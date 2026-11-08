import { AUTH_COOKIE_NAME, HealthResponseSchema } from '@octopus-diff/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Daemon } from '../src/daemon.js';
import { FakeGitCore } from './fake-git-core.js';
import { errorOf, http, inproc, startTestDaemon, tempDir } from './helpers.js';

describe('auth and request safety', () => {
  let daemon: Daemon;

  beforeEach(async () => {
    daemon = await startTestDaemon({ fake: new FakeGitCore(), stateDir: await tempDir() });
  });

  it('binds loopback on an ephemeral port and exposes the tokenized URL', () => {
    expect(daemon.host).toBe('127.0.0.1');
    expect(daemon.port).toBeGreaterThan(0);
    expect(daemon.url).toBe(`http://127.0.0.1:${daemon.port}`);
    expect(daemon.authUrl).toBe(`${daemon.url}/?token=${daemon.token}`);
  });

  it('serves /api/health without a token', async () => {
    const res = await http(daemon, '/api/health', { auth: false });
    expect(res.status).toBe(200);
    const body = HealthResponseSchema.parse(await res.json());
    expect(body.git).toEqual({ version: '2.53.0', supported: true });
    expect(body.watcher.mode).toBe('native');
  });

  it('rejects API requests without a token (401) or with a wrong one', async () => {
    const missing = await http(daemon, '/api/projects', { auth: false });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      error: { code: 'unauthorized', message: 'missing token' },
    });
    expect(missing.headers.get('www-authenticate')).toMatch(/^Bearer/);

    const wrong = await http(daemon, '/api/projects', {
      headers: { authorization: 'Bearer nope-nope-nope-nope' },
    });
    expect(wrong.status).toBe(401);
    expect((await errorOf(wrong)).code).toBe('unauthorized');

    const wrongCookie = await http(daemon, '/api/projects', {
      auth: false,
      headers: { cookie: `${AUTH_COOKIE_NAME}=wrong-token-wrong-token` },
    });
    expect(wrongCookie.status).toBe(401);
  });

  it('does not accept ?token= on API routes', async () => {
    const res = await http(daemon, `/api/projects?token=${daemon.token}`, { auth: false });
    expect(res.status).toBe(401);
  });

  it('accepts the bearer token and the auth cookie', async () => {
    expect((await http(daemon, '/api/projects')).status).toBe(200);
    const res = await http(daemon, '/api/projects', {
      auth: false,
      headers: { cookie: `other=1; ${AUTH_COOKIE_NAME}=${daemon.token}` },
    });
    expect(res.status).toBe(200);
  });

  it('bootstraps the cookie from ?token= on a page load and redirects without it', async () => {
    const res = await http(daemon, `/some/page?x=1&token=${daemon.token}&y=2`, { auth: false });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/some/page?x=1&y=2');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${AUTH_COOKIE_NAME}=${daemon.token}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\//);
    expect(res.headers.get('cache-control')).toBe('no-store');

    const root = await http(daemon, `/?token=${daemon.token}`, { auth: false });
    expect(root.headers.get('location')).toBe('/');

    const sneaky = await http(daemon, `//evil.example/?token=${daemon.token}`, { auth: false });
    expect(sneaky.headers.get('location')).toBe('/evil.example/');
  });

  it('rejects a wrong ?token= without setting a cookie', async () => {
    const res = await http(daemon, '/?token=wrong-wrong-wrong-wrong', {
      auth: false,
      headers: { accept: 'text/html' },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.text()).toContain('not signed in');
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
      const res = await inproc(daemon, '/api/health', { headers: { host } });
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

  it('rejects cross-site fetch metadata on the API', async () => {
    const res = await inproc(daemon, '/api/projects', {
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(res.status).toBe(403);
  });

  it('sets security headers and never CORS headers', async () => {
    const res = await http(daemon, '/api/projects', { headers: { origin: daemon.url } });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const preflight = await http(daemon, '/api/projects', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'PUT' },
    });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers unauthenticated page loads with a sign-in hint', async () => {
    const res = await http(daemon, '/', { auth: false, headers: { accept: 'text/html' } });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('text/html');
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
      logLevel: 'debug',
      internal: { logWrite: (line) => lines.push(line) },
    });
    await http(d, `/?token=${d.token}`, { auth: false });
    await http(d, '/api/projects');
    await http(d, '/api/projects', { headers: { authorization: `Bearer ${d.token}x` } });
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain(d.token);
  });
});
