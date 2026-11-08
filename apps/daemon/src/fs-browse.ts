import type { Dirent } from 'node:fs';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  DIRS_ENTRIES_MAX,
  type DirEntry,
  type DirKind,
  type DirsResponse,
} from '@octopus-diff/contracts';
import { ApiError } from './errors.js';
import { resolveInputPath } from './paths.js';

/** How many `.git` probes run at once (a home directory can hold hundreds of folders). */
const PROBE_CONCURRENCY = 32;

export interface ListDirsOptions {
  home?: string;
  cwd?: string;
  maxEntries?: number;
}

async function isKind(p: string, kind: 'file' | 'dir'): Promise<boolean> {
  try {
    const info = await lstat(p);
    return kind === 'file' ? info.isFile() : info.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Classifies a directory by its entries only: never runs git, never reads repo config. A `.git`
 * directory or a bare layout (`HEAD`, `objects/`, `refs/`) is a repo; a `.git` file is a gitfile.
 */
export async function dirKind(dir: string): Promise<DirKind> {
  try {
    const info = await lstat(path.join(dir, '.git'));
    if (info.isDirectory()) return 'repo';
    if (info.isFile()) return 'gitfile';
  } catch {
    // No `.git`: maybe a bare repository.
  }
  if (!(await isKind(path.join(dir, 'HEAD'), 'file'))) return 'dir';
  const [objects, refs] = await Promise.all([
    isKind(path.join(dir, 'objects'), 'dir'),
    isKind(path.join(dir, 'refs'), 'dir'),
  ]);
  return objects && refs ? 'repo' : 'dir';
}

function fsError(error: unknown, shown: string): ApiError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOENT':
      return new ApiError('not_found', `no such folder: ${shown}`, { cause: error });
    case 'ENOTDIR':
      return new ApiError('bad_request', `not a folder: ${shown}`, { cause: error });
    case 'EACCES':
    case 'EPERM':
      return new ApiError('forbidden', `permission denied: ${shown}`, { cause: error });
    default:
      return new ApiError('internal', `cannot read ${shown}`, { cause: error });
  }
}

/** True for directories and for symlinks that point at a directory. */
async function isDirEntry(dir: string, entry: Dirent): Promise<boolean> {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return (await stat(path.join(dir, entry.name))).isDirectory();
  } catch {
    return false; // dangling link
  }
}

async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/**
 * Lists the subdirectories of `input` (default: home) for the web folder picker. Read-only:
 * `readdir` plus one `lstat` of `<child>/.git` per child; returns names, never file contents.
 */
export async function listDirs(
  input: string | undefined,
  options: ListDirsOptions = {},
): Promise<DirsResponse> {
  const home = options.home ?? os.homedir();
  const cwd = options.cwd ?? process.cwd();
  const max = options.maxEntries ?? DIRS_ENTRIES_MAX;
  const requested = input === undefined ? home : resolveInputPath(input, cwd, home);

  let dir: string;
  let raw: Dirent[];
  try {
    dir = await realpath(requested);
    raw = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    throw fsError(error, input ?? requested);
  }

  const candidates = raw.filter((entry) => entry.name !== '.git');
  const flags = await mapLimited(candidates, PROBE_CONCURRENCY, (entry) => isDirEntry(dir, entry));
  const dirs = candidates
    .filter((_, i) => flags[i])
    .sort((a, b) => collator.compare(a.name, b.name));
  const kept = dirs.slice(0, max);
  const entries = await mapLimited(kept, PROBE_CONCURRENCY, async (entry): Promise<DirEntry> => {
    const full = path.join(dir, entry.name);
    return {
      name: entry.name,
      path: full,
      kind: await dirKind(full),
      hidden: entry.name.startsWith('.'),
      symlink: entry.isSymbolicLink(),
    };
  });

  const parent = path.dirname(dir);
  const root = path.parse(dir).root;
  const places: DirsResponse['places'] = [{ label: 'Home', path: home }];
  if (cwd !== home && cwd !== root) places.push({ label: 'Daemon folder', path: cwd });
  places.push({ label: 'Root', path: root });

  return {
    path: dir,
    parent: parent === dir ? null : parent,
    kind: await dirKind(dir),
    sep: path.sep === '\\' ? '\\' : '/',
    home,
    entries,
    truncated: dirs.length > kept.length,
    places,
  };
}
