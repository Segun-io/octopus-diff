import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
 * Cheap file-system identity checks for watched directories (review F1). Worktree ids are
 * hashes of the path, so a worktree removed and re-added at the same path keeps its id; these
 * tell the daemon that the directory (and possibly its git dir) behind that id was replaced.
 * Plain `stat`/`read` calls only: no git process, nothing written.
 */

/** `dev:ino` of a directory, or null if it does not exist or is not a directory. */
export async function dirIdentity(dir: string): Promise<string | null> {
  try {
    const info = await stat(dir);
    return info.isDirectory() ? `${info.dev}:${info.ino}` : null;
  } catch {
    return null;
  }
}

/**
 * Reads a small regular file from a repository (`.git` files, `.gitignore`, `info/exclude`).
 * Null if it is missing, not a regular file (symlinks are not followed, FIFOs and devices are
 * refused) or larger than `maxBytes`. Repository content is untrusted.
 */
export async function readSmallRegularFile(file: string, maxBytes: number): Promise<string | null> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.size > maxBytes) return null;
    // O_NOFOLLOW / O_NONBLOCK: the entry may be swapped for a symlink or a FIFO after lstat.
    const handle = await open(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > maxBytes) return null;
      const buffer = Buffer.alloc(Math.max(1, opened.size));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** A `.git` file is one short line (`gitdir: <path>`); anything bigger is not one. */
const MAX_GIT_FILE_BYTES = 4096;

/**
 * The git dir that a worktree's `.git` entry points to, as a realpath: `<root>/.git` itself
 * when it is a directory, the target of `gitdir: <path>` when it is a file (linked worktrees,
 * submodules). Null when it can't be determined (missing, unreadable, unexpected content); the
 * caller then keeps what git-core reported.
 */
export async function gitDirOf(root: string): Promise<string | null> {
  const dotGit = path.join(root, '.git');
  try {
    if ((await lstat(dotGit)).isDirectory()) return await realpath(dotGit);
  } catch {
    return null;
  }
  const text = await readSmallRegularFile(dotGit, MAX_GIT_FILE_BYTES);
  const first = text?.split('\n', 1)[0]?.replace(/\r$/, '') ?? '';
  if (!first.startsWith('gitdir: ')) return null;
  const target = path.resolve(root, first.slice('gitdir: '.length).trim());
  try {
    return await realpath(target);
  } catch {
    return target;
  }
}
