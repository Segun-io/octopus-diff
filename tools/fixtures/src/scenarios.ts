import { readFile, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { type BuildContext, RepoBuilder } from './builder.js';
import type { CaseLocation, RepoRole, SpecialCase } from './manifest.js';
import { codeLines, type Rng, word } from './random.js';

/**
 * What a scenario tells the generator about a repository it built. The generator turns this
 * into a `ProjectFixture` by asking git (oracle) for the actual state.
 *
 * Rule for every scenario: never leave a *wholly* untracked directory (git collapses those to
 * `dir/` unless `--untracked-files=all`), so file-level expectations don't depend on that flag.
 */
export interface ProjectSpec {
  name: string;
  role: RepoRole;
  /** Any directory of the repository (main worktree, or the git dir for bare repos). */
  locator: string;
  registration: { kind: 'path'; path: string } | { kind: 'scan'; scanRoot: string } | null;
  defaultBranch: string | null;
  /** Absolute worktree path → fixture name. The main worktree / bare entry included. */
  worktreeNames: Record<string, string>;
  cases?: Partial<Record<SpecialCase, CaseLocation>>;
  /** Commits whose file list should be recorded in the manifest (commit-scope tests). */
  describeCommits?: string[];
}

export interface ScenarioPaths {
  root: string;
  repos: string;
  worktrees: string;
  sources: string;
  scan: string;
  bench: string;
}

export function scenarioPaths(root: string): ScenarioPaths {
  return {
    root,
    repos: join(root, 'repos'),
    worktrees: join(root, 'worktrees'),
    sources: join(root, 'sources'),
    scan: join(root, 'scan'),
    bench: join(root, 'bench'),
  };
}

function marker(name: string): string {
  return `octopus-marker-${name}`;
}

async function seedFiles(repo: RepoBuilder, rng: Rng, files: Record<string, number>) {
  for (const [rel, lines] of Object.entries(files)) {
    await repo.writeLines(rel, codeLines(rng, lines));
  }
}

/** Rewrites one line of a generated file (keeps the others), returning the new content lines. */
async function editLine(
  repo: RepoBuilder,
  rel: string,
  lines: string[],
  index: number,
  text: string,
) {
  const copy = [...lines];
  copy[index] = text;
  await repo.writeLines(rel, copy);
  return copy;
}

// ---------------------------------------------------------------------------------------------
// alpha: origin with ahead/behind, two linked worktrees (feature/login, agent/refactor)
// ---------------------------------------------------------------------------------------------

export async function buildAlpha(ctx: BuildContext, paths: ScenarioPaths): Promise<ProjectSpec> {
  const rng = ctx.rng.fork('alpha');
  const dir = join(paths.repos, 'alpha');
  const repo = await RepoBuilder.init(ctx, dir);
  const app = codeLines(rng, 60);
  await repo.writeLines('src/app.ts', app);
  await seedFiles(repo, rng, {
    'src/util.ts': 30,
    'README.md': 12,
    'docs/guide.md': 25,
    'test/app.test.ts': 20,
  });
  await repo.commitAll('initial commit');
  await repo.writeLines('src/config.ts', codeLines(rng, 15));
  await repo.commitAll('add config');

  // origin: a local bare repo in the fixture dir.
  const originDir = join(paths.sources, 'alpha-origin.git');
  await RepoBuilder.init(ctx, originDir, { bare: true });
  await repo.git(['remote', 'add', 'origin', originDir]);
  await repo.git(['push', '-q', '-u', 'origin', 'main']);
  // A commit that only origin has (behind = 1).
  await repo.git(['checkout', '-q', '--detach']);
  await repo.writeLines('docs/remote.md', codeLines(rng, 8));
  await repo.commitAll('remote-only change');
  await repo.git(['push', '-q', 'origin', 'HEAD:main']);
  await repo.git(['checkout', '-q', 'main']);
  await repo.git(['remote', 'set-head', 'origin', 'main']);

  const app3 = await editLine(repo, 'src/app.ts', app, 5, 'export const featureFlags = true;');
  await repo.commitAll('feature flags');
  await repo.git(['branch', 'feature/login']);
  await repo.writeLines('src/util.ts', codeLines(rng, 32));
  await repo.commitAll('tune util');
  // main: ahead 2 (feature flags, tune util), behind 1 (remote-only change).

  // feature/login branched before "tune util": ahead 2, behind 1 vs main.
  const loginPath = join(paths.worktrees, 'alpha-login');
  const login = await repo.addWorktree(loginPath, { branch: 'feature/login' });
  const loginLines = codeLines(rng, 40);
  await login.writeLines('src/login.ts', loginLines);
  await login.commitAll('login form');
  await editLine(login, 'src/app.ts', app3, 10, 'export const loginEnabled = true;');
  await login.commitAll('wire login');
  await editLine(login, 'src/login.ts', loginLines, 3, `// ${marker('alpha-login-unstaged')}`);
  await login.writeLines('src/login.test.ts', [
    `// ${marker('alpha-login-untracked')}`,
    ...codeLines(rng, 6),
  ]);

  // agent/refactor from main: ahead 1, behind 0; staged + unstaged work in progress.
  const refactorPath = join(paths.worktrees, 'alpha-refactor');
  const refactor = await repo.addWorktree(refactorPath, {
    newBranch: 'agent/refactor',
    commitish: 'main',
  });
  await refactor.writeLines('src/refactor-plan.md', codeLines(rng, 10));
  await refactor.commitAll('refactor plan');
  await refactor.writeLines('src/config.ts', [
    `// ${marker('alpha-refactor-staged')}`,
    ...codeLines(rng, 15),
  ]);
  await refactor.add('src/config.ts');
  await refactor.writeLines('docs/guide.md', [
    `# ${marker('alpha-refactor-unstaged')}`,
    ...codeLines(rng, 20),
  ]);

  // Main worktree: one unstaged edit, one staged new file.
  await repo.writeLines('README.md', [`# ${marker('alpha-main-readme')}`, ...codeLines(rng, 12)]);
  await repo.writeLines('src/feature.ts', [
    `// ${marker('alpha-main-feature')}`,
    ...codeLines(rng, 9),
  ]);
  await repo.add('src/feature.ts');

  return {
    name: 'alpha',
    role: 'control',
    locator: dir,
    registration: { kind: 'path', path: dir },
    defaultBranch: 'main',
    worktreeNames: { [dir]: 'alpha', [loginPath]: 'alpha-login', [refactorPath]: 'alpha-refactor' },
  };
}

// ---------------------------------------------------------------------------------------------
// Scan-root layout: beta (depth 1, detached linked worktree), gamma (depth 3, `master`),
// epsilon (clean), plus node_modules, too-deep repo and symlink loops that must be skipped.
// ---------------------------------------------------------------------------------------------

export interface ScanLayout {
  specs: ProjectSpec[];
  excludedRepoPaths: string[];
  symlinkLoops: string[];
  depth: number;
}

export async function buildScanLayout(
  ctx: BuildContext,
  paths: ScenarioPaths,
): Promise<ScanLayout> {
  const rng = ctx.rng.fork('scan');
  const scanRoot = paths.scan;
  const registration = { kind: 'scan' as const, scanRoot };

  // beta
  const betaDir = join(scanRoot, 'beta');
  const beta = await RepoBuilder.init(ctx, betaDir);
  const betaMain = codeLines(rng, 50);
  await beta.writeLines('lib/main.py', betaMain);
  await seedFiles(beta, rng, { 'lib/obsolete.py': 20, 'setup.cfg': 8 });
  await beta.commitAll('beta: initial');
  await beta.writeLines('lib/extra.py', codeLines(rng, 12));
  await beta.commitAll('beta: extra');
  await editLine(beta, 'lib/main.py', betaMain, 1, 'VERSION = "1.1"');
  await beta.commitAll('beta: bump version');
  const detachedPath = join(paths.worktrees, 'beta-detached');
  const detached = await beta.addWorktree(detachedPath, { detach: true, commitish: 'HEAD~1' });
  await detached.writeLines('lib/extra.py', [
    `# ${marker('beta-detached-edit')}`,
    ...codeLines(rng, 12),
  ]);
  await beta.remove('lib/obsolete.py');
  await editLine(beta, 'lib/main.py', betaMain, 20, `# ${marker('beta-main-edit')}`);

  // gamma: three levels deep, default branch `master` (tests the main/master/trunk fallback).
  const gammaDir = join(scanRoot, 'nested', 'deeper', 'gamma');
  const gamma = await RepoBuilder.init(ctx, gammaDir, { branch: 'master' });
  await seedFiles(gamma, rng, { 'cmd/gamma.go': 40, 'go.mod': 3 });
  await gamma.commitAll('gamma: initial');
  await gamma.writeLines('cmd/flags.go', codeLines(rng, 15));
  await gamma.commitAll('gamma: flags');
  await gamma.writeLines('cmd/gamma.go', [`// ${marker('gamma-edit')}`, ...codeLines(rng, 40)]);

  // epsilon: a clean repository (must not appear in the inbox).
  const epsilonDir = join(scanRoot, 'epsilon');
  const epsilon = await RepoBuilder.init(ctx, epsilonDir);
  await seedFiles(epsilon, rng, { 'index.js': 20 });
  await epsilon.commitAll('epsilon: initial');

  // Must be skipped: a repo inside node_modules and one deeper than the scan depth.
  const hidden = await RepoBuilder.init(ctx, join(scanRoot, 'node_modules', 'hidden-pkg'));
  await seedFiles(hidden, rng, { 'index.js': 5 });
  await hidden.commitAll('hidden: initial');
  const tooDeep = await RepoBuilder.init(
    ctx,
    join(scanRoot, 'too', 'deep', 'for', 'scan', 'delta'),
  );
  await seedFiles(tooDeep, rng, { 'main.rs': 5 });
  await tooDeep.commitAll('delta: initial');
  // A plain directory with files, not a repo.
  const plain = new RepoBuilder(ctx, join(scanRoot, 'plain-dir'));
  await plain.writeLines('notes.txt', codeLines(rng, 3));

  // Symlink loops.
  const loopA = join(scanRoot, 'loop-to-root');
  const loopB = join(scanRoot, 'nested', 'loop-up');
  await new RepoBuilder(ctx, scanRoot).symlink('.', 'loop-to-root');
  await new RepoBuilder(ctx, join(scanRoot, 'nested')).symlink('..', 'loop-up');

  return {
    depth: 3,
    excludedRepoPaths: [hidden.dir, tooDeep.dir],
    symlinkLoops: [loopA, loopB],
    specs: [
      {
        name: 'beta',
        role: 'control',
        locator: betaDir,
        registration,
        defaultBranch: 'main',
        worktreeNames: { [betaDir]: 'beta', [detachedPath]: 'beta-detached' },
      },
      {
        name: 'gamma',
        role: 'control',
        locator: gammaDir,
        registration,
        defaultBranch: 'master',
        worktreeNames: { [gammaDir]: 'gamma' },
      },
      {
        name: 'epsilon',
        role: 'control',
        locator: epsilonDir,
        registration,
        defaultBranch: 'main',
        worktreeNames: { [epsilonDir]: 'epsilon' },
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// kitchen-sink: every special file case in one worktree
// ---------------------------------------------------------------------------------------------

export interface KitchenSinkOptions {
  largeFileBytes: number;
  minifiedBytes: number;
}

function pngBytes(rng: Rng, size: number): Buffer {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
  const body = Buffer.alloc(size);
  for (let i = 0; i < size; i++) body[i] = rng.int(0, 255);
  body[0] = 0; // guarantee a NUL early so git treats it as binary
  return Buffer.concat([header, body]);
}

function largeSql(rng: Rng, bytes: number, markerText: string): string {
  const parts: string[] = [`-- ${markerText}\n`];
  let size = parts[0]?.length ?? 0;
  let i = 0;
  while (size < bytes) {
    const line = `INSERT INTO events VALUES (${i}, '${word(rng)}', ${rng.int(0, 1_000_000)});\n`;
    parts.push(line);
    size += line.length;
    i++;
  }
  return parts.join('');
}

function minified(rng: Rng, bytes: number): string {
  const parts: string[] = [];
  let size = 0;
  let i = 0;
  while (size < bytes) {
    const chunk = `function ${word(rng)}${i}(a,b){return a*${rng.int(1, 99)}+b-${rng.int(0, 9)}};`;
    parts.push(chunk);
    size += chunk.length;
    i++;
  }
  return parts.join('');
}

export async function buildKitchenSink(
  ctx: BuildContext,
  paths: ScenarioPaths,
  options: KitchenSinkOptions,
): Promise<ProjectSpec> {
  const rng = ctx.rng.fork('kitchen-sink');
  const name = 'kitchen-sink';
  const dir = join(paths.repos, name);

  // Submodule source (never registered).
  const lib = await RepoBuilder.init(ctx, join(paths.sources, 'lib'));
  await seedFiles(lib, rng, { 'lib.c': 20 });
  await lib.commitAll('lib: initial');

  const repo = await RepoBuilder.init(ctx, dir);
  const both = codeLines(rng, 30);
  const crlf = codeLines(rng, 12);
  const minifiedText = minified(rng, options.minifiedBytes);
  const unicodeLines = codeLines(rng, 10);
  const whitespaceLines = codeLines(rng, 12);
  const nonUtf8Name = Buffer.concat([
    Buffer.from('latin1/caf'),
    Buffer.from([0xe9]),
    Buffer.from('.txt'),
  ]);
  await repo.writeLines('src/both.ts', both);
  await seedFiles(repo, rng, {
    'src/old-name.ts': 40,
    'src/copy-source.ts': 40,
    'src/deleted.ts': 25,
    'src/staged-deleted.ts': 15,
    'src/touched.ts': 10,
    'generated/schema.sql': 10,
    'config/settings.json': 4,
    'latin1/readme.txt': 2,
    'README.md': 6,
  });
  await repo.writeLines('src/whitespace.ts', whitespaceLines);
  await repo.write('assets/logo.png', pngBytes(rng, 2048));
  await repo.write('dist/app.min.js', `${minifiedText}\n`);
  await repo.writeLines('windows/crlf.txt', crlf, '\r\n');
  await repo.writeLines('docs/ünïcødé ✓.md', unicodeLines);
  await repo.write(nonUtf8Name, 'caf\xe9 au lait\nline two\n');
  await repo.symlink('../src/both.ts', 'links/current');
  await repo.commitAll('kitchen sink: initial');
  // Relative URL (resolved against the superproject dir) keeps commit shas independent of the
  // temp root, so the same seed gives the same shas.
  await repo.git(['submodule', 'add', '-q', '../../sources/lib', 'vendor/lib']);
  await repo.commitAll('add lib submodule');

  // --- staged changes ---
  const bothStaged = await editLine(repo, 'src/both.ts', both, 1, `// ${marker('both-staged')}`);
  await repo.add('src/both.ts');
  await repo.git(['mv', 'src/old-name.ts', 'src/new-name.ts']);
  const copySource = await readFile(repo.path('src/copy-source.ts'));
  await repo.write('src/copy-dest.ts', copySource);
  await repo.add('src/copy-dest.ts');
  await repo.git(['rm', '-q', 'src/staged-deleted.ts']);
  await repo.writeLines('src/feature-added.ts', [`// ${marker('added')}`, ...codeLines(rng, 8)]);
  await repo.add('src/feature-added.ts');
  await repo.write(
    'generated/huge.sql',
    largeSql(rng, options.largeFileBytes, marker('very-large')),
  );
  await repo.add('generated/huge.sql');

  // --- unstaged changes ---
  await editLine(repo, 'src/both.ts', bothStaged, 20, `// ${marker('both-unstaged')}`);
  await repo.remove('src/deleted.ts');
  await repo.write('assets/logo.png', pngBytes(rng, 2100));
  const mid = Math.floor(minifiedText.length / 2);
  await repo.write(
    'dist/app.min.js',
    `${minifiedText.slice(0, mid)}var ${marker('minified').replaceAll('-', '_')}=1;${minifiedText.slice(mid)}\n`,
  );
  await repo.writeLines(
    'windows/crlf.txt',
    [crlf[0] ?? '', `// ${marker('crlf')}`, ...crlf.slice(2)],
    '\r\n',
  );
  await repo.writeLines('docs/ünïcødé ✓.md', [`# ${marker('unicode')}`, ...unicodeLines.slice(1)]);
  await repo.write(nonUtf8Name, `caf\xe9 au lait\n${marker('non-utf8')}\n`);
  await repo.symlink('../src/new-name.ts', 'links/current');
  await repo.remove('config/settings.json');
  await repo.symlink('../src/both.ts', 'config/settings.json');
  await repo.writeLines(
    'src/whitespace.ts',
    whitespaceLines.map((line, i) => (i % 3 === 0 ? `${line}   ` : line)),
  );
  const sub = new RepoBuilder(ctx, repo.path('vendor/lib'));
  await sub.writeLines('lib.h', codeLines(rng, 5));
  await sub.commitAll('lib: header');

  // --- untracked ---
  await repo.writeLines('src/scratch.ts', [`// ${marker('untracked')}`, ...codeLines(rng, 7)]);

  // --- stat-dirty but unchanged: bait for any `git status` that refreshes the index ---
  const touched = repo.path('src/touched.ts');
  await utimes(touched, new Date('2020-01-01T00:00:00Z'), new Date('2020-01-01T00:00:00Z'));

  const w = name;
  return {
    name,
    role: 'control',
    locator: dir,
    registration: { kind: 'path', path: dir },
    defaultBranch: 'main',
    worktreeNames: { [dir]: name },
    cases: {
      'staged-and-unstaged': {
        worktree: w,
        path: 'src/both.ts',
        addedMarker: marker('both-unstaged'),
      },
      renamed: { worktree: w, path: 'src/new-name.ts' },
      copied: { worktree: w, path: 'src/copy-dest.ts' },
      deleted: { worktree: w, path: 'src/deleted.ts' },
      'staged-deleted': { worktree: w, path: 'src/staged-deleted.ts' },
      added: { worktree: w, path: 'src/feature-added.ts', addedMarker: marker('added') },
      binary: { worktree: w, path: 'assets/logo.png' },
      'very-large': { worktree: w, path: 'generated/huge.sql', addedMarker: marker('very-large') },
      minified: { worktree: w, path: 'dist/app.min.js' },
      crlf: { worktree: w, path: 'windows/crlf.txt', addedMarker: marker('crlf') },
      'non-utf8-filename': {
        worktree: w,
        path: Buffer.from(nonUtf8Name).toString('utf8'),
        rawPath: nonUtf8Name.toString('base64'),
        addedMarker: marker('non-utf8'),
      },
      'unicode-filename': {
        worktree: w,
        path: 'docs/ünïcødé ✓.md',
        addedMarker: marker('unicode'),
      },
      symlink: { worktree: w, path: 'links/current' },
      typechange: { worktree: w, path: 'config/settings.json' },
      submodule: { worktree: w, path: 'vendor/lib' },
      untracked: { worktree: w, path: 'src/scratch.ts', addedMarker: marker('untracked') },
      'whitespace-only': { worktree: w, path: 'src/whitespace.ts' },
      'stat-dirty': { worktree: w, path: 'src/touched.ts' },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// conflict, root-only, empty, bare
// ---------------------------------------------------------------------------------------------

export async function buildConflict(ctx: BuildContext, paths: ScenarioPaths): Promise<ProjectSpec> {
  const rng = ctx.rng.fork('conflict');
  const dir = join(paths.repos, 'conflict');
  const repo = await RepoBuilder.init(ctx, dir);
  const shared = codeLines(rng, 10);
  await repo.writeLines('shared.txt', shared);
  await repo.commitAll('conflict: base');
  await repo.git(['checkout', '-q', '-b', 'topic']);
  await editLine(repo, 'shared.txt', shared, 4, 'topic side of the line');
  await repo.writeLines('topic-only.txt', codeLines(rng, 4));
  await repo.commitAll('topic: change line 5');
  await repo.git(['checkout', '-q', 'main']);
  await editLine(repo, 'shared.txt', shared, 4, 'main side of the line');
  await repo.commitAll('main: change line 5');
  await repo.git(['merge', '--no-edit', 'topic'], { allowFailure: true });
  return {
    name: 'conflict',
    role: 'control',
    locator: dir,
    registration: { kind: 'path', path: dir },
    defaultBranch: 'main',
    worktreeNames: { [dir]: 'conflict' },
    cases: { conflict: { worktree: 'conflict', path: 'shared.txt' } },
  };
}

export async function buildRootOnly(ctx: BuildContext, paths: ScenarioPaths): Promise<ProjectSpec> {
  const rng = ctx.rng.fork('root-only');
  const dir = join(paths.repos, 'root-only');
  const repo = await RepoBuilder.init(ctx, dir);
  const readme = codeLines(rng, 8);
  await repo.writeLines('README.md', readme);
  await seedFiles(repo, rng, { 'src/a.ts': 10, 'src/b.ts': 12 });
  const root = await repo.commitAll('the only commit');
  await editLine(repo, 'README.md', readme, 2, `# ${marker('root-only-edit')}`);
  return {
    name: 'root-only',
    role: 'control',
    locator: dir,
    registration: { kind: 'path', path: dir },
    defaultBranch: 'main',
    worktreeNames: { [dir]: 'root-only' },
    describeCommits: [root],
  };
}

export async function buildEmpty(ctx: BuildContext, paths: ScenarioPaths): Promise<ProjectSpec> {
  const rng = ctx.rng.fork('empty');
  const dir = join(paths.repos, 'empty');
  const repo = await RepoBuilder.init(ctx, dir);
  await repo.writeLines('notes.txt', [`${marker('empty-staged')}`, ...codeLines(rng, 3)]);
  await repo.add('notes.txt');
  await repo.writeLines('README.md', [`# ${marker('empty-untracked')}`]);
  return {
    name: 'empty',
    role: 'control',
    locator: dir,
    registration: { kind: 'path', path: dir },
    // Unborn `main`: no commits, so nothing to detect.
    defaultBranch: null,
    worktreeNames: { [dir]: 'empty' },
  };
}

export async function buildBare(ctx: BuildContext, paths: ScenarioPaths): Promise<ProjectSpec> {
  const rng = ctx.rng.fork('bare');
  const seed = await RepoBuilder.init(ctx, join(paths.sources, 'bare-seed'));
  const app = codeLines(rng, 20);
  await seed.writeLines('app.rb', app);
  await seed.commitAll('bare: initial');
  await seed.git(['branch', 'feature/bare']);
  await seed.writeLines('Gemfile', codeLines(rng, 4));
  await seed.commitAll('bare: gemfile');
  const bareDir = join(paths.repos, 'bare-project.git');
  await RepoBuilder.init(ctx, bareDir, { bare: true });
  await seed.git(['push', '-q', bareDir, 'main', 'feature/bare']);
  const bare = new RepoBuilder(ctx, bareDir);
  const mainPath = join(paths.worktrees, 'bare-main');
  const featurePath = join(paths.worktrees, 'bare-feature');
  await bare.addWorktree(mainPath, { branch: 'main' });
  const feature = await bare.addWorktree(featurePath, { branch: 'feature/bare' });
  await editLine(feature, 'app.rb', app, 0, `# ${marker('bare-feature-edit')}`);
  return {
    name: 'bare-project',
    role: 'control',
    locator: bareDir,
    registration: { kind: 'path', path: bareDir },
    defaultBranch: 'main',
    worktreeNames: {
      [bareDir]: 'bare-project',
      [mainPath]: 'bare-main',
      [featurePath]: 'bare-feature',
    },
  };
}

// ---------------------------------------------------------------------------------------------
// live: the mutable project tests and the agent simulator edit
// ---------------------------------------------------------------------------------------------

export const LIVE_FILES = {
  edit: 'src/live.ts',
  review: 'src/review-me.ts',
  other: 'src/other.ts',
} as const;

export async function buildLive(ctx: BuildContext, paths: ScenarioPaths): Promise<ProjectSpec> {
  const rng = ctx.rng.fork('live');
  const dir = join(paths.repos, 'live');
  const repo = await RepoBuilder.init(ctx, dir);
  await seedFiles(repo, rng, {
    [LIVE_FILES.edit]: 40,
    [LIVE_FILES.review]: 30,
    [LIVE_FILES.other]: 20,
    'src/stable.ts': 20,
    'README.md': 5,
  });
  await repo.commitAll('live: initial');
  await repo.writeLines('src/second.ts', codeLines(rng, 10));
  await repo.commitAll('live: second');
  const agentPath = join(paths.worktrees, 'live-agent');
  const agent = await repo.addWorktree(agentPath, { newBranch: 'agent/live', commitish: 'main' });
  // Both worktrees start dirty so they are in the inbox.
  await repo.writeLines(LIVE_FILES.edit, [`// ${marker('live-initial')}`, ...codeLines(rng, 40)]);
  await repo.writeLines(LIVE_FILES.review, [
    `// ${marker('live-review-initial')}`,
    ...codeLines(rng, 30),
  ]);
  await agent.writeLines(LIVE_FILES.other, [
    `// ${marker('live-agent-initial')}`,
    ...codeLines(rng, 20),
  ]);
  return {
    name: 'live',
    role: 'mutable',
    locator: dir,
    registration: { kind: 'path', path: dir },
    defaultBranch: 'main',
    worktreeNames: { [dir]: 'live', [agentPath]: 'live-agent' },
  };
}

// ---------------------------------------------------------------------------------------------
// bench: N repos × M worktrees, each dirty
// ---------------------------------------------------------------------------------------------

export interface BenchLayoutOptions {
  repos: number;
  worktreesPerRepo: number;
  filesPerRepo: number;
  dirtyFilesPerWorktree: number;
}

export async function buildBenchRepo(
  ctx: BuildContext,
  paths: ScenarioPaths,
  index: number,
  options: BenchLayoutOptions,
): Promise<ProjectSpec> {
  const name = `bench-${String(index + 1).padStart(2, '0')}`;
  const rng = ctx.rng.fork(name);
  const dir = join(paths.bench, name);
  const repo = await RepoBuilder.init(ctx, dir);
  const files: string[] = [];
  for (let i = 0; i < options.filesPerRepo; i++) {
    const rel = `src/module-${String(i).padStart(3, '0')}.ts`;
    files.push(rel);
    await repo.writeLines(rel, codeLines(rng, rng.int(20, 120)));
  }
  await repo.writeLines('README.md', codeLines(rng, 5));
  await repo.commitAll(`${name}: initial`);
  for (let c = 0; c < 3; c++) {
    await repo.writeLines(rng.pick(files), codeLines(rng, rng.int(20, 120)));
    await repo.commitAll(`${name}: change ${c + 1}`);
  }
  const worktreeNames: Record<string, string> = { [dir]: name };
  const builders: RepoBuilder[] = [repo];
  for (let w = 1; w < options.worktreesPerRepo; w++) {
    const wtPath = join(paths.bench, 'worktrees', `${name}-wt${w}`);
    worktreeNames[wtPath] = `${name}-wt${w}`;
    builders.push(
      await repo.addWorktree(wtPath, { newBranch: `agent/task-${w}`, commitish: 'main' }),
    );
  }
  for (const builder of builders) {
    for (const rel of rng.shuffle(files).slice(0, options.dirtyFilesPerWorktree)) {
      await builder.writeLines(rel, codeLines(rng, rng.int(20, 120)));
    }
    await builder.writeLines(`src/untracked-${word(rng)}.ts`, codeLines(rng, 10));
  }
  return {
    name,
    role: 'bench',
    locator: dir,
    registration: { kind: 'path', path: dir },
    defaultBranch: 'main',
    worktreeNames,
  };
}
