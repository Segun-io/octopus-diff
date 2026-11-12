import { lstat, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { bstrFromUtf8, compareBstr, isValidUtf8 } from './bstr.js';
import type { RepoInfo } from './context.js';
import { mapLimit } from './fs-utils.js';
import type { NumstatEntry } from './parse/diff-output.js';
import type { StatusBranch, StatusEntry } from './parse/status.js';
import type { UntrackedInfo } from './untracked.js';

/**
 * Incremental summaries (#40): the state a summary was computed from, kept per worktree, and
 * the rules that decide when a watcher's path hint may update it instead of a full refresh.
 *
 * The summary of a worktree is a function of per-path records (the `git status` entry, the
 * numstat lines, the lstat signature of a changed file, the inspection of an untracked file)
 * and a few global facts (the status header: HEAD, branch, upstream and its ahead/behind; the
 * ahead/behind against the default branch; the operation in progress; HEAD's activity time).
 * For a path set P, `git status -- P` and `git diff --numstat HEAD -- P` give exactly the
 * records of P, as long as git compares the same things for them as a full run would:
 *
 * - The index, the ignore rules, the attributes and the config are unchanged (`Stamp`; HEAD
 *   is checked from the fresh status header). Then a path outside P whose file did not change
 *   keeps its record.
 * - Rename detection sees the same candidates: P holds every path that is added, deleted,
 *   renamed, copied, type-changed or unmerged in the last state (a rename pairs a deletion
 *   with an addition anywhere in the tree, on either side of the index), plus the changed
 *   paths themselves, which carry their new adds and deletions. With the same input set,
 *   git's pairing is the same.
 * - Literal pathspecs (`GIT_LITERAL_PATHSPECS=1`, after `--`) match a path and everything
 *   under it, which is what `Region.has` implements, byte for byte.
 *
 * Everything else (a hint that names a directory or an ignore, attribute or submodule file,
 * nested repositories, submodules, sparse checkouts, case-insensitive or normalising
 * filesystems, too many paths, a degraded numstat, any output outside P) falls back to a full
 * refresh. The daemon also reconciles with a full refresh on a timer and whenever the watcher
 * may have missed events (polling, overflow, re-subscribe, git-dir events).
 */

/** Hinted paths above this count: a full refresh (an install, a checkout, a formatter run). */
export const MAX_HINT_PATHS = 256;
/** Pathspecs (hint plus rename candidates) above this count: a full refresh. */
export const MAX_PATHSPECS = 1000;
/** Pathspec bytes above this: a full refresh (Windows caps a command line far lower). */
const PATHSPEC_BYTES = process.platform === 'win32' ? 24_000 : 256_000;
/** Worktrees whose last state is kept (each holds its status entries and numstat records). */
const MAX_TRACKS = 256;
/** Changed-path journal entries kept per worktree, for file lists (`ListJournal`). */
const MAX_JOURNAL = 64;
/** Paths in one journal entry above this: recorded as unknown (the list recomputes fully). */
const MAX_JOURNAL_PATHS = 2000;

/** Files whose change can alter many paths' records, wherever they are in the tree. */
const GLOBAL_FILES = new Set(['.gitignore', '.gitattributes', '.gitmodules']);

/**
 * Stat signatures of what the per-path records depend on besides the files themselves. Taken
 * before git runs, so a write during the run changes the next stamp.
 */
export interface Stamp {
  /** `<gitDir>/index` (git add, commit, checkout, reset, and any index refresh by others). */
  index: string;
  /** info/exclude, the global excludes file: which files are untracked. */
  ignore: string;
  /** Config and attribute files: how files are compared at all. */
  config: string;
  /** A sparse-checkout file exists: incremental refreshes are off. */
  sparse: boolean;
  /** `<root>/.gitmodules` exists: incremental refreshes are off. */
  submodules: boolean;
}

/** A numstat line as git-core keeps it (bstr paths). */
export type NumstatRecord = NumstatEntry;

/** Everything a summary was computed from, for one worktree. Never mutated once stored. */
export interface SummaryTrack {
  /** Bumped on every summary of the worktree (full or incremental). */
  version: number;
  /** The summary's `stateHash`. */
  stateHash: string;
  stamp: Stamp;
  /** Raw `# branch.*` header tokens of the last status (without their NUL). */
  header: string[];
  branch: StatusBranch;
  /** Tracked status entries (ordinary, renamed, unmerged) by path. */
  tracked: Map<string, StatusEntry>;
  /** Untracked status entries by path (a nested repository keeps its trailing `/`). */
  untracked: Map<string, StatusEntry>;
  /** numstat records by destination path, in git's order within a path. */
  numstat: Map<string, NumstatRecord[]>;
  /** numstat was degraded (unreadable files, F7): the next refresh is full. */
  degraded: boolean;
  /** Inspection of untracked files by key (no trailing `/`), with the attribute it used. */
  untrackedInfos: Map<string, { info: UntrackedInfo; attribute: string }>;
  /** Contents of untracked files were read (`inspectOptions.readContent`). */
  readContent: boolean;
  /** lstat signatures of the paths with worktree changes and of the fully staged paths. */
  signatures: Map<string, string>;
  /** `SummaryOptions.defaultBranch` the summary used. */
  defaultBranch: string | null;
  /** HEAD's commit date when there is no reflog, by HEAD commit (one `git log` per commit). */
  headCommitMs: { sha: string; ms: number | null } | null;
  /** Wall clock of the last full refresh. */
  fullAt: number;
  /** Paths whose records changed, per version (null: unknown, e.g. HEAD moved). */
  journal: Array<{ version: number; paths: Set<string> | null }>;
}

/** Parsed and validated path hint (bstr keys), or why it cannot be used. */
export type HintCheck = { ok: true; keys: string[] } | { ok: false; reason: string };

/**
 * Validates `SummaryOptions.changedPaths`: relative, `/`-separated, no `.`/`..`/empty segments,
 * nothing inside a `.git`, no ignore/attribute/submodule files, at most `MAX_HINT_PATHS`.
 */
export function checkHint(paths: readonly unknown[]): HintCheck {
  if (paths.length > MAX_HINT_PATHS) return { ok: false, reason: 'too-many-paths' };
  const keys = new Set<string>();
  for (const value of paths) {
    if (typeof value !== 'string' || value.length === 0)
      return { ok: false, reason: 'invalid-path' };
    if (value.includes('\u0000') || value.includes('\\') || value.startsWith('/')) {
      return { ok: false, reason: 'invalid-path' };
    }
    // Lone surrogates or U+FFFD: the file name was not UTF-8, git would see other bytes.
    if (value.includes('�') || !value.isWellFormed()) {
      return { ok: false, reason: 'undecodable-path' };
    }
    const parts = value.split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..')) {
      return { ok: false, reason: 'invalid-path' };
    }
    if (parts.some((part) => part === '.git')) return { ok: false, reason: 'nested-git' };
    if (GLOBAL_FILES.has(parts[parts.length - 1] as string)) {
      return { ok: false, reason: 'ignore-or-attributes' };
    }
    keys.add(bstrFromUtf8(value));
  }
  return { ok: true, keys: [...keys].sort(compareBstr) };
}

/** A set of literal pathspecs: a key is inside when it equals one or lies under one. */
export class Region {
  private readonly set: Set<string>;

  constructor(readonly specs: readonly string[]) {
    this.set = new Set(specs);
  }

  has(key: string): boolean {
    const bare = key.endsWith('/') ? key.slice(0, -1) : key;
    if (this.set.has(bare)) return true;
    for (let slash = bare.indexOf('/'); slash >= 0; slash = bare.indexOf('/', slash + 1)) {
      if (this.set.has(bare.slice(0, slash))) return true;
    }
    return false;
  }

  get size(): number {
    return this.set.size;
  }
}

/**
 * Tracked entries whose path takes part in rename detection: anything but a plain modification
 * on both sides (an addition, deletion, rename, copy or type change, or an unmerged path).
 */
export function isRenameCandidate(entry: StatusEntry): boolean {
  if (entry.kind === 'renamed' || entry.kind === 'unmerged') return true;
  if (entry.kind !== 'ordinary') return false;
  return !PLAIN.has(entry.x) || !PLAIN.has(entry.y);
}
const PLAIN = new Set(['.', 'M']);

/**
 * Pathspecs for a hint: the hinted keys, every rename candidate of the last state (both paths
 * of a rename), and the paths of signatures that changed without an event (a missed one).
 * Null when they cannot be passed as literal UTF-8 argv or are too many.
 */
export function regionFor(track: SummaryTrack, keys: Iterable<string>): Region | null {
  const specs = new Set<string>(keys);
  for (const entry of track.tracked.values()) {
    if (!isRenameCandidate(entry)) continue;
    specs.add(entry.path);
    if (entry.kind === 'renamed') specs.add(entry.origPath);
  }
  if (specs.size > MAX_PATHSPECS) return null;
  let bytes = 0;
  for (const key of specs) {
    if (!isValidUtf8(key)) return null;
    bytes += key.length + 1;
    if (bytes > PATHSPEC_BYTES) return null;
  }
  return new Region([...specs].sort(compareBstr));
}

/** Literal pathspecs for a set of keys, or null when they cannot be passed (see `regionFor`). */
export function regionOfKeys(keys: ReadonlySet<string>): Region | null {
  if (keys.size === 0 || keys.size > MAX_PATHSPECS) return null;
  let bytes = 0;
  for (const key of keys) {
    if (!isValidUtf8(key)) return null;
    bytes += key.length + 1;
    if (bytes > PATHSPEC_BYTES) return null;
  }
  return new Region([...keys].sort(compareBstr));
}

/** Why the last state cannot take an incremental update at all (or null when it can). */
export function trackBlocker(track: SummaryTrack): string | null {
  if (track.degraded) return 'degraded';
  if (track.stamp.sparse) return 'sparse-checkout';
  if (track.stamp.submodules) return 'submodules';
  for (const entry of track.tracked.values()) {
    if (entry.kind === 'unmerged') continue;
    if (entry.kind === 'ordinary' || entry.kind === 'renamed') {
      if (
        entry.modeHead === '160000' ||
        entry.modeIndex === '160000' ||
        entry.modeWorktree === '160000'
      ) {
        return 'submodules';
      }
    }
  }
  for (const key of track.untracked.keys()) {
    // A nested repository is listed as one directory entry: its files are not.
    if (key.endsWith('/')) return 'nested-repository';
  }
  return null;
}

/** The stamp parts that differ (first one), or null when equal. */
export function stampChange(a: Stamp, b: Stamp): string | null {
  if (a.index !== b.index) return 'index';
  if (a.ignore !== b.ignore) return 'ignore-rules';
  if (a.config !== b.config) return 'config';
  if (a.sparse !== b.sparse) return 'sparse-checkout';
  if (a.submodules !== b.submodules) return 'submodules';
  return null;
}

async function sig(file: string): Promise<string> {
  try {
    const info = await stat(file, { bigint: true });
    return `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}:${info.mode}`;
  } catch {
    return 'none';
  }
}

/** Config and ignore files outside the repository that git reads (global and system). */
function outsideFiles(envValue: (name: string) => string | undefined): {
  config: string[];
  ignore: string[];
} {
  const home = envValue('HOME') || os.homedir();
  const xdg = envValue('XDG_CONFIG_HOME') || (home ? path.join(home, '.config') : '');
  const config: string[] = [];
  const ignore: string[] = [];
  const global = envValue('GIT_CONFIG_GLOBAL');
  if (global) config.push(global);
  else {
    if (home) config.push(path.join(home, '.gitconfig'));
    if (xdg) config.push(path.join(xdg, 'git', 'config'));
  }
  if (!/^(1|true|yes|on)$/i.test(envValue('GIT_CONFIG_NOSYSTEM') ?? '')) {
    config.push(envValue('GIT_CONFIG_SYSTEM') || '/etc/gitconfig');
  }
  if (xdg) {
    ignore.push(path.join(xdg, 'git', 'ignore'));
    config.push(path.join(xdg, 'git', 'attributes'));
  }
  if (!/^(1|true|yes|on)$/i.test(envValue('GIT_ATTR_NOSYSTEM') ?? '')) {
    config.push('/etc/gitattributes');
  }
  return { config, ignore };
}

/**
 * The stamp of a worktree (stat calls only). A custom `core.excludesFile` or
 * `core.attributesFile`, or a config `include`, are not followed: the config file naming them
 * is, and their own edits are picked up by the daemon's reconciliation.
 */
export async function readStamp(
  repo: RepoInfo,
  envValue: (name: string) => string | undefined,
): Promise<Stamp> {
  const root = repo.toplevel ?? repo.cwd;
  const outside = outsideFiles(envValue);
  const configFiles = [
    path.join(repo.commonDir, 'config'),
    path.join(repo.gitDir, 'config.worktree'),
    path.join(repo.commonDir, 'info', 'attributes'),
    path.join(repo.commonDir, 'shallow'),
    ...outside.config,
  ];
  const ignoreFiles = [path.join(repo.commonDir, 'info', 'exclude'), ...outside.ignore];
  const sparseFiles = [
    path.join(repo.gitDir, 'info', 'sparse-checkout'),
    path.join(repo.commonDir, 'info', 'sparse-checkout'),
  ];
  const all = [
    path.join(repo.gitDir, 'index'),
    ...configFiles,
    ...ignoreFiles,
    ...sparseFiles,
    path.join(root, '.gitmodules'),
  ];
  const sigs = await mapLimit(all, 16, sig);
  const at = (i: number): string => sigs[i] as string;
  let i = 1;
  const config = configFiles.map(() => at(i++)).join('|');
  const ignore = ignoreFiles.map(() => at(i++)).join('|');
  const sparse = sparseFiles.map(() => at(i++)).some((s) => s !== 'none');
  const submodules = at(i) !== 'none';
  return { index: at(0), ignore, config, sparse, submodules };
}

const caseProbe = new Map<string, Promise<boolean>>();

/**
 * Does the worktree's filesystem fold case (macOS, Windows, a WSL `/mnt` drive, ciopfs)? Then
 * a watcher may name a file differently from the index, and literal pathspecs (which git
 * matches byte for byte, `core.ignorecase` or not) would miss it: no incremental refresh there.
 * macOS also normalises Unicode, so it never takes one either.
 */
export function foldsCase(root: string): Promise<boolean> {
  if (process.platform === 'darwin' || process.platform === 'win32') return Promise.resolve(true);
  let probe = caseProbe.get(root);
  if (!probe) {
    probe = (async () => {
      try {
        const lower = await lstat(path.join(root, '.git'), { bigint: true });
        const upper = await lstat(path.join(root, '.GIT'), { bigint: true });
        return lower.ino === upper.ino && lower.dev === upper.dev;
      } catch {
        return false;
      }
    })();
    caseProbe.set(root, probe);
    if (caseProbe.size > MAX_TRACKS) {
      const oldest = caseProbe.keys().next().value;
      if (oldest !== undefined) caseProbe.delete(oldest);
    }
  }
  return probe;
}

/** The kept states, one per worktree root, with one summary at a time per worktree. */
export class TrackStore {
  private readonly tracks = new Map<string, SummaryTrack>();
  private readonly queues = new Map<string, Promise<unknown>>();

  get(key: string): SummaryTrack | undefined {
    return this.tracks.get(key);
  }

  set(key: string, track: SummaryTrack): void {
    this.tracks.delete(key);
    this.tracks.set(key, track);
    while (this.tracks.size > MAX_TRACKS) {
      const oldest = this.tracks.keys().next().value;
      if (oldest === undefined) break;
      this.tracks.delete(oldest);
    }
  }

  delete(key: string): void {
    this.tracks.delete(key);
  }

  clear(): void {
    this.tracks.clear();
  }

  /** Runs `fn` after the worktree's previous summary settled (summaries of one worktree are serial). */
  serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    return run;
  }
}

/** One record of a path, as compared between two states for the journal. */
function recordsOf(track: SummaryTrack, key: string): string {
  const parts: string[] = [];
  const tracked = track.tracked.get(key);
  if (tracked) parts.push(tracked.line);
  const untracked = track.untracked.get(key) ?? track.untracked.get(`${key}/`);
  if (untracked) parts.push(untracked.line);
  const info = track.untrackedInfos.get(key);
  if (info) parts.push(info.info.statSig, info.attribute, info.info.patchHash);
  for (const record of track.numstat.get(key) ?? []) {
    parts.push(`${record.added}:${record.deleted}:${record.srcPath ?? ''}`);
  }
  const signature = track.signatures.get(key);
  if (signature) parts.push(signature);
  return parts.join('\u0000');
}

function keysOf(track: SummaryTrack): Set<string> {
  const keys = new Set<string>();
  for (const [key, entry] of track.tracked) {
    keys.add(key);
    if (entry.kind === 'renamed') keys.add(entry.origPath);
  }
  for (const key of track.untracked.keys()) keys.add(key.endsWith('/') ? key.slice(0, -1) : key);
  for (const key of track.numstat.keys()) keys.add(key);
  for (const records of track.numstat.values()) {
    for (const record of records) if (record.srcPath) keys.add(record.srcPath);
  }
  for (const key of track.signatures.keys()) keys.add(key);
  return keys;
}

/**
 * The paths whose records differ between two states of a worktree (both paths of a rename),
 * or null when something global changed that can alter any file's patch: HEAD, the config or
 * attribute files, the operation in progress, a degraded numstat, an attributes file.
 */
export function changedKeys(previous: SummaryTrack, next: SummaryTrack): Set<string> | null {
  if (previous.branch.oid !== next.branch.oid) return null;
  if (previous.stamp.config !== next.stamp.config) return null;
  if (previous.degraded || next.degraded) return null;
  if (previous.readContent !== next.readContent) return null;
  const out = new Set<string>();
  const all = keysOf(previous);
  for (const key of keysOf(next)) all.add(key);
  for (const key of all) {
    if (recordsOf(previous, key) === recordsOf(next, key)) continue;
    if (path.posix.basename(key) === '.gitattributes') return null;
    out.add(key);
    if (out.size > MAX_JOURNAL_PATHS) return null;
  }
  // A rename pairs two paths: when one changed, the other's patch may have changed too.
  for (const track of [previous, next]) {
    for (const entry of track.tracked.values()) {
      if (entry.kind !== 'renamed') continue;
      if (out.has(entry.path) || out.has(entry.origPath)) {
        out.add(entry.path);
        out.add(entry.origPath);
      }
    }
  }
  return out;
}

/** The journal of `next` after `previous`: the last entries plus this change. */
export function nextJournal(
  previous: SummaryTrack | undefined,
  next: SummaryTrack,
): SummaryTrack['journal'] {
  if (!previous) return [{ version: next.version, paths: null }];
  const journal = previous.journal.slice(-(MAX_JOURNAL - 1));
  journal.push({ version: next.version, paths: changedKeys(previous, next) });
  return journal;
}

/**
 * Paths that changed after version `since` (exclusive) up to the track's version, or null when
 * the journal cannot tell (a gap, an unknown entry, or too many paths).
 */
export function changedSince(track: SummaryTrack, since: number): Set<string> | null {
  if (since === track.version) return new Set();
  if (since > track.version) return null;
  const first = track.journal[0];
  if (!first || first.version > since + 1) return null;
  const out = new Set<string>();
  for (const entry of track.journal) {
    if (entry.version <= since) continue;
    if (entry.paths === null) return null;
    for (const key of entry.paths) out.add(key);
    if (out.size > MAX_JOURNAL_PATHS) return null;
  }
  return out;
}
