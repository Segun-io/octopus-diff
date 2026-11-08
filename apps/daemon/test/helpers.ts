import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  type ApiClient,
  type ApiErrorBody,
  ApiErrorBodySchema,
  createApiClient,
  type EventSubscription,
  type ServerEvent,
} from '@octopus-diff/contracts';
import { afterEach } from 'vitest';
import { type Daemon, type DaemonOptions, startDaemon } from '../src/daemon.js';
import type { FakeGitCore } from './fake-git-core.js';

export const TEST_TOKEN = 'test-token-0123456789abcdef';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length) {
    const fn = cleanups.pop();
    await fn?.().catch(() => {});
  }
});

export function onCleanup(fn: () => Promise<void> | void): void {
  cleanups.push(async () => {
    await fn();
  });
}

export async function tempDir(prefix = 'octopus-diff-'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  onCleanup(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export interface TestDaemonOptions extends Partial<DaemonOptions> {
  fake: FakeGitCore;
  stateDir: string;
}

export async function startTestDaemon(options: TestDaemonOptions): Promise<Daemon> {
  const { fake, internal, watch, ...rest } = options;
  const daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    token: TEST_TOKEN,
    logLevel: process.env.OCTOPUS_DIFF_TEST_LOGS ? 'debug' : 'silent',
    gitCore: fake,
    ...rest,
    watch: { debounceMs: 150, ...watch },
    internal: { initialSummaryWaitMs: 2000, ...internal },
  });
  onCleanup(() => daemon.close());
  return daemon;
}

export function client(daemon: Daemon, token: string = daemon.token): ApiClient {
  return createApiClient({ baseUrl: daemon.url, token });
}

/** Raw request through the real HTTP server (Host is set by fetch). */
export function http(
  daemon: Daemon,
  pathname: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<Response> {
  const { auth = true, headers, ...rest } = init;
  const h = new Headers(headers);
  if (auth && !h.has('authorization')) h.set('authorization', `Bearer ${daemon.token}`);
  return fetch(`${daemon.url}${pathname}`, { ...rest, headers: h, redirect: 'manual' });
}

/** In-process request with full control over headers (e.g. a forged Host). */
export function inproc(
  daemon: Daemon,
  pathname: string,
  init: RequestInit & { auth?: boolean } = {},
): Promise<Response> {
  const { auth = true, headers, ...rest } = init;
  const h = new Headers(headers);
  if (!h.has('host')) h.set('host', `127.0.0.1:${daemon.port}`);
  if (auth && !h.has('authorization')) h.set('authorization', `Bearer ${daemon.token}`);
  return Promise.resolve(
    daemon.app.request(`http://127.0.0.1:${daemon.port}${pathname}`, { ...rest, headers: h }),
  );
}

export interface EventRecorder {
  events: ServerEvent[];
  opened: Promise<void>;
  waitFor<T extends ServerEvent>(
    predicate: (e: ServerEvent) => e is T,
    timeoutMs?: number,
  ): Promise<T>;
  waitFor(predicate: (e: ServerEvent) => boolean, timeoutMs?: number): Promise<ServerEvent>;
  close(): void;
}

/** Subscribes to `/api/events` over real HTTP and records every event. */
export function recordEvents(daemon: Daemon): EventRecorder {
  const events: ServerEvent[] = [];
  const waiters: Array<{
    predicate: (e: ServerEvent) => boolean;
    resolve: (e: ServerEvent) => void;
  }> = [];
  let markOpen: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    markOpen = resolve;
  });
  const sub: EventSubscription = createApiClient({
    baseUrl: daemon.url,
    token: daemon.token,
  }).subscribe({
    onEvent: (event) => {
      events.push(event);
      if (event.type === 'hello') markOpen();
      for (const w of [...waiters]) {
        if (w.predicate(event)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(event);
        }
      }
    },
    reconnectDelayMs: 50,
  });
  onCleanup(() => sub.close());
  return {
    events,
    opened,
    waitFor(predicate: (e: ServerEvent) => boolean, timeoutMs = 3000): Promise<ServerEvent> {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(`timed out waiting for event; got: ${events.map((e) => e.type).join(', ')}`),
          );
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (e) => {
            clearTimeout(timer);
            resolve(e);
          },
        });
      });
    },
    close: () => sub.close(),
  } as EventRecorder;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `check` until it returns truthy or the timeout expires. */
export async function eventually<T>(
  check: () => T | Promise<T>,
  timeoutMs = 3000,
  stepMs = 25,
): Promise<NonNullable<Awaited<T>>> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) return value as NonNullable<Awaited<T>>;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`eventually: timed out${last ? `: ${String(last)}` : ''}`);
    }
    await sleep(stepMs);
  }
}

/** Parses an `ApiErrorBody` response and returns its `error`. */
export async function errorOf(res: Response): Promise<ApiErrorBody['error']> {
  return ApiErrorBodySchema.parse(await res.json()).error;
}
