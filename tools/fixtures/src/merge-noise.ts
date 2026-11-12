import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BuildContext, RepoBuilder } from './builder.js';
import { removeFixtureRoot } from './generator.js';
import { createIsolatedGitEnv, type IsolatedGitEnv, runGit } from './git.js';
import type { FixtureManifest } from './manifest.js';
import { fixtureId } from './oracle.js';
import { createRng } from './random.js';

/**
 * Merge-noise scenarios (roadmap #35, step 14 of #24): the situations the "From main" group of the
 * To review list is made for. An opt-in scenario set of its own: `generateFixtures()` and its
 * manifests are untouched, so no other spec or bench changes its counts.
 *
 * Two small projects, built in **two stages** because the daemon starts a worktree's review
 * bookmark where the branch is at first sight (the merge-base, or HEAD on the default branch):
 *
 * 1. `generateMergeNoise()` creates the repositories and the feature worktrees, all still at the
 *    base commit. Register the projects and let the daemon see them (a review summary per worktree).
 * 2. `commitOwnWork()` gives every feature branch its own commits; `integrate()` then moves the
 *    default branch and brings it into the features the way each scenario says: a clean merge, a
 *    resolved conflict, a merge of a file both sides changed, a cherry-pick, and (remote project) a
 *    rebase onto `origin/main` while the local `main` stays stale. `fetchMovesOrigin()` is the
 *    later `git fetch` that relabels a file.
 *
 * Everything is real git under the isolated config (AGENTS.md): `origin` is a bare repository next
 * to the project, filled by clone / push / fetch between temp dirs, no network. Content and commit
 * dates are fixed, so the shas are the same on every run.
 */

export interface MergeNoiseWorktree {
  /** Short role: `merge`, `conflict`, `mixed`, `pick`, `rebase`, `fix`, or `main`. */
  readonly role: MergeNoiseRole;
  readonly path: string;
  /** Expected `WorktreeId` (`hashId(realpath)`). */
  readonly id: string;
  readonly branch: string;
}

export type MergeNoiseRole = 'main' | 'merge' | 'conflict' | 'mixed' | 'pick' | 'rebase' | 'fix';

export interface MergeNoiseProject {
  readonly name: string;
  /** The main checkout (the path to register). */
  readonly dir: string;
  /** Expected `ProjectId`. */
  readonly id: string;
  readonly worktrees: Readonly<Record<string, MergeNoiseWorktree>>;
}

/**
 * What the To review list of each worktree must show once `integrate()` ran (after the daemon
 * saw the worktrees at the base commit): the daemon's labels, spelled out. `own` = files without a
 * label, `mixed` = both sides changed (tag `+main`), `base` = what the default branch brought,
 * `via` = how, `ref` = the integration ref of the group's label.
 */
export interface ExpectedNoise {
  readonly own: readonly string[];
  readonly mixed: readonly string[];
  readonly base: readonly string[];
  readonly via: 'merge' | 'rebase' | 'same-as-base';
  readonly ref: string;
}

export const MERGE_NOISE_EXPECTED = {
  /** `noise-local` has no remote: the default branch is the local `main`. */
  merge: {
    own: ['src/feature-merge-a.ts', 'src/feature-merge-b.ts'],
    mixed: [],
    base: [
      'docs/changelog.md',
      'src/conflict.txt',
      'src/hotfix.txt',
      'src/main-util.ts',
      'src/mixed.txt',
    ],
    via: 'merge',
    ref: 'main',
  },
  /** A conflict in `src/conflict.txt` (both sides changed line 2), resolved by hand. */
  conflict: {
    own: ['src/feature-conflict.ts'],
    mixed: ['src/conflict.txt'],
    base: ['docs/changelog.md', 'src/hotfix.txt', 'src/main-util.ts', 'src/mixed.txt'],
    via: 'merge',
    ref: 'main',
  },
  /** `src/mixed.txt`: this branch changed line 15, `main` line 3; git merged it without help. */
  mixed: {
    own: ['src/feature-mixed.ts'],
    mixed: ['src/mixed.txt'],
    base: ['docs/changelog.md', 'src/conflict.txt', 'src/hotfix.txt', 'src/main-util.ts'],
    via: 'merge',
    ref: 'main',
  },
  /** `git cherry-pick` of main's `src/hotfix.txt` commit: the file is main's, same content. */
  pick: {
    own: ['src/feature-pick.ts'],
    mixed: [],
    base: ['src/hotfix.txt'],
    via: 'same-as-base',
    ref: 'main',
  },
  /** `noise-remote`: rebased onto `origin/main`; the local `main` is still the base commit. */
  rebase: {
    own: ['src/feature-rebase.ts'],
    mixed: [],
    base: ['docs/upstream.md', 'src/upstream-api.ts'],
    via: 'rebase',
    ref: 'origin/main',
  },
} as const satisfies Record<string, ExpectedNoise>;

/** What `noise-remote`'s `fix` worktree has after `fetchMovesOrigin()`: its `src/fix.txt` landed upstream. */
export const MERGE_NOISE_AFTER_FETCH = {
  own: ['src/feature-fix.ts'],
  base: ['src/fix.txt'],
  via: 'same-as-base',
  ref: 'origin/main',
} as const;

/** Own files `fix` has before the fetch (both are its own work). */
export const MERGE_NOISE_BEFORE_FETCH_FIX = ['src/feature-fix.ts', 'src/fix.txt'] as const;

/** The unreviewed files each worktree of `noise-local` counts, own work only (base files excluded). */
export const MERGE_NOISE_OWN_COUNTS = {
  /** main: M1 (2 files), M2 (1), M3 (2 files) since its first sight. */
  main: 5,
  merge: 2,
  /** One own file and the mixed one. */
  conflict: 2,
  mixed: 2,
  pick: 1,
} as const;

export interface MergeNoiseSet {
  readonly root: string;
  readonly env: IsolatedGitEnv;
  readonly local: MergeNoiseProject;
  readonly remote: MergeNoiseProject;
  /** The bare repository behind `noise-remote`'s `origin`. */
  readonly originDir: string;
  /** Stage 2a: one or two own commits on every feature branch. */
  commitOwnWork(): Promise<void>;
  /** Stage 2b: main moves; the features take it the way their scenario says. Needs `commitOwnWork()`. */
  integrate(): Promise<void>;
  /**
   * A `git fetch` that moves `origin/main` in `noise-remote`: another clone pushes a commit that
   * contains the same `src/fix.txt` as the `fix` worktree's own commit, then `fetch` runs in the
   * project. The local `main` does not move.
   */
  fetchMovesOrigin(): Promise<void>;
  cleanup(): Promise<void>;
}

const lines = (tag: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}`);

/** `lines` with line `at` (1-based) replaced. */
function withLine(base: string[], at: number, text: string): string[] {
  const out = [...base];
  out[at - 1] = text;
  return out;
}

const MIXED_BASE = lines('mixed', 20);
const CONFLICT_BASE = lines('conflict', 10);

export interface GenerateMergeNoiseOptions {
  parentDir?: string;
  prefix?: string;
}

export async function generateMergeNoise(
  options: GenerateMergeNoiseOptions = {},
): Promise<MergeNoiseSet> {
  const parent = options.parentDir ?? tmpdir();
  const root = await realpath(await mkdtemp(join(parent, options.prefix ?? 'octopus-diff-noise-')));
  try {
    const env = await createIsolatedGitEnv(root);
    const ctx = new BuildContext(env, createRng(35));
    return await build(root, parent, env, ctx);
  } catch (error) {
    await removeFixtureRoot(root, parent).catch(() => {});
    throw error;
  }
}

async function build(
  root: string,
  parent: string,
  env: IsolatedGitEnv,
  ctx: BuildContext,
): Promise<MergeNoiseSet> {
  // --- noise-local: no remote, the default branch is the local `main` -------------------------
  const localDir = join(root, 'noise-local');
  const localWt = join(root, 'noise-local-worktrees');
  await mkdir(localWt, { recursive: true });
  const local = await RepoBuilder.init(ctx, localDir);
  await local.writeLines('README.md', ['# noise-local', 'a scratch project for merge noise']);
  await local.writeLines('src/mixed.txt', MIXED_BASE);
  await local.writeLines('src/conflict.txt', CONFLICT_BASE);
  await local.commitAll('noise-local: base');
  const localRoles = ['merge', 'conflict', 'mixed', 'pick'] as const;
  const localBuilders = new Map<string, RepoBuilder>();
  for (const role of localRoles) {
    localBuilders.set(
      role,
      await local.addWorktree(join(localWt, role), {
        newBranch: `feature/${role}`,
        commitish: 'main',
      }),
    );
  }

  // --- noise-remote: a bare origin, a stale local main ----------------------------------------
  const remoteDir = join(root, 'noise-remote');
  const remoteWt = join(root, 'noise-remote-worktrees');
  const originDir = join(root, 'noise-remote-origin.git');
  const upstreamDir = join(root, 'noise-remote-upstream');
  await mkdir(remoteWt, { recursive: true });
  const remote = await RepoBuilder.init(ctx, remoteDir);
  await remote.writeLines('README.md', ['# noise-remote', 'has an origin']);
  await remote.writeLines('src/app.ts', lines('app', 10));
  await remote.commitAll('noise-remote: base');
  await runGit(['clone', '-q', '--bare', remoteDir, originDir], { cwd: root, env });
  await remote.git(['remote', 'add', 'origin', originDir]);
  await remote.git(['fetch', '-q', 'origin']);
  await remote.git(['branch', '-q', '--set-upstream-to=origin/main', 'main']);
  await runGit(['clone', '-q', originDir, upstreamDir], { cwd: root, env });
  const upstream = new RepoBuilder(ctx, upstreamDir);
  const remoteRoles = ['rebase', 'fix'] as const;
  const remoteBuilders = new Map<string, RepoBuilder>();
  for (const role of remoteRoles) {
    remoteBuilders.set(
      role,
      await remote.addWorktree(join(remoteWt, role), {
        newBranch: `feature/${role}`,
        commitish: 'main',
      }),
    );
  }

  const wt = (role: MergeNoiseRole, path: string): MergeNoiseWorktree => ({
    role,
    path,
    id: fixtureId(path),
    branch: role === 'main' ? 'main' : `feature/${role}`,
  });
  const localProject: MergeNoiseProject = {
    name: 'noise-local',
    dir: localDir,
    id: fixtureId(join(localDir, '.git')),
    worktrees: {
      main: wt('main', localDir),
      ...Object.fromEntries(localRoles.map((r) => [r, wt(r, join(localWt, r))])),
    },
  };
  const remoteProject: MergeNoiseProject = {
    name: 'noise-remote',
    dir: remoteDir,
    id: fixtureId(join(remoteDir, '.git')),
    worktrees: {
      main: wt('main', remoteDir),
      ...Object.fromEntries(remoteRoles.map((r) => [r, wt(r, join(remoteWt, r))])),
    },
  };

  const builder = (map: Map<string, RepoBuilder>, role: string): RepoBuilder => {
    const b = map.get(role);
    if (!b) throw new Error(`no worktree ${role}`);
    return b;
  };

  return {
    root,
    env,
    local: localProject,
    remote: remoteProject,
    originDir,
    async commitOwnWork() {
      const merge = builder(localBuilders, 'merge');
      await merge.writeLines('src/feature-merge-a.ts', lines('merge a', 6));
      await merge.commitAll('feature/merge: a');
      await merge.writeLines('src/feature-merge-b.ts', lines('merge b', 6));
      await merge.commitAll('feature/merge: b');

      const conflict = builder(localBuilders, 'conflict');
      await conflict.writeLines('src/feature-conflict.ts', lines('conflict', 6));
      await conflict.writeLines(
        'src/conflict.txt',
        withLine(CONFLICT_BASE, 2, 'conflict line 2 (feature)'),
      );
      await conflict.commitAll('feature/conflict: own work and line 2');

      const mixed = builder(localBuilders, 'mixed');
      await mixed.writeLines('src/feature-mixed.ts', lines('mixed', 6));
      await mixed.writeLines('src/mixed.txt', withLine(MIXED_BASE, 15, 'mixed line 15 (feature)'));
      await mixed.commitAll('feature/mixed: own work and line 15');

      const pick = builder(localBuilders, 'pick');
      await pick.writeLines('src/feature-pick.ts', lines('pick', 6));
      await pick.commitAll('feature/pick: own work');

      const rebase = builder(remoteBuilders, 'rebase');
      await rebase.writeLines('src/feature-rebase.ts', lines('rebase', 6));
      await rebase.commitAll('feature/rebase: own work');

      const fix = builder(remoteBuilders, 'fix');
      await fix.writeLines('src/feature-fix.ts', lines('fix', 6));
      await fix.writeLines('src/fix.txt', ['fixed']);
      await fix.commitAll('feature/fix: own work and the fix');
    },
    async integrate() {
      // The default branch moves: three commits on `main` (M1, M2, M3).
      await local.writeLines('docs/changelog.md', ['# changelog', 'main moved']);
      await local.writeLines('src/main-util.ts', lines('util', 5));
      await local.commitAll('main: changelog and util');
      await local.writeLines('src/hotfix.txt', ['hotfix']);
      const hotfix = await local.commitAll('main: hotfix');
      await local.writeLines('src/mixed.txt', withLine(MIXED_BASE, 3, 'mixed line 3 (main)'));
      await local.writeLines(
        'src/conflict.txt',
        withLine(CONFLICT_BASE, 2, 'conflict line 2 (main)'),
      );
      await local.commitAll('main: mixed line 3 and conflict line 2');

      await builder(localBuilders, 'merge').git(['merge', '-q', '--no-edit', 'main']);

      const conflict = builder(localBuilders, 'conflict');
      await conflict.git(['merge', '-q', '--no-edit', 'main'], { allowFailure: true });
      // Resolved by hand: both lines survive.
      await conflict.writeLines(
        'src/conflict.txt',
        withLine(CONFLICT_BASE, 2, 'conflict line 2 (main and feature)'),
      );
      await conflict.git(['add', '--', 'src/conflict.txt']);
      await conflict.git(['commit', '-q', '--no-verify', '--no-edit']);

      await builder(localBuilders, 'mixed').git(['merge', '-q', '--no-edit', 'main']);
      await builder(localBuilders, 'pick').git(['cherry-pick', hotfix]);

      // noise-remote: two commits land on origin/main; the local main stays at the base commit.
      await upstream.writeLines('docs/upstream.md', ['# upstream', 'landed on origin/main']);
      await upstream.writeLines('src/upstream-api.ts', lines('api', 5));
      await upstream.commitAll('origin/main: upstream docs and api');
      await upstream.git(['push', '-q', 'origin', 'main']);
      await remote.git(['fetch', '-q', 'origin']);
      await builder(remoteBuilders, 'rebase').git(['rebase', '-q', 'origin/main']);
    },
    async fetchMovesOrigin() {
      await upstream.git(['pull', '-q', '--ff-only', 'origin', 'main']);
      await upstream.writeLines('src/fix.txt', ['fixed']);
      await upstream.commitAll('origin/main: the same fix');
      await upstream.git(['push', '-q', 'origin', 'main']);
      await remote.git(['fetch', '-q', 'origin']);
    },
    cleanup: () => removeFixtureRoot(root, parent),
  };
}

// --- bench: a fetch that moves origin/main in every repository ----------------------------------

export interface BenchOrigins {
  /** Repositories that got an `origin`, and the linked worktrees that merged it. */
  readonly repos: number;
  readonly linkedWorktrees: number;
  /**
   * A `git fetch` that moves `origin/main` in every repository: the upstream clone pushes one
   * commit (round N: `docs/upstream-round-N.md`, plus every linked worktree's own file with the
   * same content, so each of them has one file that turns from own to "same as main"), then `fetch`
   * runs in each repository. Local `main` never moves. Run it before the daemon starts (a cold
   * start after a fetch) or while it runs (every worktree's labels are invalidated at once).
   */
  fetchMovesOrigin(round: number): Promise<{ ms: number }>;
}

export interface BenchOriginsOptions {
  /** How many repositories are prepared at once. */
  concurrency?: number;
}

/** The own file the linked worktree `name` commits (and that round 2 of the fetch lands upstream). */
export function benchOwnFile(worktreeName: string): string {
  return `src/own-${worktreeName}.ts`;
}

/**
 * Opt-in for the perf bench (`generateFixtures({ bench })` is unchanged): gives every bench
 * repository a bare `origin` (clone / push / fetch under `root`, no network), commits one own file in
 * every linked worktree, pushes a first upstream commit and merges `origin/main` into the linked
 * worktrees (local `main` stays stale), so each of them has merge noise from `origin/main`. The
 * worktrees keep their dirty files; the merges touch only new files.
 */
export async function addBenchOrigins(
  manifest: Pick<FixtureManifest, 'projects'>,
  env: IsolatedGitEnv,
  root: string,
  options: BenchOriginsOptions = {},
): Promise<BenchOrigins> {
  const ctx = new BuildContext(env, createRng(36));
  const projects = manifest.projects.filter((p) => p.role === 'bench' && p.mainWorktreePath);
  const originsDir = join(root, 'bench-origins');
  await mkdir(originsDir, { recursive: true });
  interface Repo {
    main: RepoBuilder;
    upstream: RepoBuilder;
    linked: Array<{ name: string; builder: RepoBuilder }>;
  }
  const repos: Repo[] = [];
  await mapLimit(projects, options.concurrency ?? 6, async (project) => {
    const dir = project.mainWorktreePath as string;
    const originDir = join(originsDir, `${project.name}.git`);
    const upstreamDir = join(originsDir, `${project.name}-upstream`);
    const main = new RepoBuilder(ctx, dir);
    await runGit(['clone', '-q', '--bare', dir, originDir], { cwd: originsDir, env });
    await main.git(['remote', 'add', 'origin', originDir]);
    await main.git(['fetch', '-q', 'origin']);
    await runGit(['clone', '-q', originDir, upstreamDir], { cwd: originsDir, env });
    const upstream = new RepoBuilder(ctx, upstreamDir);
    const linked: Repo['linked'] = [];
    for (const worktree of project.worktrees) {
      if (worktree.isMain || worktree.bare) continue;
      const builder = new RepoBuilder(ctx, worktree.path);
      // Staged explicitly: the worktree's dirty files stay dirty.
      await builder.writeLines(benchOwnFile(worktree.name), ['own work', worktree.name]);
      await builder.add(benchOwnFile(worktree.name));
      await builder.commit(`${worktree.name}: own work`);
      linked.push({ name: worktree.name, builder });
    }
    await upstream.writeLines('docs/upstream.md', ['# upstream', project.name]);
    await upstream.commitAll(`${project.name}: upstream docs`);
    await upstream.git(['push', '-q', 'origin', 'main']);
    await main.git(['fetch', '-q', 'origin']);
    for (const { builder } of linked)
      await builder.git(['merge', '-q', '--no-edit', 'origin/main']);
    repos.push({ main, upstream, linked });
  });
  return {
    repos: repos.length,
    linkedWorktrees: repos.reduce((n, r) => n + r.linked.length, 0),
    async fetchMovesOrigin(round) {
      const started = performance.now();
      await mapLimit(repos, options.concurrency ?? 6, async (repo) => {
        await repo.upstream.git(['pull', '-q', '--ff-only', 'origin', 'main']);
        await repo.upstream.writeLines(`docs/upstream-round-${round}.md`, ['round', String(round)]);
        if (round >= 2) {
          for (const { name } of repo.linked) {
            await repo.upstream.writeLines(benchOwnFile(name), ['own work', name]);
          }
        }
        await repo.upstream.commitAll(`upstream: round ${round}`);
        await repo.upstream.git(['push', '-q', 'origin', 'main']);
        await repo.main.git(['fetch', '-q', 'origin']);
      });
      return { ms: Math.round(performance.now() - started) };
    },
  };
}

/** Runs `task` over `items` with bounded concurrency; the first failure rejects. */
async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      await task(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
