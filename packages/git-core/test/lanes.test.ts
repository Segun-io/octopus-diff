/**
 * Priority lanes and cancellation in the runner (#44): a gated stand-in git binary holds
 * processes until the test releases them, so the order in which queued work starts is exact.
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isGitCoreError } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ABORT_GRACE_MS, createGitCore, GitRunner, INTERACTIVE_BURST } from '../src/index.js';
import { createFixture, type Fixture } from './helpers/fixture.js';

let fx: Fixture;
let fakeGit: string;
let log: string;
let gates: string;

/** `status -- <name>`: the job's name is its last argument (logged at start). */
const job = (name: string): string[] => ['status', '--', name];

beforeAll(() => {
  fx = createFixture();
  log = path.join(fx.root, 'starts.log');
  gates = path.join(fx.root, 'gates');
  fx.write(path.join(gates, '.keep'), '');
  fakeGit = path.join(fx.root, 'fake-git');
  // Logs `start <pid> <name>`; a name with a gate file waits until the file is removed. Mode
  // `stubborn` ignores SIGTERM (so only SIGKILL stops it); `hang` sleeps.
  writeFileSync(
    fakeGit,
    [
      '#!/bin/sh',
      'for last in "$@"; do :; done',
      `echo "start $$ $last" >> "${log}"`,
      'case "$FAKE_MODE" in',
      "  stubborn) trap '' TERM; sleep 30 ;;",
      '  hang) sleep 30 ;;',
      'esac',
      `while [ -e "${gates}/$last" ]; do sleep 0.01; done`,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(fakeGit, 0o755);
});

afterAll(() => fx.dispose());

function starts(): Array<{ pid: number; name: string }> {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [, pid, name] = line.split(' ');
      return { pid: Number(pid), name: name ?? '' };
    });
}

function gate(name: string): () => void {
  const file = path.join(gates, name);
  writeFileSync(file, '');
  return () => rmSync(file, { force: true });
}

async function until(check: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function alive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
}

/** True while any process of the group led by `pid` is alive. */
const groupAlive = (pid: number): boolean => alive(-pid);

/**
 * The aborted run settled after its git process exited (the leader is reaped), and the rest of
 * its process group follows within moments (init reaps the orphans).
 */
async function expectGone(pid: number): Promise<void> {
  expect(alive(pid)).toBe(false);
  await until(() => !groupAlive(pid), 1_000);
}

describe('priority lanes', () => {
  it('starts queued interactive work ahead of queued background work', async () => {
    writeFileSync(log, '');
    const runner = new GitRunner({ gitBinary: fakeGit, concurrency: 1 });
    const release = gate('blocker');
    const runs = [runner.run(job('blocker'), { cwd: fx.root, queueKey: 'a' })];
    await until(() => starts().length === 1);
    // Background work of several repositories queued first, then one interactive request.
    for (let i = 0; i < 6; i++) {
      runs.push(runner.run(job(`bg${i}`), { cwd: fx.root, queueKey: `repo${i % 3}` }));
    }
    runs.push(runner.run(job('diff'), { cwd: fx.root, queueKey: 'b', priority: 'interactive' }));
    release();
    await Promise.all(runs);
    const order = starts().map((s) => s.name);
    expect(order[0]).toBe('blocker');
    expect(order[1]).toBe('diff');
    await runner.dispose();
  });

  it('bounds starvation: background work starts after at most INTERACTIVE_BURST interactive starts', async () => {
    writeFileSync(log, '');
    const runner = new GitRunner({ gitBinary: fakeGit, concurrency: 1 });
    const release = gate('blocker');
    const runs = [runner.run(job('blocker'), { cwd: fx.root })];
    await until(() => starts().length === 1);
    runs.push(runner.run(job('bg0'), { cwd: fx.root, queueKey: 'bg' }));
    runs.push(runner.run(job('bg1'), { cwd: fx.root, queueKey: 'bg' }));
    for (let i = 0; i < 3 * INTERACTIVE_BURST; i++) {
      runs.push(
        runner.run(job(`ui${i}`), { cwd: fx.root, queueKey: `ui${i}`, priority: 'interactive' }),
      );
    }
    release();
    await Promise.all(runs);
    const order = starts()
      .map((s) => s.name)
      .slice(1);
    // ui0..ui3, bg0, ui4..ui7, bg1, ui8..
    expect(order.indexOf('bg0')).toBe(INTERACTIVE_BURST);
    expect(order.indexOf('bg1')).toBe(2 * INTERACTIVE_BURST + 1);
    // Without competing background work, interactive work runs back to back.
    expect(order.slice(2 * INTERACTIVE_BURST + 2).every((n) => n.startsWith('ui'))).toBe(true);
    await runner.dispose();
  });

  it('serves the background lane as before when nothing is interactive', async () => {
    writeFileSync(log, '');
    const runner = new GitRunner({ gitBinary: fakeGit, concurrency: 1 });
    const release = gate('blocker');
    const runs = [runner.run(job('blocker'), { cwd: fx.root, queueKey: 'busy' })];
    await until(() => starts().length === 1);
    for (let i = 0; i < 3; i++)
      runs.push(runner.run(job(`busy${i}`), { cwd: fx.root, queueKey: 'busy' }));
    runs.push(runner.run(job('quiet'), { cwd: fx.root, queueKey: 'quiet' }));
    release();
    await Promise.all(runs);
    const order = starts().map((s) => s.name);
    // Round-robin per key (FairScheduler): the quiet repository is not served last.
    expect(order.indexOf('quiet')).toBeLessThan(order.length - 1);
    await runner.dispose();
  });
});

describe('cancellation', () => {
  it('a run aborted while queued rejects at once and never spawns', async () => {
    writeFileSync(log, '');
    const runner = new GitRunner({ gitBinary: fakeGit, concurrency: 1 });
    const release = gate('blocker');
    const blocker = runner.run(job('blocker'), { cwd: fx.root });
    await until(() => starts().length === 1);
    const controller = new AbortController();
    const queued = runner
      .run(job('queued'), { cwd: fx.root, queueKey: 'other', signal: controller.signal })
      .catch((e: unknown) => e);
    const after = runner.run(job('after'), { cwd: fx.root, queueKey: 'third' });
    controller.abort();
    // Rejected while the blocker still holds the only slot.
    const error = await queued;
    expect(isGitCoreError(error, 'aborted')).toBe(true);
    expect(starts().map((s) => s.name)).toEqual(['blocker']);
    release();
    await Promise.all([blocker, after]);
    expect(starts().map((s) => s.name)).toEqual(['blocker', 'after']);
    // An already-aborted signal is refused up front.
    const early = await runner
      .run(job('early'), { cwd: fx.root, signal: AbortSignal.abort() })
      .catch((e: unknown) => e);
    expect(isGitCoreError(early, 'aborted')).toBe(true);
    expect(starts().map((s) => s.name)).not.toContain('early');
    await runner.dispose();
  });

  it('a running process is terminated by an abort and settles once it is gone', async () => {
    writeFileSync(log, '');
    const runner = new GitRunner({ gitBinary: fakeGit, env: { FAKE_MODE: 'hang' } });
    const controller = new AbortController();
    const started = Date.now();
    const run = runner
      .run(job('running'), { cwd: fx.root, signal: controller.signal })
      .catch((e: unknown) => e);
    await until(() => starts().length === 1);
    const pid = starts()[0]?.pid as number;
    expect(groupAlive(pid)).toBe(true);
    controller.abort();
    const error = await run;
    expect(isGitCoreError(error, 'aborted')).toBe(true);
    // SIGTERM is enough here: well before the grace period, and nothing of the group is left.
    expect(Date.now() - started).toBeLessThan(ABORT_GRACE_MS + 2_000);
    await expectGone(pid);
    await runner.dispose();
  });

  it('escalates to SIGKILL when the process ignores SIGTERM', async () => {
    writeFileSync(log, '');
    const runner = new GitRunner({
      gitBinary: fakeGit,
      env: { FAKE_MODE: 'stubborn' },
      timeoutMs: 60_000,
    });
    const controller = new AbortController();
    const run = runner
      .run(job('stubborn'), { cwd: fx.root, signal: controller.signal })
      .catch((e: unknown) => e);
    await until(() => starts().length === 1);
    const pid = starts()[0]?.pid as number;
    // Let the shell install its trap before the signal arrives.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const abortedAt = Date.now();
    controller.abort();
    const error = await run;
    expect(isGitCoreError(error, 'aborted')).toBe(true);
    const took = Date.now() - abortedAt;
    expect(took).toBeGreaterThanOrEqual(ABORT_GRACE_MS - 50);
    // SIGKILL after the grace period, not the (much later) timeout.
    expect(took).toBeLessThan(ABORT_GRACE_MS + 2_000);
    await expectGone(pid);
    await runner.dispose();
  });

  it('keeps the slot until the aborted process has exited', async () => {
    writeFileSync(log, '');
    const runner = new GitRunner({
      gitBinary: fakeGit,
      env: { FAKE_MODE: 'stubborn' },
      concurrency: 1,
    });
    const controller = new AbortController();
    const first = runner
      .run(job('first'), { cwd: fx.root, signal: controller.signal })
      .catch((e: unknown) => e);
    await until(() => starts().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pid = starts()[0]?.pid as number;
    const second = runner
      .run(job('second'), { cwd: fx.root, queueKey: 'x', signal: AbortSignal.timeout(5_000) })
      .catch((e: unknown) => e);
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, ABORT_GRACE_MS / 2));
    // Still in its grace period: the second process has not started.
    expect(starts().map((s) => s.name)).toEqual(['first']);
    expect(isGitCoreError(await first, 'aborted')).toBe(true);
    await expectGone(pid);
    await until(() => starts().length === 2);
    await runner.dispose();
    await second;
  });
});

describe('GitCore calls with a signal and a lane (real git behind a gated wrapper)', () => {
  let wrapper: string;
  let wlog: string;
  let holds: string;

  beforeAll(() => {
    wlog = path.join(fx.root, 'wrapper.log');
    holds = path.join(fx.root, 'holds');
    fx.write(path.join(holds, '.keep'), '');
    wrapper = path.join(fx.root, 'git-wrapper.sh');
    // Finds the subcommand after git's global options, logs `start <pid> <sub> <dir name>`, waits
    // while `holds/<sub>` or `holds/<sub>@<dir name>` exists, then runs the real git.
    writeFileSync(
      wrapper,
      [
        '#!/bin/sh',
        'sub=""; skip=0',
        'for a in "$@"; do',
        '  if [ "$skip" = 1 ]; then skip=0; continue; fi',
        '  case "$a" in -c) skip=1 ;; -*) ;; *) sub="$a"; break ;; esac',
        'done',
        '[ -n "$sub" ] || sub=version',
        'dir=$(basename "$PWD")',
        `echo "start $$ $sub $dir" >> "${wlog}"`,
        `while [ -e "${holds}/$sub" ] || [ -e "${holds}/$sub@$dir" ]; do sleep 0.01; done`,
        'exec git "$@"',
        '',
      ].join('\n'),
    );
    chmodSync(wrapper, 0o755);
  });

  const spawned = (): Array<{ pid: number; sub: string; dir: string }> =>
    existsSync(wlog)
      ? readFileSync(wlog, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [, pid, sub, dir] = line.split(' ');
            return { pid: Number(pid), sub: sub ?? '', dir: dir ?? '' };
          })
      : [];

  const hold = (name: string): (() => void) => {
    const file = path.join(holds, name);
    writeFileSync(file, '');
    return () => rmSync(file, { force: true });
  };

  function dirtyRepo(name: string): { projectId: string; worktreeId: string; path: string } {
    const dir = fx.repo(name, { files: { 'a.txt': 'one\n' } });
    fx.write(path.join(dir, 'a.txt'), 'one\ntwo\n');
    return { projectId: name, worktreeId: name, path: dir };
  }

  it('an aborted getFileDiff stops its git process; the call rejects with aborted', async () => {
    const wt = dirtyRepo('abort-running');
    const core = createGitCore(fx.coreOptions({ gitBinary: wrapper }));
    await core.listChangedFiles(wt, { kind: 'working' }); // warm: version, discovery, config
    writeFileSync(wlog, '');
    const release = hold('diff@abort-running');
    try {
      const controller = new AbortController();
      const call = core
        .getFileDiff(
          wt,
          { kind: 'working' },
          { path: 'a.txt' },
          {
            signal: controller.signal,
            priority: 'interactive',
          },
        )
        .catch((e: unknown) => e);
      await until(() => spawned().some((s) => s.sub === 'diff'));
      const pid = spawned().find((s) => s.sub === 'diff')?.pid as number;
      expect(groupAlive(pid)).toBe(true);
      controller.abort();
      expect(isGitCoreError(await call, 'aborted')).toBe(true);
      await until(() => !groupAlive(pid), ABORT_GRACE_MS + 1_000);
    } finally {
      release();
      await core.dispose();
    }
  });

  it('a call aborted before its git process got a slot never spawns it', async () => {
    const busy = dirtyRepo('queued-busy');
    const wt = dirtyRepo('queued-diff');
    const core = createGitCore(fx.coreOptions({ gitBinary: wrapper, concurrency: 1 }));
    await core.listChangedFiles(busy, { kind: 'working' });
    await core.listChangedFiles(wt, { kind: 'working' });
    writeFileSync(wlog, '');
    const release = hold('status@queued-busy');
    try {
      const summary = core.getSummary(busy);
      await until(() => spawned().some((s) => s.sub === 'status'));
      const controller = new AbortController();
      const call = core
        .getFileDiff(wt, { kind: 'working' }, { path: 'a.txt' }, { signal: controller.signal })
        .catch((e: unknown) => e);
      await new Promise((resolve) => setTimeout(resolve, 100));
      controller.abort();
      expect(isGitCoreError(await call, 'aborted')).toBe(true);
      release();
      await summary;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(spawned().filter((s) => s.dir === 'queued-diff')).toEqual([]);
    } finally {
      release();
      await core.dispose();
    }
  });

  it('shared work is cancelled when its only waiter aborts', async () => {
    const wt = dirtyRepo('lone-discovery');
    const core = createGitCore(fx.coreOptions({ gitBinary: wrapper }));
    await core.version();
    writeFileSync(wlog, '');
    const release = hold('rev-parse@lone-discovery');
    try {
      const controller = new AbortController();
      const call = core
        .getFileDiff(wt, { kind: 'working' }, { path: 'a.txt' }, { signal: controller.signal })
        .catch((e: unknown) => e);
      await until(() => spawned().some((s) => s.sub === 'rev-parse'));
      const pid = spawned().find((s) => s.sub === 'rev-parse')?.pid as number;
      controller.abort();
      expect(isGitCoreError(await call, 'aborted')).toBe(true);
      // Nobody else wanted the discovery: its process is stopped, although still held.
      await until(() => !groupAlive(pid), ABORT_GRACE_MS + 1_000);
      release();
      // A later call starts a fresh discovery instead of joining the cancelled one.
      expect((await core.listChangedFiles(wt, { kind: 'working' })).map((f) => f.path)).toEqual([
        'a.txt',
      ]);
      expect(spawned().filter((s) => s.sub === 'rev-parse')).toHaveLength(2);
    } finally {
      release();
      await core.dispose();
    }
  });

  it('an already-aborted call starts nothing, not even shared reads', async () => {
    const wt = dirtyRepo('pre-aborted');
    const core = createGitCore(fx.coreOptions({ gitBinary: wrapper }));
    writeFileSync(wlog, '');
    try {
      const early = await core
        .getFileDiff(wt, { kind: 'working' }, { path: 'a.txt' }, { signal: AbortSignal.abort() })
        .catch((e: unknown) => e);
      expect(isGitCoreError(early, 'aborted')).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(spawned()).toEqual([]);
    } finally {
      await core.dispose();
    }
  });

  it('rejects at once even while it waits on shared work that others keep (the version probe)', async () => {
    const wt = dirtyRepo('waits-on-version');
    const core = createGitCore(fx.coreOptions({ gitBinary: wrapper }));
    writeFileSync(wlog, '');
    const release = hold('version');
    try {
      const controller = new AbortController();
      const leaving = core
        .getFileDiff(wt, { kind: 'working' }, { path: 'a.txt' }, { signal: controller.signal })
        .catch((e: unknown) => e);
      const staying = core.listChangedFiles(wt, { kind: 'working' });
      await until(() => spawned().some((s) => s.sub === 'version'));
      controller.abort();
      // Rejected while the version probe is still held.
      expect(isGitCoreError(await leaving, 'aborted')).toBe(true);
      release();
      expect((await staying).map((f) => f.path)).toEqual(['a.txt']);
    } finally {
      release();
      await core.dispose();
    }
  });

  it('work shared with another call is not cancelled when one caller aborts', async () => {
    const wt = dirtyRepo('shared-discovery');
    const core = createGitCore(fx.coreOptions({ gitBinary: wrapper }));
    await core.version();
    writeFileSync(wlog, '');
    // Both calls wait on the one repository discovery (`rev-parse`), started by the first.
    const release = hold('rev-parse@shared-discovery');
    try {
      const controller = new AbortController();
      const leaving = core
        .getFileDiff(wt, { kind: 'working' }, { path: 'a.txt' }, { signal: controller.signal })
        .catch((e: unknown) => e);
      const staying = core.listChangedFiles(wt, { kind: 'working' });
      await until(() => spawned().some((s) => s.sub === 'rev-parse'));
      controller.abort();
      expect(isGitCoreError(await leaving, 'aborted')).toBe(true);
      release();
      const files = await staying;
      expect(files.map((f) => f.path)).toEqual(['a.txt']);
      expect(spawned().filter((s) => s.sub === 'rev-parse')).toHaveLength(1);
    } finally {
      release();
      await core.dispose();
    }
  });

  it('an interactive diff is not queued behind background summaries of other repositories', async () => {
    const names = Array.from({ length: 6 }, (_, i) => `lane-bg${i}`);
    const bgs = names.map(dirtyRepo);
    const wt = dirtyRepo('lane-ui');
    const core = createGitCore(fx.coreOptions({ gitBinary: wrapper, concurrency: 1 }));
    for (const b of [...bgs, wt]) await core.getSummary(b);
    await core.getFileDiff(wt, { kind: 'working' }, { path: 'a.txt' });
    writeFileSync(wlog, '');
    // One background process holds the only slot; the summaries of six repositories queue.
    const release = hold('status@lane-bg0');
    const summaries = bgs.map((b) => core.getSummary(b).catch((e: unknown) => e));
    try {
      const isHeld = (s: { sub: string; dir: string }) =>
        s.sub === 'status' && s.dir === 'lane-bg0';
      await until(() => spawned().some(isHeld));
      await new Promise((resolve) => setTimeout(resolve, 100));
      const diff = core.getFileDiff(
        wt,
        { kind: 'working' },
        { path: 'a.txt' },
        {
          priority: 'interactive',
        },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Nothing else started while the held process had the only slot.
      const held = spawned().findIndex(isHeld);
      expect(spawned()).toHaveLength(held + 1);
      release();
      const result = await diff;
      expect(result.path).toBe('a.txt');
      const order = spawned();
      await Promise.all(summaries);
      const last = order.map((s) => s.dir).lastIndexOf('lane-ui');
      // The diff's first process is the next to start once the held one ends, and background
      // processes only fill the moments between two of its processes (at most one per gap).
      expect(order[held + 1]?.dir).toBe('lane-ui');
      const window = order.slice(held + 1, last + 1);
      const own = window.filter((s) => s.dir === 'lane-ui').length;
      expect(window.length - own).toBeLessThanOrEqual(own - 1);
    } finally {
      release();
      await core.dispose();
    }
  });
});
