import { mkdirSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import {
  type GitCore,
  GitProjectInfoSchema,
  isGitCoreError,
  WorktreeSchema,
} from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCore, hashId } from '../src/index.js';
import { createFixture, type Fixture } from './helpers/fixture.js';

let fx: Fixture;
let core: GitCore;

beforeAll(() => {
  fx = createFixture();
  core = createGitCore(fx.coreOptions());
});

afterAll(async () => {
  await core.dispose();
  fx.dispose();
});

describe('hashId', () => {
  it('is the first 16 hex chars of SHA-256 (DECISIONS #8)', () => {
    expect(hashId('/tmp/x')).toMatch(/^[0-9a-f]{16}$/);
    // printf '/tmp/x' | sha256sum
    expect(hashId('/tmp/x')).toBe('2e56aa36f538b33b');
  });
});

describe('resolveProject', () => {
  let main: string;
  let linked: string;
  let detached: string;

  beforeAll(() => {
    main = fx.repo('app');
    fx.write(path.join(main, 'src', 'index.ts'), 'export {};\n');
    fx.commitAll(main, 'src');
    linked = path.join(fx.root, 'worktrees', 'app-feature');
    fx.git(main, ['worktree', 'add', '-q', '-b', 'feature/x', linked]);
    detached = path.join(fx.root, 'worktrees', 'app-detached');
    fx.git(main, ['worktree', 'add', '-q', '--detach', detached]);
    fx.git(main, ['worktree', 'lock', '--reason', 'agent', detached]);
    const gone = path.join(fx.root, 'worktrees', 'app-gone');
    fx.git(main, ['worktree', 'add', '-q', '-b', 'gone', gone]);
    rmSync(gone, { recursive: true, force: true });
  });

  it('resolves the main checkout, subdirectories, linked worktrees and the git dir', async () => {
    const fromMain = await core.resolveProject(main);
    GitProjectInfoSchema.parse(fromMain.project);
    for (const worktree of fromMain.worktrees) WorktreeSchema.parse(worktree);
    const commonDir = path.join(main, '.git');
    expect(fromMain.project).toMatchObject({
      id: hashId(commonDir),
      name: 'app',
      commonDir,
      mainWorktreePath: main,
      bare: false,
      detectedDefaultBranch: 'main',
    });
    expect(fromMain.matchedWorktreeId).toBe(hashId(main));

    const fromSubdir = await core.resolveProject(path.join(main, 'src'));
    expect(fromSubdir.project.id).toBe(fromMain.project.id);
    expect(fromSubdir.matchedWorktreeId).toBe(hashId(main));

    const fromFile = await core.resolveProject(path.join(main, 'src', 'index.ts'));
    expect(fromFile.matchedWorktreeId).toBe(hashId(main));

    const fromLinked = await core.resolveProject(linked);
    expect(fromLinked.project.id).toBe(fromMain.project.id);
    expect(fromLinked.matchedWorktreeId).toBe(hashId(linked));

    const fromGitDir = await core.resolveProject(commonDir);
    expect(fromGitDir.project.id).toBe(fromMain.project.id);
    expect(fromGitDir.matchedWorktreeId).toBeNull();
  });

  it('lists worktrees with their flags', async () => {
    const { worktrees, project } = await core.resolveProject(main);
    const byPath = new Map(worktrees.map((w) => [path.basename(w.path), w]));
    expect(worktrees[0]).toMatchObject({ path: main, isMain: true, branch: 'main', bare: false });
    expect(byPath.get('app-feature')).toMatchObject({
      branch: 'feature/x',
      detached: false,
      isMain: false,
      locked: false,
      missing: false,
    });
    expect(byPath.get('app-detached')).toMatchObject({
      branch: null,
      detached: true,
      locked: true,
    });
    expect(byPath.get('app-gone')).toMatchObject({ missing: true, prunable: true });
    for (const worktree of worktrees) {
      expect(worktree.projectId).toBe(project.id);
      expect(worktree.id).toBe(hashId(worktree.path));
      expect(worktree.headSha).toMatch(/^[0-9a-f]{40}$/);
    }
    const again = await core.listWorktrees(project);
    expect(again).toEqual(worktrees);
  });

  it('resolves bare repositories and their worktrees', async () => {
    const bare = path.join(fx.root, 'origin.git');
    fx.git(fx.root, ['clone', '-q', '--bare', main, bare]);
    const wt = path.join(fx.root, 'bare-wt');
    fx.git(bare, ['worktree', 'add', '-q', wt, 'main']);
    const fromBare = await core.resolveProject(bare);
    expect(fromBare.project).toMatchObject({
      name: 'origin',
      commonDir: bare,
      mainWorktreePath: null,
      bare: true,
    });
    expect(fromBare.worktrees[0]).toMatchObject({
      path: bare,
      bare: true,
      isMain: true,
      branch: null,
    });
    expect(fromBare.matchedWorktreeId).toBeNull();
    const fromWt = await core.resolveProject(wt);
    expect(fromWt.project.id).toBe(fromBare.project.id);
    expect(fromWt.matchedWorktreeId).toBe(hashId(wt));
  });

  it('rejects paths outside repositories', async () => {
    const plain = path.join(fx.root, 'plain');
    mkdirSync(plain);
    for (const input of [plain, path.join(fx.root, 'does-not-exist')]) {
      const error = await core.resolveProject(input).catch((e: unknown) => e);
      expect(isGitCoreError(error, 'not_a_repository'), String(error)).toBe(true);
    }
    const relative = await core.resolveProject('relative').catch((e: unknown) => e);
    expect(isGitCoreError(relative, 'invalid_argument')).toBe(true);
  });

  it('reports unborn worktrees with a null headSha', async () => {
    const empty = fx.repo('empty', { empty: true });
    const { worktrees, project } = await core.resolveProject(empty);
    expect(worktrees[0]).toMatchObject({ headSha: null, branch: 'main' });
    expect(project.detectedDefaultBranch).toBeNull();
  });
});

describe('detectDefaultBranch', () => {
  it('prefers origin/HEAD, then main/master/trunk', async () => {
    const upstream = fx.repo('upstream-repo');
    fx.git(upstream, ['branch', '-m', 'main', 'develop']);
    const clone = path.join(fx.root, 'clone');
    fx.git(fx.root, ['clone', '-q', upstream, clone]);
    fx.git(clone, ['branch', '-q', 'main']);
    const project = (await core.resolveProject(clone)).project;
    expect(project.detectedDefaultBranch).toBe('develop');
    fx.git(clone, ['switch', '-q', 'main']);
    fx.git(clone, ['branch', '-q', '-D', 'develop']);
    expect(await core.detectDefaultBranch(project)).toBe('origin/develop');
    fx.git(clone, ['remote', 'set-head', 'origin', '--delete']);
    expect(await core.detectDefaultBranch(project)).toBe('main');

    const trunk = fx.repo('trunk-repo');
    fx.git(trunk, ['branch', '-m', 'main', 'trunk']);
    expect((await core.resolveProject(trunk)).project.detectedDefaultBranch).toBe('trunk');
    fx.git(trunk, ['branch', '-q', 'master']);
    expect((await core.resolveProject(trunk)).project.detectedDefaultBranch).toBe('master');
    fx.git(trunk, ['branch', '-m', 'trunk', 'other']);
    fx.git(trunk, ['branch', '-m', 'master', 'other2']);
    expect((await core.resolveProject(trunk)).project.detectedDefaultBranch).toBeNull();
  });
});

describe('scan', () => {
  let scanRoot: string;

  beforeAll(() => {
    scanRoot = path.join(fx.root, 'scan');
    const a = fx.repo('scan/a');
    fx.repo('scan/group/b');
    fx.repo('scan/group/deeper/c');
    fx.repo('scan/node_modules/pkg');
    fx.repo('scan/ignored-dir/d');
    fx.repo('scan/a/nested-inside-a');
    fx.git(a, ['worktree', 'add', '-q', '-b', 'wt', path.join(scanRoot, 'linked-a')]);
    fx.git(scanRoot, ['clone', '-q', '--bare', a, path.join(scanRoot, 'bare.git')]);
    mkdirSync(path.join(scanRoot, 'loop'));
    symlinkSync(scanRoot, path.join(scanRoot, 'loop', 'back-to-root'));
    symlinkSync(path.join(scanRoot, 'group'), path.join(scanRoot, 'group-link'));
  });

  it('finds repositories to the requested depth', async () => {
    const shallow = await core.scan(scanRoot, { depth: 1 });
    expect(shallow.repositories.map((p) => path.relative(scanRoot, p))).toEqual([
      'a',
      'bare.git',
      'linked-a',
    ]);
    const deep = await core.scan(scanRoot, { depth: 3, ignore: ['ignored-dir'] });
    const rel = deep.repositories.map((p) => path.relative(scanRoot, p));
    expect(rel).toEqual([
      'a',
      'a/nested-inside-a',
      'bare.git',
      'group/b',
      'group/deeper/c',
      'linked-a',
    ]);
    expect(deep.truncated).toBe(false);
    expect(deep.scannedDirs).toBeGreaterThan(5);
    const all = await core.scan(scanRoot, { depth: 4 });
    expect(all.repositories.map((p) => path.relative(scanRoot, p))).toContain('ignored-dir/d');
    expect(all.repositories.map((p) => path.relative(scanRoot, p))).not.toContain(
      'node_modules/pkg',
    );
  });

  it('treats the root itself as depth 0', async () => {
    const result = await core.scan(path.join(scanRoot, 'a'), { depth: 0 });
    expect(result.repositories).toEqual([path.join(scanRoot, 'a')]);
  });

  it('supports abort and progress', async () => {
    const controller = new AbortController();
    controller.abort();
    const aborted = await core.scan(scanRoot, { depth: 5, signal: controller.signal });
    expect(aborted.truncated).toBe(true);
    const progress: number[] = [];
    await core.scan(scanRoot, { depth: 5, onProgress: (p) => progress.push(p.scannedDirs) });
    expect(progress.length).toBeGreaterThan(0);
  });

  it('validates input', async () => {
    const badDepth = await core.scan(scanRoot, { depth: 99 }).catch((e: unknown) => e);
    expect(isGitCoreError(badDepth, 'invalid_argument')).toBe(true);
    const missing = await core
      .scan(path.join(scanRoot, 'nope'), { depth: 1 })
      .catch((e: unknown) => e);
    expect(isGitCoreError(missing, 'not_found')).toBe(true);
  });
});

describe('getWatchTargets', () => {
  it('points at the worktree, its git dir and the common dir', async () => {
    const main = fx.repo('watch-main');
    const linked = path.join(fx.root, 'watch-linked');
    fx.git(main, ['worktree', 'add', '-q', '-b', 'w', linked]);
    const commonDir = path.join(main, '.git');
    const mainTargets = await core.getWatchTargets({
      projectId: hashId(commonDir),
      worktreeId: hashId(main),
      path: main,
    });
    expect(mainTargets).toMatchObject({ worktreeRoot: main, gitDir: commonDir, commonDir });
    for (const name of ['HEAD', 'index', 'refs', 'packed-refs', 'worktrees']) {
      expect(mainTargets.gitPaths).toContain(path.join(commonDir, name));
    }
    const linkedTargets = await core.getWatchTargets({
      projectId: hashId(commonDir),
      worktreeId: hashId(linked),
      path: linked,
    });
    const linkedGitDir = path.join(commonDir, 'worktrees', 'watch-linked');
    expect(linkedTargets).toMatchObject({ worktreeRoot: linked, gitDir: linkedGitDir, commonDir });
    expect(linkedTargets.gitPaths).toContain(path.join(linkedGitDir, 'HEAD'));
    expect(linkedTargets.gitPaths).toContain(path.join(linkedGitDir, 'index'));
    expect(linkedTargets.gitPaths).toContain(path.join(commonDir, 'refs'));
    expect(linkedTargets.gitPaths).toContain(path.join(commonDir, 'packed-refs'));
  });
});
