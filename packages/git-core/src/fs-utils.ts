import { constants } from 'node:fs';
import { type FileHandle, lstat, open, realpath, stat } from 'node:fs/promises';

export async function realpathOrSelf(value: string): Promise<string> {
  try {
    return await realpath(value);
  } catch {
    return value;
  }
}

export async function exists(value: string | Buffer): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Opens a regular file for reading, or returns null. `O_NONBLOCK` keeps a FIFO from blocking
 * the open forever (fs reads have no timeout), and the handle is checked to be a regular file.
 * With `noFollow`, a symlink in the final component is refused (`O_NOFOLLOW`), so a file
 * swapped for a link after it was lstat'ed cannot redirect the read. POSIX flags only where
 * the platform has them.
 */
export async function openRegularFile(
  file: string | Buffer,
  options: { noFollow?: boolean } = {},
): Promise<FileHandle | null> {
  const flags =
    constants.O_RDONLY |
    (constants.O_NONBLOCK ?? 0) |
    (options.noFollow ? (constants.O_NOFOLLOW ?? 0) : 0);
  let handle: FileHandle;
  try {
    handle = await open(file, flags);
  } catch {
    return null;
  }
  try {
    if ((await handle.stat()).isFile()) return handle;
  } catch {
    // fall through
  }
  await handle.close().catch(() => {});
  return null;
}

/** Reads at most `max` bytes from the start of a regular file; null if it cannot be read. */
export async function readFileHead(file: string | Buffer, max: number): Promise<Buffer | null> {
  const handle = await openRegularFile(file);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(max);
    const { bytesRead } = await handle.read(buffer, 0, max, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Small LRU map. */
export class LruCache<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
  }

  clear(): void {
    this.map.clear();
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  /** Drops every entry `drop` says so for. */
  deleteWhere(drop: (key: K, value: V) => boolean): void {
    for (const [key, value] of [...this.map]) if (drop(key, value)) this.map.delete(key);
  }
}
