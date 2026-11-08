import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { writeRuntimeInfo } from '../src/runtime.js';
import {
  clientFactory,
  healthBody,
  makeDeps,
  makeTempDirs,
  projectItem,
  type Route,
  scanRootBody,
  type TempDirs,
} from './helpers.js';

let dirs: TempDirs;
let repo: string;
beforeEach(async () => {
  dirs = await makeTempDirs();
  repo = path.join(dirs.cwd, 'repo');
  await mkdir(repo);
  await mkdir(dirs.stateDir, { recursive: true });
  await writeFile(path.join(dirs.stateDir, 'token'), 'secret-token\n', { mode: 0o600 });
});
afterEach(async () => {
  await dirs.cleanup();
});

const BASE = 'http://127.0.0.1:7428';

function daemonRoutes(base = BASE): Route {
  return (req) => {
    if (req.url === `${base}/api/health`) return { body: healthBody() };
    if (req.authorization !== 'Bearer secret-token') {
      return { status: 401, body: { error: { code: 'unauthorized', message: 'bad token' } } };
    }
    if (req.method === 'POST' && req.url === `${base}/api/projects`) {
      const p = (req.body as { path: string }).path;
      if (p.endsWith('not-a-repo')) {
        return {
          status: 400,
          body: { error: { code: 'not_a_repository', message: `${p} is not a git repository` } },
        };
      }
      return { body: { project: projectItem(p), created: !p.endsWith('again') } };
    }
    if (req.method === 'POST' && req.url === `${base}/api/scan-roots`) {
      const { path: p, depth } = req.body as { path: string; depth: number };
      return { body: { scanRoot: scanRootBody(p, depth), created: true } };
    }
    if (req.method === 'GET' && req.url === `${base}/api/projects`) {
      return { body: { projects: [projectItem('/r/a'), projectItem('/r/b')] } };
    }
    return undefined;
  };
}

describe('add', () => {
  it('registers absolute paths with the bearer token from the state dir', async () => {
    const api = clientFactory(daemonRoutes());
    const deps = makeDeps(dirs, { createApiClient: api.createApiClient });
    expect(await run(['add', 'repo', '--scan', '.', '--depth', '2'], deps)).toBe(0);
    const posts = api.requests.filter((r) => r.method === 'POST');
    expect(posts).toEqual([
      expect.objectContaining({
        url: `${BASE}/api/projects`,
        body: { path: repo },
        authorization: 'Bearer secret-token',
      }),
      expect.objectContaining({
        url: `${BASE}/api/scan-roots`,
        body: { path: dirs.cwd, depth: 2 },
        authorization: 'Bearer secret-token',
      }),
    ]);
    expect(deps.out.text).toContain('added: repo (1 worktree)');
    expect(deps.out.text).toContain('scan root added');
    expect(deps.out.text).toContain('(depth 2)');
  });

  it('uses the default scan depth', async () => {
    const api = clientFactory(daemonRoutes());
    const deps = makeDeps(dirs, { createApiClient: api.createApiClient });
    expect(await run(['add', '--scan', '.'], deps)).toBe(0);
    expect(api.requests.find((r) => r.method === 'POST')?.body).toEqual({
      path: dirs.cwd,
      depth: 3,
    });
  });

  it('finds a daemon on another port through the runtime file', async () => {
    await writeRuntimeInfo(dirs.stateDir, {
      pid: 99,
      url: 'http://127.0.0.1:40001',
      host: '127.0.0.1',
      port: 40_001,
      version: '0',
      startedAt: '2026-11-08T00:00:00.000Z',
    });
    const api = clientFactory(daemonRoutes('http://127.0.0.1:40001'));
    const deps = makeDeps(dirs, {
      createApiClient: api.createApiClient,
      isProcessAlive: () => true,
    });
    expect(await run(['add', 'repo'], deps)).toBe(0);
    expect(api.requests.at(-1)?.url).toBe('http://127.0.0.1:40001/api/projects');
  });

  it('honors --url and --port', async () => {
    const api = clientFactory(daemonRoutes('http://127.0.0.1:9999'));
    const deps = makeDeps(dirs, { createApiClient: api.createApiClient });
    expect(await run(['add', 'repo', '--url', 'http://127.0.0.1:9999/whatever'], deps)).toBe(0);
    expect(await run(['add', 'repo', '--port', '9999'], deps)).toBe(0);
  });

  it('says clearly when no daemon is running', async () => {
    const api = clientFactory(null);
    const deps = makeDeps(dirs, { createApiClient: api.createApiClient });
    expect(await run(['add', 'repo'], deps)).toBe(1);
    expect(deps.err.text).toContain('no octopus-diff daemon is running at http://127.0.0.1:7428');
    expect(deps.err.text).toContain('octopus-diff serve');
  });

  it('detects something that is not octopus-diff', async () => {
    const api = clientFactory(() => ({ body: { hello: 'world' } }));
    const deps = makeDeps(dirs, { createApiClient: api.createApiClient });
    expect(await run(['add', 'repo'], deps)).toBe(1);
    expect(deps.err.text).toContain('not an octopus-diff daemon');
  });

  it('reports missing directories, non-repositories and duplicates, and exits 1 on any error', async () => {
    await mkdir(path.join(dirs.cwd, 'not-a-repo'));
    await mkdir(path.join(dirs.cwd, 'again'));
    const api = clientFactory(daemonRoutes());
    const deps = makeDeps(dirs, { createApiClient: api.createApiClient });
    expect(await run(['add', 'missing', 'not-a-repo', 'again', 'repo'], deps)).toBe(1);
    expect(deps.err.text).toContain('missing: no such directory');
    expect(deps.err.text).toContain('not-a-repo: not a git repository');
    expect(deps.out.text).toContain('already added: again');
    expect(deps.out.text).toContain('added: repo');
  });

  it('explains a token mismatch', async () => {
    await writeFile(path.join(dirs.stateDir, 'token'), 'stale\n');
    const api = clientFactory(daemonRoutes());
    const deps = makeDeps(dirs, { createApiClient: api.createApiClient });
    expect(await run(['add', 'repo'], deps)).toBe(1);
    expect(deps.err.text).toContain('rejected the token');
  });

  it('fails when there is no token file', async () => {
    const api = clientFactory(daemonRoutes());
    const deps = makeDeps(dirs, {
      createApiClient: api.createApiClient,
    });
    expect(await run(['add', 'repo', '--state-dir', path.join(dirs.root, 'empty')], deps)).toBe(1);
    expect(deps.err.text).toContain('no auth token');
  });
});

describe('status', () => {
  it('prints the URL, health and project counts', async () => {
    const api = clientFactory(daemonRoutes());
    const deps = makeDeps(dirs, { createApiClient: api.createApiClient });
    expect(await run(['status'], deps)).toBe(0);
    expect(deps.out.text).toContain('octopus-diff 9.9.9 is running at http://127.0.0.1:7428');
    expect(deps.out.text).toContain('Open:      http://127.0.0.1:7428/?token=secret-token');
    expect(deps.out.text).toContain('projects:  2 (2 worktrees)');
  });

  it('supports --json and --open', async () => {
    const api = clientFactory(daemonRoutes());
    const deps = makeDeps(dirs, { createApiClient: api.createApiClient });
    expect(await run(['status', '--json', '--open'], deps)).toBe(0);
    const json = JSON.parse(deps.out.text) as { authUrl: string; projects: number };
    expect(json).toMatchObject({ authUrl: `${BASE}/?token=secret-token`, projects: 2 });
    expect(deps.opened).toEqual([`${BASE}/?token=secret-token`]);
  });

  it('exits 1 without a daemon', async () => {
    const deps = makeDeps(dirs, { createApiClient: clientFactory(null).createApiClient });
    expect(await run(['status'], deps)).toBe(1);
  });
});
