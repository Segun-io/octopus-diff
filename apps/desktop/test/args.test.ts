// The packaged-build argument rules (DECISIONS #502, #507, #509): an installed app refuses the
// dev-only options and every debugger switch; `--renderer-url` is loopback-only everywhere.
import { describe, expect, it } from 'vitest';
import {
  DesktopArgsError,
  isLoopbackHost,
  isRefusedPackagedSwitch,
  type ParseOptions,
  parseDesktopArgs,
  REFUSED_PACKAGED_SWITCHES,
  switchName,
} from '../src/args.js';

const PACKAGED = { isPackaged: true, platform: 'linux' } as const;
const PACKAGED_WIN = { isPackaged: true, platform: 'win32' } as const;
const UNPACKAGED = { isPackaged: false, platform: 'linux' } as const;

const refuses = (argv: string[], options: ParseOptions = PACKAGED) =>
  expect(() => parseDesktopArgs(argv, '/', options), argv.join(' ')).toThrow(DesktopArgsError);

describe('packaged build: dev-only options are refused', () => {
  it('--dev', () => {
    refuses(['--dev']);
    expect(parseDesktopArgs(['--dev'], '/', UNPACKAGED).dev).toBe(true);
  });

  it('--backend source (both forms), but --backend bundle is fine', () => {
    refuses(['--backend', 'source']);
    refuses(['--backend=source']);
    expect(parseDesktopArgs(['--backend', 'bundle'], '/', PACKAGED).backend).toBe('bundle');
    expect(parseDesktopArgs(['--backend', 'source'], '/', UNPACKAGED).backend).toBe('source');
  });

  it('--renderer-url, even a loopback one', () => {
    refuses(['--renderer-url', 'http://localhost:5173']);
    refuses(['--renderer-url=http://127.0.0.1:5173']);
    expect(
      parseDesktopArgs(['--renderer-url', 'http://localhost:5173'], '/', UNPACKAGED).rendererUrl,
    ).toBe('http://localhost:5173');
  });

  it('keeps the options an installed app may take', () => {
    expect(
      parseDesktopArgs(
        [
          '--state-dir',
          '/s',
          '--config-dir=/c',
          '--port',
          '7431',
          '--app-data-dir',
          '/a',
          '--no-sandbox',
          '--remote-debugging-pipe',
          '--enable-logging',
          '/some/file',
        ],
        '/',
        PACKAGED,
      ),
    ).toEqual({
      dev: false,
      backend: 'bundle',
      rendererUrl: null,
      stateDir: '/s',
      configDir: '/c',
      port: 7431,
      appDataDir: '/a',
    });
  });
});

describe('packaged build: debugger switches are refused', () => {
  it('every refused switch, with and without a value, with one or two dashes', () => {
    for (const name of REFUSED_PACKAGED_SWITCHES) {
      refuses([`--${name}`]);
      refuses([`--${name}=9222`]);
      refuses([`-${name}=9222`]);
    }
  });

  it('the ones Playwright and Node use', () => {
    refuses(['--remote-debugging-port=0']);
    refuses(['--inspect=0']);
    refuses(['--inspect-brk']);
    refuses(['--inspect-port=9229']);
    refuses(['--inspect-wait']); // a newer Node spelling: every inspect* is refused
    refuses(['--remote-debugging-address=0.0.0.0']);
  });

  it('also when our parser takes the switch as an option value (Chromium still reads it)', () => {
    refuses(['--state-dir', '-remote-debugging-port=9222']);
    refuses(['--app-data-dir', '-inspect']);
  });

  it('on Windows also /switch and any letter case', () => {
    refuses(['/remote-debugging-port=9222'], PACKAGED_WIN);
    refuses(['--Remote-Debugging-Port=9222'], PACKAGED_WIN);
    refuses(['/INSPECT'], PACKAGED_WIN);
    // A plain path is not a switch on Linux.
    expect(parseDesktopArgs(['/inspect'], '/', PACKAGED).dev).toBe(false);
  });

  it('an unpackaged run keeps them (the phase A smoke drives the window over the port)', () => {
    expect(() =>
      parseDesktopArgs(['--remote-debugging-port=9222', '--inspect=0'], '/', UNPACKAGED),
    ).not.toThrow();
  });

  it('the pipe, logging and sandbox switches are not debugger ports', () => {
    for (const name of ['remote-debugging-pipe', 'enable-logging', 'no-sandbox', 'debugger']) {
      expect(isRefusedPackagedSwitch(name), name).toBe(false);
    }
  });
});

describe('switchName', () => {
  it('reads Chromium spellings', () => {
    expect(switchName('--a-b=1', 'linux')).toBe('a-b');
    expect(switchName('-a-b', 'linux')).toBe('a-b');
    expect(switchName('/a-b', 'linux')).toBeNull();
    expect(switchName('/A-B=1', 'win32')).toBe('a-b');
    expect(switchName('--A', 'linux')).toBe('A');
    expect(switchName('--', 'linux')).toBeNull();
    expect(switchName('plain', 'linux')).toBeNull();
  });
});

describe('--renderer-url is loopback only (also unpackaged)', () => {
  it('accepts loopback hosts', () => {
    for (const url of [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://127.1.2.3',
      'http://[::1]:5173',
      'https://localhost',
    ]) {
      expect(parseDesktopArgs(['--renderer-url', url], '/', UNPACKAGED).rendererUrl, url).toBe(
        new URL(url).origin,
      );
    }
  });

  it('refuses any other host', () => {
    for (const url of [
      'http://example.com',
      'http://192.168.1.2:5173',
      'http://0.0.0.0:5173',
      'http://localhost.example.com',
      'http://127.0.0.1.example.com',
      'http://[::2]',
      'http://128.0.0.1',
    ]) {
      refuses(['--renderer-url', url], UNPACKAGED);
    }
  });

  it('isLoopbackHost', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.255.255.255')).toBe(true);
    expect(isLoopbackHost('127.256.0.1')).toBe(false);
    expect(isLoopbackHost('127.0.0')).toBe(false);
    expect(isLoopbackHost('::1')).toBe(false); // URL.hostname keeps the brackets
    expect(isLoopbackHost('[::1]')).toBe(true);
  });
});
