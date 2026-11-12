import type {
  BulkReviewRequestParsed,
  BulkReviewResponse,
  Logger,
  SetBookmarkRequest,
  SetBookmarkResponse,
  SetReviewPolicyRequest,
  SettingsResponse,
  UndoReviewRequest,
  UndoReviewResponse,
} from '@octopus-diff/contracts';
import {
  type BulkFile,
  type BulkWorktree,
  filterByPaths,
  type MarkChange,
  mayHaveFiles,
  ownWork,
  type ReviewSource,
  UndoStore,
} from './bulk-review.js';
import type { BookmarkMove } from './core.js';
import { ApiError, isShutdownError, notFound } from './errors.js';
import type { EventHub } from './events.js';
import { policyInputFor, validateReviewPolicyTarget } from './review-policy.js';
import type { SettingsService } from './settings.js';
import { type ReviewKey, type ReviewMark, reviewLookupKey, type Store } from './store.js';

export interface ReviewControlsOptions {
  source: ReviewSource;
  settings: SettingsService;
  store: Store;
  hub: EventHub;
  logger: Logger;
  now?: () => Date;
  undo?: UndoStore;
}

interface Considered {
  wt: BulkWorktree;
  expected: string | undefined;
  files: BulkFile[];
}

function toKey(change: MarkChange): string {
  return reviewLookupKey(
    change.rawPath !== undefined,
    change.rawPath ?? change.path,
    change.patchHash,
  );
}

/**
 * The review controls of UX round 1 behind `PUT /api/review-policy`, `POST /api/review/bulk` and
 * `POST /api/review/undo` (COORDINATION §2.1, §2.2). Bulk review resolves its target on the
 * server from the current registry state, reuses the inbox's file-list aggregation (cached per
 * worktree and stateHash), writes every mark in one SQLite transaction, emits a single
 * `review.bulk` event and hands out an in-memory undo token. Only the daemon's own SQLite state is
 * ever written.
 */
export class ReviewControls {
  readonly #source: ReviewSource;
  readonly #settings: SettingsService;
  readonly #store: Store;
  readonly #hub: EventHub;
  readonly #log: Logger;
  readonly #now: () => Date;
  readonly undo: UndoStore;

  constructor(options: ReviewControlsOptions) {
    this.#source = options.source;
    this.#settings = options.settings;
    this.#store = options.store;
    this.#hub = options.hub;
    this.#log = options.logger;
    this.#now = options.now ?? (() => new Date());
    this.undo = options.undo ?? new UndoStore({ now: this.#now });
  }

  /** `PUT /api/review-policy`. */
  setPolicy(request: SetReviewPolicyRequest): SettingsResponse {
    const owner = validateReviewPolicyTarget(request.target, this.#source);
    return this.#settings.setOverride(request.target, request.enabled, owner);
  }

  /** `POST /api/review/bulk`. */
  async bulk(request: BulkReviewRequestParsed): Promise<BulkReviewResponse> {
    const { target, scope, reviewed, paths, expectedStateHashes, includeDisabled } = request;
    const advance =
      request.advanceBookmarks === true &&
      scope.kind === 'review' &&
      reviewed &&
      paths === undefined &&
      this.#source.moveBookmark !== undefined;
    if (paths !== undefined && target.kind !== 'worktree') {
      throw new ApiError('bad_request', 'paths is only valid with a worktree target');
    }
    const candidates = await this.#source.worktrees(target);
    const skippedDisabled: string[] = [];
    const stale: string[] = [];
    const selected: Array<{ wt: BulkWorktree; expected: string | undefined }> = [];
    for (const wt of candidates) {
      if (wt.bare || wt.missing || wt.prunable || wt.summary === null) continue;
      const expected = expectedStateHashes?.[wt.worktreeId];
      if (expected !== undefined && expected !== wt.summary.stateHash) {
        stale.push(wt.worktreeId);
        continue;
      }
      // Clean worktrees have nothing to mark and are not worth reporting as skipped (the review
      // scope may hold commits even when the worktree is clean).
      if (!mayHaveFiles(wt.summary, scope)) continue;
      if (!includeDisabled) {
        const policy = this.#settings.resolve(
          policyInputFor(
            { id: wt.projectId, scanRootId: wt.scanRootId },
            {
              id: wt.worktreeId,
              branch: wt.branch,
              detached: wt.detached,
            },
          ),
        );
        if (!policy.enabled) {
          skippedDisabled.push(wt.worktreeId);
          continue;
        }
      }
      selected.push({ wt, expected });
    }

    // Same aggregation as the inbox: one (cached) file list per worktree, in parallel.
    const fetched = await Promise.all(
      selected.map(async ({ wt, expected }): Promise<Considered | null> => {
        try {
          const files = await this.#source.changedFiles(wt.worktreeId, scope);
          return { wt, expected, files };
        } catch (error) {
          if (!isShutdownError(error)) {
            this.#log.debug('bulk review: skipping worktree', { worktreeId: wt.worktreeId, error });
          }
          return null;
        }
      }),
    );

    // Marks are per project: identical patches in two worktrees of one project count once.
    const wanted = new Map<string, Map<string, MarkChange>>();
    /** Worktrees whose bookmark moves to the HEAD of the state that was marked. */
    const advanceTo: Array<{ worktreeId: string; head: string }> = [];
    let worktrees = 0;
    for (const item of fetched) {
      if (!item) continue;
      // The worktree may have moved on while files were listed: never mark an unseen state.
      if (
        item.expected !== undefined &&
        this.#source.currentStateHash(item.wt.worktreeId) !== item.expected
      ) {
        stale.push(item.wt.worktreeId);
        continue;
      }
      // Base files (the default branch's changes, #33) are never marked or counted, even when
      // named in `paths`; the bookmark below still moves past them.
      const files = ownWork(paths === undefined ? item.files : filterByPaths(item.files, paths));
      const head = item.wt.summary?.headSha ?? null;
      if (advance && head !== null) advanceTo.push({ worktreeId: item.wt.worktreeId, head });
      if (files.length === 0) continue;
      worktrees++;
      let perProject = wanted.get(item.wt.projectId);
      if (!perProject) {
        perProject = new Map();
        wanted.set(item.wt.projectId, perProject);
      }
      for (const f of files) {
        const change: MarkChange = {
          projectId: item.wt.projectId,
          path: f.path,
          rawPath: f.rawPath,
          patchHash: f.patchHash,
        };
        perProject.set(toKey(change), change);
      }
    }

    const at = this.#now().toISOString();
    const changes: MarkChange[] = [];
    let unchanged = 0;
    for (const [projectId, perProject] of wanted) {
      const existing = new Set<string>();
      for (const m of this.#store.listReviewMarks(projectId, scope.kind)) {
        existing.add(reviewLookupKey(m.raw, m.path, m.patchHash));
      }
      for (const [key, change] of perProject) {
        if (existing.has(key) === reviewed) unchanged++;
        else changes.push(change);
      }
    }
    if (changes.length > 0) {
      this.#store.transaction(() => {
        for (const change of changes) {
          this.#store.setReviewed(this.#reviewKey(change, scope.kind), reviewed, at);
        }
      });
    }
    const projectIds = [...new Set(changes.map((c) => c.projectId))];
    if (projectIds.length > 0) this.#source.reviewChanged?.(projectIds);
    const bookmarks: BookmarkMove[] = [];
    for (const { worktreeId, head } of advanceTo) {
      try {
        const move = await this.#source.moveBookmark?.(worktreeId, head);
        if (move && move.previous !== move.bookmark) bookmarks.push(move);
      } catch (error) {
        if (!isShutdownError(error)) {
          this.#log.debug('bulk review: bookmark not moved', { worktreeId, error });
        }
      }
    }
    let undoToken: string | null = null;
    if (changes.length > 0 || bookmarks.length > 0) {
      undoToken = this.undo.put({
        at,
        scopeKind: scope.kind,
        reviewed,
        changes,
        ...(bookmarks.length > 0 ? { bookmarks } : {}),
      });
    }
    if (changes.length > 0) {
      this.#hub.emit({ type: 'review.bulk', projectIds, reviewed, changed: changes.length });
    }
    this.#log.info('bulk review', {
      target: target.kind,
      scope: scope.kind,
      reviewed,
      changed: changes.length,
      unchanged,
      worktrees,
      stale: stale.length,
      skippedDisabled: skippedDisabled.length,
    });
    return {
      ok: true,
      reviewed,
      changed: changes.length,
      unchanged,
      worktrees,
      skippedDisabled,
      stale,
      undoToken,
      ...(advance ? { bookmarks: bookmarks.length } : {}),
    };
  }

  /** `PUT /api/review/bookmark`: moves one bookmark; the undo token restores it. */
  async setBookmark(request: SetBookmarkRequest): Promise<SetBookmarkResponse> {
    const moveBookmark = this.#source.moveBookmark;
    if (!moveBookmark) throw new ApiError('bad_request', 'review bookmarks are not supported');
    const move = await moveBookmark(request.worktreeId, request.to);
    const changed = move.previous !== move.bookmark || move.recorded.length > 0;
    const undoToken = changed
      ? this.undo.put({
          at: this.#now().toISOString(),
          scopeKind: 'review',
          reviewed: true,
          changes: [],
          bookmarks: [move],
        })
      : null;
    this.#log.info('bookmark moved', {
      worktreeId: request.worktreeId,
      recorded: move.recorded.length,
    });
    return {
      ok: true,
      bookmark: move.bookmark,
      previous: move.previous,
      recorded: move.recorded.length,
      undoToken,
    };
  }

  /** `POST /api/review/undo`: reverses exactly the rows one bulk call changed. */
  undoBulk(request: UndoReviewRequest): UndoReviewResponse {
    const entry = this.undo.take(request.undoToken);
    if (!entry) throw notFound('undo token');
    const byProject = new Map<string, MarkChange[]>();
    for (const change of entry.changes) {
      const list = byProject.get(change.projectId) ?? [];
      list.push(change);
      byProject.set(change.projectId, list);
    }
    const now = this.#now().toISOString();
    const toApply: MarkChange[] = [];
    for (const [projectId, changes] of byProject) {
      const marks = new Map<string, ReviewMark>();
      for (const m of this.#store.listReviewMarks(projectId, entry.scopeKind)) {
        marks.set(reviewLookupKey(m.raw, m.path, m.patchHash), m);
      }
      for (const change of changes) {
        const mark = marks.get(toKey(change));
        if (entry.reviewed) {
          // The bulk call created this mark: remove it unless it was re-marked since.
          if (mark && mark.reviewedAt === entry.at) toApply.push(change);
        } else if (!mark) {
          // The bulk call removed this mark: restore it unless the user marked it again since.
          toApply.push(change);
        }
      }
    }
    if (toApply.length > 0) {
      this.#store.transaction(() => {
        for (const change of toApply) {
          this.#store.setReviewed(this.#reviewKey(change, entry.scopeKind), !entry.reviewed, now);
        }
      });
      this.#hub.emit({
        type: 'review.bulk',
        projectIds: [...new Set(toApply.map((c) => c.projectId))],
        reviewed: !entry.reviewed,
        changed: toApply.length,
      });
    }
    if (toApply.length > 0) this.#source.reviewChanged?.(new Set(toApply.map((c) => c.projectId)));
    let restoredBookmarks = 0;
    for (const move of entry.bookmarks ?? []) {
      if (this.#source.restoreBookmark?.(move)) restoredBookmarks++;
    }
    this.#log.info('bulk review undone', {
      restored: toApply.length,
      of: entry.changes.length,
      bookmarks: restoredBookmarks,
    });
    return { ok: true, restored: toApply.length + restoredBookmarks };
  }

  #reviewKey(change: MarkChange, scopeKind: ReviewKey['scopeKind']): ReviewKey {
    return {
      projectId: change.projectId,
      scopeKind,
      path: change.path,
      rawPath: change.rawPath,
      patchHash: change.patchHash,
    };
  }
}
