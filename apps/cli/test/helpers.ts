import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  API_VERSION,
  APP_NAME,
  createApiClient,
  type DaemonHandle,
  type HealthResponse,
  healthProofMessage,
  type ProjectListItem,
  type ScanRoot,
  type StartDaemon,
  type StartDaemonOptions,
} from '@octopus-diff/contracts';
import type { CliDeps } from '../src/deps.js';

export interface TempDirs {
  root: string;
  home: string;
  configDir: string;
  stateDir: string;
  cwd: string;
  cleanup(): Promise<void>;
}

export async function makeTempDirs(): Promise<TempDirs> {
  const root = await mkdtemp(path.join(tmpdir(), 'octopus-diff-'));
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'cwd');
  await mkdir(home, { recursive: true });
  await mkdir(cwd, { recursive: true });
  return {
    root,
    home,
    configDir: path.join(home, '.config', APP_NAME),
    stateDir: path.join(home, '.local', 'state', APP_NAME),
    cwd,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export async function writeConfig(dirs: TempDirs, config: unknown): Promise<string> {
  await mkdir(dirs.configDir, { recursive: true });
  const file = path.join(dirs.configDir, 'config.json');
  await writeFile(file, typeof config === 'string' ? config : JSON.stringify(config));
  return file;
}

export class Capture {
  text = '';
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

/** A controllable shutdown signal. */
export function shutdownSignal(): {
  wait: () => Promise<string>;
  trigger: (signal?: string) => void;
} {
  let resolve!: (signal: string) => void;
  const promise = new Promise<string>((r) => {
    resolve = r;
  });
  return { wait: () => promise, trigger: (signal = 'SIGINT') => resolve(signal) };
}

export interface FakeDaemon {
  startDaemon: StartDaemon;
  calls: StartDaemonOptions[];
  closed: number;
  handle?: DaemonHandle;
}

export function fakeDaemon(
  behavior: { fail?: unknown; closeDelayMs?: number; closeError?: unknown } = {},
): FakeDaemon {
  const fake: FakeDaemon = {
    calls: [],
    closed: 0,
    startDaemon: async (options = {}) => {
      fake.calls.push(options);
      if (behavior.fail !== undefined) throw behavior.fail;
      const port = options.port === 0 || options.port === undefined ? 45_678 : options.port;
      const host = options.host ?? '127.0.0.1';
      const url = `http://${host}:${port}`;
      const handle: DaemonHandle = {
        url,
        authUrl: `${url}/#token=tok123`,
        token: 'tok123',
        host,
        port,
        stateDir: options.stateDir ?? '/nowhere',
        configDir: options.configDir ?? '/nowhere',
        close: async () => {
          fake.closed++;
          if (behavior.closeDelayMs) await new Promise((r) => setTimeout(r, behavior.closeDelayMs));
          if (behavior.closeError !== undefined) throw behavior.closeError;
        },
      };
      fake.handle = handle;
      return handle;
    },
  };
  return fake;
}

export function healthBody(overrides: Partial<HealthResponse> = {}): HealthResponse {
  return {
    ok: true,
    name: APP_NAME,
    version: '9.9.9',
    apiVersion: API_VERSION,
    git: { version: '2.53.0', supported: true },
    watcher: { mode: 'native', warnings: [] },
    startedAt: '2026-11-08T00:00:00.000Z',
    uptimeMs: 1234,
    ...overrides,
  };
}

/** The health proof a daemon holding `token` returns for `challenge` (computed independently). */
export function proofFor(token: string, challenge: string): string {
  return createHmac('sha256', token).update(healthProofMessage(challenge)).digest('hex');
}

/**
 * `/api/health` body for a request URL: with `?challenge=`, the proof made with `token` (a
 * daemon holding that token); `token: null` answers without a proof (an old or fake daemon).
 */
export function healthFor(
  url: string,
  token: string | null,
  overrides: Partial<HealthResponse> = {},
): HealthResponse {
  const challenge = new URL(url).searchParams.get('challenge');
  return healthBody({
    ...overrides,
    ...(challenge && token ? { proof: proofFor(token, challenge) } : {}),
  });
}

/** True for `<base>/api/health` with or without a query. */
export function isHealth(url: string, base?: string): boolean {
  const u = new URL(url);
  return u.pathname === '/api/health' && (base === undefined || u.origin === base);
}

export function projectItem(mainPath: string, name = path.basename(mainPath)): ProjectListItem {
  return {
    project: {
      id: '0123456789abcdef',
      name,
      commonDir: path.join(mainPath, '.git'),
      mainWorktreePath: mainPath,
      bare: false,
      defaultBranch: 'main',
      defaultBranchOverride: null,
      scanRootId: null,
      addedAt: '2026-11-08T00:00:00.000Z',
    },
    worktrees: [
      {
        worktree: {
          id: 'fedcba9876543210',
          projectId: '0123456789abcdef',
          path: mainPath,
          branch: 'main',
          headSha: 'a'.repeat(40),
          detached: false,
          isMain: true,
          bare: false,
          locked: false,
          prunable: false,
          missing: false,
        },
        summary: null,
        error: null,
      },
    ],
  };
}

export function scanRootBody(p: string, depth: number): ScanRoot {
  return {
    id: '00112233aabbccdd',
    path: p,
    depth,
    addedAt: '2026-11-08T00:00:00.000Z',
    lastScannedAt: null,
    projectCount: 0,
  };
}

export interface RecordedRequest {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

export type Route = (req: RecordedRequest) => { status?: number; body: unknown } | undefined;

/** A fetch that answers from `route` and records requests. `null` route = connection refused. */
export function fakeFetch(route: Route | null): {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const req: RecordedRequest = {
      method: init.method ?? 'GET',
      url: input,
      authorization: headers.authorization ?? null,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    requests.push(req);
    if (route === null) throw new TypeError('fetch failed: ECONNREFUSED');
    const answer = route(req) ?? {
      status: 404,
      body: { error: { code: 'not_found', message: 'no route' } },
    };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, requests };
}

export interface TestDeps extends CliDeps {
  out: Capture;
  err: Capture;
  opened: string[];
}

export function makeDeps(dirs: TempDirs, overrides: Partial<CliDeps> = {}): TestDeps {
  const out = new Capture();
  const err = new Capture();
  const opened: string[] = [];
  const unreachable = fakeFetch(null).fetch;
  const deps: TestDeps = {
    env: { HOME: dirs.home },
    cwd: dirs.cwd,
    platform: 'linux',
    nodeVersion: '26.13.0',
    pid: 424_242,
    stdout: out,
    stderr: err,
    loadStartDaemon: async () => fakeDaemon().startDaemon,
    createApiClient: (options) => createApiClient({ fetch: unreachable, ...options }),
    openUrl: async (url) => {
      opened.push(url);
      return 'fake-open';
    },
    waitForShutdown: () => Promise.resolve('SIGTERM'),
    openReadyChannel: () => {
      throw new Error('this test did not provide a ready channel');
    },
    openStdoutReadyChannel: () => {
      throw new Error('this test did not provide a stdout ready channel');
    },
    watchBrokenPipes: () => ({ stdout: () => false, stderr: () => false }),
    watchStdin: () => ({ closed: new Promise<string>(() => {}), stop: () => {} }),
    isProcessAlive: () => false,
    runProgram: async () => ({ stdout: 'git version 2.53.0\n', stderr: '' }),
    readText: () => null,
    probePort: async () => 'free',
    networkInterfaces: () => ({}),
    now: () => new Date('2026-11-08T12:00:00.000Z'),
    shutdownTimeoutMs: 1_000,
    probeGitHelper: async () => ({
      state: 'on',
      detail: 'git version 2.53.0 through git-helper.js',
    }),
    ...overrides,
    out,
    err,
    opened,
  };
  return deps;
}

/** Client factory whose fetch answers from `route`. */
export function clientFactory(route: Route | null) {
  const fake = fakeFetch(route);
  return {
    requests: fake.requests,
    createApiClient: (options: Parameters<typeof createApiClient>[0] = {}) =>
      createApiClient({ ...options, fetch: fake.fetch }),
  };
}
