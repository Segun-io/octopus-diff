import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import parcelWatcher from '@parcel/watcher';
import { describe, expect, it } from 'vitest';
import { hashId } from '../src/ids.js';
import type { SubscribeFn } from '../src/watcher.js';
import { FakeGitCore } from './fake-git-core.js';
import { client, eventually, recordEvents, sleep, startTestDaemon, tempDir } from './helpers.js';

/** DaemonCore ↔ watcher wiring for the review fixes (fake git-core, real file system). */

function recordingSubscribe(): { subscribe: SubscribeFn; dirs: string[] } {
  const dirs: string[] = [];
  return {
    dirs,
    subscribe: async (dir, fn, opts) => {
      dirs.push(dir);
      return parcelWatcher.subscribe(dir, fn, opts);
    },
  };
}

describe('watch wiring in DaemonCore', () => {
  it('never watches prunable (broken or forged) worktree records (SEC-07)', async () => {
    const fake = new FakeGitCore();
    const base = await tempDir();
    const repo = await fake.createRepo(base, 'r', { linked: ['wt', 'forged'] });
    const [, linked, forged] = repo.worktrees;
    if (!linked || !forged) throw new Error('fixture');
    forged.prunable = true;
    const rec = recordingSubscribe();
    const daemon = await startTestDaemon({
      fake,
      stateDir: await tempDir(),
      internal: { subscribe: rec.subscribe },
    });
    await client(daemon).addProject({ path: repo.mainPath });
    await eventually(() => daemon.core.watcher.isWatched(linked.id), 5000);
    expect(daemon.core.watcher.isWatched(forged.id)).toBe(false);
    expect(rec.dirs).not.toContain(forged.path);
  });

  it('reports a refused worktree folder in /api/health without subscribing to it (SEC-07)', async () => {
    const fake = new FakeGitCore();
    const base = await tempDir();
    const repo = await fake.createRepo(base, 'r');
    const main = repo.worktrees[0];
    if (!main) throw new Error('fixture');
    // A forged record pointing at the filesystem root (git-core reports it as an existing
    // worktree when it is not flagged prunable).
    repo.worktrees.push({
      ...main,
      id: hashId('/'),
      path: '/',
      gitDir: path.join(repo.commonDir, 'worktrees', 'forged'),
      branch: 'forged',
      isMain: false,
      files: new Map(),
    });
    const rec = recordingSubscribe();
    const daemon = await startTestDaemon({
      fake,
      stateDir: await tempDir(),
      internal: { subscribe: rec.subscribe },
    });
    const api = client(daemon);
    await api.addProject({ path: repo.mainPath });
    await eventually(() => daemon.core.watcher.isWatched(hashId('/')), 5000);
    // The main worktree's native subscription completes asynchronously; until it does the mode
    // reads 'polling' (no native worktree yet). Wait for the settled state instead of racing it.
    const health = await eventually(async () => {
      const h = await api.health();
      return h.watcher.mode === 'mixed' ? h : null;
    }, 5000);
    expect(health.watcher.mode).toBe('mixed');
    expect(health.watcher.warnings).toHaveLength(1);
    expect(health.watcher.warnings[0]).toMatch(/Not watching 1 worktree folder.*filesystem root/);
    expect(rec.dirs).not.toContain('/');
  });

  it("re-fetches watch targets when a worktree's .git points at a new admin dir (F1)", async () => {
    const fake = new FakeGitCore();
    const base = await tempDir();
    const repo = await fake.createRepo(base, 'r', { linked: ['wt'] });
    const wt = repo.worktrees[1];
    if (!wt) throw new Error('fixture');
    await writeFile(path.join(wt.path, '.git'), `gitdir: ${wt.gitDir}\n`);
    const daemon = await startTestDaemon({
      fake,
      stateDir: await tempDir(),
      internal: { relistMs: 100 },
    });
    const api = client(daemon);
    const events = recordEvents(daemon);
    await events.opened;
    await api.addProject({ path: repo.mainPath });
    await eventually(() => daemon.core.watcher.isWatched(wt.id), 5000);
    await sleep(300);

    // `git worktree remove` + `git worktree add` at the same path; git picked `worktrees/wt1`.
    // The fake keeps answering with the old git dir, like git-core's repository cache would.
    const newGitDir = path.join(repo.commonDir, 'worktrees', 'wt1');
    await mkdir(newGitDir, { recursive: true });
    const before = fake.callCount('getWatchTargets');
    await rm(wt.path, { recursive: true, force: true });
    await mkdir(wt.path);
    await writeFile(path.join(wt.path, '.git'), `gitdir: ${newGitDir}\n`);
    await eventually(() => fake.callCount('getWatchTargets') > before, 5000);
    await sleep(300);

    // Index changes in the new admin dir must refresh that worktree.
    fake.bump(wt.id);
    const mark = events.events.length;
    await writeFile(path.join(newGitDir, 'index'), 'staged by the agent');
    await events.waitFor(
      (e) =>
        events.events.indexOf(e) >= mark && e.type === 'worktree.changed' && e.worktreeId === wt.id,
      5000,
    );

    // Once git-core agrees, the precise targets are used again.
    wt.gitDir = newGitDir;
    const settled = fake.callCount('getWatchTargets');
    await eventually(() => fake.callCount('getWatchTargets') > settled, 5000);
    await sleep(300);
    const calls = fake.callCount('getWatchTargets');
    await sleep(400);
    expect(fake.callCount('getWatchTargets')).toBe(calls); // cached again, no re-fetch per relist
  });
});
