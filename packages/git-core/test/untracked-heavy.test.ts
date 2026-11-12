import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  type GitCore,
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
    // 98 - 5 = 93 > 50: node_modules first; then 48 - 5 = 43 <= 45: the deepest, dist/assets.
    expect([...plan.dirs]).toEqual([
      ['node_modules', 50],
      ['dist/assets', 45],
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
    expect(ignoreLineFor('scratch/many')).toBe('/scratch/many/');
    expect(ignoreLineFor('packages/a/node_modules/.pnpm')).toBe('node_modules/');
    expect(ignoreLineFor('packages/a/dist/assets')).toBe('/packages/a/dist/');
    expect(ignoreLineFor('we*rd [dir]')).toBe('/we\\*rd \\[dir]/');
    expect(ignoreLineFor('new\nline')).toBeNull();
    const keys = [...files('big', 40), ...files('small', 2)];
    const plan = planUntracked(keys, 5);
    if (!plan) throw new Error('expected a plan');
    const omission = UntrackedOmissionSchema.parse(omissionOf(plan));
    expect(omission).toEqual({
      count: 40,
      limit: 5,
      directories: [{ path: 'big', count: 40, ignoreLine: '/big/' }],
    });
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
      directories: [{ path: 'build', count: 100, ignoreLine: '/build/' }],
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
      // HEAD moved: the speculative run used the old HEAD, so numstat runs again at the new one.
      fx.write(path.join(repo, 'b.txt'), 'b\nb2\nb3\n');
      const head = fx.commitAll(repo, 'move');
      fx.write(path.join(repo, 'a.txt'), 'a\nmore\nand more\n');
      probe.reset();
      const moved = await probe.core.getSummary(wt);
      const shape = probe.shape();
      expect(shape.numstats).toBe(2);
      expect(shape.commits.at(-1)).toBe(head);
      const { updatedAt: _a, refresh: _b, ...got } = moved;
      const { updatedAt: _c, refresh: _d, ...want } = await full.getSummary(wt);
      expect(got).toEqual(want);
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
    const saved = summaryLimits.speculateIndexBytes;
    summaryLimits.speculateIndexBytes = 1;
    const probe = loggingCore('speculate-cold');
    const off = loggingCore('speculate-off', { incremental: false });
    try {
      probe.slow(true);
      off.slow(true);
      const cold = await probe.core.getSummary(wt);
      expect(probe.shape()).toMatchObject({ alongside: true, numstats: 1 });
      expect(probe.shape().commits).toEqual([fx.git(repo, ['rev-parse', 'HEAD']).trim()]);
      expect(cold.additions).toBe(1);
      // The kill switch keeps the old calls exactly: never side by side.
      await off.core.getSummary(wt);
      await off.core.getSummary(wt);
      expect(off.shape()).toMatchObject({ alongside: false, numstats: 2 });
    } finally {
      summaryLimits.speculateIndexBytes = saved;
      probe.slow(false);
      off.slow(false);
      await probe.core.dispose();
      await off.core.dispose();
    }
  });
});
