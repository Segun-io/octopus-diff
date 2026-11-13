import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type GitCore, GitCoreError } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import type { Daemon } from '../src/daemon.js';
import { FakeGitCore, fakeFile } from './fake-git-core.js';
import { client, eventually, http, sleep, startTestDaemon, tempDir } from './helpers.js';

/**
 * The daemon's file-list cache (#27, #30, #49): one Effect `Cache` entry per
 * (worktree, scope, stateHash, base commit, attributes), lookups shared by their waiters,
 * cancelled when the last waiter leaves, never filled from a run that was invalidated meanwhile,
 * bounded as before. These tests state the behaviour, not the implementation: they go through the
 * HTTP routes with a fake git-core whose `listChangedFiles` a test can hold.
 */

interface Held {
  release: () => void;
  signal: AbortSignal | undefined;
}

/**
 * Holds every `listChangedFiles` call while `armed` (after it read its answer, as a real git run
 * does: the list is of the moment the call started), until `release` is called.
 */
function holdLists(fake: FakeGitCore) {
  const original = fake.listChangedFiles.bind(fake);
  const held: Held[] = [];
  const state = { armed: false };
  fake.listChangedFiles = async (loc, scope, options) => {
    const files = await original(loc, scope, options);
    if (!state.armed) return files;
    await new Promise<void>((resolve, reject) => {
      const signal = options?.signal;
      held.push({ release: resolve, signal });
      signal?.addEventListener('abort', () => reject(new GitCoreError('aborted', 'aborted')), {
        once: true,
      });
    });
    return files;
  };
  return {
    held,
    arm: () => {
      state.armed = true;
    },
    disarm: () => {
      state.armed = false;
    },
    releaseAll: () => {
      for (const h of held.splice(0)) h.release();
    },
  };
}

async function setup(internal: { filesCacheSize?: number } = {}) {
  const fake = new FakeGitCore();
  const repo = await fake.createRepo(await tempDir(), 'alpha');
  const wt = repo.worktrees[0]?.id ?? '';
  fake.setFiles(wt, 'working', [fakeFile('a.txt', { additions: 1 }), fakeFile('b.txt')]);
  const daemon = await startTestDaemon({
    fake,
    stateDir: await tempDir(),
    internal,
  });
  await client(daemon).addProject({ path: repo.mainPath });
  await client(daemon).listProjects();
  return { fake, daemon, repo, wt };
}

const filesUrl = (wt: string, query = 'scope=working') => `/api/worktrees/${wt}/files?${query}`;
const SHA = (n: number) => n.toString(16).padStart(40, '0');

interface FilesBody {
  files: Array<{ path: string; additions?: number }>;
}

async function listOf(daemon: Daemon, wt: string, query?: string): Promise<FilesBody> {
  const res = await http(daemon, filesUrl(wt, query));
  expect(res.status).toBe(200);
  return (await res.json()) as FilesBody;
}

const calls = (fake: FakeGitCore) => fake.callCount('listChangedFiles');

describe('file list cache: lookups (#49)', () => {
  it('concurrent identical lookups share one computation and fill the cache once', async () => {
    const { fake, daemon, wt } = await setup();
    const hold = holdLists(fake);
    hold.arm();
    const before = calls(fake);
    const pending = [1, 2, 3].map(() => http(daemon, filesUrl(wt)));
    await eventually(() => hold.held.length === 1);
    await sleep(60);
    expect(hold.held).toHaveLength(1);
    expect(calls(fake)).toBe(before + 1);
    hold.disarm();
    hold.releaseAll();
    for (const res of await Promise.all(pending)) expect(res.status).toBe(200);
    // Cached by the shared run: a fourth request starts nothing.
    await listOf(daemon, wt);
    expect(calls(fake)).toBe(before + 1);
  });

  it('an aborted waiter does not cancel the run while another waits; the last one leaving does', async () => {
    const { fake, daemon, wt } = await setup();
    const hold = holdLists(fake);
    hold.arm();
    const a = new AbortController();
    const b = new AbortController();
    const settle = (p: Promise<Response>) => p.then((r) => r.status).catch(() => 0);
    const first = settle(http(daemon, filesUrl(wt), { signal: a.signal }));
    await eventually(() => hold.held.length === 1);
    const signal = hold.held[0]?.signal;
    const second = settle(http(daemon, filesUrl(wt), { signal: b.signal }));
    await sleep(60);
    a.abort();
    expect(await first).toBe(0);
    await sleep(60);
    expect(signal?.aborted).toBe(false);
    b.abort();
    expect(await second).toBe(0);
    await eventually(() => signal?.aborted === true);
    // Nothing was cached from the cancelled run: the next request starts anew.
    hold.disarm();
    const before = calls(fake);
    await listOf(daemon, wt);
    expect(calls(fake)).toBe(before + 1);
  });

  it('a waiter that stays gets the shared answer after another one left', async () => {
    const { fake, daemon, wt } = await setup();
    const hold = holdLists(fake);
    hold.arm();
    const before = calls(fake);
    const leaving = new AbortController();
    const first = http(daemon, filesUrl(wt), { signal: leaving.signal }).catch(() => null);
    await eventually(() => hold.held.length === 1);
    const staying = http(daemon, filesUrl(wt));
    await sleep(60);
    leaving.abort();
    expect(await first).toBeNull();
    hold.disarm();
    hold.releaseAll();
    const res = await staying;
    expect(res.status).toBe(200);
    expect(((await res.json()) as FilesBody).files.map((f) => f.path)).toEqual(['a.txt', 'b.txt']);
    expect(hold.held).toHaveLength(0);
    // One run for both requests, and its answer was cached.
    await listOf(daemon, wt);
    expect(calls(fake)).toBe(before + 1);
  });

  it('an invalidation while a lookup is in flight never lets its result into the cache', async () => {
    const { fake, daemon, wt } = await setup();
    const hold = holdLists(fake);
    hold.arm();
    // The list of this moment (a.txt: 1 line added) is in flight ...
    const stale = http(daemon, filesUrl(wt));
    await eventually(() => hold.held.length === 1);
    // ... the file changes in a way the state hash does not see, and the user refreshes.
    fake.setFiles(wt, 'working', [fakeFile('a.txt', { additions: 5 }), fakeFile('b.txt')]);
    await client(daemon).refreshWorktree(wt);
    hold.disarm();
    hold.releaseAll();
    expect((await stale).status).toBe(200);
    const before = calls(fake);
    const body = await listOf(daemon, wt);
    // The old run's list was not filled into the cache after the refresh dropped the entries.
    expect(calls(fake)).toBe(before + 1);
    expect(body.files.find((f) => f.path === 'a.txt')?.additions).toBe(5);
  });

  it('a failed lookup is shared by its waiters but cached for nobody', async () => {
    const { fake, daemon, wt } = await setup();
    const before = calls(fake);
    fake.fail('listChangedFiles', 'git_failed');
    const res = await http(daemon, filesUrl(wt));
    expect(res.status).toBeGreaterThanOrEqual(400);
    fake.failures.delete('listChangedFiles');
    const body = await listOf(daemon, wt);
    expect(body.files).toHaveLength(2);
    expect(calls(fake)).toBe(before + 2);
  });
});

describe('file list cache: what is stored', () => {
  it('a list git-core made of another state than the one asked for is returned, not cached', async () => {
    const { fake, daemon, wt } = await setup();
    const git: GitCore = fake;
    // git-core says the list is of a state the summary did not describe (a refresh overtook it).
    git.listChangedFilesWithState = async (loc, scope, options) => ({
      files: await fake.listChangedFiles(loc, scope, options),
      summaryState: 'some-other-state',
    });
    const first = (await (await http(daemon, filesUrl(wt))).json()) as { stateHash: string };
    expect(first.stateHash).toMatch(/^listed-/);
    const before = calls(fake);
    await listOf(daemon, wt);
    // Asked again (an overtaken list is retried, so more than once), not served from the cache.
    expect(calls(fake)).toBeGreaterThan(before);
  });
});

describe('file list cache: keys (#27, #30)', () => {
  it('serves a repeat from the cache and misses on a new stateHash', async () => {
    const { fake, daemon, wt } = await setup();
    await listOf(daemon, wt);
    const before = calls(fake);
    await listOf(daemon, wt);
    expect(calls(fake)).toBe(before);
    fake.setFiles(wt, 'working', [fakeFile('c.txt')]);
    await client(daemon).refreshWorktree(wt);
    const body = await listOf(daemon, wt);
    expect(body.files.map((f) => f.path)).toEqual(['c.txt']);
    expect(calls(fake)).toBe(before + 1);
  });

  it('keeps one entry per scope and per worktree', async () => {
    const fake = new FakeGitCore();
    const repo = await fake.createRepo(await tempDir(), 'alpha', { linked: ['feature'] });
    const [main, linked] = repo.worktrees.map((w) => w.id);
    if (!main || !linked) throw new Error('fixture');
    fake.setFiles(main, 'working', [fakeFile('m.txt')]);
    fake.setFiles(linked, 'working', [fakeFile('l.txt')]);
    const daemon = await startTestDaemon({ fake, stateDir: await tempDir() });
    await client(daemon).addProject({ path: repo.mainPath });
    await client(daemon).listProjects();
    const queries = [
      'scope=working',
      'scope=staged',
      `scope=commit&sha=${SHA(1)}`,
      `scope=commit&sha=${SHA(2)}`,
    ];
    for (const id of [main, linked]) for (const q of queries) await listOf(daemon, id, q);
    const before = calls(fake);
    for (const id of [main, linked]) for (const q of queries) await listOf(daemon, id, q);
    expect(calls(fake)).toBe(before);
    // The two worktrees' working lists are different entries.
    expect((await listOf(daemon, main)).files.map((f) => f.path)).toEqual(['m.txt']);
    expect((await listOf(daemon, linked)).files.map((f) => f.path)).toEqual(['l.txt']);
  });

  it('misses when the default branch moved (the base commit is part of the key)', async () => {
    const { fake, daemon, wt } = await setup();
    let oid = SHA(1);
    const git: GitCore = fake;
    git.readBranchBase = async () => ({ name: 'main', ref: 'refs/heads/main', oid });
    const query = 'scope=branch';
    await listOf(daemon, wt, query);
    const before = calls(fake);
    await listOf(daemon, wt, query);
    expect(calls(fake)).toBe(before);
    oid = SHA(2);
    await listOf(daemon, wt, query);
    expect(calls(fake)).toBe(before + 1);
    // The remote-tracking ref counts too (#30).
    git.readBranchBase = async () => ({
      name: 'main',
      ref: 'refs/heads/main',
      oid,
      remote: { name: 'origin/main', ref: 'refs/remotes/origin/main', oid: SHA(3) },
    });
    await listOf(daemon, wt, query);
    expect(calls(fake)).toBe(before + 2);
  });

  it('is not cached for a branch scope without a readable base', async () => {
    const { fake, daemon, wt } = await setup();
    const before = calls(fake);
    await listOf(daemon, wt, 'scope=branch');
    await listOf(daemon, wt, 'scope=branch');
    expect(calls(fake)).toBe(before + 2);
  });

  it('misses when the attributes file changed (info/attributes is part of the key)', async () => {
    const { fake, daemon, repo, wt } = await setup();
    await listOf(daemon, wt);
    const before = calls(fake);
    await listOf(daemon, wt);
    expect(calls(fake)).toBe(before);
    await writeFile(join(repo.commonDir, 'info', 'attributes'), '*.bin -diff\n').catch(async () => {
      const { mkdir } = await import('node:fs/promises');
      await mkdir(join(repo.commonDir, 'info'), { recursive: true });
      await writeFile(join(repo.commonDir, 'info', 'attributes'), '*.bin -diff\n');
    });
    await listOf(daemon, wt);
    expect(calls(fake)).toBe(before + 1);
  });
});

describe('file list cache: invalidation points', () => {
  async function warm(daemon: Daemon, wt: string, fake: FakeGitCore) {
    await listOf(daemon, wt);
    const before = calls(fake);
    await listOf(daemon, wt);
    expect(calls(fake)).toBe(before);
    return before;
  }

  it('an explicit refresh drops the worktree entries (same state, same key)', async () => {
    const { fake, daemon, wt } = await setup();
    const before = await warm(daemon, wt, fake);
    await client(daemon).refreshWorktree(wt);
    await listOf(daemon, wt);
    expect(calls(fake)).toBe(before + 1);
  });

  /** A fake whose summary (so its stateHash) does not depend on the default branch. */
  function sameHash(fake: FakeGitCore) {
    const original = fake.getSummary.bind(fake);
    fake.getSummary = (loc, options) => original(loc, { ...options, defaultBranch: undefined });
  }

  it('changing the default branch override drops the project entries', async () => {
    const { fake, daemon, repo, wt } = await setup();
    sameHash(fake);
    await client(daemon).refreshWorktree(wt);
    const before = await warm(daemon, wt, fake);
    await client(daemon).updateProject(repo.projectId, { defaultBranchOverride: 'trunk' });
    await listOf(daemon, wt);
    expect(calls(fake)).toBe(before + 1);
  });

  it('a changed detected default branch drops the project entries', async () => {
    const { fake, daemon, repo, wt } = await setup();
    sameHash(fake);
    await client(daemon).refreshWorktree(wt);
    const before = await warm(daemon, wt, fake);
    repo.detectedDefaultBranch = 'trunk';
    await client(daemon).addProject({ path: repo.mainPath });
    await listOf(daemon, wt);
    expect(calls(fake)).toBe(before + 1);
  });

  it('a worktree that disappeared from the project drops its entries', async () => {
    const fake = new FakeGitCore();
    const repo = await fake.createRepo(await tempDir(), 'alpha', { linked: ['feature'] });
    const [main, linked] = repo.worktrees.map((w) => w.id);
    if (!main || !linked) throw new Error('fixture');
    const daemon = await startTestDaemon({ fake, stateDir: await tempDir() });
    await client(daemon).addProject({ path: repo.mainPath });
    await client(daemon).listProjects();
    await listOf(daemon, main);
    await listOf(daemon, linked);
    expect(daemon.core.cacheStats().files.entries).toBe(2);
    fake.removeWorktree(repo, linked);
    // An explicit refresh relists the project.
    await client(daemon).refreshWorktree(main);
    await eventually(() => daemon.core.cacheStats().files.entries === 0);
  });
});

describe('file list cache: bounds', () => {
  it('holds at most filesCacheSize lists and drops the least recently used first', async () => {
    const { fake, daemon, wt } = await setup({ filesCacheSize: 3 });
    const q = (n: number) => `scope=commit&sha=${SHA(n)}`;
    for (const n of [1, 2, 3]) await listOf(daemon, wt, q(n));
    // Touch 1: 2 is now the least recently used.
    await listOf(daemon, wt, q(1));
    await listOf(daemon, wt, q(4));
    const before = calls(fake);
    await listOf(daemon, wt, q(1));
    await listOf(daemon, wt, q(3));
    await listOf(daemon, wt, q(4));
    expect(calls(fake)).toBe(before);
    await listOf(daemon, wt, q(2));
    expect(calls(fake)).toBe(before + 1);
  });

  it('keeps one entry per (worktree, scope): a new state replaces the old one', async () => {
    // A directory-backed fake: a file written to the worktree is a new state, found by the watcher.
    const fake = new FakeGitCore();
    const repo = await fake.createRepo(await tempDir(), 'alpha', { fsBacked: true });
    const wt = repo.worktrees[0]?.id ?? '';
    const daemon = await startTestDaemon({
      fake,
      stateDir: await tempDir(),
      internal: { filesCacheSize: 3 },
    });
    await client(daemon).addProject({ path: repo.mainPath });
    await client(daemon).listProjects();
    await eventually(async () => (await client(daemon).health()).watcher.mode === 'native', 10_000);
    const entries = () => daemon.core.cacheStats().files.entries;
    await listOf(daemon, wt, 'scope=working');
    await listOf(daemon, wt, `scope=commit&sha=${SHA(1)}`);
    expect(entries()).toBe(2);
    for (let i = 0; i < 4; i++) {
      await writeFile(join(repo.mainPath, `g${i}.txt`), `${i}\n`);
      await eventually(
        async () =>
          (await listOf(daemon, wt, 'scope=working')).files.some((f) => f.path === `g${i}.txt`),
        8000,
      );
      expect(entries()).toBe(2);
    }
    // The commit entry survived all of it (a new state of another scope does not touch it).
    const before = calls(fake);
    await listOf(daemon, wt, `scope=commit&sha=${SHA(1)}`);
    expect(calls(fake)).toBe(before);
  });
});

describe('cache counters (#49)', () => {
  it('count hits, misses and in-flight joins', async () => {
    const { fake, daemon, wt } = await setup();
    const base = daemon.core.cacheStats().files;
    const hold = holdLists(fake);
    hold.arm();
    const pending = [http(daemon, filesUrl(wt)), http(daemon, filesUrl(wt))];
    await eventually(() => hold.held.length === 1);
    await sleep(60);
    hold.disarm();
    hold.releaseAll();
    await Promise.all(pending);
    await listOf(daemon, wt);
    const now = daemon.core.cacheStats().files;
    expect(now.misses - base.misses).toBe(1);
    expect(now.joins - base.joins).toBe(1);
    expect(now.hits - base.hits).toBe(1);
  });
});
