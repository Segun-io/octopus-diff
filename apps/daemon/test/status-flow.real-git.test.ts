import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { WorktreeReview } from '@octopus-diff/contracts';
import { GIT_CORE_IMPLEMENTED } from '@octopus-diff/git-core';
import { describe, expect, it } from 'vitest';
import { hashId } from '../src/ids.js';
import { client, tempDir } from './helpers.js';
import {
  makeRealGitFixture,
  makeRealRepo,
  type RealGitFixture,
  startRealGitDaemon,
} from './real-git-fixture.js';

/**
 * Status flow v2 (docs/STATUS-FLOW.md) against real git: bookmarks ("reviewed up to"), the To
 * review scope, Review all moving the bookmark, history rewrites, and persistence.
 */

async function setup() {
  const fx = await makeRealGitFixture();
  const stateDir = await tempDir();
  const repo = await makeRealRepo(fx, 'app', { 'a.txt': 'one\ntwo\n', 'b.txt': 'b\n' });
  const feature = path.join(fx.root, 'app-feature');
  fx.git(repo, 'worktree', 'add', '-q', '-b', 'feature', feature);
  const daemon = await startRealGitDaemon(fx, stateDir);
  const api = client(daemon);
  await api.addProject({ path: repo });
  return {
    fx,
    stateDir,
    repo,
    feature,
    daemon,
    api,
    projectId: hashId(realpathSync(path.join(repo, '.git'))),
    mainId: hashId(repo),
    featureId: hashId(feature),
  };
}

type Api = Awaited<ReturnType<typeof setup>>['api'];

async function review(api: Api, worktreeId: string): Promise<WorktreeReview> {
  const { summary } = await api.refreshWorktree(worktreeId);
  if (!summary.review) throw new Error('no review state');
  return summary.review;
}

function commit(fx: RealGitFixture, dir: string, message: string) {
  fx.git(dir, 'add', '-A');
  fx.git(dir, 'commit', '-q', '-m', message);
  return fx.git(dir, 'rev-parse', 'HEAD').trim();
}

const head = (fx: RealGitFixture, dir: string) => fx.git(dir, 'rev-parse', 'HEAD').trim();

describe.skipIf(!GIT_CORE_IMPLEMENTED)('status flow v2: bookmarks (real git)', () => {
  it('starts bookmarks at HEAD (default branch) and at the merge-base (other branches)', async () => {
    const { fx, repo, feature, api, mainId, featureId } = await setup();
    const base = head(fx, repo);
    expect(await review(api, mainId)).toEqual({
      bookmark: base,
      base,
      newCommits: 0,
      unreviewedFiles: 0,
      historyRewritten: false,
    });
    // An agent commits on the feature branch: the row has work even with a clean tree.
    await writeFile(path.join(feature, 'a.txt'), 'one\nTWO\n');
    commit(fx, feature, 'feature: a');
    const r = await review(api, featureId);
    expect(r).toMatchObject({ bookmark: base, base, newCommits: 1, unreviewedFiles: 1 });
    const files = await api.listFiles(featureId, { scope: { kind: 'review' } });
    expect(files.scope).toEqual({ kind: 'review', base });
    expect(files.files.map((f) => [f.path, f.reviewed])).toEqual([['a.txt', false]]);
    // The working scope is empty: a commit no longer hides the work.
    expect((await api.listFiles(featureId)).files).toEqual([]);
  });

  it('a file reviewed uncommitted stays reviewed after the agent commits it', async () => {
    const { fx, feature, api, projectId, featureId } = await setup();
    await writeFile(path.join(feature, 'b.txt'), 'B\n');
    await writeFile(path.join(feature, 'c.txt'), 'new\n');
    await review(api, featureId);
    const before = await api.listFiles(featureId, { scope: { kind: 'review' } });
    const b = before.files.find((f) => f.path === 'b.txt');
    if (!b) throw new Error('b.txt');
    await api.setReview({
      projectId,
      scopeKind: 'review',
      path: b.path,
      patchHash: b.patchHash,
      reviewed: true,
    });
    expect((await review(api, featureId)).unreviewedFiles).toBe(1);
    commit(fx, feature, 'agent: b and c');
    const after = await api.listFiles(featureId, { scope: { kind: 'review' } });
    expect(after.files.map((f) => [f.path, f.reviewed])).toEqual([
      ['b.txt', true],
      ['c.txt', false],
    ]);
    expect(await review(api, featureId)).toMatchObject({ newCommits: 1, unreviewedFiles: 1 });
  });

  it('Review all moves the bookmark to HEAD; undo restores it; PUT validates the target', async () => {
    const { fx, repo, feature, api, featureId } = await setup();
    const base = head(fx, repo);
    await writeFile(path.join(feature, 'a.txt'), 'one\nTWO\n');
    const tip = commit(fx, feature, 'feature: a');
    await writeFile(path.join(feature, 'b.txt'), 'B\n');
    const stateHash = (await api.refreshWorktree(featureId)).summary.stateHash;
    const res = await api.bulkReview({
      target: { kind: 'worktree', worktreeId: featureId },
      scope: { kind: 'review' },
      advanceBookmarks: true,
      expectedStateHashes: { [featureId]: stateHash },
    });
    expect(res).toMatchObject({ changed: 2, bookmarks: 1, stale: [] });
    expect(await review(api, featureId)).toMatchObject({
      bookmark: tip,
      base: tip,
      newCommits: 0,
      unreviewedFiles: 0,
    });
    if (!res.undoToken) throw new Error('undo token');
    await api.undoReview({ undoToken: res.undoToken });
    expect(await review(api, featureId)).toMatchObject({
      bookmark: base,
      newCommits: 1,
      unreviewedFiles: 2,
    });

    // PUT: HEAD and ancestors only, full ids only; undo goes through the bulk undo path.
    await expect(api.setBookmark({ worktreeId: featureId, to: tip.slice(0, 8) })).rejects.toThrow();
    const other = head(fx, repo);
    fx.git(repo, 'commit', '-q', '--allow-empty', '-m', 'main moves on');
    await expect(api.setBookmark({ worktreeId: featureId, to: head(fx, repo) })).rejects.toThrow(
      /ancestor/,
    );
    const put = await api.setBookmark({ worktreeId: featureId, to: tip });
    expect(put).toMatchObject({ ok: true, bookmark: tip, previous: other });
    expect((await review(api, featureId)).bookmark).toBe(tip);
    if (!put.undoToken) throw new Error('undo token');
    await api.undoReview({ undoToken: put.undoToken });
    expect((await review(api, featureId)).bookmark).toBe(other);
  });

  it('history rewritten: the bookmark is no longer an ancestor; bookmarks survive a restart', async () => {
    const { fx, repo, feature, api, featureId, stateDir, daemon } = await setup();
    const base = head(fx, repo);
    await writeFile(path.join(feature, 'a.txt'), 'one\nTWO\n');
    commit(fx, feature, 'one');
    await writeFile(path.join(feature, 'b.txt'), 'B\n');
    const tip = commit(fx, feature, 'two');
    await api.setBookmark({ worktreeId: featureId, to: tip });
    fx.git(feature, 'reset', '-q', '--hard', 'HEAD~1');
    const r = await review(api, featureId);
    expect(r).toMatchObject({ bookmark: tip, base, historyRewritten: true });

    await daemon.close();
    const again = await startRealGitDaemon(fx, stateDir);
    const api2 = client(again);
    expect((await review(api2, featureId)).bookmark).toBe(tip);
  });
});

describe.skipIf(!GIT_CORE_IMPLEMENTED)('status flow v2: no double review (real git)', () => {
  /** Reviews a feature branch through PUT (records commits, writes no file marks). */
  async function reviewBranch(api: Api, fx: RealGitFixture, dir: string, worktreeId: string) {
    await review(api, worktreeId);
    const res = await api.setBookmark({ worktreeId, to: head(fx, dir) });
    expect(res.recorded).toBeGreaterThan(0);
  }

  async function unreviewed(api: Api, worktreeId: string): Promise<string[]> {
    const { files } = await api.listFiles(worktreeId, { scope: { kind: 'review' } });
    return files.filter((f) => !f.reviewed).map((f) => f.path);
  }

  it('marks do not depend on the scope kind', async () => {
    const { feature, api, projectId, featureId } = await setup();
    await writeFile(path.join(feature, 'a.txt'), 'one\nTWO\n');
    await review(api, featureId);
    const [file] = (await api.listFiles(featureId)).files;
    if (!file) throw new Error('a.txt');
    await api.setReview({
      projectId,
      scopeKind: 'working',
      path: file.path,
      patchHash: file.patchHash,
      reviewed: true,
    });
    // Same patch in the review scope (bookmark = merge-base = HEAD): reviewed there too.
    expect((await api.listFiles(featureId, { scope: { kind: 'review' } })).files[0]?.reviewed).toBe(
      true,
    );
    expect((await review(api, featureId)).unreviewedFiles).toBe(0);
    // Unreviewing from another scope removes it everywhere.
    await api.setReview({
      projectId,
      scopeKind: 'review',
      path: file.path,
      patchHash: file.patchHash,
      reviewed: false,
    });
    expect((await api.listFiles(featureId)).files[0]?.reviewed).toBe(false);
  });

  it('fast-forward: commits reviewed on the branch are skipped on main (by commit id)', async () => {
    const { fx, repo, feature, api, mainId, featureId } = await setup();
    await writeFile(path.join(feature, 'a.txt'), 'one\nTWO\n');
    commit(fx, feature, 'a');
    await reviewBranch(api, fx, feature, featureId);
    fx.git(repo, 'merge', '-q', '--ff-only', 'feature');
    expect(await review(api, mainId)).toMatchObject({ newCommits: 0, unreviewedFiles: 0 });
    // The file is in main's review diff, shown as reviewed.
    const files = await api.listFiles(mainId, { scope: { kind: 'review' } });
    expect(files.files.map((f) => [f.path, f.reviewed])).toEqual([['a.txt', true]]);
  });

  it('merge commit: a clean merge of reviewed commits brings nothing; new main commits still count', async () => {
    const { fx, repo, feature, api, mainId, featureId } = await setup();
    await writeFile(path.join(feature, 'a.txt'), 'one\nTWO\n');
    commit(fx, feature, 'feature a');
    await reviewBranch(api, fx, feature, featureId);
    await writeFile(path.join(repo, 'b.txt'), 'B on main\n');
    commit(fx, repo, 'main b');
    fx.git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'feature');
    // main's own unreviewed commit counts; the feature's commit and the clean merge do not.
    expect(await review(api, mainId)).toMatchObject({ newCommits: 1, unreviewedFiles: 1 });
    expect(await unreviewed(api, mainId)).toEqual(['b.txt']);
  });

  it('squash merge: skipped by the reviewed range patch-id', async () => {
    const { fx, repo, feature, api, mainId, featureId } = await setup();
    await writeFile(path.join(feature, 'a.txt'), 'one\nTWO\n');
    commit(fx, feature, 'first');
    await writeFile(path.join(feature, 'c.txt'), 'new\n');
    commit(fx, feature, 'second');
    await reviewBranch(api, fx, feature, featureId);
    fx.git(repo, 'merge', '-q', '--squash', 'feature');
    fx.git(repo, 'commit', '-q', '-m', 'squashed');
    expect(await review(api, mainId)).toMatchObject({ newCommits: 0, unreviewedFiles: 0 });
    expect(await unreviewed(api, mainId)).toEqual([]);
  });

  it('rebase: history rewritten, nothing previously reviewed shows as unreviewed (patch-id)', async () => {
    const { fx, repo, feature, api, mainId, featureId } = await setup();
    await writeFile(path.join(feature, 'a.txt'), 'one\nTWO\n');
    commit(fx, feature, 'feature a');
    await reviewBranch(api, fx, feature, featureId);
    await writeFile(path.join(repo, 'b.txt'), 'B on main\n');
    commit(fx, repo, 'main b');
    await review(api, mainId);
    await api.setBookmark({ worktreeId: mainId, to: head(fx, repo) });
    fx.git(feature, 'rebase', '-q', 'main');
    expect(await review(api, featureId)).toMatchObject({
      historyRewritten: true,
      base: head(fx, repo),
      newCommits: 0,
      unreviewedFiles: 0,
    });
  });

  it('reset: the reviewed commits left are not shown as unreviewed', async () => {
    const { fx, feature, api, featureId } = await setup();
    await writeFile(path.join(feature, 'a.txt'), 'one\nTWO\n');
    commit(fx, feature, 'one');
    await writeFile(path.join(feature, 'b.txt'), 'B\n');
    commit(fx, feature, 'two');
    await reviewBranch(api, fx, feature, featureId);
    fx.git(feature, 'reset', '-q', '--hard', 'HEAD~1');
    expect(await review(api, featureId)).toMatchObject({
      historyRewritten: true,
      newCommits: 0,
      unreviewedFiles: 0,
    });
  });

  it('a merge with a conflict resolution shows the resolved file', async () => {
    const { fx, repo, feature, api, mainId, featureId } = await setup();
    await writeFile(path.join(feature, 'a.txt'), 'one\nFEATURE\n');
    commit(fx, feature, 'feature a');
    await reviewBranch(api, fx, feature, featureId);
    await writeFile(path.join(repo, 'a.txt'), 'one\nMAIN\n');
    commit(fx, repo, 'main a');
    await review(api, mainId);
    await api.setBookmark({ worktreeId: mainId, to: head(fx, repo) });
    try {
      fx.git(repo, 'merge', '-q', '--no-edit', 'feature');
    } catch {
      // conflict expected
    }
    await writeFile(path.join(repo, 'a.txt'), 'one\nRESOLVED\n');
    commit(fx, repo, 'merge feature');
    expect(await review(api, mainId)).toMatchObject({ newCommits: 1, unreviewedFiles: 1 });
    expect(await unreviewed(api, mainId)).toEqual(['a.txt']);
  });
});
