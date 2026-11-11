import { createHash, randomBytes } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { InboxResponseSchema } from '@octopus-diff/contracts';
import { type Context, Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Daemon } from '../src/daemon.js';
import {
  acceptsGzip,
  etagOf,
  httpCache,
  ifNoneMatchHits,
  MIN_COMPRESS_BYTES,
} from '../src/http-cache.js';
import { FakeGitCore, type FakeRepo, fakeFile } from './fake-git-core.js';
import { client, http, inproc, startTestDaemon, tempDir } from './helpers.js';

/** Raw (still compressed) bytes of a response: `app.request` does not decode. */
async function rawBytes(res: Response): Promise<Buffer> {
  return Buffer.from(await res.arrayBuffer());
}

describe('Accept-Encoding and If-None-Match parsing', () => {
  it('accepts gzip unless refused', () => {
    expect(acceptsGzip('gzip')).toBe(true);
    expect(acceptsGzip('deflate, gzip;q=0.5, br')).toBe(true);
    expect(acceptsGzip('GZIP')).toBe(true);
    expect(acceptsGzip('*')).toBe(true);
    expect(acceptsGzip('gzip;q=0')).toBe(false);
    expect(acceptsGzip('gzip;q=0, *')).toBe(false);
    expect(acceptsGzip('br, deflate')).toBe(false);
    expect(acceptsGzip('identity')).toBe(false);
    expect(acceptsGzip(undefined)).toBe(false);
  });

  it('compares validators weakly and understands lists and *', () => {
    const tag = etagOf(Buffer.from('x'));
    expect(tag).toMatch(/^W\/"[A-Za-z0-9_-]+"$/);
    expect(ifNoneMatchHits(tag, tag)).toBe(true);
    expect(ifNoneMatchHits(tag.slice(2), tag)).toBe(true);
    expect(ifNoneMatchHits(`"other", ${tag}`, tag)).toBe(true);
    expect(ifNoneMatchHits('*', tag)).toBe(true);
    expect(ifNoneMatchHits('"other"', tag)).toBe(false);
    expect(ifNoneMatchHits(undefined, tag)).toBe(false);
    expect(ifNoneMatchHits('', tag)).toBe(false);
  });
});

describe('gzip and ETag on the JSON API (fake git-core)', () => {
  let fake: FakeGitCore;
  let daemon: Daemon;
  let alpha: FakeRepo;
  const wtOf = () => alpha.worktrees[0]?.id ?? '';

  /** A 4.5k-file inbox, the size class of the 1.18 MB measurement in GitHub #28. */
  function bigFiles(count: number, suffix = '') {
    return Array.from({ length: count }, (_, i) =>
      fakeFile(`packages/pkg-${i % 40}/src/module-${i}${suffix}.ts`, {
        additions: i % 90,
        deletions: i % 13,
        patchHash: createHash('sha1').update(`${i}:${suffix}`).digest('hex'),
      }),
    );
  }

  beforeEach(async () => {
    fake = new FakeGitCore();
    const base = await tempDir();
    alpha = await fake.createRepo(base, 'alpha');
    fake.setFiles(wtOf(), 'working', bigFiles(4500));
    daemon = await startTestDaemon({ fake, stateDir: await tempDir() });
    await client(daemon).addProject({ path: alpha.mainPath });
  });

  it('sends the inbox gzipped, about 10x smaller, with Vary, and the body round-trips', async () => {
    const plain = await inproc(daemon, '/api/inbox');
    expect(plain.headers.get('content-encoding')).toBeNull();
    expect(plain.headers.get('vary')).toMatch(/accept-encoding/i);
    const plainBytes = await rawBytes(plain);
    expect(plainBytes.length).toBeGreaterThan(900_000);

    const packed = await inproc(daemon, '/api/inbox', {
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    });
    expect(packed.status).toBe(200);
    expect(packed.headers.get('content-encoding')).toBe('gzip');
    expect(packed.headers.get('vary')).toMatch(/accept-encoding/i);
    expect(packed.headers.get('content-type')).toContain('application/json');
    const packedBytes = await rawBytes(packed);
    expect(Number(packed.headers.get('content-length'))).toBe(packedBytes.length);
    const ratio = plainBytes.length / packedBytes.length;
    expect(ratio, `ratio ${ratio.toFixed(1)}x`).toBeGreaterThan(5);
    // Same content as the plain answer apart from the per-request `generatedAt`.
    const unpacked = InboxResponseSchema.parse(
      JSON.parse(gunzipSync(packedBytes).toString('utf8')),
    );
    const expected = InboxResponseSchema.parse(JSON.parse(plainBytes.toString('utf8')));
    expect({ ...unpacked, generatedAt: '' }).toEqual({ ...expected, generatedAt: '' });
  });

  it('works through the real HTTP server (the client decodes it)', async () => {
    const res = await http(daemon, '/api/inbox', { headers: { 'accept-encoding': 'gzip' } });
    expect(res.status).toBe(200);
    const body = InboxResponseSchema.parse(await res.json());
    expect(body.entries[0]?.files).toHaveLength(4500);
    // Still fine for a client that asks for nothing.
    const identity = await http(daemon, '/api/inbox', {
      headers: { 'accept-encoding': 'identity' },
    });
    expect(identity.headers.get('content-encoding')).toBeNull();
    expect(InboxResponseSchema.parse(await identity.json()).entries).toHaveLength(1);
  });

  it('answers 304 to a matching If-None-Match and 200 once the data changed', async () => {
    const first = await inproc(daemon, '/api/inbox', {
      headers: { 'accept-encoding': 'gzip' },
    });
    const etag = first.headers.get('etag');
    expect(etag).toMatch(/^W\/"/);
    // The browser must be allowed to keep it, and must revalidate it every time.
    expect(first.headers.get('cache-control')).toBe('no-cache');

    for (const encoding of ['gzip', 'identity']) {
      const second = await inproc(daemon, '/api/inbox', {
        headers: { 'if-none-match': etag ?? '', 'accept-encoding': encoding },
      });
      expect(second.status, encoding).toBe(304);
      expect(second.headers.get('etag')).toBe(etag);
      expect(second.headers.get('content-encoding')).toBeNull();
      expect(second.headers.get('vary')).toMatch(/accept-encoding/i);
      expect(second.headers.get('cache-control')).toBe('no-cache');
      // Security headers are unchanged on a 304.
      expect(second.headers.get('x-content-type-options')).toBe('nosniff');
      expect(second.headers.get('content-security-policy')).toContain("default-src 'none'");
      expect((await rawBytes(second)).length).toBe(0);
    }
    // Over real HTTP too.
    const real = await http(daemon, '/api/inbox', { headers: { 'if-none-match': etag ?? '' } });
    expect(real.status).toBe(304);

    // A change in the state changes the ETag.
    fake.setFiles(wtOf(), 'working', bigFiles(4500, '-v2'));
    await client(daemon).refreshWorktree(wtOf());
    const changed = await inproc(daemon, '/api/inbox', {
      headers: { 'if-none-match': etag ?? '' },
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
  });

  it('puts an ETag on projects and files, and a review mark changes the inbox ETag', async () => {
    const projects = await inproc(daemon, '/api/projects');
    const projectsTag = projects.headers.get('etag');
    expect(projectsTag).toBeTruthy();
    expect(
      (await inproc(daemon, '/api/projects', { headers: { 'if-none-match': projectsTag ?? '' } }))
        .status,
    ).toBe(304);

    const files = await inproc(daemon, `/api/worktrees/${wtOf()}/files`);
    const filesTag = files.headers.get('etag');
    expect(filesTag).toBeTruthy();
    expect(
      (
        await inproc(daemon, `/api/worktrees/${wtOf()}/files`, {
          headers: { 'if-none-match': filesTag ?? '' },
        })
      ).status,
    ).toBe(304);

    // Review marks are not in the worktree stateHash; a body hash still notices them.
    const inbox = await inproc(daemon, '/api/inbox?onlyUnreviewed=false');
    const inboxTag = inbox.headers.get('etag');
    const file = InboxResponseSchema.parse(await inbox.json()).entries[0]?.files[0];
    if (!file) throw new Error('missing file');
    await client(daemon).setReview({
      projectId: alpha.projectId,
      scopeKind: 'working',
      path: file.path,
      patchHash: file.patchHash,
      reviewed: true,
    });
    const after = await inproc(daemon, '/api/inbox?onlyUnreviewed=false', {
      headers: { 'if-none-match': inboxTag ?? '' },
    });
    expect(after.status).toBe(200);
  });

  it('never answers 304 (or leaks an ETag) without the token, nor to a foreign Host/Origin', async () => {
    const tag = (await inproc(daemon, '/api/inbox')).headers.get('etag') ?? '';
    const noToken = await inproc(daemon, '/api/inbox', {
      auth: false,
      headers: { 'if-none-match': tag },
    });
    expect(noToken.status).toBe(401);
    expect(noToken.headers.get('etag')).toBeNull();
    const badOrigin = await inproc(daemon, '/api/inbox', {
      headers: { 'if-none-match': tag, origin: 'https://evil.example' },
    });
    expect(badOrigin.status).toBe(403);
    const badHost = await inproc(daemon, '/api/inbox', {
      headers: { 'if-none-match': tag, host: `evil.example:${daemon.port}` },
    });
    expect(badHost.status).toBe(403);
  });

  it('keeps diffs and writes uncompressed-and-uncached: no ETag, no-store', async () => {
    const diff = await inproc(daemon, `/api/worktrees/${wtOf()}/diff?path=src%2Fa.ts`, {
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(diff.headers.get('etag')).toBeNull();
    expect(diff.headers.get('cache-control')).toBe('no-store');
    const post = await inproc(daemon, '/api/focus', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept-encoding': 'gzip' },
      body: JSON.stringify({ worktreeId: wtOf() }),
    });
    expect(post.headers.get('etag')).toBeNull();
    expect(post.headers.get('cache-control')).toBe('no-store');
  });

  it('leaves small responses alone (no gzip) but still tags the listings', async () => {
    const health = await inproc(daemon, '/api/health', { headers: { 'accept-encoding': 'gzip' } });
    expect(health.headers.get('content-encoding')).toBeNull();
    expect(health.headers.get('etag')).toBeNull();
    expect(health.headers.get('cache-control')).toBe('no-store');

    fake.setFiles(wtOf(), 'working', []);
    await client(daemon).refreshWorktree(wtOf());
    const tiny = await inproc(daemon, '/api/inbox', { headers: { 'accept-encoding': 'gzip' } });
    const bytes = await rawBytes(tiny);
    expect(bytes.length).toBeLessThan(MIN_COMPRESS_BYTES);
    expect(tiny.headers.get('content-encoding')).toBeNull();
    expect(tiny.headers.get('etag')).toBeTruthy();
    expect(Number(tiny.headers.get('content-length'))).toBe(bytes.length);
  });

  it('does not compress the event stream', async () => {
    const res = await http(daemon, '/api/events', { headers: { 'accept-encoding': 'gzip' } });
    try {
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      expect(res.headers.get('content-encoding')).toBeNull();
      expect(res.headers.get('etag')).toBeNull();
      expect(res.headers.get('cache-control')).toBe('no-store');
      const reader = res.body?.getReader();
      const first = await reader?.read();
      expect(new TextDecoder().decode(first?.value)).toContain('event: hello');
    } finally {
      await res.body?.cancel().catch(() => {});
    }
  });
});

describe('cost of the middleware', () => {
  it('adds under 50 ms CPU per 10 MB (gzip level 1 plus the ETag hash)', async () => {
    // ~10 MB of JSON shaped like a file list, with random ids so it does not compress unrealistically well
    // (the measured inbox gzips about 9x; gzip's cost grows with the entropy of its input).
    const files = Array.from({ length: 80_000 }, (_, i) => ({
      path: `packages/pkg-${i % 97}/src/dir-${i % 31}/module-${i}.ts`,
      status: 'modified',
      additions: i % 50,
      deletions: i % 7,
      patchHash: randomBytes(8).toString('hex'),
    }));
    const json = JSON.stringify({ files });
    expect(json.length).toBeGreaterThan(9_500_000);
    const route = (c: Context) => c.body(json, 200, { 'Content-Type': 'application/json' });
    const plain = new Hono().get('/api/list', route);
    const cached = new Hono()
      .use('/api/*', httpCache({ revalidate: [/^\/api\/list$/] }))
      .get('/api/list', route);

    const timeOf = async (app: Hono, headers: Record<string, string>): Promise<number> => {
      const started = performance.now();
      const res = await app.request('/api/list', { headers });
      await res.arrayBuffer();
      return performance.now() - started;
    };
    const best = async (app: Hono, headers: Record<string, string>): Promise<number> => {
      await timeOf(app, headers); // warm-up
      const runs: number[] = [];
      for (let i = 0; i < 7; i++) runs.push(await timeOf(app, headers));
      return Math.min(...runs);
    };
    // Best of several runs on each side: the budget is about the work, not CI noise. The
    // measured side also hashes the body for the ETag (the route is revalidated).
    const base = await best(plain, {});
    const withMiddleware = await best(cached, { 'accept-encoding': 'gzip' });
    const extra = withMiddleware - base;
    expect(extra, `+${extra.toFixed(1)} ms per ${(json.length / 1e6).toFixed(1)} MB`).toBeLessThan(
      50,
    );
  });
});
