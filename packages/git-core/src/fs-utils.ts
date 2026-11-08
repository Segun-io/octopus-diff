import { lstat, realpath, stat } from 'node:fs/promises';

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
}
