/**
 * Greptile on PR #91 (follow-up): a `GET /files` response pairs a list with summary fields
 * (`stateHash`, `untrackedOmitted`). A refresh that finishes while the request waits (the review
 * scope's resolution, or the list itself) must not leave them describing two states, in particular
 * when the worktree crosses the untracked cap. A gate holds one git-core call until the test has
 * moved the worktree to another summary.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApiClient, FilesResponse, GitCore, WorktreeSummary } from '@octopus-diff/contracts';
import { createGitCore } from '@octopus-diff/git-core';
import { describe, expect, it } from 'vitest';
import { listsRetried } from '../src/core.js';
import { startDaemon } from '../src/daemon.js';
import { hashId } from '../src/ids.js';
import { client, eventually, onCleanup, TEST_TOKEN, tempDir } from './helpers.js';
import { makeRealGitFixture, makeRealRepo, type RealGitFixture } from './real-git-fixture.js';

const CAP = 5;

/** A git-core whose next call of an armed method waits until released. */
function gatedCore(core: GitCore) {
  const armed = new Map<string, { entered: () => void; release: Promise<void> }>();
  const proxy = new Proxy(core, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return async (...args: unknown[]) => {
        const gate = armed.get(prop);
        if (gate) {
          armed.delete(prop);
          gate.entered();
          await gate.release;
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return {
    core: proxy as GitCore,
    /** Arms `method`; resolves `entered` when a call waits, which goes on after `release()`. */
    arm(method: keyof GitCore) {
      let entered!: () => void;
      let release!: () => void;
      const enteredP = new Promise<void>((resolve) => {
        entered = resolve;
      });
      armed.set(method, {
        entered,
        release: new Promise<void>((resolve) => {
          release = resolve;
        }),
      });
      return { entered: enteredP, release: () => release() };
    },
  };
}

async function start(fx: RealGitFixture, dir: string) {
  const real = createGitCore({ env: fx.env, maxListedUntracked: CAP });
  const gated = gatedCore(real);
  const daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    stateDir: await tempDir(),
    logLevel: 'silent',
    gitCore: gated.core,
    projects: [dir],
    watch: { debounceMs: 50 },
    internal: { forges: false },
  });
  onCleanup(async () => {
    await daemon.close();
    await real.dispose();
  });
  const api = client(daemon);
  // File events reach the worktree (the subscription can come up after the first summary).
  await eventually(async () => {
    const feed = await api.getActivity(hashId(dir));
    return feed.live && feed.watch.mode === 'native';
  }, 20_000);
  return { api, gated };
}

async function summaryOf(api: ApiClient, id: string): Promise<WorktreeSummary | undefined> {
  return (
    (await api.listProjects()).projects
      .flatMap((p) => p.worktrees)
      .find((w) => w.worktree.id === id)?.summary ?? undefined
  );
}

/** The response describes one state: its own list, notice and stateHash agree with that summary. */
function expectOneState(res: FilesResponse, summary: WorktreeSummary): void {
  expect(res.stateHash).toBe(summary.stateHash);
  expect(res.untrackedOmitted).toEqual(summary.untrackedOmitted);
  const untracked = res.files.filter((f) => f.status === 'untracked').length;
  expect(untracked + (res.untrackedOmitted?.count ?? 0)).toBe(summary.counts.untracked);
}

async function repoWith(fx: RealGitFixture, gen: number): Promise<string> {
  const dir = await makeRealRepo(fx, 'snap', { 'a.txt': 'a\n' });
  await writeFile(path.join(dir, 'a.txt'), 'a\nchanged\n');
  await writeFile(path.join(dir, 'mine.txt'), 'mine\n');
  await mkdir(path.join(dir, 'gen'));
  for (let i = 0; i < gen; i++) await writeFile(path.join(dir, 'gen', `g${i}.js`), `${i}\n`);
  return dir;
}

/**
 * One rename, so one event: a prepared directory of 9 files moves in (1 + 3 + 9 untracked files,
 * above the cap), or `gen/` (12 files) moves out (1 left, under it).
 */
async function cross(fx: RealGitFixture, dir: string, crossing: 'into' | 'out of'): Promise<void> {
  if (crossing === 'out of') {
    await rename(path.join(dir, 'gen'), path.join(fx.root, 'gen-away'));
    return;
  }
  const ready = path.join(fx.root, 'more-ready');
  await mkdir(ready);
  for (let i = 0; i < 9; i++) await writeFile(path.join(ready, `m${i}.js`), `${i}\n`);
  await rename(ready, path.join(dir, 'more'));
}

/** Waits until the summary moved past `before` and satisfies `done`. */
async function movedTo(
  api: ApiClient,
  id: string,
  before: string | undefined,
  done: (s: WorktreeSummary) => boolean,
): Promise<WorktreeSummary> {
  return eventually(async () => {
    const s = await summaryOf(api, id);
    return s && s.stateHash !== before && done(s) ? s : undefined;
  }, 15_000);
}

describe('GET /files describes one summary state (#43 follow-up)', { timeout: 60_000 }, () => {
  for (const crossing of ['into', 'out of'] as const) {
    it(`a refresh during the review scope's resolution (worktree crossing ${crossing} the cap)`, async () => {
      const fx = await makeRealGitFixture();
      // 1 + 3 untracked files: under the cap; 1 + 12: above it.
      const dir = await repoWith(fx, crossing === 'into' ? 3 : 12);
      const id = hashId(dir);
      const { api, gated } = await start(fx, dir);
      const first = await eventually(() => summaryOf(api, id), 15_000);
      expect(first.untrackedOmitted !== undefined).toBe(crossing === 'out of');
      // The review state is computed on demand: the request resolves it, and waits there.
      const gate = gated.arm('readReviewRange');
      const request = api.listFiles(id, { scope: { kind: 'review' } });
      await gate.entered;
      await cross(fx, dir, crossing);
      const moved = await movedTo(api, id, first.stateHash, (s) =>
        crossing === 'into' ? s.untrackedOmitted !== undefined : s.untrackedOmitted === undefined,
      );
      const retried = listsRetried.count;
      gate.release();
      const res = await request;
      expectOneState(res, moved);
      // The first list was of another state than the request started with: built once more.
      expect(listsRetried.count).toBe(retried + 1);
    });

    it(`a refresh while the list is built is retried (crossing ${crossing} the cap)`, async () => {
      const fx = await makeRealGitFixture();
      const dir = await repoWith(fx, crossing === 'into' ? 3 : 12);
      const id = hashId(dir);
      const { api, gated } = await start(fx, dir);
      const first = await eventually(() => summaryOf(api, id), 15_000);
      const gate = gated.arm('listChangedFiles');
      const request = api.listFiles(id, { scope: { kind: 'working' } });
      await gate.entered;
      await cross(fx, dir, crossing);
      const moved = await movedTo(api, id, first.stateHash, (s) =>
        crossing === 'into' ? s.untrackedOmitted !== undefined : s.untrackedOmitted === undefined,
      );
      const retried = listsRetried.count;
      gate.release();
      const res = await request;
      expectOneState(res, moved);
      // The first list was of another state than the request started with: built once more.
      expect(listsRetried.count).toBe(retried + 1);
    });
  }

  it('a state that moves again during the retry is labelled with the summary the list was built for', async () => {
    const fx = await makeRealGitFixture();
    const dir = await repoWith(fx, 3);
    const id = hashId(dir);
    const { api, gated } = await start(fx, dir);
    const first = await eventually(() => summaryOf(api, id), 15_000);
    const gate1 = gated.arm('listChangedFiles');
    const request = api.listFiles(id, { scope: { kind: 'working' } });
    await gate1.entered;
    await cross(fx, dir, 'into');
    const s2 = await movedTo(api, id, first.stateHash, (s) => s.untrackedOmitted !== undefined);
    // The retry's list waits too, while the worktree moves on once more.
    const gate2 = gated.arm('listChangedFiles');
    gate1.release();
    await gate2.entered;
    await writeFile(path.join(dir, 'more', 'm9.js'), '9\n');
    const s3 = await movedTo(api, id, s2.stateHash, (s) => s.untrackedOmitted?.count === 10);
    gate2.release();
    const res = await request;
    // Not two states mixed in the labels: stateHash and notice are both s2's, the list's own.
    expect(res.stateHash).toBe(s2.stateHash);
    expect(res.untrackedOmitted).toEqual(s2.untrackedOmitted);
    expect(res.stateHash).not.toBe(s3.stateHash);
    // The client sees a stateHash that is not current and fetches again: one state again.
    expectOneState(await api.listFiles(id, { scope: { kind: 'working' } }), s3);
  });

  it('inbox rows pair their files with the summary they were listed for', async () => {
    const fx = await makeRealGitFixture();
    const dir = await repoWith(fx, 3);
    const id = hashId(dir);
    const { api, gated } = await start(fx, dir);
    const first = await eventually(() => summaryOf(api, id), 15_000);
    const gate = gated.arm('listChangedFiles');
    const request = api.inbox({ scope: { kind: 'working' } });
    await gate.entered;
    await cross(fx, dir, 'into');
    const moved = await movedTo(api, id, first.stateHash, (s) => s.untrackedOmitted !== undefined);
    gate.release();
    const row = (await request).entries.find((e) => e.worktree.id === id);
    if (!row) throw new Error('no inbox row');
    expect(row.summary.stateHash).toBe(moved.stateHash);
    const untracked = row.files.filter((f) => f.status === 'untracked').length;
    expect(untracked + (row.summary.untrackedOmitted?.count ?? 0)).toBe(
      row.summary.counts.untracked,
    );
  });

  it('bulk review reports the omission of the state it marked', async () => {
    const fx = await makeRealGitFixture();
    const dir = await repoWith(fx, 3);
    const id = hashId(dir);
    const { api, gated } = await start(fx, dir);
    const first = await eventually(() => summaryOf(api, id), 15_000);
    const gate = gated.arm('listChangedFiles');
    const request = api.bulkReview({
      target: { kind: 'worktree', worktreeId: id },
      scope: { kind: 'working' },
    });
    await gate.entered;
    await cross(fx, dir, 'into');
    const moved = await movedTo(api, id, first.stateHash, (s) => s.untrackedOmitted !== undefined);
    gate.release();
    const res = await request;
    // What was marked is the moved state's list, and that state's omission is reported with it:
    // every changed file is either marked (or already was) or reported as not listed.
    expect(res.untrackedOmitted).toBe(moved.untrackedOmitted?.count);
    expect(res.changed + res.unchanged + (res.untrackedOmitted ?? 0)).toBe(moved.changedFiles);
  });

  it('Review all moves the bookmark to the HEAD of the state it marked', async () => {
    const fx = await makeRealGitFixture();
    const dir = await repoWith(fx, 3);
    const id = hashId(dir);
    const { api, gated } = await start(fx, dir);
    const first = await eventually(() => summaryOf(api, id), 15_000);
    // The first list of the call (its review state's) waits while a commit lands.
    const gate = gated.arm('listChangedFiles');
    const request = api.bulkReview({
      target: { kind: 'worktree', worktreeId: id },
      scope: { kind: 'review' },
      advanceBookmarks: true,
    });
    await gate.entered;
    fx.git(dir, 'add', 'a.txt');
    fx.git(dir, 'commit', '-q', '-m', 'during the review');
    const moved = await movedTo(api, id, first.stateHash, (s) => s.headSha !== first.headSha);
    gate.release();
    const res = await request;
    expect(res.bookmarks).toBe(1);
    const after = await eventually(async () => {
      const s = await summaryOf(api, id);
      return s?.review?.bookmark ? s : undefined;
    }, 15_000);
    expect(after.review?.bookmark).toBe(moved.headSha);
  });
});
