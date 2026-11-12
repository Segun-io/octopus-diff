/**
 * #38: the activity feed's pure parts (snapshot diff, HEAD classification) and the in-memory ring
 * (coalescing, bulk folding, caps, `dropped`, the blob allow-list, the memory ceiling).
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import {
  ACTIVITY_PATHS_MAX,
  type ActivityEntry,
  type CommitInfo,
  type SummarySnapshotEntry,
} from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_BYTES_MAX,
  type ActivityDraft,
  ActivityStore,
  classifyHead,
  countDeleted,
  diffSnapshots,
  type HeadChange,
  type HeadState,
  needsCommits,
  type OriginLabel,
  type SnapshotState,
} from '../src/activity.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const OLD = '1'.repeat(40);
const NEW = '2'.repeat(40);
const T0 = new Date('2026-11-12T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function head(over: Partial<HeadState> = {}): HeadState {
  return {
    sha: OLD,
    branch: 'main',
    detached: false,
    inProgress: null,
    aheadBehindRef: null,
    ahead: null,
    behind: null,
    ...over,
  };
}

type E = Partial<SummarySnapshotEntry> & { path: string };
function entry(e: E): SummarySnapshotEntry {
  return { xy: '.M', hH: A, hI: A, sig: 's1', added: 1, deleted: 0, ...e };
}

function state(entries: E[], h: Partial<HeadState> = {}, extra: Partial<SnapshotState> = {}) {
  const map = new Map<string, SummarySnapshotEntry>();
  for (const e of entries) map.set(e.rawPath ?? e.path, entry(e));
  return { entries: map, total: map.size, truncated: false, head: head(h), ...extra };
}

function commit(sha: string, parents: string[], subject = `commit ${sha.slice(0, 4)}`): CommitInfo {
  return {
    sha,
    shortSha: sha.slice(0, 7),
    parents,
    subject,
    authorName: 'a',
    authorEmail: 'a@example.com',
    authorDate: T0.toISOString(),
    committerDate: T0.toISOString(),
  };
}

/** Diffs prev -> cur (classifying HEAD with `commits`) and returns the drafts. */
function diff(
  prev: SnapshotState,
  cur: SnapshotState,
  commits: CommitInfo[] | null = null,
  origins: Map<string, OriginLabel> | null = null,
) {
  return diffSnapshots(prev, cur, classifyHead(prev.head, cur.head, commits), origins);
}

/** A store with a baseline for `wt`, so the next observe records. */
function storeWith(prev: SnapshotState, limits = {}): ActivityStore {
  const store = new ActivityStore(limits, T0.getTime());
  store.observe('wt', prev, [], T0);
  return store;
}

describe('diffSnapshots: files', () => {
  it('an edit is `modified` with the latest +/-', () => {
    const drafts = diff(
      state([{ path: 'a.ts', sig: 's1', added: 1 }]),
      state([{ path: 'a.ts', sig: 's2', added: 4, deleted: 2 }]),
    );
    expect(drafts).toEqual([{ kind: 'modified', path: 'a.ts', xy: '.M', added: 4, deleted: 2 }]);
  });

  it('a clean file that changes is `modified`; a new untracked or staged file is `added`', () => {
    const drafts = diff(
      state([]),
      state([
        { path: 'a.ts' },
        { path: 'new.ts', xy: '??', hH: null, hI: null, added: 3 },
        { path: 'staged.ts', xy: 'A.', hH: null, hI: B, added: 2 },
        { path: 'moved.ts', xy: 'R.', oldPath: 'old.ts', hI: B },
      ]),
    );
    expect(drafts.map((d) => [d.kind, d.path, d.oldPath])).toEqual([
      ['modified', 'a.ts', undefined],
      ['added', 'new.ts', undefined],
      ['added', 'staged.ts', undefined],
      ['added', 'moved.ts', 'old.ts'],
    ]);
  });

  it('a deleted tracked file carries its last staged or committed blob', () => {
    const drafts = diff(
      state([{ path: 'edited.ts', xy: '.M', hI: B }]),
      state([
        // clean -> deleted in the working tree: the index blob
        { path: 'gone.ts', xy: '.D', hH: A, hI: A, sig: 'missing', added: 0, deleted: 5 },
        // `git rm`: only HEAD has it
        { path: 'rm.ts', xy: 'D.', hH: C, hI: null, sig: 'missing', added: 0, deleted: 2 },
        // edited, then deleted: the index version (the unstaged edit is lost)
        { path: 'edited.ts', xy: '.D', hH: A, hI: B, sig: 'missing', added: 0, deleted: 7 },
      ]),
    );
    expect(drafts.map((d) => [d.kind, d.path, d.oid])).toEqual([
      ['deleted', 'gone.ts', A],
      ['deleted', 'rm.ts', C],
      ['deleted', 'edited.ts', B],
    ]);
    expect(drafts[0]).toMatchObject({ xy: '.D', added: 0, deleted: 5 });
  });

  it('a deleted untracked file has no content (oid null, untracked)', () => {
    const drafts = diff(
      state([{ path: 'scratch.txt', xy: '??', hH: null, hI: null, added: 9 }]),
      state([]),
    );
    expect(drafts).toEqual([
      {
        kind: 'deleted',
        path: 'scratch.txt',
        xy: '??',
        added: 9,
        deleted: 0,
        oid: null,
        untracked: true,
      },
    ]);
  });

  it('a staged new file that vanishes without a commit is deleted with its staged blob', () => {
    const drafts = diff(state([{ path: 'n.ts', xy: 'A.', hH: null, hI: B }]), state([]));
    expect(drafts).toEqual([
      { kind: 'deleted', path: 'n.ts', xy: 'A.', added: null, deleted: null, oid: B },
    ]);
  });

  it('a change undone without a HEAD move is `restored`; a deleted file that returns is `added`', () => {
    const drafts = diff(
      state([
        { path: 'reverted.ts' },
        { path: 'undeleted.ts', xy: '.D', sig: 'missing' },
        { path: 'recreated.ts', xy: '.D', sig: 'missing' },
      ]),
      state([{ path: 'recreated.ts', xy: '.M', sig: 's9', added: 2, deleted: 1 }]),
    );
    expect(drafts).toEqual([
      { kind: 'added', path: 'recreated.ts', xy: '.M', added: 2, deleted: 1 },
      { kind: 'restored', path: 'reverted.ts' },
      { kind: 'restored', path: 'undeleted.ts' },
    ]);
  });

  it('the source of a staged rename is not restored', () => {
    // `rm a; echo > b; git add -A`: `.D a` and `?? b` become `R. b <- a`.
    const drafts = diff(
      state([
        { path: 'a.ts', xy: '.D', sig: 'missing' },
        { path: 'b.ts', xy: '??', hH: null, hI: null, sig: 's7' },
      ]),
      state([{ path: 'b.ts', xy: 'R.', oldPath: 'a.ts', hI: B, sig: 's7' }]),
    );
    expect(drafts.filter((d) => d.path === 'a.ts')).toEqual([]);
  });

  it('an index-only change (git add) is not activity', () => {
    expect(diff(state([{ path: 'a.ts', xy: '.M' }]), state([{ path: 'a.ts', xy: 'M.' }]))).toEqual(
      [],
    );
  });

  it('keeps rawPath for non-UTF-8 names and keys by it', () => {
    const raw = Buffer.from([0x66, 0xff]).toString('base64');
    const drafts = diff(
      state([{ path: 'f�', rawPath: raw }]),
      state([{ path: 'f�', rawPath: raw, sig: 's2' }]),
    );
    expect(drafts).toEqual([
      { kind: 'modified', path: 'f�', rawPath: raw, xy: '.M', added: 1, deleted: 0 },
    ]);
  });

  it('counts uncommitted tracked deletions (state-based)', () => {
    const snap = {
      entries: [
        entry({ path: 'a', xy: '.D' }),
        entry({ path: 'b', xy: 'D.' }),
        entry({ path: 'c', xy: 'AD' }),
        entry({ path: 'd', xy: 'UD' }),
        entry({ path: 'e', xy: '??' }),
        entry({ path: 'f', xy: '.M' }),
      ],
      total: 6,
      truncated: false,
    };
    expect(countDeleted(snap)).toBe(3);
  });
});

describe('diffSnapshots: HEAD moves', () => {
  const dirty = state([
    { path: 'a.ts', xy: 'M.' },
    { path: 'b.ts', xy: '.M' },
  ]);

  it('a commit takes the paths that left the uncommitted set (not restored)', () => {
    const cur = state([{ path: 'b.ts', xy: '.M' }], { sha: NEW });
    const drafts = diff(dirty, cur, [commit(NEW, [OLD], 'feat: a'), commit(OLD, [])]);
    expect(drafts).toEqual([
      {
        kind: 'commit',
        sha: NEW,
        subject: 'feat: a',
        from: OLD,
        to: NEW,
        paths: ['a.ts'],
        pathCount: 1,
      },
    ]);
  });

  it('two commits in one refresh are two entries, the paths on the newest', () => {
    const mid = '3'.repeat(40);
    const drafts = diff(dirty, state([], { sha: NEW }), [
      commit(NEW, [mid], 'second'),
      commit(mid, [OLD], 'first'),
      commit(OLD, []),
    ]);
    expect(drafts.map((d) => [d.kind, d.subject, d.from, d.to, d.paths])).toEqual([
      ['commit', 'first', OLD, mid, undefined],
      ['commit', 'second', mid, NEW, ['a.ts', 'b.ts']],
    ]);
  });

  it('the first commit of an unborn branch is a commit', () => {
    const prev = state([{ path: 'a.ts', xy: 'A.', hH: null }], { sha: null });
    const drafts = diff(prev, state([], { sha: NEW }), [commit(NEW, [], 'root')]);
    expect(drafts).toMatchObject([{ kind: 'commit', sha: NEW, from: null, paths: ['a.ts'] }]);
  });

  it('a checkout (branch change) takes the paths that left, with both branches', () => {
    const drafts = diff(dirty, state([], { sha: NEW, branch: 'feature' }));
    expect(drafts).toEqual([
      {
        kind: 'head',
        op: 'checkout',
        from: OLD,
        to: NEW,
        branch: 'feature',
        fromBranch: 'main',
        inProgress: null,
        paths: ['a.ts', 'b.ts'],
        pathCount: 2,
      },
    ]);
  });

  it('reset --hard while dirty is a reset (HEAD left the old line), never a commit', () => {
    const parent = '9'.repeat(40);
    const drafts = diff(dirty, state([], { sha: parent }), [commit(parent, [])]);
    expect(drafts).toMatchObject([{ kind: 'head', op: 'reset', paths: ['a.ts', 'b.ts'] }]);
  });

  it('reset --soft brings changes back as staged: a reset plus the files', () => {
    const parent = '9'.repeat(40);
    const drafts = diff(state([]), state([{ path: 'c.ts', xy: 'M.' }], { sha: parent }), [
      commit(parent, []),
    ]);
    expect(drafts.map((d) => [d.kind, d.op ?? d.path])).toEqual([
      ['head', 'reset'],
      ['modified', 'c.ts'],
    ]);
  });

  it('a pull (behind drops) and a merge commit are merges', () => {
    const tracked = { aheadBehindRef: 'origin/main', ahead: 0 };
    const ff = diff(
      state([], { ...tracked, behind: 2 }),
      state([], { ...tracked, behind: 0, sha: NEW }),
      [commit(NEW, ['3'.repeat(40)]), commit('3'.repeat(40), [OLD]), commit(OLD, [])],
    );
    expect(ff).toMatchObject([{ kind: 'head', op: 'merge' }]);
    const merge = diff(state([]), state([], { sha: NEW }), [
      commit(NEW, [OLD, C]),
      commit(OLD, []),
    ]);
    expect(merge).toMatchObject([{ kind: 'head', op: 'merge' }]);
  });

  it('an operation in progress names it; unknown moves say `moved`', () => {
    expect(diff(state([]), state([], { inProgress: 'merge' }))).toMatchObject([
      { kind: 'head', op: 'merge', inProgress: 'merge' },
    ]);
    expect(
      diff(state([], { inProgress: 'rebase' }), state([], { sha: NEW, detached: true })),
    ).toMatchObject([{ kind: 'head', op: 'rebase', inProgress: null, branch: null }]);
    expect(diff(state([]), state([], { sha: NEW }), null)).toMatchObject([
      { kind: 'head', op: 'moved' },
    ]);
  });

  it('needs the commit list only for a same-branch move with no operation', () => {
    expect(needsCommits(head(), head({ sha: NEW }))).toBe(true);
    expect(needsCommits(head(), head({ sha: NEW, branch: 'x' }))).toBe(false);
    expect(needsCommits(head(), head({ sha: NEW, inProgress: 'rebase' }))).toBe(false);
    expect(needsCommits(head(), head())).toBe(false);
    expect(classifyHead(head(), head(), null)).toBeNull();
  });
});

describe('diffSnapshots: folding and labels', () => {
  it('more than 50 file changes fold into one bulk entry', () => {
    const files = Array.from({ length: 60 }, (_, i) => ({
      path: `gen/f${i}.ts`,
      xy: '??',
      hH: null,
      hI: null,
    }));
    const drafts = diff(state([{ path: 'x.ts' }]), state(files));
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      kind: 'bulk',
      kinds: { added: 60, modified: 0, deleted: 0, restored: 1 },
      pathCount: 61,
    });
    expect(drafts[0]?.paths).toHaveLength(ACTIVITY_PATHS_MAX);
    // 50 is not more than 50.
    expect(diff(state([]), state(files.slice(0, 50)))).toHaveLength(50);
  });

  it('a truncated snapshot gives one coarse bulk entry when anything differs', () => {
    const prev = state([{ path: 'a' }], {}, { total: 3000, truncated: true });
    const same = state([{ path: 'a' }], {}, { total: 3000, truncated: true });
    expect(diff(prev, same)).toEqual([]);
    const more = state([{ path: 'a' }], {}, { total: 3001, truncated: true });
    expect(diff(prev, more)).toEqual([{ kind: 'bulk', truncated: true, pathCount: 3001 }]);
  });

  it('labels merge noise from the review state, and a bulk of base files', () => {
    const origins = new Map<string, OriginLabel>([
      ['a.ts', { origin: 'base', originVia: 'in-progress' }],
    ]);
    const drafts = diff(state([]), state([{ path: 'a.ts' }, { path: 'b.ts' }]), null, origins);
    expect(drafts.map((d) => [d.path, d.origin, d.originVia])).toEqual([
      ['a.ts', 'base', 'in-progress'],
      ['b.ts', undefined, undefined],
    ]);
    const many = Array.from({ length: 51 }, (_, i) => ({ path: `m${i}` }));
    const all = new Map<string, OriginLabel>(many.map((m) => [m.path, { origin: 'base' }]));
    expect(diff(state([]), state(many), null, all)[0]).toMatchObject({
      kind: 'bulk',
      origin: 'base',
    });
    all.delete('m7');
    expect(diff(state([]), state(many), null, all)[0]?.origin).toBeUndefined();
  });
});

const mod = (path: string, added = 1): ActivityDraft => ({
  kind: 'modified',
  path,
  xy: '.M',
  added,
  deleted: 0,
});

describe('ActivityStore', () => {
  it('the first snapshot is a baseline: no entries, live from then on', () => {
    const store = new ActivityStore({}, T0.getTime());
    expect(store.read('wt', 0)).toEqual({ entries: [], seq: 0, dropped: false, live: false });
    expect(store.observe('wt', state([]), [mod('a')], T0)).toBe(0);
    expect(store.read('wt', 0)).toEqual({ entries: [], seq: 0, dropped: false, live: true });
    store.observe('wt', state([]), [mod('a')], at(10));
    expect(store.read('wt', 0).entries).toHaveLength(1);
  });

  it('coalesces the same path and kind within 10 s into one entry', () => {
    const store = storeWith(state([]));
    store.observe('wt', state([]), [mod('a', 1)], at(1000));
    const first = store.read('wt', 0).entries[0] as ActivityEntry;
    store.observe('wt', state([]), [mod('a', 5)], at(6000));
    store.observe('wt', state([]), [mod('a', 7)], at(15_000)); // 9 s after the last update
    const read = store.read('wt', 0);
    expect(read.entries).toHaveLength(1);
    expect(read.entries[0]).toMatchObject({
      id: first.id,
      count: 3,
      added: 7,
      at: at(1000).toISOString(),
      updatedAt: at(15_000).toISOString(),
    });
    expect(read.entries[0]?.seq).toBeGreaterThan(first.seq);
    // `after` the first seq still returns the updated entry (it has a new seq).
    expect(store.read('wt', first.seq).entries).toHaveLength(1);
    expect(store.read('wt', read.seq).entries).toHaveLength(0);
    // More than 10 s later: a new entry.
    store.observe('wt', state([]), [mod('a', 9)], at(25_001));
    expect(store.read('wt', 0).entries.map((e) => e.count)).toEqual([3, 1]);
  });

  it('does not coalesce across another kind, a commit or a HEAD change', () => {
    const store = storeWith(state([]));
    store.observe('wt', state([]), [mod('a')], at(1));
    store.observe('wt', state([]), [{ kind: 'deleted', path: 'a', oid: A }], at(2));
    store.observe('wt', state([]), [{ kind: 'added', path: 'a' }], at(3));
    store.observe('wt', state([]), [mod('a')], at(4));
    store.observe('wt', state([]), [{ kind: 'commit', sha: NEW, paths: ['a'] }], at(5));
    store.observe('wt', state([]), [mod('a')], at(6));
    store.observe('wt', state([]), [mod('b')], at(7));
    store.observe('wt', state([]), [mod('b')], at(8)); // coalesces with b, a stays apart
    expect(store.read('wt', 0).entries.map((e) => `${e.kind}:${e.path ?? ''}:${e.count}`)).toEqual([
      'modified:a:1',
      'deleted:a:1',
      'added:a:1',
      'modified:a:1',
      'commit::1',
      'modified:a:1',
      'modified:b:2',
    ]);
  });

  it('coalesces a run of the same HEAD operation (a rebase) from first to last', () => {
    const store = storeWith(state([]));
    const step = (from: string, to: string, paths: string[]): ActivityDraft => ({
      kind: 'head',
      op: 'rebase',
      from,
      to,
      branch: null,
      fromBranch: 'main',
      inProgress: 'rebase',
      ...(paths.length > 0 ? { paths, pathCount: paths.length } : {}),
    });
    store.observe('wt', state([]), [step(OLD, B, ['x'])], at(100));
    store.observe('wt', state([]), [step(B, C, ['y'])], at(200));
    store.observe('wt', state([]), [{ ...step(C, NEW, []), op: 'checkout' }], at(300));
    const entries = store.read('wt', 0).entries;
    expect(entries.map((e) => [e.op, e.count, e.from, e.to, e.paths, e.pathCount])).toEqual([
      ['rebase', 2, OLD, C, ['x', 'y'], 2],
      ['checkout', 1, C, NEW, undefined, undefined],
    ]);
  });

  it('keeps 200 entries per worktree and reports `dropped` for an `after` that fell off', () => {
    const store = storeWith(state([]));
    for (let i = 0; i < 250; i++) store.observe('wt', state([]), [mod(`f${i}`)], at(i));
    const all = store.read('wt', 0);
    expect(all.entries).toHaveLength(200);
    expect(all.entries[0]?.path).toBe('f50');
    expect(all.dropped).toBe(true);
    const oldestKept = all.entries[0]?.seq as number;
    expect(store.read('wt', oldestKept - 2).dropped).toBe(true);
    expect(store.read('wt', oldestKept - 1).dropped).toBe(false);
    expect(store.read('wt', all.seq).dropped).toBe(false);
    // An `after` from an earlier daemon run (beyond the sequence): everything, dropped.
    const stale = store.read('wt', all.seq + 1000);
    expect(stale.dropped).toBe(true);
    expect(stale.entries).toHaveLength(200);
  });

  it('caps the entries over all worktrees, dropping the globally oldest first', () => {
    const store = new ActivityStore({ globalMax: 5 }, T0.getTime());
    for (const id of ['w1', 'w2']) store.observe(id, state([]), [], T0);
    store.observe('w1', state([]), [mod('a'), mod('b'), mod('c')], at(1));
    store.observe('w2', state([]), [mod('d'), mod('e'), mod('f')], at(2));
    expect(store.stats().entries).toBe(5);
    expect(store.read('w1', 0).entries.map((e) => e.path)).toEqual(['b', 'c']);
    expect(store.read('w1', 0).dropped).toBe(true);
    expect(store.read('w2', 0).entries.map((e) => e.path)).toEqual(['d', 'e', 'f']);
    store.forget('w1');
    expect(store.stats()).toMatchObject({ rings: 1, entries: 3 });
  });

  it('allows blobs only from its entries and the current snapshot', () => {
    const store = storeWith(state([]), { ringSize: 2 });
    const cur = state([{ path: 'x', hH: B, hI: C }]);
    store.observe('wt', cur, [{ kind: 'deleted', path: 'd', oid: A }], at(1));
    expect(store.allowsBlob('wt', A)).toBe(true);
    expect(store.allowsBlob('wt', B)).toBe(true);
    expect(store.allowsBlob('wt', C)).toBe(true);
    expect(store.allowsBlob('wt', NEW)).toBe(false);
    expect(store.allowsBlob('other', A)).toBe(false);
    // Once the deleted entry falls off the ring and the snapshot moves on, A is refused.
    store.observe('wt', state([]), [mod('m1'), mod('m2')], at(2));
    expect(store.allowsBlob('wt', A)).toBe(false);
    expect(store.allowsBlob('wt', B)).toBe(false);
  });

  it('a reset baseline records nothing for the next snapshot', () => {
    const store = storeWith(state([]));
    store.resetBaseline('wt');
    expect(store.previous('wt')).toBeNull();
    expect(store.observe('wt', state([{ path: 'a' }]), [mod('a')], at(1))).toBe(0);
    expect(store.read('wt', 0).entries).toEqual([]);
  });
});

describe('ActivityStore memory', () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const heap = () => {
    gc();
    gc();
    return process.memoryUsage().heapUsed;
  };

  /** 90 worktrees x 200 entries (a fifth of them deletions with an oid), fresh strings. */
  function fill(store: ActivityStore, pathOf: (w: number, i: number) => string): void {
    const empty = state([]);
    for (let w = 0; w < 90; w++) {
      const id = w.toString(16).padStart(16, '0');
      store.observe(id, empty, [], T0);
      for (let i = 0; i < 200; i++) {
        const path = pathOf(w, i);
        const oid = (w * 1000 + i).toString(16).padStart(40, 'a');
        const d: ActivityDraft =
          i % 5 === 0
            ? { kind: 'deleted', path, xy: '.D', added: 0, deleted: 40 + i, oid }
            : { kind: 'modified', path, xy: '.M', added: i, deleted: 3 };
        // 20 s apart: nothing coalesces.
        store.observe(id, empty, [d], at(i * 20_000));
      }
    }
  }

  it('holds 90 x 200 entries in about 4 MB', () => {
    const before = heap();
    const store = new ActivityStore({}, T0.getTime());
    fill(store, (w, i) => `src/components/feature-${w}/Component${i}.tsx`);
    const used = heap() - before;
    expect(store.stats().entries).toBe(18_000);
    expect(store.stats().bytes).toBeLessThanOrEqual(ACTIVITY_BYTES_MAX);
    expect(used).toBeLessThan(4.5 * 1024 * 1024);
    expect(store.read('0000000000000000', 0).entries).toHaveLength(200);
  });

  it('caps the bytes for pathological paths (the oldest entries go first)', () => {
    const before = heap();
    const store = new ActivityStore({}, T0.getTime());
    fill(store, (w, i) => `${'deep/'.repeat(200)}${w}-${i}.txt`);
    const used = heap() - before;
    expect(store.stats().bytes).toBeLessThanOrEqual(ACTIVITY_BYTES_MAX);
    expect(store.stats().entries).toBeLessThan(18_000);
    expect(used).toBeLessThan(5 * 1024 * 1024);
  });

  it('does not keep the git output a path was sliced from', () => {
    const before = heap();
    const store = new ActivityStore({}, T0.getTime());
    store.observe('wt', state([]), [], T0);
    for (let i = 0; i < 100; i++) {
      // A 100 KB "status output" per refresh; the entry keeps one 30-char path cut from it.
      const output = `${'x'.repeat(100_000)}${i}/src/some/long/path/name.ts`;
      const path = output.slice(100_000);
      store.observe('wt', state([]), [mod(path)], at(i * 20_000));
    }
    expect(heap() - before).toBeLessThan(1024 * 1024);
  });
});

describe('HeadChange shape', () => {
  it('lists commits oldest first', () => {
    const mid = '3'.repeat(40);
    const change = classifyHead(head(), head({ sha: NEW }), [
      commit(NEW, [mid], 'b'),
      commit(mid, [OLD], 'a'),
    ]) as HeadChange;
    expect(change).toEqual({
      kind: 'commit',
      commits: [
        { sha: mid, subject: 'a' },
        { sha: NEW, subject: 'b' },
      ],
    });
  });
});
