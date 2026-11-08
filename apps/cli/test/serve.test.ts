import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { formatBanner } from '../src/commands/serve.js';
import { readRuntimeInfo, runtimeFilePath, writeRuntimeInfo } from '../src/runtime.js';
import {
  clientFactory,
  fakeDaemon,
  healthBody,
  healthFor,
  isHealth,
  makeDeps,
  makeTempDirs,
  shutdownSignal,
  type TempDirs,
  writeConfig,
} from './helpers.js';

let dirs: TempDirs;
let webDir: string;
beforeEach(async () => {
  dirs = await makeTempDirs();
  webDir = path.join(dirs.root, 'web-dist');
  await mkdir(webDir);
  await writeFile(path.join(webDir, 'index.html'), '<!doctype html>');
});
afterEach(async () => {
  await dirs.cleanup();
});

describe('serve', () => {
  it('starts the daemon with merged options, prints the auth URL and shuts down cleanly', async () => {
    await writeConfig(dirs, { projects: ['/repos/a'], watch: { debounceMs: 200 } });
    const daemon = fakeDaemon();
    const shutdown = shutdownSignal();
    const deps = makeDeps(dirs, {
      loadStartDaemon: async () => daemon.startDaemon,
      waitForShutdown: shutdown.wait,
    });
    let runtimeWhileRunning: unknown;
    const done = run(['serve', '--port', '0', '--scan', 'code', 'repo'], deps, {
      serve: {
        webRootCandidates: [path.join(dirs.root, 'missing'), webDir],
        onReady: () => {
          void readRuntimeInfo(dirs.stateDir).then((info) => {
            runtimeWhileRunning = info;
            shutdown.trigger('SIGINT');
          });
        },
      },
    });
    expect(await done).toBe(0);

    expect(daemon.calls).toHaveLength(1);
    const options = daemon.calls[0];
    expect(options).toMatchObject({
      host: '127.0.0.1',
      port: 0,
      stateDir: dirs.stateDir,
      configDir: dirs.configDir,
      webRoot: webDir,
      projects: ['/repos/a', path.join(dirs.cwd, 'repo')],
      scanRoots: [{ path: path.join(dirs.cwd, 'code') }],
      watch: { debounceMs: 200 },
      logLevel: 'info',
    });
    expect(options?.logger).toBeDefined();

    expect(deps.out.text).toContain('Open:   http://127.0.0.1:45678/#token=tok123');
    expect(deps.out.text).not.toContain('LAN:');
    expect(deps.out.text).toContain('Press Ctrl+C to stop.');
    expect(deps.err.text).toContain('received SIGINT, shutting down');
    expect(daemon.closed).toBe(1);
    expect(deps.opened).toEqual([]);

    expect(runtimeWhileRunning).toMatchObject({
      pid: deps.pid,
      url: 'http://127.0.0.1:45678',
      port: 45_678,
    });
    // Removed on shutdown.
    await expect(stat(runtimeFilePath(dirs.stateDir))).rejects.toThrow();
  });

  it('writes the runtime file with mode 0600', async () => {
    const daemon = fakeDaemon();
    const shutdown = shutdownSignal();
    let mode = 0;
    const deps = makeDeps(dirs, {
      loadStartDaemon: async () => daemon.startDaemon,
      waitForShutdown: shutdown.wait,
    });
    await run(['serve'], deps, {
      serve: {
        webRootCandidates: [webDir],
        onReady: () => {
          void stat(runtimeFilePath(dirs.stateDir)).then((s) => {
            mode = s.mode & 0o777;
            shutdown.trigger();
          });
        },
      },
    });
    expect(mode).toBe(0o600);
  });

  it('opens the browser with --open (and only then)', async () => {
    const daemon = fakeDaemon();
    const deps = makeDeps(dirs, { loadStartDaemon: async () => daemon.startDaemon });
    expect(await run(['serve', '--open'], deps, { serve: { webRootCandidates: [webDir] } })).toBe(
      0,
    );
    expect(deps.opened).toEqual(['http://127.0.0.1:7428/#token=tok123']);
  });

  it('keeps running when the browser cannot be opened', async () => {
    const deps = makeDeps(dirs, {
      loadStartDaemon: async () => fakeDaemon().startDaemon,
      openUrl: async () => {
        throw new Error('could not open a browser');
      },
    });
    expect(await run(['serve', '-o'], deps, { serve: { webRootCandidates: [webDir] } })).toBe(0);
    expect(deps.err.text).toContain('warning: could not open a browser');
  });

  it('explains a port that is already in use', async () => {
    const inUse = Object.assign(
      new Error('listen EADDRINUSE: address already in use 127.0.0.1:7428'),
      {
        code: 'EADDRINUSE',
      },
    );
    const daemon = fakeDaemon({ fail: new Error('server failed', { cause: inUse }) });
    const deps = makeDeps(dirs, { loadStartDaemon: async () => daemon.startDaemon });
    expect(await run(['serve'], deps, { serve: { webRootCandidates: [webDir] } })).toBe(1);
    expect(deps.err.text).toContain('port 7428 on 127.0.0.1 is already in use');
    expect(deps.err.text).toContain('--port 0');
  });

  it('says when the busy port belongs to another octopus-diff daemon', async () => {
    const inUse = Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' });
    const api = clientFactory((req) =>
      req.url === 'http://127.0.0.1:7428/api/health' ? { body: healthBody() } : undefined,
    );
    const deps = makeDeps(dirs, {
      loadStartDaemon: async () => fakeDaemon({ fail: inUse }).startDaemon,
      createApiClient: api.createApiClient,
    });
    expect(await run(['serve'], deps, { serve: { webRootCandidates: [webDir] } })).toBe(1);
    expect(deps.err.text).toContain('already in use by another octopus-diff daemon (9.9.9');
  });

  it('registers for signals before starting, so an early Ctrl+C still closes the daemon', async () => {
    const order: string[] = [];
    const daemon = fakeDaemon();
    const deps = makeDeps(dirs, {
      loadStartDaemon: async () => async (options) => {
        order.push('start');
        return daemon.startDaemon(options);
      },
      waitForShutdown: () => {
        order.push('listen');
        return Promise.resolve('SIGINT');
      },
    });
    expect(await run(['serve'], deps, { serve: { webRootCandidates: [webDir] } })).toBe(0);
    expect(order).toEqual(['listen', 'start']);
    expect(daemon.closed).toBe(1);
  });

  it('reports other startup failures', async () => {
    const daemon = fakeDaemon({ fail: new Error('daemon is a placeholder until WS2 lands') });
    const deps = makeDeps(dirs, { loadStartDaemon: async () => daemon.startDaemon });
    expect(await run(['serve'], deps, { serve: { webRootCandidates: [webDir] } })).toBe(1);
    expect(deps.err.text).toContain('failed to start the daemon: daemon is a placeholder');
  });

  it('serves the API only (with a warning) when no web build is found', async () => {
    const daemon = fakeDaemon();
    const deps = makeDeps(dirs, { loadStartDaemon: async () => daemon.startDaemon });
    expect(
      await run(['serve'], deps, { serve: { webRootCandidates: [path.join(dirs.root, 'nope')] } }),
    ).toBe(0);
    expect(daemon.calls[0]?.webRoot).toBeNull();
    expect(deps.err.text).toContain('built web UI not found');
    expect(deps.out.text).toContain('API only');
  });

  it('fails for an explicit --web-root without index.html', async () => {
    const daemon = fakeDaemon();
    const deps = makeDeps(dirs, { loadStartDaemon: async () => daemon.startDaemon });
    expect(await run(['serve', '--web-root', dirs.root], deps)).toBe(2);
    expect(deps.err.text).toContain('has no index.html');
    expect(daemon.calls).toHaveLength(0);
  });

  it('uses an explicit --web-root', async () => {
    const daemon = fakeDaemon();
    const deps = makeDeps(dirs, { loadStartDaemon: async () => daemon.startDaemon });
    expect(await run(['serve', '--web-root', webDir], deps)).toBe(0);
    expect(daemon.calls[0]?.webRoot).toBe(webDir);
  });

  it('refuses a non-loopback host without the flag and never starts the daemon', async () => {
    const daemon = fakeDaemon();
    const deps = makeDeps(dirs, { loadStartDaemon: async () => daemon.startDaemon });
    expect(await run(['serve', '--host', '0.0.0.0'], deps)).toBe(2);
    expect(daemon.calls).toHaveLength(0);
    expect(deps.err.text).toContain('--allow-non-loopback');
  });

  it('reports an invalid config file with exit code 2', async () => {
    await writeConfig(dirs, { port: 'nope' });
    const deps = makeDeps(dirs);
    expect(await run(['serve'], deps)).toBe(2);
    expect(deps.err.text).toContain('invalid config file');
  });

  it('exits 1 when the daemon does not close in time', async () => {
    const daemon = fakeDaemon({ closeDelayMs: 500 });
    const deps = makeDeps(dirs, {
      loadStartDaemon: async () => daemon.startDaemon,
      shutdownTimeoutMs: 20,
    });
    expect(await run(['serve'], deps, { serve: { webRootCandidates: [webDir] } })).toBe(1);
    expect(deps.err.text).toContain('shutdown did not finish within 20 ms');
  });

  it('exits 1 when close() fails', async () => {
    const daemon = fakeDaemon({ closeError: new Error('sqlite busy') });
    const deps = makeDeps(dirs, { loadStartDaemon: async () => daemon.startDaemon });
    expect(await run(['serve'], deps, { serve: { webRootCandidates: [webDir] } })).toBe(1);
    expect(deps.err.text).toContain('error while shutting down: sqlite busy');
  });

  it('does not start a second daemon for the same state dir', async () => {
    await writeRuntimeInfo(dirs.stateDir, {
      pid: 777,
      url: 'http://127.0.0.1:5555',
      host: '127.0.0.1',
      port: 5555,
      version: '0.0.0',
      startedAt: '2026-11-08T00:00:00.000Z',
    });
    await writeFile(path.join(dirs.stateDir, 'token'), 'existing-token\n', { mode: 0o600 });
    const api = clientFactory((req) =>
      isHealth(req.url, 'http://127.0.0.1:5555')
        ? { body: healthFor(req.url, 'existing-token') }
        : undefined,
    );
    const daemon = fakeDaemon();
    const deps = makeDeps(dirs, {
      loadStartDaemon: async () => daemon.startDaemon,
      createApiClient: api.createApiClient,
      isProcessAlive: (pid) => pid === 777,
    });
    expect(await run(['serve', '--open'], deps)).toBe(0);
    expect(daemon.calls).toHaveLength(0);
    expect(deps.out.text).toContain('already running (pid 777)');
    expect(deps.out.text).toContain('http://127.0.0.1:5555/#token=existing-token');
    expect(deps.opened).toEqual(['http://127.0.0.1:5555/#token=existing-token']);
    expect(api.requests.every((r) => r.authorization === null)).toBe(true);
  });

  it('SEC-02: no URL and no second daemon for a recorded daemon that cannot prove the token', async () => {
    await writeRuntimeInfo(dirs.stateDir, {
      pid: 777,
      url: 'http://127.0.0.1:5555',
      host: '127.0.0.1',
      port: 5555,
      version: '0.0.0',
      startedAt: '2026-11-08T00:00:00.000Z',
    });
    await writeFile(path.join(dirs.stateDir, 'token'), 'existing-token\n', { mode: 0o600 });
    // A squatter on the recorded port after a crash, with the pid reused by one of our processes.
    const api = clientFactory((req) =>
      isHealth(req.url) ? { body: healthBody({ proof: '0'.repeat(64) }) } : undefined,
    );
    const daemon = fakeDaemon();
    const deps = makeDeps(dirs, {
      loadStartDaemon: async () => daemon.startDaemon,
      createApiClient: api.createApiClient,
      isProcessAlive: (pid) => pid === 777,
    });
    expect(await run(['serve', '--open'], deps, { serve: { webRootCandidates: [webDir] } })).toBe(
      1,
    );
    expect(deps.err.text).toContain('did not prove that it holds');
    expect(deps.err.text).toContain('The token was not sent');
    expect(deps.out.text).toBe('');
    expect(deps.err.text).not.toContain('existing-token');
    expect(deps.opened).toEqual([]);
    // One daemon per state dir: no second daemon either.
    expect(daemon.calls).toHaveLength(0);
    for (const r of api.requests) {
      expect(r.authorization).toBeNull();
      expect(r.url).not.toContain('existing-token');
    }
  });

  it('prints the loopback URL and one URL per LAN address for a wildcard bind', async () => {
    const daemon = fakeDaemon();
    const deps = makeDeps(dirs, {
      loadStartDaemon: async () => daemon.startDaemon,
      networkInterfaces: () => ({
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
        eth0: [
          { address: '192.168.1.5', family: 'IPv4', internal: false } as never,
          { address: '2001:db8::5', family: 'IPv6', internal: false } as never,
          { address: 'fe80::1', family: 'IPv6', internal: false } as never,
        ],
      }),
    });
    const args = ['serve', '--host', '0.0.0.0', '--allow-non-loopback', '--open'];
    expect(await run(args, deps, { serve: { webRootCandidates: [webDir] } })).toBe(0);
    expect(deps.out.text).toContain('Open:   http://0.0.0.0:7428/#token=tok123');
    expect(deps.out.text).toContain('LAN:    http://192.168.1.5:7428/#token=tok123');
    expect(deps.out.text).not.toContain('2001:db8');
    expect(deps.out.text).toContain('plain HTTP');
    expect(deps.opened).toEqual(['http://0.0.0.0:7428/#token=tok123']);

    const dual = makeDeps(dirs, {
      loadStartDaemon: async () => fakeDaemon().startDaemon,
      networkInterfaces: deps.networkInterfaces,
    });
    await run(['serve', '--host', '::', '--allow-non-loopback'], dual, {
      serve: { webRootCandidates: [webDir] },
    });
    expect(dual.out.text).toContain('LAN:    http://192.168.1.5:7428/#token=tok123');
    expect(dual.out.text).toContain('LAN:    http://[2001:db8::5]:7428/#token=tok123');
    expect(dual.out.text).not.toContain('fe80');
  });

  it('passes the state dir to the opener (for the private launcher file)', async () => {
    const calls: string[][] = [];
    const deps = makeDeps(dirs, {
      loadStartDaemon: async () => fakeDaemon().startDaemon,
      openUrl: async (url, _wsl, stateDir) => {
        calls.push([url, stateDir]);
        return 'fake';
      },
    });
    await run(['serve', '--open'], deps, { serve: { webRootCandidates: [webDir] } });
    expect(calls).toEqual([['http://127.0.0.1:7428/#token=tok123', dirs.stateDir]]);
  });

  it('ignores a stale runtime file whose process is gone', async () => {
    await writeRuntimeInfo(dirs.stateDir, {
      pid: 777,
      url: 'http://127.0.0.1:5555',
      host: '127.0.0.1',
      port: 5555,
      version: '0.0.0',
      startedAt: '2026-11-08T00:00:00.000Z',
    });
    const daemon = fakeDaemon();
    const deps = makeDeps(dirs, { loadStartDaemon: async () => daemon.startDaemon });
    expect(await run(['serve'], deps, { serve: { webRootCandidates: [webDir] } })).toBe(0);
    expect(daemon.calls).toHaveLength(1);
  });

  it('warns about repositories on Windows drives under WSL', async () => {
    const daemon = fakeDaemon();
    const deps = makeDeps(dirs, {
      loadStartDaemon: async () => daemon.startDaemon,
      env: { HOME: dirs.home, WSL_DISTRO_NAME: 'Ubuntu' },
    });
    expect(
      await run(['serve', '/mnt/c/Users/me/repo'], deps, {
        serve: { webRootCandidates: [webDir] },
      }),
    ).toBe(0);
    expect(deps.err.text).toContain('/mnt/c/Users/me/repo is on a Windows drive');
    const quiet = makeDeps(dirs, {
      loadStartDaemon: async () => fakeDaemon().startDaemon,
      env: { HOME: dirs.home, WSL_DISTRO_NAME: 'Ubuntu' },
    });
    await run(['serve', '--poll', '/mnt/c/Users/me/repo'], quiet, {
      serve: { webRootCandidates: [webDir] },
    });
    expect(quiet.err.text).not.toContain('Windows drive');
  });
});

describe('formatBanner', () => {
  it('shows the auth URL, API URL and state dir', () => {
    const text = formatBanner(
      {
        url: 'http://127.0.0.1:7428',
        authUrl: 'http://127.0.0.1:7428/#token=abc',
        token: 'abc',
        host: '127.0.0.1',
        port: 7428,
        stateDir: '/home/me/.local/state/octopus-diff',
        configDir: '/home/me/.config/octopus-diff',
        close: async () => {},
      },
      '1.0.0',
      '/home/me',
      null,
    );
    expect(text).toContain('octopus-diff 1.0.0 is running');
    expect(text).toContain('Open:   http://127.0.0.1:7428/#token=abc');
    expect(text).toContain('State:  ~/.local/state/octopus-diff');
    expect(text).toContain('API only');
  });
});
