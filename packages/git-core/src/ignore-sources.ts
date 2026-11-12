import { lstat, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mapLimit } from './fs-utils.js';
import { absolutePathBuffer } from './untracked.js';

/**
 * The ignore rules an untracked file was listed under (#41, PR #93 review). Whether git lists a
 * path as untracked depends on every `.gitignore` from the repository root down to its directory
 * (a file that is absent counts: creating one, or deleting one that held a `!` rule, changes the
 * answer), `.git/info/exclude`, the global excludes file and `core.excludesFile`. The summary's
 * `Stamp` covers `info/exclude` and the default global file (an incremental refresh refuses to
 * run when they move); `.gitignore` files are covered there only by the watcher's events (a hint
 * naming one is a full refresh), which a diff opened before the summary has caught up cannot
 * wait for. So the track also records, per directory that holds an untracked file, the state of
 * that directory's `.gitignore` (its lstat signature, or `absent`), and the state of the file
 * `core.excludesFile` names; the diff route compares them again and refuses on any difference.
 */
export interface IgnoreRecord {
  /** Directory (bstr key, `''` for the root) -> state of its `.gitignore`. */
  dirs: Map<string, string>;
  /** `<resolved path>\0<state>` of `core.excludesFile`; `''` when none is set; null: not recorded. */
  excludes: string | null;
}

/**
 * A source written this close to the stamp (or later) may have changed under git's read. The
 * kernel's coarse timestamps lag the clock by a jiffy (10 ms at worst), hence a margin above that.
 */
export const IGNORE_MARGIN_MS = 30;
/** A state that never equals another one: written too close to the summary to be believed. */
export const UNSTABLE = 'unstable';

const excludesUnstable = (state: string): boolean => state.endsWith(`\u0000${UNSTABLE}`);

export function emptyIgnoreRecord(): IgnoreRecord {
  return { dirs: new Map(), excludes: null };
}

const missing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

function sigOf(info: {
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  ino: bigint;
  mode: bigint;
}): string {
  return `${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.ino}:${info.mode}`;
}

const youngMs = (info: { mtimeNs: bigint; ctimeNs: bigint }): number =>
  Math.max(Number(info.mtimeNs / 1_000_000n), Number(info.ctimeNs / 1_000_000n));

/**
 * The state of `<root>/<dir>/.gitignore` against the stamp time `at`: its signature, `absent`,
 * or `unstable` (written within the clock margin of `at`; absent in a directory whose own
 * entries changed that recently, which a deletion or a creation just before the read does).
 * Stat calls only.
 */
export async function ignoreFileState(root: string, dir: string, at: number): Promise<string> {
  const file = absolutePathBuffer(root, dir === '' ? '.gitignore' : `${dir}/.gitignore`);
  try {
    const info = await lstat(file, { bigint: true });
    // git warns and skips a `.gitignore` that is a symlink (a worktree file it will not follow);
    // whether every version does is not ours to assume, and a link's target moves unseen: never
    // believed.
    if (info.isSymbolicLink()) return UNSTABLE;
    return youngMs(info) >= at - IGNORE_MARGIN_MS ? UNSTABLE : sigOf(info);
  } catch (error) {
    if (!missing(error)) return UNSTABLE;
  }
  try {
    const info = await lstat(dir === '' ? root : absolutePathBuffer(root, dir), { bigint: true });
    return youngMs(info) >= at - IGNORE_MARGIN_MS ? UNSTABLE : 'absent';
  } catch {
    return UNSTABLE;
  }
}

/** `dir` and every directory above it, the root (`''`) first. */
export function ancestorDirs(dir: string): string[] {
  const out = [''];
  if (dir === '') return out;
  for (let slash = dir.indexOf('/'); slash >= 0; slash = dir.indexOf('/', slash + 1)) {
    out.push(dir.slice(0, slash));
  }
  out.push(dir);
  return out;
}

/** The directories (every ancestor, root included) of untracked keys. */
export function ignoreDirsOf(keys: Iterable<string>): Set<string> {
  const out = new Set<string>(['']);
  for (const raw of keys) {
    const key = raw.endsWith('/') ? raw.slice(0, -1) : raw;
    const slash = key.lastIndexOf('/');
    if (slash < 0) continue;
    const parent = key.slice(0, slash);
    if (out.has(parent)) continue;
    for (const dir of ancestorDirs(parent)) out.add(dir);
  }
  return out;
}

/**
 * The state of the file `core.excludesFile` names (`configured`: its values from the config scan,
 * the last one wins), as `<resolved path>\0<state>`, `''` when none is set (the default global
 * file is part of the `Stamp`).
 */
export async function excludesFileState(
  root: string,
  configured: readonly string[],
  home: string | undefined,
  at: number,
): Promise<string> {
  const last = configured[configured.length - 1];
  if (!last) return '';
  // `~user` and the like are not expanded here: never believed.
  if (last.startsWith('~') && !last.startsWith('~/') && last !== '~') {
    return `${last}\u0000${UNSTABLE}`;
  }
  const expanded =
    last === '~' || last.startsWith('~/') ? path.join(home || os.homedir(), last.slice(1)) : last;
  const resolved = path.resolve(root, expanded);
  const state = async (): Promise<string> => {
    try {
      const link = await lstat(resolved, { bigint: true });
      let young = youngMs(link);
      let text = sigOf(link);
      if (link.isSymbolicLink()) {
        // git reads the target: its state is part of the source (every component of the link's
        // path is followed by `stat`; the file's own path by `lstat` above).
        try {
          const target = await stat(resolved, { bigint: true });
          young = Math.max(young, youngMs(target));
          text = `${text}>${sigOf(target)}`;
        } catch (error) {
          if (!missing(error)) return UNSTABLE;
          text = `${text}>dangling`;
        }
      }
      return young >= at - IGNORE_MARGIN_MS ? UNSTABLE : text;
    } catch (error) {
      return missing(error) ? 'absent' : UNSTABLE;
    }
  };
  return `${resolved}\u0000${await state()}`;
}

/**
 * The record for a new track: every directory above an untracked key (`keys`) with the state of
 * its `.gitignore`. An incremental refresh passes the previous record: what it already holds is
 * kept (a file that moved without any event must still differ from it), only new directories and
 * ones recorded as unstable are read again, and `keys` are the ones the refresh recomputed.
 */
export async function recordIgnore(
  root: string,
  at: number,
  keys: Iterable<string>,
  previous: IgnoreRecord | undefined,
  excludes: () => Promise<string>,
  relisted: (dir: string) => boolean = () => false,
): Promise<IgnoreRecord> {
  const dirs = new Map(previous?.dirs ?? []);
  const wanted: string[] = [];
  for (const dir of ignoreDirsOf(keys)) {
    if (!dirs.has(dir)) wanted.push(dir);
  }
  // A directory recorded `unstable` was too young to vouch for, and the untracked entries under it
  // were listed under rules that may have changed since: only a refresh that lists them all again
  // (its pathspecs cover the directory) may record it afresh; any other leaves it refusing.
  for (const [dir, state] of dirs) if (state === UNSTABLE && relisted(dir)) wanted.push(dir);
  const states = await mapLimit(wanted, 32, (dir) => ignoreFileState(root, dir, at));
  for (const [i, dir] of wanted.entries()) dirs.set(dir, states[i] as string);
  // Likewise the excludes file: a held record, unstable or not, is only replaced by a full refresh.
  return { dirs, excludes: previous?.excludes ?? (await excludes()) };
}

/**
 * Does anything that decided whether `key` (a bstr key, no trailing slash) was listed as
 * untracked differ from the record? Refuses on a directory the record does not hold, an unstable
 * state, an ignore file that appeared, changed or disappeared, and a moved `core.excludesFile`.
 */
export async function ignoreRulesMoved(
  root: string,
  at: number,
  record: IgnoreRecord,
  key: string,
  excludes: () => Promise<string>,
): Promise<boolean> {
  if (record.excludes === null) return true;
  const slash = key.lastIndexOf('/');
  const dirs = ancestorDirs(slash < 0 ? '' : key.slice(0, slash));
  const recorded = dirs.map((dir) => record.dirs.get(dir));
  if (recorded.some((state) => state === undefined || state === UNSTABLE)) return true;
  const [now, global] = await Promise.all([
    Promise.all(dirs.map((dir) => ignoreFileState(root, dir, at))),
    excludes(),
  ]);
  return (
    excludesUnstable(record.excludes) ||
    excludesUnstable(global) ||
    global !== record.excludes ||
    now.some((state, i) => state !== recorded[i])
  );
}
