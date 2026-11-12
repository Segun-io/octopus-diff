/**
 * #40, DaemonCore with a fake git-core: the watcher's paths become `changedPaths`, anything else
 * (and the refresh after a failed one) is a full refresh.
 */
import type { SummaryOptions } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { FakeGitCore } from './fake-git-core.js';
import { client, eventually, sleep, startTestDaemon, tempDir } from './helpers.js';

describe('DaemonCore hints (#40)', () => {
  it('passes watcher paths, and refreshes in full after a failed refresh', async () => {
    const fake = new FakeGitCore();
    const repo = await fake.createRepo(await tempDir(), 'r');
    const main = repo.worktrees[0];
    if (!main) throw new Error('fixture');
    const daemon = await startTestDaemon({ fake, stateDir: await tempDir() });
    await client(daemon).addProject({ path: repo.mainPath });
    await eventually(() => daemon.core.watcher.isWatched(main.id), 5000);
    await sleep(300);
    const watcher = daemon.core.watcher;
    /** Runs `trigger` and waits for the summary it causes (the fake counts calls at once). */
    const after = async (trigger: () => void): Promise<SummaryOptions | undefined> => {
      const before = fake.callCount('getSummary');
      trigger();
      await eventually(() => fake.callCount('getSummary') > before, 5000);
      await sleep(50);
      return fake.lastScopeOptions as SummaryOptions | undefined;
    };

    expect(
      (await after(() => watcher.markDirty(main.id, 'fs', ['a.txt', 'dir/b c.txt'])))?.changedPaths,
    ).toEqual(['a.txt', 'dir/b c.txt']);
    await sleep(400);

    expect((await after(() => watcher.markDirty(main.id, 'focus')))?.changedPaths).toBeUndefined();
    await sleep(400);

    // A refresh that fails loses nothing: its paths come back as "refresh in full".
    fake.fail('getSummary', 'git_failed');
    await after(() => watcher.markDirty(main.id, 'fs', ['lost.txt'])); // fails at once
    await sleep(400);
    fake.failures.delete('getSummary');
    expect(
      (await after(() => watcher.markDirty(main.id, 'fs', ['later.txt'])))?.changedPaths,
    ).toBeUndefined();
    await sleep(400);
    expect(
      (await after(() => watcher.markDirty(main.id, 'fs', ['again.txt'])))?.changedPaths,
    ).toEqual(['again.txt']);
  }, 20_000);

  it('Refresh refreshes in full and forgets git-core state, even with watcher paths pending', async () => {
    const fake = new FakeGitCore();
    const repo = await fake.createRepo(await tempDir(), 'r');
    const main = repo.worktrees[0];
    if (!main) throw new Error('fixture');
    const daemon = await startTestDaemon({ fake, stateDir: await tempDir() });
    await client(daemon).addProject({ path: repo.mainPath });
    await eventually(() => daemon.core.watcher.isWatched(main.id), 5000);
    await sleep(300);
    // A slow summary is running; the watcher's next paths wait for the refresh after it.
    fake.methodDelay.set('getSummary', 400);
    const before = fake.callCount('getSummary');
    daemon.core.watcher.markDirty(main.id, 'fs', ['a.txt']);
    await eventually(() => fake.callCount('getSummary') > before, 5000);
    daemon.core.watcher.markDirty(main.id, 'fs', ['b.txt']);
    await sleep(250); // past the debounce: b.txt is the queued refresh's hint
    await client(daemon).refreshWorktree(main.id);
    const last = fake.lastScopeOptions as SummaryOptions | undefined;
    expect(last?.changedPaths).toBeUndefined();
    expect(last?.forgetState).toBe(true);
  }, 20_000);
});
