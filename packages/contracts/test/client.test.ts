import { describe, expect, it } from 'vitest';
import {
  ApiClientError,
  buildPath,
  createApiClient,
  formatSseComment,
  formatSseEvent,
  HealthQuerySchema,
  healthProofMessage,
  ROUTES,
  type ServerEvent,
} from '../src/index.js';

const id = '0123456789abcdef';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Call[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return { calls, fetch };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('buildPath', () => {
  it('fills and encodes params', () => {
    expect(buildPath(ROUTES.getDiff.path, { worktreeId: id })).toBe(`/api/worktrees/${id}/diff`);
    expect(buildPath('/x/:a', { a: 'a/b c' })).toBe('/x/a%2Fb%20c');
    expect(() => buildPath('/x/:a', {})).toThrow(/missing path parameter/);
  });
});

describe('createApiClient', () => {
  it('passes a request signal to fetch and reports a cancelled request as aborted (#44)', async () => {
    const files = { worktreeId: id, scope: { kind: 'working' }, stateHash: 's', files: [] };
    const { calls, fetch } = fakeFetch(() => json(files));
    const client = createApiClient({ fetch, validate: false });
    const controller = new AbortController();
    await client.listFiles(id, { signal: controller.signal });
    expect(calls[0]?.init?.signal).toBe(controller.signal);
    await client.getDiff(id, { path: 'a.txt', signal: controller.signal });
    expect(calls[1]?.init?.signal).toBe(controller.signal);
    expect(new URL(`http://x${calls[1]?.url}`).searchParams.has('signal')).toBe(false);
    // Without one, no signal key at all (fetch sees exactly what it saw before).
    await client.listFiles(id);
    expect(calls[2]?.init && 'signal' in calls[2].init).toBe(false);

    // A fetch that the signal aborts rejects with `aborted`, not `network`.
    const hanging = createApiClient({
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          );
        }),
    });
    const pending = new AbortController();
    const call = hanging.listFiles(id, { signal: pending.signal }).catch((e: unknown) => e);
    pending.abort();
    const error = await call;
    expect(error).toBeInstanceOf(ApiClientError);
    expect((error as ApiClientError).code).toBe('aborted');
    // Already aborted: no fetch at all.
    const before = calls.length;
    const early = await client
      .listFiles(id, { signal: AbortSignal.abort() })
      .catch((e: unknown) => e);
    expect((early as ApiClientError).code).toBe('aborted');
    expect(calls.length).toBe(before);
    // A plain network failure is still `network`.
    const broken = createApiClient({
      fetch: () => Promise.reject(new TypeError('fetch failed')),
    });
    const failed = await broken
      .listFiles(id, { signal: new AbortController().signal })
      .catch((e: unknown) => e);
    expect((failed as ApiClientError).code).toBe('network');
  });

  it('sends bearer tokens and encodes scope queries', async () => {
    const { calls, fetch } = fakeFetch(() =>
      json({ worktreeId: id, scope: { kind: 'branch', base: 'main' }, stateHash: 's', files: [] }),
    );
    const client = createApiClient({ baseUrl: 'http://127.0.0.1:7428/', token: 'tok', fetch });
    const res = await client.listFiles(id, { scope: { kind: 'branch', base: 'main' } });
    expect(res.files).toEqual([]);
    expect(calls[0]?.url).toBe(
      `http://127.0.0.1:7428/api/worktrees/${id}/files?scope=branch&base=main`,
    );
    const headers = calls[0]?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
  });

  it('encodes diff parameters', async () => {
    const { calls, fetch } = fakeFetch(() => json({}));
    const client = createApiClient({ fetch, validate: false });
    await client.getDiff(id, {
      scope: { kind: 'commit', sha: 'abc123' },
      path: 'dir/a b.ts',
      ignoreWhitespace: true,
      context: 25,
    });
    const url = new URL(calls[0]?.url ?? '', 'http://x');
    expect(url.pathname).toBe(`/api/worktrees/${id}/diff`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      scope: 'commit',
      sha: 'abc123',
      path: 'dir/a b.ts',
      ignoreWhitespace: 'true',
      context: '25',
    });
  });

  it('sends JSON bodies', async () => {
    const { calls, fetch } = fakeFetch(() => json({ ok: true, reviewed: true }));
    const client = createApiClient({ fetch });
    await client.setReview({
      projectId: id,
      scopeKind: 'working',
      path: 'a.txt',
      patchHash: 'p',
      reviewed: true,
    });
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({ path: 'a.txt' });
  });

  it('maps error bodies to ApiClientError', async () => {
    const { fetch } = fakeFetch(() =>
      json({ error: { code: 'not_found', message: 'no such worktree' } }, 404),
    );
    const client = createApiClient({ fetch });
    const error = await client.listCommits(id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiClientError);
    expect(error).toMatchObject({ code: 'not_found', status: 404, message: 'no such worktree' });
  });

  it('rejects responses that violate the contract', async () => {
    const { fetch } = fakeFetch(() => json({ projects: [{ nope: true }] }));
    const client = createApiClient({ fetch });
    await expect(client.listProjects()).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('streams server events and reconnects with Last-Event-ID', async () => {
    const events: ServerEvent[] = [];
    let connections = 0;
    const seenLastEventIds: Array<string | undefined> = [];
    const event = (n: number): ServerEvent => ({
      type: 'worktree.changed',
      projectId: id,
      worktreeId: id,
      stateHash: `s${n}`,
    });
    const { fetch } = fakeFetch((_url, init) => {
      connections++;
      const headers = init?.headers as Record<string, string>;
      seenLastEventIds.push(headers['last-event-id']);
      const n = connections;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          const frame = formatSseEvent(event(n), n);
          controller.enqueue(enc.encode(frame.slice(0, 10)));
          controller.enqueue(enc.encode(frame.slice(10) + formatSseComment()));
          controller.enqueue(enc.encode('event: future\ndata: {"type":"future"}\n\n'));
          controller.close();
        },
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    const client = createApiClient({ fetch });
    let opened = 0;
    const sub = client.subscribe({
      onEvent: (e) => {
        events.push(e);
        if (events.length === 2) sub.close();
      },
      onOpen: () => opened++,
      reconnectDelayMs: 1,
    });
    await sub.closed;
    expect(events).toEqual([event(1), event(2)]);
    expect(opened).toBe(2);
    expect(seenLastEventIds).toEqual([undefined, '1']);
  });
});

describe('health challenge', () => {
  it('sends the challenge and accepts a proof', async () => {
    const proof = 'a'.repeat(64);
    const { calls, fetch } = fakeFetch(() =>
      json({
        ok: true,
        name: 'octopus-diff',
        version: '0.0.0',
        apiVersion: 1,
        git: { version: '2.53.0', supported: true },
        watcher: { mode: 'native', warnings: [] },
        startedAt: new Date(0).toISOString(),
        uptimeMs: 1,
        proof,
      }),
    );
    const client = createApiClient({ fetch });
    const res = await client.health({ challenge: 'ab'.repeat(16) });
    expect(res.proof).toBe(proof);
    expect(calls[0]?.url).toBe(`/api/health?challenge=${'ab'.repeat(16)}`);
    expect(healthProofMessage('x')).toBe('octopus-diff-health:v1:x');
    expect(HealthQuerySchema.safeParse({ challenge: 'nothex' }).success).toBe(false);
  });
});
