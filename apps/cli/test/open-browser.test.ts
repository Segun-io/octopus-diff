import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, formatLogLine } from '../src/logger.js';
import {
  browserOpenCommands,
  LAUNCHER_TTL_MS,
  launcherHtml,
  openBrowser,
  POWERSHELL_STDIN_ARGS,
  powershellOpenScript,
  resolveOpener,
  type SpawnFn,
  type SpawnOptions,
  sweepLaunchers,
} from '../src/open-browser.js';
import { absolutePathEntries, resolveExecutable, withSafePath } from '../src/which.js';
import { makeTempDirs, type TempDirs } from './helpers.js';

const URL = 'http://127.0.0.1:7428/#token=abc_DEF-123';
const LAUNCHER = '/state/open-0123456789abcdef.html';

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
  await mkdir(dirs.stateDir, { recursive: true, mode: 0o700 });
});
afterEach(async () => {
  await dirs.cleanup();
});

describe('browserOpenCommands', () => {
  it('opens the launcher file: open on macOS, rundll32 on Windows, xdg-open on Linux', () => {
    expect(browserOpenCommands(URL, LAUNCHER, 'darwin', false)).toEqual([
      { command: 'open', args: [LAUNCHER] },
    ]);
    expect(browserOpenCommands(URL, LAUNCHER, 'win32', false)).toEqual([
      { command: 'rundll32', args: ['url.dll,FileProtocolHandler', LAUNCHER] },
    ]);
    expect(browserOpenCommands(URL, LAUNCHER, 'linux', false)).toEqual([
      { command: 'xdg-open', args: [LAUNCHER] },
    ]);
  });

  it('prefers the Windows browser on WSL, with the URL on PowerShell stdin', () => {
    const commands = browserOpenCommands(URL, LAUNCHER, 'linux', true);
    expect(commands.map((c) => c.command)).toEqual(['powershell.exe', 'xdg-open']);
    expect(commands[0]?.args).toEqual(POWERSHELL_STDIN_ARGS);
    expect(commands[0]?.stdin).toBe(`Start-Process '${URL}'\n`);
  });

  it('SEC-04: never puts the URL (or the token) on a command line', () => {
    for (const [platform, wsl] of [
      ['linux', false],
      ['linux', true],
      ['darwin', false],
      ['win32', false],
    ] as const) {
      for (const command of browserOpenCommands(URL, LAUNCHER, platform, wsl)) {
        expect(command.args.join(' ')).not.toContain('abc_DEF-123');
        expect(command.args.join(' ')).not.toContain('127.0.0.1');
      }
    }
  });

  it('quotes the URL for PowerShell', () => {
    expect(powershellOpenScript("http://x/?a='b'")).toBe("Start-Process 'http://x/?a=''b'''\n");
  });

  it('refuses anything that is not a plain http(s) URL', () => {
    for (const bad of [
      'file:///etc/passwd',
      'http://x/ y',
      'http://x/"; rm -rf ~',
      'http://x/<a>',
    ]) {
      expect(() => browserOpenCommands(bad, LAUNCHER, 'linux', false)).toThrow(/non-http/);
    }
  });
});

describe('launcher file', () => {
  it('redirects to the URL and escapes it for HTML', () => {
    const html = launcherHtml("http://127.0.0.1:1/?a=1&b='2'#token=t");
    expect(html).toContain(
      '<meta http-equiv="refresh" content="0; url=http://127.0.0.1:1/?a=1&amp;b=&#39;2&#39;#token=t">',
    );
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('sweeps launchers older than the TTL, and nothing else', async () => {
    const old = path.join(dirs.stateDir, 'open-00000000000000aa.html');
    const fresh = path.join(dirs.stateDir, 'open-00000000000000bb.html');
    const other = path.join(dirs.stateDir, 'open-notes.html');
    for (const f of [old, fresh, other]) await writeFile(f, 'x');
    const past = new Date(Date.now() - LAUNCHER_TTL_MS - 5_000);
    await utimes(old, past, past);
    await utimes(other, past, past);
    await sweepLaunchers(dirs.stateDir);
    expect((await readdir(dirs.stateDir)).sort()).toEqual([
      'open-00000000000000bb.html',
      'open-notes.html',
    ]);
  });
});

interface FakeSpawn {
  spawn: SpawnFn;
  tried: string[];
  options: SpawnOptions[];
  args: string[][];
  stdin: string[];
}

function fakeSpawn(available: Set<string>): FakeSpawn {
  const fake: FakeSpawn = {
    spawn: () => undefined as never,
    tried: [],
    options: [],
    args: [],
    stdin: [],
  };
  fake.spawn = (command, args, opts) => {
    fake.tried.push(command);
    fake.options.push(opts);
    fake.args.push(args);
    const child = Object.assign(new EventEmitter(), {
      unref: () => {},
      stdin: { end: (chunk: string) => fake.stdin.push(chunk), on: () => {} },
    });
    queueMicrotask(() => {
      if (available.has(command)) child.emit('spawn');
      else child.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    });
    return child;
  };
  return fake;
}

describe('openBrowser', () => {
  const resolve = (command: string) => `/abs/bin/${command}`;

  it('opens a 0600 launcher file from the state dir and deletes it later', async () => {
    const fake = fakeSpawn(new Set(['/abs/bin/xdg-open']));
    const used = await openBrowser(URL, {
      platform: 'linux',
      isWsl: false,
      stateDir: dirs.stateDir,
      env: { PATH: '/usr/bin:/bin' },
      spawn: fake.spawn,
      resolve,
      deleteAfterMs: 50,
    });
    expect(used).toBe('xdg-open');
    expect(fake.tried).toEqual(['/abs/bin/xdg-open']);
    const launcher = fake.args[0]?.[0] ?? '';
    expect(path.dirname(launcher)).toBe(dirs.stateDir);
    expect(path.basename(launcher)).toMatch(/^open-[0-9a-f]{16}\.html$/);
    expect((await stat(launcher)).mode & 0o777).toBe(0o600);
    expect(await readFile(launcher, 'utf8')).toContain(`url=${URL}`);
    expect(fake.options[0]).toMatchObject({
      detached: true,
      stdio: 'ignore',
      shell: false,
      cwd: dirs.stateDir,
    });
    await new Promise((r) => setTimeout(r, 120));
    await expect(stat(launcher)).rejects.toThrow();
  });

  it('on WSL writes the URL to PowerShell stdin, then falls back to xdg-open', async () => {
    const both = fakeSpawn(new Set(['/abs/bin/powershell.exe']));
    const opts = {
      platform: 'linux' as const,
      isWsl: true,
      stateDir: dirs.stateDir,
      env: {},
      resolve,
    };
    await expect(openBrowser(URL, { ...opts, spawn: both.spawn })).resolves.toBe('powershell.exe');
    expect(both.stdin).toEqual([`Start-Process '${URL}'\n`]);
    expect(both.options[0]?.stdio).toEqual(['pipe', 'ignore', 'ignore']);
    expect(both.args[0]?.join(' ')).not.toContain('token');

    const fallback = fakeSpawn(new Set(['/abs/bin/xdg-open']));
    await expect(openBrowser(URL, { ...opts, spawn: fallback.spawn })).resolves.toBe('xdg-open');
    expect(fallback.tried).toEqual(['/abs/bin/powershell.exe', '/abs/bin/xdg-open']);
  });

  it('SEC-03: skips openers that are not found instead of spawning a bare name', async () => {
    const fake = fakeSpawn(new Set(['xdg-open']));
    await expect(
      openBrowser(URL, {
        platform: 'linux',
        isWsl: false,
        stateDir: dirs.stateDir,
        env: {},
        spawn: fake.spawn,
        resolve: () => null,
      }),
    ).rejects.toThrow(/could not open a browser/);
    expect(fake.tried).toEqual([]);
    // No launcher left behind.
    expect((await readdir(dirs.stateDir)).filter((n) => n.startsWith('open-'))).toEqual([]);
  });

  it('gives openers a PATH without empty or relative entries', async () => {
    const fake = fakeSpawn(new Set(['/abs/bin/xdg-open']));
    await openBrowser(URL, {
      platform: 'linux',
      isWsl: false,
      stateDir: dirs.stateDir,
      env: { PATH: '/usr/bin::.:bin:/bin:', HOME: '/home/me' },
      spawn: fake.spawn,
      resolve,
    });
    expect(fake.options[0]?.env).toMatchObject({ PATH: '/usr/bin:/bin', HOME: '/home/me' });
  });

  it('SEC-03 (real spawn): a planted opener in the cwd or an empty PATH entry never runs', async () => {
    const planted = path.join(dirs.cwd, 'xdg-open');
    const marker = path.join(dirs.root, 'PWNED');
    await writeFile(planted, `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(planted, 0o755);
    const previous = process.cwd();
    process.chdir(dirs.cwd);
    try {
      await expect(
        openBrowser(URL, {
          platform: 'linux',
          isWsl: false,
          stateDir: dirs.stateDir,
          // Empty and relative entries only: the old bare-name spawn would have run ./xdg-open.
          env: { PATH: ':.:relative/bin' },
          spawn: spawn as unknown as SpawnFn,
        }),
      ).rejects.toThrow(/could not open a browser/);
    } finally {
      process.chdir(previous);
    }
    await new Promise((r) => setTimeout(r, 100));
    await expect(stat(marker)).rejects.toThrow();
  });
});

describe('resolveExecutable / resolveOpener (SEC-03)', () => {
  const exists = (files: string[]) => (file: string) => files.includes(file);

  it('uses only absolute PATH entries', () => {
    const env = { PATH: ':./bin:relative:/usr/local/bin:/usr/bin' };
    expect(absolutePathEntries(env, 'linux')).toEqual(['/usr/local/bin', '/usr/bin']);
    expect(
      resolveExecutable('git', { env, platform: 'linux', isExecutable: exists(['/usr/bin/git']) }),
    ).toBe('/usr/bin/git');
    expect(
      resolveExecutable('git', {
        env,
        platform: 'linux',
        isExecutable: exists(['./bin/git', 'git']),
      }),
    ).toBeNull();
    expect(
      resolveExecutable('git', { env: {}, platform: 'linux', isExecutable: () => true }),
    ).toBeNull();
  });

  it('accepts absolute commands and refuses relative paths', () => {
    const opts = {
      env: { PATH: '/usr/bin' },
      platform: 'linux' as const,
      isExecutable: () => true,
    };
    expect(resolveExecutable('/opt/git/bin/git', opts)).toBe('/opt/git/bin/git');
    expect(resolveExecutable('./git', opts)).toBeNull();
    expect(resolveExecutable('bin/git', opts)).toBeNull();
  });

  it('on Windows: never the cwd, tries .exe/.com, case-insensitive Path', () => {
    const env = { Path: 'C:\\Windows\\System32;.;;tools;"C:\\Program Files\\Git\\cmd"' };
    expect(absolutePathEntries(env, 'win32')).toEqual([
      'C:\\Windows\\System32',
      'C:\\Program Files\\Git\\cmd',
    ]);
    expect(
      resolveExecutable('git', {
        env,
        platform: 'win32',
        isExecutable: exists(['C:\\Program Files\\Git\\cmd\\git.exe', 'git.exe', '.\\git.exe']),
      }),
    ).toBe('C:\\Program Files\\Git\\cmd\\git.exe');
    expect(withSafePath(env, 'win32').Path).toBe(
      'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd',
    );
  });

  it('prefers %SystemRoot%\\System32\\rundll32.exe on Windows', () => {
    // existsSync on a Windows path is false here, so it falls back to the PATH lookup.
    expect(resolveOpener('rundll32', 'win32', { SystemRoot: 'C:\\Windows', PATH: '' })).toBeNull();
  });

  it('resolves real openers through PATH on this machine', () => {
    expect(resolveOpener('sh', 'linux', { PATH: '/usr/bin:/bin' })).toMatch(/^\/(usr\/)?bin\/sh$/);
    expect(resolveOpener('sh', 'linux', { PATH: '' })).toBeNull();
  });
});

describe('logger (SEC-09)', () => {
  it('formats logfmt-ish lines with quoted values', () => {
    const line = formatLogLine(
      'info',
      'daemon listening',
      { url: 'http://127.0.0.1:7428', path: '/a b', n: 3, skip: undefined },
      new Date('2026-11-08T12:34:56.789Z'),
    );
    expect(line).toBe(
      '12:34:56.789 INFO  daemon listening url=http://127.0.0.1:7428 path="/a b" n=3\n',
    );
  });

  it('respects the level', () => {
    const lines: string[] = [];
    const logger = createLogger('warn', (l) => lines.push(l));
    logger.info('hidden');
    logger.warn('shown');
    expect(lines).toHaveLength(1);
  });

  it('never writes control or bidi characters from repository-controlled values', () => {
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const csi8 = String.fromCharCode(0x9b);
    const rlo = String.fromCharCode(0x202e);
    const name = `x${esc}]0;OWNED-TITLE${bel}${esc}[2K${esc}[1Gbare${csi8}${rlo}`;
    const line = formatLogLine(
      'info',
      `project added${esc}[2K`,
      { name, commonDir: `/r/${name}/.git`, plain: `a${rlo}b` },
      new Date(0),
    );
    for (const ch of [esc, bel, csi8, rlo]) expect(line).not.toContain(ch);
    expect(line).toContain('name="x\\u001b]0;OWNED-TITLE\\u0007');
    expect(line).toContain('\\u009b\\u202e');
    expect(line.split('\n')).toHaveLength(2);
  });
});
