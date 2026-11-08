import { realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isSameOrInside } from './paths.js';

/**
 * Limits on what one project can make the daemon watch recursively (review SEC-07). Worktree
 * records come from `git worktree list`, i.e. from files inside the repository, so a hostile or
 * broken repository can point them anywhere (`/`, `$HOME`, hundreds of directories) and exhaust
 * the user's inotify watches, which are shared with their IDE and every other watcher.
 */

/** Natively watched (recursive) worktrees per project; the others are polled at the idle rate. */
export const MAX_WATCHED_WORKTREES_PER_PROJECT = 64;

export type WatchRefusal = 'filesystem-root' | 'home' | 'system-dir' | 'contains-git-dir';

// Top-level system directories (Linux, macOS). Only exact matches are refused: repositories
// *inside* them (e.g. /opt/app, /srv/site) are watched normally.
const SYSTEM_DIRS = new Set([
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/home',
  '/lib',
  '/lib32',
  '/lib64',
  '/libx32',
  '/media',
  '/mnt',
  '/opt',
  '/proc',
  '/root',
  '/run',
  '/sbin',
  '/snap',
  '/srv',
  '/sys',
  '/tmp',
  '/usr',
  '/var',
  '/Applications',
  '/Library',
  '/System',
  '/Users',
  '/Volumes',
  '/private',
]);

function realOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The user's home directory and the OS temp dir (realpaths), computed once per service. */
export interface GuardDirs {
  home: string | null;
  tmp: string | null;
}

export function defaultGuardDirs(): GuardDirs {
  const home = os.homedir();
  return { home: home ? realOrSelf(home) : null, tmp: realOrSelf(os.tmpdir()) };
}

/** Directories that must never be watched recursively, whatever the repository says. */
export function dirRefusal(dir: string, dirs: GuardDirs): WatchRefusal | null {
  const resolved = path.resolve(dir);
  if (resolved === path.parse(resolved).root) return 'filesystem-root';
  // Home itself or one of its ancestors (/home, /Users): every project of the user lives there.
  if (dirs.home && isSameOrInside(resolved, dirs.home)) return 'home';
  if (SYSTEM_DIRS.has(resolved) || resolved === dirs.tmp) return 'system-dir';
  // A Windows drive root mounted in WSL (/mnt/c).
  if (/^\/mnt\/[a-z]$/i.test(resolved)) return 'system-dir';
  return null;
}

/**
 * Why a worktree root must not be watched recursively, or null. Besides `dirRefusal`, a root
 * that contains its own repository's git dir is refused unless it is the main worktree sitting
 * right next to it (`<root>/.git`): a linked worktree can't legitimately contain the
 * repository it belongs to, so such a record is forged or broken.
 */
export function worktreeRootRefusal(
  root: string,
  context: { commonDir: string; isMain: boolean },
  dirs: GuardDirs,
): WatchRefusal | null {
  const refusal = dirRefusal(root, dirs);
  if (refusal) return refusal;
  const resolved = path.resolve(root);
  const commonDir = path.resolve(context.commonDir);
  if (
    isSameOrInside(resolved, commonDir) &&
    !(context.isMain && resolved === path.dirname(commonDir))
  ) {
    return 'contains-git-dir';
  }
  return null;
}
