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
