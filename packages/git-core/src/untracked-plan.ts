import {
  UNTRACKED_OMITTED_DIRS_MAX,
  type UntrackedOmission,
  type UntrackedOmittedDirectory,
} from '@octopus-diff/contracts';
import { compareBstr, decodeRepoPath } from './bstr.js';
import { hashParts } from './hash.js';

/**
 * Which untracked files a worktree with more than `maxListedUntracked` of them leaves out (#43).
 *
 * Inspecting an untracked file costs an lstat (and, under `maxUntrackedFiles`, a read): about a
 * second per refresh for 30k files, which are almost always dependencies or build output that
 * belong in a `.gitignore`. Above the cap the summary and the file lists still count every one of
 * them (git status lists them), but inspect and list at most `limit`.
 *
 * The plan is a pure function of the set of untracked paths git status reports and the limit, so
 * a full and an incremental refresh of the same state omit the same files, and so do the summary
 * and every list built from the same status:
 *
 * 0. Directories with a well-known dependency, cache or build-output name (`node_modules`, `dist`,
 *    `__pycache__`, ...; the outermost one of a path), biggest first, while more than `limit`
 *    remain (PR #91 P2-2: size alone could hide a big new source tree and list the build output).
 * 1. While more than `limit` remain: from the root, step into the biggest child directory as long
 *    as that child alone holds at least the excess (remaining - limit); omit the deepest one
 *    reached. If no top-level directory holds the excess, omit the biggest top-level directory
 *    when it holds at least a tenth of the excess, and repeat. Ties go to the smaller path. At most
 *    `MAX_OMITTED_DIRS` directories.
 * 2. If still more than `limit` remain (loose files, many small directories): keep the first
 *    `limit` of them in path order and omit the rest (`after`).
 *
 * A nested repository (git prints `dir/`) is one entry, like a file.
 */

/**
 * Dependency and cache directories that are never source: suggested as `<name>/` (any depth).
 * Build-output names (`dist`, ...) are suggested anchored at that component instead.
 */
const ANY_DEPTH = new Set([
  'node_modules',
  'bower_components',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.venv',
  '.tox',
  '.gradle',
  '.turbo',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.parcel-cache',
  '.cache',
]);
const OUTPUT = new Set(['dist', 'build', 'out', 'target', 'coverage']);

/** A path component is a well-known dependency, cache or build-output directory name. */
function generatedName(part: string): boolean {
  return ANY_DEPTH.has(part) || OUTPUT.has(part);
}

/** The directory (bstr or UTF-8, `/`-separated) or one of its ancestors has a generated name. */
export function isGenerated(dir: string): boolean {
  return dir.split('/').some(generatedName);
}

/** Most directories a plan omits before it cuts in path order. */
export const MAX_OMITTED_DIRS = 64;

export interface UntrackedPlan {
  /** Equal ids omit the same files of the same set of paths (dirs, cut, limit). */
  id: string;
  limit: number;
  /** Untracked status entries omitted (counted, not inspected, not listed). */
  omitted: number;
  /** Omitted directories (bstr, no trailing `/`) with the entries below them. */
  dirs: Map<string, number>;
  /** Raw keys after this one (`compareBstr`) are omitted too; null when nothing was cut. */
  after: string | null;
}

function stripSlash(raw: string): string {
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/** The plan for these raw untracked keys (any order), or null when at most `limit` exist. */
export function planUntracked(rawKeys: readonly string[], limit: number): UntrackedPlan | null {
  if (rawKeys.length <= limit) return null;
  // Entries below each directory, and each directory's child directories.
  const counts = new Map<string, number>();
  const children = new Map<string, string[]>();
  for (const raw of rawKeys) {
    const key = stripSlash(raw);
    let parent = '';
    for (let slash = key.indexOf('/'); slash >= 0; slash = key.indexOf('/', slash + 1)) {
      const dir = key.slice(0, slash);
      const seen = counts.get(dir);
      if (seen === undefined) {
        counts.set(dir, 1);
        const list = children.get(parent);
        if (list) list.push(dir);
        else children.set(parent, [dir]);
      } else counts.set(dir, seen + 1);
      parent = dir;
    }
  }
  const dirs = new Map<string, number>();
  let remaining = rawKeys.length;
  /** Removes an omitted directory's entries from its ancestors' counts. */
  const omit = (dir: string): void => {
    const n = counts.get(dir) ?? 0;
    // Directories omitted earlier below this one are now part of it.
    let below = n;
    for (const [inner, count] of dirs) {
      if (inner.startsWith(`${dir}/`)) {
        below += count;
        dirs.delete(inner);
      }
    }
    dirs.set(dir, below);
    remaining -= n;
    counts.set(dir, 0);
    for (let slash = dir.lastIndexOf('/'); slash > 0; slash = dir.lastIndexOf('/', slash - 1)) {
      const up = dir.slice(0, slash);
      counts.set(up, (counts.get(up) ?? 0) - n);
    }
  };
  const biggestChild = (dir: string): string | null => {
    let best: string | null = null;
    let bestCount = 0;
    for (const child of children.get(dir) ?? []) {
      const n = counts.get(child) ?? 0;
      if (n > bestCount || (n > 0 && n === bestCount && best !== null && child < best)) {
        best = child;
        bestCount = n;
      }
    }
    return best;
  };
  // 0. Generated directories first, the outermost of each path, biggest first.
  const generated = [...counts]
    .filter(([dir]) => {
      const parts = dir.split('/');
      return (
        generatedName(parts[parts.length - 1] as string) && !parts.slice(0, -1).some(generatedName)
      );
    })
    .sort((a, b) => b[1] - a[1] || compareBstr(a[0], b[0]));
  for (const [dir] of generated) {
    if (remaining <= limit || dirs.size >= MAX_OMITTED_DIRS) break;
    omit(dir);
  }
  while (remaining > limit && dirs.size < MAX_OMITTED_DIRS) {
    const excess = remaining - limit;
    const top = biggestChild('');
    if (top === null) break;
    if ((counts.get(top) ?? 0) < excess) {
      // No directory holds the excess alone: the biggest top-level one, if it is a real part of it.
      if ((counts.get(top) ?? 0) * 10 < excess) break;
      omit(top);
      continue;
    }
    let node = top;
    for (;;) {
      const next = biggestChild(node);
      if (next === null || (counts.get(next) ?? 0) < excess) break;
      node = next;
    }
    omit(node);
  }
  let after: string | null = null;
  let omitted = rawKeys.length - remaining;
  if (remaining > limit) {
    const rest = rawKeys.filter((raw) => !underDirs(dirs, stripSlash(raw)));
    rest.sort(compareBstr);
    after = rest[limit - 1] as string;
    omitted += rest.length - limit;
  }
  const sortedDirs = [...dirs.keys()].sort(compareBstr);
  const id = hashParts(['untracked-plan-v2', limit, sortedDirs.join('\u0000'), after], 16);
  return { id, limit, omitted, dirs, after };
}

function underDirs(dirs: ReadonlyMap<string, number>, key: string): boolean {
  if (dirs.size === 0) return false;
  for (let slash = key.indexOf('/'); slash >= 0; slash = key.indexOf('/', slash + 1)) {
    if (dirs.has(key.slice(0, slash))) return true;
  }
  return false;
}

/** The raw untracked key (a nested repository may end in `/`) is omitted by the plan. */
export function isOmitted(plan: UntrackedPlan | null, raw: string): boolean {
  if (plan === null) return false;
  if (underDirs(plan.dirs, stripSlash(raw))) return true;
  return plan.after !== null && compareBstr(raw, plan.after) > 0;
}

/** The raw keys a plan lists (inspects), in their order. */
export function listedKeys(plan: UntrackedPlan | null, raw: readonly string[]): string[] {
  if (plan === null) return [...raw];
  return raw.filter((key) => !isOmitted(plan, key));
}

/**
 * Characters that make a name unsafe to offer as a line to copy (PR #91 P2-4, SEC-05): controls,
 * bidi controls, zero-width and every other format character (`Cf`), line and paragraph
 * separators. Escaping them for display would break the pattern; such a name gets no line.
 */
const UNSAFE_IN_LINE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/u;

/** gitignore escaping of a pattern's literal text. */
function escapeIgnore(text: string): string {
  return text.replace(/[\\*?[]/g, '\\$&');
}

/**
 * What a broader line would also cover (PR #91 P2-3): the listed untracked files and the tracked
 * paths' directories (UTF-8, `/`-separated). Without it, every line is the exact directory.
 */
export interface IgnoreContext {
  /** Listed untracked files (keys without a trailing `/`). */
  listed: readonly string[];
  /** Every directory that holds a tracked file, and every directory name among them. */
  trackedDirs: ReadonlySet<string>;
  trackedNames: ReadonlySet<string>;
}

/**
 * A `.gitignore` line ignoring an omitted directory: `/<path>/` (exact, anchored at the worktree
 * root), broadened to `<name>/` at a dependency or cache component or to `/<path to a build-output
 * component>/` only when that broader pattern covers no listed untracked file and no tracked file
 * (`ctx`). Null for a name with unsafe characters.
 */
export function ignoreLineFor(path: string, ctx: IgnoreContext | null = null): string | null {
  if (UNSAFE_IN_LINE.test(path)) return null;
  const exact = `/${escapeIgnore(path)}/`;
  if (ctx === null) return exact;
  const parts = path.split('/');
  for (const [i, part] of parts.entries()) {
    if (ANY_DEPTH.has(part)) {
      const covered =
        ctx.trackedNames.has(part) ||
        ctx.listed.some((key) => key.split('/').slice(0, -1).includes(part));
      return covered ? exact : `${escapeIgnore(part)}/`;
    }
    if (OUTPUT.has(part)) {
      const prefix = parts.slice(0, i + 1).join('/');
      const covered =
        ctx.trackedDirs.has(prefix) || ctx.listed.some((key) => key.startsWith(`${prefix}/`));
      return covered ? exact : `/${escapeIgnore(prefix)}/`;
    }
  }
  return exact;
}

/** Would a line for one of the plan's reported directories be broader than the directory? */
export function wantsIgnoreContext(plan: UntrackedPlan): boolean {
  for (const dir of reported(plan).map(([key]) => key)) {
    const parts = dir.split('/');
    if (
      parts.some((part, i) => ANY_DEPTH.has(part) || (OUTPUT.has(part) && i < parts.length - 1))
    ) {
      return true;
    }
  }
  return false;
}

/** The directories the contract reports: the biggest, at most `UNTRACKED_OMITTED_DIRS_MAX`. */
function reported(plan: UntrackedPlan): Array<[string, number]> {
  return [...plan.dirs]
    .sort((a, b) => b[1] - a[1] || compareBstr(a[0], b[0]))
    .slice(0, UNTRACKED_OMITTED_DIRS_MAX);
}

/**
 * The contract's description of a plan (the biggest directories, with ignore lines). `count`:
 * the omitted files as the summary counts them (a path that is also a tracked change counts as
 * that), default the plan's. `ctx`: what broader lines would cover (see `ignoreLineFor`).
 */
export function omissionOf(
  plan: UntrackedPlan,
  count = plan.omitted,
  ctx: IgnoreContext | null = null,
): UntrackedOmission {
  const directories = reported(plan).map(([key, count]): UntrackedOmittedDirectory => {
    const decoded = decodeRepoPath(key);
    const generated = isGenerated(decoded.path);
    return decoded.rawPath === undefined
      ? { path: decoded.path, count, ignoreLine: ignoreLineFor(decoded.path, ctx), generated }
      : { path: decoded.path, rawPath: decoded.rawPath, count, ignoreLine: null, generated };
  });
  return { count, limit: plan.limit, directories };
}
