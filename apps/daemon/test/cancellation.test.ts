import { describe, expect, it } from 'vitest';
import type { Daemon } from '../src/daemon.js';
import { FakeGitCore, type FakeRepo, fakeFile } from './fake-git-core.js';
import { client, eventually, http, inproc, sleep, startTestDaemon, tempDir } from './helpers.js';

/**
 * Request cancellation and lanes in the daemon (#44): the HTTP request's signal reaches
 * git-core for `/files`, `/diff`, `/commits` and blobs, in the interactive lane; the single-flight
 * file list is shared by its waiters and cancelled only when the last one leaves, and is never
 * cached from a cancelled run.
 */
async function setup(): Promise<{ fake: FakeGitCore; daemon: Daemon; repo: FakeRepo; wt: string }> {
  const fake = new FakeGitCore();
  const repo = await fake.createRepo(await tempDir(), 'alpha');
  const wt = repo.worktrees[0]?.id ?? '';
  fake.setFiles(wt, 'working', [fakeFile('a.txt'), fakeFile('b.txt')]);
  const daemon = await startTestDaemon({ fake, stateDir: await tempDir() });
  await client(daemon).addProject({ path: repo.mainPath });
  // The first summary is in (a `/files` request would otherwise wait for it).
  await client(daemon).listProjects();
  return { fake, daemon, repo, wt };
}

const filesPath = (wt: string) => `/api/worktrees/${wt}/files?scope=working`;

/** Starts a request through the real HTTP server that the test can abort. */
function request(daemon: Daemon, pathname: string, controller?: AbortController) {
  return http(daemon, pathname, controller ? { signal: controller.signal } : {}).then(
    async (res) => ({ status: res.status, body: (await res.json()) as unknown }),
    (error: unknown) => ({ status: 0, body: error }),
  );
}

describe('request cancellation (#44)', () => {
  it('one of two waiters aborting does not cancel or poison the shared file list', async () => {
    const { fake, daemon, wt } = await setup();
    fake.methodDelay.set('listChangedFiles', 300);
    const before = fake.callCount('listChangedFiles');
    const leaving = new AbortController();
    const first = request(daemon, filesPath(wt), leaving);
    await eventually(() => fake.callCount('listChangedFiles') === before + 1);
    const second = request(daemon, filesPath(wt));
    await sleep(50);
    leaving.abort();
    expect((await first).status).toBe(0);
    // The shared run went on for the second request: its signal was not aborted.
    expect(fake.lastFilesOptions?.signal?.aborted).toBe(false);
    const answer = await second;
    expect(answer.status).toBe(200);
    expect((answer.body as { files: Array<{ path: string }> }).files.map((f) => f.path)).toEqual([
      'a.txt',
      'b.txt',
    ]);
    // One run for both, and its result was cached: a third request costs no git-core call.
    expect(fake.callCount('listChangedFiles')).toBe(before + 1);
    expect((await request(daemon, filesPath(wt))).status).toBe(200);
    expect(fake.callCount('listChangedFiles')).toBe(before + 1);
  });

  it('the last waiter leaving cancels the run; nothing is cached and the next request starts anew', async () => {
    const { fake, daemon, wt } = await setup();
    fake.methodDelay.set('listChangedFiles', 300);
    const before = fake.callCount('listChangedFiles');
    const a = new AbortController();
    const b = new AbortController();
    const first = request(daemon, filesPath(wt), a);
    await eventually(() => fake.callCount('listChangedFiles') === before + 1);
    const signal = fake.lastFilesOptions?.signal;
    const second = request(daemon, filesPath(wt), b);
    await sleep(50);
    a.abort();
    await sleep(20);
    expect(signal?.aborted).toBe(false);
    b.abort();
    await Promise.all([first, second]);
    await eventually(() => signal?.aborted === true);
    fake.methodDelay.delete('listChangedFiles');
    const third = await request(daemon, filesPath(wt));
    expect(third.status).toBe(200);
    expect((third.body as { files: unknown[] }).files).toHaveLength(2);
    expect(fake.callCount('listChangedFiles')).toBe(before + 2);
  });

  it('passes the interactive lane for /files, /diff and /commits, and nothing for the inbox', async () => {
    const { fake, daemon, wt } = await setup();
    await http(daemon, filesPath(wt));
    expect(fake.lastFilesOptions?.priority).toBe('interactive');
    expect(fake.lastFilesOptions?.signal).toBeInstanceOf(AbortSignal);
    await http(daemon, `/api/worktrees/${wt}/diff?scope=working&path=a.txt`);
    expect(fake.lastDiffOptions?.priority).toBe('interactive');
    expect(fake.lastDiffOptions?.signal).toBeInstanceOf(AbortSignal);
    await http(daemon, `/api/worktrees/${wt}/commits?limit=5`);
    expect(fake.lastCommitsOptions?.priority).toBe('interactive');
    fake.bump(wt);
    await client(daemon).refreshWorktree(wt);
    await http(daemon, '/api/inbox?scope=working');
    expect(fake.lastFilesOptions?.priority).toBeUndefined();
    expect(fake.lastFilesOptions?.signal).toBeUndefined();
  });

  it('an aborted /diff gets no error body and no error log; git-core saw the abort', async () => {
    const { fake, daemon, wt } = await setup();
    fake.methodDelay.set('getFileDiff', 2_000);
    const controller = new AbortController();
    const pending = inproc(daemon, `/api/worktrees/${wt}/diff?scope=working&path=a.txt`, {
      signal: controller.signal,
    });
    await eventually(() => fake.lastDiffOptions?.signal !== undefined);
    controller.abort();
    const res = await pending;
    expect(res.status).toBe(499);
    expect(await res.text()).toBe('');
    expect(fake.lastDiffOptions?.signal?.aborted).toBe(true);
  });
});
