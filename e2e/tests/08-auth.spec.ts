/**
 * PLAN §8 item 9 (and §5.4), auth v2 (DECISIONS Phase 2 lead #5, security review SEC-01/02/04/
 * 10/11/12): every API route and the event stream need `Authorization: Bearer`; static UI assets
 * are public; no cookie is ever set and a stale v1 cookie is expired; `?token=` page loads
 * redirect to `#token=`; the browser keeps the token in localStorage and strips it from the
 * address bar; `/api/health?challenge=` proves the daemon holds the token; foreign `Host` /
 * `Origin` are still rejected. Tested over raw HTTP and in Chromium.
 */
import { execFile } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  AUTH_COOKIE_NAME,
  HealthResponseSchema,
  healthProofMessage,
  ROUTES,
  TEST_IDS,
  TOKEN_STORAGE_KEY,
} from '@octopus-diff/contracts';
import { findProject } from '@octopus-diff/fixtures';
import { REPO_ROOT, WEB_DIST } from '../support/env.js';
import { cookiesFrom, rawRequest } from '../support/http.js';
import { expect, test } from '../support/test.js';

const REJECTED = [401, 403, 421];
const CLI_BIN = join(REPO_ROOT, 'apps', 'cli', 'dist', 'index.js');

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/**
 * The address after sign-in: the token fragment is gone and no token is in the URL. Since #50 the
 * app writes the selected worktree into the query (`?worktree=…`), so the path is checked, not the
 * whole URL.
 */
function expectNoTokenInAddress(url: string, daemon: { url: string; token: string }): void {
  const parsed = new URL(url);
  expect(parsed.origin).toBe(daemon.url);
  expect(parsed.pathname).toBe('/');
  expect(parsed.hash).toBe('');
  expect(url).not.toContain(daemon.token);
  expect(parsed.searchParams.has('token')).toBe(false);
}

function proof(token: string, challenge: string): string {
  return createHmac('sha256', token).update(healthProofMessage(challenge)).digest('hex');
}

/**
 * Every API route except health, derived from `ROUTES` (routes added later are covered too),
 * plus an unknown API path. Path params get a fixture id; bodies are minimal valid-looking JSON.
 */
function apiRoutes(projectId: string): Array<{ method: string; path: string; body?: string }> {
  const routes: Array<{ method: string; path: string; body?: string }> = Object.entries(ROUTES)
    .filter(([name]) => name !== 'health')
    .map(([, route]) => ({
      method: route.method,
      path: route.path.replace(
        /:[A-Za-z]+/g,
        route.path.includes(':projectId') ? projectId : '0'.repeat(16),
      ),
      ...(['POST', 'PUT', 'PATCH'].includes(route.method) ? { body: '{}' } : {}),
    }));
  expect(routes.length).toBeGreaterThanOrEqual(16);
  return [...routes, { method: 'GET', path: '/api/no-such-route' }];
}

/** `/`, plus the scripts and styles index.html references (the real web build). */
async function staticAssets(): Promise<string[]> {
  const html = await readFile(join(WEB_DIST, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map((m) => m[1] ?? '');
  const workers = (await readdir(join(WEB_DIST, 'assets'))).filter((f) => /worker.*\.js$/i.test(f));
  return ['/', '/index.html', ...refs, ...workers.slice(0, 2).map((f) => `/assets/${f}`)];
}

test.describe('§8.9 auth v2, Host and Origin checks (HTTP)', () => {
  test('health is public; ?challenge= returns the HMAC proof, without it there is none', async ({
    daemon,
  }) => {
    const plain = await rawRequest(`${daemon.url}${ROUTES.health.path}`);
    expect(plain.status).toBe(200);
    const body = HealthResponseSchema.parse(JSON.parse(plain.body));
    expect(body).toMatchObject({ ok: true, name: 'octopus-diff' });
    expect(body.proof).toBeUndefined();

    const challenge = randomBytes(32).toString('hex');
    const challenged = await rawRequest(
      `${daemon.url}${ROUTES.health.path}?challenge=${challenge}`,
    );
    expect(challenged.status).toBe(200);
    const proven = HealthResponseSchema.parse(JSON.parse(challenged.body));
    expect(proven.proof).toBe(proof(daemon.token, challenge));
    expect(challenged.body).not.toContain(daemon.token);
    // The contract client passes the challenge through as well.
    const viaClient = await daemon.client.health({ challenge: 'ab'.repeat(16) });
    expect(viaClient.proof).toBe(proof(daemon.token, 'ab'.repeat(16)));

    for (const bad of ['xyz', 'ABCDEF0123456789ABCDEF0123456789', '0'.repeat(10)]) {
      const res = await rawRequest(`${daemon.url}${ROUTES.health.path}?challenge=${bad}`);
      expect(res.status, bad).toBe(400);
    }
  });

  test('every other API route and the event stream need the bearer token', async ({
    daemon,
    manifest,
  }) => {
    const alpha = findProject(manifest, 'alpha');
    for (const { method, path, body } of apiRoutes(alpha.id)) {
      const stream = path === ROUTES.events.path;
      const none = await rawRequest(`${daemon.url}${path}`, {
        method,
        ...(body ? { body } : {}),
        stream,
      });
      expect(none.status, `no token: ${method} ${path}`).toBe(401);
      expect(JSON.parse(none.body)).toMatchObject({ error: { code: 'unauthorized' } });
      const wrong = await rawRequest(`${daemon.url}${path}`, {
        method,
        headers: bearer('x'.repeat(48)),
        ...(body ? { body } : {}),
        stream,
      });
      expect(wrong.status, `wrong token: ${method} ${path}`).toBe(401);
      // The v1 cookie, even holding the right token, is not a credential any more.
      const cookie = await rawRequest(`${daemon.url}${path}`, {
        method,
        headers: { cookie: `${AUTH_COOKIE_NAME}=${daemon.token}` },
        ...(body ? { body } : {}),
        stream,
      });
      expect(cookie.status, `cookie: ${method} ${path}`).toBe(401);
    }
    const ok = await rawRequest(`${daemon.url}${ROUTES.listProjects.path}`, {
      headers: bearer(daemon.token),
    });
    expect(ok.status).toBe(200);
    const events = await rawRequest(`${daemon.url}${ROUTES.events.path}`, {
      headers: { accept: 'text/event-stream', ...bearer(daemon.token) },
      stream: true,
    });
    expect(events.status).toBe(200);
    expect(String(events.headers['content-type'])).toContain('text/event-stream');
  });

  test('static UI assets are public, never set a cookie, and still check Host', async ({
    daemon,
  }) => {
    const assets = await staticAssets();
    expect(assets.length).toBeGreaterThan(3);
    for (const path of assets) {
      const res = await rawRequest(`${daemon.url}${path}`, { maxBytes: 1024 });
      expect(res.status, path).toBe(200);
      expect(res.headers['set-cookie'], path).toBeUndefined();
      const rebound = await rawRequest(`${daemon.url}${path}`, {
        headers: { host: `evil.example:${daemon.port}` },
        maxBytes: 1024,
      });
      expect(REJECTED.concat(400), `foreign Host: ${path}`).toContain(rebound.status);
    }
    const api = await rawRequest(`${daemon.url}${ROUTES.listProjects.path}`, {
      headers: bearer(daemon.token),
    });
    expect(api.headers['set-cookie']).toBeUndefined();
  });

  test('a stale v1 auth cookie is expired on any response', async ({ daemon }) => {
    for (const path of ['/', ROUTES.health.path, ROUTES.listProjects.path]) {
      const res = await rawRequest(`${daemon.url}${path}`, {
        headers: { cookie: `${AUTH_COOKIE_NAME}=${daemon.token}`, ...bearer(daemon.token) },
        maxBytes: 1024,
      });
      const cookie = cookiesFrom(res.headers).get(AUTH_COOKIE_NAME);
      expect(cookie, path).toBeDefined();
      expect(cookie?.value).toBe('');
      expect(cookie?.raw).toMatch(/Max-Age=0/i);
      expect(cookie?.raw).toMatch(/Path=\//);
    }
  });

  test('?token= on a page load redirects to #token=, sets no cookie; a wrong one is refused', async ({
    daemon,
  }) => {
    const res = await rawRequest(`${daemon.url}/?token=${daemon.token}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`/#token=${daemon.token}`);
    expect(res.headers['set-cookie']).toBeUndefined();
    const deep = await rawRequest(`${daemon.url}/inbox?x=1&token=${daemon.token}`);
    expect(deep.headers.location).toBe(`/inbox?x=1#token=${daemon.token}`);

    const wrong = await rawRequest(`${daemon.url}/?token=wrong-token-wrong-token`);
    expect(wrong.status).toBe(401);
    expect(wrong.headers.location).toBeUndefined();
    expect(wrong.headers['set-cookie']).toBeUndefined();
    // Never on an API route.
    const api = await rawRequest(`${daemon.url}${ROUTES.listProjects.path}?token=${daemon.token}`);
    expect(api.status).toBe(401);
  });

  test('SEC-10: percent-encoded unreserved characters in the path are refused', async ({
    daemon,
  }) => {
    for (const path of [
      '/%61pi/projects',
      '/api/%70rojects',
      `/%61pi/projects?token=${daemon.token}`,
    ]) {
      for (const headers of [{}, bearer(daemon.token)]) {
        const res = await rawRequest(`${daemon.url}${path}`, { headers });
        expect(res.status, path).toBe(400);
        expect(res.headers.location).toBeUndefined();
      }
    }
    const crossSite = await rawRequest(`${daemon.url}${ROUTES.listProjects.path}`, {
      headers: { ...bearer(daemon.token), 'sec-fetch-site': 'cross-site' },
    });
    expect(crossSite.status).toBe(403);
  });

  test('a foreign Origin is rejected even with a valid token', async ({ daemon }) => {
    const auth = bearer(daemon.token);
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
    const same = await rawRequest(`${daemon.url}${ROUTES.listProjects.path}`, {
      headers: { ...auth, origin: daemon.url },
    });
    expect(same.status).toBe(200);
  });

  test('a foreign Host is rejected (DNS rebinding), loopback names are accepted', async ({
    daemon,
  }) => {
    const auth = bearer(daemon.token);
    for (const host of [
      `evil.example:${daemon.port}`,
      'attacker.test',
      `192.168.1.10:${daemon.port}`,
    ]) {
      for (const path of [
        ROUTES.listProjects.path,
        `${ROUTES.health.path}?challenge=${'0'.repeat(32)}`,
      ]) {
        const res = await rawRequest(`${daemon.url}${path}`, { headers: { ...auth, host } });
        expect(REJECTED.concat(400), `Host ${host} ${path} → ${res.status}`).toContain(res.status);
      }
    }
    for (const host of [`127.0.0.1:${daemon.port}`, `localhost:${daemon.port}`]) {
      const res = await rawRequest(`${daemon.url}${ROUTES.listProjects.path}`, {
        headers: { ...auth, host },
      });
      expect(res.status, `Host ${host}`).toBe(200);
    }
  });
});

test.describe('§8.9 auth v2 in the browser', () => {
  test('authUrl signs the browser in: token in localStorage, never in the address bar, no cookies', async ({
    daemon,
    app,
    page,
    context,
  }) => {
    expect(daemon.authUrl).toBe(`${daemon.url}/#token=${daemon.token}`);
    await app.open(daemon.authUrl);
    expectNoTokenInAddress(page.url(), daemon);
    expect(await page.evaluate((key) => localStorage.getItem(key), TOKEN_STORAGE_KEY)).toBe(
      daemon.token,
    );
    expect(await context.cookies()).toEqual([]);
    // The page's own requests carry the bearer token; a request without it is refused.
    const statuses = await page.evaluate(
      async ({ path, key }) => {
        const token = localStorage.getItem(key) ?? '';
        const withToken = await fetch(path, { headers: { authorization: `Bearer ${token}` } });
        const without = await fetch(path);
        return [withToken.status, without.status];
      },
      { path: ROUTES.listProjects.path, key: TOKEN_STORAGE_KEY },
    );
    expect(statuses).toEqual([200, 401]);
    // A reload (and a new tab) stays signed in without the token in the URL.
    await page.reload();
    await app.waitReady();
    const second = await context.newPage();
    await second.goto(daemon.url);
    await expect(second.getByTestId(TEST_IDS.app)).toHaveAttribute('data-ready', 'true', {
      timeout: 20_000,
    });
    await second.close();
  });

  test('a v1 ?token= URL still signs in and ends without the token in the address bar', async ({
    daemon,
    app,
    page,
    context,
  }) => {
    await app.open(`${daemon.url}/?token=${daemon.token}`);
    expectNoTokenInAddress(page.url(), daemon);
    expect(await context.cookies()).toEqual([]);
  });

  test('a stale v1 cookie in the browser is expired by the first page load', async ({
    daemon,
    app,
    context,
  }) => {
    const { hostname } = new URL(daemon.url);
    await context.addCookies([
      { name: AUTH_COOKIE_NAME, value: daemon.token, domain: hostname, path: '/', httpOnly: true },
    ]);
    expect(await context.cookies()).toHaveLength(1);
    await app.open(daemon.authUrl);
    expect(await context.cookies()).toEqual([]);
  });

  test('without a token the UI explains how to sign in; pasting the URL into the tab signs in', async ({
    daemon,
    app,
    page,
  }) => {
    await page.goto(daemon.url);
    const banner = page.getByTestId(TEST_IDS.errorBanner);
    await expect(banner).toHaveAttribute('data-kind', 'auth');
    await expect(banner).toContainText('octopus-diff serve');
    await expect(banner).toContainText('#token=');
    // Same document, fragment-only navigation: the app picks up the token and reloads.
    await page.goto(daemon.authUrl);
    await app.waitReady();
    await expect.poll(() => new URL(page.url()).hash).toBe('');
    expectNoTokenInAddress(page.url(), daemon);
  });

  test('a wrong #token= is stripped and leads to the sign-in hint', async ({ daemon, page }) => {
    await page.goto(`${daemon.url}/#token=${'w'.repeat(40)}`);
    await expect(page.getByTestId(TEST_IDS.errorBanner)).toHaveAttribute('data-kind', 'auth');
    expect(page.url()).toBe(`${daemon.url}/`);
  });

  test('SEC-04: `status --open` hands the opener a 0600 launcher file, which signs the browser in', async ({
    daemon,
    app,
    page,
  }) => {
    test.skip(!existsSync(CLI_BIN), 'apps/cli is not built (run pnpm build)');
    // The CLI finds the daemon through the state dir: token file and runtime file (pid = us).
    await writeFile(join(daemon.stateDir, 'token'), `${daemon.token}\n`, { mode: 0o600 });
    await writeFile(
      join(daemon.stateDir, 'daemon.json'),
      JSON.stringify({
        pid: process.pid,
        url: daemon.url,
        host: '127.0.0.1',
        port: daemon.port,
        version: 'e2e',
        startedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    // Fake openers record their argv and stdin. PATH holds only them, so no real browser opener
    // can be found (the CLI resolves openers through absolute PATH entries only). Run 1 offers
    // only xdg-open (the launcher file, on every OS); run 2 adds powershell.exe, which the CLI
    // prefers on WSL (URL on stdin).
    const runStatusOpen = async (openers: string[], tag: string) => {
      const bin = join(daemon.stateDir, '..', `fake-bin-${tag}`);
      const record = join(daemon.stateDir, '..', `opener-${tag}`);
      await mkdir(bin, { recursive: true });
      for (const name of openers) {
        await writeFile(
          join(bin, name),
          `#!/bin/sh\nprintf '%s\\n' "${name}" "$@" > '${record}.argv'\n` +
            `while IFS= read -r line; do printf '%s\\n' "$line"; done > '${record}.stdin'\n`,
        );
        await chmod(join(bin, name), 0o755);
      }
      const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
        (resolve) => {
          execFile(
            process.execPath,
            [
              CLI_BIN,
              'status',
              '--open',
              '--state-dir',
              daemon.stateDir,
              '--config-dir',
              daemon.configDir,
            ],
            { env: { PATH: bin, HOME: join(daemon.stateDir, '..') }, timeout: 30_000 },
            (error, stdout, stderr) =>
              resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr }),
          );
        },
      );
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(daemon.authUrl);
      await expect.poll(() => existsSync(`${record}.argv`)).toBe(true);
      const argv = (await readFile(`${record}.argv`, 'utf8')).trim().split('\n');
      expect(argv.join(' ')).not.toContain(daemon.token);
      return { argv, stdin: () => readFile(`${record}.stdin`, 'utf8').catch(() => '') };
    };

    const first = await runStatusOpen(['xdg-open'], 'xdg');
    expect(first.argv[0]).toBe('xdg-open');
    const launcher = first.argv[1] ?? '';
    expect(launcher).toMatch(/\/open-[0-9a-f]{16}\.html$/);
    expect(launcher.startsWith(daemon.stateDir)).toBe(true);
    expect((await stat(launcher)).mode & 0o777).toBe(0o600);
    // Chromium follows the launcher's meta refresh from file:// to the daemon and signs in.
    await page.goto(pathToFileURL(launcher).href);
    await page.waitForURL(`${daemon.url}/`);
    await app.waitReady();
    expect(page.url()).not.toContain(daemon.token);

    const second = await runStatusOpen(['xdg-open', 'powershell.exe'], 'both');
    if (second.argv[0] === 'powershell.exe') {
      expect(second.argv.slice(1)).toEqual([
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        '-',
      ]);
      await expect.poll(second.stdin).toBe(`Start-Process '${daemon.authUrl}'\n`);
    } else {
      expect(second.argv[0]).toBe('xdg-open');
    }
    expect(page.url()).not.toContain(daemon.token);
  });
});
