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
import { listsRetried, listsUnlabelled } from '../src/core.js';
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
      // One gate for both list calls (the daemon uses the one that reports its state).
      const name = prop === 'listChangedFilesWithState' ? 'listChangedFiles' : prop;
      return async (...args: unknown[]) => {
        const gate = armed.get(name);
        if (gate) {
          armed.delete(name);
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

async function start_(fx: RealGitFixture, dir: string) {
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
      const { api, gated } = await start_(fx, dir);
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
      const { api, gated } = await start_(fx, dir);
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

  /** Moves a prepared directory of `n` files in as `name` (one event), or `name` out. */
  async function move(fx: RealGitFixture, dir: string, name: string, n: number | 'out') {
    if (n === 'out') {
      await rename(path.join(dir, name), path.join(fx.root, `${name}-away`));
      return;
    }
    const ready = path.join(fx.root, `${name}-ready`);
    await mkdir(ready);
    for (let i = 0; i < n; i++) await writeFile(path.join(ready, `x${i}.js`), `${i}\n`);
    await rename(ready, path.join(dir, name));
  }

  // Greptile on PR #95: the second attempt can be overtaken too, by a move that crosses the cap
  // again; git-core then lists the worktree as it is now, which no summary held so far describes.
  for (const start of ['under', 'above'] as const) {
    it(`a second move across the cap during the retry (starting ${start} it)`, async () => {
      const fx = await makeRealGitFixture();
      // under: 1 + 3 untracked; above: 1 + 12.
      const dir = await repoWith(fx, start === 'under' ? 3 : 12);
      const id = hashId(dir);
      const { api, gated } = await start_(fx, dir);
      const first = await eventually(() => summaryOf(api, id), 15_000);
      const capped = (s: WorktreeSummary) => s.untrackedOmitted !== undefined;
      const gate1 = gated.arm('listChangedFiles');
      const request = api.listFiles(id, { scope: { kind: 'working' } });
      await gate1.entered;
      // First move across the cap...
      if (start === 'under') await move(fx, dir, 'more', 9);
      else await move(fx, dir, 'gen', 'out');
      const s2 = await movedTo(api, id, first.stateHash, (s) => capped(s) === (start === 'under'));
      const gate2 = gated.arm('listChangedFiles');
      gate1.release();
      await gate2.entered;
      // ...and back across it while the retry's list waits.
      if (start === 'under') await move(fx, dir, 'more', 'out');
      else await move(fx, dir, 'more', 9);
      const s3 = await movedTo(api, id, s2.stateHash, (s) => capped(s) === (start === 'above'));
      const unlabelled = listsUnlabelled.count;
      gate2.release();
      const res = await request;
      // The third attempt listed the current state: labelled with its summary.
      expect(listsUnlabelled.count).toBe(unlabelled);
      // One state, the current one, and what a fresh listing says.
      expectOneState(res, s3);
      const fresh = await api.listFiles(id, { scope: { kind: 'working' } });
      expect(res.files).toEqual(fresh.files);
      expect(res.untrackedOmitted).toEqual(fresh.untrackedOmitted);
      expect(res.stateHash).toBe(fresh.stateHash);
    });
  }

  /**
   * Runs `request` while every list attempt is overtaken by a move across the cap (into, out of,
   * into again), and returns its result with the last summary.
   */
  async function overtaken<T>(
    fx: RealGitFixture,
    dir: string,
    api: ApiClient,
    gated: ReturnType<typeof gatedCore>,
    id: string,
    request: () => Promise<T>,
  ): Promise<{ result: T; first: WorktreeSummary; last: WorktreeSummary }> {
    const first = await eventually(() => summaryOf(api, id), 15_000);
    const capped = (s: WorktreeSummary) => s.untrackedOmitted !== undefined;
    let gate = gated.arm('listChangedFiles');
    const running = request();
    let before = first.stateHash;
    const moves: Array<[string, number | 'out', boolean]> = [
      ['more', 9, true],
      ['more', 'out', false],
      ['other', 9, true],
    ];
    let last = first;
    for (const [i, [name, n, wantCapped]] of moves.entries()) {
      await gate.entered;
      await move(fx, dir, name, n);
      last = await movedTo(api, id, before, (s) => capped(s) === wantCapped);
      before = last.stateHash;
      const held = gate;
      if (i < moves.length - 1) gate = gated.arm('listChangedFiles');
      held.release();
    }
    return { result: await running, first, last };
  }

  it('when every attempt is overtaken, the list is labelled with what git-core listed', async () => {
    const fx = await makeRealGitFixture();
    const dir = await repoWith(fx, 3);
    const id = hashId(dir);
    const { api, gated } = await start_(fx, dir);
    const unlabelled = listsUnlabelled.count;
    const {
      result: res,
      first,
      last,
    } = await overtaken(fx, dir, api, gated, id, () =>
      api.listFiles(id, { scope: { kind: 'working' } }),
    );
    expect(listsUnlabelled.count).toBe(unlabelled + 1);
    // No summary the daemon held matches what was listed: not labelled as one of them, and the
    // notice is the one the list itself applied.
    expect(res.stateHash).not.toBe(last.stateHash);
    expect(res.stateHash).not.toBe(first.stateHash);
    const untracked = res.files.filter((f) => f.status === 'untracked').length;
    expect(untracked + (res.untrackedOmitted?.count ?? 0)).toBe(last.counts.untracked);
    expect(res.untrackedOmitted?.count).toBe(last.untrackedOmitted?.count);
    // A client that sees a stateHash it does not hold fetches again: the current state.
    expectOneState(await api.listFiles(id, { scope: { kind: 'working' } }), last);
  });

  it('an inbox row overtaken on every attempt is left out, never paired with another summary', async () => {
    const fx = await makeRealGitFixture();
    const dir = await repoWith(fx, 3);
    const id = hashId(dir);
    const { api, gated } = await start_(fx, dir);
    const { result, last } = await overtaken(fx, dir, api, gated, id, () =>
      api.inbox({ scope: { kind: 'working' } }),
    );
    const row = result.entries.find((e) => e.worktree.id === id);
    if (row) expect(row.summary.stateHash).toBe(last.stateHash);
    expect(row).toBeUndefined();
  });

  it('bulk review overtaken on every attempt marks nothing and reports the worktree stale', async () => {
    const fx = await makeRealGitFixture();
    const dir = await repoWith(fx, 3);
    const id = hashId(dir);
    const { api, gated } = await start_(fx, dir);
    const { result } = await overtaken(fx, dir, api, gated, id, () =>
      api.bulkReview({ target: { kind: 'worktree', worktreeId: id }, scope: { kind: 'working' } }),
    );
    expect(result).toMatchObject({ changed: 0, stale: [id] });
  });

  it('inbox rows pair their files with the summary they were listed for', async () => {
    const fx = await makeRealGitFixture();
    const dir = await repoWith(fx, 3);
    const id = hashId(dir);
    const { api, gated } = await start_(fx, dir);
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
    const { api, gated } = await start_(fx, dir);
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
    const { api, gated } = await start_(fx, dir);
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
