import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createLogger, formatLogLine } from '../src/logger.js';
import {
  browserOpenCommands,
  openBrowser,
  powershellOpenArgs,
  type SpawnFn,
} from '../src/open-browser.js';

const URL = 'http://127.0.0.1:7428/?token=abc_DEF-123';

describe('browserOpenCommands', () => {
  it('uses open on macOS, rundll32 on Windows, xdg-open on Linux', () => {
    expect(browserOpenCommands(URL, 'darwin', false)).toEqual([{ command: 'open', args: [URL] }]);
    expect(browserOpenCommands(URL, 'win32', false)).toEqual([
      { command: 'rundll32', args: ['url.dll,FileProtocolHandler', URL] },
    ]);
    expect(browserOpenCommands(URL, 'linux', false)).toEqual([
      { command: 'xdg-open', args: [URL] },
    ]);
  });

  it('prefers the Windows browser on WSL', () => {
    expect(browserOpenCommands(URL, 'linux', true).map((c) => c.command)).toEqual([
      'wslview',
      'powershell.exe',
      'xdg-open',
    ]);
  });

  it('encodes the PowerShell command so no quoting applies', () => {
    const args = powershellOpenArgs("http://x/?a='b'");
    const encoded = args.at(-1) ?? '';
    expect(args).toContain('-EncodedCommand');
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(
      "Start-Process 'http://x/?a=''b'''",
    );
  });

  it('refuses anything that is not a plain http(s) URL', () => {
    expect(() => browserOpenCommands('file:///etc/passwd', 'linux', false)).toThrow(/non-http/);
    expect(() => browserOpenCommands('http://x/ y', 'linux', false)).toThrow(/non-http/);
    expect(() => browserOpenCommands('http://x/"; rm -rf ~', 'linux', false)).toThrow(/non-http/);
  });
});

function fakeSpawn(available: Set<string>): {
  spawn: SpawnFn;
  tried: string[];
  options: unknown[];
} {
  const tried: string[] = [];
  const options: unknown[] = [];
  const spawn: SpawnFn = (command, _args, opts) => {
    tried.push(command);
    options.push(opts);
    const child = Object.assign(new EventEmitter(), { unref: () => {} });
    queueMicrotask(() => {
      if (available.has(command)) child.emit('spawn');
      else
        child.emit(
          'error',
          Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }),
        );
    });
    return child as unknown as ReturnType<SpawnFn>;
  };
  return { spawn, tried, options };
}

describe('openBrowser', () => {
  it('falls back to the next opener when one is missing, never using a shell', async () => {
    const fake = fakeSpawn(new Set(['powershell.exe']));
    await expect(openBrowser(URL, 'linux', true, fake.spawn)).resolves.toBe('powershell.exe');
    expect(fake.tried).toEqual(['wslview', 'powershell.exe']);
    expect(fake.options[0]).toMatchObject({ shell: false, detached: true, stdio: 'ignore' });
  });

  it('rejects when nothing can open the URL', async () => {
    const fake = fakeSpawn(new Set());
    await expect(openBrowser(URL, 'linux', false, fake.spawn)).rejects.toThrow(
      /open the URL manually/,
    );
  });
});

describe('logger', () => {
  it('filters by level and formats fields', () => {
    const lines: string[] = [];
    const logger = createLogger(
      'info',
      (l) => lines.push(l),
      () => new Date('2026-11-08T01:02:03.456Z'),
    );
    logger.debug('hidden');
    logger.info('listening', { port: 7428, host: '127.0.0.1', note: 'two words' });
    logger.error('boom', { error: new Error('bad') });
    expect(lines).toEqual([
      '01:02:03.456 INFO  listening port=7428 host=127.0.0.1 note="two words"\n',
      '01:02:03.456 ERROR boom error="bad"\n',
    ]);
    const silent: string[] = [];
    createLogger('silent', (l) => silent.push(l)).error('x');
    expect(silent).toEqual([]);
    expect(formatLogLine('warn', 'm', undefined, new Date(0))).toBe('00:00:00.000 WARN  m\n');
  });
});
