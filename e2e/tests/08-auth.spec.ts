/**
 * PLAN §8 item 9 (and §5.4, DECISIONS #16): requests without the token, or with a foreign
 * `Origin` / `Host`, are rejected. Tested at the HTTP level, without a browser.
 */
import { AUTH_COOKIE_NAME, AUTH_QUERY_PARAM, ROUTES } from '@octopus-diff/contracts';
import { findProject } from '@octopus-diff/fixtures';
import { cookiesFrom, rawRequest } from '../support/http.js';
import { expect, test } from '../support/test.js';

const REJECTED = [401, 403, 421];

test.describe('§8.9 auth, Host and Origin checks', () => {
  test('health is public; every other route needs the token', async ({ daemon }) => {
    const health = await rawRequest(`${daemon.url}${ROUTES.health.path}`);
    expect(health.status).toBe(200);
    expect(JSON.parse(health.body)).toMatchObject({ ok: true, name: 'octopus-diff' });

    const protectedGets = [
      ROUTES.listProjects.path,
      ROUTES.listScanRoots.path,
      ROUTES.inbox.path,
      `/api/worktrees/${'0'.repeat(16)}/files`,
    ];
    for (const path of protectedGets) {
      const none = await rawRequest(`${daemon.url}${path}`);
      expect(none.status, `no token: ${path}`).toBe(401);
      expect(JSON.parse(none.body)).toMatchObject({ error: { code: 'unauthorized' } });
      const wrong = await rawRequest(`${daemon.url}${path}`, {
        headers: { authorization: `Bearer ${'x'.repeat(48)}` },
      });
      expect(wrong.status, `wrong token: ${path}`).toBe(401);
    }

    const ok = await rawRequest(`${daemon.url}${ROUTES.listProjects.path}`, {
      headers: { authorization: `Bearer ${daemon.token}` },
    });
    expect(ok.status).toBe(200);
  });

  test('write-ish routes and the event stream need the token', async ({ daemon, manifest }) => {
    const alpha = findProject(manifest, 'alpha');
    const add = await rawRequest(`${daemon.url}${ROUTES.addProject.path}`, {
      method: 'POST',
      body: JSON.stringify({ path: alpha.mainWorktreePath }),
    });
    expect(add.status).toBe(401);
    const review = await rawRequest(`${daemon.url}${ROUTES.setReview.path}`, {
      method: 'PUT',
      body: JSON.stringify({
        projectId: alpha.id,
        scopeKind: 'working',
        path: 'README.md',
        patchHash: 'x',
        reviewed: true,
      }),
    });
    expect(review.status).toBe(401);
    const events = await rawRequest(`${daemon.url}${ROUTES.events.path}`, {
      headers: { accept: 'text/event-stream' },
      stream: true,
    });
    expect(events.status).toBe(401);
    const eventsOk = await rawRequest(`${daemon.url}${ROUTES.events.path}`, {
      headers: { accept: 'text/event-stream', authorization: `Bearer ${daemon.token}` },
      stream: true,
    });
    expect(eventsOk.status).toBe(200);
    expect(String(eventsOk.headers['content-type'])).toContain('text/event-stream');
  });

  test('a foreign Origin is rejected even with a valid token', async ({ daemon }) => {
    const auth = { authorization: `Bearer ${daemon.token}` };
    for (const origin of [
      'http://evil.example',
      `http://localhost.evil.example:${daemon.port}`,
      'null',
    ]) {
      const res = await rawRequest(`${daemon.url}${ROUTES.listProjects.path}`, {
        headers: { ...auth, origin },
      });
      expect(REJECTED, `Origin ${origin} → ${res.status}`).toContain(res.status);
    }
    const post = await rawRequest(`${daemon.url}${ROUTES.setFocus.path}`, {
      method: 'PUT',
      headers: { ...auth, origin: 'https://attacker.example' },
      body: JSON.stringify({ worktreeId: null }),
    });
    expect(REJECTED).toContain(post.status);
    // The daemon's own origin is fine.
    const same = await rawRequest(`${daemon.url}${ROUTES.listProjects.path}`, {
      headers: { ...auth, origin: daemon.url },
    });
    expect(same.status).toBe(200);
  });

  test('a foreign Host is rejected (DNS rebinding), loopback names are accepted', async ({
    daemon,
  }) => {
    const auth = { authorization: `Bearer ${daemon.token}` };
    for (const host of [
      `evil.example:${daemon.port}`,
      `attacker.test`,
      `192.168.1.10:${daemon.port}`,
    ]) {
      const res = await rawRequest(`${daemon.url}${ROUTES.listProjects.path}`, {
        headers: { ...auth, host },
      });
      expect(REJECTED.concat(400), `Host ${host} → ${res.status}`).toContain(res.status);
    }
    for (const host of [`127.0.0.1:${daemon.port}`, `localhost:${daemon.port}`]) {
      const res = await rawRequest(`${daemon.url}${ROUTES.listProjects.path}`, {
        headers: { ...auth, host },
      });
      expect(res.status, `Host ${host}`).toBe(200);
    }
    // The UI page itself must not be served to a rebinding host either.
    const page = await rawRequest(`${daemon.url}/?${AUTH_QUERY_PARAM}=${daemon.token}`, {
      headers: { host: `evil.example:${daemon.port}` },
    });
    expect(REJECTED.concat(400)).toContain(page.status);
  });

  test('?token= on a page load sets an HttpOnly SameSite=Strict cookie and strips the token', async ({
    daemon,
  }) => {
    const res = await rawRequest(`${daemon.url}/?${AUTH_QUERY_PARAM}=${daemon.token}`);
    expect([301, 302, 303, 307, 308]).toContain(res.status);
    const location = String(res.headers.location ?? '');
    expect(location).not.toContain(daemon.token);
    const cookie = cookiesFrom(res.headers).get(AUTH_COOKIE_NAME);
    expect(cookie, 'auth cookie').toBeDefined();
    expect(cookie?.raw).toMatch(/HttpOnly/i);
    expect(cookie?.raw).toMatch(/SameSite=Strict/i);

    const withCookie = await rawRequest(`${daemon.url}${ROUTES.listProjects.path}`, {
      headers: { cookie: `${AUTH_COOKIE_NAME}=${cookie?.value}` },
    });
    expect(withCookie.status).toBe(200);
    const badCookie = await rawRequest(`${daemon.url}${ROUTES.listProjects.path}`, {
      headers: { cookie: `${AUTH_COOKIE_NAME}=nope` },
    });
    expect(badCookie.status).toBe(401);
    // Cookie + foreign Origin (CSRF from another tab) is rejected.
    const csrf = await rawRequest(`${daemon.url}${ROUTES.setFocus.path}`, {
      method: 'PUT',
      headers: { cookie: `${AUTH_COOKIE_NAME}=${cookie?.value}`, origin: 'http://evil.example' },
      body: JSON.stringify({ worktreeId: null }),
    });
    expect(REJECTED).toContain(csrf.status);
  });

  test('a wrong ?token= does not log the browser in', async ({ daemon }) => {
    const res = await rawRequest(`${daemon.url}/?${AUTH_QUERY_PARAM}=wrong-token`);
    expect(cookiesFrom(res.headers).has(AUTH_COOKIE_NAME)).toBe(false);
  });

  test('the browser gets in through authUrl and the API works from the page', async ({
    daemon,
    app,
    page,
  }) => {
    await app.open(daemon.authUrl);
    expect(page.url()).not.toContain(daemon.token);
    const status = await page.evaluate(
      async (path) => (await fetch(path)).status,
      ROUTES.listProjects.path,
    );
    expect(status).toBe(200);
  });
});
