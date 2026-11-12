/**
 * #43: above `maxListedUntracked` the daemon passes git-core's omission on: the summary (rows,
 * events, inbox) and `GET /files` say how many untracked files no list holds and where; bulk review
 * cannot mark them and says so; the review state counts listed files only; the activity feed
 * neither reports omitted files nor mistakes a change of the omitted set for deletions.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type ActivityEntry,
  type ApiClient,
  FilesResponseSchema,
  UNTRACKED_LISTED_DEFAULT,
} from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { startDaemon } from '../src/daemon.js';
import { hashId } from '../src/ids.js';
import { client, eventually, onCleanup, sleep, TEST_TOKEN, tempDir } from './helpers.js';
import { makeRealGitFixture, makeRealRepo, type RealGitFixture } from './real-git-fixture.js';

const CAP = 20;
const WORKING = { scope: { kind: 'working' as const } };

async function start(fx: RealGitFixture, projects: string[]) {
  const daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    stateDir: await tempDir(),
    logLevel: process.env.OCTOPUS_DIFF_TEST_LOGS ? 'debug' : 'silent',
    git: { env: fx.env, maxListedUntracked: CAP },
    projects,
    watch: { debounceMs: 100 },
    internal: { forges: false },
  });
  onCleanup(() => daemon.close());
  return { daemon, api: client(daemon) };
}

/** `bulk`: the directory of 60 untracked files (the watcher never watches `node_modules`). */
async function heavyRepo(fx: RealGitFixture, bulk = 'node_modules'): Promise<string> {
  const dir = await makeRealRepo(fx, 'heavy', { 'a.txt': 'a\n', 'keep.txt': 'k\n' });
  await writeFile(path.join(dir, 'a.txt'), 'a\nchanged\n');
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src', 'new.ts'), 'one\n');
  for (let d = 0; d < 6; d++) {
    await mkdir(path.join(dir, bulk, `pkg${d}`), { recursive: true });
    for (let f = 0; f < 10; f++) {
      await writeFile(path.join(dir, bulk, `pkg${d}`, `f${f}.js`), `${d}/${f}\n`);
    }
  }
  return dir;
}

async function summaryOf(api: ApiClient, id: string) {
  return (await api.listProjects()).projects
    .flatMap((p) => p.worktrees)
    .find((w) => w.worktree.id === id)?.summary;
}

describe('untracked-heavy worktrees through the daemon (#43)', { timeout: 60_000 }, () => {
  it('default cap is the contract constant', () => {
    expect(UNTRACKED_LISTED_DEFAULT).toBe(2000);
  });

  it('rows, files, inbox and bulk review say what is omitted; review counts listed files', async () => {
    const fx = await makeRealGitFixture();
    const dir = await heavyRepo(fx);
    const id = hashId(dir);
    const { api } = await start(fx, [dir]);
    const summary = await eventually(() => summaryOf(api, id), 10_000);
    expect(summary.counts.untracked).toBe(61);
    expect(summary.changedFiles).toBe(62);
    const omission = {
      count: 60,
      limit: CAP,
      directories: [{ path: 'node_modules', count: 60, ignoreLine: 'node_modules/' }],
    };
    expect(summary.untrackedOmitted).toEqual(omission);

    // The files response: the listed files and the placeholder, for scopes that list untracked.
    const files = FilesResponseSchema.parse(await api.listFiles(id, WORKING));
    expect(files.files.map((f) => f.path)).toEqual(['a.txt', 'src/new.ts']);
    expect(files.untrackedOmitted).toEqual(omission);
    expect((await api.listFiles(id, { scope: { kind: 'review' } })).untrackedOmitted).toEqual(
      omission,
    );
    expect(
      (await api.listFiles(id, { scope: { kind: 'staged' } })).untrackedOmitted,
    ).toBeUndefined();
    expect(
      (await api.listFiles(id, { scope: { kind: 'unstaged' } })).untrackedOmitted,
    ).toBeUndefined();

    // The inbox holds the same rows; the entry's summary carries the omission.
    const inbox = await api.inbox(WORKING);
    const entry = inbox.entries.find((e) => e.worktree.id === id);
    expect(entry?.files.map((f) => f.path)).toEqual(['a.txt', 'src/new.ts']);
    expect(entry?.summary.untrackedOmitted).toEqual(omission);

    // A path selection naming an omitted file marks nothing (it has no row) and is not counted.
    const named = await api.bulkReview({
      target: { kind: 'worktree', worktreeId: id },
      scope: { kind: 'working' },
      paths: [{ path: 'node_modules/pkg0/f0.js' }],
    });
    expect(named).toMatchObject({ changed: 0, unchanged: 0 });
    expect(named.untrackedOmitted).toBeUndefined();
    // Mark all: the two listed files; the 60 omitted ones are reported, not marked.
    const all = await api.bulkReview({
      target: { kind: 'worktree', worktreeId: id },
      scope: { kind: 'working' },
    });
    expect(all).toMatchObject({ changed: 2, worktrees: 1, untrackedOmitted: 60 });
    // Staged scope lists no untracked files: nothing to report.
    const staged = await api.bulkReview({
      target: { kind: 'worktree', worktreeId: id },
      scope: { kind: 'staged' },
    });
    expect(staged.untrackedOmitted).toBeUndefined();

    // The review state: every listed file is reviewed now; omitted files are not counted.
    await api.listFiles(id, { scope: { kind: 'review' } });
    const review = await eventually(async () => {
      const r = (await summaryOf(api, id))?.review;
      return r && r.unreviewedFiles === 0 ? r : undefined;
    }, 10_000);
    expect(review.unreviewedFiles).toBe(0);
    expect((await summaryOf(api, id))?.untrackedOmitted?.count).toBe(60);
  });

  it('activity: omitted files make no entries; a change of the omitted set is one coarse entry', async () => {
    const fx = await makeRealGitFixture();
    const dir = await makeRealRepo(fx, 'feed', { 'a.txt': 'a\n' });
    await mkdir(path.join(dir, 'src'));
    await writeFile(path.join(dir, 'src', 'new.ts'), 'one\n');
    await mkdir(path.join(dir, 'gen'));
    const gen = async (from: number, to: number) => {
      for (let i = from; i < to; i++) await writeFile(path.join(dir, 'gen', `g${i}.js`), `${i}\n`);
    };
    // src/new.ts and 19 files in gen/: exactly the cap, all listed (and in the snapshot).
    await gen(0, 19);
    const id = hashId(dir);
    const { api } = await start(fx, [dir]);
    await eventually(async () => {
      const feed = await api.getActivity(id);
      return feed.live && feed.watch.mode === 'native';
    }, 20_000);
    const feed = async (after: number): Promise<ActivityEntry[]> =>
      (await api.getActivity(id, { after })).entries;
    expect(await feed(0)).toEqual([]);
    expect((await summaryOf(api, id))?.untrackedOmitted).toBeUndefined();

    // One more file in gen/ passes the cap: its 19 listed files become omitted (one write, so no
    // state in between). They are not deleted: no "deleted" entry, at most one coarse entry for
    // the change of the omitted set.
    let seq = (await api.getActivity(id)).seq;
    await gen(19, 20);
    await eventually(
      async () => (await summaryOf(api, id))?.untrackedOmitted?.count === 20,
      10_000,
    );
    await sleep(400);
    let entries = await feed(seq);
    expect(entries.filter((e) => e.kind !== 'bulk')).toEqual([]);

    // Another omitted file, same omitted set: the state moves, the feed says nothing.
    seq = (await api.getActivity(id)).seq;
    const before = (await summaryOf(api, id))?.stateHash;
    await gen(20, 21);
    await eventually(async () => (await summaryOf(api, id))?.stateHash !== before, 10_000);
    await sleep(400);
    expect(await feed(seq)).toEqual([]);
    // A listed file's edit is still reported per file (the snapshot is not coarse).
    await writeFile(path.join(dir, 'src', 'new.ts'), 'one\ntwo\n');
    const edit = await eventually(
      async () => (await feed(seq)).find((e) => e.kind === 'modified' && e.path === 'src/new.ts'),
      10_000,
    );
    expect(edit).toBeDefined();

    // gen/ goes away in one rename: under the cap again; its files were not listed, so nothing per
    // file.
    seq = (await api.getActivity(id)).seq;
    await rename(path.join(dir, 'gen'), path.join(fx.root, 'gen-moved'));
    await eventually(async () => (await summaryOf(api, id))?.counts.untracked === 1, 10_000);
    await sleep(400);
    entries = await feed(seq);
    expect(entries.filter((e) => e.kind !== 'bulk')).toEqual([]);
    expect((await summaryOf(api, id))?.untrackedOmitted).toBeUndefined();
  });
});
