import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configJsonSchema, loadConfig, parseConfig } from '../src/config.js';
import { UsageError } from '../src/errors.js';
import {
  defaultConfigDir,
  defaultStateDir,
  expandHome,
  resolveUserPath,
  tildify,
} from '../src/paths.js';
import {
  baseUrlFor,
  buildServeSettings,
  clientHost,
  isLoopbackHost,
  loadContext,
} from '../src/settings.js';
import { makeTempDirs, type TempDirs, writeConfig } from './helpers.js';

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(async () => {
  await dirs.cleanup();
});

describe('paths', () => {
  it('honors absolute XDG variables and ignores relative ones', () => {
    expect(defaultConfigDir({ HOME: '/h' })).toBe('/h/.config/octopus-diff');
    expect(defaultStateDir({ HOME: '/h' })).toBe('/h/.local/state/octopus-diff');
    expect(defaultConfigDir({ HOME: '/h', XDG_CONFIG_HOME: '/x/cfg' })).toBe('/x/cfg/octopus-diff');
    expect(defaultStateDir({ HOME: '/h', XDG_STATE_HOME: '/x/st' })).toBe('/x/st/octopus-diff');
    expect(defaultConfigDir({ HOME: '/h', XDG_CONFIG_HOME: 'relative' })).toBe(
      '/h/.config/octopus-diff',
    );
  });

  it('expands ~ and resolves relative paths', () => {
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~/a', '/h')).toBe('/h/a');
    expect(expandHome('~other/a', '/h')).toBe('~other/a');
    expect(resolveUserPath('a/b', '/base', '/h')).toBe('/base/a/b');
    expect(resolveUserPath('/abs', '/base', '/h')).toBe('/abs');
    expect(tildify('/h/x', '/h')).toBe('~/x');
    expect(tildify('/hx', '/h')).toBe('/hx');
  });
});

describe('config file', () => {
  it('returns defaults when the file is missing', async () => {
    const loaded = await loadConfig(path.join(dirs.root, 'none.json'), false, dirs.home);
    expect(loaded).toEqual({ path: path.join(dirs.root, 'none.json'), exists: false, config: {} });
  });

  it('fails when an explicit --config file is missing', async () => {
    await expect(loadConfig(path.join(dirs.root, 'none.json'), true, dirs.home)).rejects.toThrow(
      /cannot read config file/,
    );
  });

  it('rejects invalid JSON and invalid values with the key path', async () => {
    const file = await writeConfig(dirs, '{ "port": ');
    await expect(loadConfig(file, false, dirs.home)).rejects.toThrow(/not valid JSON/);
    await writeConfig(dirs, { port: 'x', watch: { debounceMs: 5 } });
    const error = await loadConfig(file, false, dirs.home).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UsageError);
    expect((error as Error).message).toMatch(/port:/);
    expect((error as Error).message).toMatch(/watch\.debounceMs:/);
  });

  it('rejects unknown keys (typos)', () => {
    expect(() => parseConfig({ prot: 1 }, '/c/config.json', '/h')).toThrow(/prot/);
  });

  it('resolves paths relative to the config file and expands ~', () => {
    const config = parseConfig(
      {
        $schema: './schema.json',
        projects: ['~/repo', 'rel/repo'],
        scanRoots: ['~/code', { path: '/srv', depth: 2 }],
        stateDir: 'state',
        webRoot: '/opt/web',
      },
      '/c/config.json',
      '/h',
    );
    expect(config).toEqual({
      projects: ['/h/repo', '/c/rel/repo'],
      scanRoots: [{ path: '/h/code' }, { path: '/srv', depth: 2 }],
      stateDir: '/c/state',
      webRoot: '/opt/web',
    });
  });

  it('exports a JSON Schema', () => {
    const schema = configJsonSchema() as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining([
        'port',
        'host',
        'scanRoots',
        'projects',
        'watch',
        'open',
        'logLevel',
      ]),
    );
  });
});

describe('loadContext', () => {
  it('uses XDG defaults from the injected env', async () => {
    const { paths, loaded } = await loadContext({}, { env: { HOME: dirs.home }, cwd: dirs.cwd });
    expect(paths.configFile).toBe(path.join(dirs.configDir, 'config.json'));
    expect(paths.stateDir).toBe(dirs.stateDir);
    expect(loaded.exists).toBe(false);
  });

  it('state dir precedence: flag > config > default', async () => {
    await writeConfig(dirs, { stateDir: '/from/config' });
    const ctx = { env: { HOME: dirs.home }, cwd: dirs.cwd };
    expect((await loadContext({}, ctx)).paths.stateDir).toBe('/from/config');
    expect((await loadContext({ stateDir: 'flag' }, ctx)).paths.stateDir).toBe(
      path.join(dirs.cwd, 'flag'),
    );
  });
});

describe('buildServeSettings', () => {
  const ctx = () => ({ env: { HOME: dirs.home }, cwd: dirs.cwd });
  const baseFlags = { scan: [], projects: [], allowedHosts: [] };

  it('uses the defaults', async () => {
    const { paths, loaded } = await loadContext({}, ctx());
    const settings = buildServeSettings(baseFlags, loaded.config, paths, ctx(), '1.2.3');
    expect(settings.open).toBe(false);
    expect(settings.logLevel).toBe('info');
    expect(settings.webRoot).toBeUndefined();
    expect(settings.options).toEqual({
      host: '127.0.0.1',
      port: 7428,
      allowNonLoopback: false,
      stateDir: dirs.stateDir,
      configDir: dirs.configDir,
      projects: [],
      scanRoots: [],
      watch: {},
      git: {},
      version: '1.2.3',
      logLevel: 'info',
    });
  });

  it('lets flags win over the config and merges lists', async () => {
    await writeConfig(dirs, {
      port: 9000,
      host: 'localhost',
      open: true,
      logLevel: 'warn',
      projects: ['/repos/a'],
      scanRoots: ['/code', { path: '/deep', depth: 6 }],
      scanDepth: 4,
      allowedHosts: ['a.local'],
      watch: { enabled: true, debounceMs: 250, forcePolling: false },
      git: { timeoutMs: 5000 },
    });
    const { paths, loaded } = await loadContext({}, ctx());
    const settings = buildServeSettings(
      {
        ...baseFlags,
        port: 0,
        open: false,
        logLevel: 'debug',
        projects: ['b', '/repos/a'],
        scan: ['/code', 'more'],
        depth: 1,
        allowedHosts: ['b.local'],
        watch: false,
        poll: true,
        webRoot: 'web',
      },
      loaded.config,
      paths,
      ctx(),
      '0.0.0',
    );
    expect(settings.open).toBe(false);
    expect(settings.logLevel).toBe('debug');
    expect(settings.webRoot).toBe(path.join(dirs.cwd, 'web'));
    expect(settings.options).toMatchObject({
      host: 'localhost',
      port: 0,
      projects: ['/repos/a', path.join(dirs.cwd, 'b')],
      scanRoots: [
        { path: '/code', depth: 1 },
        { path: '/deep', depth: 6 },
        { path: path.join(dirs.cwd, 'more'), depth: 1 },
      ],
      allowedHosts: ['a.local', 'b.local'],
      watch: { enabled: false, debounceMs: 250, forcePolling: true },
      git: { timeoutMs: 5000 },
      logLevel: 'debug',
    });
  });

  it('applies the config scanDepth to roots without a depth', async () => {
    await writeConfig(dirs, { scanRoots: ['/code'], scanDepth: 2 });
    const { paths, loaded } = await loadContext({}, ctx());
    const settings = buildServeSettings(baseFlags, loaded.config, paths, ctx(), '0.0.0');
    expect(settings.options.scanRoots).toEqual([{ path: '/code', depth: 2 }]);
  });

  it('refuses non-loopback hosts without --allow-non-loopback', async () => {
    const { paths, loaded } = await loadContext({}, ctx());
    expect(() =>
      buildServeSettings({ ...baseFlags, host: '0.0.0.0' }, loaded.config, paths, ctx(), '0'),
    ).toThrow(/refusing to bind 0\.0\.0\.0/);
    const settings = buildServeSettings(
      { ...baseFlags, host: '0.0.0.0', allowNonLoopback: true },
      loaded.config,
      paths,
      ctx(),
      '0',
    );
    expect(settings.options).toMatchObject({ host: '0.0.0.0', allowNonLoopback: true });
  });
});

describe('host helpers', () => {
  it.each([
    ['127.0.0.1', true],
    ['127.1.2.3', true],
    ['localhost', true],
    ['app.localhost', true],
    ['::1', true],
    ['[::1]', true],
    ['::ffff:127.0.0.1', true],
    ['0.0.0.0', false],
    ['::', false],
    ['192.168.1.10', false],
    ['example.com', false],
  ])('isLoopbackHost(%s) = %s', (host, expected) => {
    expect(isLoopbackHost(host)).toBe(expected);
  });

  it('maps wildcard binds to a loopback client address', () => {
    expect(clientHost('0.0.0.0')).toBe('127.0.0.1');
    expect(clientHost('::')).toBe('[::1]');
    expect(clientHost('::1')).toBe('[::1]');
    expect(baseUrlFor('localhost', 7428)).toBe('http://localhost:7428');
  });
});
