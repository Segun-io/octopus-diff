import { randomBytes } from 'node:crypto';
import {
  BULK_UNDO_MAX_ENTRIES,
  BULK_UNDO_TTL_MS,
  type BulkReviewTarget,
  type DiffScope,
  type GitChangedFile,
  type ScopeKind,
  type WorktreeSummary,
} from '@octopus-diff/contracts';
import type { TargetRegistry } from './review-policy.js';

/**
 * Bulk review ("Mark all as verified") building blocks (COORDINATION §2.2): the read-only view of
 * the registry the operation needs, the pure helpers (file selection, inbox-style relevance), and
 * the in-memory undo store. The orchestration lives in `review-controls.ts`.
 */

/** One worktree as seen by bulk review: registry facts plus the current summary (if any). */
export interface BulkWorktree {
  worktreeId: string;
  projectId: string;
  scanRootId: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  missing: boolean;
  prunable: boolean;
  summary: WorktreeSummary | null;
}

/**
 * What bulk review reads from the core. Implemented by `DaemonCore.reviewSource()`; everything is
 * a read of in-memory state or of the cached file lists (never one git process per file).
 */
export interface ReviewSource extends TargetRegistry {
  /**
   * The worktrees a bulk target resolves to, after the bounded wait for first summaries. Throws
   * `not_found` for an unknown project, scan root or worktree.
   */
  worktrees(target: BulkReviewTarget): Promise<BulkWorktree[]>;
  /** Changed files of a worktree in a scope (the same list `GET .../files` returns). */
  changedFiles(worktreeId: string, scope: DiffScope): Promise<GitChangedFile[]>;
  /** The worktree's current summary `stateHash`, or null when it has none right now. */
  currentStateHash(worktreeId: string): string | null;
}

/** Same prefilter the inbox uses: can this worktree have files in `scope` at all? */
export function mayHaveFiles(summary: WorktreeSummary, scope: DiffScope): boolean {
  const c = summary.counts;
  switch (scope.kind) {
    case 'working':
      return summary.changedFiles > 0;
    case 'staged':
      return c.staged + c.conflicted > 0;
    case 'unstaged':
      return c.unstaged + c.untracked + c.conflicted > 0;
    default:
      return true;
  }
}

export interface PathSelector {
  path: string;
  rawPath?: string | undefined;
}

/** `rawPath` wins over `path`, as everywhere else (`getFileDiff` selectors). */
export function fileMatchesSelector(
  file: Pick<GitChangedFile, 'path' | 'rawPath'>,
  selector: PathSelector,
): boolean {
  return selector.rawPath !== undefined
    ? file.rawPath === selector.rawPath
    : file.rawPath === undefined && file.path === selector.path;
}

/** Keeps the files named by `paths` (unknown selectors are ignored). */
export function filterByPaths<T extends Pick<GitChangedFile, 'path' | 'rawPath'>>(
  files: readonly T[],
  paths: readonly PathSelector[],
): T[] {
  const byPath = new Set<string>();
  const byRaw = new Set<string>();
  for (const p of paths) {
    if (p.rawPath !== undefined) byRaw.add(p.rawPath);
    else byPath.add(p.path);
  }
  return files.filter((f) => (f.rawPath !== undefined ? byRaw.has(f.rawPath) : byPath.has(f.path)));
}

/** One mark a bulk call created or removed (the undo unit). */
export interface MarkChange {
  projectId: string;
  /** Display path. */
  path: string;
  /** Raw path (base64) when the file's path is not valid UTF-8. */
  rawPath: string | undefined;
  patchHash: string;
}

export interface UndoEntry {
  /** ISO timestamp the bulk call stamped on the marks it created. */
  at: string;
  scopeKind: ScopeKind;
  /** What the bulk call did: true = created marks, false = removed marks. */
  reviewed: boolean;
  changes: MarkChange[];
}

interface StoredUndo extends UndoEntry {
  token: string;
  expiresAt: number;
}

export interface UndoStoreOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => Date;
}

/**
 * Undo tokens: random, single-use, memory only (lost on restart), valid for `BULK_UNDO_TTL_MS`,
 * at most `BULK_UNDO_MAX_ENTRIES` (the oldest is dropped first).
 */
export class UndoStore {
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => Date;
  /** Insertion-ordered, oldest first. */
  readonly #entries = new Map<string, StoredUndo>();

  constructor(options: UndoStoreOptions = {}) {
    this.#ttlMs = options.ttlMs ?? BULK_UNDO_TTL_MS;
    this.#max = Math.max(1, options.maxEntries ?? BULK_UNDO_MAX_ENTRIES);
    this.#now = options.now ?? (() => new Date());
  }

  get size(): number {
    this.#prune();
    return this.#entries.size;
  }

  /** Stores an entry and returns its token. */
  put(entry: UndoEntry): string {
    this.#prune();
    const token = randomBytes(24).toString('base64url');
    this.#entries.set(token, {
      ...entry,
      token,
      expiresAt: this.#now().getTime() + this.#ttlMs,
    });
    while (this.#entries.size > this.#max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    return token;
  }

  /** Removes and returns the entry (single use); null when unknown, expired or already used. */
  take(token: string): UndoEntry | null {
    this.#prune();
    const entry = this.#entries.get(token);
    if (!entry) return null;
    this.#entries.delete(token);
    const { token: _t, expiresAt: _e, ...rest } = entry;
    return rest;
  }

  #prune(): void {
    const now = this.#now().getTime();
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(token);
    }
  }
}
