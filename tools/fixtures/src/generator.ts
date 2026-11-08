import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { BuildContext } from './builder.js';
import { createIsolatedGitEnv, type IsolatedGitEnv, READ_ONLY_GIT_ARGS, runGit } from './git.js';
import {
  type FixtureManifest,
  MANIFEST_VERSION,
  type ProjectFixture,
  type ScanRootFixture,
  type WorktreeFixture,
} from './manifest.js';
import {
  absoluteGitDir,
  aheadBehind,
  commitFiles,
  commonGitDir,
  countsFromStatus,
  fixtureId,
  inProgressOperation,
  listCommits,
  listWorktrees,
  type OracleOptions,
  readStatus,
  scopeFiles,
} from './oracle.js';
import { createRng } from './random.js';
import {
  type BenchLayoutOptions,
  buildAlpha,
  buildBare,
  buildBenchRepo,
  buildConflict,
  buildEmpty,
  buildKitchenSink,
  buildLive,
  buildRootOnly,
  buildScanLayout,
  type ProjectSpec,
  scenarioPaths,
} from './scenarios.js';

export interface GenerateOptions {
  /** PRNG seed: same seed → same file contents and commit shas (default 1). */
  seed?: number;
  /** Parent directory (default `os.tmpdir()`); the fixture root is a `mkdtemp` inside it. */
  parentDir?: string;
  /** mkdtemp prefix (default `octopus-diff-`). */
  prefix?: string;
  /**
   * The acceptance layout: alpha/beta/gamma/epsilon, kitchen-sink with every special case,
   * conflict, root-only, empty, bare, and the mutable `live` project (default true).
   */
  acceptance?: boolean;
  /** The perf-bench layout (N repos × M worktrees), or false (default). */
  bench?: Partial<BenchLayoutOptions> | false;
  /** Size of the very large text file (default 4 MiB). */
  largeFileBytes?: number;
  /** Size of the minified one-line file (default 256 KiB). */
  minifiedBytes?: number;
  /** Write `manifest.json` into the fixture root (default true). */
  writeManifest?: boolean;
}

export interface FixtureSet {
  readonly root: string;
  readonly manifest: FixtureManifest;
  readonly env: IsolatedGitEnv;
  /** `<root>/manifest.json` (written unless `writeManifest: false`). */
  readonly manifestPath: string;
  /** Re-derives one worktree's expectations from git after a test mutated it. */
  describeWorktree(name: string): Promise<WorktreeFixture>;
  /** Deletes the fixture root. Safe to call twice. */
  cleanup(): Promise<void>;
}

export const DEFAULT_BENCH: BenchLayoutOptions = {
  repos: 30,
  worktreesPerRepo: 3,
  filesPerRepo: 40,
  dirtyFilesPerWorktree: 3,
};

/** Refuses to delete anything that is not a direct child of the OS temp dir (or `parentDir`). */
export async function removeFixtureRoot(root: string, parentDir = tmpdir()): Promise<void> {
  const parent = await realpath(parentDir).catch(() => parentDir);
  const resolved = await realpath(root).catch(() => null);
  if (resolved === null) return;
  if (!resolved.startsWith(parent + sep) || resolved.slice(parent.length + 1).includes(sep)) {
    throw new Error(`refusing to delete ${resolved}: not a direct child of ${parent}`);
  }
  await rm(resolved, { recursive: true, force: true });
}

export async function generateFixtures(options: GenerateOptions = {}): Promise<FixtureSet> {
  const seed = options.seed ?? 1;
  const parentDir = options.parentDir ?? tmpdir();
  const root = await realpath(await mkdtemp(join(parentDir, options.prefix ?? 'octopus-diff-')));
  try {
    const env = await createIsolatedGitEnv(root);
    const ctx = new BuildContext(env, createRng(seed));
    const paths = scenarioPaths(root);
    for (const dir of [paths.repos, paths.worktrees, paths.sources, paths.scan]) {
      await mkdir(dir, { recursive: true });
    }

    const specs: ProjectSpec[] = [];
    const scanRoots: ScanRootFixture[] = [];
    const sources: string[] = [];
    if (options.acceptance ?? true) {
      specs.push(await buildAlpha(ctx, paths));
      const scan = await buildScanLayout(ctx, paths);
      specs.push(...scan.specs);
      scanRoots.push({
        path: paths.scan,
        depth: scan.depth,
        expectedProjects: scan.specs.map((s) => s.name),
        excludedRepoPaths: scan.excludedRepoPaths,
        symlinkLoops: scan.symlinkLoops,
      });
      specs.push(
        await buildKitchenSink(ctx, paths, {
          largeFileBytes: options.largeFileBytes ?? 4 * 1024 * 1024,
          minifiedBytes: options.minifiedBytes ?? 256 * 1024,
        }),
      );
      specs.push(await buildConflict(ctx, paths));
      specs.push(await buildRootOnly(ctx, paths));
      specs.push(await buildEmpty(ctx, paths));
      specs.push(await buildBare(ctx, paths));
      specs.push(await buildLive(ctx, paths));
      sources.push(join(paths.sources, 'alpha-origin.git'), join(paths.sources, 'lib'));
      sources.push(join(paths.sources, 'bare-seed'));
    }
    if (options.bench) {
      const bench = { ...DEFAULT_BENCH, ...options.bench };
      await mkdir(paths.bench, { recursive: true });
      for (let i = 0; i < bench.repos; i++) specs.push(await buildBenchRepo(ctx, paths, i, bench));
    }

    const oracle: OracleOptions = { env };
    const projects: ProjectFixture[] = [];
    for (const spec of specs) projects.push(await describeProject(oracle, spec));
    for (const source of sources) projects.push(await describeSource(oracle, source));

    // Stat-dirty bait in every control worktree (see addStatDirtyBait).
    for (const project of projects) {
      if (project.role !== 'control') continue;
      for (const worktree of project.worktrees) {
        if (!worktree.bare) await addStatDirtyBait(oracle, worktree);
      }
    }

    const manifest: FixtureManifest = {
      version: MANIFEST_VERSION,
      seed,
      root,
      createdAt: new Date().toISOString(),
      git: { configPath: env.configPath, vars: { ...env.vars } },
      projects,
      scanRoots,
      registerPaths: projects
        .filter((p) => p.registration?.kind === 'path')
        .map((p) => (p.registration as { path: string }).path),
    };
    const manifestPath = join(root, 'manifest.json');
    if (options.writeManifest ?? true) await writeManifestFile(manifestPath, manifest);

    const specsByWorktree = new Map<string, ProjectSpec>();
    for (const spec of specs)
      for (const n of Object.values(spec.worktreeNames)) specsByWorktree.set(n, spec);
    let cleaned = false;
    return {
      root,
      manifest,
      env,
      manifestPath,
      async describeWorktree(name) {
        const spec = specsByWorktree.get(name);
        if (!spec) throw new Error(`unknown fixture worktree: ${name}`);
        const project = await describeProject(oracle, spec);
        const worktree = project.worktrees.find((w) => w.name === name);
        if (!worktree) throw new Error(`worktree ${name} disappeared`);
        return worktree;
      },
      async cleanup() {
        if (cleaned) return;
        cleaned = true;
        await removeFixtureRoot(root, parentDir);
      },
    };
  } catch (error) {
    await removeFixtureRoot(root, parentDir).catch(() => {});
    throw error;
  }
}

/**
 * Makes one tracked, unmodified file stat-dirty (old mtime, same content). A `git status`
 * that is allowed to take optional locks would then refresh and rewrite `.git/index`, which
 * the read-only proof detects; `--no-optional-locks` leaves it alone.
 */
async function addStatDirtyBait(oracle: OracleOptions, worktree: WorktreeFixture): Promise<void> {
  if (worktree.headSha === null) return;
  const changed = new Set(worktree.status.map((e) => e.path));
  const result = await runGit([...READ_ONLY_GIT_ARGS, 'ls-files', '-z', '-s'], {
    cwd: worktree.path,
    env: oracle.env,
    extraEnv: { GIT_OPTIONAL_LOCKS: '0' },
  });
  for (const record of result.stdout.toString('utf8').split('\0')) {
    const match = /^100644 [0-9a-f]+ 0\t(.+)$/.exec(record);
    if (!match?.[1] || changed.has(match[1]) || /[^\x20-\x7e]/.test(match[1])) continue;
    const old = new Date('2020-01-01T00:00:00Z');
    await utimes(join(worktree.path, match[1]), old, old);
    return;
  }
}

export async function writeManifestFile(path: string, manifest: FixtureManifest): Promise<void> {
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function readManifestFile(path: string): Promise<FixtureManifest> {
  const manifest = JSON.parse(await readFile(path, 'utf8')) as FixtureManifest;
  if (manifest.version !== MANIFEST_VERSION) {
    throw new Error(`unsupported fixture manifest version ${manifest.version} in ${path}`);
  }
  return manifest;
}

async function describeSource(oracle: OracleOptions, dir: string): Promise<ProjectFixture> {
  const commonDir = await commonGitDir(oracle, dir);
  const bare = commonDir === (await realpath(dir));
  const name = dir.split(sep).pop() ?? dir;
  return {
    name: `source:${name}`,
    id: fixtureId(commonDir),
    role: 'source',
    commonDir,
    mainWorktreePath: bare ? null : await realpath(dir),
    bare,
    defaultBranch: 'main',
    registration: null,
    worktrees: [],
    cases: {},
  };
}

async function describeProject(oracle: OracleOptions, spec: ProjectSpec): Promise<ProjectFixture> {
  const commonDir = await commonGitDir(oracle, spec.locator);
  const names = new Map<string, string>();
  for (const [path, name] of Object.entries(spec.worktreeNames))
    names.set(await realpath(path), name);
  const listed = await listWorktrees(oracle, spec.locator);
  const worktrees: WorktreeFixture[] = [];
  for (const [index, entry] of listed.entries()) {
    const path = await realpath(entry.path);
    const name = names.get(path);
    if (!name) throw new Error(`fixture spec ${spec.name} does not name worktree ${path}`);
    const isMain = index === 0;
    if (entry.bare) {
      worktrees.push({
        name,
        id: fixtureId(path),
        path,
        isMain,
        bare: true,
        branch: null,
        detached: false,
        headSha: null,
        upstream: null,
        counts: { staged: 0, unstaged: 0, untracked: 0, conflicted: 0 },
        changedFiles: 0,
        dirty: false,
        inProgress: null,
        status: [],
        scopes: {},
        commits: [],
      });
      continue;
    }
    worktrees.push(await describeCheckout(oracle, spec, { path, name, isMain }));
  }
  const main = worktrees.find((w) => w.isMain && !w.bare);
  return {
    name: spec.name,
    id: fixtureId(commonDir),
    role: spec.role,
    commonDir,
    mainWorktreePath: main?.path ?? null,
    bare: worktrees.some((w) => w.bare),
    defaultBranch: spec.defaultBranch,
    registration: spec.registration,
    worktrees,
    cases: spec.cases ?? {},
  };
}

async function describeCheckout(
  oracle: OracleOptions,
  spec: ProjectSpec,
  wt: { path: string; name: string; isMain: boolean },
): Promise<WorktreeFixture> {
  const status = await readStatus(oracle, wt.path);
  const counts = countsFromStatus(status.entries);
  const working = await scopeFiles(oracle, wt.path, { kind: 'working' }, status);
  const staged = await scopeFiles(oracle, wt.path, { kind: 'staged' }, status);
  const unstaged = await scopeFiles(oracle, wt.path, { kind: 'unstaged' }, status);
  const scopes: WorktreeFixture['scopes'] = { working, staged, unstaged };

  let aheadBehindRef: string | null | undefined = null;
  let ahead: number | null | undefined = null;
  let behind: number | null | undefined = null;
  if (status.upstream) {
    aheadBehindRef = status.upstream;
    ahead = status.ahead;
    behind = status.behind;
  } else if (status.detached) {
    // The contract doesn't pin this down for detached HEADs: don't assert.
    aheadBehindRef = undefined;
    ahead = undefined;
    behind = undefined;
  } else if (spec.defaultBranch && status.head !== spec.defaultBranch && status.oid) {
    const ab = await aheadBehind(oracle, wt.path, spec.defaultBranch);
    if (ab) {
      aheadBehindRef = spec.defaultBranch;
      ahead = ab.ahead;
      behind = ab.behind;
    }
  }
  if (spec.defaultBranch && status.oid && status.head !== spec.defaultBranch) {
    scopes.branch = await scopeFiles(
      oracle,
      wt.path,
      { kind: 'branch', base: spec.defaultBranch },
      status,
    );
  }

  const commits = await listCommits(oracle, wt.path);
  for (const commit of commits) {
    if (spec.describeCommits?.includes(commit.sha)) {
      commit.files = await commitFiles(oracle, wt.path, commit.sha);
    }
  }

  return {
    name: wt.name,
    id: fixtureId(wt.path),
    path: wt.path,
    isMain: wt.isMain,
    bare: false,
    branch: status.head,
    detached: status.detached,
    headSha: status.oid,
    upstream: status.upstream,
    aheadBehindRef,
    ahead,
    behind,
    counts,
    changedFiles: working.length,
    dirty: working.length > 0,
    inProgress: inProgressOperation(await absoluteGitDir(oracle, wt.path)),
    status: status.entries,
    scopes,
    commits,
  };
}
