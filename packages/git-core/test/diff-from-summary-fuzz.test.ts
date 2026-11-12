/**
 * Fuzz (#41): random sequences of worktree and git operations (the ones of `incremental-fuzz.test.ts`,
 * `helpers/fuzz-ops.ts`) on a real repository. After each step, the summary state of one git-core is
 * brought up to date from the paths the step touched, left behind (no summary at all this step), or
 * made to miss events (hints with fewer paths than were touched, silent edits). Then every changed
 * file of the scopes that read the worktree, and a few other paths, are asked of both that core (the
 * summary route where the state vouches for the file) and a reference core with no summary route
 * (`incremental: false`): the whole `GitFileDiff`, patch text and `patchHash` included, or the same
 * error, byte for byte, under random view options. A failure prints the seed and the steps so far:
 * rerun with FUZZ_SEED=<seed> (FUZZ_STEPS, FUZZ_VERBOSE as in the other fuzz).
 *
 * On a case-folding filesystem (macOS, `OCTOPUS_DIFF_TEST_FOLDS_CASE=1`) the summary route is off by
 * design (#288): the equality checks run all the same and no call may take it.
 */
import { cpSync } from 'node:fs';
import type { DiffOptions, DiffScope, GitCore, GitFileDiff } from '@octopus-diff/contracts';
import { isGitCoreError } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileDiffRoutes } from '../src/diff.js';
import { createGitCore } from '../src/index.js';
import { locator } from './helpers/core.js';
import { createFixture, type Fixture } from './helpers/fixture.js';
import { worktreesFoldCase } from './helpers/folds.js';
import {
  abs,
  BODIES,
  nextOp,
  PATHS,
  pick,
  prng,
  silentlyEdited,
  useUniverse,
} from './helpers/fuzz-ops.js';

const FOLDS = await worktreesFoldCase();
const STEPS = Number(process.env.FUZZ_STEPS ?? (process.platform === 'darwin' ? 25 : 60));
const SEEDS = process.env.FUZZ_SEED
  ? [Number(process.env.FUZZ_SEED)]
  : [0xd1ff01, 0xd1ff02, 0xd1ff03];
/** Files compared per step (the changed ones first, then random paths). */
const PER_STEP = 8;

let fx: Fixture;
let fast: GitCore;
let reference: GitCore;

beforeAll(() => {
  fx = createFixture('octopus-diff-dfs-fuzz-');
  fast = createGitCore(fx.coreOptions());
  reference = createGitCore(fx.coreOptions({ incremental: false }));
});

afterAll(async () => {
  await fast.dispose();
  await reference.dispose();
  fx.dispose();
});

function setupRepo(name: string, r: () => number): string {
  const repo = fx.repo(name, { files: { 'a.txt': BODIES[0]?.(r) ?? '', 'b.txt': 'b\n' } });
  for (const rel of ['dir/d.txt', 'dir/sub/f.txt', 'sp ace.txt', 'ünï/çödé.txt', 'c.txt']) {
    fx.write(abs(repo, rel), pick(r, BODIES)(r));
  }
  fx.commitAll(repo, 'second');
  fx.git(repo, ['branch', 'side']);
  fx.write(abs(repo, 'side-only.txt'), 'on main\n');
  fx.commitAll(repo, 'third');
  // Half of the repositories name a global excludes file the ops rewrite.
  if (r() < 0.5) fx.git(repo, ['config', 'core.excludesFile', `${repo}.excludes`]);
  return repo;
}

type Settled = { ok: GitFileDiff } | { error: string; message: string };

async function settle(call: Promise<GitFileDiff>): Promise<Settled> {
  try {
    return { ok: await call };
  } catch (error) {
    return isGitCoreError(error)
      ? { error: error.code, message: error.message }
      : { error: 'unexpected', message: String(error) };
  }
}

const VIEWS: Array<DiffOptions | undefined> = [
  undefined,
  undefined,
  undefined,
  { ignoreWhitespace: true },
  { contextLines: 0 },
  { contextLines: 12, ignoreWhitespace: true },
  { full: true },
];

async function runSeed(
  seed: number,
  cores: { fast: GitCore; reference: GitCore } = { fast, reference },
  planShapes = false,
): Promise<{ summary: number; compared: number }> {
  const r = prng(seed);
  silentlyEdited.length = 0;
  useUniverse(planShapes);
  const repo = setupRepo(`dfuzz-${seed.toString(16)}`, r);
  const wt = locator(repo);
  const root = fx.git(repo, ['rev-list', '--max-parents=0', 'HEAD']).trim();
  const log: string[] = [];
  const reasons = new Map<string, number>();
  const summaryBefore = fileDiffRoutes.summary;
  let compared = 0;
  await cores.fast.getSummary(wt);
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
    }
    // The state: brought up to date from the touched paths (a watcher), from fewer (events lost),
    // by a full summary, or not at all (the diff is asked before any summary has seen the step).
    const roll = r();
    let mode: string;
    if (roll < 0.15) mode = 'none';
    else if (roll < 0.25) mode = 'full';
    else if (roll < 0.35 && touched.size > 0) mode = 'fewer';
    else mode = 'exact';
    if (mode === 'full') await cores.fast.getSummary(wt);
    else if (mode === 'fewer') {
      const kept = [...touched].filter(() => r() < 0.4);
      await cores.fast.getSummary(wt, { changedPaths: kept });
    } else if (mode === 'exact') {
      await cores.fast.getSummary(wt, { changedPaths: lost ? [] : [...touched] });
    }
    const head = fx.git(repo, ['rev-parse', 'HEAD'], { allowFail: true }).trim();
    const scopes: DiffScope[] = [
      { kind: 'working' },
      { kind: 'review', base: root },
      ...(head ? [{ kind: 'review', base: head } as DiffScope] : []),
      { kind: 'branch', base: 'main', includeWorking: true },
    ];
    // Several scopes per step: the list of one of them names the files to ask for.
    const scope = pick(r, scopes);
    const listed = await cores.reference.listChangedFiles(wt, scope, { defaultBranch: 'main' });
    const candidates = new Set<string>(listed.map((file) => file.path));
    for (let i = 0; i < 3; i++) candidates.add(pick(r, PATHS));
    const picked = [...candidates].sort(() => r() - 0.5).slice(0, PER_STEP);
    for (const file of picked) {
      const options: DiffOptions = { defaultBranch: 'main', ...(pick(r, VIEWS) ?? {}) };
      const asked = `seed 0x${seed.toString(16)} step ${step} (${mode}) scope ${JSON.stringify(scope)} file ${JSON.stringify(file)} options ${JSON.stringify(options)}\n${log.slice(-12).join('\n')}`;
      const summaryNow = fileDiffRoutes.summary;
      const reasonsNow = new Map(fileDiffRoutes.reasons);
      const got = await settle(cores.fast.getFileDiff(wt, scope, { path: file }, options));
      if (fileDiffRoutes.summary === summaryNow) {
        for (const [reason, count] of fileDiffRoutes.reasons) {
          if (count !== (reasonsNow.get(reason) ?? 0)) {
            reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
          }
        }
      }
      const want = await settle(cores.reference.getFileDiff(wt, scope, { path: file }, options));
      compared++;
      if (process.env.FUZZ_DUMP && JSON.stringify(got) !== JSON.stringify(want)) {
        cpSync(repo, process.env.FUZZ_DUMP, { recursive: true });
        console.log('dumped', process.env.FUZZ_DUMP, asked.split('\n')[0]);
      }
      expect(got, asked).toEqual(want);
    }
  }
  if (process.env.FUZZ_VERBOSE) {
    console.log(
      `seed 0x${seed.toString(16)}: summary route ${fileDiffRoutes.summary - summaryBefore} of ${compared}; whole route:`,
      Object.fromEntries(reasons),
    );
  }
  return { summary: fileDiffRoutes.summary - summaryBefore, compared };
}

describe('getFileDiff from the summary state fuzz', () => {
  for (const seed of SEEDS) {
    it(`seed 0x${seed.toString(16)}: the summary route == the whole-scope route, byte for byte`, async () => {
      const { summary, compared } = await runSeed(seed);
      if (FOLDS) expect(summary).toBe(0);
      else {
        // The route must actually be taken often, or the test proves nothing.
        expect(compared).toBeGreaterThan(STEPS);
        expect(summary).toBeGreaterThan(compared / 10);
      }
    }, 240_000);
  }
  // #43: above `maxListedUntracked` untracked files are omitted (never inspected): the summary route
  // must refuse them and the whole route answer, with dependency/build-output shapes in the universe.
  for (const [seed, cap] of [
    [0xd1ca01, 1],
    [0xd1ca02, 2],
  ] as const) {
    it(`seed 0x${seed.toString(16)}: capped untracked files (maxListedUntracked ${cap})`, async () => {
      const cappedFast = createGitCore(fx.coreOptions({ maxListedUntracked: cap }));
      const cappedReference = createGitCore(
        fx.coreOptions({ maxListedUntracked: cap, incremental: false }),
      );
      try {
        const { summary, compared } = await runSeed(
          seed,
          { fast: cappedFast, reference: cappedReference },
          true,
        );
        if (FOLDS) expect(summary).toBe(0);
        else expect(summary).toBeGreaterThan(compared / 20);
      } finally {
        await cappedFast.dispose();
        await cappedReference.dispose();
      }
    }, 240_000);
  }
});
