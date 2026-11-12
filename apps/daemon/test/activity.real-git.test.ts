/**
 * #38 through the daemon with real git: an "agent" edits, deletes, commits, checks out and resets
 * in a worktree; the live feed shows it, the deleted file's last committed content is served by the
 * blob route (only for oids of the feed), an untracked deleted file says "content unavailable",
 * the snapshot costs no extra git process, and nothing is persisted.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ActivityEntry, ApiClient, GitCore, ServerEvent } from '@octopus-diff/contracts';
import { createGitCore } from '@octopus-diff/git-core';
import { describe, expect, it } from 'vitest';
import { type Daemon, startDaemon } from '../src/daemon.js';
import { hashId } from '../src/ids.js';
import {
  client,
  errorOf,
  eventually,
  http,
  onCleanup,
  recordEvents,
  TEST_TOKEN,
  tempDir,
} from './helpers.js';
import { makeRealGitFixture, makeRealRepo, type RealGitFixture } from './real-git-fixture.js';

const SECRET = 'AGENT-DELETED-CONTENT-7f3a';
const DELETED_NAME = 'deleted-by-agent.txt';
const SCRATCH_NAME = 'scratch-untracked.txt';

interface Started {
  daemon: Daemon;
  api: ApiClient;
  stateDir: string;
  /** git processes git-core started (a wrapper logs each one). */
  spawns: () => string[];
  /** GitCore method calls by name. */
  calls: Map<string, number>;
}

/**
 * A daemon on a real git-core whose git binary is a logging wrapper. `stripSnapshot` removes the
 * snapshot option from `getSummary` (the daemon as it was before #38), for spawn comparisons.
 */
async function start(
  fx: RealGitFixture,
  options: {
    projects?: string[];
    watch?: {
      enabled?: boolean;
      forcePolling?: boolean;
      pollFocusedMs?: number;
      pollIdleMs?: number;
    };
    stripSnapshot?: boolean;
    stateDir?: string;
  } = {},
): Promise<Started> {
  const dir = await tempDir();
  const log = path.join(dir, 'spawns.log');
  writeFileSync(log, '');
  const wrapper = path.join(dir, 'git-wrapper.sh');
  writeFileSync(wrapper, `#!/bin/sh\necho "$*" >> '${log}'\nexec git "$@"\n`);
  chmodSync(wrapper, 0o755);
  const real = createGitCore({ env: fx.env, gitBinary: wrapper });
  const calls = new Map<string, number>();
  const git = new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        calls.set(String(prop), (calls.get(String(prop)) ?? 0) + 1);
        if (prop === 'getSummary' && options.stripSnapshot) {
          const { snapshot: _drop, ...rest } = (args[1] ?? {}) as Record<string, unknown>;
          return value.call(target, args[0], rest);
        }
        return value.apply(target, args);
      };
    },
  }) as GitCore;
  const stateDir = options.stateDir ?? (await tempDir());
  const daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    stateDir,
    logLevel: process.env.OCTOPUS_DIFF_TEST_LOGS ? 'debug' : 'silent',
    gitCore: git,
    projects: options.projects ?? [],
    watch: { debounceMs: 150, ...options.watch },
    internal: { forges: false },
  });
  onCleanup(() => daemon.close());
  return {
    daemon,
    api: client(daemon),
    stateDir,
    spawns: () => readFileSync(log, 'utf8').split('\n').filter(Boolean),
    calls,
  };
}

async function repo(fx: RealGitFixture, name = 'app'): Promise<string> {
  return makeRealRepo(fx, name, {
    'a.txt': 'one\ntwo\n',
    [DELETED_NAME]: `${SECRET}\nline 2\nline 3\n`,
    'c.txt': 'c\n',
  });
}

/** Waits until the feed has an entry matching `match` and returns it. */
function waitEntry(
  api: ApiClient,
  worktreeId: string,
  match: (e: ActivityEntry) => boolean,
  timeoutMs = 8000,
): Promise<ActivityEntry> {
  return eventually(
    async () => (await api.getActivity(worktreeId)).entries.find(match),
    timeoutMs,
    50,
  );
}

const live = (api: ApiClient, id: string) =>
  eventually(async () => (await api.getActivity(id)).live, 8000, 50);

/** The git subcommand of a logged argv (after the global options and `-c` pairs). */
function subcommand(line: string): string | undefined {
  const words = line.split(' ');
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as string;
    if (w === '-c') i++;
    else if (!w.startsWith('-')) return w;
  }
  return undefined;
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (d.isFile()) out.push(path.join(d.parentPath, d.name));
  }
  return out;
}

describe('live activity feed (real git, #38)', () => {
  it('shows what an agent does: edit, delete (content served), untracked delete, commit, checkout, reset', async () => {
    const fx = await makeRealGitFixture();
    const dir = await repo(fx);
    const id = hashId(dir);
    const s = await start(fx, { projects: [dir] });
    const { api } = s;
    const events = recordEvents(s.daemon);
    await events.opened;
    await live(api, id);
    // The baseline produced nothing.
    expect((await api.getActivity(id)).entries).toEqual([]);
    expect((await api.getActivity(id)).watch.mode).toBe('native');

    // 1. Edit.
    await appendFile(path.join(dir, 'a.txt'), 'three\nfour\n');
    const edit = await waitEntry(api, id, (e) => e.kind === 'modified' && e.path === 'a.txt');
    expect(edit).toMatchObject({ xy: '.M', added: 2, deleted: 0, count: 1 });
    const changed = (await events.waitFor(
      (e) => e.type === 'worktree.changed' && e.worktreeId === id && e.activitySeq !== undefined,
      5000,
    )) as Extract<ServerEvent, { type: 'worktree.changed' }>;
    expect(changed.activitySeq).toBeGreaterThanOrEqual(edit.seq);

    // 2. Delete a tracked file: its committed content stays readable by oid.
    await rm(path.join(dir, DELETED_NAME));
    const del = await waitEntry(api, id, (e) => e.kind === 'deleted' && e.path === DELETED_NAME);
    expect(del).toMatchObject({ xy: '.D', added: 0, deleted: 3 });
    expect(del.oid).toMatch(/^[0-9a-f]{40}$/);
    const blob = await api.getBlob(id, del.oid as string);
    expect(blob.blob).toMatchObject({ kind: 'text', content: `${SECRET}\nline 2\nline 3\n` });
    // State-based chip: one uncommitted tracked deletion.
    const summaryOf = async () =>
      (await api.listProjects()).projects[0]?.worktrees.find((w) => w.worktree.id === id)?.summary;
    expect((await summaryOf())?.counts.deleted).toBe(1);
    // The snapshot never reaches the API.
    expect(JSON.stringify(await summaryOf())).not.toContain('"snapshot"');

    // 3. An untracked file created then deleted: seen, but no content.
    await writeFile(path.join(dir, SCRATCH_NAME), 'temporary\n');
    await waitEntry(api, id, (e) => e.kind === 'added' && e.path === SCRATCH_NAME);
    await rm(path.join(dir, SCRATCH_NAME));
    const gone = await waitEntry(api, id, (e) => e.kind === 'deleted' && e.path === SCRATCH_NAME);
    expect(gone).toMatchObject({ oid: null, untracked: true, xy: '??' });

    // 4. Commit the edit and the deletion: one commit entry, the paths on it, nothing "restored".
    const before = (await api.getActivity(id)).seq;
    fx.git(dir, 'add', '-A');
    fx.git(dir, 'commit', '-q', '-m', 'agent: edit a, drop the file');
    const c = await waitEntry(api, id, (e) => e.kind === 'commit');
    expect(c).toMatchObject({ subject: 'agent: edit a, drop the file', pathCount: 2 });
    expect([...(c.paths ?? [])].sort()).toEqual([DELETED_NAME, 'a.txt'].sort());
    const afterCommit = await api.getActivity(id, { after: before });
    expect(afterCommit.entries.filter((e) => e.kind === 'restored')).toEqual([]);
    await eventually(async () => (await summaryOf())?.counts.deleted === 0, 5000);
    // The deleted file's blob is still served after the commit (its entry is in the ring).
    expect((await api.getBlob(id, del.oid as string)).blob.content).toContain(SECRET);

    // 5. Checkout a new branch, then reset it back by one commit while dirty.
    fx.git(dir, 'checkout', '-q', '-b', 'agent/work');
    const co = await waitEntry(api, id, (e) => e.kind === 'head' && e.op === 'checkout');
    expect(co).toMatchObject({ branch: 'agent/work', fromBranch: 'main' });
    await appendFile(path.join(dir, 'c.txt'), 'dirty\n');
    await waitEntry(api, id, (e) => e.kind === 'modified' && e.path === 'c.txt');
    fx.git(dir, 'reset', '-q', '--hard', 'HEAD~1');
    const reset = await waitEntry(api, id, (e) => e.kind === 'head' && e.op === 'reset');
    expect(reset.paths).toContain('c.txt');
    const all = (await api.getActivity(id)).entries;
    expect(all.filter((e) => e.kind === 'commit')).toHaveLength(1); // the reset is not a commit
    expect(all.filter((e) => e.kind === 'restored' && e.path === 'c.txt')).toEqual([]);

    // `after` pages: nothing newer than the latest seq.
    const latest = await api.getActivity(id);
    expect((await api.getActivity(id, { after: latest.seq })).entries).toEqual([]);
    expect(latest.dropped).toBe(false);
  });

  it('serves only blobs of the feed, validated and size-capped', async () => {
    const fx = await makeRealGitFixture();
    const dir = await repo(fx);
    const other = await makeRealRepo(fx, 'other', { 'o.txt': 'o\n' });
    const id = hashId(dir);
    const otherId = hashId(other);
    const s = await start(fx, { projects: [dir, other] });
    const { api, daemon } = s;
    await live(api, id);
    await live(api, otherId);
    await rm(path.join(dir, DELETED_NAME));
    const del = await waitEntry(api, id, (e) => e.kind === 'deleted');
    const oid = del.oid as string;
    const route = (wt: string, o: string, q = '') => `/api/worktrees/${wt}/blob/${o}${q}`;

    // Invalid ids: 400 before anything reads git.
    const reads = () => s.calls.get('readBlob') ?? 0;
    const r0 = reads();
    for (const bad of [
      'abc1234',
      oid.toUpperCase(),
      'HEAD',
      '0'.repeat(40),
      `${oid}0`,
      '--batch',
    ]) {
      const res = await http(daemon, route(id, encodeURIComponent(bad)));
      expect(res.status, bad).toBe(400);
    }
    // Real objects of the repository that are not in the feed: 404, never read.
    const head = fx.git(dir, 'rev-parse', 'HEAD').trim();
    const tree = fx.git(dir, 'rev-parse', 'HEAD^{tree}').trim();
    const untouched = fx.git(dir, 'rev-parse', 'HEAD:c.txt').trim();
    for (const notFed of [head, tree, untouched]) {
      const res = await http(daemon, route(id, notFed));
      expect(res.status).toBe(404);
      expect((await errorOf(res)).message).toMatch(/recent activity/);
    }
    // The oid belongs to `dir`'s feed, not to `other`'s.
    expect((await http(daemon, route(otherId, oid))).status).toBe(404);
    expect(reads()).toBe(r0);
    // Caps: above the route's limit is a 400, a small cap gives too_large without content.
    expect((await http(daemon, route(id, oid, `?maxBytes=${2 * 1024 * 1024}`))).status).toBe(400);
    expect((await http(daemon, route(id, oid, '?maxBytes=0'))).status).toBe(400);
    const small = await api.getBlob(id, oid, { maxBytes: 5 });
    expect(small.blob).toMatchObject({ kind: 'too_large', content: null, maxBytes: 5 });
    // Behind the token like every route; unknown worktree 404.
    expect((await http(daemon, route(id, oid), { auth: false })).status).toBe(401);
    expect((await http(daemon, `/api/worktrees/${id}/activity`, { auth: false })).status).toBe(401);
    expect((await http(daemon, route('0123456789abcdef', oid))).status).toBe(404);
    expect((await http(daemon, '/api/worktrees/0123456789abcdef/activity')).status).toBe(404);
    expect((await http(daemon, `/api/worktrees/${id}/activity?after=-1`)).status).toBe(400);
    expect((await http(daemon, `/api/worktrees/${id}/activity?after=x`)).status).toBe(400);
    // The API CSP and no-store apply.
    const ok = await http(daemon, route(id, oid));
    expect(ok.status).toBe(200);
    expect(ok.headers.get('cache-control')).toBe('no-store');
    expect(ok.headers.get('content-security-policy')).toContain("default-src 'none'");
  });

  it('the snapshot costs no git process; a HEAD move costs one `log`', async () => {
    // The same steps on two identical repositories, driven by manual refreshes (watching off):
    // the daemon as built, and one whose getSummary calls have the snapshot option removed.
    const steps = async (s: Started, dir: string, fx: RealGitFixture) => {
      const id = hashId(dir);
      const counts: number[] = [];
      const step = async (act: () => Promise<void> | void) => {
        await act();
        await s.api.refreshWorktree(id);
        counts.push(s.spawns().length);
      };
      await step(() => {});
      await step(() => appendFile(path.join(dir, 'a.txt'), 'x\n'));
      await step(() => rm(path.join(dir, DELETED_NAME)));
      await step(() => writeFile(path.join(dir, 'new.txt'), 'n\n'));
      await step(() => {
        fx.git(dir, 'add', '-A');
        fx.git(dir, 'commit', '-q', '-m', 'step');
      });
      return counts;
    };
    const quiet = { enabled: false, pollFocusedMs: 600_000, pollIdleMs: 600_000 };
    const fxA = await makeRealGitFixture();
    const dirA = await repo(fxA);
    const a = await start(fxA, { projects: [dirA], watch: quiet });
    await live(a.api, hashId(dirA));
    const withSnapshot = await steps(a, dirA, fxA);

    const fxB = await makeRealGitFixture();
    const dirB = await repo(fxB);
    const b = await start(fxB, { projects: [dirB], watch: quiet, stripSnapshot: true });
    await eventually(async () => (await b.api.listProjects()).projects[0]?.worktrees[0]?.summary);
    const without = await steps(b, dirB, fxB);

    const [lastA = 0, lastB = 0] = [withSnapshot[4], without[4]];
    expect(a.spawns().length - lastA).toBe(0);
    // Startup and the file steps: identical totals; the commit adds exactly one `log`.
    expect(withSnapshot.slice(0, 4)).toEqual(without.slice(0, 4));
    expect(lastA - lastB).toBe(1);
    // The extra process is the HEAD classification's `git log`.
    const logs = (x: Started) => x.spawns().filter((l) => subcommand(l) === 'log').length;
    expect(logs(a) - logs(b)).toBe(1);
    // The feed of A saw it all; B (no snapshot) has no feed.
    const feed = await a.api.getActivity(hashId(dirA));
    expect(feed.entries.map((e) => e.kind)).toEqual(['modified', 'deleted', 'added', 'commit']);
    expect((await b.api.getActivity(hashId(dirB))).live).toBe(false);
    expect(feed.watch).toEqual({ mode: 'disabled', pollMs: 600_000 });
  });

  it('is never persisted: nothing reaches the state dir, a restart starts empty', async () => {
    const fx = await makeRealGitFixture();
    const dir = await repo(fx);
    const id = hashId(dir);
    const s = await start(fx, { projects: [dir] });
    await live(s.api, id);
    await writeFile(path.join(dir, SCRATCH_NAME), `${SECRET}-untracked\n`);
    await waitEntry(s.api, id, (e) => e.path === SCRATCH_NAME);
    await rm(path.join(dir, DELETED_NAME));
    await waitEntry(s.api, id, (e) => e.kind === 'deleted' && e.path === DELETED_NAME);
    await rm(path.join(dir, SCRATCH_NAME));
    await waitEntry(s.api, id, (e) => e.kind === 'deleted' && e.path === SCRATCH_NAME);
    await s.daemon.close();
    for (const file of await filesUnder(s.stateDir)) {
      const bytes = await readFile(file);
      for (const needle of [SECRET, DELETED_NAME, SCRATCH_NAME]) {
        expect(bytes.includes(Buffer.from(needle)), `${needle} in ${file}`).toBe(false);
      }
    }
    // A new daemon on the same state dir: a fresh baseline, no entries.
    const again = await start(fx, { projects: [dir], stateDir: s.stateDir });
    await live(again.api, id);
    const feed = await again.api.getActivity(id);
    expect(feed.entries).toEqual([]);
    // The previous run's seq is from another run: dropped, start over.
    expect((await again.api.getActivity(id, { after: 1000 })).dropped).toBe(true);
    // Still a deletion in the state: the chip is state-based.
    const summary = (await again.api.listProjects()).projects[0]?.worktrees[0]?.summary;
    expect(summary?.counts.deleted).toBe(1);
  });

  it('says how a polled worktree is refreshed', async () => {
    const fx = await makeRealGitFixture();
    const dir = await repo(fx);
    const id = hashId(dir);
    const s = await start(fx, { projects: [dir], watch: { forcePolling: true, pollIdleMs: 4000 } });
    await live(s.api, id);
    const feed = await s.api.getActivity(id);
    expect(feed.watch.mode).toBe('polling');
    expect(feed.watch.pollMs).toBeGreaterThan(0);
  });
});
