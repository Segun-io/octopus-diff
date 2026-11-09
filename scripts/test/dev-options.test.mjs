import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createDaemonOutputFilter,
  DevUsageError,
  daemonServeArgs,
  isAlreadyRunningLine,
  lanIPv4Addresses,
  parseDevArgs,
  tokenFromBannerLine,
  webAuthUrls,
  webEnv,
} from '../lib/dev-options.mjs';

const ctx = { repoRoot: '/repo', home: '/home/me', cwd: '/work' };
const parse = (argv, env = {}) => parseDevArgs(argv, env, ctx);

describe('parseDevArgs', () => {
  it('defaults to the LAN, ports 7429/5173, this checkout and a separate state dir', () => {
    expect(parse([])).toEqual({
      help: false,
      lan: true,
      daemonPort: 7429,
      webPort: 5173,
      lanHosts: ['odino', 'odino.local'],
      repos: ['/repo'],
      stateDir: '/home/me/.local/state/octopus-diff-dev',
      serveArgs: [],
    });
  });

  it('takes flags, positional repos and serve flags after --', () => {
    const opts = parse([
      '--daemon-port',
      '7439',
      '--web-port=5183',
      '--allowed-host',
      'Box.lan',
      '--state-dir',
      '~/dev-state',
      'a',
      '/abs/b',
      '--',
      '--log-level',
      'debug',
    ]);
    expect(opts.daemonPort).toBe(7439);
    expect(opts.webPort).toBe(5183);
    expect(opts.lanHosts).toEqual(['odino', 'odino.local', 'box.lan']);
    expect(opts.stateDir).toBe('/home/me/dev-state');
    expect(opts.repos).toEqual(['/work/a', '/abs/b']);
    expect(opts.serveArgs).toEqual(['--log-level', 'debug']);
  });

  it('reads the environment', () => {
    const opts = parse([], {
      OCTOPUS_DIFF_DEV_DAEMON_PORT: '7500',
      OCTOPUS_DIFF_DEV_WEB_PORT: '5500',
      OCTOPUS_DIFF_DEV_ALLOWED_HOSTS: 'one, two',
      OCTOPUS_DIFF_DEV_REPOS: ['/x', 'rel'].join(path.delimiter),
      XDG_STATE_HOME: '/state',
    });
    expect(opts.daemonPort).toBe(7500);
    expect(opts.webPort).toBe(5500);
    expect(opts.lanHosts).toEqual(['odino', 'odino.local', 'one', 'two']);
    expect(opts.repos).toEqual(['/x', '/work/rel']);
    expect(opts.stateDir).toBe('/state/octopus-diff-dev');
  });

  it('ignores a relative XDG_STATE_HOME', () => {
    expect(parse([], { XDG_STATE_HOME: 'rel' }).stateDir).toBe(
      '/home/me/.local/state/octopus-diff-dev',
    );
  });

  it('--loopback drops the LAN names but keeps explicit extra hosts', () => {
    expect(parse(['--loopback']).lanHosts).toEqual([]);
    expect(parse(['--loopback']).lan).toBe(false);
    expect(parse(['--loopback', '--allowed-host', 'x']).lanHosts).toEqual(['x']);
  });

  it('allows the LAN addresses as hosts in LAN mode only', () => {
    const withIps = (argv) => parseDevArgs(argv, {}, { ...ctx, lanAddresses: ['10.0.0.5'] });
    expect(withIps([]).lanHosts).toEqual(['odino', 'odino.local', '10.0.0.5']);
    expect(withIps(['--loopback']).lanHosts).toEqual([]);
  });

  it.each([
    [['--daemon-port', '7428'], /reserved for the production LAN server/],
    [['--web-port', '7428'], /reserved/],
    [['--daemon-port', '0'], /port number/],
    [['--web-port', '70000'], /port number/],
    [['--web-port', '12ab'], /port number/],
    [['--daemon-port', '5173'], /must differ/],
    [['--allowed-host', 'odino:5173'], /bare host name/],
    [['--allowed-host', 'http://x'], /bare host name/],
    [['--bogus'], /Unknown option/],
    [['--', '--port', '7439'], /--daemon-port/],
    [['--', '--port=7428'], /--daemon-port/],
    [['--', '-p7439'], /--daemon-port/],
    [['--', '--host', '0.0.0.0'], /--loopback/],
    [['--', '--allow-non-loopback'], /--loopback/],
    [['--', '--state-dir', '/x'], /--state-dir before --/],
    [['--', '--allowed-host=x'], /--allowed-host before --/],
    [['--', '--', 'repo'], /repo paths before --/],
  ])('rejects %j', (argv, message) => {
    expect(() => parse(argv)).toThrow(DevUsageError);
    expect(() => parse(argv)).toThrow(message);
  });

  it('rejects 7428 from the environment too', () => {
    expect(() => parse([], { OCTOPUS_DIFF_DEV_DAEMON_PORT: '7428' })).toThrow(/reserved/);
  });
});

describe('child arguments', () => {
  it('builds the LAN serve argv', () => {
    expect(daemonServeArgs(parse(['--', '--poll']))).toEqual([
      'serve',
      '--host',
      '::',
      '--allow-non-loopback',
      '--port',
      '7429',
      '--allowed-host',
      'localhost',
      '--allowed-host',
      '127.0.0.1',
      '--allowed-host',
      'odino',
      '--allowed-host',
      'odino.local',
      '--state-dir',
      '/home/me/.local/state/octopus-diff-dev',
      '--no-open',
      '--poll',
      '--',
      '/repo',
    ]);
  });

  it('builds the loopback serve argv without the LAN flags', () => {
    const argv = daemonServeArgs(parse(['--loopback']));
    expect(argv.slice(0, 5)).toEqual(['serve', '--host', '127.0.0.1', '--port', '7429']);
    expect(argv).not.toContain('--allow-non-loopback');
    expect(argv).not.toContain('odino');
  });

  it('builds the Vite env', () => {
    expect(webEnv(parse([]))).toEqual({
      OCTOPUS_DIFF_API: 'http://127.0.0.1:7429',
      OCTOPUS_DIFF_WEB_HOST: '::',
      OCTOPUS_DIFF_WEB_PORT: '5173',
      OCTOPUS_DIFF_ALLOWED_HOSTS: 'odino,odino.local',
    });
    expect(webEnv(parse(['--loopback']))).toMatchObject({
      OCTOPUS_DIFF_WEB_HOST: '127.0.0.1',
      OCTOPUS_DIFF_ALLOWED_HOSTS: '',
    });
  });
});

describe('banner', () => {
  it('extracts the token from the daemon Open line only', () => {
    expect(tokenFromBannerLine('  Open:   http://127.0.0.1:7429/#token=abc_D-9')).toBe('abc_D-9');
    expect(tokenFromBannerLine('  LAN:    http://192.168.1.2:7429/#token=abc')).toBeNull();
    expect(tokenFromBannerLine('  Open:   http://127.0.0.1:7429/')).toBeNull();
  });

  it('recognises the already-running message', () => {
    expect(
      isAlreadyRunningLine('octopus-diff is already running (pid 12) with this state directory.'),
    ).toBe(true);
    expect(isAlreadyRunningLine('octopus-diff 0.0.0 is running')).toBe(false);
  });

  it('rewrites the token URL to the Vite port and LAN names', () => {
    expect(webAuthUrls(parse(['--web-port', '5183']), 'T')).toEqual([
      { label: 'Local', url: 'http://localhost:5183/#token=T' },
      { label: 'LAN', url: 'http://odino:5183/#token=T' },
      { label: 'LAN', url: 'http://odino.local:5183/#token=T' },
    ]);
    expect(webAuthUrls(parse(['--loopback']), 'T')).toEqual([
      { label: 'Local', url: 'http://127.0.0.1:5173/#token=T' },
    ]);
  });
});

describe('lanIPv4Addresses', () => {
  it('keeps non-internal IPv4 addresses once', () => {
    expect(
      lanIPv4Addresses({
        lo: [
          { address: '127.0.0.1', family: 'IPv4', internal: true },
          { address: '10.255.255.254', family: 'IPv4', internal: true },
        ],
        eth0: [
          { address: '192.168.1.2', family: 'IPv4', internal: false },
          { address: 'fe80::1', family: 'IPv6', internal: false },
        ],
        eth1: [{ address: '192.168.1.2', family: 'IPv4', internal: false }],
        none: undefined,
      }),
    ).toEqual(['192.168.1.2']);
  });
});

describe('createDaemonOutputFilter', () => {
  const banner = (token) => [
    '',
    '  octopus-diff 0.0.0 is running',
    '',
    `  Open:   http://127.0.0.1:7429/#token=${token}`,
    `  LAN:    http://10.0.0.5:7429/#token=${token}`,
    '  API:    http://127.0.0.1:7429',
    '  Press Ctrl+C to stop.',
    '',
  ];

  it('hides the banner and reports ready with its token, each restart', () => {
    const filter = createDaemonOutputFilter();
    const shown = [];
    const ready = [];
    const lines = [
      'warning: built web UI not found (looked in …); serving the API only.',
      '11:00:00.000 INFO  daemon listening url=http://127.0.0.1:7429',
      ...banner('A'),
      '[tsx] change in ./apps/daemon/src/app.ts Restarting...',
      ...banner('A'),
    ];
    for (const line of lines) {
      const result = filter(line);
      if (result.show) shown.push(line);
      if (result.ready) ready.push(result.token);
    }
    expect(shown).toEqual([
      '11:00:00.000 INFO  daemon listening url=http://127.0.0.1:7429',
      '[tsx] change in ./apps/daemon/src/app.ts Restarting...',
    ]);
    expect(ready).toEqual(['A', 'A']);
  });

  it('reports a null token when the banner has none, and flags already-running', () => {
    const filter = createDaemonOutputFilter();
    filter('  octopus-diff 0.0.0 is running');
    expect(filter('  Press Ctrl+C to stop.')).toEqual({ show: false, ready: true, token: null });
    expect(
      filter('octopus-diff is already running (pid 7) with this state directory.'),
    ).toMatchObject({ show: true, alreadyRunning: true });
  });

  it('gives up hiding after a runaway banner', () => {
    const filter = createDaemonOutputFilter();
    filter('  octopus-diff 0.0.0 is running');
    let result;
    for (let i = 0; i < 40; i++) result = filter(`line ${i}`);
    expect(result).toMatchObject({ ready: true });
    expect(filter('later').show).toBe(true);
  });
});
