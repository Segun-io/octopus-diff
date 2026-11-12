/**
 * #51: `worktree.changed` carries the worktree's row of `/api/projects` and the changed paths with
 * their patch hashes, built from what the daemon already holds (no git process of its own), and
 * `GET /api/inbox?worktreeIds=` answers only those rows. Spawns are counted by pointing git-core at
 * a wrapper script that logs its argv and then execs the real git.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  type GitChangedFile,
  parseServerEvent,
  type ServerEventOf,
  SseParser,
  WORKTREE_CHANGED_PATHS_MAX,
  WORKTREE_CHANGED_PATHS_MAX_CHARS,
  WorktreeChangedPathsSchema,
} from '@octopus-diff/contracts';
import { createGitCore } from '@octopus-diff/git-core';
import { describe, expect, it } from 'vitest';
import { changedPathsOf } from '../src/core.js';
import { type Daemon, startDaemon } from '../src/daemon.js';
import { hashId } from '../src/ids.js';
import {
  client,
  eventually,
  onCleanup,
  recordEvents,
  sleep,
  TEST_TOKEN,
  tempDir,
} from './helpers.js';
import { makeRealGitFixture, makeRealRepo, type RealGitFixture } from './real-git-fixture.js';

type Changed = ServerEventOf<'worktree.changed'>;

/**
 * Git processes three appends to a tracked file cost in this fixture (the summary, the review state
 * with its file list), measured on main before #51 with this same test (3 runs, identical):
 * `config status diff rev-parse config status diff`, `config status diff config status diff`, and
 * the same plus one `config`. The deltas must not add one.
 */
const SPAWNS_PER_EDIT_BEFORE = [7, 6, 7];

interface Counting {
  daemon: Daemon;
  /** Subcommands of every git process spawned so far. */
  spawns: () => string[];
}

async function startCounting(fx: RealGitFixture): Promise<Counting> {
  const log = path.join(await tempDir(), 'spawns.log');
  writeFileSync(log, '');
  const wrapper = path.join(path.dirname(log), 'git-wrapper.sh');
  writeFileSync(wrapper, `#!/bin/sh\necho "$*" >> '${log}'\nexec git "$@"\n`);
  chmodSync(wrapper, 0o755);
  const daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    stateDir: await tempDir(),
    logLevel: 'silent',
    gitCore: createGitCore({ env: fx.env, gitBinary: wrapper }),
    watch: { debounceMs: 100, enabled: true },
  });
  onCleanup(() => daemon.close());
  return {
    daemon,
    spawns: () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(' ').find((w) => !w.startsWith('-') && !w.includes('=')) ?? ''),
  };
}

/** Waits until no git process was spawned for `quietMs`. */
async function quiet(spawns: () => string[], quietMs = 400): Promise<void> {
  let last = spawns().length;
  let since = Date.now();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await sleep(50);
    const now = spawns().length;
    if (now !== last) {
      last = now;
      since = Date.now();
    } else if (Date.now() - since >= quietMs) return;
  }
  throw new Error('git never went quiet');
}

async function setup() {
  const fx = await makeRealGitFixture();
  const repo = await makeRealRepo(fx, 'repo', { 'a.txt': 'one\ntwo\n', 'b.txt': 'b\n' });
  const other = await makeRealRepo(fx, 'other', { 'o.txt': 'o\n' });
  await appendFile(path.join(repo, 'b.txt'), 'dirty\n');
  await appendFile(path.join(other, 'o.txt'), 'dirty\n');
  return { fx, repo, other, repoId: hashId(repo), otherId: hashId(other) };
}

function changedAfter(
  events: ReturnType<typeof recordEvents>,
  mark: number,
  worktreeId: string,
): Promise<Changed> {
  return eventually(
    () =>
      events.events
        .slice(mark)
        .find((e): e is Changed => e.type === 'worktree.changed' && e.worktreeId === worktreeId),
    5000,
  );
}

/** The replayed `worktree.changed` with `stateHash` for a stream opened with `Last-Event-ID`. */
async function replayAfter(daemon: Daemon, lastEventId: string, stateHash: string) {
  const controller = new AbortController();
  const res = await fetch(`${daemon.url}/api/events`, {
    headers: { authorization: `Bearer ${daemon.token}`, 'last-event-id': lastEventId },
    signal: controller.signal,
  });
  const reader = res.body?.getReader();
  if (!reader) throw new Error('no body');
  const parser = new SseParser();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended');
      for (const message of parser.push(decoder.decode(value, { stream: true }))) {
        const event = parseServerEvent(message);
        if (event?.type === 'worktree.changed' && event.stateHash === stateHash) return event;
      }
    }
  } finally {
    controller.abort();
  }
}

describe('event deltas (#51)', () => {
  it('worktree.changed carries the /api/projects row and the cached paths; no extra git process', async () => {
    const s = await setup();
    const { daemon, spawns } = await startCounting(s.fx);
    const api = client(daemon);
    const events = recordEvents(daemon);
    await events.opened;
    await api.addProject({ path: s.repo });
    await api.addProject({ path: s.other });
    await quiet(spawns);

    const perEdit: string[][] = [];
    let last: Changed | undefined;
    for (let i = 0; i < 3; i++) {
      const mark = events.events.length;
      const before = spawns().length;
      await appendFile(path.join(s.repo, 'a.txt'), `edit ${i}\n`);
      last = await changedAfter(events, mark, s.repoId);
      await quiet(spawns);
      perEdit.push(spawns().slice(before));
    }
    // No more git processes per edit than before the deltas (and none of them a working listing).
    if (process.env.OCTOPUS_PRINT_SPAWNS) console.log(JSON.stringify(perEdit));
    perEdit.forEach((list, i) => {
      expect(list.length, list.join(', ')).toBeLessThanOrEqual(SPAWNS_PER_EDIT_BEFORE[i] ?? 0);
    });
    if (!last) throw new Error('no event');

    // The row is exactly what /api/projects now says about the worktree.
    const { projects } = await api.listProjects();
    const row = projects.flatMap((p) => p.worktrees).find((w) => w.worktree.id === s.repoId);
    expect(row).toBeDefined();
    expect(last.worktree).toEqual(row?.worktree);
    expect(last.summary).toEqual(row?.summary);
    expect(last.error).toBeNull();
    expect(last.review).toEqual(row?.review);
    expect(last.summary?.stateHash).toBe(last.stateHash);

    // The paths are the list the daemon already had for this state (the review state's), and
    // they agree with what `/files` says in that scope.
    const paths = last.paths;
    expect(paths).toBeDefined();
    if (!paths) return;
    expect(paths.truncated).toBe(false);
    expect(paths.scope.kind).toBe('review');
    const listed = await api.listFiles(s.repoId, { scope: paths.scope });
    expect(listed.stateHash).toBe(last.stateHash);
    const ids = (files: { path: string; patchHash: string }[]) =>
      files.map((f) => `${f.path}\u0000${f.patchHash}`).sort();
    expect(ids(paths.files)).toEqual(ids(listed.files));
    expect(paths.total).toBe(listed.files.length);
    expect(paths.files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
  });

  it('a clean worktree announces an empty working list; replayed events are slim', async () => {
    const s = await setup();
    const { daemon, spawns } = await startCounting(s.fx);
    const api = client(daemon);
    const events = recordEvents(daemon);
    await events.opened;
    await api.addProject({ path: s.other });
    await quiet(spawns);
    const mark = events.events.length;
    // Undo the only change: the worktree is clean.
    await writeFile(path.join(s.other, 'o.txt'), 'o\n');
    const clean = await changedAfter(events, mark, s.otherId);
    expect(clean.summary?.changedFiles).toBe(0);
    expect(clean.paths).toEqual({
      scope: { kind: 'working' },
      files: [],
      total: 0,
      truncated: false,
    });

    // A client reconnecting with Last-Event-ID gets the event without the delta (it resyncs).
    const replayed = await replayAfter(daemon, `${daemon.hub.bootId}.0`, clean.stateHash);
    expect(replayed.stateHash).toBe(clean.stateHash);
    expect(replayed.summary).toBeUndefined();
    expect(replayed.paths).toBeUndefined();
  });

  it('GET /api/inbox?worktreeIds= returns only those rows, as the full inbox has them', async () => {
    const s = await setup();
    // A second (dirty) worktree in the same project: the filter is by worktree, not by project.
    const feature = path.join(s.fx.root, 'repo-feature');
    s.fx.git(s.repo, 'worktree', 'add', '-q', '-b', 'feature', feature);
    await appendFile(path.join(feature, 'a.txt'), 'feature\n');
    const featureId = hashId(feature);
    const { daemon, spawns } = await startCounting(s.fx);
    const api = client(daemon);
    await api.addProject({ path: s.repo });
    await api.addProject({ path: s.other });
    await quiet(spawns);
    const scope = { kind: 'working' } as const;
    const full = await api.inbox({ scope });
    expect(full.entries.map((e) => e.worktree.id).sort()).toEqual(
      [s.repoId, featureId, s.otherId].sort(),
    );
    const only = await api.inbox({ scope, worktreeIds: [s.otherId, 'ffffffffffffffff'] });
    expect(only.entries).toEqual(full.entries.filter((e) => e.worktree.id === s.otherId));
    const one = await api.inbox({ scope, worktreeIds: [featureId] });
    expect(one.entries).toEqual(full.entries.filter((e) => e.worktree.id === featureId));
    // Within projectIds when both are given: the other project's worktree is not in it.
    const none = await api.inbox({
      scope,
      worktreeIds: [s.otherId],
      projectIds: [full.entries.find((e) => e.worktree.id === s.repoId)?.project.id ?? ''],
    });
    expect(none.entries).toEqual([]);
    // Ids are validated with the contract schema.
    const res = await fetch(`${daemon.url}/api/inbox?worktreeIds=nope`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(res.status).toBe(400);
  });
});

describe('the bounded path list (#51)', () => {
  const file = (p: string, rawPath?: string): GitChangedFile => ({
    path: p,
    ...(rawPath ? { rawPath } : {}),
    oldPath: null,
    status: 'modified',
    binary: false,
    oldMode: '100644',
    newMode: '100644',
    additions: 1,
    deletions: 0,
    patchHash: `h-${p}`,
    staged: false,
    unstaged: true,
  });
  const scope = { kind: 'working' } as const;

  it('lists every file up to the cap, identity and patch hash only', () => {
    const files = Array.from({ length: WORKTREE_CHANGED_PATHS_MAX }, (_, i) => file(`f${i}`));
    files[0] = file('weird', 'd2VpcmQ=');
    const out = changedPathsOf(scope, files);
    expect(out.truncated).toBe(false);
    expect(out.total).toBe(WORKTREE_CHANGED_PATHS_MAX);
    expect(out.files[0]).toEqual({ path: 'weird', rawPath: 'd2VpcmQ=', patchHash: 'h-weird' });
    expect(out.files[1]).toEqual({ path: 'f1', patchHash: 'h-f1' });
    expect(WorktreeChangedPathsSchema.safeParse(out).success).toBe(true);
  });

  it('sends none, with the total, above the count or the character cap', () => {
    const many = Array.from({ length: WORKTREE_CHANGED_PATHS_MAX + 1 }, (_, i) => file(`f${i}`));
    expect(changedPathsOf(scope, many)).toEqual({
      scope,
      files: [],
      total: WORKTREE_CHANGED_PATHS_MAX + 1,
      truncated: true,
    });
    const long = 'x'.repeat(Math.ceil(WORKTREE_CHANGED_PATHS_MAX_CHARS / 10) + 1);
    const wide = Array.from({ length: 10 }, (_, i) => file(`${long}${i}`));
    expect(changedPathsOf(scope, wide)).toMatchObject({ files: [], total: 10, truncated: true });
  });
});
