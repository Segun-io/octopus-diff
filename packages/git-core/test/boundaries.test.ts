/**
 * Repository config and admin files are untrusted (review-security SEC-06, SEC-07, SEC-08):
 * - `core.worktree` must not make git-core list or return files outside the worktree root;
 * - forged `.git/worktrees/<id>/gitdir` records must not surface arbitrary directories as
 *   usable worktrees;
 * - `scan()` must not follow symlinks out of the scan root.
 * Each hostile setup is first shown to be effective with plain git (control).
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { GitCore } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCore } from '../src/index.js';
import { fileDiff, listFiles, locator } from './helpers/core.js';
import { createFixture, type Fixture } from './helpers/fixture.js';

let fx: Fixture;
let core: GitCore;
let outside: string;

beforeAll(() => {
  fx = createFixture();
  core = createGitCore(fx.coreOptions());
  // Stand-in for the user's home directory: secrets the repository must not reach.
  outside = path.join(fx.root, 'home');
  fx.write(path.join(outside, '.ssh', 'id_ed25519'), 'REAL-SECRET-CONTENT\n');
  fx.write(path.join(outside, 'notes.txt'), 'outside\n');
});

afterAll(async () => {
  await core.dispose();
  fx.dispose();
});

function plainStatus(cwd: string): string {
  return fx.git(cwd, ['--no-optional-locks', 'status', '--porcelain=v2', '-uall']);
}

describe('SEC-06: core.worktree cannot redirect git-core outside the worktree', () => {
  function hostileClone(name: string, worktreeValue: (repo: string) => string): string {
    const repo = fx.repo(name, {
      files: { 'a.txt': 'a\n', '.ssh/id_ed25519': 'placeholder\n' },
    });
    fx.git(repo, ['config', 'core.worktree', worktreeValue(repo)]);
    return repo;
  }

  async function expectContained(repo: string): Promise<void> {
    const { project, worktrees, matchedWorktreeId } = await core.resolveProject(repo);
    expect(worktrees.map((w) => w.path)).toEqual([repo]);
    expect(matchedWorktreeId).toBe(worktrees[0]?.id);
    expect(project.mainWorktreePath).toBe(repo);
    const wt = locator(repo, project.commonDir);

    // Clean: nothing from the outside directory shows up.
    expect(await listFiles(core, wt, { kind: 'working' })).toEqual([]);
    const clean = await core.getSummary(wt);
    expect(clean.changedFiles).toBe(0);
    await expect(
      core.getFileDiff(wt, { kind: 'working' }, { path: '.ssh/id_ed25519' }),
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      core.getFileDiff(wt, { kind: 'working' }, { path: 'notes.txt' }),
    ).rejects.toMatchObject({ code: 'not_found' });

    // Dirty inside: the repository's own files are diffed, never the outside ones.
    writeFileSync(path.join(repo, '.ssh', 'id_ed25519'), 'changed placeholder\n');
    writeFileSync(path.join(repo, 'new.txt'), 'new\n');
    const files = await listFiles(core, wt, { kind: 'working' });
    expect(files.map((f) => [f.path, f.status])).toEqual([
      ['.ssh/id_ed25519', 'modified'],
      ['new.txt', 'untracked'],
    ]);
    const diff = await fileDiff(core, wt, { kind: 'working' }, { path: '.ssh/id_ed25519' });
    expect(diff.patch).toContain('+changed placeholder');
    expect(diff.patch).not.toContain('REAL-SECRET');
    for (const scope of [{ kind: 'staged' }, { kind: 'unstaged' }] as const) {
      for (const file of await listFiles(core, wt, scope)) {
        const d = await fileDiff(core, wt, scope, file);
        expect(d.patch).not.toContain('REAL-SECRET');
      }
    }
    expect((await core.getSummary(wt)).changedFiles).toBe(2);
    const targets = await core.getWatchTargets(wt);
    expect(targets.worktreeRoot).toBe(repo);
  }

  it('ignores an absolute core.worktree pointing outside', async () => {
    const repo = hostileClone('abs-worktree', () => outside);
    // Control: plain git lists and diffs the outside directory.
    const status = plainStatus(repo);
    expect(status).toContain('notes.txt');
    expect(fx.git(repo, ['diff'])).toContain('REAL-SECRET');
    await expectContained(repo);
  });

  it('ignores a relative core.worktree that resolves outside', async () => {
    // Relative to the git dir: <root>/rel-worktree/.git/../../home = <root>/home.
    const repo = hostileClone('rel-worktree', () => '../../home');
    expect(plainStatus(repo)).toContain('notes.txt');
    await expectContained(repo);
  });

  it('ignores core.worktree from a linked worktree config.worktree', async () => {
    const main = fx.repo('wtconfig', { files: { 'a.txt': 'a\n', '.ssh/id_ed25519': 'p\n' } });
    fx.git(main, ['config', 'extensions.worktreeConfig', 'true']);
    const linked = path.join(fx.root, 'wtconfig-linked');
    fx.git(main, ['worktree', 'add', '-q', '-b', 'x', linked]);
    fx.git(linked, ['config', '--worktree', 'core.worktree', outside]);
    expect(plainStatus(linked)).toContain('notes.txt');
    const { project, worktrees, matchedWorktreeId } = await core.resolveProject(linked);
    const entry = worktrees.find((w) => w.path === linked);
    expect(entry?.missing).toBe(false);
    expect(matchedWorktreeId).toBe(entry?.id);
    const wt = locator(linked, project.commonDir);
    expect(await listFiles(core, wt, { kind: 'working' })).toEqual([]);
    expect((await core.getSummary(wt)).changedFiles).toBe(0);
  });

  it('treats a git dir whose work tree comes only from core.worktree as bare', async () => {
    // A bare-looking directory (as a scan root would find it) that sets a work tree.
    const gitDir = path.join(fx.root, 'evil.git');
    fx.git(fx.root, ['init', '-q', '--bare', gitDir]);
    fx.git(gitDir, ['config', 'core.bare', 'false']);
    fx.git(gitDir, ['config', 'core.worktree', outside]);
    expect(plainStatus(gitDir)).toContain('notes.txt');
    const { project, worktrees } = await core.resolveProject(gitDir);
    expect(project.bare).toBe(true);
    expect(project.mainWorktreePath).toBeNull();
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).toMatchObject({ path: gitDir, bare: true });
    const wt = locator(gitDir, project.commonDir);
    const summary = await core.getSummary(wt);
    expect(summary.changedFiles).toBe(0);
    expect(summary.counts).toEqual({ staged: 0, unstaged: 0, untracked: 0, conflicted: 0 });
    expect(await listFiles(core, wt, { kind: 'working' })).toEqual([]);
    expect(await listFiles(core, wt, { kind: 'unstaged' })).toEqual([]);
  });

  it('still uses the submodule work tree that git sets with core.worktree', async () => {
    // Absorbed submodules have core.worktree in .git/modules/<name>/config: legitimate, and
    // equal to the directory whose .git file points at that git dir.
    const lib = fx.repo('sm-lib', { files: { 'l.txt': 'l\n' } });
    const sup = fx.repo('sm-super', { files: { 'r.txt': 'r\n' } });
    fx.git(sup, ['submodule', 'add', '-q', lib, 'sub']);
    fx.commitAll(sup, 'add sub');
    const sub = path.join(sup, 'sub');
    writeFileSync(path.join(sub, 'l.txt'), 'changed\n');
    const { project, matchedWorktreeId, worktrees } = await core.resolveProject(sub);
    expect(project.commonDir).toBe(path.join(sup, '.git', 'modules', 'sub'));
    // git itself reports the git dir as the submodule's main worktree; git-core follows
    // core.worktree there because sub/.git links back to that git dir.
    expect(worktrees).toHaveLength(1);
    expect(worktrees[0]).toMatchObject({ path: sub, bare: false, missing: false });
    expect(project).toMatchObject({ bare: false, mainWorktreePath: sub });
    expect(matchedWorktreeId).toBe(worktrees[0]?.id);
    expect((await core.resolveProject(project.commonDir)).worktrees).toEqual(worktrees);
    const files = await listFiles(core, locator(sub, project.commonDir), { kind: 'working' });
    expect(files.map((f) => f.path)).toEqual(['l.txt']);
    expect((await core.getSummary(locator(sub, project.commonDir))).changedFiles).toBe(1);
  });
});

describe('SEC-07: forged worktree records', () => {
  let main: string;
  let linked: string;
  let victim: string;
  let otherRepo: string;

  function forge(id: string, target: string): void {
    const admin = path.join(main, '.git', 'worktrees', id);
    mkdirSync(admin, { recursive: true });
    writeFileSync(path.join(admin, 'gitdir'), `${path.join(target, '.git')}\n`);
    writeFileSync(path.join(admin, 'commondir'), '../..\n');
    writeFileSync(path.join(admin, 'HEAD'), 'ref: refs/heads/main\n');
  }

  beforeAll(() => {
    main = fx.repo('forged-main', { files: { 'a.txt': 'a\n' } });
    linked = path.join(fx.root, 'forged-linked');
    fx.git(main, ['worktree', 'add', '-q', '-b', 'feature', linked]);
    // A big directory that is not a repository, and another repository of the user.
    victim = path.join(fx.root, 'victim');
    for (let i = 0; i < 20; i += 1) mkdirSync(path.join(victim, `d${i}`), { recursive: true });
    otherRepo = fx.repo('other-private', { files: { 'secret.txt': 's\n' } });
    forge('evil-victim', victim);
    // `/.git` makes git list the admin dir itself: also not a worktree.
    forge('evil-root', '/');
    forge('evil-home', outside);
    forge('evil-repo', otherRepo);
    // A copied admin dir: a second record for the real linked worktree.
    cpSync(
      path.join(main, '.git', 'worktrees', 'forged-linked'),
      path.join(main, '.git', 'worktrees', 'zz-copy'),
      { recursive: true },
    );
  });

  it('git itself lists the forged records (control)', () => {
    const listed = fx.git(main, ['worktree', 'list', '--porcelain']);
    for (const dir of [victim, outside, otherRepo]) {
      expect(listed).toContain(`worktree ${dir}\n`);
    }
  });

  it('reports forged records as prunable and missing, and keeps real ones', async () => {
    const { project, worktrees } = await core.resolveProject(main);
    const relisted = await core.listWorktrees(project);
    expect(relisted).toEqual(worktrees);
    const byPath = new Map(worktrees.map((w) => [w.path, w]));
    expect(byPath.get(main)).toMatchObject({ isMain: true, missing: false, prunable: false });
    expect(byPath.get(linked)).toMatchObject({ missing: false, prunable: false });
    const forgedAdmin = path.join(main, '.git', 'worktrees', 'evil-root');
    for (const dir of [victim, outside, otherRepo, forgedAdmin]) {
      expect(byPath.get(dir), dir).toMatchObject({ missing: true, prunable: true, isMain: false });
    }
    expect(worktrees).toHaveLength(6);
    // The duplicate record for the linked worktree is dropped.
    expect(worktrees.filter((w) => w.path === linked)).toHaveLength(1);
    expect(new Set(worktrees.map((w) => w.id)).size).toBe(worktrees.length);
  });

  it('accepts linked worktrees that use relative paths (worktree.useRelativePaths)', async () => {
    const repo = fx.repo('relative-main', { files: { 'a.txt': 'a\n' } });
    const wt = path.join(fx.root, 'relative-wt');
    fx.git(repo, ['-c', 'worktree.useRelativePaths=true', 'worktree', 'add', '-q', '-b', 'r', wt], {
      allowFail: true,
    });
    if (!existsSync(path.join(wt, '.git'))) return; // git < 2.48
    expect(readFileSync(path.join(wt, '.git'), 'utf8')).toMatch(/^gitdir: \.\./);
    const { worktrees } = await core.resolveProject(repo);
    expect(worktrees.find((w) => w.path === wt)).toMatchObject({ missing: false, prunable: false });
  });

  it('rejects a worktree whose .git file points at another admin dir', async () => {
    // `.git` of a real worktree of another repository: points back, but not into ours.
    const elsewhere = fx.repo('elsewhere-main', { files: { 'e.txt': 'e\n' } });
    const elsewhereWt = path.join(fx.root, 'elsewhere-wt');
    fx.git(elsewhere, ['worktree', 'add', '-q', '-b', 'w', elsewhereWt]);
    forge('evil-foreign', elsewhereWt);
    const { worktrees } = await core.resolveProject(main);
    expect(worktrees.find((w) => w.path === elsewhereWt)).toMatchObject({
      missing: true,
      prunable: true,
    });
  });
});

describe('SEC-08: scan stays inside the scan root', () => {
  it('does not follow symlinks out of the root', async () => {
    const scanRoot = path.join(fx.root, 'scanroot');
    const cloned = path.join(scanRoot, 'cloned');
    mkdirSync(cloned, { recursive: true });
    fx.git(cloned, ['init', '-q', '.']);
    const elsewhere = path.join(fx.root, 'elsewhere');
    const privateRepo = path.join(elsewhere, 'private-repo');
    mkdirSync(privateRepo, { recursive: true });
    fx.git(privateRepo, ['init', '-q', '.']);
    fx.symlink('../../elsewhere', path.join(cloned, 'innocent-link'));
    fx.symlink(path.join(fx.root, 'elsewhere'), path.join(cloned, 'absolute-link'));
    fx.symlink('/', path.join(cloned, 'root-link'));
    // A link that stays inside the root is still followed.
    const inside = path.join(scanRoot, 'nested', 'inner-repo');
    mkdirSync(inside, { recursive: true });
    fx.git(inside, ['init', '-q', '.']);
    fx.symlink('../nested', path.join(cloned, 'inside-link'));
    const linkedInside = path.join(scanRoot, 'only-via-link');
    fx.symlink('nested', linkedInside);

    const result = await core.scan(scanRoot, { depth: 4 });
    expect(result.repositories).toEqual([cloned, inside]);
    expect(result.repositories).not.toContain(privateRepo);
    expect(result.truncated).toBe(false);
    // `/` was not walked.
    expect(result.scannedDirs).toBeLessThan(20);
  });

  it('follows a link to a directory inside the root that is not reachable otherwise', async () => {
    const scanRoot = path.join(fx.root, 'scanroot2');
    const deep = path.join(scanRoot, 'a', 'b', 'c', 'repo');
    mkdirSync(deep, { recursive: true });
    fx.git(deep, ['init', '-q', '.']);
    fx.symlink('a/b/c', path.join(scanRoot, 'shortcut'));
    // depth 2 reaches the repo only through the shortcut (shortcut/repo).
    const result = await core.scan(scanRoot, { depth: 2 });
    expect(result.repositories).toEqual([deep]);
  });
});
