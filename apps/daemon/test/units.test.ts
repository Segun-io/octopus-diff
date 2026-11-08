import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GitCoreError } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { startDaemon } from '../src/daemon.js';
import { ApiError, toApiError } from '../src/errors.js';
import { createLogger } from '../src/logger.js';
import {
  ensurePrivateDir,
  expandHome,
  isSameOrInside,
  resolveDirs,
  resolveInputPath,
} from '../src/paths.js';
import { isHostAllowed, isLoopbackHost, isOriginAllowed, parseHost } from '../src/security.js';
import { DB_FILE, SCHEMA_VERSION, Store } from '../src/store.js';
import { isValidToken, loadOrCreateToken, tokensEqual } from '../src/token.js';
import { tempDir } from './helpers.js';

describe('security helpers', () => {
  const policy = {
    boundHost: '127.0.0.1',
    port: () => 7428,
    allowedHosts: ['dev.box', 'proxy.example:443'],
  };

  it('recognizes loopback hosts', () => {
    for (const h of [
      'localhost',
      '127.0.0.1',
      '127.9.9.9',
      '::1',
      '[::1]',
      '::ffff:127.0.0.1',
      '[::ffff:7f00:1]',
    ]) {
      expect(isLoopbackHost(h), h).toBe(true);
    }
    for (const h of [
      '0.0.0.0',
      '10.0.0.1',
      'example.com',
      'localhost.evil.com',
      '::',
      '128.0.0.1',
    ]) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });

  it('parses Host headers strictly', () => {
    expect(parseHost('127.0.0.1:7428')).toEqual({
      hostname: '127.0.0.1',
      port: 7428,
      host: '127.0.0.1:7428',
    });
    expect(parseHost('[::1]:7428')?.hostname).toBe('[::1]');
    for (const bad of ['', 'a/b', 'u@h', 'h:1/x', 'h?x', ' h', 'h#x'])
      expect(parseHost(bad), bad).toBeNull();
  });

  it('applies the Host policy', () => {
    expect(isHostAllowed('127.0.0.1:7428', policy)).toBe(true);
    expect(isHostAllowed('LOCALHOST:7428', policy)).toBe(true);
    expect(isHostAllowed('localhost:7429', policy)).toBe(false);
    expect(isHostAllowed('localhost', policy)).toBe(false);
    expect(isHostAllowed('evil.com:7428', policy)).toBe(false);
    expect(isHostAllowed('dev.box', policy)).toBe(true);
    expect(isHostAllowed('dev.box:9999', policy)).toBe(true);
    expect(isHostAllowed('proxy.example', policy)).toBe(false);
    expect(isHostAllowed('proxy.example:443', policy)).toBe(true);
    expect(isHostAllowed(undefined, policy)).toBe(false);
    const lan = { boundHost: '192.168.1.5', port: () => 80, allowedHosts: [] };
    expect(isHostAllowed('192.168.1.5', lan)).toBe(true);
    expect(isHostAllowed('192.168.1.6', lan)).toBe(false);
  });

  it('applies the Origin policy', () => {
    expect(isOriginAllowed(undefined, '127.0.0.1:7428')).toBe(true);
    expect(isOriginAllowed('http://127.0.0.1:7428', '127.0.0.1:7428')).toBe(true);
    expect(isOriginAllowed('http://localhost:7428', '127.0.0.1:7428')).toBe(false);
    expect(isOriginAllowed('null', '127.0.0.1:7428')).toBe(false);
    expect(isOriginAllowed('file://', '127.0.0.1:7428')).toBe(false);
    expect(isOriginAllowed('https://proxy.example', 'proxy.example')).toBe(true);
    expect(isOriginAllowed('https://proxy.example:8443', 'proxy.example')).toBe(false);
    expect(isOriginAllowed('http://localhost', 'localhost:80')).toBe(true);
  });
});

describe('token', () => {
  it('creates a 0600 token in a 0700 state dir and reuses it', async () => {
    const stateDir = path.join(await tempDir(), 'nested', 'state');
    expect(await ensurePrivateDir(stateDir)).toBeNull();
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    const first = await loadOrCreateToken(stateDir);
    expect(first.source).toBe('created');
    expect(isValidToken(first.token)).toBe(true);
    expect((await stat(path.join(stateDir, 'token'))).mode & 0o777).toBe(0o600);
    const second = await loadOrCreateToken(stateDir);
    expect(second).toMatchObject({ token: first.token, source: 'file' });
  });

  it('tightens loose permissions and replaces an invalid token file', async () => {
    const stateDir = await tempDir();
    await chmod(stateDir, 0o755);
    expect(await ensurePrivateDir(stateDir)).toMatch(/0700/);
    expect((await stat(stateDir)).mode & 0o777).toBe(0o700);
    await writeFile(path.join(stateDir, 'token'), 'bad token\n', { mode: 0o644 });
    const loaded = await loadOrCreateToken(stateDir);
    expect(loaded.source).toBe('created');
    expect(loaded.warnings).toHaveLength(1);
    expect((await readFile(path.join(stateDir, 'token'), 'utf8')).trim()).toBe(loaded.token);
    expect((await stat(path.join(stateDir, 'token'))).mode & 0o777).toBe(0o600);
  });

  it('validates explicit tokens and compares in constant time', async () => {
    await expect(loadOrCreateToken(await tempDir(), 'short')).rejects.toThrow(/16-512/);
    await expect(loadOrCreateToken(await tempDir(), 'has space in it 12345')).rejects.toThrow();
    expect(tokensEqual('abc', 'abc')).toBe(true);
    expect(tokensEqual('abc', 'abd')).toBe(false);
    expect(tokensEqual('abc', 'abcd')).toBe(false);
  });
});

describe('paths', () => {
  it('expands ~ and resolves relative paths', () => {
    expect(expandHome('~', '/home/u')).toBe('/home/u');
    expect(expandHome('~/code', '/home/u')).toBe('/home/u/code');
    expect(expandHome('~other/x', '/home/u')).toBe('~other/x');
    expect(resolveInputPath('repo', '/work')).toBe('/work/repo');
    expect(isSameOrInside('/a/b', '/a/b/c')).toBe(true);
    expect(isSameOrInside('/a/b', '/a/bc')).toBe(false);
  });

  it('honors XDG variables and ignores relative ones', () => {
    expect(resolveDirs({}, { XDG_STATE_HOME: '/x/state', XDG_CONFIG_HOME: '/x/config' })).toEqual({
      stateDir: '/x/state/octopus-diff',
      configDir: '/x/config/octopus-diff',
    });
    const fallback = resolveDirs({}, { XDG_STATE_HOME: 'relative' });
    expect(fallback.stateDir).toMatch(/\.local\/state\/octopus-diff$/);
    expect(resolveDirs({ stateDir: '/s', configDir: '/c' }, {})).toEqual({
      stateDir: '/s',
      configDir: '/c',
    });
  });
});

describe('logger', () => {
  it('writes JSON lines, filters by level and redacts secrets', () => {
    const lines: string[] = [];
    const log = createLogger({
      level: 'info',
      write: (l) => lines.push(l),
      secrets: () => ['s3cr3t-token-value'],
    });
    log.debug('hidden');
    log.info('hello s3cr3t-token-value', {
      token: 'x',
      nested: { authorization: 'Bearer y', ok: 'see s3cr3t-token-value' },
      error: new Error('boom s3cr3t-token-value'),
    });
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0] ?? '{}');
    expect(entry).toMatchObject({
      level: 'info',
      msg: 'hello [redacted]',
      token: '[redacted]',
      nested: { authorization: '[redacted]', ok: 'see [redacted]' },
      error: { name: 'Error', message: 'boom [redacted]' },
    });
    expect(typeof entry.time).toBe('string');
    const silent: string[] = [];
    createLogger({ level: 'silent', write: (l) => silent.push(l) }).error('x');
    expect(silent).toEqual([]);
  });

  it('delegates to a provided logger', () => {
    const calls: string[] = [];
    const log = createLogger({
      level: 'warn',
      logger: {
        debug: () => {},
        info: () => calls.push('info'),
        warn: (m) => calls.push(`warn:${m}`),
        error: () => {},
      },
    });
    log.info('no');
    log.warn('yes');
    expect(calls).toEqual(['warn:yes']);
  });
});

describe('store', () => {
  it('migrates, persists and reopens', async () => {
    const dir = await tempDir();
    const store = await Store.open(dir);
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    store.insertProject({
      id: '0123456789abcdef',
      name: 'p',
      commonDir: '/r/.git',
      mainWorktreePath: '/r',
      bare: false,
      detectedDefaultBranch: 'main',
      defaultBranchOverride: null,
      scanRootId: null,
      addedAt: '2026-01-01T00:00:00.000Z',
      worktrees: [],
    });
    store.setReviewed(
      { projectId: '0123456789abcdef', scopeKind: 'working', path: 'a', patchHash: 'h' },
      true,
      '2026-01-01T00:00:00.000Z',
    );
    store.close();
    expect((await stat(path.join(dir, DB_FILE))).isFile()).toBe(true);
    const reopened = await Store.open(dir);
    expect(reopened.listProjects()).toHaveLength(1);
    expect(reopened.listReviewMarks('0123456789abcdef', 'working')).toEqual([
      {
        path: 'a',
        raw: false,
        patchHash: 'h',
        reviewedAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    reopened.close();
  });

  it('refuses a database from a newer schema', async () => {
    const dir = await tempDir();
    const { DatabaseSync } = await import('node:sqlite');
    await mkdir(dir, { recursive: true });
    const db = new DatabaseSync(path.join(dir, DB_FILE));
    db.exec('PRAGMA user_version = 999');
    db.close();
    await expect(Store.open(dir)).rejects.toThrow(/newer/);
  });
});

describe('errors', () => {
  it('maps GitCoreError codes', () => {
    const cases: Array<[ConstructorParameters<typeof GitCoreError>[0], string, number]> = [
      ['not_a_repository', 'not_a_repository', 422],
      ['not_found', 'not_found', 404],
      ['invalid_argument', 'bad_request', 400],
      ['timeout', 'timeout', 504],
      ['output_too_large', 'too_large', 413],
      ['git_failed', 'git_error', 500],
      ['git_not_found', 'git_error', 500],
      ['command_not_allowed', 'internal', 500],
      ['disposed', 'internal', 503],
    ];
    for (const [gitCode, code, status] of cases) {
      const e = toApiError(new GitCoreError(gitCode, 'm'));
      expect([e.code, e.status], gitCode).toEqual([code, status]);
    }
    expect(toApiError(new Error('x')).toBody()).toEqual({
      error: { code: 'internal', message: 'x' },
    });
    const api = new ApiError('conflict', 'c');
    expect(toApiError(api)).toBe(api);
  });
});

describe('startDaemon option validation', () => {
  it('refuses non-loopback hosts unless allowed, and invalid ports', async () => {
    await expect(
      startDaemon({ host: '0.0.0.0', port: 0, stateDir: await tempDir(), logLevel: 'silent' }),
    ).rejects.toThrow(/allowNonLoopback/);
    await expect(
      startDaemon({ port: 70000, stateDir: await tempDir(), logLevel: 'silent' }),
    ).rejects.toThrow(/invalid port/);
  });

  it('reports a port conflict clearly and cleans up', async () => {
    const { FakeGitCore } = await import('./fake-git-core.js');
    const first = await startDaemon({
      port: 0,
      stateDir: await tempDir(),
      gitCore: new FakeGitCore(),
      logLevel: 'silent',
    });
    try {
      await expect(
        startDaemon({
          port: first.port,
          stateDir: await tempDir(),
          gitCore: new FakeGitCore(),
          logLevel: 'silent',
        }),
      ).rejects.toThrow(/already in use/);
    } finally {
      await first.close();
    }
  });
});
