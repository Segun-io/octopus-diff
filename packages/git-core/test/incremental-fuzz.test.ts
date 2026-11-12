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
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
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

/** mulberry32: small, seedable, good enough for picking operations. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The path universe: spaces, unicode, a newline, nesting, an ignored pattern, a binary. */
const PATHS = [
  'a.txt',
  'b.txt',
  'c.txt',
  'dir/d.txt',
  'dir/e.txt',
  'dir/sub/f.txt',
  'other/g.txt',
  'sp ace.txt',
  'ünï/çödé.txt',
  'new\nline.txt',
  'bin.dat',
  'x.log',
  'ign/y.txt',
  'Case.txt',
  'case.txt',
];
const DIRS = ['dir', 'dir/sub', 'other', 'ünï', 'ign', 'fresh', 'fresh/deep'];

const BODIES = [
  (r: () => number) =>
    Array.from({ length: 20 }, (_, i) => `shared line ${i}\n`).join('') +
    `tail ${Math.floor(r() * 4)}\n`,
  (r: () => number) => `short ${Math.floor(r() * 3)}\n`,
  (r: () => number) =>
    Array.from(
      { length: 8 + Math.floor(r() * 8) },
      (_, i) => `row ${i} ${Math.floor(r() * 2)}\n`,
    ).join(''),
];

interface Step {
  name: string;
  /** Its events are lost: no hint will ever name what it changed (PR #89 F1). */
  silent?: boolean;
  /** Worktree paths a watcher would report (null: a git operation; hint stays the paths touched). */
  touched: string[];
}

type Op = (fx: Fixture, repo: string, r: () => number) => Step | null;

const pick = <T>(r: () => number, list: readonly T[]): T =>
  list[Math.floor(r() * list.length)] as T;
const abs = (repo: string, rel: string): string => path.join(repo, rel);
const exists = (p: string): boolean => {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
};

/** Creates missing parent directories; returns the topmost one created (a watcher reports it). */
function ensureParent(repo: string, rel: string): string | null {
  const parts = rel.split('/').slice(0, -1);
  let created: string | null = null;
  for (let i = 1; i <= parts.length; i++) {
    const dir = parts.slice(0, i).join('/');
    const full = abs(repo, dir);
    if (exists(full) && !lstatSync(full).isDirectory()) return 'blocked';
    if (!exists(full)) {
      mkdirSync(full);
      created ??= dir;
    }
  }
  return created;
}

function writeFile(repo: string, rel: string, content: string | Buffer): Step | null {
  const created = ensureParent(repo, rel);
  if (created === 'blocked') return null;
  const full = abs(repo, rel);
  if (exists(full) && lstatSync(full).isDirectory()) return null;
  if (exists(full) && lstatSync(full).isSymbolicLink()) rmSync(full);
  writeFileSync(full, content);
  return { name: `write ${JSON.stringify(rel)}`, touched: created ? [created, rel] : [rel] };
}

const git = (fx: Fixture, repo: string, args: string[]): void => {
  fx.git(repo, args, { allowFail: true });
};

/** Paths edited by a silent op in the current seed: a silent restore mostly undoes one of them. */
const silentlyEdited: string[] = [];

const OPS: Array<[number, Op]> = [
  [
    1,
    (_fx, repo, r) => {
      // An edit whose events are lost.
      const rel = pick(r, PATHS);
      const done = writeFile(repo, rel, pick(r, BODIES)(r));
      if (done) silentlyEdited.push(rel);
      return done ? { name: `silent ${done.name}`, touched: [], silent: true } : null;
    },
  ],
  [
    1,
    (fx, repo, r) => {
      // Back to HEAD's content, events lost too: what a list read mid-edit must not keep.
      const rel = silentlyEdited.length > 0 && r() < 0.8 ? pick(r, silentlyEdited) : pick(r, PATHS);
      const shown = spawnSync('git', ['show', `HEAD:${rel}`], {
        cwd: repo,
        env: { ...process.env, ...fx.env, LC_ALL: 'C' },
      });
      if (shown.status !== 0) return null;
      const done = writeFile(repo, rel, shown.stdout);
      return done
        ? { name: `silent restore ${JSON.stringify(rel)}`, touched: [], silent: true }
        : null;
    },
  ],
  [6, (_fx, repo, r) => writeFile(repo, pick(r, PATHS), pick(r, BODIES)(r))],
  [
    2,
    (_fx, repo, r) => {
      const rel = pick(r, PATHS);
      return writeFile(repo, rel, Buffer.from([0, 1, 2, Math.floor(r() * 255), 0, 10]));
    },
  ],
  [
    3,
    (fx, repo, r) => {
      // Back to HEAD's content by a plain write (no index change): a clean file again, which is
      // what leaves a phantom row in a list read while the edit was pending (PR #89 P1).
      const rel = pick(r, PATHS);
      const shown = spawnSync('git', ['show', `HEAD:${rel}`], {
        cwd: repo,
        env: { ...process.env, ...fx.env, LC_ALL: 'C' },
      });
      if (shown.status !== 0) return null;
      return writeFile(repo, rel, shown.stdout);
    },
  ],
  [
    3,
    (_fx, repo, r) => {
      const rel = pick(r, PATHS);
      const full = abs(repo, rel);
      if (!exists(full) || lstatSync(full).isDirectory()) return null;
      rmSync(full);
      return { name: `delete ${JSON.stringify(rel)}`, touched: [rel] };
    },
  ],
  [
    3,
    (_fx, repo, r) => {
      const from = pick(r, PATHS);
      const to = pick(r, PATHS);
      if (from === to || !exists(abs(repo, from)) || lstatSync(abs(repo, from)).isDirectory()) {
        return null;
      }
      const created = ensureParent(repo, to);
      if (
        created === 'blocked' ||
        (exists(abs(repo, to)) && lstatSync(abs(repo, to)).isDirectory())
      ) {
        return null;
      }
      renameSync(abs(repo, from), abs(repo, to));
      return {
        name: `rename ${JSON.stringify(from)} -> ${JSON.stringify(to)}`,
        touched: created ? [created, from, to] : [from, to],
      };
    },
  ],
  [
    1,
    (_fx, repo, r) => {
      const rel = pick(r, PATHS);
      const full = abs(repo, rel);
      if (!exists(full) || !lstatSync(full).isFile()) return null;
      chmodSync(full, lstatSync(full).mode & 0o100 ? 0o644 : 0o755);
      return { name: `chmod ${JSON.stringify(rel)}`, touched: [rel] };
    },
  ],
  [
    1,
    (_fx, repo, r) => {
      const rel = pick(r, PATHS);
      const full = abs(repo, rel);
      if (!exists(full) || lstatSync(full).isDirectory()) return null;
      const t = new Date(Date.now() - Math.floor(r() * 100_000));
      lutimesSync(full, t, t);
      return { name: `touch ${JSON.stringify(rel)}`, touched: [rel] };
    },
  ],
  [
    1,
    (_fx, repo, r) => {
      const rel = pick(r, PATHS);
      const created = ensureParent(repo, rel);
      const full = abs(repo, rel);
      if (created === 'blocked' || (exists(full) && lstatSync(full).isDirectory())) return null;
      if (exists(full)) rmSync(full);
      symlinkSync(pick(r, ['a.txt', 'missing', '../outside']), full);
      return { name: `symlink ${JSON.stringify(rel)}`, touched: created ? [created, rel] : [rel] };
    },
  ],
  [
    1,
    (_fx, repo, r) => {
      const dir = pick(r, DIRS);
      const full = abs(repo, dir);
      if (exists(full)) {
        rmSync(full, { recursive: true, force: true });
        return { name: `rm -rf ${dir}`, touched: [dir] };
      }
      const created = ensureParent(repo, `${dir}/x`);
      if (created === 'blocked') return null;
      writeFileSync(path.join(full, 'made.txt'), 'made in a new directory\n');
      return { name: `mkdir ${dir} + file`, touched: [created ?? dir, `${dir}/made.txt`] };
    },
  ],
  [
    1,
    (_fx, repo, r) => {
      const rules = pick(r, ['*.log\n', '*.log\nign/\n', 'ign/\n*.dat\n', '']);
      writeFileSync(abs(repo, '.gitignore'), rules);
      return { name: `.gitignore = ${JSON.stringify(rules)}`, touched: ['.gitignore'] };
    },
  ],
  [
    1,
    (fx, repo, r) => {
      const exclude = path.join(repo, '.git', 'info', 'exclude');
      mkdirSync(path.dirname(exclude), { recursive: true });
      writeFileSync(exclude, pick(r, ['', 'b.txt\n', 'other/\n']));
      void fx;
      return { name: 'info/exclude', touched: [] };
    },
  ],
  // Git operations: the index or HEAD changes (the daemon would see git-dir events and refresh
  // in full; git-core must notice on its own when handed a path hint anyway).
  [
    3,
    (fx, repo, r) => {
      const rel = pick(r, PATHS);
      git(fx, repo, ['add', '--', rel]);
      return { name: `git add ${JSON.stringify(rel)}`, touched: [] };
    },
  ],
  [
    1,
    (fx, repo, r) => {
      const rel = pick(r, PATHS);
      git(fx, repo, ['add', '-N', '--', rel]);
      return { name: `git add -N ${JSON.stringify(rel)}`, touched: [] };
    },
  ],
  [
    2,
    (fx, repo, r) => {
      const rel = pick(r, PATHS);
      git(fx, repo, ['reset', '-q', '--', rel]);
      return { name: `git reset ${JSON.stringify(rel)}`, touched: [] };
    },
  ],
  [
    1,
    (fx, repo, r) => {
      const rel = pick(r, PATHS);
      git(fx, repo, ['rm', '-q', '--cached', '--', rel]);
      return { name: `git rm --cached ${JSON.stringify(rel)}`, touched: [] };
    },
  ],
  [
    1,
    (fx, repo, r) => {
      const from = pick(r, PATHS);
      const to = pick(r, PATHS);
      ensureParent(repo, to);
      git(fx, repo, ['mv', '-k', '--', from, to]);
      return { name: `git mv ${JSON.stringify(from)} ${JSON.stringify(to)}`, touched: [from, to] };
    },
  ],
  [
    2,
    (fx, repo, r) => {
      if (r() < 0.5) git(fx, repo, ['add', '-A']);
      git(fx, repo, ['commit', '-q', '-m', 'step']);
      return { name: 'git commit', touched: [] };
    },
  ],
  [
    1,
    (fx, repo, r) => {
      const branch = pick(r, ['main', 'side']);
      git(fx, repo, ['checkout', '-q', '-f', branch]);
      return { name: `git checkout -f ${branch}`, touched: PATHS.slice(0, 4) };
    },
  ],
  [
    1,
    (fx, repo, r) => {
      // HEAD moves, the index stays: only the status header tells.
      const branch = pick(r, ['main', 'side']);
      git(fx, repo, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
      return { name: `git symbolic-ref HEAD ${branch}`, touched: [pick(r, PATHS)] };
    },
  ],
  [
    1,
    (fx, repo, r) => {
      if (r() < 0.5) git(fx, repo, ['stash', 'push', '-q', '-u']);
      else git(fx, repo, ['stash', 'pop', '-q']);
      return { name: 'git stash', touched: PATHS.slice(0, 3) };
    },
  ],
];
const WEIGHT = OPS.reduce((sum, [w]) => sum + w, 0);

function nextOp(r: () => number): Op {
  let x = r() * WEIGHT;
  for (const [w, op] of OPS) {
    x -= w;
    if (x < 0) return op;
  }
  return (OPS[0] as [number, Op])[1];
}

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
  cores: { inc: GitCore; full: GitCore } = { inc, full },
): Promise<{ incremental: number; hinted: number; omitted: number; omittedIncremental: number }> {
  const r = prng(seed);
  silentlyEdited.length = 0;
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
      try {
        const result = await runSeed(seed, [], { inc: cappedInc, full: cappedFull });
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
