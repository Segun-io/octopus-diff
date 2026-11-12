import { createHash } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ACTIVITY_BLOB_MAX_BYTES,
  type ActivityResponse,
  type ActivityWatch,
  API_VERSION,
  APP_NAME,
  type BlobResponse,
  type BulkReviewTarget,
  type ChangedFile,
  type CommitInfo,
  type DiffQuery,
  type DiffResponse,
  type DiffScope,
  type EffectiveReviewPolicy,
  type FileOriginInfo,
  type FilesResponse,
  type GitChangedFile,
  type GitCore,
  type HealthResponse,
  type InboxEntry,
  type InboxResponse,
  isGitCoreError,
  type Logger,
  type Project,
  type ProjectListItem,
  type ResolvedProject,
  type ReviewRange,
  type ReviewRequest,
  type ReviewResponse,
  type ScanRoot,
  type ScopeKind,
  type SummarySnapshot,
  scopeKey,
  type UpdateProjectRequest,
  type WatchOptions,
  type WatchTargets,
  type Worktree,
  type WorktreeLocator,
  type WorktreeSummary,
} from '@octopus-diff/contracts';
import {
  ActivityStore,
  classifyHead,
  countDeleted,
  diffSnapshots,
  HEAD_CLASSIFY_COMMITS,
  headDiffers,
  needsCommits,
  type OriginLabel,
  snapshotState,
} from './activity.js';
import type { BulkWorktree, ReviewSource } from './bulk-review.js';
import { Coalescer, settleWithin } from './coalesce.js';
import { ApiError, type ApiErrorInfo, isShutdownError, notFound, toApiError } from './errors.js';
import type { EventHub } from './events.js';
import { hashId } from './ids.js';
import { Limiter } from './limit.js';
import { resolveInputPath } from './paths.js';
import { policyInputFor, type ReviewPolicyProvider } from './review-policy.js';
import {
  bookmarkKey,
  coveredByCommits,
  defaultBranchCommits,
  isUncommitted,
  pathKey,
  type ReviewComputed,
} from './review-state.js';
import {
  type ProjectRow,
  REVIEW_TOUCH_INTERVAL_MS,
  REVIEW_TTL_MS,
  type ReviewMark,
  reviewLookupKey,
  type ScanRootRow,
  type Store,
} from './store.js';
import { gitDirOf } from './watch-identity.js';
import { type DirtyReason, type SubscribeFn, WatcherService } from './watcher.js';

export const CORE_DEFAULTS = {
  /** How long list endpoints wait for first summaries before returning `summary: null`. */
  initialSummaryWaitMs: 2500,
  /** Interval between review-mark GC sweeps. */
  gcIntervalMs: 24 * 60 * 60 * 1000,
  /** `scan.progress` events are throttled to one per this interval while scanning. */
  scanProgressIntervalMs: 250,
  /** Max cached file lists (per worktree x scope). */
  filesCacheSize: 2000,
  /**
   * `readFileOrigins` calls in flight at once (#33). A fetch that moves `origin/main` relabels
   * every worktree of the project; git-core has 4 process slots (per-repository round-robin), so
   * this leaves half of them to interactive requests.
   */
  originsConcurrency: 2,
} as const;

/** A listed file with its origin attached (#33); `origin` absent = own. */
export type LabeledFile = GitChangedFile & Pick<ChangedFile, 'origin' | 'originVia'>;

/** A file list with its origins (`#labelFiles`). */
interface Labels {
  files: LabeledFile[];
  /** The origins are known (computed, or all own by rule 1 without asking git-core). */
  known: boolean;
  integrationRef: string | null;
  /** `N` (`FileOrigins.n`), null when unknown or not asked. */
  n: string | null;
}

/**
 * Where a list's committed part starts for `readFileOrigins` (`O`, #33), or undefined when the
 * scope gets no origins. `review`: its base (the bookmark). `branch` against the default branch:
 * HEAD, because the list is measured from `N` and `merge-base HEAD N` is `N` itself, so only the
 * "same as the newest default-branch version" rule and the in-progress rule can apply (the
 * default branch's own changes are not in the list at all, and a file both sides changed shows
 * only this branch's patch there: own). `working`: nothing committed (the in-progress rule only).
 * Not `staged` / `unstaged` (their flags do not come from the whole `git status`), not `commit`,
 * not a `branch` scope with an explicit base (it is not measured from `N`).
 */
function originBaseOf(scope: DiffScope, head: string | null): string | null | undefined {
  switch (scope.kind) {
    case 'review':
      return scope.base ?? null;
    case 'branch':
      return scope.base ? undefined : head;
    case 'working':
      return null;
    default:
      return undefined;
  }
}

/** Copies non-own origins onto the files (absent = own); the same array when all are own. */
function applyOrigins(
  files: readonly GitChangedFile[],
  origins: ReadonlyMap<string, FileOriginInfo>,
): LabeledFile[] {
  let labeled: LabeledFile[] | null = null;
  files.forEach((file, i) => {
    const info = origins.get(pathKey(file));
    if (!info || info.origin === 'own') return;
    labeled ??= files.slice();
    labeled[i] = {
      ...file,
      origin: info.origin,
      ...(info.via !== null ? { originVia: info.via } : {}),
    };
  });
  return labeled ?? (files as LabeledFile[]);
}

export interface CoreOptions {
  gitCore: GitCore;
  store: Store;
  hub: EventHub;
  logger: Logger;
  version: string;
  startedAt: Date;
  watch?: WatchOptions;
  /** Internal knobs (tests, benchmarks). */
  relistMs?: number;
  maxWaitMs?: number;
  /** Refresh quiet worktrees on their first watcher event (default true). */
  leadingEdge?: boolean;
  pollDegradedFocusedMs?: number;
  subscribe?: SubscribeFn;
  initialSummaryWaitMs?: number;
  gcIntervalMs?: number;
  now?: () => Date;
  cwd?: string;
  /** Review policy (UX round 1). Without it no `review` is attached (older-daemon behaviour). */
  reviewPolicy?: ReviewPolicyProvider;
  /**
   * Called when the watcher saw a git change (HEAD, refs, index, config) in one of a project's
   * worktrees, whether or not the summary's state hash moved. The forge service uses it to notice
   * push configuration changes, which the state hash does not cover.
   */
  onGitChange?: (projectId: string) => void;
  /**
   * Called on every `PUT /api/focus`: `visible` is the client's word (`FocusRequest.visible`), or for
   * older clients false when nothing is focused; `projectId` is the project of the focused worktree
   * or the open Overview
   * (`overview`: the project's Overview itself is open).
   * The forge service paces its polling by it (DECISIONS #197).
   */
  onFocus?: (visible: boolean, projectId: string | null, overview: boolean) => void;
  /** The activity rings (#38; tests pass one with small caps). */
  activity?: ActivityStore;
}

interface WorktreeEntry {
  worktree: Worktree;
  projectId: string;
  summary: WorktreeSummary | null;
  error: ApiErrorInfo | null;
  /** Last stateHash announced via `worktree.changed` (or `error:<code>`). */
  lastHash: string | null;
  attempted: boolean;
  targets: WatchTargets | null;
  /** The folder may have been recycled: compare `targets.gitDir` with its `.git` (F1). */
  checkGitDir: boolean;
  refresher: Coalescer;
  /** Status flow v2: the last computed review state (may lag the summary briefly). */
  review: ReviewComputed | null;
  reviewRun: { key: string; promise: Promise<ReviewComputed | null> } | null;
  /** `readReviewRange` result for (HEAD, bookmark) while the bookmark is reachable. */
  rangeCache: { key: string; range: ReviewRange } | null;
  /**
   * The state hash of the worktree's first summary in this session. The review state is
   * computed on demand (#10): once the project is opened, or once the worktree changed after
   * that first summary (live work an agent does), never for every repository at startup.
   */
  firstHash: string | null;
}

/** First review states that land within this window share one `review.ready` per project. */
const REVIEW_READY_BATCH_MS = 50;

/** How long a removed worktree id is remembered: git-core caches repository info for 5 min. */
const RECYCLE_WINDOW_MS = 5 * 60_000;

interface ProjectEntry {
  row: ProjectRow;
  worktrees: Map<string, WorktreeEntry>;
  /** Set when the repository vanished (reported, never silently deleted). */
  missing: ApiErrorInfo | null;
  relister: Coalescer;
  watchSync: Promise<void>;
  reconciling: Promise<void> | null;
}

interface ScanState {
  row: ScanRootRow;
  controller: AbortController | null;
  running: Promise<void> | null;
}

interface RegisterOptions {
  scanRootId: string | null;
  /** Explicitly added by the user (clears a scan-root association and scan exclusions). */
  explicit: boolean;
}

function sameWorktree(a: Worktree, b: Worktree): boolean {
  return (
    a.path === b.path &&
    a.branch === b.branch &&
    a.headSha === b.headSha &&
    a.detached === b.detached &&
    a.isMain === b.isMain &&
    a.bare === b.bare &&
    a.locked === b.locked &&
    a.prunable === b.prunable &&
    a.missing === b.missing
  );
}

function compareWorktrees(a: Worktree, b: Worktree): number {
  if (a.isMain !== b.isMain) return a.isMain ? -1 : 1;
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function compareProjects(a: ProjectRow, b: ProjectRow): number {
  const an = a.name.toLowerCase();
  const bn = b.name.toLowerCase();
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Scopes whose file list is a function of the worktree state (and, for `branch`, of its base
 * ref: see `#branchBase`). `review` without a base is resolved before it gets here; with a base
 * it is immutable.
 */
function isCacheableScope(scope: DiffScope): boolean {
  return !(scope.kind === 'review' && !scope.base);
}

/** The scope whose base is the project's default branch (what "All on branch" measures). */
const DEFAULT_BASE_SCOPE: DiffScope = { kind: 'branch' };

/**
 * The summary with its `stateHash` extended by the default branch's commit (`ref=oid`), so equal
 * hashes keep meaning "nothing to refetch" for branch scopes too. Unchanged without a base.
 */
function withBase(summary: WorktreeSummary, base: string | null | undefined): WorktreeSummary {
  if (!base) return summary;
  const hash = createHash('sha1')
    .update(summary.stateHash)
    .update('\u0000')
    .update(base)
    .digest('hex')
    .slice(0, Math.max(summary.stateHash.length, 16));
  return { ...summary, stateHash: hash };
}

/** A bookmark target must be a full commit id (the daemon never stores abbreviations). */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** What `moveBookmark` changed (for the route, bulk review and undo). */
export interface BookmarkMove {
  projectId: string;
  worktreeId: string;
  key: string;
  previous: string | null;
  bookmark: string;
  /** Commits newly recorded as reviewed (removed again by undo). */
  recorded: string[];
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * The daemon's state and behavior behind the HTTP layer: project registry, scan roots,
 * cached worktree summaries (single-flight per worktree), file lists, review marks, and the
 * watcher wiring. All git access goes through `GitCore`; nothing here writes to a repository.
 */
export class DaemonCore {
  readonly #git: GitCore;
  readonly #store: Store;
  readonly #hub: EventHub;
  readonly #log: Logger;
  readonly #onGitChange: ((projectId: string) => void) | undefined;
  readonly #onFocus:
    | ((visible: boolean, projectId: string | null, overview: boolean) => void)
    | undefined;
  readonly #version: string;
  readonly #startedAt: Date;
  readonly #now: () => Date;
  readonly #cwd: string;
  readonly #initialWaitMs: number;
  readonly #gcIntervalMs: number;
  readonly #relistMs: number;
  readonly #watcher: WatcherService;
  readonly #reviewPolicy: ReviewPolicyProvider | null;
  readonly #projects = new Map<string, ProjectEntry>();
  readonly #scanRoots = new Map<string, ScanState>();
  /**
   * Changed files per (worktree, scope), valid while the worktree's `stateHash` and, for branch
   * scopes, the base ref's commit (`base`) are the ones they were listed under (#27).
   */
  readonly #filesCache = new Map<
    string,
    { stateHash: string; base: string | null; attrs: string; files: GitChangedFile[] }
  >();
  readonly #filesInflight = new Map<string, Promise<GitChangedFile[]>>();
  /**
   * File origins (#33) per listed file array: `#gitFiles` hands out the same array while its
   * cache entry (worktree, scope, stateHash, base, attributes) is current, so the array's identity
   * already covers HEAD, the index, the working tree and the operation in progress. `key` adds
   * what the labels also depend on: `O`, the default branch's name and both of its commits
   * (local and `origin/<d>`, read fresh on every call, so a fetch is never served stale labels).
   */
  readonly #origins = new WeakMap<
    readonly GitChangedFile[],
    { key: string; run: Promise<Labels> }
  >();
  readonly #originsLimit = new Limiter(CORE_DEFAULTS.originsConcurrency);
  /** The live view's activity rings (#38): memory only, never written to the store. */
  readonly #activity: ActivityStore;
  /** Identical inbox requests that overlap share one run (`inbox`), keyed by what it reads. */
  readonly #inboxInflight = new Map<string, Promise<InboxResponse>>();
  /** Worktree ids removed recently (id → time), to spot a path re-added soon after (F1). */
  readonly #recentlyRemoved = new Map<string, number>();
  /** Bumped on every review write in a project (marks, bookmarks, reviewed commits). */
  readonly #reviewVersion = new Map<string, number>();
  /**
   * Projects the user opened in this session (a worktree or the project's Overview was focused):
   * their worktrees' review state is computed and kept current. Others start without one (#10,
   * decision 2 in #25): the sidebar shows their changes, not an inherited "to review" state.
   */
  readonly #openProjects = new Set<string>();
  /** Projects whose review state became available since the last `review.ready` (batched). */
  readonly #reviewReady = new Set<string>();
  #reviewReadyTimer: NodeJS.Timeout | null = null;
  #gitVersion: string | null = null;
  #timers: NodeJS.Timeout[] = [];
  #closed = false;

  constructor(options: CoreOptions) {
    this.#git = options.gitCore;
    this.#store = options.store;
    this.#hub = options.hub;
    this.#log = options.logger;
    this.#onGitChange = options.onGitChange;
    this.#onFocus = options.onFocus;
    this.#version = options.version;
    this.#startedAt = options.startedAt;
    this.#now = options.now ?? (() => new Date());
    this.#cwd = options.cwd ?? process.cwd();
    this.#initialWaitMs = options.initialSummaryWaitMs ?? CORE_DEFAULTS.initialSummaryWaitMs;
    this.#gcIntervalMs = options.gcIntervalMs ?? CORE_DEFAULTS.gcIntervalMs;
    this.#reviewPolicy = options.reviewPolicy ?? null;
    this.#activity = options.activity ?? new ActivityStore();
    const watch = options.watch ?? {};
    this.#relistMs = options.relistMs ?? 60_000;
    const watcherOptions: ConstructorParameters<typeof WatcherService>[0] = {
      enabled: watch.enabled ?? true,
      forcePolling: watch.forcePolling ?? false,
      ignore: watch.ignore ?? [],
      relistMs: this.#relistMs,
      leadingEdge: options.leadingEdge ?? true,
      logger: this.#log,
      onWorktreeDirty: (id, reason) => this.#onWorktreeDirty(id, reason),
      onWorktreeListDirty: (projectId) => {
        const entry = this.#projects.get(projectId);
        if (entry) void this.#relist(entry);
      },
      onWorktreeReplaced: (worktreeId) => this.#onWorktreeReplaced(worktreeId),
    };
    if (watch.debounceMs !== undefined) watcherOptions.debounceMs = watch.debounceMs;
    if (watch.pollFocusedMs !== undefined) watcherOptions.pollFocusedMs = watch.pollFocusedMs;
    if (watch.pollIdleMs !== undefined) watcherOptions.pollIdleMs = watch.pollIdleMs;
    if (options.maxWaitMs !== undefined) watcherOptions.maxWaitMs = options.maxWaitMs;
    if (options.pollDegradedFocusedMs !== undefined) {
      watcherOptions.pollDegradedFocusedMs = options.pollDegradedFocusedMs;
    }
    if (options.subscribe) watcherOptions.subscribe = options.subscribe;
    this.#watcher = new WatcherService(watcherOptions);
  }

  get watcher(): WatcherService {
    return this.#watcher;
  }

  #nowIso(): string {
    return this.#now().toISOString();
  }

  // --- lifecycle -------------------------------------------------------------------------------

  /** Loads the registry from the store (synchronously usable right away, before reconciling). */
  load(): void {
    for (const row of this.#store.listProjects()) {
      const entry = this.#newProjectEntry(row);
      for (const wt of row.worktrees)
        entry.worktrees.set(wt.id, this.#newWorktreeEntry(wt, row.id));
      this.#projects.set(row.id, entry);
    }
    for (const row of this.#store.listScanRoots()) {
      this.#scanRoots.set(row.id, { row, controller: null, running: null });
    }
  }

  /**
   * Starts background work: reconciles every stored project with git (vanished repositories
   * are reported as missing, not deleted), rescans scan roots, and schedules GC and retries.
   * `skipProjects` / `skipScanRoots` were just registered by the caller.
   */
  start(skip: { projects?: Set<string>; scanRoots?: Set<string> } = {}): void {
    for (const entry of this.#projects.values()) {
      if (skip.projects?.has(entry.row.id)) continue;
      void this.#reconcile(entry);
    }
    for (const st of this.#scanRoots.values()) {
      if (skip.scanRoots?.has(st.row.id)) continue;
      this.#startScan(st);
    }
    this.gc();
    const gcTimer = setInterval(() => this.gc(), this.#gcIntervalMs);
    gcTimer.unref();
    const retryTimer = setInterval(() => {
      for (const entry of this.#projects.values()) {
        if (entry.missing) void this.#reconcile(entry);
      }
    }, this.#relistMs);
    retryTimer.unref();
    this.#timers.push(gcTimer, retryTimer);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const t of this.#timers) clearInterval(t);
    this.#timers = [];
    if (this.#reviewReadyTimer) clearTimeout(this.#reviewReadyTimer);
    this.#reviewReadyTimer = null;
    const scans: Promise<void>[] = [];
    for (const st of this.#scanRoots.values()) {
      st.controller?.abort();
      if (st.running) scans.push(st.running.catch(() => {}));
    }
    await this.#watcher.close();
    await settleWithin(Promise.all(scans), 2000);
  }

  /** Deletes review marks of removed projects and marks unseen for 30 days (PLAN §5.7). */
  gc(): { orphaned: number; stale: number } {
    if (this.#closed || this.#store.closed) return { orphaned: 0, stale: 0 };
    const staleBefore = new Date(this.#now().getTime() - REVIEW_TTL_MS).toISOString();
    try {
      const result = this.#store.gcReviewMarks(staleBefore);
      if (result.orphaned + result.stale > 0)
        this.#log.info('review marks garbage-collected', result);
      return result;
    } catch (error) {
      this.#log.error('review mark GC failed', { error });
      return { orphaned: 0, stale: 0 };
    }
  }

  // --- health ----------------------------------------------------------------------------------

  async health(): Promise<HealthResponse> {
    let supported = this.#gitVersion !== null;
    if (this.#gitVersion === null && !this.#closed) {
      try {
        const v = await this.#git.version();
        this.#gitVersion = `${v.major}.${v.minor}.${v.patch}`;
        supported = true;
      } catch (error) {
        this.#log.debug('git version unavailable', { error });
        supported = false;
      }
    }
    const now = this.#now();
    return {
      ok: true,
      name: APP_NAME,
      version: this.#version,
      apiVersion: API_VERSION,
      git: { version: this.#gitVersion, supported },
      watcher: this.#watcher.status(),
      startedAt: this.#startedAt.toISOString(),
      uptimeMs: Math.max(0, now.getTime() - this.#startedAt.getTime()),
    };
  }

  // --- projects --------------------------------------------------------------------------------

  async listProjects(): Promise<ProjectListItem[]> {
    const entries = [...this.#projects.values()];
    await this.#awaitInitial(entries);
    await this.#awaitReviews(entries);
    return entries
      .filter((e) => this.#projects.get(e.row.id) === e)
      .sort((a, b) => compareProjects(a.row, b.row))
      .map((e) => this.#item(e));
  }

  /**
   * Registers a repository by any path inside it (idempotent). `waitForSummaries` (default
   * true) waits, bounded, for the first summaries so the response is complete.
   */
  async addProject(
    inputPath: string,
    options: { waitForSummaries?: boolean } = {},
  ): Promise<{ item: ProjectListItem; created: boolean }> {
    const real = await this.#resolveDirectory(inputPath);
    const resolved = await this.#git.resolveProject(real);
    this.#assertOpen();
    const { entry, created } = this.#register(resolved, { scanRootId: null, explicit: true });
    if (!entry) throw new ApiError('internal', 'project registration failed');
    if (options.waitForSummaries ?? true) await this.#awaitInitial([entry]);
    return { item: this.#item(entry), created };
  }

  async updateProject(projectId: string, request: UpdateProjectRequest): Promise<ProjectListItem> {
    const entry = this.#requireProject(projectId);
    if (request.defaultBranchOverride !== undefined) {
      const value = request.defaultBranchOverride;
      if (value !== entry.row.defaultBranchOverride) {
        this.#store.setDefaultBranchOverride(projectId, value);
        entry.row.defaultBranchOverride = value;
        this.#invalidateFiles(entry);
        const refreshes = [...entry.worktrees.values()].map((e) => this.#refresh(e));
        this.#hub.emit({ type: 'project.updated', projectId });
        await settleWithin(Promise.all(refreshes), this.#initialWaitMs);
      }
    }
    return this.#item(entry);
  }

  async removeProject(projectId: string): Promise<void> {
    const entry = this.#requireProject(projectId);
    await this.#dropProject(entry, { exclude: true });
  }

  #dropProject(entry: ProjectEntry, options: { exclude: boolean }): Promise<void> {
    const id = entry.row.id;
    this.#projects.delete(id);
    this.#invalidateFiles(entry);
    for (const worktreeId of entry.worktrees.keys()) this.#activity.forget(worktreeId);
    if (options.exclude && entry.row.scanRootId && this.#scanRoots.has(entry.row.scanRootId)) {
      this.#store.addScanExclusion(entry.row.scanRootId, id, this.#nowIso());
    }
    this.#store.deleteProject(id);
    this.#reviewPolicy?.onProjectRemoved(id);
    if (this.#watcher.focus && entry.worktrees.has(this.#watcher.focus))
      this.#watcher.setFocus(null);
    const unwatched = this.#watcher.removeProject(id);
    this.#hub.emit({ type: 'project.removed', projectId: id });
    this.#log.info('project removed', { projectId: id, name: entry.row.name });
    return unwatched;
  }

  async #resolveDirectory(inputPath: string): Promise<string> {
    const abs = resolveInputPath(inputPath, this.#cwd);
    let real: string;
    try {
      real = await realpath(abs);
    } catch (error) {
      if (errnoCode(error) === 'ENOENT' || errnoCode(error) === 'ENOTDIR') {
        throw new ApiError('not_found', `path does not exist: ${abs}`);
      }
      throw new ApiError('bad_request', `cannot access ${abs}: ${(error as Error).message}`);
    }
    const info = await stat(real);
    if (!info.isDirectory()) throw new ApiError('bad_request', `not a directory: ${real}`);
    return real;
  }

  /** Adds or refreshes a project from a git-core resolution. Synchronous (no awaits). */
  #register(
    resolved: ResolvedProject,
    options: RegisterOptions,
  ): { entry: ProjectEntry | null; created: boolean } {
    const info = resolved.project;
    const existing = this.#projects.get(info.id);
    if (existing) {
      let changed = false;
      if (options.explicit && existing.row.scanRootId !== null) {
        existing.row.scanRootId = null;
        this.#store.setProjectScanRoot(info.id, null);
        changed = true;
      }
      changed = this.#updateInfo(existing, resolved) || changed;
      const wasMissing = existing.missing !== null;
      existing.missing = null;
      const result = this.#applyWorktrees(existing, resolved.worktrees, { emit: true });
      if (changed || wasMissing || result.changed) {
        this.#hub.emit({ type: 'project.updated', projectId: info.id });
      }
      this.#kickSummaries(existing);
      return { entry: existing, created: false };
    }
    if (options.scanRootId !== null) {
      if (!this.#scanRoots.has(options.scanRootId)) return { entry: null, created: false };
      if (this.#store.isScanExcluded(options.scanRootId, info.id)) {
        this.#log.debug('scan skipped a project the user removed', { projectId: info.id });
        return { entry: null, created: false };
      }
    }
    if (options.explicit) this.#store.clearScanExclusions(info.id);
    const row: ProjectRow = {
      id: info.id,
      name: info.name,
      commonDir: info.commonDir,
      mainWorktreePath: info.mainWorktreePath,
      bare: info.bare,
      detectedDefaultBranch: info.detectedDefaultBranch,
      defaultBranchOverride: null,
      scanRootId: options.scanRootId,
      addedAt: this.#nowIso(),
      worktrees: resolved.worktrees,
    };
    this.#store.insertProject(row);
    const entry = this.#newProjectEntry(row);
    this.#projects.set(row.id, entry);
    this.#applyWorktrees(entry, resolved.worktrees, { emit: false });
    this.#hub.emit({ type: 'project.added', projectId: row.id });
    this.#log.info('project added', {
      projectId: row.id,
      name: row.name,
      commonDir: row.commonDir,
      worktrees: resolved.worktrees.length,
      scanRootId: row.scanRootId,
    });
    this.#kickSummaries(entry);
    return { entry, created: true };
  }

  #updateInfo(entry: ProjectEntry, resolved: ResolvedProject): boolean {
    const info = resolved.project;
    const row = entry.row;
    if (
      row.name === info.name &&
      row.commonDir === info.commonDir &&
      row.mainWorktreePath === info.mainWorktreePath &&
      row.bare === info.bare &&
      row.detectedDefaultBranch === info.detectedDefaultBranch
    ) {
      return false;
    }
    const defaultChanged = row.detectedDefaultBranch !== info.detectedDefaultBranch;
    row.name = info.name;
    row.commonDir = info.commonDir;
    row.mainWorktreePath = info.mainWorktreePath;
    row.bare = info.bare;
    row.detectedDefaultBranch = info.detectedDefaultBranch;
    this.#store.updateProjectInfo(row.id, row);
    if (defaultChanged) {
      this.#invalidateFiles(entry);
      for (const e of entry.worktrees.values()) void this.#refresh(e);
    }
    return true;
  }

  /** Re-resolves a stored project (startup, and retries while it is missing). */
  #reconcile(entry: ProjectEntry): Promise<void> {
    if (entry.reconciling) return entry.reconciling;
    const run = (async () => {
      const commonDir = entry.row.commonDir;
      try {
        await stat(commonDir);
      } catch (error) {
        if (errnoCode(error) === 'ENOENT' || errnoCode(error) === 'ENOTDIR') {
          this.#markMissing(entry);
          return;
        }
      }
      try {
        const resolved = await this.#git.resolveProject(commonDir);
        if (this.#closed || this.#projects.get(entry.row.id) !== entry) return;
        if (resolved.project.id !== entry.row.id) {
          this.#log.warn('repository identity changed; reporting the project as missing', {
            projectId: entry.row.id,
            commonDir,
            resolvedId: resolved.project.id,
          });
          this.#markMissing(entry);
          return;
        }
        this.#register(resolved, { scanRootId: entry.row.scanRootId, explicit: false });
      } catch (error) {
        if (this.#closed || isShutdownError(error)) return;
        if (isGitCoreError(error, 'not_a_repository')) {
          this.#markMissing(entry);
          return;
        }
        this.#log.warn('could not reconcile project; keeping last known worktrees', {
          projectId: entry.row.id,
          error,
        });
        void this.#syncWatcher(entry);
        this.#kickSummaries(entry);
      }
    })();
    entry.reconciling = run.finally(() => {
      entry.reconciling = null;
    });
    return entry.reconciling;
  }

  #markMissing(entry: ProjectEntry): void {
    if (this.#closed || this.#projects.get(entry.row.id) !== entry) return;
    if (entry.missing) return;
    entry.missing = {
      code: 'not_found',
      message: `repository no longer exists at ${entry.row.commonDir}`,
    };
    this.#invalidateFiles(entry);
    for (const e of entry.worktrees.values()) {
      e.worktree = { ...e.worktree, missing: true };
      e.summary = null;
      e.error = entry.missing;
      e.attempted = true;
      this.#announce(e, 'missing');
    }
    void this.#watcher.removeProject(entry.row.id);
    this.#log.warn('project path vanished; keeping it registered and reporting it as missing', {
      projectId: entry.row.id,
      name: entry.row.name,
      commonDir: entry.row.commonDir,
    });
    this.#hub.emit({ type: 'project.updated', projectId: entry.row.id });
  }

  #relist(entry: ProjectEntry): Promise<void> {
    return entry.relister.run();
  }

  async #doRelist(entry: ProjectEntry): Promise<void> {
    if (this.#closed || this.#projects.get(entry.row.id) !== entry) return;
    if (entry.missing) {
      await this.#reconcile(entry);
      return;
    }
    try {
      const worktrees = await this.#git.listWorktrees({
        id: entry.row.id,
        commonDir: entry.row.commonDir,
      });
      if (this.#closed || this.#projects.get(entry.row.id) !== entry) return;
      const result = this.#applyWorktrees(entry, worktrees, { emit: true });
      if (result.changed && result.added.length === 0 && result.removed.length === 0) {
        this.#hub.emit({ type: 'project.updated', projectId: entry.row.id });
      }
      this.#kickSummaries(entry);
    } catch (error) {
      if (this.#closed || isShutdownError(error)) return;
      if (isGitCoreError(error, 'not_a_repository')) {
        await this.#reconcile(entry);
        return;
      }
      this.#log.debug('worktree relist failed', { projectId: entry.row.id, error });
    }
  }

  #applyWorktrees(
    entry: ProjectEntry,
    worktrees: Worktree[],
    options: { emit: boolean },
  ): { added: string[]; removed: string[]; changed: boolean } {
    const next = new Map<string, WorktreeEntry>();
    const added: string[] = [];
    const removed: string[] = [];
    let changed = false;
    for (const wt of worktrees) {
      const existing = entry.worktrees.get(wt.id);
      if (existing) {
        if (!sameWorktree(existing.worktree, wt)) {
          const wasMissing = existing.worktree.missing;
          existing.worktree = wt;
          changed = true;
          if (wasMissing && !wt.missing) {
            existing.error = null;
            existing.attempted = false;
            existing.checkGitDir = true;
          }
        }
        next.set(wt.id, existing);
      } else {
        const created = this.#newWorktreeEntry(wt, entry.row.id);
        const removedAt = this.#recentlyRemoved.get(wt.id);
        if (removedAt !== undefined && Date.now() - removedAt < RECYCLE_WINDOW_MS) {
          created.checkGitDir = true;
        }
        next.set(wt.id, created);
        added.push(wt.id);
        changed = true;
      }
    }
    for (const id of entry.worktrees.keys()) {
      if (!next.has(id)) {
        removed.push(id);
        changed = true;
        this.#invalidateWorktreeFiles(id);
        this.#rememberRemoved(id);
        this.#activity.forget(id);
      }
    }
    entry.worktrees = next;
    if (changed) {
      entry.row.worktrees = worktrees;
      this.#store.setProjectWorktrees(entry.row.id, worktrees);
    }
    if (options.emit) {
      for (const worktreeId of added) {
        this.#hub.emit({ type: 'worktree.added', projectId: entry.row.id, worktreeId });
      }
      for (const worktreeId of removed) {
        this.#hub.emit({ type: 'worktree.removed', projectId: entry.row.id, worktreeId });
      }
    }
    if (added.length || removed.length) {
      this.#log.info('worktrees changed', { projectId: entry.row.id, added, removed });
    }
    void this.#syncWatcher(entry);
    return { added, removed, changed };
  }

  /** Serialized per project: fetches watch targets and updates the watcher's worktree set. */
  #syncWatcher(entry: ProjectEntry): Promise<void> {
    entry.watchSync = entry.watchSync.then(async () => {
      if (this.#closed || this.#projects.get(entry.row.id) !== entry || entry.missing) return;
      const watched = [];
      for (const e of entry.worktrees.values()) {
        // Prunable records point at a folder whose `.git` does not lead back to this repository
        // (broken or forged): never watch them (SEC-07).
        if (e.worktree.missing || e.worktree.prunable) continue;
        const targets = await this.#watchTargets(e);
        if (targets === undefined) return;
        watched.push({
          projectId: entry.row.id,
          worktreeId: e.worktree.id,
          root: e.worktree.path,
          bare: e.worktree.bare,
          isMain: e.worktree.isMain,
          targets,
        });
      }
      if (this.#closed || this.#projects.get(entry.row.id) !== entry || entry.missing) return;
      await this.#watcher.setProject(entry.row.id, entry.row.commonDir, watched);
    });
    entry.watchSync = entry.watchSync.catch((error) => {
      this.#log.warn('watcher sync failed', { projectId: entry.row.id, error });
    });
    return entry.watchSync;
  }

  #rememberRemoved(worktreeId: string): void {
    const now = Date.now();
    for (const [id, at] of this.#recentlyRemoved) {
      if (now - at >= RECYCLE_WINDOW_MS) this.#recentlyRemoved.delete(id);
    }
    this.#recentlyRemoved.set(worktreeId, now);
  }

  /** The watcher saw a worktree folder deleted or replaced: re-check its targets (F1). */
  #onWorktreeReplaced(worktreeId: string): void {
    for (const project of this.#projects.values()) {
      const e = project.worktrees.get(worktreeId);
      if (!e) continue;
      e.checkGitDir = true;
      // Another folder may now sit at this path: its first snapshot is a new baseline.
      this.#activity.resetBaseline(worktreeId);
      void this.#syncWatcher(project);
      return;
    }
  }

  /**
   * Watch targets of a worktree. When the folder may have been recycled (`checkGitDir`), its
   * `.git` entry is read and the targets are re-fetched if it points at another git dir (review
   * F1). If git-core still reports the old git dir (its repository cache), null is returned:
   * the watcher then routes every git-dir event of the project to this worktree until the two
   * agree. Undefined on shutdown.
   */
  async #watchTargets(e: WorktreeEntry): Promise<WatchTargets | null | undefined> {
    const check = e.checkGitDir && !e.worktree.bare;
    if (!check) e.checkGitDir = false;
    if (e.targets && !check) return e.targets;
    const actual = check ? await gitDirOf(e.worktree.path) : null;
    if (e.targets && actual !== null && e.targets.gitDir !== actual) {
      this.#log.debug('worktree git dir changed; refreshing watch targets', {
        worktreeId: e.worktree.id,
      });
      e.targets = null;
    }
    if (!e.targets) {
      try {
        e.targets = await this.#git.getWatchTargets(this.#locator(e));
      } catch (error) {
        if (isShutdownError(error)) return undefined;
        this.#log.debug('watch targets unavailable', { worktreeId: e.worktree.id, error });
        return null;
      }
    }
    if (actual !== null && e.targets.gitDir !== actual) {
      this.#log.debug('watch targets disagree with the worktree .git file; using none for now', {
        worktreeId: e.worktree.id,
      });
      e.targets = null;
      return null;
    }
    // Keep checking while the `.git` entry can't be read (the folder may be coming back).
    if (actual !== null) e.checkGitDir = false;
    return e.targets;
  }

  #newProjectEntry(row: ProjectRow): ProjectEntry {
    const entry: ProjectEntry = {
      row,
      worktrees: new Map(),
      missing: null,
      relister: new Coalescer(() => this.#doRelist(entry)),
      watchSync: Promise.resolve(),
      reconciling: null,
    };
    return entry;
  }

  #newWorktreeEntry(worktree: Worktree, projectId: string): WorktreeEntry {
    const entry: WorktreeEntry = {
      worktree,
      projectId,
      summary: null,
      error: null,
      lastHash: null,
      attempted: false,
      targets: null,
      checkGitDir: false,
      refresher: new Coalescer(() => this.#computeSummary(entry)),
      review: null,
      reviewRun: null,
      rangeCache: null,
      firstHash: null,
    };
    return entry;
  }

  #toProject(row: ProjectRow): Project {
    return {
      id: row.id,
      name: row.name,
      commonDir: row.commonDir,
      mainWorktreePath: row.mainWorktreePath,
      bare: row.bare,
      defaultBranch: row.defaultBranchOverride ?? row.detectedDefaultBranch,
      defaultBranchOverride: row.defaultBranchOverride,
      scanRootId: row.scanRootId,
      addedAt: row.addedAt,
    };
  }

  #item(entry: ProjectEntry): ProjectListItem {
    const worktrees = [...entry.worktrees.values()]
      .sort((a, b) => compareWorktrees(a.worktree, b.worktree))
      .map((e) => {
        const review = this.#policy(entry, e);
        const summary = e.summary && e.review ? { ...e.summary, review: e.review.info } : e.summary;
        return {
          worktree: e.worktree,
          summary,
          error: e.error,
          ...(review ? { review } : {}),
        };
      });
    return { project: this.#toProject(entry.row), worktrees };
  }

  /** Effective review policy of a worktree (UX round 1), or undefined without a provider. */
  #policy(project: ProjectEntry, e: WorktreeEntry) {
    return this.#reviewPolicy?.resolve(policyInputFor(project.row, e.worktree));
  }

  #requireProject(projectId: string): ProjectEntry {
    const entry = this.#projects.get(projectId);
    if (!entry) throw notFound('project');
    return entry;
  }

  #requireWorktree(worktreeId: string): { project: ProjectEntry; entry: WorktreeEntry } {
    for (const project of this.#projects.values()) {
      const entry = project.worktrees.get(worktreeId);
      if (entry) return { project, entry };
    }
    throw notFound('worktree');
  }

  #locator(e: WorktreeEntry): WorktreeLocator {
    return { projectId: e.projectId, worktreeId: e.worktree.id, path: e.worktree.path };
  }

  #defaultBranch(project: ProjectEntry): string | null {
    return project.row.defaultBranchOverride ?? project.row.detectedDefaultBranch;
  }

  #assertOpen(): void {
    if (this.#closed) throw new ApiError('internal', 'daemon is shutting down', { status: 503 });
  }

  // --- summaries -------------------------------------------------------------------------------

  #onWorktreeDirty(worktreeId: string, reason: DirtyReason): void {
    for (const project of this.#projects.values()) {
      const entry = project.worktrees.get(worktreeId);
      if (entry) {
        this.#log.debug('worktree dirty', { worktreeId, reason });
        void this.#refresh(entry);
        if (reason === 'git') this.#onGitChange?.(entry.projectId);
        return;
      }
    }
  }

  #refresh(entry: WorktreeEntry): Promise<void> {
    return entry.refresher.run();
  }

  #kickSummaries(project: ProjectEntry): void {
    for (const e of project.worktrees.values()) {
      if (!e.attempted && !e.refresher.running) void this.#refresh(e);
    }
  }

  async #computeSummary(entry: WorktreeEntry): Promise<void> {
    const project = this.#projects.get(entry.projectId);
    if (this.#closed || !project || project.worktrees.get(entry.worktree.id) !== entry) return;
    if (project.missing) return;
    if (entry.worktree.bare) {
      entry.attempted = true;
      return;
    }
    if (entry.worktree.missing) {
      entry.summary = null;
      entry.error = {
        code: 'not_found',
        message: `worktree path no longer exists: ${entry.worktree.path}`,
      };
      entry.attempted = true;
      this.#activity.resetBaseline(entry.worktree.id);
      this.#announce(entry, 'missing');
      return;
    }
    try {
      // The snapshot (#37) is a reshaping of what the summary reads anyway: no extra git process.
      // It feeds the activity ring only and never reaches an API payload.
      const { snapshot, ...gitSummary } = await this.#git.getSummary(this.#locator(entry), {
        defaultBranch: this.#defaultBranch(project),
        snapshot: true,
      });
      // The state hash also covers the default branch's commit (#27): a branch scope's diff
      // follows it (the merge base moves) while the worktree itself stays as it was.
      const summary = withBase(gitSummary, await this.#branchBase(project, DEFAULT_BASE_SCOPE));
      if (snapshot) {
        summary.counts = { ...summary.counts, deleted: countDeleted(snapshot) };
      }
      if (this.#closed || project.worktrees.get(entry.worktree.id) !== entry) return;
      entry.summary = summary;
      entry.error = null;
      if (
        entry.worktree.branch !== summary.branch ||
        entry.worktree.headSha !== summary.headSha ||
        entry.worktree.detached !== summary.detached
      ) {
        entry.worktree = {
          ...entry.worktree,
          branch: summary.branch,
          headSha: summary.headSha,
          detached: summary.detached,
        };
      }
      if (entry.firstHash === null) {
        entry.firstHash = summary.stateHash;
        this.#seedBookmark(project, entry, summary);
      }
      // The review state is ready (cached) before clients are told to refetch, when it is
      // wanted; at startup it is not (#10): the summary alone (status + numstat) is enough.
      if (this.#reviewWanted(project, entry)) {
        await this.#reviewOf(project, entry);
        if (this.#closed || project.worktrees.get(entry.worktree.id) !== entry) return;
      }
      if (snapshot) {
        await this.#recordActivity(entry, summary, snapshot);
        if (this.#closed || project.worktrees.get(entry.worktree.id) !== entry) return;
      }
      this.#announce(entry, summary.stateHash);
    } catch (error) {
      if (this.#closed || isShutdownError(error)) return;
      if (project.worktrees.get(entry.worktree.id) !== entry) return;
      const apiError = toApiError(error);
      entry.summary = null;
      entry.error = apiError.toBody().error;
      this.#log.debug('summary failed', { worktreeId: entry.worktree.id, error });
      this.#announce(entry, `error:${apiError.code}`);
    } finally {
      entry.attempted = true;
    }
  }

  /**
   * First sight of a worktree that starts its bookmark at HEAD (the default branch, detached, or a
   * repository with no default branch):
   * stores HEAD now, from the summary, without a git process. Its review state is computed later
   * (#10), and commits made before that must still count as new. Other branches start at the
   * merge base with the default branch, which their own commits do not move.
   */
  #seedBookmark(project: ProjectEntry, entry: WorktreeEntry, summary: WorktreeSummary): void {
    const head = summary.headSha;
    if (!head || !FULL_SHA.test(head) || !this.#git.readReviewRange) return;
    const defaultBranch = this.#defaultBranch(project);
    const branch = summary.branch;
    // No default branch (none detected, none set: a local repository with only `develop`): the
    // review range falls back to HEAD too (`readReviewRange`: no default ref, so the initial
    // bookmark is HEAD), so the attached branch starts at HEAD here as well.
    const startsAtHead =
      summary.detached ||
      (branch !== null &&
        (defaultBranch === null ||
          branch === defaultBranch ||
          (defaultBranch.includes('/') &&
            defaultBranch.slice(defaultBranch.indexOf('/') + 1) === branch)));
    if (!startsAtHead) return;
    const key = bookmarkKey({ id: entry.worktree.id, branch, detached: summary.detached });
    try {
      if (this.#store.getBookmark(project.row.id, key) !== null) return;
      this.#store.setBookmark(project.row.id, key, head, this.#nowIso());
    } catch (error) {
      this.#log.debug('could not seed the review bookmark', {
        worktreeId: entry.worktree.id,
        error,
      });
    }
  }

  /**
   * Diffs this refresh's snapshot against the previous one into the activity ring (#38). The first
   * snapshot is the baseline. A HEAD move on the same branch reads the newest commits once
   * (`listCommits`, one `git log`) to tell a commit from a reset or a pull; nothing else spawns.
   */
  async #recordActivity(
    entry: WorktreeEntry,
    summary: WorktreeSummary,
    snapshot: SummarySnapshot,
  ): Promise<void> {
    const id = entry.worktree.id;
    const cur = snapshotState(summary, snapshot);
    const prev = this.#activity.previous(id);
    if (prev === null) {
      this.#activity.observe(id, cur, [], this.#now());
      return;
    }
    let head = null;
    if (headDiffers(prev.head, cur.head)) {
      let commits: CommitInfo[] | null = null;
      if (needsCommits(prev.head, cur.head)) {
        try {
          commits = await this.#git.listCommits(this.#locator(entry), {
            limit: HEAD_CLASSIFY_COMMITS,
          });
        } catch (error) {
          if (isShutdownError(error)) return;
          this.#log.debug('activity: commits unavailable', { worktreeId: id, error });
        }
      }
      // The read took a while: if the worktree was removed or its baseline reset meanwhile, this
      // snapshot is not the one it was compared with. Writing it would bring back a ring that
      // `forget` dropped, and a re-added worktree would compare new work against old state.
      const project = this.#projects.get(entry.projectId);
      if (
        this.#closed ||
        project?.worktrees.get(id) !== entry ||
        this.#activity.previous(id) !== prev
      ) {
        return;
      }
      head = classifyHead(prev.head, cur.head, commits);
    }
    // Only an unchanged review state's labels apply (they describe this summary's files).
    const review = entry.review;
    const origins = review?.key.startsWith(`${summary.stateHash}\u0000`) ? review.origins : null;
    const drafts = diffSnapshots(prev, cur, head, origins);
    this.#activity.observe(id, cur, drafts, this.#now());
  }

  /** Emits `worktree.changed` only when the state hash actually changed (PLAN §5.6). */
  #announce(entry: WorktreeEntry, stateHash: string): void {
    if (entry.lastHash === stateHash) return;
    entry.lastHash = stateHash;
    const activitySeq = this.#activity.seqOf(entry.worktree.id);
    this.#hub.emit({
      type: 'worktree.changed',
      projectId: entry.projectId,
      worktreeId: entry.worktree.id,
      stateHash,
      ...(activitySeq > 0 ? { activitySeq } : {}),
    });
  }

  /** Waits (bounded) for reconciliation and first summaries of the given projects. */
  async #awaitInitial(projects: ProjectEntry[]): Promise<void> {
    const reconciling = projects
      .map((p) => p.reconciling)
      .filter((p): p is Promise<void> => p !== null);
    const deadline = Date.now() + this.#initialWaitMs;
    if (reconciling.length) await settleWithin(Promise.all(reconciling), this.#initialWaitMs);
    const pending: Promise<void>[] = [];
    for (const project of projects) {
      for (const e of project.worktrees.values()) {
        if (e.attempted) continue;
        pending.push(e.refresher.current ?? this.#refresh(e));
      }
    }
    const remaining = deadline - Date.now();
    if (pending.length && remaining > 0) await settleWithin(Promise.all(pending), remaining);
  }

  async #ensureSummary(entry: WorktreeEntry): Promise<void> {
    if (entry.attempted) return;
    await (entry.refresher.current ?? this.#refresh(entry));
  }

  async refreshWorktree(worktreeId: string): Promise<WorktreeSummary> {
    const { project, entry } = this.#requireWorktree(worktreeId);
    this.#invalidateWorktreeFiles(worktreeId);
    void this.#relist(project);
    await this.#refresh(entry);
    if (entry.summary) {
      const review = await this.#reviewOf(project, entry);
      return review ? { ...entry.summary, review: review.info } : entry.summary;
    }
    if (entry.worktree.bare)
      throw new ApiError('bad_request', 'a bare repository has no working tree');
    throw this.#errorFromInfo(entry.error);
  }

  #errorFromInfo(info: ApiErrorInfo | null): ApiError {
    if (!info) return new ApiError('internal', 'summary unavailable');
    return new ApiError(info.code, info.message, { details: info.details });
  }

  /**
   * The focused worktree (watch priority) and the project the user has open: a focused worktree
   * opens its project, and so does `projectId` (its Overview). Opening computes review states.
   */
  setFocus(worktreeId: string | null, projectId: string | null = null, visible?: boolean): void {
    this.#watcher.setFocus(worktreeId);
    let project: ProjectEntry | undefined;
    if (worktreeId !== null) {
      for (const p of this.#projects.values()) {
        if (p.worktrees.has(worktreeId)) {
          project = p;
          break;
        }
      }
    }
    project ??= projectId === null ? undefined : this.#projects.get(projectId);
    if (project) this.#openProject(project);
    // `visible` is the client's own word; older clients are inferred (nothing selected = hidden).
    this.#onFocus?.(
      visible ?? (worktreeId !== null || projectId !== null),
      project?.row.id ?? null,
      projectId !== null,
    );
  }

  // --- live view (#38) ---------------------------------------------------------------------------

  /** The worktree's activity feed after `after` (memory only; see `activity.ts`). */
  activity(worktreeId: string, after: number, run?: string): ActivityResponse {
    this.#requireWorktree(worktreeId);
    const read = this.#activity.read(worktreeId, after, run);
    const watch: ActivityWatch = this.#watcher.liveness(worktreeId);
    return { worktreeId, ...read, watch };
  }

  /**
   * A blob of the worktree's feed: only an oid the ring or the current snapshot holds for this
   * worktree (so the route cannot read arbitrary objects of the repository), only through
   * `readBlob`, capped at `ACTIVITY_BLOB_MAX_BYTES`.
   */
  async readBlob(worktreeId: string, oid: string, maxBytes?: number): Promise<BlobResponse> {
    const { entry } = this.#requireWorktree(worktreeId);
    const read = this.#git.readBlob;
    if (!read) throw new ApiError('internal', 'blob reads are not available', { status: 501 });
    if (!this.#activity.allowsBlob(worktreeId, oid)) {
      throw new ApiError('not_found', "blob not in this worktree's recent activity");
    }
    try {
      const blob = await read.call(this.#git, this.#locator(entry), {
        oid,
        maxBytes: Math.min(maxBytes ?? ACTIVITY_BLOB_MAX_BYTES, ACTIVITY_BLOB_MAX_BYTES),
      });
      return { worktreeId, blob };
    } catch (error) {
      if (isGitCoreError(error, 'not_found')) {
        throw new ApiError('not_found', 'content gone (the object was pruned)', { cause: error });
      }
      throw error;
    }
  }

  /** Activity ring sizes (tests, memory checks). */
  activityStats(): ReturnType<ActivityStore['stats']> {
    return this.#activity.stats();
  }

  // --- files, diffs, commits -------------------------------------------------------------------

  #filesKey(worktreeId: string, scope: DiffScope): string {
    return `${worktreeId}\u0000${scopeKey(scope)}`;
  }

  #invalidateWorktreeFiles(worktreeId: string): void {
    const prefix = `${worktreeId}\u0000`;
    for (const key of this.#filesCache.keys()) {
      if (key.startsWith(prefix)) this.#filesCache.delete(key);
    }
  }

  #invalidateFiles(project: ProjectEntry): void {
    for (const id of project.worktrees.keys()) this.#invalidateWorktreeFiles(id);
  }

  /**
   * What a branch scope diffs against: `<ref>=<commit>` of its base (the scope's `base`, else the
   * project's default branch, then also `+<remote ref>=<commit>`), read from the ref files (no git
   * process, #27, #30). A branch scope's
   * file list depends on HEAD, the working tree and this commit, and nothing else: a default
   * branch that moves changes the merge base without touching the worktree's own state.
   * `undefined`: not a branch scope. `null`: unknown (git-core cannot say), so not cacheable.
   */
  async #branchBase(project: ProjectEntry, scope: DiffScope): Promise<string | null | undefined> {
    if (scope.kind !== 'branch') return undefined;
    const read = this.#git.readBranchBase;
    if (!read) return null;
    const name = scope.base ?? this.#defaultBranch(project);
    if (name === null) return null;
    try {
      const base = await read.call(
        this.#git,
        { id: project.row.id, commonDir: project.row.commonDir },
        scope.base ? { base: scope.base } : { defaultBranch: name },
      );
      if (!base) return null;
      // The default branch counts with its remote-tracking ref (#30): either one moving changes the merge base.
      return base.remote
        ? `${base.ref}=${base.oid}+${base.remote.ref}=${base.remote.oid}`
        : `${base.ref}=${base.oid}`;
    } catch (error) {
      if (!isShutdownError(error)) this.#log.debug('branch base unreadable', { error });
      return null;
    }
  }

  /**
   * Where git reads attributes that no worktree state covers: `<commonDir>/info/attributes` and the
   * user's global attributes file in its default places. They decide how committed changes are
   * diffed (`-diff`, `binary`), so an edit to one must not be served from the cache. A tracked or
   * untracked `.gitattributes` is already in the `stateHash`. A custom `core.attributesFile` is not
   * covered (reading it needs git config; the next HEAD or worktree change refreshes the entry).
   */
  async #attributesStamp(project: ProjectEntry): Promise<string> {
    const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), '.config');
    const files = [
      join(project.row.commonDir, 'info', 'attributes'),
      join(xdg, 'git', 'attributes'),
    ];
    const stamps = await Promise.all(
      files.map((file) =>
        stat(file).then(
          (info) => `${info.mtimeMs}:${info.size}`,
          () => '-',
        ),
      ),
    );
    return stamps.join('|');
  }

  /**
   * Changed files from git-core, cached by (worktree, scope, stateHash, base commit) and
   * single-flight. The cache key is exactly "the state changed": the worktree's `stateHash`
   * covers HEAD, the index and the working tree; `base` the ref a branch scope is measured
   * against. A forced refresh and every project change drop the entries (`#invalidate*`).
   */
  async #gitFiles(
    project: ProjectEntry,
    entry: WorktreeEntry,
    scope: DiffScope,
  ): Promise<GitChangedFile[]> {
    const key = this.#filesKey(entry.worktree.id, scope);
    const stateHash = scope.kind === 'commit' ? 'immutable' : (entry.summary?.stateHash ?? null);
    const base = (await this.#branchBase(project, scope)) ?? null;
    const attrs = await this.#attributesStamp(project);
    const cacheable =
      isCacheableScope(scope) && stateHash !== null && (scope.kind !== 'branch' || base !== null);
    if (cacheable) {
      const cached = this.#filesCache.get(key);
      if (
        cached &&
        cached.stateHash === stateHash &&
        cached.base === base &&
        cached.attrs === attrs
      ) {
        this.#filesCache.delete(key);
        this.#filesCache.set(key, cached);
        return cached.files;
      }
    }
    const flightKey = `${key}\u0000${stateHash ?? ''}\u0000${base ?? ''}\u0000${attrs}`;
    const inflight = this.#filesInflight.get(flightKey);
    if (inflight) return inflight;
    const run = this.#git
      .listChangedFiles(this.#locator(entry), scope, {
        defaultBranch: this.#defaultBranch(project),
      })
      .then((files) => {
        // Tracked files under ignored build directories make them watched (review F5).
        const tracked: string[] = [];
        for (const f of files) {
          if (f.status === 'untracked') continue;
          tracked.push(f.path);
          if (f.oldPath) tracked.push(f.oldPath);
        }
        if (tracked.length) this.#watcher.noteTrackedPaths(entry.worktree.id, tracked);
        if (cacheable && stateHash !== null && project.worktrees.get(entry.worktree.id) === entry) {
          this.#filesCache.set(key, { stateHash, base, attrs, files });
          while (this.#filesCache.size > CORE_DEFAULTS.filesCacheSize) {
            const oldest = this.#filesCache.keys().next().value;
            if (oldest === undefined) break;
            this.#filesCache.delete(oldest);
          }
        }
        return files;
      })
      .finally(() => {
        this.#filesInflight.delete(flightKey);
      });
    this.#filesInflight.set(flightKey, run);
    return run;
  }

  /**
   * The files of a list with their origins (#33, `GitCore.readFileOrigins`), for the scopes that
   * have them (`originBaseOf`). Cached per listed array and `key` (see `#origins`), single-flight,
   * through `#originsLimit`: a repeat costs no git process. Without any committed file and with no
   * operation in progress every file is own (rule 1) and git-core is not asked. `required`: ask
   * even for an empty list (the review state wants `N` for its commits). On failure, or without
   * `readFileOrigins`, the files come back as they are (all own) with `known: false`.
   */
  async #labelFiles(
    project: ProjectEntry,
    entry: WorktreeEntry,
    scope: DiffScope,
    files: GitChangedFile[],
    required = false,
  ): Promise<Labels> {
    const plain: Labels = { files, known: false, integrationRef: null, n: null };
    const read = this.#git.readFileOrigins;
    const summary = entry.summary;
    if (!read || !summary) return plain;
    const base = originBaseOf(scope, summary.headSha);
    if (base === undefined) return plain;
    if (!required) {
      const committed = base !== null && files.some((f) => !isUncommitted(f));
      if (files.length === 0 || (!committed && summary.inProgress === null)) {
        return { ...plain, known: true };
      }
    }
    const refs = await this.#branchBase(project, DEFAULT_BASE_SCOPE);
    const defaultBranch = this.#defaultBranch(project);
    const key = [scopeKey(scope), base ?? '', defaultBranch ?? '', refs ?? ''].join('\u0000');
    const cached = this.#origins.get(files);
    if (cached && cached.key === key) return cached.run;
    // The fallback is part of the cached promise: every caller that shares it gets the same answer,
    // so an overlapping `/files` and `/inbox` request never sees the raw failure.
    const run: Promise<Labels> = this.#originsLimit
      .run(() => read.call(this.#git, this.#locator(entry), { base, defaultBranch, files }))
      .then(
        (result): Labels => ({
          files: applyOrigins(files, result.origins),
          known: true,
          integrationRef: result.integrationRef,
          n: result.n,
        }),
      )
      .catch((error: unknown) => {
        if (this.#origins.get(files)?.run === run) this.#origins.delete(files);
        if (!isShutdownError(error)) {
          this.#log.debug('file origins unavailable', { worktreeId: entry.worktree.id, error });
        }
        return plain;
      });
    // Unreadable default-branch refs: no identity to cache under (as `#gitFiles`).
    if (refs !== null) this.#origins.set(files, { key, run });
    return run;
  }

  /** `#gitFiles` with the origins attached (`#labelFiles`). */
  async #labeledFiles(
    project: ProjectEntry,
    entry: WorktreeEntry,
    scope: DiffScope,
  ): Promise<LabeledFile[]> {
    const files = await this.#gitFiles(project, entry, scope);
    return (await this.#labelFiles(project, entry, scope, files)).files;
  }

  #summaryOrThrow(entry: WorktreeEntry): string {
    if (entry.summary) return entry.summary.stateHash;
    if (entry.worktree.bare) return 'bare';
    throw this.#errorFromInfo(entry.error);
  }

  async listFiles(worktreeId: string, scope: DiffScope): Promise<FilesResponse> {
    const { project, entry } = this.#requireWorktree(worktreeId);
    await this.#ensureSummary(entry);
    const stateHash = this.#summaryOrThrow(entry);
    const resolved = await this.#resolveScope(project, entry, scope);
    const files = await this.#labeledFiles(project, entry, resolved.scope);
    return {
      worktreeId,
      scope: resolved.scope,
      stateHash,
      files: this.#attachReviewedFor(project.row.id, resolved.scope, files, resolved.review),
    };
  }

  async getDiff(worktreeId: string, query: DiffQuery): Promise<DiffResponse> {
    const { project, entry } = this.#requireWorktree(worktreeId);
    const options: {
      defaultBranch: string | null;
      ignoreWhitespace: boolean;
      full: boolean;
      contextLines?: number;
    } = {
      defaultBranch: this.#defaultBranch(project),
      ignoreWhitespace: query.ignoreWhitespace,
      full: query.full,
    };
    if (query.context !== undefined) options.contextLines = query.context;
    const selector =
      query.rawPath === undefined
        ? { path: query.path }
        : { path: query.path, rawPath: query.rawPath };
    const resolved = await this.#resolveScope(project, entry, query.scope);
    const diff = await this.#git.getFileDiff(
      this.#locator(entry),
      resolved.scope,
      selector,
      options,
    );
    const [withReview] = this.#attachReviewedFor(
      project.row.id,
      resolved.scope,
      [diff],
      resolved.review,
    );
    return {
      worktreeId,
      scope: resolved.scope,
      diff: { ...diff, reviewed: withReview?.reviewed ?? false },
    };
  }

  async listCommits(worktreeId: string, limit: number): Promise<CommitInfo[]> {
    const { entry } = this.#requireWorktree(worktreeId);
    return this.#git.listCommits(this.#locator(entry), { limit });
  }

  /** Dirty worktrees' files in `scope`, of every project or only of `projectIds` (#10). */
  async inbox(
    scope: DiffScope,
    onlyUnreviewed: boolean,
    projectIds?: readonly string[],
  ): Promise<InboxResponse> {
    const only = projectIds ? new Set(projectIds) : null;
    const projects = [...this.#projects.values()].filter(
      (p) => !p.missing && (only === null || only.has(p.row.id)),
    );
    await this.#awaitInitial(projects);
    const candidates: Array<{
      project: ProjectEntry;
      entry: WorktreeEntry;
      summary: WorktreeSummary;
      review: EffectiveReviewPolicy | undefined;
    }> = [];
    for (const project of projects) {
      for (const entry of project.worktrees.values()) {
        const summary = entry.summary;
        if (!summary || entry.worktree.bare || entry.worktree.missing) continue;
        // Review-disabled worktrees are out of the review loop: omitted from onlyUnreviewed.
        const review = this.#policy(project, entry);
        if (onlyUnreviewed && review && !review.enabled) continue;
        const c = summary.counts;
        const relevant =
          scope.kind === 'working'
            ? summary.changedFiles > 0
            : scope.kind === 'staged'
              ? c.staged + c.conflicted > 0
              : scope.kind === 'unstaged'
                ? c.unstaged + c.untracked + c.conflicted > 0
                : true;
        if (relevant) candidates.push({ project, entry, summary, review });
      }
    }
    // Single-flight (#27): the UI asks for the same inbox from several places at once (first
    // load, a refetch right after an event). Requests share a run only when everything the run
    // reads is equal: scope, filter, every candidate's state hash (HEAD, index, worktree and the
    // default branch's commit), effective policy, review version and project facts. A request
    // that arrives after any of those moved starts its own run, so nobody is served older data.
    const bases = new Map<string, string | null | undefined>();
    for (const project of projects)
      bases.set(project.row.id, await this.#branchBase(project, scope));
    const hash = createHash('sha1')
      .update(`${scopeKey(scope)}\u0000${onlyUnreviewed}`)
      .update(`\u0000${only ? [...only].sort().join(',') : '*'}`)
      .update(`\u0000${[...bases.values()].join('\u0001')}`);
    for (const c of candidates) {
      hash.update(
        `\u0000${c.entry.worktree.id}\u0001${c.summary.stateHash}\u0001${this.#reviewVersion.get(c.project.row.id) ?? 0}\u0001${JSON.stringify(c.review ?? null)}\u0001${JSON.stringify(this.#toProject(c.project.row))}`,
      );
    }
    const flightKey = hash.digest('hex');
    const inflight = this.#inboxInflight.get(flightKey);
    if (inflight) return inflight;
    const run = this.#buildInbox(scope, onlyUnreviewed, candidates).finally(() => {
      this.#inboxInflight.delete(flightKey);
    });
    this.#inboxInflight.set(flightKey, run);
    return run;
  }

  async #buildInbox(
    scope: DiffScope,
    onlyUnreviewed: boolean,
    candidates: ReadonlyArray<{
      project: ProjectEntry;
      entry: WorktreeEntry;
      summary: WorktreeSummary;
      review: EffectiveReviewPolicy | undefined;
    }>,
  ): Promise<InboxResponse> {
    const results = await Promise.all(
      candidates.map(async (c): Promise<InboxEntry | null> => {
        try {
          const resolved = await this.#resolveScope(c.project, c.entry, scope);
          const gitFiles = await this.#labeledFiles(c.project, c.entry, resolved.scope);
          let files = this.#attachReviewedFor(
            c.project.row.id,
            resolved.scope,
            gitFiles,
            resolved.review,
          );
          if (onlyUnreviewed) files = files.filter((f) => !f.reviewed);
          if (files.length === 0) return null;
          return {
            project: this.#toProject(c.project.row),
            worktree: c.entry.worktree,
            summary: c.summary,
            files,
            ...(c.review ? { review: c.review } : {}),
          };
        } catch (error) {
          if (!isShutdownError(error)) {
            this.#log.debug('inbox: skipping worktree', { worktreeId: c.entry.worktree.id, error });
          }
          return null;
        }
      }),
    );
    const entries = results
      .filter((e): e is InboxEntry => e !== null)
      .sort((a, b) => {
        const an = a.project.name.toLowerCase();
        const bn = b.project.name.toLowerCase();
        if (an !== bn) return an < bn ? -1 : 1;
        if (a.project.id !== b.project.id) return a.project.id < b.project.id ? -1 : 1;
        return compareWorktrees(a.worktree, b.worktree);
      });
    return { scope, entries, generatedAt: this.#nowIso() };
  }

  // --- status flow v2: review state, bookmarks (docs/STATUS-FLOW.md) ---------------------------

  /** Notes a review write in these projects: review states recompute on next use. */
  bumpReview(projectIds: Iterable<string>): void {
    for (const id of projectIds)
      this.#reviewVersion.set(id, (this.#reviewVersion.get(id) ?? 0) + 1);
  }

  /** Waits (bounded) for the review states that are wanted (`#reviewWanted`), nothing else. */
  async #awaitReviews(projects: ProjectEntry[]): Promise<void> {
    const pending: Promise<unknown>[] = [];
    for (const project of projects) {
      if (project.missing) continue;
      for (const e of project.worktrees.values()) {
        if (this.#reviewWanted(project, e)) pending.push(this.#reviewOf(project, e));
      }
    }
    if (pending.length) await settleWithin(Promise.all(pending), this.#initialWaitMs);
  }

  /**
   * Whether a worktree's review state is computed and kept current (#10): its project was
   * opened, it already has one (something asked for it: the To review scope, a bookmark move),
   * or it changed after its first summary in this session (live work). Never at startup alone.
   */
  #reviewWanted(project: ProjectEntry, entry: WorktreeEntry): boolean {
    if (this.#openProjects.has(project.row.id) || entry.review !== null) return true;
    const summary = entry.summary;
    return summary !== null && entry.firstHash !== null && entry.firstHash !== summary.stateHash;
  }

  /**
   * Opens a project (#10): its worktrees' review states are computed now, in the background,
   * and kept current from then on. Clients hear `review.ready` once they are available.
   */
  #openProject(project: ProjectEntry): void {
    if (this.#closed || project.missing || this.#openProjects.has(project.row.id)) return;
    this.#openProjects.add(project.row.id);
    for (const e of project.worktrees.values()) {
      void (e.refresher.current ?? Promise.resolve()).then(() => this.#reviewOf(project, e));
    }
  }

  /** Batches `review.ready` per project: one event per burst of first review states. */
  #noteReviewReady(projectId: string): void {
    if (this.#closed) return;
    this.#reviewReady.add(projectId);
    if (this.#reviewReadyTimer) return;
    this.#reviewReadyTimer = setTimeout(() => {
      this.#reviewReadyTimer = null;
      const ids = [...this.#reviewReady];
      this.#reviewReady.clear();
      if (this.#closed) return;
      for (const id of ids) {
        if (this.#projects.has(id)) this.#hub.emit({ type: 'review.ready', projectId: id });
      }
    }, REVIEW_READY_BATCH_MS);
    this.#reviewReadyTimer.unref();
  }

  /**
   * The worktree's review state, computed once per (summary state, review version, default
   * branch) and single-flight. Null without a summary, for bare or missing worktrees, or when
   * git-core cannot read review ranges (test doubles). On failure the last state is kept.
   */
  #reviewOf(project: ProjectEntry, entry: WorktreeEntry): Promise<ReviewComputed | null> {
    const summary = entry.summary;
    if (
      !summary ||
      !this.#git.readReviewRange ||
      entry.worktree.bare ||
      entry.worktree.missing ||
      project.missing
    ) {
      return Promise.resolve(null);
    }
    const key = [
      summary.stateHash,
      this.#reviewVersion.get(project.row.id) ?? 0,
      this.#defaultBranch(project) ?? '',
    ].join('\u0000');
    if (entry.review?.key === key) return Promise.resolve(entry.review);
    if (entry.reviewRun?.key === key) return entry.reviewRun.promise;
    const promise = this.#computeReview(project, entry, key).then(
      (review) => {
        if (project.worktrees.get(entry.worktree.id) === entry) {
          // First review state of this worktree (opened, or asked for by a request): rows that
          // showed plain changes now show their review stage. Later ones ride on the usual
          // events (`worktree.changed`, `review.*`).
          if (entry.review === null) this.#noteReviewReady(project.row.id);
          entry.review = review;
        }
        return review;
      },
      (error: unknown) => {
        if (!isShutdownError(error)) {
          this.#log.debug('review state failed', { worktreeId: entry.worktree.id, error });
        }
        return entry.review;
      },
    );
    const run = { key, promise };
    entry.reviewRun = run;
    void promise.finally(() => {
      if (entry.reviewRun === run) entry.reviewRun = null;
    });
    return promise;
  }

  async #computeReview(
    project: ProjectEntry,
    entry: WorktreeEntry,
    key: string,
  ): Promise<ReviewComputed> {
    const readRange = this.#git.readReviewRange;
    const summary = entry.summary;
    if (!readRange || !summary) throw new ApiError('internal', 'review state unavailable');
    const projectId = project.row.id;
    const bk = bookmarkKey(entry.worktree);
    let bookmark = this.#store.getBookmark(projectId, bk);
    const rangeKey = `${summary.headSha ?? ''}\u0000${bookmark ?? ''}`;
    let range: ReviewRange;
    if (entry.rangeCache?.key === rangeKey) {
      range = entry.rangeCache.range;
    } else {
      range = await readRange.call(this.#git, this.#locator(entry), {
        bookmark,
        defaultBranch: this.#defaultBranch(project),
      });
      // A reachable bookmark's range depends only on HEAD and the bookmark.
      entry.rangeCache = range.bookmarkReachable ? { key: rangeKey, range } : null;
    }
    const firstSight = bookmark === null;
    if (bookmark === null && range.initial !== null) {
      // First sight of this branch: start at HEAD (default branch) or the merge-base.
      bookmark = range.initial;
      this.#store.setBookmark(projectId, bk, bookmark, this.#nowIso());
    }
    const scope: DiffScope = range.base ? { kind: 'review', base: range.base } : { kind: 'review' };
    const nothing =
      summary.changedFiles === 0 && (range.base === null || range.base === range.head);
    // Commit coverage and the file list (then its origins) are independent reads.
    const [coverage, labels] = await Promise.all([
      this.#commitCoverage(project, entry, range),
      nothing
        ? null
        : this.#gitFiles(project, entry, scope).then((files) =>
            this.#labelFiles(project, entry, scope, files, true),
          ),
    ]);
    const { uncovered } = coverage;
    // Default-branch commits a merge or rebase brought in are not this branch's new work (#33):
    // not counted here and never recorded as reviewed from here. Their paths stay in `uncovered`,
    // so the files they touched are not taken as reviewed (`unreviewedFiles` keeps its meaning).
    const baseCommits = defaultBranchCommits(range, labels?.n ?? null);
    const unreviewedCommits = coverage.unreviewedCommits.filter((sha) => !baseCommits.has(sha));
    const marked = this.#attachReviewed(projectId, 'review', labels?.files ?? []);
    let unreviewedFiles = 0;
    let unreviewedOwnFiles = 0;
    let baseFiles = 0;
    for (const f of marked) {
      const base = f.origin === 'base';
      if (base) baseFiles++;
      if (f.reviewed || coveredByCommits(f, uncovered)) continue;
      unreviewedFiles++;
      if (!base) unreviewedOwnFiles++;
    }
    // Known when there was nothing to label, or when the labels were computed.
    const known = this.#git.readFileOrigins !== undefined && (labels === null || labels.known);
    // Non-own labels by path, for the activity feed (#38): no git process of its own.
    let origins: Map<string, OriginLabel> | null = null;
    if (known && labels !== null) {
      origins = new Map();
      for (const f of labels.files) {
        if (f.origin === undefined || f.origin === 'own') continue;
        origins.set(pathKey(f), {
          origin: f.origin,
          ...(f.originVia !== undefined ? { originVia: f.originVia } : {}),
        });
      }
    }
    return {
      key,
      bookmarkKey: bk,
      range,
      scope,
      uncovered,
      unreviewedCommits,
      baseCommits,
      integrationBase: labels?.n ?? null,
      origins,
      info: {
        bookmark,
        base: range.base,
        newCommits: unreviewedCommits.length,
        unreviewedFiles,
        historyRewritten: !firstSight && range.head !== null && !range.bookmarkReachable,
        ...(known ? { baseFiles, unreviewedOwnFiles } : {}),
        ...(labels?.integrationRef ? { integrationRef: labels.integrationRef } : {}),
      },
    };
  }

  /**
   * Which commits of the range are unreviewed and which paths they touched (§2.4). Without
   * commit facts every commit counts and coverage is unknown.
   */
  async #commitCoverage(
    project: ProjectEntry,
    entry: WorktreeEntry,
    range: ReviewRange,
  ): Promise<{ unreviewedCommits: string[]; uncovered: Set<string> | null }> {
    const all = range.commits.map((c) => c.sha);
    if (range.commits.length === 0) return { unreviewedCommits: [], uncovered: new Set() };
    const describe = this.#git.describeCommits;
    if (!describe) return { unreviewedCommits: all, uncovered: null };
    const reviewedShas = new Set<string>();
    const reviewedPatches = new Set<string>();
    for (const c of this.#store.listReviewedCommits(project.row.id)) {
      reviewedShas.add(c.sha);
      if (c.patchId) reviewedPatches.add(c.patchId);
    }
    const unknown = range.commits.filter((c) => !reviewedShas.has(c.sha));
    if (unknown.length === 0) return { unreviewedCommits: [], uncovered: new Set() };
    const details = await describe.call(
      this.#git,
      this.#locator(entry),
      unknown.map((c) => c.sha),
    );
    const unreviewedCommits: string[] = [];
    const uncovered = new Set<string>();
    unknown.forEach((commit, i) => {
      const d = details[i];
      if (!d) return;
      const merge = commit.parents.length > 1;
      // Same change already reviewed elsewhere (rebase, cherry-pick, squash of a reviewed range).
      if (!merge && d.patchId !== null && reviewedPatches.has(d.patchId)) return;
      // A clean merge or an empty commit brings nothing new; a merge's `--cc` paths are its
      // conflict resolutions and evil-merge edits.
      if (d.paths.length === 0) return;
      unreviewedCommits.push(commit.sha);
      for (const p of d.paths) uncovered.add(p);
    });
    return { unreviewedCommits, uncovered: range.truncated ? null : uncovered };
  }

  /**
   * `scope=review` without a base resolves to the worktree's review base (its bookmark, or the
   * fallback after a history rewrite). Other scopes pass through.
   */
  async #resolveScope(
    project: ProjectEntry,
    entry: WorktreeEntry,
    scope: DiffScope,
  ): Promise<{ scope: DiffScope; review: ReviewComputed | null }> {
    if (scope.kind !== 'review' || scope.base) return { scope, review: null };
    await this.#ensureSummary(entry);
    const review = await this.#reviewOf(project, entry);
    return review ? { scope: review.scope, review } : { scope, review: null };
  }

  /** Review marks, plus (in the review scope) files that only reviewed commits touched. */
  #attachReviewedFor<T extends Pick<GitChangedFile, 'path' | 'rawPath' | 'patchHash'>>(
    projectId: string,
    scope: DiffScope,
    files: T[],
    review: ReviewComputed | null,
  ): Array<T & { reviewed: boolean }> {
    const out = this.#attachReviewed(projectId, scope.kind, files);
    if (!review || review.uncovered === null) return out;
    return out.map((f) =>
      f.reviewed ||
      !coveredByCommits(f as unknown as Parameters<typeof coveredByCommits>[0], review.uncovered)
        ? f
        : { ...f, reviewed: true },
    );
  }

  /**
   * Moves the worktree's bookmark to `to` (HEAD or an ancestor of it, full commit id). Records
   * the commits it passes as reviewed (step 3). Emits `review.bookmark`.
   */
  async moveBookmark(worktreeId: string, to: string): Promise<BookmarkMove> {
    const { project, entry } = this.#requireWorktree(worktreeId);
    const readRange = this.#git.readReviewRange;
    if (!readRange) throw new ApiError('bad_request', 'review bookmarks are not supported');
    if (entry.worktree.bare) throw new ApiError('bad_request', 'a bare repository has no HEAD');
    const target = to.toLowerCase();
    if (!FULL_SHA.test(target)) throw new ApiError('bad_request', 'to must be a full commit id');
    await this.#ensureSummary(entry);
    const projectId = project.row.id;
    const key = bookmarkKey(entry.worktree);
    const previous = this.#store.getBookmark(projectId, key);
    const check = await readRange.call(this.#git, this.#locator(entry), {
      bookmark: target,
      defaultBranch: this.#defaultBranch(project),
      maxCommits: 1,
    });
    if (check.head === null || !check.bookmarkReachable) {
      throw new ApiError('bad_request', 'to must be HEAD or an ancestor of HEAD');
    }
    const recorded = await this.#recordReviewed(project, entry, target);
    this.#store.setBookmark(projectId, key, target, this.#nowIso());
    this.bumpReview([projectId]);
    this.#hub.emit({ type: 'review.bookmark', projectId, worktreeId, bookmark: target });
    return { projectId, worktreeId, key, previous, bookmark: target, recorded };
  }

  /**
   * Records the commits a bookmark move passes as reviewed (§2.4): each commit by id and
   * patch-id, plus the whole range's patch-id as `<base>..<to>` (a squash merge of it has the
   * same one). Only when `to` is HEAD (Review all), where the range is the review range itself.
   * Default-branch commits in the range (`ReviewComputed.baseCommits`, #33) are not recorded: they
   * were shown as noise here, and recording them would make the default branch's own worktree
   * take them as reviewed. With such commits the whole-range patch-id is the branch's own part,
   * `N..<to>` (what a squash merge of the branch onto the default branch carries).
   */
  async #recordReviewed(
    project: ProjectEntry,
    entry: WorktreeEntry,
    to: string,
  ): Promise<string[]> {
    const review = await this.#reviewOf(project, entry);
    const range = review?.range;
    if (!review || !range || range.head !== to || range.base === null || range.base === to) {
      return [];
    }
    const noise = review.baseCommits;
    const commits = range.commits.filter((c) => !noise.has(c.sha));
    const details =
      this.#git.describeCommits && commits.length > 0
        ? await this.#git.describeCommits(
            this.#locator(entry),
            commits.map((c) => c.sha),
          )
        : [];
    const rows = commits.map((c, i) => ({ sha: c.sha, patchId: details[i]?.patchId ?? null }));
    const from =
      noise.size > 0 && review.integrationBase !== null ? review.integrationBase : range.base;
    const whole =
      this.#git.rangePatchId && from !== to
        ? await this.#git.rangePatchId(this.#locator(entry), from, to)
        : null;
    if (whole !== null) rows.push({ sha: `${from}..${to}`, patchId: whole });
    return this.#store.transaction(() =>
      this.#store.addReviewedCommits(project.row.id, rows, this.#nowIso()),
    );
  }

  /** Undo of a bookmark move: restores `previous` unless the bookmark moved again since. */
  restoreBookmark(move: BookmarkMove): boolean {
    if (this.#store.getBookmark(move.projectId, move.key) !== move.bookmark) return false;
    this.#store.transaction(() => {
      this.#store.setBookmark(move.projectId, move.key, move.previous, this.#nowIso());
      this.#store.removeReviewedCommits(move.projectId, move.recorded);
    });
    this.bumpReview([move.projectId]);
    this.#hub.emit({
      type: 'review.bookmark',
      projectId: move.projectId,
      worktreeId: move.worktreeId,
      bookmark: move.previous,
    });
    return true;
  }

  // --- review marks ----------------------------------------------------------------------------

  #attachReviewed<T extends Pick<GitChangedFile, 'path' | 'rawPath' | 'patchHash'>>(
    projectId: string,
    scopeKind: ScopeKind,
    files: T[],
  ): Array<T & { reviewed: boolean }> {
    if (files.length === 0) return [];
    const marks = this.#store.listReviewMarks(projectId, scopeKind);
    if (marks.length === 0) return files.map((f) => ({ ...f, reviewed: false }));
    const byKey = new Map<string, ReviewMark>();
    for (const m of marks) byKey.set(reviewLookupKey(m.raw, m.path, m.patchHash), m);
    const now = this.#now();
    const touch: ReviewMark[] = [];
    const out = files.map((f) => {
      const mark = byKey.get(
        reviewLookupKey(f.rawPath !== undefined, f.rawPath ?? f.path, f.patchHash),
      );
      if (mark && now.getTime() - Date.parse(mark.lastSeenAt) > REVIEW_TOUCH_INTERVAL_MS)
        touch.push(mark);
      return { ...f, reviewed: mark !== undefined };
    });
    if (touch.length > 0) {
      try {
        this.#store.touchReviewMarks(projectId, scopeKind, touch, now.toISOString());
      } catch (error) {
        this.#log.warn('could not refresh review marks', { error });
      }
    }
    return out;
  }

  setReview(request: ReviewRequest): ReviewResponse {
    this.#requireProject(request.projectId);
    this.#store.setReviewed(
      {
        projectId: request.projectId,
        scopeKind: request.scopeKind,
        path: request.path,
        rawPath: request.rawPath,
        patchHash: request.patchHash,
      },
      request.reviewed,
      this.#nowIso(),
    );
    this.bumpReview([request.projectId]);
    this.#hub.emit({
      type: 'review.changed',
      projectId: request.projectId,
      scopeKind: request.scopeKind,
      path: request.path,
      ...(request.rawPath !== undefined ? { rawPath: request.rawPath } : {}),
      patchHash: request.patchHash,
      reviewed: request.reviewed,
    });
    return { ok: true, reviewed: request.reviewed };
  }

  /**
   * Read-only view for bulk review (UX round 1, review-controls.ts): registry lookups, the
   * worktrees a bulk target resolves to (after the bounded wait for first summaries), and the
   * cached file lists. Nothing here spawns git per file.
   */
  reviewSource(): ReviewSource {
    const toBulk = (project: ProjectEntry, e: WorktreeEntry): BulkWorktree => ({
      worktreeId: e.worktree.id,
      projectId: project.row.id,
      scanRootId: project.row.scanRootId,
      branch: e.worktree.branch,
      detached: e.worktree.detached,
      bare: e.worktree.bare,
      missing: e.worktree.missing,
      prunable: e.worktree.prunable,
      summary: e.summary,
    });
    return {
      hasProject: (projectId) => this.#projects.has(projectId),
      hasScanRoot: (scanRootId) => this.#scanRoots.has(scanRootId),
      projectOfWorktree: (worktreeId) => {
        for (const p of this.#projects.values()) if (p.worktrees.has(worktreeId)) return p.row.id;
        return null;
      },
      worktrees: async (target: BulkReviewTarget) => {
        if (target.kind === 'worktree') {
          const { project, entry } = this.#requireWorktree(target.worktreeId);
          await this.#ensureSummary(entry);
          return [toBulk(project, entry)];
        }
        let projects: ProjectEntry[];
        if (target.kind === 'project') {
          projects = [this.#requireProject(target.projectId)];
        } else {
          if (target.kind === 'folder' && !this.#scanRoots.has(target.scanRootId))
            throw notFound('scan root');
          projects = [...this.#projects.values()].filter(
            (p) => target.kind === 'all' || p.row.scanRootId === target.scanRootId,
          );
        }
        projects = projects.filter((p) => !p.missing);
        await this.#awaitInitial(projects);
        return projects.flatMap((p) => [...p.worktrees.values()].map((e) => toBulk(p, e)));
      },
      changedFiles: async (worktreeId, scope) => {
        const { project, entry } = this.#requireWorktree(worktreeId);
        const resolved = await this.#resolveScope(project, entry, scope);
        return this.#labeledFiles(project, entry, resolved.scope);
      },
      moveBookmark: (worktreeId, to) => this.moveBookmark(worktreeId, to),
      restoreBookmark: (move) => this.restoreBookmark(move),
      reviewChanged: (projectIds) => this.bumpReview(projectIds),
      currentStateHash: (worktreeId) => {
        for (const p of this.#projects.values()) {
          const e = p.worktrees.get(worktreeId);
          if (e) return e.summary?.stateHash ?? null;
        }
        return null;
      },
    };
  }

  // --- scan roots ------------------------------------------------------------------------------

  #toScanRoot(row: ScanRootRow): ScanRoot {
    let projectCount = 0;
    for (const p of this.#projects.values()) if (p.row.scanRootId === row.id) projectCount++;
    return {
      id: row.id,
      path: row.path,
      depth: row.depth,
      addedAt: row.addedAt,
      lastScannedAt: row.lastScannedAt,
      projectCount,
    };
  }

  listScanRoots(): ScanRoot[] {
    return [...this.#scanRoots.values()].map((s) => this.#toScanRoot(s.row));
  }

  /** Registers a scan root (idempotent) and starts a background scan. */
  async addScanRoot(
    inputPath: string,
    depth: number,
  ): Promise<{ scanRoot: ScanRoot; created: boolean }> {
    const real = await this.#resolveDirectory(inputPath);
    this.#assertOpen();
    const id = hashId(real);
    let st = this.#scanRoots.get(id);
    let created = false;
    if (st) {
      if (st.row.depth !== depth) {
        this.#store.setScanRootDepth(id, depth);
        st.row.depth = depth;
      }
    } else {
      const row: ScanRootRow = {
        id,
        path: real,
        depth,
        addedAt: this.#nowIso(),
        lastScannedAt: null,
      };
      this.#store.insertScanRoot(row);
      st = { row, controller: null, running: null };
      this.#scanRoots.set(id, st);
      created = true;
      this.#log.info('scan root added', { scanRootId: id, path: real, depth });
    }
    this.#startScan(st);
    return { scanRoot: this.#toScanRoot(st.row), created };
  }

  rescan(scanRootId: string): ScanRoot {
    const st = this.#scanRoots.get(scanRootId);
    if (!st) throw notFound('scan root');
    this.#startScan(st);
    return this.#toScanRoot(st.row);
  }

  /**
   * Removes a scan root and the projects it discovered (projects added explicitly, or first
   * discovered by another scan root, stay registered).
   */
  async removeScanRoot(scanRootId: string): Promise<void> {
    const st = this.#scanRoots.get(scanRootId);
    if (!st) throw notFound('scan root');
    this.#scanRoots.delete(scanRootId);
    st.controller?.abort();
    for (const project of [...this.#projects.values()]) {
      if (project.row.scanRootId === scanRootId)
        void this.#dropProject(project, { exclude: false });
    }
    this.#store.deleteScanRoot(scanRootId);
    this.#reviewPolicy?.onScanRootRemoved(scanRootId);
    this.#log.info('scan root removed', { scanRootId, path: st.row.path });
    if (st.running) await settleWithin(st.running, 2000);
  }

  /** Waits for a scan root's current scan (tests). */
  async waitForScan(scanRootId: string): Promise<void> {
    const st = this.#scanRoots.get(scanRootId);
    if (st?.running) await st.running;
  }

  #startScan(st: ScanState): void {
    if (this.#closed) return;
    st.controller?.abort();
    const controller = new AbortController();
    st.controller = controller;
    const previous = st.running;
    const run = (async () => {
      if (previous) await previous.catch(() => {});
      if (controller.signal.aborted || this.#closed) return;
      await this.#runScan(st, controller.signal);
    })();
    st.running = run.finally(() => {
      if (st.controller === controller) {
        st.controller = null;
        st.running = null;
      }
    });
  }

  async #runScan(st: ScanState, signal: AbortSignal): Promise<void> {
    const scanRootId = st.row.id;
    const emit = (
      state: 'scanning' | 'done' | 'error',
      scannedDirs: number,
      foundRepos: number,
      message: string | null,
    ) => {
      if (this.#scanRoots.get(scanRootId) !== st) return;
      this.#hub.emit({
        type: 'scan.progress',
        scanRootId,
        state,
        scannedDirs,
        foundRepos,
        message,
      });
    };
    emit('scanning', 0, 0, null);
    let lastEmit = 0;
    try {
      const result = await this.#git.scan(st.row.path, {
        depth: st.row.depth,
        signal,
        onProgress: (progress) => {
          if (signal.aborted) return;
          const now = Date.now();
          if (now - lastEmit < CORE_DEFAULTS.scanProgressIntervalMs) return;
          lastEmit = now;
          emit('scanning', progress.scannedDirs, progress.foundRepos, null);
        },
      });
      let registered = 0;
      for (const repoPath of result.repositories) {
        if (signal.aborted || this.#closed) return;
        try {
          const resolved = await this.#git.resolveProject(repoPath);
          if (signal.aborted || this.#closed) return;
          const { entry } = this.#register(resolved, { scanRootId, explicit: false });
          if (entry) registered++;
        } catch (error) {
          if (isShutdownError(error)) return;
          this.#log.warn('scan: skipping a repository that could not be resolved', {
            path: repoPath,
            error,
          });
        }
      }
      if (signal.aborted || this.#closed || this.#scanRoots.get(scanRootId) !== st) return;
      const at = this.#nowIso();
      this.#store.setScanRootScanned(scanRootId, at);
      st.row.lastScannedAt = at;
      this.#log.info('scan finished', {
        scanRootId,
        scannedDirs: result.scannedDirs,
        foundRepos: result.repositories.length,
        registered,
        truncated: result.truncated,
      });
      emit(
        'done',
        result.scannedDirs,
        result.repositories.length,
        result.truncated ? 'scan stopped early (directory limit reached)' : null,
      );
    } catch (error) {
      if (signal.aborted || this.#closed || isShutdownError(error)) return;
      const message = toApiError(error).message;
      this.#log.warn('scan failed', { scanRootId, error });
      emit('error', 0, 0, message);
    }
  }
}
