/**
 * `serve` → `add` → `status` over real HTTP on an ephemeral loopback port, using a tiny stub
 * daemon (node:http) in place of `@octopus-diff/daemon`. This exercises the real API client,
 * runtime-file discovery, token file and process-liveness checks without the real daemon.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import type { DaemonHandle, StartDaemon } from '@octopus-diff/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { type CliDeps, defaultDeps } from '../src/deps.js';
import {
  Capture,
  healthBody,
  makeTempDirs,
  projectItem,
  shutdownSignal,
  type TempDirs,
} from './helpers.js';

async function readBody(req: IncomingMessage): Promise<unknown> {
  let text = '';
  for await (const chunk of req) text += String(chunk);
  return text === '' ? undefined : JSON.parse(text);
}

/** Minimal daemon: token file (0600), unauthenticated /api/health, bearer-protected POST /api/projects. */
const stubDaemon: StartDaemon = async (options = {}) => {
  const stateDir = options.stateDir ?? '';
  const token = randomBytes(16).toString('hex');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(stateDir, 'token'), `${token}\n`, { mode: 0o600 });
  const added: string[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/api/health') return send(200, healthBody());
      if (req.headers.authorization !== `Bearer ${token}`) {
        return send(401, { error: { code: 'unauthorized', message: 'missing token' } });
      }
      if (req.method === 'POST' && req.url === '/api/projects') {
        const { path: p } = (await readBody(req)) as { path: string };
        const created = !added.includes(p);
        added.push(p);
        return send(200, { project: projectItem(p), created });
      }
      if (req.method === 'GET' && req.url === '/api/projects') {
        return send(200, { projects: [...new Set(added)].map((p) => projectItem(p)) });
      }
      return send(404, { error: { code: 'not_found', message: 'no route' } });
    })();
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, options.host, resolve));
  const { port } = server.address() as AddressInfo;
  const host = options.host ?? '127.0.0.1';
  const url = `http://${host}:${port}`;
  const handle: DaemonHandle = {
    url,
    authUrl: `${url}/?token=${token}`,
    token,
    host,
    port,
    stateDir,
    configDir: options.configDir ?? '',
    close: () => new Promise((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
  return handle;
};

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(async () => {
  await dirs.cleanup();
});

function liveDeps(overrides: Partial<CliDeps>): CliDeps & { out: Capture; err: Capture } {
  const out = new Capture();
  const err = new Capture();
  return {
    ...defaultDeps(),
    env: { HOME: dirs.home },
    cwd: dirs.cwd,
    stdout: out,
    stderr: err,
    openUrl: async () => {
      throw new Error('tests must not open a browser');
    },
    loadStartDaemon: async () => stubDaemon,
    ...overrides,
    out,
    err,
  };
}

describe('serve + add + status over real HTTP', () => {
  it('finds the daemon on its ephemeral port and registers a repository', async () => {
    const repo = path.join(dirs.cwd, 'my-repo');
    await mkdir(repo);
    const shutdown = shutdownSignal();
    const serveDeps = liveDeps({ waitForShutdown: shutdown.wait });

    let addCode = -1;
    let addAgainCode = -1;
    let statusCode = -1;
    const addDeps = liveDeps({});
    const addAgainDeps = liveDeps({});
    const statusDeps = liveDeps({});

    let daemonPort = 0;
    const webRoot = path.join(dirs.root, 'web');
    await mkdir(webRoot);
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html>');
    const code = await run(['serve', '--port', '0', '--web-root', webRoot], serveDeps, {
      serve: {
        onReady: (handle) => {
          daemonPort = handle.port;
          void (async () => {
            try {
              addCode = await run(['add', 'my-repo'], addDeps);
              addAgainCode = await run(['add', repo], addAgainDeps);
              statusCode = await run(['status'], statusDeps);
            } finally {
              shutdown.trigger('SIGTERM');
            }
          })();
        },
      },
    });

    expect(serveDeps.err.text).toContain('received SIGTERM');
    expect(code).toBe(0);
    expect(addDeps.err.text).toBe('');
    expect(addCode).toBe(0);
    expect(addDeps.out.text).toContain(`added: my-repo (1 worktree)`);
    expect(addAgainCode).toBe(0);
    expect(addAgainDeps.out.text).toContain('already added: my-repo');
    expect(statusCode).toBe(0);
    expect(statusDeps.out.text).toMatch(/is running at http:\/\/127\.0\.0\.1:\d+/);
    expect(statusDeps.out.text).toContain('projects:  1 (1 worktrees)');

    // After shutdown the daemon is gone and `add` says so.
    const after = liveDeps({});
    expect(await run(['add', 'my-repo', '--port', String(daemonPort)], after)).toBe(1);
    expect(after.err.text).toContain('no octopus-diff daemon is running');
  });
});
