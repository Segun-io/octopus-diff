import { describe, expect, it } from 'vitest';
import {
  type ChangedFile,
  compareFileOrder,
  FILES_PAGE_MAX_BYTES,
  FilesQuerySchema,
  FilesResponseSchema,
  fileListCounts,
  fileListEntryKey,
  fileListKey,
  fuzzyMatch,
  InboxEntrySchema,
  InboxQuerySchema,
  orderFiles,
  pageFileList,
  utf8Length,
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

const ORIGINS = ['own', 'mixed', 'base', undefined] as const;

function file(path: string, extra: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path,
    oldPath: null,
    status: 'modified',
    binary: false,
    oldMode: '100644',
    newMode: '100644',
    additions: 1,
    deletions: 1,
    patchHash: `h-${path}`,
    staged: false,
    unstaged: true,
    reviewed: false,
    ...extra,
  };
}

function randomList(random: () => number, size: number, names: string[]): ChangedFile[] {
  const picked = new Set<string>();
  while (picked.size < Math.min(size, names.length)) {
    picked.add(names[Math.floor(random() * names.length)] as string);
  }
  return [...picked].map((p) => {
    const origin = ORIGINS[Math.floor(random() * ORIGINS.length)];
    return file(p, {
      reviewed: random() < 0.4,
      ...(origin ? { origin } : {}),
      ...(random() < 0.05 ? { rawPath: btoa(`raw-${p}`) } : {}),
    });
  });
}

const NAMES = Array.from({ length: 400 }, (_, i) => {
  const dir = ['a', 'B', 'src', 'src/deep', 'é', 'z/y'][i % 6];
  return `${dir}/file-${(i * 7919) % 1000}.ts`;
});

const page = (
  list: ChangedFile[],
  request: Parameters<typeof pageFileList>[1],
  state = 's1',
  maxBytes = FILES_PAGE_MAX_BYTES,
) =>
  pageFileList(list, request, {
    listKey: fileListKey(state, list),
    defaultLimit: 2000,
    maxBytes,
  });

describe('paging order', () => {
  it('own and mixed first, then base, each by code-unit path then rawPath', () => {
    const list = orderFiles([
      file('b.ts', { origin: 'base' }),
      file('Z.ts'),
      file('a.ts', { origin: 'mixed' }),
      file('a.ts', { rawPath: 'AA==' }),
      file('A.ts', { origin: 'base' }),
    ]);
    expect(list.map((f) => `${f.origin ?? 'own'}:${f.path}:${f.rawPath ?? ''}`)).toEqual([
      'own:Z.ts:',
      'mixed:a.ts:',
      'own:a.ts:AA==',
      'base:A.ts:',
      'base:b.ts:',
    ]);
    expect(compareFileOrder(file('x'), file('x'))).toBe(0);
  });

  it('counts the whole list', () => {
    expect(
      fileListCounts([
        file('a', { reviewed: true }),
        file('b', { origin: 'base', reviewed: true }),
        file('c', { origin: 'base' }),
        file('d'),
      ]),
    ).toEqual({ total: 4, reviewed: 2, base: 2, baseReviewed: 1 });
  });
});

describe('pageFileList (property: pages of random sizes are the list, once each)', () => {
  it('yields exactly the full list for 200 random lists and page sizes', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const random = rng(seed);
      const list = orderFiles(randomList(random, Math.floor(random() * 300), NAMES));
      const got: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      for (;;) {
        const limit = 1 + Math.floor(random() * 60);
        const p = page(list, { limit, ...(cursor ? { cursor } : {}) });
        expect(p.restarted).toBe(false);
        expect(p.files.length).toBeLessThanOrEqual(limit);
        expect(p.offset).toBe(got.length);
        expect(p.total).toBe(list.length);
        got.push(...p.files.map(fileListEntryKey));
        pages++;
        if (p.nextCursor === null) break;
        expect(p.truncated).toBe(true);
        cursor = p.nextCursor;
      }
      expect(got).toEqual(list.map(fileListEntryKey));
      expect(new Set(got).size).toBe(got.length);
      expect(pages).toBeGreaterThan(0);
    }
  });

  it('restarts when the list changes mid-paging, and the restarted paging is the new list exactly', () => {
    let restarts = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const random = rng(1000 + seed);
      let list = orderFiles(randomList(random, 20 + Math.floor(random() * 200), NAMES));
      let state = 0;
      let got: string[] = [];
      let cursor: string | undefined;
      for (let step = 0; step < 500; step++) {
        // A refresh between two pages: files appear, go, flip origin, or only a patch moves.
        if (random() < 0.25) {
          const kind = Math.floor(random() * 4);
          if (kind === 0)
            list = orderFiles(
              [...list, ...randomList(random, 3, NAMES)].filter(
                (f, i, all) =>
                  all.findIndex((g) => fileListEntryKey(g) === fileListEntryKey(f)) === i,
              ),
            );
          else if (kind === 1) list = list.filter(() => random() > 0.1);
          else if (kind === 2)
            list = orderFiles(
              list.map((f) =>
                random() < 0.1 ? { ...f, origin: f.origin === 'base' ? 'own' : 'base' } : f,
              ),
            );
          else
            list = list.map((f) => (random() < 0.1 ? { ...f, patchHash: `${f.patchHash}+` } : f));
          state++;
        }
        const p = page(
          list,
          { limit: 1 + Math.floor(random() * 40), ...(cursor ? { cursor } : {}) },
          `s${state}`,
        );
        if (p.restarted) {
          restarts++;
          got = [];
        }
        expect(p.offset).toBe(got.length);
        got.push(...p.files.map(fileListEntryKey));
        if (p.nextCursor === null) {
          expect(got).toEqual(list.map(fileListEntryKey));
          break;
        }
        cursor = p.nextCursor;
      }
      expect(new Set(got).size).toBe(got.length);
    }
    expect(restarts).toBeGreaterThan(50);
  });

  it('an unreviewed view restarts when marks move, not otherwise', () => {
    const list = orderFiles(NAMES.slice(0, 50).map((p, i) => file(p, { reviewed: i % 3 === 0 })));
    const first = page(list, { limit: 5, unreviewed: true });
    expect(first.files.every((f) => !f.reviewed)).toBe(true);
    const cursor = first.nextCursor as string;
    expect(page(list, { limit: 5, unreviewed: true, cursor }).restarted).toBe(false);
    const marked = list.map((f, i) => (i === 40 ? { ...f, reviewed: !f.reviewed } : f));
    expect(page(marked, { limit: 5, unreviewed: true, cursor }).restarted).toBe(true);
    // The unfiltered view does not depend on marks.
    const plain = page(list, { limit: 5 }).nextCursor as string;
    expect(page(marked, { limit: 5, cursor: plain }).restarted).toBe(false);
    // A cursor of one view is not one of another.
    expect(page(list, { limit: 5, cursor: plain, origin: 'own' }).restarted).toBe(true);
    expect(page(list, { limit: 5, cursor: 'garbage' }).restarted).toBe(true);
  });

  it('stops before the byte budget but always returns one file', () => {
    const list = orderFiles(NAMES.slice(0, 100).map((p) => file(p)));
    const size = JSON.stringify(list[0]).length + 1;
    const p = page(list, { limit: 100 }, 's', size * 10 + 5);
    expect(p.files.length).toBe(10);
    expect(page(list, { limit: 100 }, 's', 1).files.length).toBe(1);
    // Multi-byte paths count as UTF-8.
    const wide = orderFiles([file('é'.repeat(100)), file('ü'.repeat(100))]);
    const one = utf8Length(JSON.stringify(wide[0])) + 1;
    expect(one).toBe(JSON.stringify(wide[0]).length + 1 + 200); // path and patchHash
    expect(page(wide, { limit: 2 }, 's', one).files.length).toBe(1);
    expect(page(wide, { limit: 2 }, 's', one * 2).files.length).toBe(2);
  });

  it('without a limit gives the default number of files', () => {
    const list = orderFiles(NAMES.slice(0, 30).map((p) => file(p)));
    const p = pageFileList(list, {}, { listKey: 'k', defaultLimit: 12, maxBytes: 1e9 });
    expect(p.files).toHaveLength(12);
    expect(p.truncated).toBe(true);
    const all = pageFileList(list, {}, { listKey: 'k', defaultLimit: 2000, maxBytes: 1e9 });
    expect(all.files).toHaveLength(30);
    expect(all.truncated).toBe(false);
    expect(all.nextCursor).toBeNull();
  });

  it('after: the first file after it in the view, where it would sort when it is gone', () => {
    const list = orderFiles([
      file('a', { reviewed: true }),
      file('b'),
      file('c', { reviewed: true }),
      file('d'),
      file('e', { origin: 'base' }),
      file('f', { origin: 'base', reviewed: true }),
    ]);
    const next = (after: string, extra = {}) =>
      page(list, { after: { path: after }, limit: 1, unreviewed: true, ...extra }).files[0]?.path;
    expect(next('a')).toBe('b');
    expect(next('b')).toBe('d');
    expect(next('c')).toBe('d');
    expect(next('d')).toBe('e');
    expect(next('d', { origin: 'own' })).toBeUndefined();
    expect(next('bb')).toBe('d'); // gone: sorts between b and c
    expect(page(list, { after: { path: 'c' }, limit: 1 }).position).toBe(3);
    expect(page(list, { after: { path: 'f' }, limit: 1 }).files).toHaveLength(0);
  });

  it('q ranks by the fuzzy score, ties in list order', () => {
    const list = orderFiles([
      file('src/app.ts'),
      file('lib/apple.ts'),
      file('app.ts'),
      file('docs/readme.md'),
    ]);
    const p = page(list, { q: 'app' });
    // app.ts scores highest (a prefix run); the other two tie and keep the list's order.
    expect(fuzzyMatch('app', 'app.ts')?.score).toBeGreaterThan(
      fuzzyMatch('app', 'src/app.ts')?.score ?? 0,
    );
    expect(p.files.map((f) => f.path)).toEqual(['app.ts', 'lib/apple.ts', 'src/app.ts']);
    expect(p.total).toBe(3);
  });
});

describe('schemas (#42)', () => {
  it('parses the paging parameters and keeps old queries as they were', () => {
    expect(FilesQuerySchema.parse({ scope: 'working' })).toEqual({ scope: { kind: 'working' } });
    const q = FilesQuerySchema.parse({
      scope: 'working',
      limit: '20',
      after: 'a/b.ts',
      unreviewed: 'true',
      origin: 'own',
      q: 'b',
    });
    expect(q.page).toEqual({
      limit: 20,
      after: { path: 'a/b.ts' },
      unreviewed: true,
      origin: 'own',
      q: 'b',
    });
    expect(() => FilesQuerySchema.parse({ limit: '0' })).toThrow();
    expect(() => FilesQuerySchema.parse({ limit: '2001' })).toThrow();
    expect(() => FilesQuerySchema.parse({ cursor: 'not a cursor' })).toThrow();
    expect(InboxQuerySchema.parse({ filesLimit: '0' }).filesLimit).toBe(0);
  });

  it('older clients strip the new response fields', () => {
    const parsed = FilesResponseSchema.parse({
      worktreeId: '0123456789abcdef',
      scope: { kind: 'working' },
      stateHash: 'h',
      files: [],
      total: 0,
      offset: 0,
      position: null,
      nextCursor: null,
      truncated: false,
      restarted: false,
      counts: { total: 0, reviewed: 0, base: 0, baseReviewed: 0 },
    });
    expect(parsed.total).toBe(0);
    expect(InboxEntrySchema.shape.filesTotal.safeParse(undefined).success).toBe(true);
  });
});
