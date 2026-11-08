/**
 * Tiny Node HTTP server for the mock backend, bound to 127.0.0.1. Serves the contract routes
 * plus `/api/events` (SSE) and runs the change simulator.
 *
 * Env: MOCK_PORT (default 7429), MOCK_DATASET (demo | large | empty), MOCK_INTERVAL_MS
 * (simulator period, 0 disables; default 5000), MOCK_TOKEN (require auth), MOCK_LATENCY_MS.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  formatSseComment,
  formatSseEvent,
  SSE_HEARTBEAT_INTERVAL_MS,
} from '@octopus-diff/contracts';
import { MockBackend, type MockDataset } from './backend.js';
import { createMockRouter } from './router.js';

export interface MockServerOptions {
  port?: number;
  host?: string;
  dataset?: MockDataset;
  intervalMs?: number;
  token?: string;
  latencyMs?: number;
}

export interface MockServer {
  url: string;
  backend: MockBackend;
  server: Server;
  close(): Promise<void>;
}

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(', '));
  }
  return new Request(new URL(req.url ?? '/', origin), {
    method: req.method ?? 'GET',
    headers,
    ...(body && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
  });
}

export async function startMockServer(options: MockServerOptions = {}): Promise<MockServer> {
  const host = options.host ?? '127.0.0.1';
  const backend = new MockBackend({ dataset: options.dataset ?? 'demo' });
  const handle = createMockRouter(backend, {
    ...(options.token ? { token: options.token } : {}),
    ...(options.latencyMs ? { latencyMs: options.latencyMs } : {}),
  });
  const sseClients = new Set<ServerResponse>();
  let eventId = 0;

  const server = createServer((req, res) => {
    void (async () => {
      const origin = `http://${host}`;
      if (req.url?.startsWith('/api/events')) {
        if (options.token) {
          const cookie = req.headers.cookie ?? '';
          const ok =
            req.headers.authorization === `Bearer ${options.token}` ||
            cookie.split(/;\s*/).includes(`octopus_diff_token=${options.token}`);
          if (!ok) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'missing token' } }));
            return;
          }
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        });
        res.write('retry: 1000\n\n');
        res.write(formatSseEvent(backend.hello(), ++eventId));
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      const response = await handle(await toRequest(req, origin));
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((err: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'internal', message: String(err) } }));
    });
  });

  const unsubscribe = backend.subscribe((event) => {
    const frame = formatSseEvent(event, ++eventId);
    for (const client of sseClients) client.write(frame);
  });
  const heartbeat = setInterval(() => {
    for (const client of sseClients) client.write(formatSseComment());
  }, SSE_HEARTBEAT_INTERVAL_MS);
  const intervalMs = options.intervalMs ?? 5000;
  const stopSimulator = intervalMs > 0 ? backend.startSimulator(intervalMs) : () => {};

  await new Promise<void>((resolve) => server.listen(options.port ?? 7429, host, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 7429);
  return {
    url: `http://${host}:${port}`,
    backend,
    server,
    close: async () => {
      stopSimulator();
      clearInterval(heartbeat);
      unsubscribe();
      for (const client of sseClients) client.end();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function mockServerOptionsFromEnv(): MockServerOptions {
  return {
    port: envNumber('MOCK_PORT', 7429),
    dataset: (process.env.MOCK_DATASET as MockDataset | undefined) ?? 'demo',
    intervalMs: envNumber('MOCK_INTERVAL_MS', 5000),
    latencyMs: envNumber('MOCK_LATENCY_MS', 0),
    ...(process.env.MOCK_TOKEN ? { token: process.env.MOCK_TOKEN } : {}),
  };
}

const isEntry = import.meta.url === `file://${process.argv[1]}`;
if (isEntry) {
  const mock = await startMockServer(mockServerOptionsFromEnv());
  console.log(`octopus-diff mock API listening on ${mock.url}`);
}
