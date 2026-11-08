import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Daemon } from '../src/daemon.js';
import { FakeGitCore } from './fake-git-core.js';
import { http, inproc, startTestDaemon, tempDir } from './helpers.js';

describe('static web UI', () => {
  let daemon: Daemon;
  let outside: string;

  beforeEach(async () => {
    const webRoot = await tempDir();
    outside = await tempDir();
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>ui</title>');
    await mkdir(path.join(webRoot, 'assets'));
    await writeFile(path.join(webRoot, 'assets', 'app-abc123.js'), 'console.log(1)');
    await writeFile(path.join(webRoot, 'favicon.svg'), '<svg/>');
    await writeFile(path.join(outside, 'secret.txt'), 'top secret');
    await symlink(path.join(outside, 'secret.txt'), path.join(webRoot, 'leak.txt'));
    await symlink(outside, path.join(webRoot, 'leakdir'));
    daemon = await startTestDaemon({ fake: new FakeGitCore(), stateDir: await tempDir(), webRoot });
  });

  it('serves index.html with the UI CSP and security headers', async () => {
    const res = await http(daemon, '/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await res.text()).toContain('<title>ui</title>');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves hashed assets with long caching and correct types', async () => {
    const js = await http(daemon, '/assets/app-abc123.js');
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
    expect(js.headers.get('cache-control')).toContain('immutable');
    // Worker scripts run under their own response's CSP: it must allow same-origin imports.
    expect(js.headers.get('content-security-policy') ?? '').toContain("script-src 'self'");
    const svg = await http(daemon, '/favicon.svg');
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    const head = await http(daemon, '/assets/app-abc123.js', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
  });

  it('falls back to index.html for client routes but 404s missing assets', async () => {
    const route = await http(daemon, '/inbox/some/route');
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('<title>ui</title>');
    expect((await http(daemon, '/assets/missing.js')).status).toBe(404);
    expect((await http(daemon, '/missing.js')).status).toBe(404);
  });

  it('blocks path traversal and symlink escapes', async () => {
    for (const p of [
      '/..%2f..%2fetc%2fpasswd',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/assets/..%2f..%2fsecret.txt',
      '/a%00b',
      '/a%5c..%5csecret',
    ]) {
      const res = await inproc(daemon, p);
      const body = await res.text();
      // Either refused, or normalized by the URL parser to an in-root path (SPA fallback).
      if (res.status === 200) expect(body, p).toContain('<title>ui</title>');
      else expect([400, 404], p).toContain(res.status);
      expect(body).not.toContain('top secret');
      expect(body).not.toContain('root:');
    }
    for (const p of ['/leak.txt', '/leakdir/secret.txt']) {
      const res = await http(daemon, p);
      expect(res.status, p).toBe(404);
      expect(await res.text()).not.toContain('top secret');
    }
  });

  it('requires auth for static files too', async () => {
    const res = await http(daemon, '/assets/app-abc123.js', { auth: false });
    expect(res.status).toBe(401);
  });

  it('does not serve the UI for non-GET methods', async () => {
    const res = await http(daemon, '/', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

describe('webRoot without index.html', () => {
  it('serves the API only', async () => {
    const daemon = await startTestDaemon({
      fake: new FakeGitCore(),
      stateDir: await tempDir(),
      webRoot: await tempDir(),
    });
    expect((await http(daemon, '/')).status).toBe(404);
    expect((await http(daemon, '/api/projects')).status).toBe(200);
  });
});
