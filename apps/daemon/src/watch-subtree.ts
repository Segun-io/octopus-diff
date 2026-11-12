import { type Dirent, readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * New directories under a watched tree (issue #36, DECISIONS #213).
 *
 * `@parcel/watcher`'s inotify backend (Linux) adds a watch for a directory that appears, for that
 * one directory only, and never crawls it (`InotifyBackend::handleSubscription` calls `watchDir`,
 * not a recursive walk). A subdirectory that already exists when the watch is added (`mkdir -p
 * vendor/pkg/deep`, `cp -r`, `tar x`, a `git checkout` that creates nested directories, a `mv` of
 * a whole tree into the worktree) therefore has no watch and reports nothing, ever, until the
 * tree is subscribed again. The stream shows one event, `create vendor`, and `git status` shows
 * no change while the directories are still empty, so the daemon announces nothing, and later
 * writes inside the subtree are invisible.
 *
 * `NewSubtreeWatch` collects the directory creations of a burst, and once the burst is quiet
 * looks (read-only `readdir`) for subdirectories that never reported their own creation: those
 * were not watched. It then asks for one rate-limited re-subscribe, which crawls the tree again
 * and watches every directory in it. The same rule covers an inotify queue overflow, which
 * @parcel/watcher ignores silently (`IN_Q_OVERFLOW` is skipped): a burst big enough to fill the
 * queue may have dropped the creation of a directory, so it ends with a re-subscribe too.
 */

/**
 * Created paths (files too: events do not say which are directories) inspected per pass; a
 * bigger burst re-subscribes without looking.
 */
export const MAX_INSPECTED_PATHS = 4096;

/** `readdir`s in flight at once while inspecting. */
const INSPECT_CONCURRENCY = 64;

/** Shortest gap between two re-subscribes of the same tree (grows with the crawl time). */
export const MIN_RESUBSCRIBE_GAP_MS = 2000;

/** A re-subscribe may take at most 1/10 of the time: the next one waits ten crawl durations. */
const GAP_PER_CRAWL = 10;

const DEFAULT_MAX_QUEUED_EVENTS = 16_384;

/**
 * Creation events in one burst that suggest the kernel queue may have overflowed
 * (`fs.inotify.max_queued_events`, 16384 by default): half of the limit.
 */
export function burstThreshold(): number {
  let limit = DEFAULT_MAX_QUEUED_EVENTS;
  try {
    const parsed = Number.parseInt(
      readFileSync('/proc/sys/fs/inotify/max_queued_events', 'utf8').trim(),
      10,
    );
    if (Number.isFinite(parsed) && parsed > 0) limit = parsed;
  } catch {
    // Not Linux, or not readable: the default.
  }
  return Math.max(1000, Math.floor(limit / 2));
}

export type SubtreeReason = 'unwatched-subdir' | 'burst' | 'too-many-paths';

export interface SubtreeCheck {
  /** Created paths looked at. */
  inspected: number;
  /** Why the tree needs a re-subscribe, or null. */
  reason: SubtreeReason | null;
}

/**
 * Is there a subdirectory, directly inside one of the `created` directories, that is neither
 * ignored nor was reported created itself? Such a directory existed before its parent was
 * watched, so it is not watched. Entries that are not directories (files, symlinks) and
 * paths that vanished are skipped. `alsoCreated` holds the creations of the previous pass: a
 * subdirectory's own event may arrive in a later delivery than its parent's.
 */
export async function findUnwatchedSubdir(
  created: ReadonlySet<string>,
  isIgnored: (childPath: string) => boolean,
  alsoCreated: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  const inspect = async (dir: string): Promise<boolean> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return false; // gone, or not a directory (a created file)
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (!created.has(child) && !alsoCreated.has(child) && !isIgnored(child)) return true;
    }
    return false;
  };
  const paths = [...created];
  for (let i = 0; i < paths.length; i += INSPECT_CONCURRENCY) {
    const found = await Promise.all(paths.slice(i, i + INSPECT_CONCURRENCY).map(inspect));
    if (found.some(Boolean)) return true;
  }
  return false;
}

export interface NewSubtreeWatchOptions {
  debounceMs: number;
  maxWaitMs: number;
  /** Creation events in one burst that make a re-subscribe worthwhile by themselves. */
  burstThreshold: number;
  /** Directories that are not watched by design (ignore list, other worktrees). */
  isIgnored: (childPath: string) => boolean;
  /** The tree needs a re-subscribe. */
  onUnwatched: (check: SubtreeCheck) => void;
  /** Every finished pass (diagnostics and tests). */
  onCheck?: (check: SubtreeCheck) => void;
}

/** Collects the creations of a burst; one pass per quiet period. */
export class NewSubtreeWatch {
  readonly #opts: NewSubtreeWatchOptions;
  #created = new Set<string>();
  /** The previous pass's creations (minus what was deleted since, see `noteRemoved`). */
  #recent = new Set<string>();
  #count = 0;
  #timer: NodeJS.Timeout | undefined;
  #burstStart = 0;
  #disposed = false;

  constructor(options: NewSubtreeWatchOptions) {
    this.#opts = options;
  }

  /** Feeds the `create` events of one delivery (other event types are not passed in). */
  note(createdPaths: readonly string[]): void {
    if (this.#disposed || createdPaths.length === 0) return;
    for (const p of createdPaths) {
      if (this.#created.size <= MAX_INSPECTED_PATHS) this.#created.add(p);
    }
    this.#count += createdPaths.length;
    const now = Date.now();
    if (this.#timer === undefined) this.#burstStart = now;
    clearTimeout(this.#timer);
    const wait = Math.max(
      0,
      Math.min(this.#opts.debounceMs, this.#burstStart + this.#opts.maxWaitMs - now),
    );
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#pass();
    }, wait);
    this.#timer.unref();
  }

  /**
   * Forgets what is remembered about deleted paths and everything under them. A creation seen
   * earlier at the same path is no proof that a directory created there now is watched: it was
   * replaced (`a/b` created, `a` deleted, `a/b/deep` created in one go reports only `create a`).
   */
  noteRemoved(removedPaths: readonly string[]): void {
    if (this.#disposed || removedPaths.length === 0) return;
    for (const removed of removedPaths) {
      const inside = removed + path.sep;
      for (const set of [this.#created, this.#recent]) {
        for (const p of set) if (p === removed || p.startsWith(inside)) set.delete(p);
      }
    }
  }

  async #pass(): Promise<void> {
    const created = this.#created;
    const count = this.#count;
    const recent = this.#recent;
    this.#recent = new Set(created);
    this.#created = new Set();
    this.#count = 0;
    if (this.#disposed) return;
    let reason: SubtreeReason | null = null;
    if (count >= this.#opts.burstThreshold) reason = 'burst';
    else if (created.size > MAX_INSPECTED_PATHS) reason = 'too-many-paths';
    else if (await findUnwatchedSubdir(created, this.#opts.isIgnored, recent))
      reason = 'unwatched-subdir';
    if (this.#disposed) return;
    const check = { inspected: created.size, reason };
    this.#opts.onCheck?.(check);
    if (reason) this.#opts.onUnwatched(check);
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#created.clear();
  }
}

/**
 * Runs a re-subscribe at most once per gap, and coalesces requests made while one is waiting
 * or running into one more run after it (the crawl sees every directory that exists by then).
 */
export class ResubscribeGate {
  readonly #minGapMs: number;
  #lastAt = 0;
  #lastDurationMs = 0;
  #timer: NodeJS.Timeout | undefined;
  #running = false;
  #again = false;
  #disposed = false;

  constructor(minGapMs: number = MIN_RESUBSCRIBE_GAP_MS) {
    this.#minGapMs = minGapMs;
  }

  request(run: () => Promise<void>): void {
    if (this.#disposed || this.#timer !== undefined) return;
    if (this.#running) {
      this.#again = true;
      return;
    }
    const gap = Math.max(this.#minGapMs, GAP_PER_CRAWL * this.#lastDurationMs);
    const wait = Math.max(0, this.#lastAt + gap - Date.now());
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#run(run);
    }, wait);
    this.#timer.unref();
  }

  async #run(run: () => Promise<void>): Promise<void> {
    this.#running = true;
    const start = Date.now();
    try {
      await run();
    } finally {
      this.#running = false;
      this.#lastDurationMs = Date.now() - start;
      this.#lastAt = Date.now();
      if (this.#again && !this.#disposed) {
        this.#again = false;
        this.request(run);
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

const GIT_DIR_HEAVY = new Set(['objects', 'logs', 'hooks', 'lfs', 'rr-cache', 'fsmonitor--daemon']);

/**
 * Is `child` (absolute, inside `commonDir`) one of the directories `GIT_DIR_IGNORES` leaves
 * unwatched? Mirrors that list, which is what the watcher actually skips.
 */
export function isIgnoredGitDirChild(commonDir: string, child: string): boolean {
  const parts = path.relative(commonDir, child).split(path.sep);
  const [first, second, third] = parts;
  if (parts.length === 1) return GIT_DIR_HEAVY.has(first ?? '');
  if (first === 'worktrees' && third === 'logs' && parts.length === 3) return true;
  const last = parts[parts.length - 1] ?? '';
  const underModules = first === 'modules' || (first === 'worktrees' && parts[2] === 'modules');
  return underModules && second !== undefined && GIT_DIR_HEAVY.has(last);
}
