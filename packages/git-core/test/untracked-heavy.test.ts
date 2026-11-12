import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type GitCore,
  type SummaryResult,
  SummarySnapshotSchema,
  UntrackedOmissionSchema,
  WorktreeSummarySchema,
} from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCore } from '../src/index.js';
import { summaryLimits } from '../src/summary.js';
import {
  ignoreLineFor,
  isOmitted,
  listedKeys,
  MAX_OMITTED_DIRS,
  omissionOf,
  planUntracked,
} from '../src/untracked-plan.js';
import { listFiles, locator } from './helpers/core.js';
import { createFixture, type Fixture } from './helpers/fixture.js';
import { worktreesFoldCase } from './helpers/folds.js';

const FOLDS = await worktreesFoldCase();

const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const files = (dir: string, n: number): string[] => range(n).map((i) => `${dir}/f${i}.txt`);

describe('planUntracked (#43)', () => {
  it('omits nothing at or below the cap', () => {
    expect(planUntracked(files('a', 5), 5)).toBeNull();
    expect(listedKeys(null, ['x', 'y'])).toEqual(['x', 'y']);
  });

  it('omits the deepest directory that holds the excess alone', () => {
    // The bench's shape: scratch/gen (real new files) next to scratch/many/pkg*/d* (bulk).
    const keys = [
      ...files('scratch/gen', 4),
      ...range(30).flatMap((d) => files(`scratch/many/pkg${d % 3}/d${d}`, 10)),
      'top.txt',
    ];
    const plan = planUntracked(keys, 10);
    expect(plan).not.toBeNull();
    if (!plan) return;
    expect([...plan.dirs]).toEqual([['scratch/many', 300]]);
    expect(plan.after).toBeNull();
    expect(plan.omitted).toBe(300);
    expect(listedKeys(plan, keys)).toEqual([...files('scratch/gen', 4), 'top.txt']);
  });

  it('omits the biggest top-level directories when none holds the excess, then descends', () => {
    const keys = [...files('node_modules/x', 50), ...files('dist/assets', 45), ...files('src', 3)];
    const plan = planUntracked(keys, 5);
    if (!plan) throw new Error('expected a plan');
    // Both are generated names (PR #91 P2-2): omitted first, biggest first, as whole directories.
    expect([...plan.dirs]).toEqual([
      ['node_modules', 50],
      ['dist', 45],
    ]);
    expect(listedKeys(plan, keys)).toEqual(files('src', 3));
  });

  it('cuts in path order when no directory is worth omitting', () => {
    const keys = [...range(20).map((i) => `loose${String(i).padStart(2, '0')}.txt`), 'a/one.txt'];
    const plan = planUntracked(keys, 5);
    if (!plan) throw new Error('expected a plan');
    expect(plan.dirs.size).toBe(0);
    const listed = listedKeys(plan, keys);
    // The first five in path order (listedKeys keeps the input's order).
    expect(listed).toEqual([
      'loose00.txt',
      'loose01.txt',
      'loose02.txt',
      'loose03.txt',
      'a/one.txt',
    ]);
    expect(plan.after).toBe('loose03.txt');
    expect(plan.omitted).toBe(16);
    expect(isOmitted(plan, 'loose04.txt')).toBe(true);
    expect(isOmitted(plan, 'loose03.txt')).toBe(false);
  });

  it('never lists more than the cap and counts every omitted entry', () => {
    // Many small directories: at most MAX_OMITTED_DIRS directories, then the cut.
    const keys = range(300).flatMap((d) => files(`d${String(d).padStart(3, '0')}`, 3));
    for (const cap of [1, 7, 100]) {
      const plan = planUntracked(keys, cap);
      if (!plan) throw new Error('expected a plan');
      const listed = listedKeys(plan, keys);
      expect(listed.length).toBeLessThanOrEqual(cap);
      expect(listed.length + plan.omitted).toBe(keys.length);
      expect(plan.dirs.size).toBeLessThanOrEqual(MAX_OMITTED_DIRS);
    }
  });

  it('depends on the set of paths, not their order; a directory omitted later absorbs inner ones', () => {
    const keys = [...files('n/a', 30), ...files('n/b', 25), ...files('n', 10), 'z.txt'];
    const shuffled = [...keys].reverse();
    expect(planUntracked(shuffled, 3)?.id).toBe(planUntracked(keys, 3)?.id);
    const plan = planUntracked(keys, 3);
    if (!plan) throw new Error('expected a plan');
    // 66 - 3 = 63 > 30 (n/a), but n holds 65: n; nothing below it is reported separately.
    expect([...plan.dirs]).toEqual([['n', 65]]);
    // Nested repositories (`dir/`) count as one entry of their parent.
    expect(isOmitted(plan, 'n/repo/')).toBe(true);
  });

  it('describes the plan with copyable .gitignore lines', () => {
    const none = { listed: [], trackedDirs: new Set<string>(), trackedNames: new Set<string>() };
    expect(ignoreLineFor('scratch/many', none)).toBe('/scratch/many/');
    expect(ignoreLineFor('packages/a/node_modules/.pnpm', none)).toBe('node_modules/');
    expect(ignoreLineFor('packages/a/dist/assets', none)).toBe('/packages/a/dist/');
    // Without knowing what else is there (no context), only the exact directory.
    expect(ignoreLineFor('packages/a/node_modules/.pnpm')).toBe('/packages/a/node_modules/.pnpm/');
    expect(ignoreLineFor('we*rd [dir]', none)).toBe('/we\\*rd \\[dir]/');
    expect(ignoreLineFor('new\nline', none)).toBeNull();
    const keys = [...files('big', 40), ...files('small', 2)];
    const plan = planUntracked(keys, 5);
    if (!plan) throw new Error('expected a plan');
    const omission = UntrackedOmissionSchema.parse(omissionOf(plan));
    expect(omission).toEqual({
      count: 40,
      limit: 5,
      directories: [{ path: 'big', count: 40, ignoreLine: '/big/', generated: false }],
    });
  });

  // PR #91 P2-3: a broader line must not ignore a listed untracked file or a tracked one.
  it('broadens a line only when nothing listed or tracked falls under it', () => {
    const ctx = (listed: string[], tracked: string[] = []) => {
      const trackedDirs = new Set<string>();
      const trackedNames = new Set<string>();
      for (const t of tracked) {
        const parts = t.split('/').slice(0, -1);
        parts.forEach((part, i) => {
          trackedDirs.add(parts.slice(0, i + 1).join('/'));
          trackedNames.add(part);
        });
      }
      return { listed, trackedDirs, trackedNames };
    };
    // tools/build is a source folder: its new-script.ts is listed.
    expect(ignoreLineFor('tools/build/cache', ctx(['tools/build/new-script.ts']))).toBe(
      '/tools/build/cache/',
    );
    expect(ignoreLineFor('tools/build/cache', ctx(['src/x.ts']))).toBe('/tools/build/');
    expect(ignoreLineFor('src/build/gen', ctx([], ['src/build/real/a.ts']))).toBe(
      '/src/build/gen/',
    );
    // `node_modules/` anywhere would also ignore a listed file in another node_modules.
    expect(ignoreLineFor('a/node_modules', ctx(['b/node_modules/x.js']))).toBe('/a/node_modules/');
    expect(ignoreLineFor('a/node_modules', ctx([], ['vendor/node_modules/keep.js']))).toBe(
      '/a/node_modules/',
    );
    expect(ignoreLineFor('a/node_modules', ctx(['a/src.ts']))).toBe('node_modules/');
  });

  // Greptile on PR #91: a listed directory entry (a nested repository, `dir/`) is a directory the
  // pattern matches by its own name, not only through its parents.
  it('treats listed directory entries as directories', () => {
    const none = (listed: string[]) => ({
      listed,
      trackedDirs: new Set<string>(),
      trackedNames: new Set<string>(),
    });
    const table: Array<[string, string[], string]> = [
      ['b/node_modules', ['a/node_modules/'], '/b/node_modules/'],
      ['b/node_modules', ['a/node_modules/inner/'], '/b/node_modules/'],
      ['b/node_modules', ['a/node_modules_x/'], 'node_modules/'],
      // A file named node_modules is not a directory: `node_modules/` does not match it.
      ['b/node_modules', ['a/node_modules'], 'node_modules/'],
      ['tools/build/cache', ['tools/build/'], '/tools/build/cache/'],
      ['tools/build/cache', ['tools/build2/'], '/tools/build/'],
      ['x/dist/a', ['x/dist/'], '/x/dist/a/'],
    ];
    for (const [dir, listed, line] of table) {
      expect(ignoreLineFor(dir, none(listed)), `${dir} with ${listed}`).toBe(line);
    }
  });

  // PR #91 P2-4 (SEC-05): bidi, zero-width and other format characters make no line to copy.
  it('makes no line for names with bidi, zero-width or format characters', () => {
    for (const name of [
      '\u202eevil',
      'a\u200bb',
      'x\u2066y',
      'bom\ufeff',
      'soft\u00adhy',
      'ls\u2028',
    ]) {
      expect(ignoreLineFor(name), JSON.stringify(name)).toBeNull();
    }
    expect(ignoreLineFor('ünï/çödé')).toBe('/ünï/çödé/');
  });

  // PR #91 P2-2: generated directories go first, so the plan does not hide source behind them.
  it('omits dependency and build-output directories before others', () => {
    const keys = [
      ...range(5).flatMap((m) => files(`src/m${m}`, 5)),
      ...files('dist/assets', 15),
      'top.txt',
    ];
    const plan = planUntracked(keys, 30);
    if (!plan) throw new Error('expected a plan');
    // 41 > 30: dist first (15), then 26 remain, under the cap: src stays listed (size alone
    // would have omitted src, 25, and listed dist).
    expect([...plan.dirs]).toEqual([['dist', 15]]);
    expect(listedKeys(plan, keys)).toHaveLength(26);
    const omission = omissionOf(plan);
    expect(omission.directories).toEqual([
      { path: 'dist', count: 15, ignoreLine: '/dist/', generated: true },
    ]);
    // Above the cap even without dist: dist first, then the deepest source directory needed.
    const more = [...keys, ...files('src/m0', 10).map((k) => k.replace('/f', '/g'))];
    const second = planUntracked(more, 30);
    if (!second) throw new Error('expected a plan');
    expect([...second.dirs]).toEqual([
      ['dist', 15],
      ['src/m0', 15],
    ]);
    expect(omissionOf(second).directories.map((d) => [d.path, d.generated])).toEqual([
      ['dist', true],
      ['src/m0', false],
    ]);
    // Nested: the outermost generated directory, never one inside it separately.
    const nested = planUntracked([...files('node_modules/a/dist', 30), ...files('src', 3)], 5);
    expect([...(nested?.dirs ?? [])]).toEqual([['node_modules', 30]]);
  });
});

let fx: Fixture;
let core: GitCore;
let full: GitCore;
const CAP = 20;

beforeAll(() => {
  fx = createFixture('octopus-diff-untracked-heavy-');
  core = createGitCore(fx.coreOptions({ maxListedUntracked: CAP }));
  full = createGitCore(fx.coreOptions({ maxListedUntracked: CAP, incremental: false }));
});

afterAll(async () => {
  await core.dispose();
  await full.dispose();
  fx.dispose();
});

function heavyRepo(name: string): string {
  const repo = fx.repo(name, { files: { 'a.txt': 'a\n', 'src/keep.ts': 'export {};\n' } });
  fx.write(path.join(repo, 'a.txt'), 'a\nchanged\n');
  fx.write(path.join(repo, 'src/new.ts'), 'one\ntwo\n');
  for (const d of range(10)) {
    mkdirSync(path.join(repo, 'build', `d${d}`), { recursive: true });
    for (const f of range(10)) {
      writeFileSync(path.join(repo, 'build', `d${d}`, `f${f}.txt`), `x ${d} ${f}\n`);
    }
  }
  return repo;
}

describe('summaries and lists above the cap (#43)', () => {
  it('counts every untracked file, inspects and lists only the cap, and says so', async () => {
    const repo = heavyRepo('counts');
    const wt = locator(repo);
    const summary = await core.getSummary(wt, { snapshot: true });
    WorktreeSummarySchema.parse(summary);
    expect(summary.counts.untracked).toBe(101);
    // a.txt + src/new.ts + 100 build files: exact.
    expect(summary.changedFiles).toBe(102);
    // a.txt's added line and src/new.ts's two lines; the omitted files' lines are unknown.
    expect(summary.additions).toBe(3);
    expect(summary.untrackedOmitted).toEqual({
      count: 100,
      limit: CAP,
      directories: [{ path: 'build', count: 100, ignoreLine: '/build/', generated: true }],
    });
    const snapshot = SummarySnapshotSchema.parse(summary.snapshot);
    expect(snapshot.entries.map((e) => e.path)).toEqual(['a.txt', 'src/new.ts']);
    expect(snapshot.total).toBe(102);
    expect(snapshot.truncated).toBe(false);
    expect(snapshot.untrackedOmitted).toBe(100);
    expect(snapshot.omittedPlan).toMatch(/^[0-9a-f]{16}$/);

    for (const scope of [
      { kind: 'working' as const },
      { kind: 'review' as const },
      { kind: 'branch' as const, base: 'main', includeWorking: true },
    ]) {
      const listed = await listFiles(core, wt, scope, { summaryState: summary.stateHash });
      expect(listed.map((f) => f.path)).toEqual(['a.txt', 'src/new.ts']);
      // A list without the summary's state (its own status) omits the same files.
      expect(await listFiles(full, wt, scope)).toEqual(listed);
    }
    // An omitted file can still be diffed by path: it is only left out of lists.
    const diff = await core.getFileDiff(wt, { kind: 'working' }, { path: 'build/d0/f0.txt' });
    expect(diff.status).toBe('untracked');
    expect(diff.patch).toContain('+x 0 0');
  });

  it('listed files keep the rows and patches they had without a cap, byte for byte', async () => {
    const repo = heavyRepo('identical');
    const wt = locator(repo);
    // Both above `maxUntrackedFiles` (contents not read, as with 30k files and the defaults);
    // only the first omits anything.
    const capped = createGitCore(
      fx.coreOptions({ maxListedUntracked: CAP, maxUntrackedFiles: 50 }),
    );
    const uncapped = createGitCore(
      fx.coreOptions({ maxListedUntracked: 10_000, maxUntrackedFiles: 50 }),
    );
    try {
      for (const scope of [{ kind: 'working' as const }, { kind: 'review' as const }]) {
        const got = await listFiles(capped, wt, scope);
        const all = await listFiles(uncapped, wt, scope);
        expect(got.map((f) => f.path)).toEqual(['a.txt', 'src/new.ts']);
        expect(got).toEqual(all.filter((f) => !f.path.startsWith('build/')));
        for (const file of got) {
          const a = await capped.getFileDiff(wt, scope, { path: file.path });
          const b = await uncapped.getFileDiff(wt, scope, { path: file.path });
          expect(a).toEqual(b);
          expect(a.patchHash).toBe(file.patchHash);
        }
      }
    } finally {
      await capped.dispose();
      await uncapped.dispose();
    }
  });

  it('below the cap nothing changes: no field, same state hash as without the option', async () => {
    const repo = fx.repo('below', { files: { 'a.txt': 'a\n' } });
    for (const i of range(CAP)) fx.write(path.join(repo, 'new', `n${i}.txt`), `${i}\n`);
    const wt = locator(repo);
    const capped = await core.getSummary(wt, { snapshot: true });
    const plain = createGitCore(fx.coreOptions());
    try {
      const reference = await plain.getSummary(wt, { snapshot: true });
      expect(capped.untrackedOmitted).toBeUndefined();
      expect(capped.snapshot?.untrackedOmitted).toBeUndefined();
      expect(capped.stateHash).toBe(reference.stateHash);
      expect(capped.snapshot?.contentHash).toBe(reference.snapshot?.contentHash);
      expect((await listFiles(core, wt, { kind: 'working' })).length).toBe(CAP);
    } finally {
      await plain.dispose();
    }
  });

  it('the state hash moves when an omitted file appears or disappears, not when it is rewritten', async () => {
    const repo = heavyRepo('hash');
    const wt = locator(repo);
    const first = await core.getSummary(wt, { snapshot: true });
    const omittedFile = path.join(repo, 'build', 'd3', 'f3.txt');
    // Rewritten in place: git status cannot see it and its stat signature is not read.
    writeFileSync(omittedFile, 'rewritten, longer than before\n');
    const rewritten = await core.getSummary(wt, { snapshot: true });
    expect(rewritten.stateHash).toBe(first.stateHash);
    expect(rewritten.snapshot?.contentHash).toBe(first.snapshot?.contentHash);
    rmSync(omittedFile);
    const removed = await core.getSummary(wt, { snapshot: true });
    expect(removed.stateHash).not.toBe(first.stateHash);
    // The activity feed's hash sees omitted paths come and go too (only their paths).
    expect(removed.snapshot?.contentHash).not.toBe(first.snapshot?.contentHash);
    expect(removed.snapshot?.untrackedOmitted).toBe(99);
    expect(removed.counts.untracked).toBe(100);
    expect(removed.untrackedOmitted?.count).toBe(99);
    writeFileSync(path.join(repo, 'build', 'd3', 'new.txt'), 'new\n');
    const added = await core.getSummary(wt);
    expect(added.stateHash).not.toBe(removed.stateHash);
    expect(added.untrackedOmitted?.count).toBe(100);
    // A listed untracked file is still fully signed: rewriting it moves the hash.
    writeFileSync(path.join(repo, 'src', 'new.ts'), 'one\ntwo\nthree\n');
    expect((await core.getSummary(wt)).stateHash).not.toBe(added.stateHash);
  });

  it.skipIf(FOLDS)(
    'an incremental refresh agrees with a full one across a plan change',
    async () => {
      const repo = heavyRepo('incremental');
      const wt = locator(repo);
      await core.getSummary(wt, { snapshot: true });
      // One file in build/ (omitted) and one in src/ (listed): the plan stays the same.
      writeFileSync(path.join(repo, 'build', 'd1', 'extra.txt'), 'e\n');
      writeFileSync(path.join(repo, 'src', 'other.ts'), 'o\n');
      const got = await core.getSummary(wt, {
        snapshot: true,
        changedPaths: ['build/d1/extra.txt', 'src/other.ts'],
      });
      expect(got.refresh?.mode).toBe('incremental');
      const { updatedAt: _a, refresh: _b, ...gotRest } = got;
      const {
        updatedAt: _c,
        refresh: _d,
        ...wantRest
      } = await full.getSummary(wt, {
        snapshot: true,
      });
      expect(gotRest).toEqual(wantRest);
      expect(
        (await listFiles(core, wt, { kind: 'working' }, { summaryState: got.stateHash })).map(
          (f) => f.path,
        ),
      ).toEqual(['a.txt', 'src/new.ts', 'src/other.ts']);
      // Removing build/ brings the worktree under the cap: everything is listed again.
      rmSync(path.join(repo, 'build'), { recursive: true });
      const under = await core.getSummary(wt, { changedPaths: ['build'] });
      expect(under.untrackedOmitted).toBeUndefined();
      expect(under.counts.untracked).toBe(2);
      expect(
        (await listFiles(core, wt, { kind: 'working' }, { summaryState: under.stateHash })).map(
          (f) => f.path,
        ),
      ).toEqual(['a.txt', 'src/new.ts', 'src/other.ts']);
    },
  );

  // PR #91 P2-3, checked with git itself: every suggested line ignores every file of its directory
  // and no listed untracked file; a tracked file only under the exact line of its own directory.
  async function checkIgnore(
    name: string,
    files: Record<string, string>,
    untracked: Record<string, number>,
    loose: string[],
    trackedRepos: string[] = [],
  ): Promise<Map<string, string | null>> {
    const repo = fx.repo(name, { files });
    /** A repository of its own at `rel` (git shows it as one entry, `rel/`). */
    const nested = (rel: string) => {
      const dir = path.join(repo, rel);
      mkdirSync(dir, { recursive: true });
      fx.git(dir, ['init', '-q']);
      fx.write(path.join(dir, 'inner.txt'), 'inner\n');
      fx.commitAll(dir, 'inner');
    };
    for (const rel of trackedRepos) {
      nested(rel);
      fx.git(repo, ['add', '--', rel]);
      fx.git(repo, ['commit', '-q', '-m', `track ${rel}`]);
    }
    for (const [dir, n] of Object.entries(untracked)) {
      for (const i of range(n)) fx.write(path.join(repo, dir, `f${i}.txt`), `${i}\n`);
    }
    // A trailing `/`: a listed nested repository.
    for (const rel of loose) {
      if (rel.endsWith('/')) nested(rel.slice(0, -1));
      else fx.write(path.join(repo, rel), 'listed\n');
    }
    const wt = locator(repo);
    const capped = createGitCore(fx.coreOptions({ maxListedUntracked: 5 }));
    try {
      const omission = (await capped.getSummary(wt)).untrackedOmitted;
      if (!omission) throw new Error('expected an omission');
      const lines = omission.directories.map((d) => d.ignoreLine);
      expect(lines.every((line) => line !== null)).toBe(true);
      // Directory entries (nested repositories) keep their `/`, as check-ignore needs it.
      const listed = (await listFiles(capped, wt, { kind: 'working' }))
        .filter((f) => f.status === 'untracked')
        .map((f) => (f.newMode === '160000' ? `${f.path}/` : f.path));
      expect(listed.sort()).toEqual([...loose].sort());
      const tracked = fx.git(repo, ['ls-files']).split('\n').filter(Boolean);
      const excludes = path.join(fx.root, `${name}.excludes`);
      writeFileSync(excludes, `${lines.join('\n')}\n`);
      const ignored = (paths: string[]): string[] =>
        fx
          .git(
            repo,
            ['-c', `core.excludesFile=${excludes}`, 'check-ignore', '--no-index', '--stdin'],
            { allowFail: true, input: `${paths.join('\n')}\n` },
          )
          .split('\n')
          .filter(Boolean);
      expect(ignored(listed)).toEqual([]);
      const exactDirs = omission.directories.filter((d) => d.ignoreLine === `/${d.path}/`);
      expect(
        ignored(tracked).filter((t) => !exactDirs.some((d) => t.startsWith(`${d.path}/`))),
      ).toEqual([]);
      for (const dir of omission.directories) {
        const inside = fx
          .git(repo, ['ls-files', '--others', '--', dir.path])
          .split('\n')
          .filter(Boolean);
        expect(inside.length, dir.path).toBe(dir.count);
        expect(ignored(inside), dir.path).toEqual(inside);
      }
      return new Map(omission.directories.map((d) => [d.path, d.ignoreLine]));
    } finally {
      await capped.dispose();
    }
  }

  it('suggested lines ignore the omitted files and nothing listed or tracked (git check-ignore)', async () => {
    // `node_modules/` anywhere would also ignore web/node_modules/one.js (listed) and the tracked
    // vendor/node_modules: the exact line instead.
    expect(
      await checkIgnore(
        'check-ignore',
        { 'a.txt': 'a\n', 'vendor/node_modules/keep.js': 'k\n', 'dist/README.md': 'r\n' },
        { 'pkg/node_modules/x': 12, 'dist/assets': 12 },
        ['web/node_modules/one.js', 'src/new.ts'],
      ),
    ).toEqual(
      new Map([
        ['dist', '/dist/'],
        ['pkg/node_modules', '/pkg/node_modules/'],
      ]),
    );
    // Nothing else named node_modules: the broad line.
    expect(
      await checkIgnore('check-ignore-broad', { 'a.txt': 'a\n' }, { 'app/node_modules/x': 12 }, [
        'app/src.ts',
      ]),
    ).toEqual(new Map([['app/node_modules', 'node_modules/']]));
    // Only a tracked vendor/node_modules: still the exact line (found by the `ls-files` scan).
    expect(
      await checkIgnore(
        'check-ignore-tracked',
        { 'a.txt': 'a\n', 'vendor/node_modules/keep.js': 'k\n' },
        { 'app/node_modules/x': 12 },
        ['app/src.ts'],
      ),
    ).toEqual(new Map([['app/node_modules', '/app/node_modules/']]));
    // Greptile on PR #91: a listed nested repository named node_modules is itself a directory the
    // broad line would ignore (not only directories above it).
    expect(
      await checkIgnore('check-ignore-nested', { 'a.txt': 'a\n' }, { 'b/node_modules/x': 12 }, [
        'a/node_modules/',
        'src.ts',
      ]),
    ).toEqual(new Map([['b/node_modules', '/b/node_modules/']]));
    // A tracked repository (gitlink) named node_modules counts as a tracked directory too.
    expect(
      await checkIgnore(
        'check-ignore-gitlink',
        { 'a.txt': 'a\n' },
        { 'b/node_modules/x': 12 },
        ['src.ts'],
        ['vendor/node_modules'],
      ),
    ).toEqual(new Map([['b/node_modules', '/b/node_modules/']]));
    // Names with spaces and pattern characters, broad when nothing else is called that.
    expect(
      await checkIgnore(
        'check-ignore-special',
        { 'a.txt': 'a\n' },
        { 'my app/node_modules/x[1]': 12 },
        ['my app/src #1.ts', 'out [v2]/keep.txt'],
      ),
    ).toEqual(new Map([['my app/node_modules', 'node_modules/']]));
  });

  it('an omitted directory named with bidi characters has no line', async () => {
    const repo = fx.repo('bidi', { files: { 'a.txt': 'a\n' } });
    for (const i of range(10)) fx.write(path.join(repo, '\u202egnp.exe', `f${i}`), 'x\n');
    const capped = createGitCore(fx.coreOptions({ maxListedUntracked: 3 }));
    try {
      const summary = await capped.getSummary(locator(repo));
      expect(summary.untrackedOmitted?.directories).toEqual([
        { path: '\u202egnp.exe', count: 10, ignoreLine: null, generated: false },
      ]);
    } finally {
      await capped.dispose();
    }
  });

  it('a file that is both a staged deletion and untracked counts once', async () => {
    const repo = fx.repo('dup', { files: { 'a.txt': 'a\n', 'build/kept.txt': 'k\n' } });
    fx.git(repo, ['rm', '-q', '--cached', '--', 'build/kept.txt']);
    for (const i of range(CAP + 5)) fx.write(path.join(repo, 'build', `n${i}.txt`), `${i}\n`);
    const summary = await core.getSummary(locator(repo));
    const reference = await full.getSummary(locator(repo));
    // build/kept.txt: one staged deletion; the other CAP + 5 untracked files are omitted.
    expect(summary.changedFiles).toBe(1 + CAP + 5);
    expect(summary.untrackedOmitted?.count).toBe(CAP + 5);
    expect(summary.changedFiles).toBe(reference.changedFiles);
    // The directory's count leaves the tracked row out too (Greptile on PR #91, P2): the notice
    // must not say 25 files are not listed, then 26 in build/.
    expect(summary.untrackedOmitted?.directories).toEqual([
      { path: 'build', count: CAP + 5, ignoreLine: '/build/', generated: true },
    ]);
  });
});

describe('numstat alongside the status of a full summary (#43)', () => {
  /** A git wrapper that logs every start and end, and holds `status` while `slow` exists. */
  function loggingCore(name: string, extra: Parameters<Fixture['coreOptions']>[0] = {}) {
    const log = path.join(fx.root, `${name}.log`);
    const slow = path.join(fx.root, `${name}.slow`);
    const wrapper = path.join(fx.root, `${name}.sh`);
    writeFileSync(log, '');
    writeFileSync(
      wrapper,
      [
        '#!/bin/sh',
        `echo "start $*" >> '${log}'`,
        'for a in "$@"; do',
        `  if [ "$a" = "status" ] && [ -e '${slow}' ]; then sleep 0.3; fi`,
        'done',
        'git "$@"',
        'rc=$?',
        `echo "end $*" >> '${log}'`,
        'exit $rc',
        '',
      ].join('\n'),
    );
    chmodSync(wrapper, 0o755);
    const c = createGitCore(fx.coreOptions({ gitBinary: wrapper, ...extra }));
    const lines = (): string[] => readFileSync(log, 'utf8').split('\n').filter(Boolean);
    return {
      core: c,
      lines,
      reset: () => writeFileSync(log, ''),
      slow: (on: boolean) => (on ? writeFileSync(slow, '') : rmSync(slow, { force: true })),
      /** Did a numstat start before the status ended (side by side)? And how many numstats? */
      shape: () => {
        const all = lines();
        const statusEnd = all.findIndex((l) => l.startsWith('end') && / status /.test(l));
        const numstats = all.filter((l) => l.startsWith('start') && l.includes('--numstat'));
        const firstNumstat = all.findIndex((l) => l.startsWith('start') && l.includes('--numstat'));
        return {
          alongside: firstNumstat >= 0 && statusEnd >= 0 && firstNumstat < statusEnd,
          numstats: numstats.length,
          commits: numstats.map((l) => l.split(' ').at(-2)),
        };
      },
    };
  }

  it('runs side by side once a kept state had tracked changes; reruns when HEAD moved', async () => {
    const repo = fx.repo('speculate', { files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
    const wt = locator(repo);
    const probe = loggingCore('speculate');
    try {
      fx.write(path.join(repo, 'a.txt'), 'a\nmore\n');
      probe.slow(true);
      await probe.core.getSummary(wt);
      // No kept state, small index: numstat after the status, as before.
      expect(probe.shape()).toMatchObject({ alongside: false, numstats: 1 });
      probe.reset();
      const warm = await probe.core.getSummary(wt);
      expect(probe.shape()).toMatchObject({ alongside: true, numstats: 1 });
      expect(warm.additions).toBe(1);
      // A commit (PR #91 P3-1): the guess is the new HEAD, read from the ref files, so a commit with
      // changes left costs one numstat, side by side, at the new commit.
      fx.write(path.join(repo, 'b.txt'), 'b\nb2\nb3\n');
      const head = fx.commitAll(repo, 'move');
      fx.write(path.join(repo, 'a.txt'), 'a\nmore\nand more\n');
      probe.reset();
      const moved = await probe.core.getSummary(wt);
      const shape = probe.shape();
      expect(shape).toMatchObject({ alongside: true, numstats: 1, commits: [head] });
      const { updatedAt: _a, refresh: _b, ...got } = moved;
      const { updatedAt: _c, refresh: _d, ...want } = await full.getSummary(wt);
      expect(got).toEqual(want);
      // HEAD moves while the status runs: the guess was the old HEAD, the status header says
      // otherwise, so numstat runs again at the new one; the result equals a full core's.
      probe.reset();
      const racing = probe.core.getSummary(wt);
      await new Promise((resolve) => setTimeout(resolve, 120));
      const raced = fx.commitAll(repo, 'during the status');
      fx.write(path.join(repo, 'a.txt'), 'a\nmore\nand more\nand again\n');
      const afterRace = await racing;
      const race = probe.shape();
      // The commit lands while the wrapper holds the status (300 ms), so the status sees it. The
      // ref files were read before it (two numstats); on a very slow runner perhaps after (one,
      // already at the new HEAD). Either way the numstat used is the new HEAD's.
      expect(afterRace.headSha).toBe(raced);
      expect(race.numstats).toBeGreaterThanOrEqual(1);
      expect(race.commits.at(-1)).toBe(raced);
      {
        const { updatedAt: _a, refresh: _b, ...got } = afterRace;
        const { updatedAt: _c, refresh: _d, ...want } = await full.getSummary(wt);
        expect(got).toEqual(want);
      }
      await probe.core.getSummary(wt);
      // Clean now: the speculative run is waited for and discarded.
      fx.git(repo, ['checkout', '-q', '--', '.']);
      probe.reset();
      const clean = await probe.core.getSummary(wt);
      expect(clean.changedFiles).toBe(0);
      expect(probe.shape().numstats).toBe(1);
    } finally {
      probe.slow(false);
      await probe.core.dispose();
    }
  });

  it('a first summary runs it side by side above the index size, HEAD from the ref files', async () => {
    const repo = fx.repo('speculate-cold', { files: { 'a.txt': 'a\n' } });
    fx.write(path.join(repo, 'a.txt'), 'a\nb\n');
    const wt = locator(repo);
    const saved = { ...summaryLimits };
    summaryLimits.speculateIndexBytes = 1;
    // a.txt was written just now: with the default margin its numstat record could predate an
    // edit during the summary, so it is diffed again (asserted below); without a margin its ctime,
    // older than the summary's start, is the proof.
    summaryLimits.settleMs = 0;
    const probe = loggingCore('speculate-cold');
    const off = loggingCore('speculate-off', { incremental: false });
    try {
      probe.slow(true);
      off.slow(true);
      const cold = await probe.core.getSummary(wt);
      expect(probe.shape()).toMatchObject({ alongside: true, numstats: 1 });
      expect(probe.shape().commits).toEqual([fx.git(repo, ['rev-parse', 'HEAD']).trim()]);
      expect(cold.additions).toBe(1);
      // The default margin, a new core (no kept state): a numstat of a.txt alone after the status.
      summaryLimits.settleMs = saved.settleMs;
      const fresh = loggingCore('speculate-cold-margin');
      try {
        fresh.slow(true);
        const again = await fresh.core.getSummary(wt);
        expect(fresh.shape()).toMatchObject({ alongside: true, numstats: 2 });
        expect(
          fresh
            .lines()
            .filter((l) => l.startsWith('start') && l.includes('--numstat'))
            .at(-1),
        ).toMatch(/-- a\.txt$/);
        expect(again.additions).toBe(1);
      } finally {
        fresh.slow(false);
        await fresh.core.dispose();
      }
      // The kill switch keeps the old calls exactly: never side by side.
      await off.core.getSummary(wt);
      await off.core.getSummary(wt);
      expect(off.shape()).toMatchObject({ alongside: false, numstats: 2 });
    } finally {
      Object.assign(summaryLimits, saved);
      probe.slow(false);
      off.slow(false);
      await probe.core.dispose();
      await off.core.dispose();
    }
  });

  // Greptile on PR #91 (P1): numstat runs alongside the status, so the pair is no snapshot. A file
  // edited after the numstat read it but before the status did must not lose its counts, now or in
  // the incremental refreshes after.
  describe('edits while numstat and status run', () => {
    /**
     * A git wrapper: while `armed` exists, the first numstat runs git, then holds its output until
     * `release`; every status waits for `edited` before it starts. The test edits in between.
     */
    function racingCore(name: string) {
      const dir = path.join(fx.root, `${name}.race`);
      mkdirSync(dir, { recursive: true });
      const f = (n: string) => path.join(dir, n);
      const wrapper = path.join(dir, 'git.sh');
      writeFileSync(
        wrapper,
        [
          '#!/bin/sh',
          'numstat=0; status=0',
          'for a in "$@"; do',
          '  [ "$a" = "--numstat" ] && numstat=1',
          '  [ "$a" = "status" ] && status=1',
          'done',
          `if [ $numstat = 1 ] && [ -e '${f('armed')}' ] && [ ! -e '${f('held')}' ]; then`,
          `  : > '${f('held')}'`,
          `  git "$@" > '${f('out')}'; rc=$?`,
          `  : > '${f('diff-done')}'`,
          `  while [ ! -e '${f('release')}' ]; do sleep 0.01; done`,
          `  cat '${f('out')}'; exit $rc`,
          'fi',
          `if [ $status = 1 ] && [ -e '${f('armed')}' ]; then`,
          `  while [ ! -e '${f('edited')}' ]; do sleep 0.01; done`,
          'fi',
          'exec git "$@"',
          '',
        ].join('\n'),
      );
      chmodSync(wrapper, 0o755);
      const waitFor = async (n: string) => {
        const deadline = Date.now() + 10_000;
        while (!existsSync(f(n))) {
          if (Date.now() > deadline) throw new Error(`no ${n}`);
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      return {
        core: createGitCore(fx.coreOptions({ gitBinary: wrapper })),
        arm: () => {
          for (const n of ['held', 'diff-done', 'release', 'edited', 'out'])
            rmSync(f(n), { force: true });
          writeFileSync(f('armed'), '');
        },
        disarm: () => rmSync(f('armed'), { force: true }),
        /** Waits until the held numstat has read the files, runs `edit`, lets status and numstat go. */
        during: async (edit: () => void) => {
          await waitFor('diff-done');
          edit();
          writeFileSync(f('edited'), '');
          writeFileSync(f('release'), '');
        },
      };
    }

    const comparable = (summary: SummaryResult) => {
      const { updatedAt: _u, refresh: _r, ...rest } = summary;
      return rest;
    };

    it('an edit after the numstat read but before the status counts, and stays counted', async () => {
      const repo = fx.repo('race', {
        files: { 'a.txt': 'a\n', 'b.txt': 'b\n', 'c.txt': 'c\n', 'd.txt': 'd\n' },
      });
      const wt = locator(repo);
      const race = racingCore('race');
      try {
        fx.write(path.join(repo, 'a.txt'), 'a\na2\n');
        await race.core.getSummary(wt, { snapshot: true });
        // The kept state had tracked changes: the next full summary runs numstat alongside.
        race.arm();
        const running = race.core.getSummary(wt, { snapshot: true });
        await race.during(() => {
          fx.write(path.join(repo, 'a.txt'), 'a\na2\na3\na4\n'); // already dirty, edited again
          fx.write(path.join(repo, 'b.txt'), 'b\nb2\nb3\n'); // newly dirty
          rmSync(path.join(repo, 'd.txt')); // deleted
        });
        const got = await running;
        race.disarm();
        const want = await full.getSummary(wt, { snapshot: true });
        expect(comparable(got)).toEqual(comparable(want));
        expect(got).toMatchObject({ changedFiles: 3, additions: 5, deletions: 1 });
        // An incremental refresh of another file keeps the totals right.
        fx.write(path.join(repo, 'c.txt'), 'c\nc2\n');
        const next = await race.core.getSummary(wt, { snapshot: true, changedPaths: ['c.txt'] });
        expect(comparable(next)).toEqual(comparable(await full.getSummary(wt, { snapshot: true })));
        expect(next).toMatchObject({ changedFiles: 4, additions: 6, deletions: 1 });
      } finally {
        race.disarm();
        await race.core.dispose();
      }
    });

    it('a file edited after the numstat read it is diffed again by the next incremental refresh', async () => {
      const repo = fx.repo('race-late', { files: { 'a.txt': 'a\n', 'b.txt': 'b\n' } });
      const wt = locator(repo);
      const race = racingCore('race-late');
      try {
        // A clean kept state: the next full summary runs numstat after the status, held here.
        await race.core.getSummary(wt);
        fx.write(path.join(repo, 'a.txt'), 'a\na2\n');
        race.arm();
        writeFileSync(path.join(fx.root, 'race-late.race', 'edited'), '');
        const running = race.core.getSummary(wt);
        await race.during(() => fx.write(path.join(repo, 'a.txt'), 'a\na2\na3\na4\n'));
        await running;
        race.disarm();
        // a.txt's event is lost: the next refresh names b.txt only, yet a.txt's counts are right,
        // because the kept state did not keep a.txt's newer signature as if it had been read.
        fx.write(path.join(repo, 'b.txt'), 'b\nb2\n');
        const next = await race.core.getSummary(wt, { changedPaths: ['b.txt'] });
        expect(comparable(next)).toEqual(comparable(await full.getSummary(wt)));
        expect(next).toMatchObject({ changedFiles: 2, additions: 4 });
      } finally {
        race.disarm();
        await race.core.dispose();
      }
    });

    it('a commit inside a submodule while the status runs is never trusted from ctimes', async () => {
      const repo = fx.repo('race-sub', { files: { 'a.txt': 'a\n' } });
      const sub = path.join(repo, 'sub');
      mkdirSync(sub);
      fx.git(sub, ['init', '-q']);
      fx.write(path.join(sub, 's.txt'), 's\n');
      fx.commitAll(sub, 'sub one');
      fx.git(repo, ['add', 'sub']);
      fx.git(repo, ['commit', '-q', '-m', 'add sub']);
      const wt = locator(repo);
      const saved = summaryLimits.settleMs;
      // No margin: every file is "old" by ctime, so only the gitlink rule keeps sub unproven.
      summaryLimits.settleMs = 0;
      const race = racingCore('race-sub');
      try {
        fx.write(path.join(repo, 'a.txt'), 'a\na2\n');
        await race.core.getSummary(wt);
        race.arm();
        const running = race.core.getSummary(wt);
        await race.during(() => {
          fx.write(path.join(sub, 's.txt'), 's\ns2\n');
          fx.commitAll(sub, 'sub two');
        });
        const got = await running;
        race.disarm();
        expect(comparable(got)).toEqual(comparable(await full.getSummary(wt)));
        expect(got.changedFiles).toBe(2);
      } finally {
        summaryLimits.settleMs = saved;
        race.disarm();
        await race.core.dispose();
      }
    });

    it('repeated edits while summaries run agree with a full summary', async () => {
      const repo = fx.repo('race-loop', {
        files: Object.fromEntries(range(6).map((i) => [`f${i}.txt`, `${i}\n`])),
      });
      const wt = locator(repo);
      const race = racingCore('race-loop');
      try {
        fx.write(path.join(repo, 'f0.txt'), '0\nchanged\n');
        await race.core.getSummary(wt);
        for (const round of range(8)) {
          race.arm();
          const running = race.core.getSummary(wt);
          await race.during(() => {
            const target = path.join(repo, `f${(round * 5) % 6}.txt`);
            fx.write(target, `${round}\n`.repeat(1 + (round % 3)));
            if (round % 4 === 3) fx.write(path.join(repo, 'f0.txt'), '0\n');
          });
          const got = await running;
          race.disarm();
          expect(comparable(got), `round ${round}`).toEqual(comparable(await full.getSummary(wt)));
          const other = `f${(round + 1) % 6}.txt`;
          fx.write(path.join(repo, other), `other ${round}\n`);
          const next = await race.core.getSummary(wt, { changedPaths: [other] });
          expect(comparable(next), `round ${round}, after`).toEqual(
            comparable(await full.getSummary(wt)),
          );
        }
      } finally {
        race.disarm();
        await race.core.dispose();
      }
    });
  });
});

// Greptile on PR #95: a caller labels a list with the state git-core says it listed.
describe('listChangedFilesWithState (#43 follow-up)', () => {
  it('reports the summary state it followed, or none and its own omission', async () => {
    const repo = heavyRepo('with-state');
    const wt = locator(repo);
    const summary = await core.getSummary(wt);
    const listWith = core.listChangedFilesWithState;
    if (!listWith) throw new Error('git-core lists with its state');
    // Built from the held state: that state, and the summary says what is omitted.
    const held = await listWith.call(
      core,
      wt,
      { kind: 'working' },
      { summaryState: summary.stateHash },
    );
    expect(held.summaryState).toBe(summary.stateHash);
    expect(held.untrackedOmitted).toBeUndefined();
    expect(held.files).toEqual(
      await listFiles(core, wt, { kind: 'working' }, { summaryState: summary.stateHash }),
    );
    // The worktree moved on: the held state is no longer git-core's latest.
    writeFileSync(path.join(repo, 'src', 'late.ts'), 'late\n');
    await core.getSummary(wt);
    const stale = await listWith.call(
      core,
      wt,
      { kind: 'working' },
      { summaryState: summary.stateHash },
    );
    expect(stale.summaryState).toBeNull();
    expect(stale.files.map((f) => f.path)).toContain('src/late.ts');
    // Its own omission: the same numbers as a summary of the same files.
    const now = await full.getSummary(wt);
    expect(stale.untrackedOmitted?.count).toBe(now.untrackedOmitted?.count);
    expect(stale.untrackedOmitted?.directories.map((d) => [d.path, d.count])).toEqual(
      now.untrackedOmitted?.directories.map((d) => [d.path, d.count]),
    );
    // A held state that is still the latest: reported, even where the list is built in full
    // (a committed scope), so a caller keeps caching it as that state's.
    const latestNow = await core.getSummary(wt);
    const branch = await listWith.call(
      core,
      wt,
      { kind: 'branch', base: 'main' },
      { summaryState: latestNow.stateHash },
    );
    expect(branch.summaryState).toBe(latestNow.stateHash);
    // Without any state asked for, and for a scope without untracked files: no omission.
    expect((await listWith.call(core, wt, { kind: 'working' })).summaryState).toBeNull();
    const staged = await listWith.call(core, wt, { kind: 'staged' });
    expect(staged).toMatchObject({ summaryState: null });
    expect(staged.untrackedOmitted).toBeUndefined();
  });
});
