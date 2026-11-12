/**
 * #40: the watcher's paths reach git-core, which limits `status` / `diff` to them; an edit costs at
 * most three git processes from the write to the end of its refresh (summary and review state);
 * a lost event is repaired by the reconciliation refresh; `incremental: false` is the old path.
 * Spawns are counted by pointing git-core at a wrapper script that logs its argv.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { ServerEventOf, WorktreeSummary } from '@octopus-diff/contracts';
import { createGitCore } from '@octopus-diff/git-core';
import parcelWatcher from '@parcel/watcher';
import { describe, expect, it } from 'vitest';
import { type DaemonInternals, startDaemon } from '../src/daemon.js';
import { hashId } from '../src/ids.js';
import type { SubscribeFn } from '../src/watcher.js';
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

async function startCounting(fx: RealGitFixture, internal: DaemonInternals = {}) {
  const log = path.join(await tempDir(), 'spawns.log');
  writeFileSync(log, '');
  const wrapper = path.join(path.dirname(log), 'git-wrapper.sh');
  // One line per process: its arguments, NUL-separated (paths may hold spaces).
  writeFileSync(
    wrapper,
    `#!/bin/sh\nfor a in "$@"; do printf '%s\\001' "$a"; done >> '${log}'\necho >> '${log}'\nexec git "$@"\n`,
  );
  chmodSync(wrapper, 0o755);
  const incremental = internal.incremental !== false;
  const daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    stateDir: await tempDir(),
    logLevel: 'silent',
    gitCore: createGitCore({ env: fx.env, gitBinary: wrapper, incremental }),
    watch: { debounceMs: 100, enabled: true },
    internal,
  });
  onCleanup(() => daemon.close());
  /** argv (global options dropped) of every git process so far, `config` reads left out. */
  const spawns = (): string[][] =>
    readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => line.split('\u0001').filter(Boolean))
      .map((argv) => argv.slice(argv.findIndex((a) => !a.startsWith('-') && !a.includes('='))))
      .filter((argv) => argv[0] !== 'config');
  return { daemon, spawns };
}

async function quiet(spawns: () => unknown[], quietMs = 400): Promise<void> {
  let last = spawns().length;
  let since = Date.now();
  const deadline = Date.now() + 15_000;
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
  const files: Record<string, string> = { 'a.txt': 'one\ntwo\n', 'b.txt': 'b\n', 'c d.txt': 'c\n' };
  for (let i = 0; i < 40; i++) files[`f${i}.txt`] = `file ${i}\n`;
  const repo = await makeRealRepo(fx, 'repo', files);
  await appendFile(path.join(repo, 'b.txt'), 'dirty\n');
  return { fx, repo, repoId: hashId(repo) };
}

function changedAfter(events: ReturnType<typeof recordEvents>, mark: number, id: string) {
  return eventually(
    () =>
      events.events
        .slice(mark)
        .find((e): e is Changed => e.type === 'worktree.changed' && e.worktreeId === id),
    8000,
  );
}

/** What a full refresh says about the worktree now (another git-core, no state). */
async function fullSummary(fx: RealGitFixture, repo: string): Promise<WorktreeSummary> {
  const core = createGitCore({ env: fx.env, incremental: false });
  try {
    const {
      snapshot: _s,
      refresh: _r,
      ...summary
    } = await core.getSummary({
      projectId: 'p',
      worktreeId: 'w',
      path: repo,
    });
    return summary as WorktreeSummary;
  } finally {
    await core.dispose();
  }
}

const sameState = (got: WorktreeSummary | null | undefined, want: WorktreeSummary) => {
  expect(got).toBeDefined();
  const pick = (s: WorktreeSummary) => ({
    counts: { ...s.counts, deleted: undefined },
    changedFiles: s.changedFiles,
    additions: s.additions,
    deletions: s.deletions,
    headSha: s.headSha,
    branch: s.branch,
  });
  expect(pick(got as WorktreeSummary)).toEqual(pick(want));
};

describe('incremental refresh in the daemon (#40)', () => {
  it('an edit costs at most 3 git processes, limited to the edited path', async () => {
    const s = await setup();
    const { daemon, spawns } = await startCounting(s.fx);
    const api = client(daemon);
    const events = recordEvents(daemon);
    await events.opened;
    await api.addProject({ path: s.repo });
    await quiet(spawns);
    // A first change: the review state is wanted from then on (it changed after startup).
    let mark = events.events.length;
    await appendFile(path.join(s.repo, 'c d.txt'), 'warm up\n');
    await changedAfter(events, mark, s.repoId);
    await quiet(spawns);

    const perEdit: string[][][] = [];
    for (let i = 0; i < 3; i++) {
      mark = events.events.length;
      const before = spawns().length;
      await appendFile(path.join(s.repo, 'a.txt'), `edit ${i}\n`);
      const event = await changedAfter(events, mark, s.repoId);
      await quiet(spawns);
      perEdit.push(spawns().slice(before));
      sameState(event.summary, await fullSummary(s.fx, s.repo));
    }
    if (process.env.OCTOPUS_PRINT_SPAWNS) console.log(JSON.stringify(perEdit));
    for (const list of perEdit) {
      const subs = list.map((argv) => argv[0]);
      // status + numstat for the summary, one diff for the review list.
      expect(list.length, subs.join(', ')).toBeLessThanOrEqual(3);
      for (const argv of list) {
        if (argv[0] !== 'status' && argv[0] !== 'diff') continue;
        // Limited to the edited file (no rename candidates in this worktree).
        expect(argv.slice(argv.indexOf('--')), argv.join(' ')).toEqual(['--', 'a.txt']);
      }
    }
    // The file lists the UI reads are what a full listing says.
    const reference = createGitCore({ env: s.fx.env, incremental: false });
    onCleanup(() => reference.dispose());
    const { files } = await api.listFiles(s.repoId, { scope: { kind: 'working' } });
    const want = await reference.listChangedFiles(
      { projectId: 'p', worktreeId: 'w', path: s.repo },
      { kind: 'working' },
    );
    expect(files.map(({ reviewed: _r, origin: _o, ...f }) => f)).toEqual(want);
  });

  it('a lost event is repaired by the reconciliation refresh', async () => {
    const s = await setup();
    // The native watcher, minus every event for `lost.txt`.
    const dropping: SubscribeFn = (dir, fn, opts) =>
      parcelWatcher.subscribe(
        dir,
        (error, evts) =>
          fn(
            error,
            evts.filter((e) => !e.path.endsWith('lost.txt')),
          ),
        opts,
      );
    const { daemon, spawns } = await startCounting(s.fx, {
      subscribe: dropping,
      incremental: { reconcileMs: 1500 },
    });
    const api = client(daemon);
    const events = recordEvents(daemon);
    await events.opened;
    await api.addProject({ path: s.repo });
    await quiet(spawns);

    const mark = events.events.length;
    await appendFile(path.join(s.repo, 'lost.txt'), 'nobody saw me\n');
    await sleep(50);
    await appendFile(path.join(s.repo, 'a.txt'), 'seen\n');
    const first = await changedAfter(events, mark, s.repoId);
    const truth = await fullSummary(s.fx, s.repo);
    // The incremental refresh trusted the watcher: lost.txt is missing.
    expect(first.summary?.counts.untracked).toBe(truth.counts.untracked - 1);
    // Then the reconciliation (1.5 s after it) finds it, with no new event at all.
    const repaired = await eventually(
      () =>
        events.events
          .slice(mark)
          .find(
            (e): e is Changed =>
              e.type === 'worktree.changed' &&
              e.worktreeId === s.repoId &&
              e.summary?.counts.untracked === truth.counts.untracked,
          ),
      6000,
    );
    sameState(repaired.summary, truth);
  });

  it('Refresh is a full refresh that forgets the kept state, whatever the watcher has pending', async () => {
    const s = await setup();
    const dropping: SubscribeFn = (dir, fn, opts) =>
      parcelWatcher.subscribe(
        dir,
        (error, evts) =>
          fn(
            error,
            evts.filter((e) => !e.path.endsWith('lost.txt')),
          ),
        opts,
      );
    // No reconciliation during the test: only Refresh can repair the lost event.
    const { daemon, spawns } = await startCounting(s.fx, {
      subscribe: dropping,
      incremental: { reconcileMs: 600_000 },
    });
    const api = client(daemon);
    const events = recordEvents(daemon);
    await events.opened;
    await api.addProject({ path: s.repo });
    await quiet(spawns);
    const mark = events.events.length;
    await appendFile(path.join(s.repo, 'lost.txt'), 'nobody saw me\n');
    await sleep(50);
    await appendFile(path.join(s.repo, 'a.txt'), 'seen\n');
    const first = await changedAfter(events, mark, s.repoId);
    const truth = await fullSummary(s.fx, s.repo);
    expect(first.summary?.counts.untracked).toBe(truth.counts.untracked - 1);
    await quiet(spawns);
    // An edit whose paths the watcher still holds when the user presses Refresh.
    daemon.core.watcher.markDirty(s.repoId, 'fs', ['a.txt']);
    const before = spawns().length;
    const { summary } = await api.refreshWorktree(s.repoId);
    sameState(summary, await fullSummary(s.fx, s.repo));
    const statuses = spawns()
      .slice(before)
      .filter((argv) => argv[0] === 'status');
    expect(statuses.some((argv) => !argv.includes('--'))).toBe(true);
  });

  it('incremental: false runs every status over the whole worktree', async () => {
    const s = await setup();
    const { daemon, spawns } = await startCounting(s.fx, { incremental: false });
    const api = client(daemon);
    const events = recordEvents(daemon);
    await events.opened;
    await api.addProject({ path: s.repo });
    await quiet(spawns);
    const mark = events.events.length;
    const before = spawns().length;
    await appendFile(path.join(s.repo, 'a.txt'), 'edit\n');
    await changedAfter(events, mark, s.repoId);
    await quiet(spawns);
    const statuses = spawns()
      .slice(before)
      .filter((argv) => argv[0] === 'status');
    expect(statuses.length).toBeGreaterThan(0);
    for (const argv of statuses) expect(argv).not.toContain('--');
  });
});
