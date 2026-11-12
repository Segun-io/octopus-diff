import { createHmac } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  AUTH_COOKIE_NAME,
  createApiClient,
  HealthResponseSchema,
  healthProofMessage,
  ROUTES,
} from '@octopus-diff/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Daemon } from '../src/daemon.js';
import { healthProof } from '../src/token.js';
import { FakeGitCore } from './fake-git-core.js';
import { errorOf, http, inproc, recordEvents, startTestDaemon, tempDir } from './helpers.js';

const CHALLENGE = '0123456789abcdef'.repeat(4);

function expectedProof(token: string, challenge: string): string {
  return createHmac('sha256', token).update(healthProofMessage(challenge)).digest('hex');
}

/**
 * Every API route except health, derived from `ROUTES` (so routes added later are covered too),
 * plus unknown API paths. Path params get a well-formed id; bodies are `{}` (a 400 is fine:
 * the point is that auth runs first).
 */
function apiRequests(): Array<{ method: string; path: string; body?: string }> {
  const id = '0'.repeat(16);
  const requests: Array<{ method: string; path: string; body?: string }> = Object.entries(ROUTES)
    .filter(([name]) => name !== 'health')
    .map(([, route]) => ({
      method: route.method,
      path: route.path.replace(/:[A-Za-z]+/g, id),
      ...(['POST', 'PUT', 'PATCH'].includes(route.method) ? { body: '{}' } : {}),
    }));
  expect(requests.length).toBeGreaterThanOrEqual(16);
  return [
    ...requests,
    { method: 'GET', path: '/api/no-such-route' },
    { method: 'GET', path: '/api' },
  ];
}

describe('auth v2 and request safety', () => {
  let daemon: Daemon;
  let webRoot: string;

  beforeEach(async () => {
    webRoot = await tempDir();
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>ui</title>');
    await writeFile(path.join(webRoot, 'app.js'), 'console.log(1)');
    daemon = await startTestDaemon({ fake: new FakeGitCore(), stateDir: await tempDir(), webRoot });
  });

  it('binds loopback on an ephemeral port and exposes the #token= URL', () => {
    expect(daemon.host).toBe('127.0.0.1');
    expect(daemon.port).toBeGreaterThan(0);
    expect(daemon.url).toBe(`http://127.0.0.1:${daemon.port}`);
    expect(daemon.authUrl).toBe(`${daemon.url}/#token=${daemon.token}`);
  });

  it('serves /api/health without a token, and without a proof unless challenged', async () => {
    const res = await http(daemon, '/api/health', { auth: false });
    expect(res.status).toBe(200);
    const body = HealthResponseSchema.parse(await res.json());
    expect(body.git).toEqual({ version: '2.53.0', supported: true });
    expect(body.watcher.mode).toBe('native');
    expect(body.proof).toBeUndefined();
  });

  it('proves possession of the token for ?challenge= (HMAC-SHA256 keyed by the token)', async () => {
    const res = await http(daemon, `/api/health?challenge=${CHALLENGE}`, { auth: false });
    expect(res.status).toBe(200);
    const body = HealthResponseSchema.parse(await res.json());
    expect(body.proof).toBe(expectedProof(daemon.token, CHALLENGE));
    expect(body.proof).toBe(healthProof(daemon.token, CHALLENGE));
    expect(JSON.stringify(body)).not.toContain(daemon.token);
    // A different challenge gives a different proof; the contract client passes it through.
    const other = 'f'.repeat(32);
    const viaClient = await createApiClient({ baseUrl: daemon.url }).health({ challenge: other });
    expect(viaClient.proof).toBe(expectedProof(daemon.token, other));
    expect(viaClient.proof).not.toBe(body.proof);
  });

  it('rejects malformed challenges', async () => {
    for (const challenge of [
      'zz',
      'abc',
      'A'.repeat(32),
      '0'.repeat(129),
      `${'0'.repeat(32)}%20`,
    ]) {
      const res = await http(daemon, `/api/health?challenge=${challenge}`, { auth: false });
      expect(res.status, challenge).toBe(400);
    }
  });

  it('requires the bearer token on every other API route, including /api/events', async () => {
    for (const { method, path: p, body } of apiRequests()) {
      const headers = body ? { 'content-type': 'application/json' } : undefined;
      const none = await inproc(daemon, p, { method, auth: false, headers, body });
      expect(none.status, `${method} ${p} without a token`).toBe(401);
      expect(await errorOf(none)).toEqual({ code: 'unauthorized', message: 'missing token' });
      expect(none.headers.get('www-authenticate')).toMatch(/^Bearer/);

      const wrong = await inproc(daemon, p, {
        method,
        body,
        headers: { ...headers, authorization: 'Bearer nope-nope-nope-nope' },
      });
      expect(wrong.status, `${method} ${p} with a wrong token`).toBe(401);
      expect((await errorOf(wrong)).message).toBe('invalid token');

      const ok = await inproc(daemon, p, { method, headers, body });
      expect(ok.status, `${method} ${p} with the token`).not.toBe(401);
      await ok.body?.cancel();
    }
  });

  it('streams events with the bearer token (fetch-based subscribe)', async () => {
    const recorder = recordEvents(daemon);
    await recorder.opened;
    expect(recorder.events[0]?.type).toBe('hello');
  });

  it('ignores the v1 cookie (even with the right token) and expires it everywhere', async () => {
    const cookie = `other=1; ${AUTH_COOKIE_NAME}=${daemon.token}`;
    const api = await http(daemon, '/api/projects', { auth: false, headers: { cookie } });
    expect(api.status).toBe(401);
    for (const res of [
      api,
      await http(daemon, '/api/projects', { headers: { cookie } }),
      await http(daemon, '/api/health', { auth: false, headers: { cookie } }),
      await http(daemon, '/', { auth: false, headers: { cookie } }),
    ]) {
      const set = res.headers.get('set-cookie') ?? '';
      expect(set).toContain(`${AUTH_COOKIE_NAME}=;`);
      expect(set).toMatch(/Max-Age=0/);
      expect(set).toMatch(/Path=\//);
      expect(set).not.toContain(daemon.token);
    }
    // No cookie in the request: no Set-Cookie at all.
    expect((await http(daemon, '/')).headers.get('set-cookie')).toBeNull();
    expect((await http(daemon, '/api/projects')).headers.get('set-cookie')).toBeNull();
  });

  it('never accepts ?token= on API routes', async () => {
    const res = await http(daemon, `/api/projects?token=${daemon.token}`, { auth: false });
    expect(res.status).toBe(401);
    expect(res.headers.get('location')).toBeNull();
  });

  it('redirects a v1 ?token= page load to #token= without setting a cookie', async () => {
    const res = await http(daemon, `/some/page?x=1&token=${daemon.token}&y=2`, { auth: false });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/some/page?x=1&y=2#token=${daemon.token}`);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');

    const root = await http(daemon, `/?token=${daemon.token}`, { auth: false });
    expect(root.headers.get('location')).toBe(`/#token=${daemon.token}`);

    const sneaky = await inproc(daemon, `//evil.example/?token=${daemon.token}`, { auth: false });
    expect(sneaky.headers.get('location')).toBe(`/evil.example/#token=${daemon.token}`);
  });

  it('answers a wrong ?token= with a sign-in hint, no redirect and no cookie', async () => {
    const res = await http(daemon, '/?token=wrong-wrong-wrong-wrong', {
      auth: false,
      headers: { accept: 'text/html' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('location')).toBeNull();
    expect(await res.text()).toContain('#token=');
  });

  it('serves the static UI without a token, but still checks Host and Origin', async () => {
    for (const p of ['/', '/app.js', '/inbox/some/route']) {
      const res = await http(daemon, p, { auth: false });
      expect(res.status, p).toBe(200);
      await res.body?.cancel();
    }
    const foreignHost = await inproc(daemon, '/', {
      auth: false,
      headers: { host: `evil.example:${daemon.port}` },
    });
    expect(foreignHost.status).toBe(403);
    const foreignOrigin = await inproc(daemon, '/app.js', {
      auth: false,
      headers: { origin: 'https://evil.example' },
    });
    expect(foreignOrigin.status).toBe(403);
    // A cross-site navigation to the page is fine (fetch metadata only guards the API).
    const nav = await inproc(daemon, '/', {
      auth: false,
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(nav.status).toBe(200);
  });

  it('rejects foreign Host headers (DNS rebinding), even for /api/health and with a token', async () => {
    for (const host of [
      'evil.example',
      `evil.example:${daemon.port}`,
      `127.0.0.1:${daemon.port + 1}`,
      'localhost',
      `127.0.0.1.nip.io:${daemon.port}`,
      `user@127.0.0.1:${daemon.port}`,
    ]) {
      const res = await inproc(daemon, `/api/health?challenge=${CHALLENGE}`, { headers: { host } });
      expect(res.status, host).toBe(403);
      expect((await errorOf(res)).code).toBe('forbidden');
    }
    const authed = await inproc(daemon, '/api/projects', {
      headers: { host: `evil.example:${daemon.port}` },
    });
    expect(authed.status).toBe(403);
  });

  it('accepts loopback Host names with the bound port', async () => {
    for (const host of [
      `127.0.0.1:${daemon.port}`,
      `localhost:${daemon.port}`,
      `[::1]:${daemon.port}`,
      `127.1.2.3:${daemon.port}`,
    ]) {
      const res = await inproc(daemon, '/api/projects', { headers: { host } });
      expect(res.status, host).toBe(200);
    }
  });

  it('rejects foreign Origin headers and accepts its own origin', async () => {
    for (const origin of [
      'https://evil.example',
      'null',
      `http://localhost:${daemon.port + 1}`,
      `http://evil.example:${daemon.port}`,
    ]) {
      const res = await inproc(daemon, '/api/projects', { headers: { origin } });
      expect(res.status, origin).toBe(403);
    }
    const post = await inproc(daemon, '/api/review', {
      method: 'PUT',
      headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(post.status).toBe(403);
    const own = await inproc(daemon, '/api/projects', {
      headers: { origin: `http://127.0.0.1:${daemon.port}` },
    });
    expect(own.status).toBe(200);
    const sse = await inproc(daemon, '/api/events', {
      headers: { origin: 'https://evil.example' },
    });
    expect(sse.status).toBe(403);
  });

  it('rejects cross-site fetch metadata on every API route, health included', async () => {
    for (const p of ['/api/projects', '/api/health', '/api/events', '/api/nope']) {
      const res = await inproc(daemon, p, { headers: { 'sec-fetch-site': 'cross-site' } });
      expect(res.status, p).toBe(403);
    }
  });

  it('sets security headers and never CORS headers', async () => {
    const res = await http(daemon, '/api/settings', { headers: { origin: daemon.url } });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    // The project listing is the exception to `no-store`: `no-cache` + ETag (DECISIONS #171).
    const projects = await http(daemon, '/api/projects', { headers: { origin: daemon.url } });
    expect(projects.headers.get('cache-control')).toBe('no-cache');
    expect(projects.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(projects.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await http(daemon, '/api/projects', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('guards the UX round 1 routes (settings, review policy, bulk review, undo) like every API route', async () => {
    const routes: Array<{ method: string; path: string; body?: unknown; ok: number }> = [
      { method: 'GET', path: '/api/settings', ok: 200 },
      { method: 'PATCH', path: '/api/settings', body: {}, ok: 200 },
      {
        method: 'PUT',
        path: '/api/review-policy',
        body: { target: { kind: 'project', projectId: '0000000000000000' }, enabled: false },
        ok: 404,
      },
      { method: 'POST', path: '/api/review/bulk', body: { target: { kind: 'all' } }, ok: 200 },
      { method: 'POST', path: '/api/review/undo', body: { undoToken: 'nope' }, ok: 404 },
    ];
    for (const r of routes) {
      const init = {
        method: r.method,
        headers: { 'content-type': 'application/json' },
        ...(r.body === undefined ? {} : { body: JSON.stringify(r.body) }),
      };
      const label = `${r.method} ${r.path}`;
      const missing = await http(daemon, r.path, { ...init, auth: false });
      expect(missing.status, `${label} without token`).toBe(401);
      expect((await errorOf(missing)).code).toBe('unauthorized');
      const wrong = await http(daemon, r.path, {
        ...init,
        headers: { ...init.headers, authorization: 'Bearer nope-nope-nope-nope' },
      });
      expect(wrong.status, `${label} wrong token`).toBe(401);
      const query = await http(daemon, `${r.path}?token=${daemon.token}`, {
        ...init,
        auth: false,
      });
      expect(query.status, `${label} ?token=`).toBe(401);
      const origin = await inproc(daemon, r.path, {
        ...init,
        headers: { ...init.headers, origin: 'https://evil.example' },
      });
      expect(origin.status, `${label} foreign Origin`).toBe(403);
      const host = await inproc(daemon, r.path, {
        ...init,
        headers: { ...init.headers, host: `evil.example:${daemon.port}` },
      });
      expect(host.status, `${label} foreign Host`).toBe(403);
      const crossSite = await inproc(daemon, r.path, {
        ...init,
        headers: { ...init.headers, 'sec-fetch-site': 'cross-site' },
      });
      expect(crossSite.status, `${label} cross-site`).toBe(403);
      const ok = await http(daemon, r.path, {
        ...init,
        headers: { ...init.headers, origin: daemon.url },
      });
      expect(ok.status, `${label} with token`).toBe(r.ok);
      expect(ok.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('never logs the token', async () => {
    const lines: string[] = [];
    const d = await startTestDaemon({
      fake: new FakeGitCore(),
      stateDir: await tempDir(),
      webRoot,
      logLevel: 'debug',
      internal: { logWrite: (line) => lines.push(line) },
    });
    await http(d, `/?token=${d.token}`, { auth: false });
    await http(d, `/api/health?challenge=${CHALLENGE}`, { auth: false });
    await http(d, '/api/projects');
    await http(d, '/api/projects', { headers: { authorization: `Bearer ${d.token}x` } });
    await http(d, '/api/projects', {
      auth: false,
      headers: { cookie: `${AUTH_COOKIE_NAME}=${d.token}` },
    });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(d.token);
  });
});

describe('SEC-10: router and security middleware agree on paths', () => {
  let daemon: Daemon;

  beforeEach(async () => {
    const webRoot = await tempDir();
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>ui</title>');
    daemon = await startTestDaemon({ fake: new FakeGitCore(), stateDir: await tempDir(), webRoot });
  });

  it('refuses percent-encoded unreserved characters in the path before routing', async () => {
    for (const p of [
      '/%61pi/projects',
      '/%41pi/projects',
      '/api/%70rojects',
      '/ap%69/health',
      `/%61pi/projects?token=${daemon.token}`,
      '/api/projects%2E',
      '/%7Eroot',
      '/assets/%5Fx.js',
    ]) {
      for (const auth of [false, true]) {
        const res = await inproc(daemon, p, { auth });
        expect(res.status, `${p} auth=${auth}`).toBe(400);
        expect(res.headers.get('set-cookie')).toBeNull();
        expect(res.headers.get('location')).toBeNull();
      }
      const crossSite = await inproc(daemon, p, { headers: { 'sec-fetch-site': 'cross-site' } });
      expect([400, 403]).toContain(crossSite.status);
    }
  });

  it('never serves API data on paths the router does not treat as API paths', async () => {
    for (const p of ['//api/projects', '/API/projects', '/api%2Fprojects', '//api/health']) {
      const res = await inproc(daemon, p, { auth: false });
      const text = await res.text();
      expect(text, p).not.toContain('"projects"');
      expect(text, p).not.toContain('"apiVersion"');
    }
  });

  it('applies API rules to every path the router sends to the API', async () => {
    for (const p of ['/api/projects', '/./api/projects', '/x/../api/projects', '/api//projects']) {
      const res = await inproc(daemon, p, { auth: false });
      expect(res.status, p).toBe(401);
      const redirect = await inproc(daemon, `${p}?token=${daemon.token}`, { auth: false });
      expect(redirect.status, `${p}?token=`).toBe(401);
    }
  });
});
