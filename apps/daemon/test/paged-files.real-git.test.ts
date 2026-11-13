/**
 * #42: paged `GET /files` and paged inbox rows through a real daemon and real git.
 *
 * - Pages of random sizes, with the worktree edited between pages, add up to exactly one state's
 *   list (a cursor of an older state restarts), and paging never lists the worktree more than once
 *   per state.
 * - An old client (no `limit`) gets the first `FILES_UNPAGED_MAX` files with `truncated`; no page
 *   passes about 1 MB whatever the paths' length.
 * - `after` + `unreviewed` (the web's `n`), `q` (the palette's file search), `origin`.
 * - Inbox rows carry a bounded first page, the list's counts and a cursor `GET /files` pages on with.
 * - Bulk review of a worktree marks its whole list, not a page.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type ApiClient,
  FILES_PAGE_MAX,
  FILES_UNPAGED_MAX,
  type FilesParams,
  type FilesResponse,
  fileListEntryKey,
  type GitCore,
  orderFiles,
  type WorktreeSummary,
} from '@octopus-diff/contracts';
import { createGitCore } from '@octopus-diff/git-core';
import { describe, expect, it } from 'vitest';
import { startDaemon } from '../src/daemon.js';
import { hashId } from '../src/ids.js';
import { client, eventually, http, onCleanup, TEST_TOKEN, tempDir } from './helpers.js';
import { makeRealGitFixture, makeRealRepo, type RealGitFixture } from './real-git-fixture.js';

const WORKING = { kind: 'working' as const };

/** mulberry32 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A real git-core that counts the lists it is asked for, per worktree path and scope. */
function countingCore(real: GitCore) {
  const lists: string[] = [];
  const core = new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop === 'listChangedFiles' || prop === 'listChangedFilesWithState') {
        return (...args: unknown[]) => {
          const [locator, scope] = args as [{ path: string }, { kind: string }];
          lists.push(`${locator.path}|${scope.kind}`);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { core, lists };
}

async function start(fx: RealGitFixture, dir: string) {
  const real = createGitCore({ env: fx.env });
  const counting = countingCore(real);
  const daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    stateDir: await tempDir(),
    logLevel: process.env.OCTOPUS_DIFF_TEST_LOGS ? 'debug' : 'silent',
    gitCore: counting.core,
    projects: [dir],
    watch: { debounceMs: 50 },
    internal: { forges: false },
  });
  onCleanup(async () => {
    await daemon.close();
    await real.dispose();
  });
  const api = client(daemon);
  const id = hashId(dir);
  await eventually(() => summaryOf(api, id), 20_000);
  return { daemon, api, id, lists: counting.lists };
}

/** Events reach the worktree (the subscription can come up after the first summary). */
async function watching(api: ApiClient, id: string) {
  await eventually(async () => {
    const feed = await api.getActivity(id);
    return feed.live && feed.watch.mode === 'native';
  }, 20_000);
}

async function projectIdOf(api: ApiClient, id: string): Promise<string> {
  const { projects } = await api.listProjects();
  const p = projects.find((x) => x.worktrees.some((w) => w.worktree.id === id));
  return p?.project.id as string;
}

async function summaryOf(api: ApiClient, id: string): Promise<WorktreeSummary | undefined> {
  return (
    (await api.listProjects()).projects
      .flatMap((p) => p.worktrees)
      .find((w) => w.worktree.id === id)?.summary ?? undefined
  );
}

/** `tracked` committed files, `modified` of them rewritten, `untracked` new ones. */
async function repoWith(
  fx: RealGitFixture,
  name: string,
  counts: { tracked: number; modified: number; untracked: number },
): Promise<string> {
  const files: Record<string, string> = {};
  const dirs = ['a', 'b/c', 'B', 'z'];
  const rel = (i: number) => `${dirs[i % dirs.length]}/f${String(i).padStart(4, '0')}.txt`;
  for (let i = 0; i < counts.tracked; i++) files[rel(i)] = `line ${i}\n`;
  const made = await makeRealRepoDeep(fx, name, files);
  for (let i = 0; i < counts.modified; i++) {
    await writeFile(path.join(made, rel(i)), `line ${i}\nchanged\n`);
  }
  await mkdir(path.join(made, 'new'), { recursive: true });
  for (let i = 0; i < counts.untracked; i++) {
    await writeFile(path.join(made, 'new', `u${i}.txt`), `u${i}\n`);
  }
  return made;
}

/** `makeRealRepo` for nested paths. */
async function makeRealRepoDeep(
  fx: RealGitFixture,
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const dir = await makeRealRepo(fx, name, { '.keep': '\n' });
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), content);
  }
  fx.git(dir, 'add', '-A');
  fx.git(dir, 'commit', '-q', '-m', 'files');
  return dir;
}

const keys = (files: readonly { path: string; rawPath?: string | undefined }[]) =>
  files.map(fileListEntryKey);

async function all(api: ApiClient, id: string, params: FilesParams = {}): Promise<FilesResponse> {
  return api.listFiles(id, { scope: WORKING, limit: FILES_PAGE_MAX, ...params });
}

describe('paged file lists through the daemon (#42)', { timeout: 120_000 }, () => {
  it('pages of random sizes are one state exactly, across edits that restart the paging', async () => {
    const fx = await makeRealGitFixture();
    const dir = await repoWith(fx, 'fuzz', { tracked: 160, modified: 120, untracked: 40 });
    const { api, id } = await start(fx, dir);
    await watching(api, id);
    let restarts = 0;
    let completed = 0;
    for (let seed = 1; seed <= 3; seed++) {
      const random = rng(seed);
      let got: string[] = [];
      let state: string | null = null;
      let cursor: string | undefined;
      let edits = 0;
      for (let step = 0; step < 200; step++) {
        // An edit between two pages (at most 4 per round): the state moves on.
        if (cursor && edits < 4 && random() < 0.2) {
          const before = (await summaryOf(api, id))?.stateHash;
          const kind = Math.floor(random() * 3);
          const n = Math.floor(random() * 150);
          if (kind === 0) await writeFile(path.join(dir, 'new', `e${seed}-${n}.txt`), `${n}\n`);
          else if (kind === 1) await rm(path.join(dir, 'new', `u${n % 40}.txt`), { force: true });
          else
            await writeFile(
              path.join(dir, `a/f${String(n * 4).padStart(4, '0')}.txt`),
              `x${step}\n`,
            );
          edits++;
          // Wait for the real condition: the daemon's state moved (an rm of a gone file does not).
          await eventually(
            async () => (await summaryOf(api, id))?.stateHash !== before,
            5000,
          ).catch(() => undefined);
        }
        const limit = 1 + Math.floor(random() * 70);
        const page = await api.listFiles(id, {
          scope: WORKING,
          limit,
          ...(cursor ? { cursor } : {}),
        });
        expect(page.files.length).toBeLessThanOrEqual(limit);
        if (page.restarted) {
          restarts++;
          got = [];
          state = null;
        }
        // Every page since the last restart is of one state.
        state ??= page.stateHash;
        expect(page.stateHash).toBe(state);
        expect(page.offset).toBe(got.length);
        got.push(...keys(page.files));
        if (!page.nextCursor) {
          const whole = await all(api, id);
          // The worktree has not moved since: the paging is that state's whole list.
          if (whole.stateHash === state) {
            expect(got).toEqual(keys(whole.files));
            expect(got).toHaveLength(whole.total ?? -1);
            completed++;
          }
          break;
        }
        cursor = page.nextCursor;
      }
      expect(new Set(got).size).toBe(got.length);
    }
    expect(completed).toBeGreaterThan(0);
    expect(restarts).toBeGreaterThan(0);
  });

  it('a cursor of an older state restarts, even when the same files are listed', async () => {
    const fx = await makeRealGitFixture();
    const dir = await repoWith(fx, 'same', { tracked: 40, modified: 40, untracked: 0 });
    const { api, id } = await start(fx, dir);
    await watching(api, id);
    const first = await api.listFiles(id, { scope: WORKING, limit: 10 });
    expect(first.nextCursor).toBeTruthy();
    // Only a patch moves: the same 40 files, another state.
    await writeFile(path.join(dir, 'a/f0004.txt'), 'line 4\nchanged again\n');
    await eventually(async () => (await summaryOf(api, id))?.stateHash !== first.stateHash, 10_000);
    const next = await api.listFiles(id, {
      scope: WORKING,
      limit: 10,
      cursor: first.nextCursor as string,
    });
    expect(next.restarted).toBe(true);
    expect(next.offset).toBe(0);
    expect(next.stateHash).not.toBe(first.stateHash);
    expect(keys(next.files)).toEqual(keys(first.files));
  });

  it('serves every page of one state from one list', async () => {
    const fx = await makeRealGitFixture();
    const dir = await repoWith(fx, 'once', { tracked: 120, modified: 100, untracked: 30 });
    const { api, id, lists } = await start(fx, dir);
    const first = await api.listFiles(id, { scope: WORKING, limit: 7 });
    const before = lists.filter((l) => l === `${dir}|working`).length;
    let cursor = first.nextCursor;
    let pages = 1;
    while (cursor) {
      const page = await api.listFiles(id, { scope: WORKING, limit: 7, cursor });
      expect(page.restarted).toBe(false);
      cursor = page.nextCursor;
      pages++;
    }
    await api.listFiles(id, {
      scope: WORKING,
      unreviewed: true,
      after: { path: 'a/f0004.txt' },
      limit: 1,
    });
    await api.listFiles(id, { scope: WORKING, q: 'f00' });
    await api.inbox({ scope: WORKING, filesLimit: 3 });
    expect(pages).toBe(Math.ceil(130 / 7));
    expect(lists.filter((l) => l === `${dir}|working`).length).toBe(before);
    expect(before).toBeLessThanOrEqual(1);
  });

  it('an old client gets the first files with truncated; bulk review marks the whole list', async () => {
    const fx = await makeRealGitFixture();
    const n = FILES_UNPAGED_MAX + 100;
    const dir = await repoWith(fx, 'old', { tracked: n, modified: n, untracked: 0 });
    const { api, id } = await start(fx, dir);
    const res = await api.listFiles(id, { scope: WORKING });
    expect(res.files).toHaveLength(FILES_UNPAGED_MAX);
    expect(res.truncated).toBe(true);
    expect(res.total).toBe(n);
    expect(res.counts).toEqual({ total: n, reviewed: 0, base: 0, baseReviewed: 0 });
    // The rest, from where the first answer stopped.
    const rest = await api.listFiles(id, { scope: WORKING, cursor: res.nextCursor as string });
    expect(rest.files).toHaveLength(100);
    expect(rest.nextCursor).toBeNull();
    expect([...keys(res.files), ...keys(rest.files)]).toEqual(
      keys(orderFiles([...res.files, ...rest.files])),
    );
    // Bulk review of the worktree: the daemon's whole list, not a page.
    const summary = await summaryOf(api, id);
    const bulk = await api.bulkReview({
      target: { kind: 'worktree', worktreeId: id },
      scope: WORKING,
      reviewed: true,
      expectedStateHashes: { [id]: summary?.stateHash as string },
    });
    expect(bulk.changed).toBe(n);
    const after = await api.listFiles(id, { scope: WORKING, limit: 1 });
    expect(after.counts?.reviewed).toBe(n);
    // `n` finds nothing left; the unreviewed view is empty.
    const next = await api.listFiles(id, { scope: WORKING, limit: 1, unreviewed: true });
    expect(next.files).toHaveLength(0);
    expect(next.total).toBe(0);
  });

  it('no response passes about 1 MB, whatever the paths', async () => {
    const fx = await makeRealGitFixture();
    const dir = await makeRealRepo(fx, 'long', { 'a.txt': 'a\n' });
    // About 800 characters a path (macOS allows 1024), 1300 files: about 1.3 MB of rows.
    const deep = path.join(
      ...Array.from({ length: 4 }, (_, i) => `${String(i)}${'d'.repeat(195)}`),
    );
    await mkdir(path.join(dir, deep), { recursive: true });
    for (let i = 0; i < 1300; i++) await writeFile(path.join(dir, deep, `f${i}.txt`), `${i}\n`);
    const { daemon, id } = await start(fx, dir);
    const sizes: number[] = [];
    const seen: string[] = [];
    let cursor = '';
    for (let i = 0; i < 10; i++) {
      const res = await http(
        daemon,
        `/api/worktrees/${id}/files?scope=working&limit=${FILES_PAGE_MAX}${cursor ? `&cursor=${cursor}` : ''}`,
        { headers: { 'accept-encoding': 'identity' } },
      );
      const bytes = Buffer.from(await res.arrayBuffer());
      sizes.push(bytes.length);
      const body = JSON.parse(bytes.toString('utf8')) as FilesResponse;
      seen.push(...keys(body.files));
      if (!body.nextCursor) break;
      cursor = body.nextCursor;
    }
    expect(sizes.length).toBeGreaterThan(1);
    expect(Math.max(...sizes)).toBeLessThan(1_000_000);
    expect(new Set(seen).size).toBe(1300);
    // The old client's answer is bounded the same way.
    const unpaged = await http(daemon, `/api/worktrees/${id}/files?scope=working`, {
      headers: { 'accept-encoding': 'identity' },
    });
    const body = Buffer.from(await unpaged.arrayBuffer());
    expect(body.length).toBeLessThan(1_000_000);
    expect((JSON.parse(body.toString('utf8')) as FilesResponse).truncated).toBe(true);
    // The inbox too.
    const inbox = await http(daemon, '/api/inbox?scope=working&filesLimit=2000', {
      headers: { 'accept-encoding': 'identity' },
    });
    expect((await inbox.arrayBuffer()).byteLength).toBeLessThan(1_000_000);
  });

  it('after + unreviewed is the next unreviewed file; q searches; origin filters', async () => {
    const fx = await makeRealGitFixture();
    const dir = await repoWith(fx, 'next', { tracked: 40, modified: 40, untracked: 0 });
    const { api, id } = await start(fx, dir);
    const whole = await all(api, id);
    const order = whole.files.map((f) => f.path);
    // Review every other file of the first ten.
    for (const f of whole.files.slice(0, 10).filter((_, i) => i % 2 === 0)) {
      await api.setReview({
        projectId: await projectIdOf(api, id),
        path: f.path,
        patchHash: f.patchHash,
        reviewed: true,
        scopeKind: 'working',
      });
    }
    const next = (after: string) =>
      api
        .listFiles(id, { scope: WORKING, after: { path: after }, unreviewed: true, limit: 1 })
        .then((r) => r.files[0]?.path);
    expect(await next(order[0] as string)).toBe(order[1]);
    expect(await next(order[1] as string)).toBe(order[3]);
    // A file gone from the list: where it would sort.
    expect(await next(`${order[1]}~`)).toBe(order[3]);
    const pos = await api.listFiles(id, {
      scope: WORKING,
      after: { path: order[1] as string },
      unreviewed: true,
      limit: 1,
    });
    expect(pos.position).toBe(3);
    // Search: best match first, at most `limit`.
    const found = await api.listFiles(id, { scope: WORKING, q: 'f0013', limit: 5 });
    expect(found.files[0]?.path).toMatch(/f0013\.txt$/);
    expect(found.files.length).toBeLessThanOrEqual(5);
    // Every file is own here: the base view is empty, the own view is the list.
    expect((await api.listFiles(id, { scope: WORKING, origin: 'base' })).total).toBe(0);
    expect((await api.listFiles(id, { scope: WORKING, origin: 'own' })).total).toBe(40);
  });

  it('inbox rows: a bounded first page, counts, and a cursor /files pages on with', async () => {
    const fx = await makeRealGitFixture();
    const dir = await repoWith(fx, 'inbox', { tracked: 90, modified: 80, untracked: 10 });
    const { api, id } = await start(fx, dir);
    const whole = await all(api, id);
    const inbox = await api.inbox({ scope: WORKING, filesLimit: 25 });
    const row = inbox.entries.find((e) => e.worktree.id === id);
    expect(row?.files).toHaveLength(25);
    expect(row?.filesTotal).toBe(90);
    expect(row?.fileCounts).toEqual({ total: 90, reviewed: 0, base: 0, baseReviewed: 0 });
    expect(keys(row?.files ?? [])).toEqual(keys(whole.files.slice(0, 25)));
    const rest = await api.listFiles(id, {
      scope: WORKING,
      limit: FILES_PAGE_MAX,
      cursor: row?.filesNextCursor as string,
    });
    expect(rest.restarted).toBe(false);
    expect(keys(rest.files)).toEqual(keys(whole.files.slice(25)));
    // The default: `INBOX_FILES_PER_WORKTREE` (200) holds all 90.
    const plain = (await api.inbox({ scope: WORKING })).entries.find((e) => e.worktree.id === id);
    expect(plain?.files).toHaveLength(90);
    expect(plain?.filesNextCursor).toBeUndefined();
    // Counts only.
    const counts = (await api.inbox({ scope: WORKING, filesLimit: 0 })).entries[0];
    expect(counts?.files).toHaveLength(0);
    expect(counts?.filesTotal).toBe(90);
    // onlyUnreviewed: the row pages the unreviewed view (`unreviewed=true`).
    const f = whole.files[0];
    await api.setReview({
      projectId: await projectIdOf(api, id),
      path: f?.path as string,
      patchHash: f?.patchHash as string,
      reviewed: true,
      scopeKind: 'working',
    });
    const open = (await api.inbox({ scope: WORKING, onlyUnreviewed: true, filesLimit: 10 }))
      .entries[0];
    expect(open?.filesTotal).toBe(89);
    expect(open?.fileCounts?.reviewed).toBe(1);
    const more = await api.listFiles(id, {
      scope: WORKING,
      unreviewed: true,
      limit: FILES_PAGE_MAX,
      cursor: open?.filesNextCursor as string,
    });
    expect(more.restarted).toBe(false);
    expect(more.files).toHaveLength(79);
    // The same cursor is not one of the whole list.
    const other = await api.listFiles(id, {
      scope: WORKING,
      cursor: open?.filesNextCursor as string,
    });
    expect(other.restarted).toBe(true);
  });
});
