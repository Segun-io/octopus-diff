import path from 'node:path';
import { type GitCore, isGitCoreError } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGitCore } from '../src/index.js';
import {
  expectConsistentHashes,
  expectFile,
  fileDiff,
  listFiles,
  locator,
} from './helpers/core.js';
import { createFixture, type Fixture, lines } from './helpers/fixture.js';

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

describe('merge conflicts', () => {
  let repo: string;

  beforeAll(() => {
    repo = fx.repo('conflict', { files: { 'x.txt': 'base\n', 'other.txt': 'o\n' } });
    fx.git(repo, ['switch', '-q', '-c', 'feat']);
    fx.write(path.join(repo, 'x.txt'), 'feat\n');
    fx.commitAll(repo, 'feat');
    fx.git(repo, ['switch', '-q', 'main']);
    fx.write(path.join(repo, 'x.txt'), 'main\n');
    fx.commitAll(repo, 'main');
    fx.git(repo, ['merge', 'feat'], { allowFail: true });
    fx.write(path.join(repo, 'other.txt'), 'changed\n');
  });

  it('reports conflicted files in every status-based scope with consistent hashes', async () => {
    const wt = locator(repo);
    for (const kind of ['working', 'staged', 'unstaged'] as const) {
      const files = await listFiles(core, wt, { kind });
      expectFile(files, 'x.txt', { status: 'conflicted' });
      await expectConsistentHashes(core, wt, { kind }, files);
    }
    const working = await fileDiff(core, wt, { kind: 'working' }, { path: 'x.txt' });
    expect(working.patch).toContain('+<<<<<<< HEAD');
    const unstaged = await fileDiff(core, wt, { kind: 'unstaged' }, { path: 'x.txt' });
    expect(unstaged.patch).toContain('diff --cc x.txt');
    const staged = await fileDiff(core, wt, { kind: 'staged' }, { path: 'x.txt' });
    expect(staged.patch).toContain('* Unmerged path x.txt');
  });

  it('reports the merge in the summary', async () => {
    const summary = await core.getSummary(locator(repo));
    expect(summary.inProgress).toBe('merge');
    expect(summary.counts.conflicted).toBe(1);
    expect(summary.counts.unstaged).toBe(1);
  });
});

describe('submodules and symlinks', () => {
  let repo: string;

  beforeAll(() => {
    const sub = fx.repo('sub-origin', { files: { 's.txt': 's\n' } });
    repo = fx.repo('super', { files: { 'a.txt': 'a\n', link: 'placeholder\n' } });
    fx.git(repo, ['rm', '-q', 'link']);
    fx.symlink('a.txt', path.join(repo, 'link'));
    fx.git(repo, ['submodule', 'add', '-q', sub, 'sm']);
    fx.commitAll(repo, 'add submodule and symlink');
    const smDir = path.join(repo, 'sm');
    fx.write(path.join(smDir, 't.txt'), 't\n');
    fx.commitAll(smDir, 'sub change');
    fx.git(repo, ['rm', '-q', '--cached', 'link']);
    fx.write(path.join(repo, 'b.txt'), 'b\n');
    fx.git(repo, ['add', 'b.txt']);
    // Re-point the symlink and track it again.
    fx.git(repo, ['add', 'link']);
  });

  it('shows a submodule commit change as a gitlink diff', async () => {
    const wt = locator(repo);
    const files = await listFiles(core, wt, { kind: 'working' });
    const sm = expectFile(files, 'sm', {
      status: 'modified',
      oldMode: '160000',
      newMode: '160000',
    });
    expect(sm.additions).toBe(1);
    const diff = await fileDiff(core, wt, { kind: 'working' }, { path: 'sm' });
    expect(diff.patch).toMatch(
      /-Subproject commit [0-9a-f]{40}\n\+Subproject commit [0-9a-f]{40}\n/,
    );
    await expectConsistentHashes(core, wt, { kind: 'working' }, files);
  });

  it('ignores changes inside a submodule worktree (dirty submodules)', async () => {
    fx.write(path.join(repo, 'sm', 'dirty.txt'), 'dirty\n');
    const files = await listFiles(core, locator(repo), { kind: 'unstaged' });
    expect(files.map((f) => f.path)).toEqual(['sm']);
  });

  it('diffs symlink targets', async () => {
    const commit = fx.git(repo, ['rev-parse', 'HEAD']).trim();
    const files = await listFiles(core, locator(repo), { kind: 'commit', sha: commit });
    expectFile(files, 'link', { status: 'typechange', oldMode: '100644', newMode: '120000' });
    expectFile(files, 'sm', { status: 'added', newMode: '160000' });
    expectFile(files, '.gitmodules', { status: 'added' });
  });
});

describe('unborn HEAD', () => {
  let repo: string;

  beforeAll(() => {
    repo = fx.repo('unborn', { empty: true });
    fx.write(path.join(repo, 'staged.txt'), 'one\ntwo\n');
    fx.git(repo, ['add', 'staged.txt']);
    fx.write(path.join(repo, 'staged.txt'), 'one\ntwo\nthree\n');
    fx.write(path.join(repo, 'untracked.txt'), 'u\n');
  });

  it('diffs against the empty tree', async () => {
    const wt = locator(repo);
    const working = await listFiles(core, wt, { kind: 'working' });
    expectFile(working, 'staged.txt', {
      status: 'added',
      additions: 3,
      staged: true,
      unstaged: true,
    });
    expectFile(working, 'untracked.txt', { status: 'untracked' });
    const staged = await listFiles(core, wt, { kind: 'staged' });
    expectFile(staged, 'staged.txt', { status: 'added', additions: 2 });
    const unstaged = await listFiles(core, wt, { kind: 'unstaged' });
    expectFile(unstaged, 'staged.txt', { status: 'modified', additions: 1 });
    for (const kind of ['working', 'staged', 'unstaged'] as const) {
      await expectConsistentHashes(core, wt, { kind }, await listFiles(core, wt, { kind }));
    }
    expect(await listFiles(core, wt, { kind: 'branch', base: 'main' }).catch((e) => e)).toSatisfy(
      (value: unknown) => isGitCoreError(value, 'not_found'),
    );
    expect(await core.listCommits(wt)).toEqual([]);
  });

  it('summarizes an unborn branch', async () => {
    const summary = await core.getSummary(locator(repo));
    expect(summary).toMatchObject({
      branch: 'main',
      headSha: null,
      detached: false,
      ahead: null,
      behind: null,
      changedFiles: 2,
      counts: { staged: 1, unstaged: 1, untracked: 1, conflicted: 0 },
      additions: 4,
    });
  });
});

describe('branch and commit scopes', () => {
  let repo: string;
  let root: string;
  let featureFirst: string;
  let merge: string;

  beforeAll(() => {
    repo = fx.repo('history', { files: { 'base.txt': lines(5), 'shared.txt': 'shared\n' } });
    root = fx.git(repo, ['rev-parse', 'HEAD']).trim();
    fx.git(repo, ['switch', '-q', '-c', 'feature']);
    fx.write(path.join(repo, 'feature.txt'), 'feature\n');
    fx.write(path.join(repo, 'base.txt'), lines(5).replace('line 3', 'line three'));
    featureFirst = fx.commitAll(repo, 'feature work');
    fx.git(repo, ['switch', '-q', 'main']);
    fx.write(path.join(repo, 'main-only.txt'), 'main\n');
    fx.commitAll(repo, 'main work');
    fx.git(repo, ['switch', '-q', 'feature']);
    fx.write(path.join(repo, 'feature2.txt'), 'two\n');
    fx.commitAll(repo, 'more feature');
    fx.git(repo, ['merge', '-q', '--no-edit', 'main']);
    merge = fx.git(repo, ['rev-parse', 'HEAD']).trim();
    // Uncommitted work is not part of the branch scope.
    fx.write(path.join(repo, 'uncommitted.txt'), 'u\n');
  });

  it('diffs HEAD against the merge base with the default branch', async () => {
    const wt = locator(repo);
    const files = await listFiles(core, wt, { kind: 'branch' });
    expect(files.map((f) => f.path)).toEqual(['base.txt', 'feature.txt', 'feature2.txt']);
    expectFile(files, 'base.txt', { status: 'modified', staged: false, unstaged: false });
    await expectConsistentHashes(core, wt, { kind: 'branch' }, files);
    const explicit = await listFiles(core, wt, { kind: 'branch', base: 'main' });
    expect(explicit.map((f) => f.patchHash)).toEqual(files.map((f) => f.patchHash));
    const viaOption = await listFiles(
      core,
      wt,
      { kind: 'branch' },
      { defaultBranch: 'refs/heads/main' },
    );
    expect(viaOption.map((f) => f.path)).toEqual(files.map((f) => f.path));
  });

  it('reports missing bases', async () => {
    const wt = locator(repo);
    const missing = await core
      .listChangedFiles(wt, { kind: 'branch', base: 'nope' })
      .catch((e) => e);
    expect(isGitCoreError(missing, 'not_found')).toBe(true);
    const lone = fx.repo('lone', { files: { 'a.txt': 'a\n' } });
    fx.git(lone, ['branch', '-m', 'main', 'develop']);
    const noDefault = await core
      .listChangedFiles(locator(lone), { kind: 'branch' })
      .catch((e) => e);
    expect(isGitCoreError(noDefault, 'invalid_argument')).toBe(true);
  });

  it('diffs single commits, including root and merge commits', async () => {
    const wt = locator(repo);
    const rootFiles = await listFiles(core, wt, { kind: 'commit', sha: root });
    expect(rootFiles.map((f) => [f.path, f.status])).toEqual([
      ['base.txt', 'added'],
      ['shared.txt', 'added'],
    ]);
    await expectConsistentHashes(core, wt, { kind: 'commit', sha: root }, rootFiles);
    const short = await listFiles(core, wt, { kind: 'commit', sha: featureFirst.slice(0, 8) });
    expect(short.map((f) => f.path)).toEqual(['base.txt', 'feature.txt']);
    const mergeFiles = await listFiles(core, wt, { kind: 'commit', sha: merge });
    expect(mergeFiles.map((f) => f.path)).toEqual(['main-only.txt']);
    const missing = await core
      .listChangedFiles(wt, { kind: 'commit', sha: 'deadbeefdeadbeef' })
      .catch((e: unknown) => e);
    expect(isGitCoreError(missing, 'not_found')).toBe(true);
  });

  it("honors each worktree's .gitattributes in commit scope", async () => {
    const commit = fx.git(repo, ['rev-parse', 'HEAD~1']).trim();
    const linked = path.join(fx.root, 'history-attr');
    fx.git(repo, ['worktree', 'add', '-q', '--detach', linked, 'HEAD']);
    fx.write(path.join(linked, '.gitattributes'), '*.txt -diff\n');
    const mainFiles = await listFiles(core, locator(repo), { kind: 'commit', sha: commit });
    const linkedFiles = await listFiles(core, locator(linked), { kind: 'commit', sha: commit });
    expect(mainFiles.find((f) => f.path === 'feature2.txt')?.binary).toBe(false);
    expect(linkedFiles.find((f) => f.path === 'feature2.txt')?.binary).toBe(true);
    await expectConsistentHashes(
      core,
      locator(linked),
      { kind: 'commit', sha: commit },
      linkedFiles,
    );
  });

  it('returns fresh objects for repeated history queries', async () => {
    const wt = locator(repo);
    const first = await listFiles(core, wt, { kind: 'commit', sha: root });
    (first[0] as { path: string }).path = 'mutated';
    const second = await listFiles(core, wt, { kind: 'commit', sha: root });
    expect(second[0]?.path).toBe('base.txt');
  });

  it('lists commits newest first', async () => {
    const commits = await core.listCommits(locator(repo), { limit: 3 });
    expect(commits).toHaveLength(3);
    expect(commits[0]?.sha).toBe(merge);
    expect(commits[0]?.parents).toHaveLength(2);
    expect(commits[0]?.authorName).toBe('Fixture User');
    expect(commits[0]?.authorDate).toBe('2026-01-01T00:00:00.000Z');
    const all = await core.listCommits(locator(repo));
    expect(all.at(-1)?.sha).toBe(root);
    expect(all.at(-1)?.parents).toEqual([]);
    const bad = await core.listCommits(locator(repo), { limit: 0 }).catch((e: unknown) => e);
    expect(isGitCoreError(bad, 'invalid_argument')).toBe(true);
  });
});

describe('rename pairing with narrowed pathspecs', () => {
  it('matches the list when a pathspec would also match a directory', async () => {
    const repo = fx.repo('narrow', {
      files: { foo: lines(30, 'foo'), baz: lines(30, 'baz'), keep: 'k\n' },
    });
    fx.git(repo, ['rm', '-q', 'foo', 'baz']);
    fx.write(path.join(repo, 'bar'), lines(30, 'foo'));
    fx.write(path.join(repo, 'foo', 'x'), lines(30, 'baz'));
    fx.git(repo, ['add', 'bar', 'foo/x']);
    const wt = locator(repo);
    for (const kind of ['working', 'staged'] as const) {
      const files = await listFiles(core, wt, { kind });
      await expectConsistentHashes(core, wt, { kind }, files);
    }
  });

  it('marks a rename source as staged when status pairs differently', async () => {
    const repo = fx.repo('rename-flags', { files: { a: lines(20, 'a') } });
    fx.git(repo, ['mv', 'a', 'b']);
    fx.write(path.join(repo, 'b'), lines(20, 'completely different'));
    const files = await listFiles(core, locator(repo), { kind: 'working' });
    expectFile(files, 'a', { status: 'deleted', staged: true });
  });
});

describe('bare repositories', () => {
  it('summarizes bare entries and supports history scopes', async () => {
    const source = fx.repo('bare-source', { files: { 'a.txt': 'a\n' } });
    fx.write(path.join(source, 'b.txt'), 'b\n');
    const second = fx.commitAll(source, 'b');
    const bare = path.join(fx.root, 'bare.git');
    fx.git(fx.root, ['clone', '-q', '--bare', source, bare]);
    const wt = locator(bare);
    const summary = await core.getSummary(wt);
    expect(summary).toMatchObject({ branch: 'main', headSha: second, changedFiles: 0 });
    expect(await core.listChangedFiles(wt, { kind: 'working' })).toEqual([]);
    const files = await listFiles(core, wt, { kind: 'commit', sha: second });
    expect(files.map((f) => f.path)).toEqual(['b.txt']);
  });
});
