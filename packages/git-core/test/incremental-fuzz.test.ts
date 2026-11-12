/**
 * Fuzz (#40): random sequences of worktree and git operations on a real repository. After each
 * step, one git-core updates its summary incrementally from exactly the paths the step touched
 * (what a watcher reports), another computes it in full; every field, the state hash and the
 * per-file snapshot must agree. The file lists of the scopes that read the worktree are checked
 * the same way. A failure prints the seed and the steps so far: rerun with FUZZ_SEED=<seed>.
 *
 * Git config is isolated (helpers/fixture.ts). Steps per seed: FUZZ_STEPS (default 120).
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { DiffScope, GitCore, SummaryResult } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listRefreshCounts, STATUS_ARGS } from '../src/diff.js';
import { createGitCore } from '../src/index.js';
import { parseStatusV2 } from '../src/parse/status.js';
import { canonicalStatusOutput } from '../src/summary.js';
import { locator } from './helpers/core.js';
import { createFixture, type Fixture } from './helpers/fixture.js';
import { FOLDING_SKIP, worktreesFoldCase } from './helpers/folds.js';
import {
  abs,
  BODIES,
  DIRS,
  nextOp,
  PATHS,
  pick,
  prng,
  silentlyEdited,
  useUniverse,
} from './helpers/fuzz-ops.js';

/** A case-folding filesystem gets full refreshes only (#288): equality still holds, trivially. */
const FOLDS = await worktreesFoldCase();
/** A skipped test's title says why. */
const skipped = (title: string): string => (FOLDS ? `${title} [skipped: ${FOLDING_SKIP}]` : title);

/**
 * macOS runs fewer steps: every refresh is full there (#288), so the check is cheap to make but
 * each step costs more git, and the macOS job has a 25-minute budget for every package.
 */
const STEPS = Number(process.env.FUZZ_STEPS ?? (process.platform === 'darwin' ? 40 : 120));
const SEEDS = process.env.FUZZ_SEED
  ? [Number(process.env.FUZZ_SEED)]
  : [0x5eed01, 0x5eed02, 0x5eed03, 0x5eed04];

/** Summary fields that must agree (`updatedAt` is a clock reading, `refresh` describes how). */
function comparable(summary: SummaryResult): Record<string, unknown> {
  const { updatedAt: _u, refresh: _r, ...rest } = summary;
  return rest;
}

/** Scopes that read the worktree; `review` gets the repository's first commit as its base. */
function scopesFor(base: string): DiffScope[] {
  return [{ kind: 'working' }, { kind: 'review', base }, { kind: 'branch', includeWorking: true }];
}

let fx: Fixture;
/** Repositories made so far (one seed may run twice, with different cores). */
let repoCount = 0;
let inc: GitCore;
let full: GitCore;

beforeAll(() => {
  fx = createFixture('octopus-diff-fuzz-');
  inc = createGitCore(fx.coreOptions());
  full = createGitCore(fx.coreOptions({ incremental: false }));
});

afterAll(async () => {
  await inc.dispose();
  await full.dispose();
  fx.dispose();
});

function setupRepo(name: string, r: () => number, extraConfig: string[][] = []): string {
  const repo = fx.repo(name, { files: { 'a.txt': BODIES[0]?.(r) ?? '', 'b.txt': 'b\n' } });
  for (const [key, value] of extraConfig) fx.git(repo, ['config', key as string, value as string]);
  for (const rel of ['dir/d.txt', 'dir/sub/f.txt', 'sp ace.txt', 'ünï/çödé.txt', 'c.txt']) {
    fx.write(abs(repo, rel), pick(r, BODIES)(r));
  }
  fx.commitAll(repo, 'second');
  fx.git(repo, ['branch', 'side']);
  fx.write(abs(repo, 'side-only.txt'), 'on main\n');
  fx.commitAll(repo, 'third');
  return repo;
}

/** git's raw status output equals the canonical rebuild (the state hash stays what it was). */
function checkCanonical(repo: string): void {
  const raw = spawnSync(
    'git',
    ['-c', 'core.quotePath=false', '--no-optional-locks', ...STATUS_ARGS],
    { cwd: repo, env: { ...process.env, ...fx.env, LC_ALL: 'C' } },
  );
  const output = raw.stdout.toString('latin1');
  const parsed = parseStatusV2(output);
  const byPath = (a: { path: string }, b: { path: string }) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  const of = (kinds: string[]) => parsed.entries.filter((e) => kinds.includes(e.kind)).sort(byPath);
  const sorted = [...of(['ordinary', 'renamed']), ...of(['unmerged']), ...of(['untracked'])];
  expect(canonicalStatusOutput(parsed.header, sorted)).toBe(output);
}

async function runSeed(
  seed: number,
  config: string[][] = [],
  cores: { inc: GitCore; full: GitCore; uncapped?: GitCore } = { inc, full },
  planShapes = false,
): Promise<{ incremental: number; hinted: number; omitted: number; omittedIncremental: number }> {
  const r = prng(seed);
  silentlyEdited.length = 0;
  useUniverse(planShapes);
  repoCount += 1;
  const repo = setupRepo(`fuzz-${seed.toString(16)}-${config.length}-${repoCount}`, r, config);
  const wt = locator(repo);
  const root = fx.git(repo, ['rev-list', '--max-parents=0', 'HEAD']).trim();
  const SCOPES = scopesFor(root);
  const log: string[] = [];
  let incremental = 0;
  /** Steps whose summary omitted untracked files (#43, `maxListedUntracked`). */
  let omitted = 0;
  let omittedIncremental = 0;
  /** Steps whose hint named at least one path (an empty hint is a full refresh by design). */
  let hinted = 0;
  const reasons = new Map<string, number>();
  // Baseline: the first summary has no state to update.
  let held = (await cores.inc.getSummary(wt, { snapshot: true })).stateHash;
  /**
   * A hint named fewer paths than the step touched (lost events): the incremental state may be
   * behind the files until a full summary reconciles it. Until then summaries and lists are not
   * compared; the reconciliation (blind) must then agree with a full core everywhere.
   */
  let stale = false;
  const hints = { exact: 0, more: 0, fewer: 0, reconciled: 0 };
  /** Review bases listed so far: their cached lists are checked again later. */
  const bases: string[] = [];
  for (const scope of SCOPES) await cores.inc.listChangedFiles(wt, scope);
  for (let step = 0; step < STEPS; step++) {
    const ops = 1 + Math.floor(r() * 3);
    const touched = new Set<string>();
    let lost = false;
    for (let i = 0; i < ops; i++) {
      const done = nextOp(r)(fx, repo, r);
      if (!done) continue;
      if (done.silent) lost = true;
      log.push(`${step}: ${done.name}`);
      for (const p of done.touched) touched.add(p);
      // Lists asked for while this step's events are still pending (PR #89 P1), between its
      // operations: read from the files after the last summary, with the held (now stale) state
      // or none at all. A later operation may undo what they saw before any summary does.
      for (const scope of SCOPES) {
        const roll = r();
        if (roll < 0.2) await cores.inc.listChangedFiles(wt, scope, { summaryState: held });
        else if (roll < 0.3) await cores.inc.listChangedFiles(wt, scope);
      }
      // And a review list against a base seeded before: an update that reads this step's files.
      if (bases.length > 0 && r() < 0.3) {
        const scope: DiffScope = { kind: 'review', base: pick(r, bases) };
        await cores.inc.listChangedFiles(wt, scope, { summaryState: held });
      }
    }
    const context = () => `seed 0x${seed.toString(16)} step ${step}\n${log.slice(-12).join('\n')}`;
    // The hint names exactly the touched paths, more (a watcher also reports what did not change
    // in git's eyes, or paths of other events), or fewer (events lost).
    const roll = r();
    let hint = [...touched];
    if (roll < 0.2) {
      hints.more++;
      const extra = 1 + Math.floor(r() * 3);
      for (let i = 0; i < extra; i++) hint.push(r() < 0.8 ? pick(r, PATHS) : pick(r, DIRS));
      hint = [...new Set(hint)];
    } else if (roll < 0.5 && hint.length > 0) {
      hints.fewer++;
      const kept = hint.filter(() => r() < 0.4);
      if (kept.length < hint.length) stale = true;
      hint = kept;
    } else hints.exact++;
    let reconciled = false;
    if (hint.length > 0) hinted++;
    let got = await cores.inc.getSummary(wt, { snapshot: true, changedPaths: hint });
    if (lost) stale = true;
    if (got.refresh?.mode === 'full') stale = false;
    if (stale && r() < 0.5) {
      // The daemon's reconciliation: a full summary, without a hint.
      hints.reconciled++;
      got = await cores.inc.getSummary(wt, { snapshot: true });
      stale = false;
      reconciled = true;
    }
    held = got.stateHash;
    if (stale) {
      // Lists of the stale state still get asked for and cached, to be checked after reconciling.
      for (const scope of SCOPES) {
        if (r() < 0.5) await cores.inc.listChangedFiles(wt, scope, { summaryState: got.stateHash });
      }
      // A seed of a review scope against a random commit, reading files whose events were lost
      // (PR #89 F1: what it read must still be checked after later updates and a blind summary).
      if (r() < 0.5) {
        const commits = fx
          .git(repo, ['rev-list', '--all'], { allowFail: true })
          .split('\n')
          .filter(Boolean);
        if (commits.length > 0) {
          bases.push(pick(r, commits));
          if (bases.length > 6) bases.shift();
          const base = pick(r, bases);
          await cores.inc.listChangedFiles(
            wt,
            { kind: 'review', base },
            { summaryState: got.stateHash },
          );
        }
      }
      if (step % 10 === 0) checkCanonical(repo);
      continue;
    }
    const want = await cores.full.getSummary(wt, { snapshot: true });
    if (got.refresh?.mode === 'incremental') incremental++;
    if (got.untrackedOmitted) omitted++;
    if (got.untrackedOmitted && cores.uncapped) {
      // The omission's numbers agree with each other and with an uncapped list (PR #91 review):
      // directory counts never exceed the total, and each is the untracked rows under it.
      const omission = got.untrackedOmitted;
      const counts = omission.directories.map((d) => d.count);
      expect(
        counts.reduce((a, b) => a + b, 0),
        context(),
      ).toBeLessThanOrEqual(omission.count);
      const rows = (await cores.uncapped.listChangedFiles(wt, { kind: 'working' })).filter(
        (f) => f.status === 'untracked',
      );
      for (const dir of omission.directories) {
        if (dir.rawPath !== undefined) continue;
        const under = rows.filter((f) => f.path.startsWith(`${dir.path}/`)).length;
        expect(dir.count, `${context()}\n${dir.path}`).toBe(under);
        expect(dir.count, `${context()}\n${dir.path}`).toBeGreaterThan(0);
      }
    }
    if (got.untrackedOmitted && got.refresh?.mode === 'incremental') omittedIncremental++;
    const why = got.refresh?.reason ?? got.refresh?.mode ?? 'none';
    reasons.set(why, (reasons.get(why) ?? 0) + 1);
    if (
      process.env.FUZZ_DUMP &&
      JSON.stringify(comparable(got)) !== JSON.stringify(comparable(want))
    ) {
      cpSync(repo, process.env.FUZZ_DUMP, { recursive: true });
      console.log('dumped', process.env.FUZZ_DUMP, JSON.stringify(got.refresh), [...touched]);
    }
    expect(comparable(got), `${context()}\nrefresh ${JSON.stringify(got.refresh)}`).toEqual(
      comparable(want),
    );
    // Lists are not asked for after every summary: the journal must cover several steps.
    for (const scope of SCOPES) {
      if (r() < 0.3) continue;
      const gotFiles = await cores.inc.listChangedFiles(wt, scope, { summaryState: got.stateHash });
      const wantFiles = await cores.full.listChangedFiles(wt, scope);
      expect(gotFiles, `${context()}\nscope ${scope.kind}`).toEqual(wantFiles);
    }
    // A review scope against a random commit of the history: mostly a list never asked for (seeded
    // from the summary's paths and the commit's diff-tree), sometimes one cached before.
    if (r() < 0.3) {
      const commits = fx
        .git(repo, ['rev-list', '--all'], { allowFail: true })
        .split('\n')
        .filter(Boolean);
      if (commits.length > 0) {
        // Mostly a base seeded while stale (now updated), sometimes a new one.
        const base = bases.length > 0 && r() < 0.7 ? pick(r, bases) : pick(r, commits);
        const scope: DiffScope = { kind: 'review', base };
        const gotFiles = await cores.inc.listChangedFiles(wt, scope, {
          summaryState: got.stateHash,
        });
        const wantFiles = await cores.full.listChangedFiles(wt, scope);
        expect(gotFiles, `${context()}\nscope review ${scope.base}`).toEqual(wantFiles);
      }
    }
    // After a reconciliation every review list seeded while stale must be right (PR #89 F1).
    if (reconciled) {
      for (const base of new Set(bases)) {
        const scope: DiffScope = { kind: 'review', base };
        const gotFiles = await cores.inc.listChangedFiles(wt, scope, {
          summaryState: got.stateHash,
        });
        const wantFiles = await cores.full.listChangedFiles(wt, scope);
        expect(gotFiles, `${context()}\nreconciled, review ${base}`).toEqual(wantFiles);
      }
    }
    if (step % 10 === 0) checkCanonical(repo);
  }
  if (process.env.FUZZ_VERBOSE) {
    console.log(
      `seed 0x${seed.toString(16)}`,
      Object.fromEntries(reasons),
      listRefreshCounts,
      hints,
    );
  }
  return { incremental, hinted, omitted, omittedIncremental };
}

describe('incremental summary fuzz', () => {
  for (const seed of SEEDS) {
    it(`seed 0x${seed.toString(16)}: incremental == full after every step`, async () => {
      const { incremental, hinted } = await runSeed(seed);
      // The hint must actually be used often, or the test proves nothing: in more than a fifth of
      // the steps whose hint names a path (empty ones, from lost events, are full by design). On a
      // folding filesystem it must never be (the equality checks above still ran every step).
      if (FOLDS) expect(incremental).toBe(0);
      else {
        expect(hinted).toBeGreaterThan(STEPS / 2);
        expect(incremental).toBeGreaterThan(hinted / 5);
      }
    }, 120_000);
  }

  it.skipIf(FOLDS)(
    skipped('core.ignorecase=true on a case-sensitive filesystem'),
    async () => {
      const { incremental, hinted } = await runSeed(0xca5e, [['core.ignorecase', 'true']]);
      expect(incremental).toBeGreaterThan(hinted / 5);
    },
    120_000,
  );

  // #43: above `maxListedUntracked` untracked files are counted, not inspected or listed. With a cap
  // of 2 the fuzz's few untracked files cross it all the time and the omission plan keeps changing
  // (directories, then a cut in path order): summaries, snapshots and lists must still equal a full
  // core's with the same cap after every step.
  const capped: ReadonlyArray<readonly [number, number]> = process.env.FUZZ_SEED
    ? [
        [Number(process.env.FUZZ_SEED), 1],
        [Number(process.env.FUZZ_SEED), 2],
      ]
    : [
        [0xca9001, 1],
        [0xca9002, 1],
        [0xca9003, 2],
      ];
  for (const [seed, cap] of capped) {
    it(`seed 0x${seed.toString(16)}: capped untracked files (maxListedUntracked ${cap})`, async () => {
      const cappedInc = createGitCore(fx.coreOptions({ maxListedUntracked: cap }));
      const cappedFull = createGitCore(
        fx.coreOptions({ maxListedUntracked: cap, incremental: false }),
      );
      const uncapped = createGitCore(fx.coreOptions({ maxListedUntracked: 100_000 }));
      try {
        const result = await runSeed(
          seed,
          [],
          { inc: cappedInc, full: cappedFull, uncapped },
          true,
        );
        // The capped mode must really be exercised, and incrementally.
        expect(result.omitted).toBeGreaterThan(STEPS / 10);
        if (FOLDS) expect(result.incremental).toBe(0);
        else {
          expect(result.incremental).toBeGreaterThan(result.hinted / 5);
          // A cap of 2 is crossed less often: some capped incremental steps, not a share.
          expect(result.omittedIncremental).toBeGreaterThan(cap === 1 ? STEPS / 20 : 0);
        }
      } finally {
        await cappedInc.dispose();
        await cappedFull.dispose();
        await uncapped.dispose();
      }
    }, 120_000);
  }

  it('the directory tree used by the fuzz exists', () => {
    // Guards the helpers above against silently doing nothing (an empty universe).
    const repo = fx.repo('fuzz-guard', { files: { 'a.txt': 'a\n' } });
    expect(readdirSync(repo)).toContain('a.txt');
    expect(existsSync(path.join(repo, '.git'))).toBe(true);
  });
});
