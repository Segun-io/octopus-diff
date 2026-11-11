import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger, WatcherMode, WatchTargets } from '@octopus-diff/contracts';
import type parcelWatcher from '@parcel/watcher';
import { isSameOrInside } from './paths.js';
import {
  defaultGuardDirs,
  dirRefusal,
  type GuardDirs,
  MAX_WATCHED_WORKTREES_PER_PROJECT,
  type WatchRefusal,
  worktreeRootRefusal,
} from './watch-guard.js';
import { createWatchHost, type WatchHost } from './watch-host.js';
import { dirIdentity } from './watch-identity.js';
import {
  ancestorsOf,
  BUILD_OUTPUT_DIRS,
  type BuildDirRules,
  buildDirIgnoreEntries,
  buildDirsOf,
  emptyBuildDirRules,
  isIgnoredBuildDir,
  readExcludeFile,
  readNestedBuildDirRules,
  readRootBuildDirRules,
} from './watch-ignores.js';

export type SubscribeFn = (
  dir: string,
  fn: parcelWatcher.SubscribeCallback,
  opts?: parcelWatcher.Options,
) => Promise<parcelWatcher.AsyncSubscription>;

export type DirtyReason = 'fs' | 'git' | 'poll' | 'focus' | 'manual';

/**
 * Directory names never watched inside working trees (PLAN §5.6), at any depth: dependency,
 * cache and tool directories that are practically never tracked. Build-output names
 * (`BUILD_OUTPUT_DIRS`: dist, build, out, target, coverage) are skipped only where git ignores
 * them (review F5, see `watch-ignores.ts`).
 */
export const DEFAULT_WORKTREE_IGNORES: readonly string[] = [
  '.git',
  'node_modules',
  'bower_components',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  '.vite',
  '.gradle',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  '.terraform',
  '.direnv',
];

/**
 * Parts of a common git dir that never affect status (watching them would be expensive).
 * `info/` (exclude, attributes) and submodule git dirs (`modules/<name>`, per linked worktree
 * `worktrees/<wt>/modules/<name>`) are watched, minus their heavy parts (reviews F3, F6).
 */
export const GIT_DIR_IGNORES: readonly string[] = [
  'objects',
  'logs',
  'hooks',
  'lfs',
  'rr-cache',
  'fsmonitor--daemon',
  'worktrees/*/logs',
  '{modules,worktrees/*/modules}/**/{objects,logs,hooks,lfs,rr-cache,fsmonitor--daemon}',
];

export { BUILD_OUTPUT_DIRS, MAX_WATCHED_WORKTREES_PER_PROJECT };

export const WATCH_DEFAULTS = {
  debounceMs: 200,
  maxWaitMs: 1000,
  pollFocusedMs: 30_000,
  pollIdleMs: 300_000,
  /** Focused worktree without a working native watcher. */
  pollDegradedFocusedMs: 5_000,
  relistMs: 60_000,
  /**
   * First retry after a subscription reported an error (its backend died, e.g. `EINTR` in
   * @parcel/watcher's inotify thread); doubles per consecutive error, up to 5 minutes.
   */
  resubscribeDelayMs: 1_000,
} as const;

/** Upper bound of the re-subscribe backoff. */
const MAX_RESUBSCRIBE_DELAY_MS = 300_000;
/** Errors further apart than this restart the backoff. */
const ERROR_STREAK_RESET_MS = 600_000;

export interface WatchedWorktree {
  projectId: string;
  worktreeId: string;
  /** Worktree root (for a bare entry: its git dir). */
  root: string;
  bare: boolean;
  isMain: boolean;
  /** From `GitCore.getWatchTargets`; null if unavailable (then any git-dir event dirties all). */
  targets: WatchTargets | null;
}

export interface WatcherServiceOptions {
  enabled?: boolean;
  /**
   * Refresh a quiet worktree on its first event instead of after the debounce; later events
   * within the debounce window still coalesce into one trailing refresh (default false).
   */
  leadingEdge?: boolean;
  forcePolling?: boolean;
  ignore?: readonly string[];
  debounceMs?: number;
  maxWaitMs?: number;
  pollFocusedMs?: number;
  pollIdleMs?: number;
  pollDegradedFocusedMs?: number;
  relistMs?: number;
  resubscribeDelayMs?: number;
  /** Natively watched worktrees per project (default 64); the rest are polled (SEC-07). */
  maxWorktreesPerProject?: number;
  logger: Logger;
  /**
   * Injected for tests (e.g. to simulate inotify limits). Default: `@parcel/watcher` in a
   * child process (`watch-host.ts`, DECISIONS #130).
   */
  subscribe?: SubscribeFn;
  /** Home and temp directories for the watch guard (tests). Default: the real ones. */
  guardDirs?: GuardDirs;
  onWorktreeDirty: (worktreeId: string, reason: DirtyReason) => void;
  onWorktreeListDirty: (projectId: string, reason: 'git' | 'timer' | 'missing') => void;
  /**
   * A watched worktree folder was deleted, or replaced at the same path: its git dir may have
   * changed too, so cached watch targets should be re-checked (F1).
   */
  onWorktreeReplaced?: (worktreeId: string) => void;
}

type FailureKind = 'inotify-watches' | 'inotify-instances' | 'missing' | 'permission' | 'other';

/** Why a worktree is deliberately not watched natively (SEC-07): too broad, or over the cap. */
type WatchPolicy = WatchRefusal | 'capped';

/** Build-output directory decisions for one worktree (review F5). */
interface BuildState {
  /** Rules from `<root>/.gitignore` and `<common>/info/exclude`. */
  rules: BuildDirRules;
  /** Rules of nested `.gitignore` files, by `/`-separated directory (read lazily). */
  nested: Map<string, BuildDirRules>;
  /** Build directories known to hold tracked files (from file lists): always watched. */
  forced: Set<string>;
  /** `buildDirIgnoreEntries` used by the current subscription. */
  key: string;
  /** Debounced re-read of the root rules after `.gitignore` / `info/exclude` changed. */
  recheck: NodeJS.Timeout | undefined;
}

interface WorktreeState {
  info: WatchedWorktree;
  sub: parcelWatcher.AsyncSubscription | null;
  /** Serialized subscribe / unsubscribe work in flight (null when idle). */
  subscribing: Promise<void> | null;
  native: boolean;
  failure: { kind: FailureKind; message: string } | null;
  policy: WatchPolicy | null;
  /** `dev:ino` of the root and the git dir when the current subscription was made (F1). */
  identity: string | null;
  gitDir: string | null;
  build: BuildState;
  onWindowsMount: boolean;
  debounce: NodeJS.Timeout | undefined;
  burstStart: number;
  pendingReason: DirtyReason;
  poll: NodeJS.Timeout | undefined;
  /** When this worktree last fired a refresh (any reason); 0 = never. */
  lastFireAt: number;
  /** Re-subscribe after the subscription reported an error. */
  retry: ErrorRetry;
}

/** Backoff state for re-subscribing after a subscription error (DECISIONS #130). */
interface ErrorRetry {
  timer: NodeJS.Timeout | undefined;
  /** Consecutive errors (reset after ERROR_STREAK_RESET_MS without one). */
  count: number;
  lastAt: number;
}

const newRetry = (): ErrorRetry => ({ timer: undefined, count: 0, lastAt: 0 });

interface ProjectState {
  projectId: string;
  commonDir: string;
  sub: parcelWatcher.AsyncSubscription | null;
  subscribing: Promise<void> | null;
  native: boolean;
  failure: { kind: FailureKind; message: string } | null;
  policy: WatchRefusal | null;
  identity: string | null;
  /** `info/exclude` text, read once and shared by the worktrees (reset when it changes). */
  exclude: Promise<string | null> | null;
  worktreeIds: Set<string>;
  relist: NodeJS.Timeout | undefined;
  listDebounce: NodeJS.Timeout | undefined;
  retry: ErrorRetry;
}

const REFUSAL_LABELS: Record<WatchRefusal, string> = {
  'filesystem-root': 'filesystem root',
  home: 'home directory or a parent of it',
  'system-dir': 'system directory',
  'contains-git-dir': "folder containing the repository's git dir",
};

/** Bound on cached nested `.gitignore` rules per worktree. */
const MAX_NESTED_RULES = 5000;
/** Bound on build directories remembered as holding tracked files, per worktree. */
const MAX_FORCED_DIRS = 1000;

function classifyError(error: unknown): { kind: FailureKind; message: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOSPC|No space left on device/i.test(message)) return { kind: 'inotify-watches', message };
  if (/EMFILE|Too many open files|inotify_init/i.test(message)) {
    return { kind: 'inotify-instances', message };
  }
  if (/ENOENT|No such file or directory|ENOTDIR|Not a directory/i.test(message)) {
    return { kind: 'missing', message };
  }
  if (/EACCES|EPERM|Permission denied/i.test(message)) return { kind: 'permission', message };
  return { kind: 'other', message };
}

function readSysctl(file: string): string | null {
  try {
    return readFileSync(file, 'utf8').trim();
  } catch {
    return null;
  }
}

const IS_WSL =
  process.platform === 'linux' &&
  (/microsoft/i.test(os.release()) || process.env.WSL_DISTRO_NAME !== undefined);

function isGlobOrPath(entry: string): boolean {
  return /[*?[\]{}!/\\]/.test(entry);
}

/** Expands plain names (`dist`) to "at any depth" globs; globs and paths pass through. */
export function buildWorktreeIgnores(extra: readonly string[] = []): string[] {
  const out = new Set<string>();
  for (const entry of [...DEFAULT_WORKTREE_IGNORES, ...extra]) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    if (isGlobOrPath(trimmed)) {
      out.add(trimmed);
    } else {
      out.add(trimmed);
      out.add(`**/${trimmed}`);
    }
  }
  return [...out];
}

/** Timer jitter (±25 %): every worktree and project is armed at startup, so fixed intervals
 * would make all relists (60 s) and fallback polls (5 min) fire in the same second. */
export const TIMER_JITTER = 0.25;

function jittered(ms: number): number {
  return Math.max(1, Math.round(ms * (1 + TIMER_JITTER * (2 * Math.random() - 1))));
}

// Merges "**/<name>" globs into a single "**/{a,b,...}" glob for @parcel/watcher. Its native
// matcher tests every crawled path against each glob's regex in turn, so the 24 default names
// (each also passed as a path) made the initial crawl of a 50k-file worktree take ~1.8 s
// instead of ~0.3 s. Paths and other globs pass through unchanged; names containing a comma
// stay separate globs.
export function compactIgnores(entries: readonly string[]): string[] {
  const names: string[] = [];
  const out: string[] = [];
  for (const entry of entries) {
    const match = /^\*\*\/([^*?[\]{}!/\\,]+)$/.exec(entry);
    if (match?.[1]) names.push(match[1]);
    else out.push(entry);
  }
  const unique = [...new Set(names)];
  if (unique.length === 1) out.push(`**/${unique[0]}`);
  else if (unique.length > 1) out.push(`**/{${unique.join(',')}}`);
  return out;
}

/**
 * Adds `<glob>/**` after every glob entry so a directory's contents are ignored on every backend.
 * `@parcel/watcher` matches globs against each event path: inotify (Linux) never watches an
 * ignored directory, so its contents are dropped too, but FSEvents (macOS) watches the whole tree
 * and drops only the paths a glob matches, so `**\/node_modules` let every file inside a nested
 * `node_modules` through (an install in a monorepo meant a refresh storm). Plain paths are matched
 * as prefixes on every backend and pass through unchanged.
 */
export function withDescendants(entries: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    out.push(entry);
    if (/[*?[\]{}!]/.test(entry) && !entry.endsWith('/**')) out.push(`${entry}/**`);
  }
  return out;
}

function isLockFile(p: string): boolean {
  return p.endsWith('.lock');
}

/**
 * Watches working trees and git dirs with `@parcel/watcher` (PLAN §5.6), debounces bursts per
 * worktree, and polls as a safety net (30 s focused / 5 min others). When native watching fails
 * (inotify limits on WSL or big trees, permissions, missing paths) the affected worktrees are
 * polled instead and a warning is surfaced through `status()`. Folders that are too broad to
 * watch (`/`, `$HOME`, ...) and worktrees beyond the per-project cap are only polled (SEC-07).
 * A watched folder that is deleted, or replaced at the same path, is re-subscribed (F1).
 */
export class WatcherService {
  readonly #opts: Required<
    Omit<
      WatcherServiceOptions,
      | 'subscribe'
      | 'ignore'
      | 'logger'
      | 'onWorktreeDirty'
      | 'onWorktreeListDirty'
      | 'guardDirs'
      | 'maxWorktreesPerProject'
      | 'onWorktreeReplaced'
    >
  >;
  readonly #log: Logger;
  readonly #subscribe: SubscribeFn;
  /** The child process running @parcel/watcher, unless `subscribe` was injected. */
  readonly #host: WatchHost | null;
  /** Subscriptions that reported an error: never unsubscribed (see `#dispose`). */
  readonly #dead = new WeakSet<parcelWatcher.AsyncSubscription>();
  /** Always-ignored names and the user's extra entries (not compacted). */
  readonly #baseIgnores: string[];
  readonly #guard: GuardDirs;
  readonly #maxPerProject: number;
  readonly #onDirty: WatcherServiceOptions['onWorktreeDirty'];
  readonly #onListDirty: WatcherServiceOptions['onWorktreeListDirty'];
  readonly #onReplaced: (worktreeId: string) => void;
  readonly #worktrees = new Map<string, WorktreeState>();
  readonly #projects = new Map<string, ProjectState>();
  readonly #loggedFailures = new Set<FailureKind>();
  #focus: string | null = null;
  #closed = false;

  constructor(options: WatcherServiceOptions) {
    const debounceMs = options.debounceMs ?? WATCH_DEFAULTS.debounceMs;
    this.#opts = {
      enabled: options.enabled ?? true,
      leadingEdge: options.leadingEdge ?? false,
      forcePolling: options.forcePolling ?? false,
      debounceMs: Math.max(0, debounceMs),
      maxWaitMs: Math.max(debounceMs, options.maxWaitMs ?? WATCH_DEFAULTS.maxWaitMs),
      pollFocusedMs: Math.max(50, options.pollFocusedMs ?? WATCH_DEFAULTS.pollFocusedMs),
      pollIdleMs: Math.max(50, options.pollIdleMs ?? WATCH_DEFAULTS.pollIdleMs),
      pollDegradedFocusedMs: Math.max(
        50,
        options.pollDegradedFocusedMs ??
          Math.min(
            WATCH_DEFAULTS.pollDegradedFocusedMs,
            options.pollFocusedMs ?? WATCH_DEFAULTS.pollFocusedMs,
          ),
      ),
      relistMs: Math.max(50, options.relistMs ?? WATCH_DEFAULTS.relistMs),
      resubscribeDelayMs: Math.max(
        1,
        options.resubscribeDelayMs ?? WATCH_DEFAULTS.resubscribeDelayMs,
      ),
    };
    this.#log = options.logger;
    if (options.subscribe) {
      this.#host = null;
      this.#subscribe = options.subscribe;
    } else {
      this.#host = createWatchHost({ logger: this.#log });
      this.#subscribe = this.#host.subscribe;
      // Boot the host now: projects registered right after start are then watched at once.
      if (this.#opts.enabled && !this.#opts.forcePolling) this.#host.warm();
    }
    this.#baseIgnores = buildWorktreeIgnores(options.ignore);
    this.#guard = options.guardDirs ?? defaultGuardDirs();
    this.#maxPerProject = Math.max(
      1,
      Math.floor(options.maxWorktreesPerProject ?? MAX_WATCHED_WORKTREES_PER_PROJECT),
    );
    this.#onDirty = options.onWorktreeDirty;
    this.#onListDirty = options.onWorktreeListDirty;
    this.#onReplaced = options.onWorktreeReplaced ?? (() => {});
  }

  get #native(): boolean {
    return this.#opts.enabled && !this.#opts.forcePolling;
  }

  // --- registration ----------------------------------------------------------------------------

  /**
   * Declares the full set of worktrees to watch for a project. Worktrees not in the list are
   * unwatched; new ones are subscribed; existing ones get updated targets, and are
   * re-subscribed if their folder was deleted or replaced since (F1).
   */
  async setProject(
    projectId: string,
    commonDir: string,
    declared: WatchedWorktree[],
  ): Promise<void> {
    if (this.#closed) return;
    // git reports the git dir itself as the main worktree of a submodule registered on its own
    // (`<super>/.git/modules/<name>`): there is no working tree to watch there, and the git-dir
    // subscription covers it, so it is watched like a bare entry.
    const worktrees = declared.map((w) =>
      !w.bare && path.resolve(w.root) === path.resolve(commonDir) ? { ...w, bare: true } : w,
    );
    let project = this.#projects.get(projectId);
    const pending: Promise<void>[] = [];
    if (!project) {
      project = {
        projectId,
        commonDir,
        sub: null,
        subscribing: null,
        native: false,
        failure: null,
        policy: dirRefusal(commonDir, this.#guard),
        identity: null,
        exclude: null,
        worktreeIds: new Set(),
        relist: undefined,
        listDebounce: undefined,
        retry: newRetry(),
      };
      this.#projects.set(projectId, project);
      this.#scheduleRelist(project);
      if (project.policy) {
        this.#log.warn('not watching a git dir that is too broad to watch; polling instead', {
          projectId,
          path: commonDir,
          reason: project.policy,
        });
      } else if (this.#native) {
        const p = project;
        pending.push(this.#enqueue(p, () => this.#subscribeProject(p)));
      }
    } else {
      pending.push(this.#healProject(project));
    }
    const wanted = new Set(worktrees.map((w) => w.worktreeId));
    for (const id of [...project.worktreeIds]) {
      if (!wanted.has(id)) pending.push(this.#unwatchWorktree(id));
    }
    const policies = this.#assignPolicies(commonDir, worktrees);
    for (const info of worktrees) {
      const policy = policies.get(info.worktreeId) ?? null;
      const existing = this.#worktrees.get(info.worktreeId);
      if (existing) {
        pending.push(this.#updateWorktree(existing, info, policy));
        continue;
      }
      project.worktreeIds.add(info.worktreeId);
      pending.push(this.#watchWorktree(info, policy));
    }
    await Promise.all(pending);
  }

  async removeProject(projectId: string): Promise<void> {
    const project = this.#projects.get(projectId);
    if (!project) return;
    this.#projects.delete(projectId);
    clearTimeout(project.relist);
    clearTimeout(project.listDebounce);
    clearTimeout(project.retry.timer);
    const pending = [...project.worktreeIds].map((id) => this.#unwatchWorktree(id));
    pending.push(this.#releaseProjectSub(project));
    await Promise.all(pending);
  }

  setFocus(worktreeId: string | null): void {
    const previous = this.#focus;
    this.#focus = worktreeId;
    if (previous && previous !== worktreeId) this.#schedulePoll(previous);
    if (worktreeId && previous !== worktreeId && this.#worktrees.has(worktreeId)) {
      // Focusing a worktree refreshes it right away (cheap; helps when watching is degraded).
      this.markDirty(worktreeId, 'focus');
    }
  }

  get focus(): string | null {
    return this.#focus;
  }

  /** Schedules a debounced refresh of one worktree. */
  markDirty(worktreeId: string, reason: DirtyReason): void {
    const st = this.#worktrees.get(worktreeId);
    if (!st || this.#closed) return;
    const now = Date.now();
    if (
      this.#opts.leadingEdge &&
      st.debounce === undefined &&
      now - st.lastFireAt >= this.#opts.debounceMs
    ) {
      // Quiet worktree: refresh now. Events in the next debounce window (the rest of the same
      // save or commit) start the normal trailing debounce below.
      this.#fire(st, reason);
      return;
    }
    if (st.debounce === undefined) {
      st.burstStart = now;
      st.pendingReason = reason;
    } else if (reason === 'git') {
      st.pendingReason = 'git';
    }
    clearTimeout(st.debounce);
    const wait = Math.max(
      0,
      Math.min(this.#opts.debounceMs, st.burstStart + this.#opts.maxWaitMs - now),
    );
    st.debounce = setTimeout(() => {
      st.debounce = undefined;
      this.#fire(st, st.pendingReason);
    }, wait);
    st.debounce.unref();
  }

  isWatched(worktreeId: string): boolean {
    return this.#worktrees.has(worktreeId);
  }

  /**
   * Tells the watcher which paths (`/`-separated, relative to the worktree root) have tracked
   * changes, from a file list the daemon already computed. Build directories among them hold
   * tracked files, so they are watched even where `.gitignore` rules ignore them (F5: a
   * force-added `dist/` becomes live after its first listed change).
   */
  noteTrackedPaths(worktreeId: string, relPaths: readonly string[]): void {
    const st = this.#worktrees.get(worktreeId);
    if (!st || st.info.bare || this.#closed) return;
    let added = false;
    for (const p of relPaths) {
      for (const dir of buildDirsOf(p)) {
        if (st.build.forced.has(dir) || st.build.forced.size >= MAX_FORCED_DIRS) continue;
        st.build.forced.add(dir);
        added = true;
      }
    }
    if (!added) return;
    const key = buildDirIgnoreEntries(st.build.rules, st.build.forced).join('\0');
    if (key === st.build.key || !st.sub) return;
    this.#log.info('tracked files found in an ignored build directory; watching it', {
      worktreeId,
    });
    void this.#enqueue(st, () => this.#subscribeWorktree(st));
  }

  // --- status ----------------------------------------------------------------------------------

  /** Overall mode and human-readable warnings (no paths: `/api/health` is unauthenticated). */
  status(): { mode: WatcherMode; warnings: string[] } {
    if (!this.#opts.enabled) return { mode: 'disabled', warnings: [] };
    if (this.#opts.forcePolling) return { mode: 'polling', warnings: [] };
    let native = 0;
    let degraded = 0;
    const failures = new Map<FailureKind, number>();
    const refused = new Map<WatchRefusal, number>();
    let capped = 0;
    let windowsMounts = 0;
    for (const st of this.#worktrees.values()) {
      const project = this.#projects.get(st.info.projectId);
      if (this.#isNative(st)) native++;
      else degraded++;
      if (st.policy === 'capped') capped++;
      else if (st.policy) refused.set(st.policy, (refused.get(st.policy) ?? 0) + 1);
      else {
        const failure = st.failure ?? (project?.policy ? null : (project?.failure ?? null));
        if (failure) failures.set(failure.kind, (failures.get(failure.kind) ?? 0) + 1);
      }
      if (st.onWindowsMount) windowsMounts++;
    }
    const refusedProjects = [...this.#projects.values()].filter((p) => p.policy !== null).length;
    const pollSeconds = Math.round(this.#opts.pollFocusedMs / 1000);
    const idleSeconds = Math.round(this.#opts.pollIdleMs / 1000);
    const warnings: string[] = [];
    for (const [kind, count] of failures) {
      warnings.push(this.#failureWarning(kind, count, pollSeconds));
    }
    if (refused.size > 0) {
      const total = [...refused.values()].reduce((a, b) => a + b, 0);
      const reasons = [...refused].map(([r, n]) => `${REFUSAL_LABELS[r]}: ${n}`).join(', ');
      warnings.push(
        `Not watching ${total} worktree folder(s) that are too broad to watch (${reasons}); they are only polled every ${idleSeconds}s (${pollSeconds}s when selected). Check \`git worktree list\` in the affected project for stale or forged worktree records.`,
      );
    }
    if (capped > 0) {
      warnings.push(
        `${capped} worktree(s) are beyond the limit of ${this.#maxPerProject} watched worktrees per project; they are only polled every ${idleSeconds}s (${pollSeconds}s when selected).`,
      );
    }
    if (refusedProjects > 0) {
      warnings.push(
        `Not watching the git dir of ${refusedProjects} project(s) because it is too broad to watch (filesystem root, home directory or a system directory); their commits and index changes are only picked up by polling every ${idleSeconds}s.`,
      );
    }
    if (windowsMounts > 0) {
      warnings.push(
        `${windowsMounts} worktree(s) are on a Windows drive under WSL (/mnt/*): Linux does not get file events for changes made from Windows, so they are also polled every ${pollSeconds}s.`,
      );
    }
    const mode: WatcherMode = degraded === 0 ? 'native' : native === 0 ? 'polling' : 'mixed';
    return { mode, warnings };
  }

  #failureWarning(kind: FailureKind, count: number, pollSeconds: number): string {
    const tail = `${count} worktree(s) fall back to polling every ${pollSeconds}s.`;
    switch (kind) {
      case 'inotify-watches': {
        const limit = readSysctl('/proc/sys/fs/inotify/max_user_watches');
        return `File watching hit the inotify watch limit (fs.inotify.max_user_watches=${limit ?? 'unknown'}); ${tail} Raise it with: sudo sysctl fs.inotify.max_user_watches=1048576`;
      }
      case 'inotify-instances': {
        const limit = readSysctl('/proc/sys/fs/inotify/max_user_instances');
        return `File watching hit the inotify instance or open-file limit (fs.inotify.max_user_instances=${limit ?? 'unknown'}); ${tail}`;
      }
      case 'missing':
        return `Some watched paths do not exist; ${tail}`;
      case 'permission':
        return `File watching was denied permission for some paths; ${tail}`;
      default:
        return `Native file watching failed; ${tail}`;
    }
  }

  #isNative(st: WorktreeState): boolean {
    if (!this.#native || st.onWindowsMount || st.policy) return false;
    const project = this.#projects.get(st.info.projectId);
    const gitNative = project?.native ?? false;
    return st.info.bare ? gitNative : st.native && gitNative;
  }

  /** Not watched natively by design (SEC-07), as opposed to a failure: polled at normal rates. */
  #pollOnly(st: WorktreeState): boolean {
    return st.policy !== null || (this.#projects.get(st.info.projectId)?.policy ?? null) !== null;
  }

  // --- worktree subscriptions ------------------------------------------------------------------

  /** Which worktrees may be watched natively: refuses too-broad roots, caps the rest (SEC-07). */
  #assignPolicies(
    commonDir: string,
    worktrees: WatchedWorktree[],
  ): Map<string, WatchPolicy | null> {
    const out = new Map<string, WatchPolicy | null>();
    const candidates: WatchedWorktree[] = [];
    for (const info of worktrees) {
      if (info.bare) {
        out.set(info.worktreeId, null);
        continue;
      }
      const refusal = worktreeRootRefusal(
        info.root,
        { commonDir, isMain: info.isMain },
        this.#guard,
      );
      if (refusal) out.set(info.worktreeId, refusal);
      else candidates.push(info);
    }
    // Main worktree first, then the ones already watched (a new worktree never evicts an
    // existing subscription), then the order given. The sort is stable.
    const rank = (info: WatchedWorktree): number => {
      if (info.isMain) return 0;
      const st = this.#worktrees.get(info.worktreeId);
      return st && st.policy === null ? 1 : 2;
    };
    candidates.sort((a, b) => rank(a) - rank(b));
    candidates.forEach((info, i) => {
      out.set(info.worktreeId, i < this.#maxPerProject ? null : 'capped');
    });
    return out;
  }

  async #watchWorktree(info: WatchedWorktree, policy: WatchPolicy | null): Promise<void> {
    const st: WorktreeState = {
      info,
      sub: null,
      subscribing: null,
      native: false,
      failure: null,
      policy,
      identity: null,
      gitDir: null,
      build: {
        rules: emptyBuildDirRules(),
        nested: new Map(),
        forced: new Set(),
        key: '',
        recheck: undefined,
      },
      onWindowsMount: IS_WSL && /^\/mnt\/[a-z](\/|$)/i.test(info.root),
      debounce: undefined,
      burstStart: 0,
      pendingReason: 'fs',
      poll: undefined,
      lastFireAt: 0,
      retry: newRetry(),
    };
    this.#worktrees.set(info.worktreeId, st);
    this.#schedulePoll(info.worktreeId);
    if (policy) this.#logPolicy(st);
    if (!this.#native || info.bare || policy) return;
    await this.#enqueue(st, () => this.#subscribeWorktree(st));
  }

  /** Applies new targets / policy to a watched worktree and heals a dead subscription (F1). */
  async #updateWorktree(
    st: WorktreeState,
    info: WatchedWorktree,
    policy: WatchPolicy | null,
  ): Promise<void> {
    st.info = info;
    if (policy !== st.policy) {
      st.policy = policy;
      this.#schedulePoll(info.worktreeId);
      if (policy) {
        this.#logPolicy(st);
        st.native = false;
        await this.#enqueue(st, () => this.#releaseSub(st));
      } else if (this.#native && !info.bare) {
        await this.#enqueue(st, () => this.#subscribeWorktree(st));
      }
      return;
    }
    if (!this.#native || info.bare || policy) return;
    if (st.subscribing) await st.subscribing;
    if (this.#worktrees.get(info.worktreeId) !== st || st.policy) return;
    const identity = await dirIdentity(info.root);
    if (identity === null || this.#worktrees.get(info.worktreeId) !== st || st.subscribing) return;
    const gitDir = info.targets?.gitDir ?? null;
    const replaced = st.sub !== null && identity !== st.identity;
    const back = st.sub === null && (st.failure === null || st.failure.kind === 'missing');
    if (!replaced && !back) {
      if (gitDir !== null && st.gitDir !== null && gitDir !== st.gitDir) {
        // New admin dir behind the same folder: routing uses the new targets from now on.
        st.gitDir = gitDir;
        this.markDirty(info.worktreeId, 'git');
      }
      return;
    }
    this.#log.info(
      replaced
        ? 'worktree folder was replaced at the same path; re-subscribing'
        : 'worktree folder is back; re-subscribing',
      { worktreeId: info.worktreeId, path: info.root },
    );
    if (replaced) this.#onReplaced(info.worktreeId);
    await this.#enqueue(st, () => this.#subscribeWorktree(st));
    // Changes made while the folder had no working subscription were missed.
    this.markDirty(info.worktreeId, 'fs');
  }

  /** (Re)subscribes a worktree root; runs serialized through `#enqueue`. */
  async #subscribeWorktree(st: WorktreeState): Promise<void> {
    const id = st.info.worktreeId;
    const current = () => !this.#closed && this.#worktrees.get(id) === st;
    if (!current() || !this.#native || st.info.bare || st.policy) return;
    await this.#releaseSub(st);
    const root = st.info.root;
    const [identity, rules] = await Promise.all([
      dirIdentity(root),
      this.#excludeOf(st).then((exclude) => readRootBuildDirRules(root, exclude)),
    ]);
    if (!current()) return;
    if (identity === null) {
      st.failure = { kind: 'missing', message: 'worktree folder does not exist' };
      st.identity = null;
      this.#schedulePoll(id);
      return;
    }
    st.build.rules = rules;
    st.build.nested.clear();
    const buildIgnores = buildDirIgnoreEntries(st.build.rules, st.build.forced);
    const nested = [...this.#worktrees.values()]
      .map((other) => other.info.root)
      .filter((r) => r !== root && isSameOrInside(root, r));
    const ignore = withDescendants(
      compactIgnores([...this.#baseIgnores, ...buildIgnores, ...nested]),
    );
    try {
      const link = this.#link((error) => this.#onWorktreeError(st, error));
      const sub = await this.#subscribe(
        root,
        (error, events) => {
          if (link.failed) return;
          if (error) link.fail(error);
          else this.#onWorktreeEvents(st, events);
        },
        { ignore },
      );
      const failedEarly = link.attach(sub);
      if (!current() || st.policy) {
        await this.#dispose(sub);
        return;
      }
      if (failedEarly) {
        // It failed before subscribe() returned: never active, retried like any other error.
        st.failure = link.error ? classifyError(link.error) : { kind: 'other', message: '' };
        this.#scheduleWorktreeRetry(st);
        this.#schedulePoll(id);
        return;
      }
      st.sub = sub;
      st.native = true;
      st.failure = null;
      st.identity = identity;
      st.gitDir = st.info.targets?.gitDir ?? null;
      st.build.key = buildIgnores.join('\0');
      this.#schedulePoll(id);
    } catch (error) {
      st.failure = classifyError(error);
      this.#logFailure(st.failure, root);
      // A retry that failed for no known reason (e.g. the watch host was restarted) backs off
      // and tries again; known causes (limits, permissions, a missing folder) keep polling.
      if (st.retry.count > 0 && st.failure.kind === 'other') this.#scheduleWorktreeRetry(st);
      this.#schedulePoll(id);
    }
  }

  async #releaseSub(st: WorktreeState): Promise<void> {
    const sub = st.sub;
    st.sub = null;
    st.native = false;
    if (sub) await this.#dispose(sub);
  }

  /**
   * Ties a subscription to its error handler. An error marks the subscription dead: it is
   * dropped, never unsubscribed (`#dispose`). The error can arrive before `subscribe()`
   * returns; `attach` then reports it, and the handler is not called (the caller handles it).
   */
  #link(onError: (error: Error) => void): {
    readonly failed: boolean;
    readonly error: Error | null;
    fail(error: Error): void;
    attach(sub: parcelWatcher.AsyncSubscription): boolean;
  } {
    let sub: parcelWatcher.AsyncSubscription | null = null;
    let failure: Error | null = null;
    return {
      get failed() {
        return failure !== null;
      },
      get error() {
        return failure;
      },
      fail: (error) => {
        failure = error;
        if (!sub) return;
        this.#dead.add(sub);
        onError(error);
      },
      attach: (s) => {
        sub = s;
        if (failure) this.#dead.add(s);
        return failure !== null;
      },
    };
  }

  /**
   * Releases a subscription, unless it reported an error. @parcel/watcher's backend is dead
   * then: its thread has ended without signalling it, and native cleanup that reaches the
   * backend's destructor waits for that signal forever (DECISIONS #130). The error already
   * removed the subscription's callbacks natively, so dropping the reference leaks nothing
   * that runs later, at exit included (the shared backend table is never destroyed).
   */
  async #dispose(sub: parcelWatcher.AsyncSubscription): Promise<void> {
    if (this.#dead.has(sub)) return;
    await sub.unsubscribe().catch(() => {});
  }

  /** Next delay of a re-subscribe backoff (and records the error). */
  #nextRetryDelay(retry: ErrorRetry): number {
    const now = Date.now();
    retry.count = now - retry.lastAt > ERROR_STREAK_RESET_MS ? 1 : retry.count + 1;
    retry.lastAt = now;
    const delay = this.#opts.resubscribeDelayMs * 2 ** Math.min(retry.count - 1, 20);
    return Math.min(delay, Math.max(MAX_RESUBSCRIBE_DELAY_MS, this.#opts.resubscribeDelayMs));
  }

  #scheduleWorktreeRetry(st: WorktreeState): void {
    if (this.#closed) return;
    clearTimeout(st.retry.timer);
    st.retry.timer = setTimeout(() => {
      st.retry.timer = undefined;
      if (this.#closed || this.#worktrees.get(st.info.worktreeId) !== st || st.sub) return;
      void this.#enqueue(st, () => this.#subscribeWorktree(st)).then(() => {
        // Changes made while nothing was watching were missed.
        if (st.sub) this.markDirty(st.info.worktreeId, 'fs');
      });
    }, this.#nextRetryDelay(st.retry));
    st.retry.timer.unref();
  }

  /** The worktree's subscription reported an error: drop it, poll, re-subscribe later. */
  #onWorktreeError(st: WorktreeState, error: Error): void {
    if (this.#closed || this.#worktrees.get(st.info.worktreeId) !== st) return;
    this.#log.warn('watcher error; polling until re-subscribed', {
      worktreeId: st.info.worktreeId,
      error,
    });
    st.sub = null;
    st.native = false;
    st.failure = classifyError(error);
    if (st.failure.kind !== 'missing') this.#scheduleWorktreeRetry(st);
    this.#schedulePoll(st.info.worktreeId);
    this.#onListDirty(st.info.projectId, 'missing');
  }

  /** Serializes subscribe / unsubscribe work per worktree or project. */
  #enqueue(target: { subscribing: Promise<void> | null }, op: () => Promise<void>): Promise<void> {
    const run = (target.subscribing ?? Promise.resolve()).then(op).catch((error) => {
      this.#log.debug('watch (re)subscription failed', { error });
    });
    target.subscribing = run;
    void run.then(() => {
      if (target.subscribing === run) target.subscribing = null;
    });
    return run;
  }

  /** The project's `info/exclude` text, read once per change (F5, F6). */
  #excludeOf(st: WorktreeState): Promise<string | null> {
    const project = this.#projects.get(st.info.projectId);
    if (!project) return Promise.resolve(null);
    project.exclude ??= readExcludeFile(project.commonDir);
    return project.exclude;
  }

  #logPolicy(st: WorktreeState): void {
    if (st.policy === 'capped') {
      this.#log.warn('too many worktrees in one project; polling this one instead of watching it', {
        worktreeId: st.info.worktreeId,
        path: st.info.root,
        max: this.#maxPerProject,
      });
    } else if (st.policy) {
      this.#log.warn('not watching a worktree folder that is too broad to watch; polling it', {
        worktreeId: st.info.worktreeId,
        path: st.info.root,
        reason: st.policy,
      });
    }
  }

  async #unwatchWorktree(worktreeId: string): Promise<void> {
    const st = this.#worktrees.get(worktreeId);
    if (!st) return;
    this.#worktrees.delete(worktreeId);
    this.#projects.get(st.info.projectId)?.worktreeIds.delete(worktreeId);
    clearTimeout(st.debounce);
    clearTimeout(st.poll);
    clearTimeout(st.build.recheck);
    clearTimeout(st.retry.timer);
    if (this.#focus === worktreeId) this.#focus = null;
    if (st.subscribing) await st.subscribing;
    await this.#releaseSub(st);
  }

  #onWorktreeEvents(st: WorktreeState, events: parcelWatcher.Event[]): void {
    if (this.#closed || this.#worktrees.get(st.info.worktreeId) !== st) return;
    // Ignore-file changes first: they change which build directories are filtered below.
    for (const event of events) {
      if (path.basename(event.path) !== '.gitignore') continue;
      const owner = this.#ownerOf(event.path, st);
      owner.build.nested.clear();
      if (path.dirname(event.path) === owner.info.root) this.#scheduleIgnoreCheck(owner);
    }
    const owners = new Set<WorktreeState>();
    const deferred: Array<{ owner: WorktreeState; path: string }> = [];
    let rootDeleted = false;
    for (const event of events) {
      if (event.path === st.info.root && event.type === 'delete') rootDeleted = true;
      const owner = this.#ownerOf(event.path, st);
      const verdict = this.#buildVerdict(owner, event.path);
      if (verdict === 'drop') continue;
      if (verdict === 'unknown') deferred.push({ owner, path: event.path });
      else owners.add(owner);
    }
    if (rootDeleted) this.#onRootDeleted(st);
    this.#markOwnersDirty(owners, 'fs');
    if (deferred.length) void this.#resolveDeferred(deferred);
  }

  /**
   * The root was deleted: inotify dropped every watch, and nothing is reported if a folder
   * is created again at the same path. Drop the subscription so the worktree is polled at the
   * degraded rate and reported as degraded until a relist or poll re-subscribes it (F1).
   */
  #onRootDeleted(st: WorktreeState): void {
    st.native = false;
    st.identity = null;
    st.failure = { kind: 'missing', message: 'worktree folder was deleted' };
    void this.#enqueue(st, () => this.#releaseSub(st));
    this.#schedulePoll(st.info.worktreeId);
    this.#onReplaced(st.info.worktreeId);
    this.#onListDirty(st.info.projectId, 'missing');
  }

  /** Poll-time retry for a worktree whose folder had disappeared. */
  #maybeHeal(st: WorktreeState): void {
    if (!this.#native || st.info.bare || st.policy || st.sub || st.subscribing) return;
    if (st.failure?.kind !== 'missing') return;
    void (async () => {
      if ((await dirIdentity(st.info.root)) === null) return;
      if (this.#worktrees.get(st.info.worktreeId) !== st || st.sub || st.subscribing) return;
      await this.#enqueue(st, () => this.#subscribeWorktree(st));
    })();
  }

  /** Is `p` inside a build directory that git ignores (and that holds no known tracked files)? */
  #buildVerdict(owner: WorktreeState, p: string): 'keep' | 'drop' | 'unknown' {
    const rel = path.relative(owner.info.root, p);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return 'keep';
    const relPosix = path.sep === '/' ? rel : rel.split(path.sep).join('/');
    for (const dir of buildDirsOf(relPosix)) {
      if (owner.build.forced.has(dir)) return 'keep';
      const ignored = isIgnoredBuildDir(dir, owner.build.rules, (d) => owner.build.nested.get(d));
      if (ignored === undefined) return 'unknown';
      if (ignored) return 'drop';
    }
    return 'keep';
  }

  /** Reads the nested `.gitignore` files that events under build directories depend on. */
  async #resolveDeferred(items: Array<{ owner: WorktreeState; path: string }>): Promise<void> {
    const owners = new Set<WorktreeState>();
    for (const { owner, path: p } of items) {
      if (this.#closed || this.#worktrees.get(owner.info.worktreeId) !== owner) continue;
      const rel = path.relative(owner.info.root, p).split(path.sep).join('/');
      for (const dir of buildDirsOf(rel)) {
        for (const ancestor of ancestorsOf(dir)) {
          if (owner.build.nested.has(ancestor)) continue;
          const rules = await readNestedBuildDirRules(owner.info.root, ancestor);
          if (owner.build.nested.size >= MAX_NESTED_RULES) owner.build.nested.clear();
          owner.build.nested.set(ancestor, rules);
        }
      }
      // Still unknown (the cache was cleared meanwhile): keep the event, a refresh is harmless.
      if (this.#buildVerdict(owner, p) !== 'drop') owners.add(owner);
    }
    this.#markOwnersDirty(owners, 'fs');
  }

  /** Re-reads the root ignore rules (debounced) and re-subscribes if the build ignores changed. */
  #scheduleIgnoreCheck(st: WorktreeState): void {
    clearTimeout(st.build.recheck);
    st.build.recheck = setTimeout(() => {
      st.build.recheck = undefined;
      void this.#recheckIgnores(st);
    }, this.#opts.debounceMs);
    st.build.recheck.unref();
  }

  async #recheckIgnores(st: WorktreeState): Promise<void> {
    if (this.#closed || this.#worktrees.get(st.info.worktreeId) !== st || !st.sub) return;
    const rules = await readRootBuildDirRules(st.info.root, await this.#excludeOf(st));
    if (this.#worktrees.get(st.info.worktreeId) !== st) return;
    st.build.rules = rules;
    st.build.nested.clear();
    if (buildDirIgnoreEntries(rules, st.build.forced).join('\0') === st.build.key) return;
    this.#log.debug('ignore rules for build directories changed; re-subscribing', {
      worktreeId: st.info.worktreeId,
    });
    await this.#enqueue(st, () => this.#subscribeWorktree(st));
    this.markDirty(st.info.worktreeId, 'fs');
  }

  /**
   * Marks worktrees dirty, plus the worktrees of *other* projects that contain them: a nested
   * repository is often a submodule, whose changes alter its superproject's status (F3).
   */
  #markOwnersDirty(owners: Iterable<WorktreeState>, reason: DirtyReason): void {
    const ids = new Set<string>();
    for (const owner of owners) {
      ids.add(owner.info.worktreeId);
      if (owner.info.bare) continue;
      for (const other of this.#worktrees.values()) {
        if (
          other.info.projectId !== owner.info.projectId &&
          !other.info.bare &&
          other.info.root !== owner.info.root &&
          isSameOrInside(other.info.root, owner.info.root)
        ) {
          ids.add(other.info.worktreeId);
        }
      }
    }
    for (const id of ids) this.markDirty(id, reason);
  }

  /** The deepest watched worktree root that contains `p` (handles nested worktrees). */
  #ownerOf(p: string, st: WorktreeState): WorktreeState {
    let owner = st;
    let depth = st.info.root.length;
    for (const other of this.#worktrees.values()) {
      if (other === st || other.info.bare) continue;
      const root = other.info.root;
      if (root.length > depth && isSameOrInside(root, p) && isSameOrInside(st.info.root, root)) {
        owner = other;
        depth = root.length;
      }
    }
    return owner;
  }

  // --- git dir subscriptions -------------------------------------------------------------------

  async #subscribeProject(project: ProjectState): Promise<void> {
    const current = () => !this.#closed && this.#projects.get(project.projectId) === project;
    if (!current() || project.policy) return;
    await this.#releaseProjectSubNow(project);
    const identity = await dirIdentity(project.commonDir);
    if (!current()) return;
    if (identity === null) {
      project.failure = { kind: 'missing', message: 'git dir does not exist' };
      return;
    }
    try {
      const link = this.#link((error) => this.#onProjectError(project, error));
      const sub = await this.#subscribe(
        project.commonDir,
        (error, events) => {
          if (link.failed) return;
          if (error) link.fail(error);
          else this.#onGitEvents(project, events);
        },
        { ignore: withDescendants(GIT_DIR_IGNORES) },
      );
      const failedEarly = link.attach(sub);
      if (!current()) {
        await this.#dispose(sub);
        return;
      }
      if (failedEarly) {
        project.failure = link.error ? classifyError(link.error) : { kind: 'other', message: '' };
        this.#scheduleProjectRetry(project);
        return;
      }
      project.sub = sub;
      project.native = true;
      project.failure = null;
      project.identity = identity;
      for (const id of project.worktreeIds) this.#schedulePoll(id);
    } catch (error) {
      project.failure = classifyError(error);
      this.#logFailure(project.failure, project.commonDir);
      if (project.retry.count > 0 && project.failure.kind === 'other') {
        this.#scheduleProjectRetry(project);
      }
    }
  }

  #scheduleProjectRetry(project: ProjectState): void {
    if (this.#closed) return;
    clearTimeout(project.retry.timer);
    project.retry.timer = setTimeout(() => {
      project.retry.timer = undefined;
      if (this.#closed || this.#projects.get(project.projectId) !== project || project.sub) {
        return;
      }
      void this.#enqueue(project, () => this.#subscribeProject(project)).then(() => {
        if (project.sub) for (const id of project.worktreeIds) this.markDirty(id, 'git');
      });
    }, this.#nextRetryDelay(project.retry));
    project.retry.timer.unref();
  }

  /** The git dir's subscription reported an error: drop it, poll, re-subscribe later. */
  #onProjectError(project: ProjectState, error: Error): void {
    if (this.#closed || this.#projects.get(project.projectId) !== project) return;
    this.#log.warn('git dir watcher error; polling until re-subscribed', {
      projectId: project.projectId,
      error,
    });
    project.sub = null;
    project.native = false;
    project.failure = classifyError(error);
    if (project.failure.kind !== 'missing') this.#scheduleProjectRetry(project);
    for (const id of project.worktreeIds) this.#schedulePoll(id);
    this.#onListDirty(project.projectId, 'missing');
  }

  /** Re-subscribes a project's git dir that was deleted or replaced at the same path (F1). */
  async #healProject(project: ProjectState): Promise<void> {
    if (!this.#native || project.policy) return;
    if (project.subscribing) await project.subscribing;
    if (this.#projects.get(project.projectId) !== project) return;
    const identity = await dirIdentity(project.commonDir);
    if (identity === null || project.subscribing) return;
    const replaced = project.sub !== null && identity !== project.identity;
    const back =
      project.sub === null && (project.failure === null || project.failure.kind === 'missing');
    if (!replaced && !back) return;
    this.#log.info('git dir was replaced or is back; re-subscribing', {
      projectId: project.projectId,
      path: project.commonDir,
    });
    await this.#enqueue(project, () => this.#subscribeProject(project));
    if (project.sub) for (const id of project.worktreeIds) this.markDirty(id, 'git');
  }

  async #releaseProjectSubNow(project: ProjectState): Promise<void> {
    const sub = project.sub;
    project.sub = null;
    project.native = false;
    if (sub) await this.#dispose(sub);
  }

  async #releaseProjectSub(project: ProjectState): Promise<void> {
    if (project.subscribing) await project.subscribing;
    await this.#releaseProjectSubNow(project);
  }

  #onGitEvents(project: ProjectState, events: parcelWatcher.Event[]): void {
    if (this.#closed || this.#projects.get(project.projectId) !== project) return;
    const dirty = new Set<WorktreeState>();
    let relist = false;
    const worktreesDir = path.join(project.commonDir, 'worktrees');
    const excludeFile = path.join(project.commonDir, 'info', 'exclude');
    const states = [...project.worktreeIds]
      .map((id) => this.#worktrees.get(id))
      .filter((s): s is WorktreeState => s !== undefined);
    for (const event of events) {
      const p = event.path;
      if (p === project.commonDir && event.type === 'delete') {
        // Same as a deleted worktree root (F1): the subscription is dead from here on.
        project.native = false;
        project.identity = null;
        project.failure = { kind: 'missing', message: 'git dir was deleted' };
        void this.#enqueue(project, () => this.#releaseProjectSubNow(project));
        for (const id of project.worktreeIds) this.#schedulePoll(id);
        this.#onListDirty(project.projectId, 'missing');
        continue;
      }
      if (isLockFile(p)) continue;
      if (p === excludeFile) {
        project.exclude = null;
        for (const st of states) this.#scheduleIgnoreCheck(st);
      }
      if (isSameOrInside(worktreesDir, p)) {
        const rel = path.relative(worktreesDir, p).split(path.sep);
        // worktrees/, worktrees/<name>, worktrees/<name>/{gitdir,locked}: the list changed.
        if (rel.length <= 1 || rel[0] === '' || rel[1] === 'gitdir' || rel[1] === 'locked') {
          relist = true;
        }
      }
      let matched = false;
      for (const st of states) {
        if (this.#gitEventMatches(project, st, p)) {
          dirty.add(st);
          matched = true;
        }
      }
      if (!matched && isSameOrInside(worktreesDir, p) && !relist) relist = true;
    }
    if (relist) this.#scheduleListDirty(project);
    this.#markOwnersDirty(dirty, 'git');
  }

  /** Does a change at `p` (inside the common dir) affect worktree `st`'s git state? */
  #gitEventMatches(project: ProjectState, st: WorktreeState, p: string): boolean {
    const commonDir = project.commonDir;
    const targets = st.info.targets;
    if (!targets) return true;
    const worktreesDir = path.join(commonDir, 'worktrees');
    const ownGitDir = targets.gitDir;
    const isLinked = ownGitDir !== commonDir;
    if (isLinked && isSameOrInside(ownGitDir, p)) return true;
    // Shared state: refs and packed-refs move branch tips and ahead/behind for every worktree;
    // info/ (exclude, attributes) changes what status and diffs report (F6).
    if (
      isSameOrInside(path.join(commonDir, 'refs'), p) ||
      p === path.join(commonDir, 'packed-refs') ||
      isSameOrInside(path.join(commonDir, 'info'), p)
    ) {
      return true;
    }
    for (const g of targets.gitPaths) {
      if (g === commonDir || g === worktreesDir) continue;
      if (isLinked && isSameOrInside(worktreesDir, g) && !isSameOrInside(ownGitDir, g)) continue;
      if (isSameOrInside(g, p)) return true;
    }
    if (!isLinked && !isSameOrInside(worktreesDir, p)) {
      // Main worktree: its git dir is the common dir. Top-level files (HEAD, index, MERGE_HEAD,
      // ORIG_HEAD, ...), in-progress operation dirs and its submodules' git dirs (`modules/`:
      // a submodule's HEAD moving changes the superproject's status, F3) belong to it.
      const rel = path.relative(commonDir, p);
      const first = rel.split(path.sep)[0] ?? '';
      if (!rel.includes(path.sep)) return true;
      if (['rebase-merge', 'rebase-apply', 'sequencer', 'modules'].includes(first)) return true;
    }
    return false;
  }

  #scheduleListDirty(project: ProjectState): void {
    clearTimeout(project.listDebounce);
    project.listDebounce = setTimeout(() => {
      project.listDebounce = undefined;
      if (!this.#closed) this.#onListDirty(project.projectId, 'git');
    }, this.#opts.debounceMs);
    project.listDebounce.unref();
  }

  #scheduleRelist(project: ProjectState): void {
    clearTimeout(project.relist);
    project.relist = setTimeout(() => {
      if (this.#closed || this.#projects.get(project.projectId) !== project) return;
      this.#onListDirty(project.projectId, 'timer');
      this.#scheduleRelist(project);
    }, jittered(this.#opts.relistMs));
    project.relist.unref();
  }

  // --- polling ---------------------------------------------------------------------------------

  pollIntervalFor(worktreeId: string): number {
    const st = this.#worktrees.get(worktreeId);
    const focused = this.#focus === worktreeId;
    if (st && (this.#isNative(st) || this.#pollOnly(st))) {
      return focused ? this.#opts.pollFocusedMs : this.#opts.pollIdleMs;
    }
    return focused ? this.#opts.pollDegradedFocusedMs : this.#opts.pollFocusedMs;
  }

  #schedulePoll(worktreeId: string): void {
    const st = this.#worktrees.get(worktreeId);
    if (!st || this.#closed) return;
    clearTimeout(st.poll);
    st.poll = setTimeout(
      () => {
        st.poll = undefined;
        this.#maybeHeal(st);
        this.#fire(st, 'poll');
      },
      jittered(this.pollIntervalFor(worktreeId)),
    );
    st.poll.unref();
  }

  #fire(st: WorktreeState, reason: DirtyReason): void {
    if (this.#closed || this.#worktrees.get(st.info.worktreeId) !== st) return;
    st.lastFireAt = Date.now();
    this.#schedulePoll(st.info.worktreeId);
    try {
      this.#onDirty(st.info.worktreeId, reason);
    } catch (error) {
      this.#log.error('worktree refresh callback failed', {
        worktreeId: st.info.worktreeId,
        error,
      });
    }
  }

  #logFailure(failure: { kind: FailureKind; message: string }, where: string): void {
    const fields = { path: where, kind: failure.kind, error: failure.message };
    if (this.#loggedFailures.has(failure.kind)) {
      this.#log.debug('native watching failed; polling instead', fields);
      return;
    }
    this.#loggedFailures.add(failure.kind);
    const hint =
      failure.kind === 'inotify-watches'
        ? ' (inotify watch limit; raise fs.inotify.max_user_watches, see `octopus-diff doctor`)'
        : '';
    this.#log.warn(`native watching failed; polling instead${hint}`, fields);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    // Kill the watch host first, never waiting for it: subscribes in flight reject at once
    // (a stuck host cannot delay close) and the unsubscribes below have nothing left to do.
    this.#host?.close();
    const pending: Promise<void>[] = [];
    for (const st of this.#worktrees.values()) {
      clearTimeout(st.debounce);
      clearTimeout(st.poll);
      clearTimeout(st.build.recheck);
      clearTimeout(st.retry.timer);
      pending.push(
        (async () => {
          if (st.subscribing) await st.subscribing;
          await this.#releaseSub(st);
        })(),
      );
    }
    for (const project of this.#projects.values()) {
      clearTimeout(project.relist);
      clearTimeout(project.listDebounce);
      clearTimeout(project.retry.timer);
      pending.push(this.#releaseProjectSub(project));
    }
    this.#worktrees.clear();
    this.#projects.clear();
    await Promise.all(pending);
  }
}
