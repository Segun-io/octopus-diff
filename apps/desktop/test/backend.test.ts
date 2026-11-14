import { describe, expect, it } from 'vitest';
import {
  type BackendOptions,
  type BackendState,
  BackendSupervisor,
  backendEnv,
  backendStdio,
  backoffDelay,
  DEFAULT_POLICY,
  isLoopbackReady,
  isReadyFor,
  parseReadyLine,
  serveArgs,
} from '../src/backend.js';
import { FakeClock, fakeSpawn, fakeWslSpawn, readyLine, settle, TOKEN } from './fakes.js';

function setup(over: Partial<BackendOptions> = {}) {
  const clock = new FakeClock();
  const spawner = fakeSpawn();
  const notes: string[] = [];
  const output: string[] = [];
  const states: BackendState[] = [];
  let alive = true;
  const probes: string[] = [];
  const supervisor = new BackendSupervisor({
    spawn: spawner.spawn,
    command: '/apps/Electron',
    args: ['/app/dist/cli/index.js', ...serveArgs(['--state-dir', '/s'])],
    env: { PATH: '/usr/bin:/opt/homebrew/bin', HOME: '/home/u' },
    appVersion: '1.2.3',
    log: { output: (c) => output.push(String(c)), note: (l) => notes.push(l) },
    timers: clock,
    probe: async (url) => {
      probes.push(url);
      return alive;
    },
    onState: (s) => states.push(s),
    ...over,
  });
  return {
    clock,
    spawner,
    notes,
    output,
    states,
    probes,
    supervisor,
    setAlive: (v: boolean) => {
      alive = v;
    },
    kinds: () => states.map((s) => s.kind),
    allLogs: () => [...notes, ...output].join('\n'),
  };
}

describe('serveArgs / backendEnv', () => {
  it('always asks for the ready line on fd 3, the stdin lifeline and no browser', () => {
    expect(serveArgs()).toEqual(['serve', '--ready-fd', '3', '--exit-with-stdin', '--no-open']);
    expect(serveArgs(['--port', '0'])).toEqual([
      'serve',
      '--ready-fd',
      '3',
      '--exit-with-stdin',
      '--no-open',
      '--port',
      '0',
    ]);
  });

  it('runs Electron as Node (ELECTRON_RUN_AS_NODE=1) and keeps the rest of the env', () => {
    expect(backendEnv({ PATH: '/x', ELECTRON_RUN_AS_NODE: undefined })).toEqual({
      PATH: '/x',
      ELECTRON_RUN_AS_NODE: '1',
    });
  });
});

describe('backendStdio', () => {
  it('stdin and fd 3 are always pipes (never ignore); output goes to the log fd if given', () => {
    expect(backendStdio(undefined)).toEqual(['pipe', 'pipe', 'pipe', 'pipe']);
    expect(backendStdio(null)).toEqual(['pipe', 'pipe', 'pipe', 'pipe']);
    expect(backendStdio(17)).toEqual(['pipe', 17, 17, 'pipe']);
    expect(backendStdio(0)).toEqual(['pipe', 0, 0, 'pipe']);
  });
});

describe('parseReadyLine', () => {
  it('accepts one valid line (a trailing newline or more lines are fine)', () => {
    const parsed = parseReadyLine(`${readyLine()}\n`);
    expect(parsed).toEqual({
      ok: true,
      ready: {
        mode: 'started',
        url: 'http://127.0.0.1:7428',
        authUrl: `http://127.0.0.1:7428/#token=${TOKEN}`,
        pid: 4242,
        version: '1.2.3',
      },
    });
    expect(parseReadyLine(`${readyLine({ mode: 'attached' })}\ngarbage`).ok).toBe(true);
  });

  it('rejects empty, non-JSON and invalid lines without quoting them (they hold the token)', () => {
    expect(parseReadyLine('')).toEqual({ ok: false, reason: 'no ready line' });
    expect(parseReadyLine('\n')).toEqual({ ok: false, reason: 'no ready line' });
    const notJson = parseReadyLine(`token=${TOKEN}`);
    expect(notJson).toEqual({ ok: false, reason: 'the ready line is not JSON' });
    const invalid = parseReadyLine(readyLine({ mode: 'other', pid: -1 }));
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.reason).toBe('invalid ready line (mode, pid)');
      expect(invalid.reason).not.toContain(TOKEN);
    }
    expect(parseReadyLine('[]').ok).toBe(false);
    expect(parseReadyLine(readyLine({ authUrl: 'not a url' })).ok).toBe(false);
  });
});

describe('isReadyFor (PR #108: a health answer for a daemon that has left ready is dropped)', () => {
  const info = {
    mode: 'started',
    url: 'http://127.0.0.1:7428/',
    authUrl: `http://127.0.0.1:7428/#token=${TOKEN}`,
    pid: 1,
    version: '1.0.0',
    versionMismatch: false,
  } as const;

  it('is true only while the backend is ready with this very daemon', () => {
    expect(isReadyFor({ kind: 'ready', ready: info }, info)).toBe(true);
    // The same daemon announced again (a new state object) is a different one to wait for.
    expect(isReadyFor({ kind: 'ready', ready: { ...info } }, info)).toBe(false);
  });

  it('is false once a restart, a failure or a stop screen is up', () => {
    for (const state of [
      { kind: 'restarting', attempt: 1, delayMs: 500, reason: 'exited' },
      { kind: 'failed', reason: 'exited', failures: 5 },
      { kind: 'stopping' },
      { kind: 'stopped' },
      { kind: 'starting', attempt: 1 },
      { kind: 'idle' },
    ] as const) {
      expect(isReadyFor(state, info)).toBe(false);
    }
    expect(isReadyFor(undefined, info)).toBe(false);
  });
});

describe('backoffDelay', () => {
  it('walks the list and repeats its last entry', () => {
    const policy = { backoffMs: [100, 200, 400] };
    expect([1, 2, 3, 4, 9].map((n) => backoffDelay(policy, n))).toEqual([100, 200, 400, 400, 400]);
    expect(backoffDelay(policy, 0)).toBe(100);
    expect(backoffDelay({ backoffMs: [] }, 3)).toBe(0);
  });
});

describe('BackendSupervisor: spawning', () => {
  it('spawns the Electron binary as Node with four pipes (stdin is the lifeline, never ignore)', () => {
    const t = setup();
    t.supervisor.start();
    const call = t.spawner.last();
    expect(call.command).toBe('/apps/Electron');
    expect(call.args).toEqual([
      '/app/dist/cli/index.js',
      'serve',
      '--ready-fd',
      '3',
      '--exit-with-stdin',
      '--no-open',
      '--state-dir',
      '/s',
    ]);
    expect(call.options.stdio).toEqual(['pipe', 'pipe', 'pipe', 'pipe']);
    expect(call.options.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(call.options.env.PATH).toBe('/usr/bin:/opt/homebrew/bin');
    expect(call.options.windowsHide).toBe(true);
    expect(t.kinds()).toEqual(['starting']);
    const withFd = setup({ outputFd: 9 });
    withFd.supervisor.start();
    expect(withFd.spawner.last().options.stdio).toEqual(['pipe', 9, 9, 'pipe']);
    // start() twice does not spawn a second backend
    t.supervisor.start();
    expect(t.spawner.calls).toHaveLength(1);
  });

  it('sends the daemon output to the log', async () => {
    const t = setup();
    t.supervisor.start();
    t.spawner.last().child.stdout.write('banner line\n');
    t.spawner.last().child.stderr.write('a warning\n');
    await settle();
    expect(t.output).toEqual(['banner line\n', 'a warning\n']);
  });

  it('a spawn that throws counts as a failure and is retried', async () => {
    let n = 0;
    const t = setup({
      spawn: () => {
        n++;
        throw new Error('EACCES');
      },
    });
    t.supervisor.start();
    expect(t.supervisor.state).toMatchObject({ kind: 'restarting', attempt: 2 });
    await t.clock.advance(DEFAULT_POLICY.backoffMs[0] ?? 0);
    expect(n).toBe(2);
  });
});

describe('BackendSupervisor: started', () => {
  it('reports ready, owns the daemon and never logs the token', async () => {
    const t = setup();
    t.supervisor.start();
    t.spawner.last().child.ready(readyLine());
    await settle();
    expect(t.supervisor.state).toEqual({
      kind: 'ready',
      ready: {
        mode: 'started',
        url: 'http://127.0.0.1:7428',
        authUrl: `http://127.0.0.1:7428/#token=${TOKEN}`,
        pid: 4242,
        version: '1.2.3',
        versionMismatch: false,
      },
    });
    expect(t.supervisor.ownsDaemon).toBe(true);
    expect(t.allLogs()).toContain('backend ready: started http://127.0.0.1:7428');
    expect(t.allLogs()).not.toContain(TOKEN);
  });

  it('flags a version different from the app CLI', async () => {
    const t = setup();
    t.supervisor.start();
    t.spawner.last().child.ready(readyLine({ version: '9.9.9' }));
    await settle();
    expect(t.supervisor.state).toMatchObject({ kind: 'ready', ready: { versionMismatch: true } });
    expect(t.notes.join('\n')).toContain('version 9.9.9, app CLI 1.2.3');
  });

  it('restarts an unexpectedly exited daemon with growing backoff, then gives up', async () => {
    const t = setup();
    t.supervisor.start();
    const delays: number[] = [];
    for (let i = 0; i < DEFAULT_POLICY.maxFailures; i++) {
      const child = t.spawner.last().child;
      child.ready(readyLine());
      await settle();
      child.exit(1);
      await settle();
      const state = t.supervisor.state;
      if (state.kind === 'restarting') {
        delays.push(state.delayMs);
        expect(state.reason).toBe('the daemon exited with code 1');
        // nothing is spawned before the delay is over
        const before = t.spawner.calls.length;
        await t.clock.advance(state.delayMs - 1);
        expect(t.spawner.calls).toHaveLength(before);
        await t.clock.advance(1);
        expect(t.spawner.calls).toHaveLength(before + 1);
      }
    }
    expect(delays).toEqual(DEFAULT_POLICY.backoffMs.slice(0, DEFAULT_POLICY.maxFailures - 1));
    expect(t.supervisor.state).toEqual({
      kind: 'failed',
      reason: 'the daemon exited with code 1',
      failures: DEFAULT_POLICY.maxFailures,
    });
    expect(t.spawner.calls).toHaveLength(DEFAULT_POLICY.maxFailures);
    await t.clock.advance(60_000);
    expect(t.spawner.calls).toHaveLength(DEFAULT_POLICY.maxFailures);
  });

  it('a daemon that served for stableMs resets the failure count', async () => {
    const t = setup();
    t.supervisor.start();
    t.spawner.last().child.exit(1); // failure 1 (never ready)
    await settle();
    await t.clock.advance(DEFAULT_POLICY.backoffMs[0] ?? 0);
    t.spawner.last().child.exit(1); // failure 2
    await settle();
    expect(t.supervisor.state).toMatchObject({ kind: 'restarting', attempt: 3 });
    await t.clock.advance(DEFAULT_POLICY.backoffMs[1] ?? 0);
    const child = t.spawner.last().child;
    child.ready(readyLine());
    await settle();
    await t.clock.advance(DEFAULT_POLICY.stableMs);
    child.exit(null, 'SIGKILL');
    await settle();
    expect(t.supervisor.state).toEqual({
      kind: 'restarting',
      attempt: 2,
      delayMs: DEFAULT_POLICY.backoffMs[0],
      reason: 'the daemon killed by SIGKILL',
    });
  });

  it('a short-lived daemon does not reset the count', async () => {
    const t = setup();
    t.supervisor.start();
    t.spawner.last().child.exit(1);
    await settle();
    await t.clock.advance(DEFAULT_POLICY.backoffMs[0] ?? 0);
    const child = t.spawner.last().child;
    child.ready(readyLine());
    await settle();
    await t.clock.advance(DEFAULT_POLICY.stableMs - 1);
    child.exit(1);
    await settle();
    expect(t.supervisor.state).toMatchObject({ kind: 'restarting', attempt: 3 });
  });

  it('an exit before the ready line is a failure', async () => {
    const t = setup();
    t.supervisor.start();
    t.spawner.last().child.exit(1);
    await settle();
    expect(t.supervisor.state).toMatchObject({
      kind: 'restarting',
      reason: 'the backend exited with code 1 before it was ready',
    });
  });

  it('an invalid ready line kills the child (logged without the line) and retries', async () => {
    const t = setup();
    t.supervisor.start();
    const child = t.spawner.last().child;
    child.ready(JSON.stringify({ mode: 'started', authUrl: `x#token=${TOKEN}` }));
    await settle();
    expect(child.kills).toEqual(['SIGTERM']);
    child.exit(null, 'SIGTERM');
    await settle();
    expect(t.supervisor.state).toMatchObject({
      kind: 'restarting',
      reason: 'invalid ready line (url, authUrl, pid, version)',
    });
    expect(t.allLogs()).not.toContain(TOKEN);
  });

  it('no ready line within readyTimeoutMs: SIGTERM, then SIGKILL if it stays', async () => {
    const t = setup();
    t.supervisor.start();
    const child = t.spawner.last().child;
    await t.clock.advance(DEFAULT_POLICY.readyTimeoutMs - 1);
    expect(child.kills).toEqual([]);
    await t.clock.advance(1);
    expect(child.kills).toEqual(['SIGTERM']);
    await t.clock.advance(DEFAULT_POLICY.killGraceMs);
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    child.exit(null, 'SIGKILL');
    await settle();
    expect(t.supervisor.state).toMatchObject({
      kind: 'restarting',
      reason: `no ready line within ${DEFAULT_POLICY.readyTimeoutMs} ms`,
    });
  });

  it('retry() after failed starts a fresh series', async () => {
    const t = setup({ policy: { maxFailures: 1 } });
    t.supervisor.start();
    t.spawner.last().child.exit(1);
    await settle();
    expect(t.supervisor.state.kind).toBe('failed');
    t.supervisor.retry();
    expect(t.spawner.calls).toHaveLength(2);
    expect(t.supervisor.state).toEqual({ kind: 'starting', attempt: 1 });
  });

  it('retry() while ready does nothing', async () => {
    const t = setup();
    t.supervisor.start();
    t.spawner.last().child.ready(readyLine());
    await settle();
    t.supervisor.retry();
    expect(t.spawner.calls).toHaveLength(1);
  });
});

describe('BackendSupervisor: stop (quit)', () => {
  it('closes stdin first and waits: a daemon that exits on EOF is never signalled', async () => {
    const t = setup();
    t.supervisor.start();
    const child = t.spawner.last().child;
    child.ready(readyLine());
    await settle();
    const stopped = t.supervisor.stop();
    await settle();
    expect(child.stdinEnded).toBe(true);
    expect(t.supervisor.state.kind).toBe('stopping');
    child.exit(0);
    await stopped;
    expect(child.kills).toEqual([]);
    expect(t.supervisor.state.kind).toBe('stopped');
    expect(t.clock.pending).toBe(0);
    // no restart after a requested stop
    await t.clock.advance(60_000);
    expect(t.spawner.calls).toHaveLength(1);
  });

  it('escalates: SIGTERM after stopGraceMs, SIGKILL after killGraceMs', async () => {
    const t = setup();
    t.supervisor.start();
    const child = t.spawner.last().child;
    child.ready(readyLine());
    await settle();
    const stopped = t.supervisor.stop();
    await t.clock.advance(DEFAULT_POLICY.stopGraceMs - 1);
    expect(child.kills).toEqual([]);
    await t.clock.advance(1);
    expect(child.kills).toEqual(['SIGTERM']);
    await t.clock.advance(DEFAULT_POLICY.killGraceMs - 1);
    expect(child.kills).toEqual(['SIGTERM']);
    await t.clock.advance(1);
    expect(child.kills).toEqual(['SIGTERM', 'SIGKILL']);
    child.exit(null, 'SIGKILL');
    await stopped;
    expect(t.supervisor.state.kind).toBe('stopped');
  });

  it('stops a child that has not sent its ready line yet', async () => {
    const t = setup();
    t.supervisor.start();
    const child = t.spawner.last().child;
    const stopped = t.supervisor.stop();
    await settle();
    expect(child.stdinEnded).toBe(true);
    child.exit(0);
    await stopped;
    expect(t.supervisor.state.kind).toBe('stopped');
  });

  it('cancels a pending restart and is idempotent', async () => {
    const t = setup();
    t.supervisor.start();
    t.spawner.last().child.exit(1);
    await settle();
    expect(t.supervisor.state.kind).toBe('restarting');
    const a = t.supervisor.stop();
    const b = t.supervisor.stop();
    expect(a).toBe(b);
    await a;
    await t.clock.advance(60_000);
    expect(t.spawner.calls).toHaveLength(1);
    t.supervisor.start();
    expect(t.spawner.calls).toHaveLength(1);
  });

  it('a ready line arriving after stop() is ignored', async () => {
    const t = setup();
    t.supervisor.start();
    const child = t.spawner.last().child;
    const stopped = t.supervisor.stop();
    child.ready(readyLine());
    await settle();
    expect(t.states.some((s) => s.kind === 'ready')).toBe(false);
    child.exit(0);
    await stopped;
  });
});

describe('BackendSupervisor: attached', () => {
  async function attached() {
    const t = setup();
    t.supervisor.start();
    const child = t.spawner.last().child;
    child.ready(readyLine({ mode: 'attached', pid: 777 }));
    await settle();
    child.exit(0);
    await settle();
    return { t, child };
  }

  it('does not own the daemon: the attach run exiting 0 is no failure', async () => {
    const { t } = await attached();
    expect(t.supervisor.state).toMatchObject({
      kind: 'ready',
      ready: { mode: 'attached', pid: 777 },
    });
    expect(t.supervisor.ownsDaemon).toBe(false);
    expect(t.supervisor.childPid).toBeUndefined();
    expect(t.kinds()).toEqual(['starting', 'ready']);
  });

  it('handles the exit coming before fd 3 is read', async () => {
    const t = setup();
    t.supervisor.start();
    const child = t.spawner.last().child;
    child.emit('exit', 0, null); // the exit first, then the line (fd 3 still open)
    await settle();
    expect(t.supervisor.state.kind).toBe('starting');
    child.fd3.write(`${readyLine({ mode: 'attached' })}\n`);
    await settle();
    expect(t.supervisor.state).toMatchObject({ kind: 'ready', ready: { mode: 'attached' } });
    expect(t.supervisor.childPid).toBeUndefined();
    expect(t.clock.pending).toBe(1); // only the attached poll: the drain timer is not needed
  });

  it('an exit with nothing on fd 3 is handled after the drain timeout at the latest', async () => {
    const t = setup();
    t.supervisor.start();
    const child = t.spawner.last().child;
    child.emit('exit', 1, null);
    await settle();
    expect(t.supervisor.state.kind).toBe('starting');
    await t.clock.advance(500);
    expect(t.supervisor.state).toMatchObject({
      kind: 'restarting',
      reason: 'the backend exited with code 1 before it was ready',
    });
  });

  it('quitting leaves the attached daemon alone (nothing to signal)', async () => {
    const { t, child } = await attached();
    await t.supervisor.stop();
    expect(child.kills).toEqual([]);
    expect(t.notes.join('\n')).not.toContain('stopping the daemon');
    expect(t.supervisor.state.kind).toBe('stopped');
  });

  it('polls health; a daemon that went away gets `serve` run again', async () => {
    const { t } = await attached();
    await t.clock.advance(DEFAULT_POLICY.attachedPollMs);
    expect(t.probes).toEqual(['http://127.0.0.1:7428']);
    expect(t.spawner.calls).toHaveLength(1);
    t.setAlive(false);
    await t.clock.advance(DEFAULT_POLICY.attachedPollMs); // miss 1
    expect(t.spawner.calls).toHaveLength(1);
    await t.clock.advance(DEFAULT_POLICY.attachedPollMs); // miss 2
    expect(t.spawner.calls).toHaveLength(2);
    expect(t.supervisor.state).toEqual({ kind: 'starting', attempt: 1 });
    t.spawner.last().child.ready(readyLine({ mode: 'started' }));
    await settle();
    expect(t.supervisor.ownsDaemon).toBe(true);
  });

  it('one missed poll is not enough', async () => {
    const { t } = await attached();
    t.setAlive(false);
    await t.clock.advance(DEFAULT_POLICY.attachedPollMs);
    t.setAlive(true);
    await t.clock.advance(DEFAULT_POLICY.attachedPollMs);
    t.setAlive(false);
    await t.clock.advance(DEFAULT_POLICY.attachedPollMs);
    expect(t.spawner.calls).toHaveLength(1);
  });

  it('a throwing probe counts as a miss; stop() ends the polling', async () => {
    const t = setup({
      probe: async () => {
        throw new Error('ECONNREFUSED');
      },
    });
    t.supervisor.start();
    t.spawner.last().child.ready(readyLine({ mode: 'attached' }));
    await settle();
    t.spawner.last().child.exit(0);
    await settle();
    await t.clock.advance(DEFAULT_POLICY.attachedPollMs * 2);
    expect(t.spawner.calls).toHaveLength(2);

    const u = await attached();
    await u.t.supervisor.stop();
    u.t.setAlive(false);
    await u.t.clock.advance(DEFAULT_POLICY.attachedPollMs * 5);
    expect(u.t.probes).toEqual([]);
    expect(u.t.spawner.calls).toHaveLength(1);
  });
});

describe('BackendSupervisor: the WSL backend (wsl.exe child, stdout ready frame, #22)', () => {
  const NONCE = 'wsl_nonce_0123456789abcdefghij';

  function wsl(over: Partial<BackendOptions> = {}) {
    const spawner = fakeWslSpawn();
    const t = setup({
      spawn: spawner.spawn,
      command: 'wsl.exe',
      args: ['-d', 'Ubuntu', '--exec', '/usr/bin/env', 'PATH=/usr/bin', '/usr/bin/octopus-diff'],
      env: { PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' },
      runAsNode: false,
      ready: { kind: 'stdout', nonce: NONCE },
      wrapper: true,
      loopbackOnly: true,
      outputFd: 7,
      ...over,
    });
    return { ...t, wsl: spawner };
  }

  it('spawns wsl.exe with three pipes-or-fds (no fd 3), stdout a pipe, no ELECTRON_RUN_AS_NODE', () => {
    const t = wsl();
    t.supervisor.start();
    const call = t.wsl.last();
    expect(call.command).toBe('wsl.exe');
    expect(call.options.stdio).toEqual(['pipe', 'pipe', 7]);
    expect(call.options.env).toEqual({ PATH: 'C:\\Windows\\System32', SystemRoot: 'C:\\Windows' });
    expect(call.options.env).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(backendStdio(7, 'stdout')).toEqual(['pipe', 'pipe', 7]);
    expect(backendStdio(null, 'stdout')).toEqual(['pipe', 'pipe', 'pipe']);
  });

  it('reads the frame from stdout; the banner goes to the log, the frame (token) never does', async () => {
    const t = wsl();
    t.supervisor.start();
    t.wsl.last().child.frame(NONCE, readyLine());
    await settle();
    expect(t.supervisor.state).toMatchObject({
      kind: 'ready',
      ready: { mode: 'started', url: 'http://127.0.0.1:7428' },
    });
    expect(t.output.join('')).toContain('octopus-diff is running');
    expect(t.allLogs()).not.toContain(TOKEN);
    expect(t.supervisor.ownsDaemon).toBe(true);
  });

  it('a frame with another nonce is ignored (noted without its text); the real one counts', async () => {
    const t = wsl();
    t.supervisor.start();
    const child = t.wsl.last().child;
    child.frame(
      'someone_else_0123456789abcd',
      readyLine({ url: 'http://127.0.0.1:1', authUrl: `http://127.0.0.1:1/#token=${TOKEN}` }),
    );
    await settle();
    expect(t.supervisor.state.kind).toBe('starting');
    expect(t.notes.join('\n')).toContain("not this run's");
    child.frame(NONCE, readyLine());
    await settle();
    expect(t.supervisor.state).toMatchObject({
      kind: 'ready',
      ready: { url: 'http://127.0.0.1:7428' },
    });
    expect(t.allLogs()).not.toContain(TOKEN);
  });

  it('refuses a ready line that is not on loopback (closes stdin first, then signals wsl.exe)', async () => {
    const t = wsl();
    t.supervisor.start();
    const child = t.wsl.last().child;
    child.frame(
      NONCE,
      readyLine({
        url: 'http://192.168.1.5:7428',
        authUrl: `http://192.168.1.5:7428/#token=${TOKEN}`,
      }),
    );
    await settle();
    expect(child.stdinEnded).toBe(true);
    expect(child.linuxAlive).toBe(false);
    expect(t.supervisor.state).toMatchObject({
      kind: 'restarting',
      reason: 'the daemon is not on a loopback address',
    });
    expect(isLoopbackReady({ url: 'http://localhost:1', authUrl: 'http://localhost:1/#t' })).toBe(
      true,
    );
    expect(isLoopbackReady({ url: 'http://[::1]:1', authUrl: 'http://[::1]:1/#t' })).toBe(true);
    expect(isLoopbackReady({ url: 'http://127.0.0.1:1', authUrl: 'http://127.0.0.1:2/#t' })).toBe(
      false,
    );
    expect(isLoopbackReady({ url: 'http://0.0.0.0:1', authUrl: 'http://0.0.0.0:1/#t' })).toBe(
      false,
    );
    expect(isLoopbackReady({ url: 'file:///x', authUrl: 'file:///x' })).toBe(false);
  });

  it('quit: closing stdin stops the Linux daemon; wsl.exe then exits and is never signalled', async () => {
    const t = wsl();
    t.supervisor.start();
    const child = t.wsl.last().child;
    child.frame(NONCE, readyLine());
    await settle();
    const stopped = t.supervisor.stop();
    await settle();
    await stopped;
    expect(child.linuxAlive).toBe(false);
    expect(child.kills).toEqual([]);
    expect(t.supervisor.state.kind).toBe('stopped');
  });

  it('no ready frame in time: stdin closed first and the daemon gets stopGraceMs before wsl.exe is killed', async () => {
    const t = wsl();
    t.supervisor.start();
    const child = t.wsl.last().child;
    // A Linux process that ignores EOF for now (stuck starting): only the escalation is left.
    child.ignoresEof = true;
    await t.clock.advance(DEFAULT_POLICY.readyTimeoutMs);
    expect(child.stdinEnded).toBe(true);
    expect(child.kills).toEqual([]);
    await t.clock.advance(DEFAULT_POLICY.stopGraceMs);
    expect(child.kills).toEqual(['SIGTERM']);
  });

  it('no ready frame in time, the usual case: the EOF alone stops the daemon, no kill at all', async () => {
    const t = wsl();
    t.supervisor.start();
    const child = t.wsl.last().child;
    await t.clock.advance(DEFAULT_POLICY.readyTimeoutMs);
    await settle();
    expect(child.linuxAlive).toBe(false);
    expect(child.kills).toEqual([]);
    expect(t.supervisor.state).toMatchObject({ kind: 'restarting' });
    await t.clock.advance(DEFAULT_POLICY.stopGraceMs + DEFAULT_POLICY.killGraceMs);
    expect(child.kills).toEqual([]);
  });

  it('stop() escalation on a stuck daemon: SIGTERM to wsl.exe only after the grace; stdin was closed first', async () => {
    const t = wsl();
    t.supervisor.start();
    const child = t.wsl.last().child;
    child.frame(NONCE, readyLine());
    await settle();
    child.ignoresEof = true;
    const stopped = t.supervisor.stop();
    await settle();
    expect(child.stdinEnded).toBe(true);
    expect(child.kills).toEqual([]);
    await t.clock.advance(DEFAULT_POLICY.stopGraceMs);
    expect(child.kills).toEqual(['SIGTERM']);
    await stopped;
  });

  it('wsl.exe exiting before stdout is drained still hands over the frame (attach run)', async () => {
    const t = wsl();
    t.supervisor.start();
    const child = t.wsl.last().child;
    child.frame(NONCE, readyLine({ mode: 'attached' }));
    child.exit(0);
    await settle();
    expect(t.supervisor.state).toMatchObject({ kind: 'ready', ready: { mode: 'attached' } });
    expect(t.supervisor.ownsDaemon).toBe(false);
  });

  it('an over-long frame fails the attempt (never logged)', async () => {
    const t = wsl();
    t.supervisor.start();
    const child = t.wsl.last().child;
    child.stdout.write(`\n\u001eoctopus-diff-ready ${NONCE} ${'x'.repeat(20_000)}`);
    await settle();
    expect(t.supervisor.state).toMatchObject({
      kind: 'restarting',
      reason: 'the ready line is too long',
    });
    expect(t.output.join('')).not.toContain('xxxx');
  });

  it('wsl.exe that exits with nothing (distro gone): a failure, retried with backoff', async () => {
    const t = wsl();
    t.supervisor.start();
    t.wsl.last().child.exit(255);
    await settle();
    expect(t.supervisor.state).toMatchObject({
      kind: 'restarting',
      reason: 'the backend exited with code 255 before it was ready',
    });
    await t.clock.advance(DEFAULT_POLICY.backoffMs[0] ?? 0);
    expect(t.wsl.calls).toHaveLength(2);
  });
});
