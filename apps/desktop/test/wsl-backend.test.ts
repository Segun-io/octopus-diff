/** #22: the WSL preflight (list, probe, the serve command) over a fake `wsl.exe`. */
import { describe, expect, it } from 'vitest';
import { WSL_PROBE_SCRIPT } from '../src/wsl.js';
import { listWslDistros, prepareWslBackend, type RunWsl } from '../src/wsl-backend.js';

const utf16 = (text: string) => Buffer.from(text, 'utf16le');
const LIST = utf16(
  [
    '  NAME              STATE           VERSION',
    '* Ubuntu            Running         2',
    '  docker-desktop    Stopped         2',
    '  My Distro         Stopped         2',
    '',
  ].join('\r\n'),
);
const RS = '\u001e';
const answers = (over: Record<string, string | null> = {}) => {
  const base: Record<string, string | null> = {
    path: '/home/u/.nvm/versions/node/v24.1.0/bin:/usr/bin:/bin',
    home: '/home/u',
    env: '/usr/bin/env',
    cli: '/home/u/.nvm/versions/node/v24.1.0/bin/octopus-diff',
    node: 'v24.1.0',
    git: 'git version 2.43.0',
    cliVersion: '0.1.0',
    readyStdout: '1',
    ...over,
  };
  return Buffer.from(
    `${Object.entries(base)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${RS}od:${k}=${v}`)
      .join('\n')}\n${RS}od:end=1\n`,
  );
};

interface Call {
  args: readonly string[];
  input: string | undefined;
  timeoutMs: number;
}

function fakeRun(script: (args: readonly string[]) => Awaited<ReturnType<RunWsl>>) {
  const calls: Call[] = [];
  const run: RunWsl = async (args, options) => {
    calls.push({ args, input: options.input, timeoutMs: options.timeoutMs });
    return script(args);
  };
  return { run, calls };
}

const ok = (stdout: Buffer) => ({ code: 0, stdout, stderr: Buffer.alloc(0) });
const NONCE = 'preflight_nonce_0123456789abc';
const base = { distro: 'Ubuntu', port: null, minNode: 24, minGit: '2.31' };

describe('listWslDistros', () => {
  it('runs wsl.exe --list --verbose and parses it', async () => {
    const f = fakeRun(() => ok(LIST));
    const r = await listWslDistros(f.run);
    expect(f.calls[0]?.args).toEqual(['--list', '--verbose']);
    expect(r).toMatchObject({ ok: true });
    if (r.ok)
      expect(r.distros.map((d) => d.name)).toEqual(['Ubuntu', 'docker-desktop', 'My Distro']);
  });

  it('wsl.exe missing, failing or listing nothing: a reason', async () => {
    const missing = await listWslDistros(
      fakeRun(() => ({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        error: 'missing',
      })).run,
    );
    expect(missing).toEqual({ ok: false, reason: expect.stringMatching(/WSL is not installed/) });
    const none = await listWslDistros(
      fakeRun(() => ({
        code: 4294967295,
        stdout: utf16('Windows Subsystem for Linux has no installed distributions.\r\n'),
        stderr: Buffer.alloc(0),
      })).run,
    );
    expect(none).toEqual({ ok: false, reason: expect.stringMatching(/no distros/) });
    const timeout = await listWslDistros(
      fakeRun(() => ({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        error: 'timeout',
      })).run,
    );
    expect(timeout).toEqual({ ok: false, reason: expect.stringMatching(/did not answer/) });
  });
});

describe('prepareWslBackend', () => {
  it('all there: the serve command for wsl.exe, after one list and one probe (script on stdin)', async () => {
    const f = fakeRun((args) => (args[0] === '--list' ? ok(LIST) : ok(answers())));
    const r = await prepareWslBackend({ ...base, run: f.run });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]?.args).toEqual(['-d', 'Ubuntu', '--cd', '~', '--exec', '/bin/sh', '-s']);
    expect(f.calls[1]?.input).toBe(WSL_PROBE_SCRIPT);
    expect(r.ok && r.argsFor(NONCE)).toEqual([
      '-d',
      'Ubuntu',
      '--cd',
      '~',
      '--exec',
      '/usr/bin/env',
      'PATH=/home/u/.nvm/versions/node/v24.1.0/bin:/usr/bin:/bin',
      '/home/u/.nvm/versions/node/v24.1.0/bin/octopus-diff',
      'serve',
      `--ready-stdout=${NONCE}`,
      '--exit-with-stdin',
      '--no-open',
      '--host',
      '127.0.0.1',
    ]);
    expect(r).toMatchObject({
      ok: true,
      distro: 'Ubuntu',
      command: 'wsl.exe',
      cliVersion: '0.1.0',
    });
    // One preflight, a command line per attempt: each with its own nonce.
    expect(r.ok && r.argsFor('another_nonce_0123456789abc')).toContain(
      '--ready-stdout=another_nonce_0123456789abc',
    );
  });

  it('a distro with a space in its name is passed as one argument', async () => {
    const f = fakeRun((args) => (args[0] === '--list' ? ok(LIST) : ok(answers())));
    const r = await prepareWslBackend({ ...base, distro: 'My Distro', run: f.run });
    expect(f.calls[1]?.args.slice(0, 2)).toEqual(['-d', 'My Distro']);
    expect(r.ok && r.argsFor(NONCE).slice(0, 2)).toEqual(['-d', 'My Distro']);
  });

  it('a distro that is not listed, a system distro or a hostile name: refused before any probe', async () => {
    for (const distro of ['Gone', 'docker-desktop', '--exec', 'a"b']) {
      const f = fakeRun(() => ok(LIST));
      const r = await prepareWslBackend({ ...base, distro, run: f.run });
      expect(r, distro).toMatchObject({ ok: false, kind: 'no-distro' });
      expect(
        f.calls.every((c) => c.args[0] === '--list'),
        distro,
      ).toBe(true);
    }
  });

  it('missing prerequisites: the problems, nothing started', async () => {
    const f = fakeRun((args) =>
      args[0] === '--list'
        ? ok(LIST)
        : ok(answers({ cli: null, node: 'v20.0.0', readyStdout: null })),
    );
    const r = await prepareWslBackend({ ...base, run: f.run });
    expect(r).toMatchObject({ ok: false, kind: 'prerequisites' });
    if (!r.ok) expect(r.problems?.map((p) => p.kind)).toEqual(['cli-missing', 'node-old']);
  });

  it('only an old Node (the CLI is there): still prerequisites, no serve command', async () => {
    const f = fakeRun((args) =>
      args[0] === '--list' ? ok(LIST) : ok(answers({ node: 'v22.11.0' })),
    );
    const r = await prepareWslBackend({ ...base, run: f.run });
    expect(r).toMatchObject({ ok: false, kind: 'prerequisites' });
    if (!r.ok) expect(r.problems?.map((p) => p.kind)).toEqual(['node-old']);
    expect(f.calls).toHaveLength(2);
  });

  it('a probe that does not finish, times out or cannot start: probe-failed with a clean reason', async () => {
    const cut = fakeRun((args) =>
      args[0] === '--list'
        ? ok(LIST)
        : { code: 1, stdout: Buffer.from('half'), stderr: Buffer.from('sh: 1: \u001b[31mboom\n') },
    );
    const r = await prepareWslBackend({ ...base, run: cut.run });
    expect(r).toMatchObject({ ok: false, kind: 'probe-failed' });
    if (!r.ok) {
      expect(r.reason).toContain('boom');
      expect(r.reason).not.toContain('\u001b');
    }
    const slow = fakeRun((args) =>
      args[0] === '--list'
        ? ok(LIST)
        : { code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), error: 'timeout' },
    );
    expect(await prepareWslBackend({ ...base, run: slow.run })).toMatchObject({
      ok: false,
      kind: 'probe-failed',
      reason: expect.stringMatching(/did not answer/),
    });
  });

  it('no WSL at all: no-wsl', async () => {
    const f = fakeRun(() => ({
      code: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      error: 'missing',
    }));
    expect(await prepareWslBackend({ ...base, run: f.run })).toMatchObject({
      ok: false,
      kind: 'no-wsl',
    });
  });

  it('passes --port on', async () => {
    const f = fakeRun((args) => (args[0] === '--list' ? ok(LIST) : ok(answers())));
    const r = await prepareWslBackend({ ...base, port: 0, run: f.run });
    expect(r.ok && r.argsFor(NONCE).slice(-2)).toEqual(['--port', '0']);
  });
});
