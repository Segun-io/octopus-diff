/**
 * The bridge's path check (docs/DESKTOP.md §3.4): the main process never trusts a path from the
 * renderer. A file is named by `worktreeId` + a repo-relative path; the worktree comes from the
 * daemon's `GET /api/projects` (never from the renderer), the relative path is split into plain
 * segments and joined under the worktree's realpath, the result is `realpath`ed (so symlinks are
 * followed to where they really point) and refused unless it is still inside the worktree.
 *
 * Pure apart from the injected `fs` (realpath + stat), so tests run it on Linux for every platform.
 * No git involved.
 */
import path from 'node:path';
import type { DesktopRefusal } from '@octopus-diff/contracts';

export interface WorktreeRecord {
  id: string;
  /** The worktree root as the daemon reports it (a realpath when it was listed). */
  path: string;
  missing: boolean;
  bare: boolean;
}

export interface StatLike {
  isDirectory(): boolean;
  isFile(): boolean;
  mode: number;
}

export interface TargetFs {
  realpath(p: string): Promise<string>;
  stat(p: string): Promise<StatLike>;
}

export interface ResolvedTarget {
  /** The realpath of the target, inside `root`. */
  path: string;
  /** The realpath of the worktree root. */
  root: string;
  kind: 'file' | 'directory' | 'other';
  mode: number;
}

export interface Refusal {
  ok: false;
  reason: DesktopRefusal;
  message: string;
}

export type TargetResult = ({ ok: true } & ResolvedTarget) | Refusal;

export function refuse(reason: DesktopRefusal, message: string): Refusal {
  return { ok: false, reason, message };
}

export function pathApi(platform: NodeJS.Platform): typeof path.posix {
  return platform === 'win32' ? path.win32 : path.posix;
}

/**
 * The plain segments of a repo-relative path (`undefined` = the worktree root), or null when any
 * segment could leave or redirect the join: empty, `.`, `..`, NUL, a leading `/`; on Windows also
 * `\`, `:` (drives, alternate data streams) and names Windows trims to `.`/`..`/nothing (trailing
 * dots and spaces).
 */
export function relPathSegments(
  relPath: string | undefined,
  platform: NodeJS.Platform,
): string[] | null {
  if (relPath === undefined) return [];
  if (relPath.length === 0 || relPath.length > 4096) return null;
  const segments = relPath.split('/');
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null;
    if (segment.includes('\u0000')) return null;
    if (platform === 'win32') {
      if (/[\\:]/.test(segment)) return null;
      const trimmed = segment.replace(/[. ]+$/, '');
      if (trimmed === '' || trimmed === '.' || trimmed === '..') return null;
    }
  }
  return segments;
}

/** True when `target` is `root` or below it (whole segments: `/x/repo2` is not inside `/x/repo`). */
export function isInside(root: string, target: string, platform: NodeJS.Platform): boolean {
  const p = pathApi(platform);
  const rel = p.relative(root, target);
  if (rel === '') return true;
  if (p.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${p.sep}`);
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

export async function resolveWorktreeTarget(input: {
  worktreeId: string;
  relPath: string | undefined;
  /** From the daemon; null when it could not be asked. */
  worktrees: readonly WorktreeRecord[] | null;
  platform: NodeJS.Platform;
  fs: TargetFs;
}): Promise<TargetResult> {
  const { platform, fs } = input;
  const segments = relPathSegments(input.relPath, platform);
  if (segments === null) return refuse('invalid', 'Not a path inside the worktree.');
  if (input.worktrees === null) return refuse('not-ready', 'The daemon is not ready.');
  const worktree = input.worktrees.find((w) => w.id === input.worktreeId);
  if (!worktree) return refuse('unknown-worktree', 'The daemon does not list this worktree.');
  if (worktree.missing) return refuse('missing-worktree', 'The worktree is gone from disk.');
  const p = pathApi(platform);
  let root: string;
  try {
    root = await fs.realpath(worktree.path);
  } catch {
    return refuse('missing-worktree', 'The worktree is gone from disk.');
  }
  const joined = segments.length === 0 ? root : p.join(root, ...segments);
  // The lexical join must already be inside (segments are plain names; this is the backstop).
  if (!isInside(root, joined, platform)) {
    return refuse('outside-worktree', 'The path is outside its worktree.');
  }
  let real: string;
  try {
    real = await fs.realpath(joined);
  } catch (error) {
    const code = errorCode(error);
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? refuse('not-found', 'The file does not exist (any more).')
      : refuse('failed', 'The file cannot be read.');
  }
  if (!isInside(root, real, platform)) {
    return refuse('outside-worktree', 'The path leads outside its worktree (a symlink).');
  }
  let stats: StatLike;
  try {
    stats = await fs.stat(real);
  } catch {
    return refuse('not-found', 'The file does not exist (any more).');
  }
  const kind = stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other';
  return { ok: true, path: real, root, kind, mode: stats.mode };
}
