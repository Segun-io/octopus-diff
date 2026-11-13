/**
 * The file explorer's listing, security review of PR #99: partial clones (P2-1: blob sizes in a
 * blobless clone, also when git has no `GIT_NO_LAZY_FETCH`; P3-6: a treeless clone's missing
 * trees), the per-child file count of one `ls-tree -r` and its failure memo (P3-3), and listings
 * resolved without entries (P3-4).
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { GIT_OBJECT_MISSING, type GitCore, isGitCoreError } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCore, treeCacheOf } from '../src/index.js';
import { childCount, compactChildren, TreeCache } from '../src/tree.js';
import { locator } from './helpers/core.js';
import { createFixture, type Fixture } from './helpers/fixture.js';

let fx: Fixture;
let source: string;
let blobless: string;
let treeless: string;

/** A git wrapper logging one line per spawn (one printf of a built string), optionally faking. */
function wrapper(name: string, body: string): { bin: string; spawns: () => string[] } {
  const log = path.join(fx.root, `${name}.log`);
  writeFileSync(log, '');
  const bin = path.join(fx.root, `${name}.sh`);
  writeFileSync(
    bin,
    `#!/bin/sh\nline="$*"\nprintf '%s\\n' "$line" >> '${log}'\n${body}\nexec git "$@"\n`,
  );
  chmodSync(bin, 0o755);
  return { bin, spawns: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
}

const cores: GitCore[] = [];
function core(gitBinary?: string, extra: Parameters<typeof createGitCore>[0] = {}): GitCore {
  const c = createGitCore(fx.coreOptions({ ...extra, ...(gitBinary ? { gitBinary } : {}) }));
  cores.push(c);
  return c;
}

beforeAll(() => {
  fx = createFixture();
  source = fx.repo('source', {
    files: { 'top.txt': 'top\n', 'd/a.txt': 'a\n', 'd/b.txt': 'bb\n', 'e/f/g.txt': 'g\n' },
  });
  fx.git(source, ['config', 'uploadpack.allowFilter', 'true']);
  fx.git(source, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  blobless = path.join(fx.root, 'blobless');
  treeless = path.join(fx.root, 'treeless');
  fx.git(fx.root, [
    'clone',
    '-q',
    '--no-checkout',
    '--filter=blob:none',
    `file://${source}`,
    blobless,
  ]);
  fx.git(fx.root, [
    'clone',
    '-q',
    '--no-checkout',
    '--filter=tree:0',
    `file://${source}`,
    treeless,
  ]);
});

afterAll(async () => {
  for (const c of cores) await c.dispose();
  fx?.dispose();
});

const at = (dir: string) => locator(dir, path.join(dir, '.git'));

describe('a blobless partial clone (P2-1)', () => {
  it('lists with null sizes for the blobs it lacks, and never fetches', async () => {
    const w = wrapper('plain', '');
    const listing = await core(w.bin).listTree?.(at(blobless), { ref: 'HEAD', path: '' });
    expect(listing?.entries.map((e) => [e.name, e.kind, e.size])).toEqual([
      ['d', 'dir', null],
      ['e', 'dir', null],
      ['top.txt', 'file', null],
    ]);
    expect(w.spawns().some((l) => / fetch( |$)/.test(l))).toBe(false);
  });

  it('without GIT_NO_LAZY_FETCH (git before 2.44): falls back to a listing without sizes, then stays there', async () => {
    const w = wrapper('oldgit', 'unset GIT_NO_LAZY_FETCH');
    const c = core(w.bin);
    const root = await c.listTree?.(at(blobless), { ref: 'HEAD', path: '' });
    expect(root?.entries.map((e) => [e.name, e.size])).toEqual([
      ['d', null],
      ['e', null],
      ['top.txt', null],
    ]);
    const d = await c.listTree?.(at(blobless), { ref: 'HEAD', path: 'd' });
    expect(d?.entries.map((e) => [e.name, e.size])).toEqual([
      ['a.txt', null],
      ['b.txt', null],
    ]);
    const lsTrees = w.spawns().filter((l) => / ls-tree /.test(l));
    // The root: `-l` failed (the blocked lazy fetch), then without; `d`: without at once.
    expect(lsTrees.map((l) => l.includes(' -l '))).toEqual([true, false, false]);
  });

  it('a git below 2.44 in a partial clone never asks for sizes', async () => {
    const w = wrapper(
      'git240',
      'for a in "$@"; do [ "$a" = "--version" ] && { echo "git version 2.40.0"; exit 0; }; done\nunset GIT_NO_LAZY_FETCH',
    );
    const c = core(w.bin);
    const root = await c.listTree?.(at(blobless), { ref: 'HEAD', path: 'e' });
    expect(root?.entries.map((e) => e.name)).toEqual(['f']);
    const lsTrees = w.spawns().filter((l) => / ls-tree /.test(l));
    expect(lsTrees.length).toBeGreaterThan(0);
    expect(lsTrees.some((l) => l.includes(' -l '))).toBe(false);
    // A full clone with the same old git still gets sizes.
    const full = await c.listTree?.(at(source), { ref: 'HEAD', path: 'd' });
    expect(full?.entries.map((e) => e.size)).toEqual([2, 3]);
  });
});

describe('a treeless partial clone (P3-6)', () => {
  it('says the tree is missing locally, with a stable reason, and fetches nothing', async () => {
    const w = wrapper('treeless', '');
    const c = core(w.bin);
    const error = await c
      .listTree?.(at(treeless), { ref: 'HEAD', path: '' })
      .catch((e: unknown) => e);
    expect(isGitCoreError(error, 'not_found')).toBe(true);
    expect((error as { details: { reason?: string } }).details.reason).toBe(GIT_OBJECT_MISSING);
    expect((error as Error).message).toMatch(/does not have .* locally \(a partial clone\?\)/);
    expect(w.spawns().some((l) => / fetch( |$)/.test(l))).toBe(false);
  });
});

describe('countTreeChildren and the failure memo (P3-3)', () => {
  it('counts the files below every child directory with one ls-tree -r', async () => {
    const w = wrapper('children', '');
    const c = core(w.bin);
    const tree = fx.git(source, ['rev-parse', 'HEAD^{tree}']).trim();
    const before = w.spawns().length;
    const counts = await c.countTreeChildren?.(at(source), { tree });
    expect(counts?.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      { name: 'd', count: 2 },
      { name: 'e', count: 1 },
    ]);
    // Memoized, and the total is known too.
    expect(await c.countTreeChildren?.(at(source), { tree })).toEqual(counts);
    expect(await c.countTreeFiles?.(at(source), { tree })).toBe(4);
    expect(
      w
        .spawns()
        .slice(before)
        .filter((l) => / ls-tree /.test(l)),
    ).toHaveLength(1);
  });

  it('remembers a failure: an output above the cap is not retried', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 300; i++) files[`many/sub${i % 10}/file-${i}.txt`] = `${i}\n`;
    const big = fx.repo('big', { files });
    const w = wrapper('capped', '');
    const c = core(w.bin, { maxOutputBytes: 4096 });
    const tree = fx.git(big, ['rev-parse', 'HEAD^{tree}']).trim();
    const first = await c.countTreeChildren?.(at(big), { tree }).catch((e: unknown) => e);
    expect(isGitCoreError(first, 'output_too_large'), String(first)).toBe(true);
    expect(w.spawns().filter((l) => / ls-tree -r /.test(l))).toHaveLength(1);
    const before = w.spawns().length;
    const again = await c.countTreeFiles?.(at(big), { tree }).catch((e: unknown) => e);
    expect(isGitCoreError(again, 'output_too_large')).toBe(true);
    await c.countTreeChildren?.(at(big), { tree }).catch(() => undefined);
    expect(w.spawns().slice(before)).toEqual([]);
  });

  it('remembers a missing tree (a treeless clone)', async () => {
    const w = wrapper('missing', '');
    const c = core(w.bin);
    const tree = fx.git(source, ['rev-parse', 'HEAD^{tree}']).trim();
    const first = await c.countTreeChildren?.(at(treeless), { tree }).catch((e: unknown) => e);
    expect(isGitCoreError(first, 'not_found')).toBe(true);
    const before = w.spawns().length;
    await c.countTreeChildren?.(at(treeless), { tree }).catch(() => undefined);
    expect(w.spawns().slice(before)).toEqual([]);
  });
});

describe('listTree withEntries: false (P3-4)', () => {
  it('resolves commit, tree and kind without entries', async () => {
    const c = core();
    const full = await c.listTree?.(at(source), { ref: 'HEAD', path: 'd' });
    const bare = await c.listTree?.(at(source), { ref: 'HEAD', path: 'd', withEntries: false });
    expect(bare).toEqual({ commit: full?.commit, tree: full?.tree, kind: 'dir', entries: [] });
    expect(full?.entries).toHaveLength(2);
    const file = await c.listTree?.(at(source), {
      ref: 'HEAD',
      path: 'top.txt',
      withEntries: false,
    });
    expect(file).toMatchObject({ kind: 'file', tree: null });
  });
});

describe('child counts stay within the byte budget (Greptile, PR #99 round 3)', () => {
  const wide = (n: number, salt: string) => {
    const counts = new Map<string, number>();
    for (let i = 0; i < n; i++) counts.set(`dir-${salt}-${i}`, (i % 7) + 1);
    return counts;
  };

  it('compact: no object per child, about the bytes of its names', () => {
    const compact = compactChildren(wide(100_000, 'a'));
    expect(compact.counts).toBeInstanceOf(Uint32Array);
    expect(compact.counts.length).toBe(100_000);
    expect(childCount(compact, 'dir-a-41')).toBe((41 % 7) + 1);
    expect(childCount(compact, 'dir-a-100000')).toBeUndefined();
    expect(childCount(compact, '')).toBeUndefined();
    // 2 bytes per name character, 8 per child for the two typed arrays.
    const cache = new TreeCache(64 * 1024 * 1024);
    cache.setChildren('k', compact);
    expect(cache.bytes).toBeLessThan(100_000 * (2 * 'dir-a-99999'.length + 2 + 8) + 1024);
  });

  it('many wide root trees: evicted by bytes, together with the listings', () => {
    const budget = 8 * 1024 * 1024;
    const cache = new TreeCache(budget);
    for (let r = 0; r < 20; r++) {
      cache.setChildren(`c${r}`, compactChildren(wide(100_000, String(r))));
      cache.set(`t${r}`, { entries: [], bytes: 100_000 });
      expect(cache.bytes).toBeLessThanOrEqual(budget);
    }
    // The newest are kept, the oldest went; listings share the budget.
    expect(cache.children('c19')).toBeDefined();
    expect(cache.get('t19')).toBeDefined();
    expect(cache.children('c0')).toBeUndefined();
    expect(cache.size).toBeLessThan(40);
    // One item above the budget is not kept, and evicts nothing for it.
    const held = cache.size;
    cache.setChildren('huge', compactChildren(wide(400_000, 'huge')));
    expect(cache.children('huge')).toBeUndefined();
    expect(cache.size).toBe(held);
    expect(cache.children('c19')).toBeDefined();
  });

  it('a real tree of 100k child directories: counted once, compactly, the asked names only', async () => {
    const dir = fx.repo('wide', { files: { 'top.txt': 't\n' } });
    const leaf = fx.git(dir, ['rev-parse', 'HEAD:top.txt']).trim();
    const sub = fx.git(dir, ['mktree'], { input: `100644 blob ${leaf}\tf\n` }).trim();
    const lines: string[] = [];
    for (let i = 0; i < 100_000; i++)
      lines.push(`040000 tree ${sub}\td${String(i).padStart(6, '0')}`);
    const root = fx.git(dir, ['mktree'], { input: `${lines.join('\n')}\n` }).trim();
    const c = core();
    await c.listCommits(at(dir), { limit: 1 });
    const cache = treeCacheOf(c);
    const before = cache?.bytes ?? 0;
    const asked = await c.countTreeChildren?.(at(dir), {
      tree: root,
      names: [{ name: 'd000007' }, { name: 'd099999' }, { name: 'nope' }],
    });
    expect(asked).toEqual([
      { name: 'd000007', count: 1 },
      { name: 'd099999', count: 1 },
    ]);
    const held = (cache?.bytes ?? 0) - before;
    // Accounted in the budget, and compact: well under the ~100 bytes an object per child cost.
    expect(held).toBeGreaterThan(100_000 * 8);
    expect(held).toBeLessThan(100_000 * 30);
    expect(cache?.bytes ?? 0).toBeLessThanOrEqual(cache?.maxBytes ?? 0);
    // Without names: every child directory, from the same memo.
    const all = await c.countTreeChildren?.(at(dir), { tree: root });
    expect(all).toHaveLength(100_000);
    expect(await c.countTreeFiles?.(at(dir), { tree: root })).toBe(100_000);
    await expect(
      c.countTreeChildren?.(at(dir), {
        tree: root,
        names: [{ name: 'x', rawName: 'not base64!' }],
      }),
    ).rejects.toMatchObject({ code: 'invalid_argument' });
  });
});
