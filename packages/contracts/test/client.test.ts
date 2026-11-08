import { describe, expect, it } from 'vitest';
import {
  ApiClientError,
  buildPath,
  createApiClient,
  formatSseComment,
  formatSseEvent,
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
