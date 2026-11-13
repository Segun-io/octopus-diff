import { describe, expect, it } from 'vitest';
import {
  compareTreeNames,
  GitChangedFileSchema,
  pageTreeEntries,
  ROUTES,
  TREE_PAGE_DEFAULT,
  TREE_PAGE_MAX,
  type TreeEntry,
  TreeEntrySchema,
  TreeQuerySchema,
  TreeResponseSchema,
  treeDirIdentity,
  treeListingKey,
  WorktreeChangedEventSchema,
} from '../src/index.js';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function entry(name: string, extra: Partial<TreeEntry> = {}): TreeEntry {
  return {
    name,
    path: `dir/${name}`,
    kind: 'file',
    mode: '100644',
    oid: 'a'.repeat(40),
    size: 10,
    ...extra,
  };
}

describe('compareTreeNames (git tree order)', () => {
  it('compares a directory as name/', () => {
    // git: "a-b" (0x2d) < "a/" (0x2f) < "a0" (0x30); a file "a" sorts before "a-b".
    const names: Array<[string, boolean]> = [
      ['a0', false],
      ['a', true],
      ['a-b', false],
      ['a', false],
    ];
    names.sort((x, y) => compareTreeNames(x[0], x[1], y[0], y[1]));
    expect(names).toEqual([
      ['a', false],
      ['a-b', false],
      ['a', true],
      ['a0', false],
    ]);
  });

  it('compares bytes unsigned (latin1 byte strings)', () => {
    expect(compareTreeNames('ÿ', false, 'z', false)).toBeGreaterThan(0);
    expect(compareTreeNames('B', false, 'a', false)).toBeLessThan(0);
    expect(compareTreeNames('x', false, 'x', false)).toBe(0);
  });
});

describe('pageTreeEntries', () => {
  const entries = Array.from({ length: 237 }, (_, i) => entry(`f${String(i).padStart(4, '0')}`));
  const listKey = treeListingKey('state', entries);

  it('pages of any size add up to the listing exactly once (random sizes)', () => {
    const random = rng(9);
    for (let round = 0; round < 200; round++) {
      const seen: TreeEntry[] = [];
      let cursor: string | undefined;
      for (let guard = 0; guard < 1000; guard++) {
        const limit = 1 + Math.floor(random() * 60);
        const page = pageTreeEntries(entries, { limit, cursor }, { listKey });
        expect(page.restarted).toBe(false);
        expect(page.offset).toBe(seen.length);
        seen.push(...page.entries);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      expect(seen).toEqual(entries);
    }
  });

  it('a cursor of another listing restarts from the top', () => {
    const first = pageTreeEntries(entries, { limit: 10 }, { listKey });
    const changed = [...entries.slice(0, 5), entry('new'), ...entries.slice(5)];
    const otherKey = treeListingKey('state', changed);
    expect(otherKey).not.toBe(listKey);
    const next = pageTreeEntries(
      changed,
      { limit: 10, cursor: first.nextCursor ?? '' },
      { listKey: otherKey },
    );
    expect(next.restarted).toBe(true);
    expect(next.offset).toBe(0);
    expect(next.entries[0]).toEqual(changed[0]);
  });

  it('the listing key moves with an overlay change, not only with names', () => {
    const changed = entries.map((e, i) => (i === 3 ? { ...e, status: 'modified' as const } : e));
    expect(treeListingKey('state', changed)).not.toBe(listKey);
    expect(treeListingKey('other state', entries)).not.toBe(listKey);
  });

  it('bounds a page by bytes but always returns one entry', () => {
    const big = Array.from({ length: 5 }, (_, i) =>
      entry(`${'x'.repeat(4000)}${i}`, { path: `${'p/'.repeat(10)}${'x'.repeat(4000)}${i}` }),
    );
    const key = treeListingKey('s', big);
    const page = pageTreeEntries(big, {}, { listKey: key, maxBytes: 9000 });
    expect(page.entries).toHaveLength(1);
    expect(page.truncated).toBe(true);
    const one = pageTreeEntries(big, {}, { listKey: key, maxBytes: 1 });
    expect(one.entries).toHaveLength(1);
  });

  it('defaults and clamps the limit', () => {
    const many = Array.from({ length: TREE_PAGE_MAX + 10 }, (_, i) => entry(`e${i}`));
    const key = treeListingKey('s', many);
    expect(pageTreeEntries(many, {}, { listKey: key }).entries).toHaveLength(TREE_PAGE_DEFAULT);
    expect(pageTreeEntries(many, { limit: 10 ** 9 }, { listKey: key }).entries).toHaveLength(
      TREE_PAGE_MAX,
    );
  });

  it('a malformed cursor restarts', () => {
    for (const cursor of ['', '1.abc.1', 't1.zz.1', `t1.${'0'.repeat(16)}.-1`]) {
      const page = pageTreeEntries(entries, { cursor, limit: 5 }, { listKey });
      expect(page.restarted).toBe(true);
      expect(page.offset).toBe(0);
    }
  });
});

describe('tree schemas', () => {
  it('has the route', () => {
    expect(ROUTES.getTree).toEqual({ method: 'GET', path: '/api/worktrees/:worktreeId/tree' });
  });

  it('accepts the root, a directory with one trailing slash, refs and commit ids', () => {
    expect(TreeQuerySchema.parse({})).toEqual({});
    expect(TreeQuerySchema.parse({ path: '' }).path).toBe('');
    expect(TreeQuerySchema.parse({ path: 'src/' }).path).toBe('src');
    expect(TreeQuerySchema.parse({ path: 'a/b', ref: 'HEAD', limit: '20' })).toEqual({
      path: 'a/b',
      ref: 'HEAD',
      limit: 20,
    });
    expect(TreeQuerySchema.parse({ ref: 'origin/main' }).ref).toBe('origin/main');
    expect(TreeQuerySchema.parse({ ref: 'a'.repeat(40) }).ref).toBe('a'.repeat(40));
  });

  it('refuses traversal, absolute paths, NUL, option-like refs and revision syntax', () => {
    for (const path of ['..', 'a/../b', './a', '/etc', 'a\u0000b', '//', 'a/./b']) {
      expect(TreeQuerySchema.safeParse({ path }).success, path).toBe(false);
    }
    for (const ref of ['-p', '--output=x', 'HEAD~1', 'HEAD^{tree}', 'main:src', 'a..b', '@{-1}']) {
      expect(TreeQuerySchema.safeParse({ ref }).success, ref).toBe(false);
    }
    expect(TreeQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(TreeQuerySchema.safeParse({ limit: String(TREE_PAGE_MAX + 1) }).success).toBe(false);
    expect(TreeQuerySchema.safeParse({ cursor: '1.abc.1' }).success).toBe(false);
  });

  it('parses a response and an event with dirs', () => {
    const response = {
      worktreeId: '0123456789abcdef',
      view: 'working',
      ref: null,
      commit: 'b'.repeat(40),
      tree: 'c'.repeat(40),
      path: '',
      stateHash: 'h',
      entries: [
        entry('a.ts', { path: 'a.ts', status: 'modified', staged: false, unstaged: true }),
        {
          name: 'new',
          path: 'new',
          kind: 'dir',
          mode: null,
          oid: null,
          size: null,
          status: 'untracked',
          changes: 3,
        },
      ],
      total: 2,
      offset: 0,
      nextCursor: null,
      truncated: false,
      restarted: false,
    };
    expect(TreeResponseSchema.parse(response)).toEqual(response);
    const event = {
      type: 'worktree.changed',
      projectId: '0123456789abcdef',
      worktreeId: '0123456789abcdef',
      stateHash: 'x',
      dirs: { all: false, dirs: [{ path: '' }, { path: 'src' }] },
    };
    expect(WorktreeChangedEventSchema.parse(event)).toEqual(event);
    expect(
      WorktreeChangedEventSchema.safeParse({
        ...event,
        dirs: { all: false, dirs: Array.from({ length: 101 }, () => ({ path: 'a' })) },
      }).success,
    ).toBe(false);
  });
});

describe('raw and display identities (#9 review)', () => {
  it('a raw directory and one literally named like its base64 never share an identity', () => {
    const raw = { path: 'd\ufffd', rawPath: Buffer.from([0x64, 0xff]).toString('base64') };
    const literal = { path: raw.rawPath };
    expect(raw.rawPath).toBe('ZP8=');
    expect(treeDirIdentity(raw)).not.toBe(treeDirIdentity(literal));
    expect(treeDirIdentity(literal)).toBe('p:ZP8=');
    expect(treeDirIdentity(raw)).toBe('r:ZP8=');
    expect(treeDirIdentity({ path: '' })).toBe('p:');
  });

  it('the listing key tells a raw entry from a display entry of the same text', () => {
    const base = entry('x', { path: 'ZP8=' });
    const raw = { ...base, path: 'd\ufffd', rawPath: 'ZP8=' };
    expect(treeListingKey('s', [base])).not.toBe(treeListingKey('s', [{ ...raw, path: 'ZP8=' }]));
  });

  it('the listing key moves with replaces', () => {
    const e = entry('d', { kind: 'dir', status: 'untracked' });
    expect(treeListingKey('s', [e])).not.toBe(treeListingKey('s', [{ ...e, replaces: 'file' }]));
  });

  it('schemas carry the raw old path and replaces', () => {
    const file = {
      path: 'new',
      oldPath: 'old\ufffd',
      oldRawPath: Buffer.from([0x6f, 0x6c, 0x64, 0xff]).toString('base64'),
      status: 'renamed',
      binary: false,
      oldMode: '100644',
      newMode: '100644',
      additions: 0,
      deletions: 0,
      patchHash: 'h',
      staged: true,
      unstaged: false,
    };
    expect(GitChangedFileSchema.parse(file)).toEqual(file);
    expect(GitChangedFileSchema.safeParse({ ...file, oldRawPath: 'not base64!' }).success).toBe(
      false,
    );
    const row = entry('d', { kind: 'dir', mode: null, oid: null, size: null, replaces: 'file' });
    expect(TreeEntrySchema.parse(row)).toEqual(row);
    expect(TreeEntrySchema.safeParse({ ...row, replaces: 'blob' }).success).toBe(false);
  });
});
