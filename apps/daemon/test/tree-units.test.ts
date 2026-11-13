/** The explorer's overlay and directory deltas (#9), without git. */
import type {
  GitChangedFile,
  GitTreeListing,
  SummarySnapshot,
  SummarySnapshotEntry,
  UntrackedOmission,
} from '@octopus-diff/contracts';
import { WORKTREE_CHANGED_DIRS_MAX } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { overlayIndex, treeBasis, treeDelta, workingEntries } from '../src/tree.js';

const OID = 'a'.repeat(40);

function changed(
  path: string,
  status: GitChangedFile['status'],
  extra: Partial<GitChangedFile> = {},
): GitChangedFile {
  return {
    path,
    oldPath: null,
    status,
    binary: false,
    oldMode: status === 'untracked' || status === 'added' ? null : '100644',
    newMode: status === 'deleted' ? null : '100644',
    additions: 1,
    deletions: 0,
    patchHash: `h-${path}`,
    staged: false,
    unstaged: true,
    ...extra,
  };
}

function listing(
  dir: string,
  entries: Array<[string, 'file' | 'dir' | 'symlink']>,
): GitTreeListing {
  return {
    commit: OID,
    tree: OID,
    kind: 'dir',
    entries: entries.map(([name, kind]) => ({
      name,
      path: dir === '' ? name : `${dir}/${name}`,
      kind,
      mode: kind === 'dir' ? '040000' : kind === 'symlink' ? '120000' : '100644',
      oid: OID,
      size: kind === 'dir' ? null : 1,
    })),
  };
}

const none = async () => null;

describe('workingEntries', () => {
  it('merges new files and directories in git tree order and marks the rest', async () => {
    const files = [
      changed('a-b.txt', 'untracked'),
      changed('a/new.txt', 'untracked'),
      changed('a0', 'modified'),
      changed('z/deep/x.txt', 'added', { staged: true, unstaged: false }),
    ];
    const index = overlayIndex(files, undefined);
    const entries = await workingEntries(
      listing('', [
        ['a0', 'file'],
        ['b', 'dir'],
      ]),
      '',
      index,
      none,
    );
    expect(entries.map((e) => [e.name, e.kind, e.status ?? null, e.changes ?? null])).toEqual([
      ['a-b.txt', 'file', 'untracked', null],
      ['a', 'dir', 'untracked', 1],
      ['a0', 'file', 'modified', null],
      ['b', 'dir', null, null],
      ['z', 'dir', 'added', 1],
    ]);
  });

  it('a rename source is deleted with renamedTo, unless the list has its own record there', async () => {
    const files = [
      changed('new/name.txt', 'renamed', { oldPath: 'old/name.txt', staged: true }),
      changed('back.txt', 'renamed', { oldPath: 'front.txt' }),
      // A new file at the source path: its record wins.
      changed('front.txt', 'added'),
    ];
    const index = overlayIndex(files, undefined);
    const root = await workingEntries(
      listing('', [
        ['front.txt', 'file'],
        ['old', 'dir'],
      ]),
      '',
      index,
      async () => 1,
    );
    const by = Object.fromEntries(root.map((e) => [e.name, e]));
    expect(by['front.txt']).toMatchObject({ status: 'added' });
    expect(by['front.txt']?.renamedTo).toBeUndefined();
    expect(by.back?.status ?? by['back.txt']?.status).toBe('renamed');
    expect(by.old).toMatchObject({ status: 'deleted', changes: 1 });
    expect(by.new).toMatchObject({ status: 'added', changes: 1 });
    const old = await workingEntries(listing('old', [['name.txt', 'file']]), 'old', index, none);
    expect(old[0]).toMatchObject({ status: 'deleted', renamedTo: 'new/name.txt' });
  });

  it('marks a HEAD directory deleted only when its file count equals the deletions below', async () => {
    const files = [changed('d/x', 'deleted'), changed('d/y', 'deleted')];
    const index = overlayIndex(files, undefined);
    const tree = listing('', [['d', 'dir']]);
    expect((await workingEntries(tree, '', index, async () => 2))[0]?.status).toBe('deleted');
    expect((await workingEntries(tree, '', index, async () => 3))[0]?.status).toBeUndefined();
    expect((await workingEntries(tree, '', index, none))[0]?.status).toBeUndefined();
    // Something live below: never deleted, whatever the count.
    const live = overlayIndex([...files, changed('d/z', 'untracked')], undefined);
    let asked = 0;
    const entries = await workingEntries(tree, '', live, async () => {
      asked++;
      return 2;
    });
    expect(entries[0]?.status).toBeUndefined();
    expect(asked).toBe(0);
  });

  it('lists omitted untracked directories (#43) with their counts', async () => {
    const omission: UntrackedOmission = {
      count: 5000,
      limit: 2000,
      directories: [
        { path: 'node_modules', count: 4000, ignoreLine: '/node_modules/' },
        { path: 'src/gen', count: 1000, ignoreLine: '/src/gen/' },
      ],
    };
    const index = overlayIndex([changed('src/a.ts', 'modified')], omission);
    const root = await workingEntries(listing('', [['src', 'dir']]), '', index, none);
    expect(
      root.map((e) => [e.name, e.status ?? null, e.changes, e.untrackedOmitted ?? null]),
    ).toEqual([
      ['node_modules', 'untracked', 4000, 4000],
      ['src', null, 1001, 1000],
    ]);
    const src = await workingEntries(listing('src', [['a.ts', 'file']]), 'src', index, none);
    expect(src.map((e) => [e.name, e.status])).toEqual([
      ['a.ts', 'modified'],
      ['gen', 'untracked'],
    ]);
  });

  it('adds snapshot conflicts the list lacks, without doubling a listed one', async () => {
    const index = overlayIndex([changed('c.txt', 'conflicted')], undefined, ['c.txt', 'gone.txt']);
    const root = await workingEntries(
      listing('', [
        ['c.txt', 'file'],
        ['gone.txt', 'file'],
      ]),
      '',
      index,
      none,
    );
    expect(root.map((e) => e.status)).toEqual(['conflicted', 'conflicted']);
  });
});

function snap(
  entries: Array<Partial<SummarySnapshotEntry> & { path: string }>,
  truncated = false,
): SummarySnapshot {
  return {
    entries: entries.map((e) => ({
      xy: '.M',
      hH: null,
      hI: null,
      sig: 's1',
      added: 1,
      deleted: 0,
      ...e,
    })),
    total: entries.length,
    truncated,
  };
}

describe('treeDelta', () => {
  const basis = (head: string, s: SummarySnapshot, omission?: UntrackedOmission) =>
    treeBasis('state', head, s, omission);

  it('names the ancestors of a path whose status moved, not of a content edit', () => {
    const prev = basis(OID, snap([{ path: 'a/b/c.ts' }, { path: 'x/new.ts', xy: '??' }]));
    const edited = basis(
      OID,
      snap([
        { path: 'a/b/c.ts', sig: 's2' },
        { path: 'x/new.ts', xy: '??' },
      ]),
    );
    expect(treeDelta(prev, edited)).toEqual({ all: false, dirs: [] });
    const staged = basis(
      OID,
      snap([
        { path: 'a/b/c.ts', xy: 'M.' },
        { path: 'x/new.ts', xy: '??' },
      ]),
    );
    expect(treeDelta(prev, staged)).toEqual({
      all: false,
      dirs: [{ path: '' }, { path: 'a' }, { path: 'a/b' }],
    });
    const gone = basis(OID, snap([{ path: 'a/b/c.ts' }]));
    expect(treeDelta(prev, gone)).toEqual({ all: false, dirs: [{ path: '' }, { path: 'x' }] });
  });

  it('a content edit of an added or deleted path may re-pair renames: named', () => {
    const prev = basis(OID, snap([{ path: 'n/a.ts', xy: 'A.' }]));
    const cur = basis(OID, snap([{ path: 'n/a.ts', xy: 'A.', sig: 's2' }]));
    expect(treeDelta(prev, cur).dirs).toEqual([{ path: '' }, { path: 'n' }]);
  });

  it('a rename names both sides', () => {
    const prev = basis(OID, snap([]));
    const cur = basis(OID, snap([{ path: 'to/x', xy: 'R.', oldPath: 'from/x' }]));
    expect(treeDelta(prev, cur).dirs).toEqual([{ path: '' }, { path: 'from' }, { path: 'to' }]);
  });

  it('HEAD moves, cut snapshots and too many directories mean all', () => {
    const prev = basis(OID, snap([]));
    expect(treeDelta(prev, basis('b'.repeat(40), snap([])))).toEqual({ all: true, dirs: [] });
    expect(treeDelta(prev, basis(OID, snap([], true)))).toEqual({ all: true, dirs: [] });
    const many = snap(
      Array.from({ length: WORKTREE_CHANGED_DIRS_MAX + 1 }, (_, i) => ({
        path: `d${i}/f`,
        xy: '??',
      })),
    );
    expect(treeDelta(prev, basis(OID, many))).toEqual({ all: true, dirs: [] });
    const long = snap(
      Array.from({ length: 30 }, (_, i) => ({ path: `${'x'.repeat(300)}${i}/f`, xy: '??' })),
    );
    expect(treeDelta(prev, basis(OID, long))).toEqual({ all: true, dirs: [] });
  });

  it('omitted directories that appear, go or change count are named with themselves', () => {
    const o = (count: number): UntrackedOmission => ({
      count,
      limit: 1,
      directories: [{ path: 'a/gen', count, ignoreLine: null }],
    });
    const prev = basis(OID, snap([]), o(10));
    expect(treeDelta(prev, basis(OID, snap([]), o(10)))).toEqual({ all: false, dirs: [] });
    expect(treeDelta(prev, basis(OID, snap([]), o(11))).dirs).toEqual([
      { path: '' },
      { path: 'a' },
      { path: 'a/gen' },
    ]);
    expect(treeDelta(prev, basis(OID, snap([]))).dirs).toEqual([
      { path: '' },
      { path: 'a' },
      { path: 'a/gen' },
    ]);
  });

  it('keeps raw (non-UTF-8) directory names as rawPath', () => {
    const raw = Buffer.from([0x64, 0xff]).toString('base64');
    const prev = basis(OID, snap([]));
    const cur = basis(
      OID,
      snap([
        {
          path: 'd�/f',
          rawPath: Buffer.from([0x64, 0xff, 0x2f, 0x66]).toString('base64'),
          xy: '??',
        },
      ]),
    );
    expect(treeDelta(prev, cur).dirs).toEqual([{ path: '' }, { path: 'd�', rawPath: raw }]);
  });
});
