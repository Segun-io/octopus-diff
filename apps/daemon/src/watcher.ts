import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Logger, WatcherMode, WatchTargets } from '@octopus-diff/contracts';
import parcelWatcher from '@parcel/watcher';
import { isSameOrInside } from './paths.js';

export type SubscribeFn = (
  dir: string,
  fn: parcelWatcher.SubscribeCallback,
  opts?: parcelWatcher.Options,
) => Promise<parcelWatcher.AsyncSubscription>;

export type DirtyReason = 'fs' | 'git' | 'poll' | 'focus' | 'manual';

/** Directory names never watched inside working trees (PLAN §5.6), at any depth. */
export const DEFAULT_WORKTREE_IGNORES: readonly string[] = [
  '.git',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
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

/** Parts of a common git dir that never affect status (watching them would be expensive). */
export const GIT_DIR_IGNORES: readonly string[] = [
  'objects',
  'logs',
  'hooks',
  'lfs',
  'modules',
  'rr-cache',
  'info',
  'fsmonitor--daemon',
  'worktrees/*/logs',
];

export const WATCH_DEFAULTS = {
  debounceMs: 200,
  maxWaitMs: 1000,
  pollFocusedMs: 30_000,
  pollIdleMs: 300_000,
  /** Focused worktree without a working native watcher. */
  pollDegradedFocusedMs: 5_000,
  relistMs: 60_000,
} as const;

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
  forcePolling?: boolean;
  ignore?: readonly string[];
  debounceMs?: number;
  maxWaitMs?: number;
  pollFocusedMs?: number;
  pollIdleMs?: number;
  pollDegradedFocusedMs?: number;
  relistMs?: number;
  logger: Logger;
  /** Injected for tests (e.g. to simulate inotify limits). Default: `@parcel/watcher`. */
  subscribe?: SubscribeFn;
  onWorktreeDirty: (worktreeId: string, reason: DirtyReason) => void;
  onWorktreeListDirty: (projectId: string, reason: 'git' | 'timer' | 'missing') => void;
}

type FailureKind = 'inotify-watches' | 'inotify-instances' | 'missing' | 'permission' | 'other';

interface WorktreeState {
  info: WatchedWorktree;
  sub: parcelWatcher.AsyncSubscription | null;
  subscribing: Promise<void> | null;
  native: boolean;
  failure: { kind: FailureKind; message: string } | null;
  onWindowsMount: boolean;
  debounce: NodeJS.Timeout | undefined;
  burstStart: number;
  pendingReason: DirtyReason;
  poll: NodeJS.Timeout | undefined;
}

interface ProjectState {
  projectId: string;
  commonDir: string;
  sub: parcelWatcher.AsyncSubscription | null;
  subscribing: Promise<void> | null;
  native: boolean;
  failure: { kind: FailureKind; message: string } | null;
  worktreeIds: Set<string>;
  relist: NodeJS.Timeout | undefined;
  listDebounce: NodeJS.Timeout | undefined;
}

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

function isLockFile(p: string): boolean {
  return p.endsWith('.lock');
}

/**
 * Watches working trees and git dirs with `@parcel/watcher` (PLAN §5.6), debounces bursts per
 * worktree, and polls as a safety net (30 s focused / 5 min others). When native watching fails
 * (inotify limits on WSL or big trees, permissions, missing paths) the affected worktrees are
 * polled instead and a warning is surfaced through `status()`.
 */
export class WatcherService {
  readonly #opts: Required<
    Omit<
      WatcherServiceOptions,
      'subscribe' | 'ignore' | 'logger' | 'onWorktreeDirty' | 'onWorktreeListDirty'
    >
  >;
  readonly #log: Logger;
  readonly #subscribe: SubscribeFn;
  readonly #worktreeIgnores: string[];
  readonly #onDirty: WatcherServiceOptions['onWorktreeDirty'];
  readonly #onListDirty: WatcherServiceOptions['onWorktreeListDirty'];
  readonly #worktrees = new Map<string, WorktreeState>();
  readonly #projects = new Map<string, ProjectState>();
  readonly #loggedFailures = new Set<FailureKind>();
  #focus: string | null = null;
  #closed = false;

  constructor(options: WatcherServiceOptions) {
    const debounceMs = options.debounceMs ?? WATCH_DEFAULTS.debounceMs;
    this.#opts = {
      enabled: options.enabled ?? true,
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
    };
    this.#log = options.logger;
    this.#subscribe = options.subscribe ?? parcelWatcher.subscribe;
    this.#worktreeIgnores = buildWorktreeIgnores(options.ignore);
    this.#onDirty = options.onWorktreeDirty;
    this.#onListDirty = options.onWorktreeListDirty;
  }

  get #native(): boolean {
    return this.#opts.enabled && !this.#opts.forcePolling;
  }

  // --- registration ----------------------------------------------------------------------------

  /**
   * Declares the full set of worktrees to watch for a project. Worktrees not in the list are
   * unwatched; new ones are subscribed; existing ones get updated targets.
   */
  async setProject(
    projectId: string,
    commonDir: string,
    worktrees: WatchedWorktree[],
  ): Promise<void> {
    if (this.#closed) return;
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
        worktreeIds: new Set(),
        relist: undefined,
        listDebounce: undefined,
      };
      this.#projects.set(projectId, project);
      this.#scheduleRelist(project);
      if (this.#native) pending.push(this.#subscribeProject(project));
    }
    const wanted = new Set(worktrees.map((w) => w.worktreeId));
    for (const id of [...project.worktreeIds]) {
      if (!wanted.has(id)) pending.push(this.#unwatchWorktree(id));
    }
    for (const info of worktrees) {
      const existing = this.#worktrees.get(info.worktreeId);
      if (existing) {
        existing.info = info;
        continue;
      }
      project.worktreeIds.add(info.worktreeId);
      pending.push(this.#watchWorktree(info));
    }
    await Promise.all(pending);
  }

  async removeProject(projectId: string): Promise<void> {
    const project = this.#projects.get(projectId);
    if (!project) return;
    this.#projects.delete(projectId);
    clearTimeout(project.relist);
    clearTimeout(project.listDebounce);
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

  // --- status ----------------------------------------------------------------------------------

  /** Overall mode and human-readable warnings (no paths: `/api/health` is unauthenticated). */
  status(): { mode: WatcherMode; warnings: string[] } {
    if (!this.#opts.enabled) return { mode: 'disabled', warnings: [] };
    if (this.#opts.forcePolling) return { mode: 'polling', warnings: [] };
    let native = 0;
    let degraded = 0;
    const failures = new Map<FailureKind, number>();
    let windowsMounts = 0;
    for (const st of this.#worktrees.values()) {
      const project = this.#projects.get(st.info.projectId);
      const failure = st.failure ?? project?.failure ?? null;
      if (this.#isNative(st)) native++;
      else degraded++;
      if (failure) failures.set(failure.kind, (failures.get(failure.kind) ?? 0) + 1);
      if (st.onWindowsMount) windowsMounts++;
    }
    const pollSeconds = Math.round(this.#opts.pollFocusedMs / 1000);
    const warnings: string[] = [];
    for (const [kind, count] of failures) {
      warnings.push(this.#failureWarning(kind, count, pollSeconds));
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
    if (!this.#native || st.onWindowsMount) return false;
    const project = this.#projects.get(st.info.projectId);
    const gitNative = project?.native ?? false;
    return st.info.bare ? gitNative : st.native && gitNative;
  }

  // --- worktree subscriptions ------------------------------------------------------------------

  async #watchWorktree(info: WatchedWorktree): Promise<void> {
    const st: WorktreeState = {
      info,
      sub: null,
      subscribing: null,
      native: false,
      failure: null,
      onWindowsMount: IS_WSL && /^\/mnt\/[a-z](\/|$)/i.test(info.root),
      debounce: undefined,
      burstStart: 0,
      pendingReason: 'fs',
      poll: undefined,
    };
    this.#worktrees.set(info.worktreeId, st);
    this.#schedulePoll(info.worktreeId);
    if (!this.#native || info.bare) return;
    const nested = [...this.#worktrees.values()]
      .map((other) => other.info.root)
      .filter((root) => root !== info.root && isSameOrInside(info.root, root));
    const ignore = [...this.#worktreeIgnores, ...nested];
    st.subscribing = (async () => {
      try {
        const sub = await this.#subscribe(
          info.root,
          (error, events) => this.#onWorktreeEvents(st, error, events),
          { ignore },
        );
        if (this.#closed || this.#worktrees.get(info.worktreeId) !== st) {
          await sub.unsubscribe().catch(() => {});
          return;
        }
        st.sub = sub;
        st.native = true;
        st.failure = null;
        this.#schedulePoll(info.worktreeId);
      } catch (error) {
        st.failure = classifyError(error);
        this.#logFailure(st.failure, info.root);
        this.#schedulePoll(info.worktreeId);
      } finally {
        st.subscribing = null;
      }
    })();
    await st.subscribing;
  }

  async #unwatchWorktree(worktreeId: string): Promise<void> {
    const st = this.#worktrees.get(worktreeId);
    if (!st) return;
    this.#worktrees.delete(worktreeId);
    this.#projects.get(st.info.projectId)?.worktreeIds.delete(worktreeId);
    clearTimeout(st.debounce);
    clearTimeout(st.poll);
    if (this.#focus === worktreeId) this.#focus = null;
    if (st.subscribing) await st.subscribing;
    const sub = st.sub;
    st.sub = null;
    if (sub) await sub.unsubscribe().catch(() => {});
  }

  #onWorktreeEvents(st: WorktreeState, error: Error | null, events: parcelWatcher.Event[]): void {
    if (this.#closed || this.#worktrees.get(st.info.worktreeId) !== st) return;
    if (error) {
      this.#log.warn('watcher error; polling continues', {
        worktreeId: st.info.worktreeId,
        error,
      });
      st.failure = classifyError(error);
      st.native = false;
      this.#schedulePoll(st.info.worktreeId);
      this.#onListDirty(st.info.projectId, 'missing');
      return;
    }
    const owners = new Set<string>();
    for (const event of events) {
      if (event.path === st.info.root && event.type === 'delete') {
        this.#onListDirty(st.info.projectId, 'missing');
      }
      owners.add(this.#ownerOf(event.path, st));
    }
    for (const owner of owners) this.markDirty(owner, 'fs');
  }

  /** The deepest watched worktree root that contains `p` (handles nested worktrees). */
  #ownerOf(p: string, st: WorktreeState): string {
    let owner = st.info.worktreeId;
    let depth = st.info.root.length;
    for (const other of this.#worktrees.values()) {
      if (other === st || other.info.bare) continue;
      const root = other.info.root;
      if (root.length > depth && isSameOrInside(root, p) && isSameOrInside(st.info.root, root)) {
        owner = other.info.worktreeId;
        depth = root.length;
      }
    }
    return owner;
  }

  // --- git dir subscriptions -------------------------------------------------------------------

  async #subscribeProject(project: ProjectState): Promise<void> {
    project.subscribing = (async () => {
      try {
        const sub = await this.#subscribe(
          project.commonDir,
          (error, events) => this.#onGitEvents(project, error, events),
          { ignore: [...GIT_DIR_IGNORES] },
        );
        if (this.#closed || this.#projects.get(project.projectId) !== project) {
          await sub.unsubscribe().catch(() => {});
          return;
        }
        project.sub = sub;
        project.native = true;
        project.failure = null;
        for (const id of project.worktreeIds) this.#schedulePoll(id);
      } catch (error) {
        project.failure = classifyError(error);
        this.#logFailure(project.failure, project.commonDir);
      } finally {
        project.subscribing = null;
      }
    })();
    await project.subscribing;
  }

  async #releaseProjectSub(project: ProjectState): Promise<void> {
    if (project.subscribing) await project.subscribing;
    const sub = project.sub;
    project.sub = null;
    if (sub) await sub.unsubscribe().catch(() => {});
  }

  #onGitEvents(project: ProjectState, error: Error | null, events: parcelWatcher.Event[]): void {
    if (this.#closed || this.#projects.get(project.projectId) !== project) return;
    if (error) {
      this.#log.warn('git dir watcher error; polling continues', {
        projectId: project.projectId,
        error,
      });
      project.failure = classifyError(error);
      project.native = false;
      for (const id of project.worktreeIds) this.#schedulePoll(id);
      this.#onListDirty(project.projectId, 'missing');
      return;
    }
    const dirty = new Set<string>();
    let relist = false;
    const worktreesDir = path.join(project.commonDir, 'worktrees');
    const states = [...project.worktreeIds]
      .map((id) => this.#worktrees.get(id))
      .filter((s): s is WorktreeState => s !== undefined);
    for (const event of events) {
      const p = event.path;
      if (p === project.commonDir && event.type === 'delete') {
        this.#onListDirty(project.projectId, 'missing');
        continue;
      }
      if (isLockFile(p)) continue;
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
          dirty.add(st.info.worktreeId);
          matched = true;
        }
      }
      if (!matched && isSameOrInside(worktreesDir, p) && !relist) relist = true;
    }
    if (relist) this.#scheduleListDirty(project);
    for (const id of dirty) this.markDirty(id, 'git');
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
    // Shared state: refs and packed-refs move branch tips and ahead/behind for every worktree.
    if (
      isSameOrInside(path.join(commonDir, 'refs'), p) ||
      p === path.join(commonDir, 'packed-refs')
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
      // ORIG_HEAD, ...) and in-progress operation dirs belong to it.
      const rel = path.relative(commonDir, p);
      const first = rel.split(path.sep)[0] ?? '';
      if (!rel.includes(path.sep)) return true;
      if (['rebase-merge', 'rebase-apply', 'sequencer'].includes(first)) return true;
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
    if (st && this.#isNative(st)) return focused ? this.#opts.pollFocusedMs : this.#opts.pollIdleMs;
    return focused ? this.#opts.pollDegradedFocusedMs : this.#opts.pollFocusedMs;
  }

  #schedulePoll(worktreeId: string): void {
    const st = this.#worktrees.get(worktreeId);
    if (!st || this.#closed) return;
    clearTimeout(st.poll);
    st.poll = setTimeout(
      () => {
        st.poll = undefined;
        this.#fire(st, 'poll');
      },
      jittered(this.pollIntervalFor(worktreeId)),
    );
    st.poll.unref();
  }

  #fire(st: WorktreeState, reason: DirtyReason): void {
    if (this.#closed || this.#worktrees.get(st.info.worktreeId) !== st) return;
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
    const pending: Promise<void>[] = [];
    for (const st of this.#worktrees.values()) {
      clearTimeout(st.debounce);
      clearTimeout(st.poll);
      pending.push(
        (async () => {
          if (st.subscribing) await st.subscribing;
          if (st.sub) await st.sub.unsubscribe().catch(() => {});
          st.sub = null;
        })(),
      );
    }
    for (const project of this.#projects.values()) {
      clearTimeout(project.relist);
      clearTimeout(project.listDebounce);
      pending.push(this.#releaseProjectSub(project));
    }
    this.#worktrees.clear();
    this.#projects.clear();
    await Promise.all(pending);
  }
}
