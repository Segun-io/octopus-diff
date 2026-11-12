import { realpathSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GitCore } from '@octopus-diff/contracts';
import { createGitCore, GIT_CORE_IMPLEMENTED } from '@octopus-diff/git-core';
import { describe, expect, it } from 'vitest';
import { startDaemon } from '../src/daemon.js';
import { hashId } from '../src/ids.js';
import { client, eventually, onCleanup, recordEvents, TEST_TOKEN, tempDir } from './helpers.js';
import { makeRealGitFixture, makeRealRepo, type RealGitFixture } from './real-git-fixture.js';

/**
 * Startup does each worktree's summary once and no review state (#10, decision 2 in #25): the
 * review state is computed when a project is opened (`PUT /api/focus`), or for a worktree that
 * changed after startup, and `review.ready` tells clients when it lands.
 */

/** A real git-core that counts its calls by method name. */
function countingGitCore(fx: RealGitFixture): { git: GitCore; calls: Map<string, number> } {
  const real = createGitCore({ env: fx.env });
  onCleanup(() => real.dispose());
  const calls = new Map<string, number>();
  const git = new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        // Both list calls count as `listChangedFiles` (the daemon uses the one reporting its state).
        const name = prop === 'listChangedFilesWithState' ? 'listChangedFiles' : String(prop);
        calls.set(name, (calls.get(name) ?? 0) + 1);
        return value.apply(target, args);
      };
    },
  });
  return { git, calls };
}

async function setup() {
  const fx = await makeRealGitFixture();
  const repo = await makeRealRepo(fx, 'app', { 'a.txt': 'one\n', 'b.txt': 'b\n' });
  const feature = path.join(fx.root, 'app-feature');
  fx.git(repo, 'worktree', 'add', '-q', '-b', 'feature', feature);
  const other = await makeRealRepo(fx, 'other', { 'c.txt': 'c\n' });
  // Both dirty: their files would all be "to review" if the state were inherited.
  await writeFile(path.join(repo, 'a.txt'), 'one\nmain edit\n');
  await writeFile(path.join(feature, 'b.txt'), 'b\nfeature edit\n');
  await writeFile(path.join(other, 'c.txt'), 'c\nother edit\n');
  const { git, calls } = countingGitCore(fx);
  const daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    stateDir: await tempDir(),
    logLevel: process.env.OCTOPUS_DIFF_TEST_LOGS ? 'debug' : 'silent',
    gitCore: git,
    projects: [repo, other],
    watch: { debounceMs: 150 },
    internal: { forges: false },
  });
  onCleanup(() => daemon.close());
  return {
    fx,
    repo,
    feature,
    daemon,
    api: client(daemon),
    calls,
    projectId: hashId(realpathSync(path.join(repo, '.git'))),
    otherId: hashId(realpathSync(path.join(other, '.git'))),
    mainId: hashId(repo),
    featureId: hashId(feature),
    otherMainId: hashId(other),
  };
}

describe.skipIf(!GIT_CORE_IMPLEMENTED)('startup: summaries once, review on demand (#10)', () => {
  it('computes each summary once and no review state at startup', async () => {
    const { api, calls } = await setup();
    const { projects } = await api.listProjects();
    const worktrees = projects.flatMap((p) => p.worktrees);
    expect(worktrees).toHaveLength(3);
    for (const w of worktrees) {
      expect(w.summary?.changedFiles).toBe(1);
      expect(w.summary?.review).toBeUndefined();
    }
    // One summary per worktree; the review state's own file list (a second status + diff per
    // worktree) and its range are not computed.
    expect(calls.get('getSummary')).toBe(3);
    expect(calls.get('listChangedFiles') ?? 0).toBe(0);
    expect(calls.get('readReviewRange') ?? 0).toBe(0);
  });

  it('opening a project (its worktree or its Overview) computes its review states', async () => {
    const { daemon, api, calls, projectId, otherId, featureId, mainId, otherMainId } =
      await setup();
    await api.listProjects();
    const events = recordEvents(daemon);
    await events.opened;

    await api.setFocus({ worktreeId: featureId });
    await events.waitFor((e) => e.type === 'review.ready' && e.projectId === projectId);
    const opened = (await api.listProjects()).projects;
    const app = opened.find((p) => p.project.id === projectId);
    const ids = (app?.worktrees ?? []).map((w) => [
      w.worktree.id,
      w.summary?.review?.unreviewedFiles,
    ]);
    expect(ids.sort()).toEqual(
      [
        [featureId, 1],
        [mainId, 1],
      ].sort(),
    );
    // The other project stays as it was: its changes, no review state.
    const other = opened.find((p) => p.project.id === otherId);
    expect(other?.worktrees[0]?.summary?.review).toBeUndefined();
    // Two review file lists (the opened project's worktrees), none for the other project.
    expect(calls.get('listChangedFiles')).toBe(2);

    // The project Overview opens a project without a worktree.
    await api.setFocus({ worktreeId: null, projectId: otherId });
    await events.waitFor((e) => e.type === 'review.ready' && e.projectId === otherId);
    const after = (await api.listProjects()).projects.find((p) => p.project.id === otherId);
    expect(after?.worktrees[0]?.worktree.id).toBe(otherMainId);
    expect(after?.worktrees[0]?.summary?.review?.unreviewedFiles).toBe(1);
  });

  it('a commit made after startup still counts as new on the default branch', async () => {
    const { fx, repo, api, mainId } = await setup();
    await api.listProjects();
    // An agent commits on main in a project nobody opened.
    fx.git(repo, 'add', '-A');
    fx.git(repo, 'commit', '-q', '-m', 'agent: main edit');
    const review = await eventually(
      async () => {
        const { projects } = await api.listProjects();
        const main = projects.flatMap((p) => p.worktrees).find((w) => w.worktree.id === mainId);
        return main?.summary?.review;
      },
      8000,
      50,
    );
    // The bookmark was seeded at the startup HEAD, so the commit is one to review.
    expect(review).toMatchObject({ newCommits: 1, unreviewedFiles: 1, historyRewritten: false });
  });

  it('a commit made after startup counts as new in a repository with no default branch', async () => {
    // Only `develop`: nothing is detected as the default branch, so the bookmark must still be seeded
    // at the startup HEAD (the review range falls back to HEAD without a default ref).
    const fx = await makeRealGitFixture();
    const repo = await makeRealRepo(fx, 'solo', { 'a.txt': 'one\n' });
    fx.git(repo, 'branch', '-m', 'develop');
    await writeFile(path.join(repo, 'a.txt'), 'one\nuncommitted\n');
    const { git } = countingGitCore(fx);
    const daemon = await startDaemon({
      host: '127.0.0.1',
      port: 0,
      token: TEST_TOKEN,
      stateDir: await tempDir(),
      logLevel: process.env.OCTOPUS_DIFF_TEST_LOGS ? 'debug' : 'silent',
      gitCore: git,
      projects: [repo],
      watch: { debounceMs: 150 },
      internal: { forges: false },
    });
    onCleanup(() => daemon.close());
    const api = client(daemon);
    const worktreeId = (await api.listProjects()).projects[0]?.worktrees[0]?.worktree.id ?? '';
    expect(worktreeId).not.toBe('');
    fx.git(repo, 'add', '-A');
    fx.git(repo, 'commit', '-q', '-m', 'agent: edit');
    // Do not depend on the watcher noticing the commit (it can be in polling mode, 30 s): ask.
    await api.refreshWorktree(worktreeId);
    const review = await eventually(
      async () => {
        const { projects } = await api.listProjects();
        return projects[0]?.worktrees[0]?.summary?.review;
      },
      8000,
      50,
    );
    expect(review).toMatchObject({ newCommits: 1, historyRewritten: false });
  });
});
