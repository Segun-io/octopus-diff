import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCommandLine } from '../src/args.js';
import { run } from '../src/cli.js';
import { rotateToken, writeRuntimeInfo } from '../src/runtime.js';
import { oneLine, safeOutput, terminalSafe } from '../src/terminal.js';
import { authUrlFor, isWildcardHost, lanAuthUrls, lanHosts } from '../src/urls.js';
import {
  Capture,
  clientFactory,
  healthFor,
  isHealth,
  makeDeps,
  makeTempDirs,
  type TempDirs,
} from './helpers.js';

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(async () => {
  await dirs.cleanup();
});

const TOKEN_FILE = () => path.join(dirs.stateDir, 'token');

describe('token command (SEC-11)', () => {
  it('parses --rotate and shows help', () => {
    expect(parseCommandLine(['token', '--rotate'])).toEqual({
      command: 'token',
      flags: { rotate: true },
    });
    expect(parseCommandLine(['token', '-h'])).toEqual({ command: 'help', topic: 'token' });
  });

  it('describes the token file without printing the token', async () => {
    const deps = makeDeps(dirs);
    expect(await run(['token'], deps)).toBe(0);
    expect(deps.out.text).toContain('not created yet');
    await rotateToken(dirs.stateDir);
    const token = (await readFile(TOKEN_FILE(), 'utf8')).trim();
    const again = makeDeps(dirs);
    expect(await run(['token'], again)).toBe(0);
    expect(again.out.text).toContain('(mode 600)');
    expect(again.out.text).not.toContain(token);
  });

  it('--rotate writes a new 0600 token file (a new inode) and never prints it', async () => {
    await rotateToken(dirs.stateDir);
    const before = (await readFile(TOKEN_FILE(), 'utf8')).trim();
    const inode = (await stat(TOKEN_FILE())).ino;
    const deps = makeDeps(dirs);
    expect(await run(['token', '--rotate'], deps)).toBe(0);
    const after = (await readFile(TOKEN_FILE(), 'utf8')).trim();
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const info = await stat(TOKEN_FILE());
    expect(info.mode & 0o777).toBe(0o600);
    expect(info.ino).not.toBe(inode);
    expect(deps.out.text).toContain('Replaced the auth token');
    expect(deps.out.text).toContain('octopus-diff serve');
    expect(deps.out.text).not.toContain(after);
    expect(deps.out.text).not.toContain(before);
  });

  it('--rotate tells a verified running daemon to be restarted', async () => {
    await rotateToken(dirs.stateDir);
    const old = (await readFile(TOKEN_FILE(), 'utf8')).trim();
    await writeRuntimeInfo(dirs.stateDir, {
      pid: 4242,
      url: 'http://127.0.0.1:40123',
      host: '127.0.0.1',
      port: 40_123,
      version: '0',
      startedAt: '2026-11-08T00:00:00.000Z',
    });
    const api = clientFactory((req) =>
      isHealth(req.url) ? { body: healthFor(req.url, old) } : undefined,
    );
    const deps = makeDeps(dirs, {
      createApiClient: api.createApiClient,
      isProcessAlive: (pid) => pid === 4242,
    });
    expect(await run(['token', '--rotate'], deps)).toBe(0);
    expect(deps.out.text).toContain('The running daemon (pid 4242, http://127.0.0.1:40123)');
    expect(deps.out.text).toContain('until it restarts');
    expect(api.requests.every((r) => r.authorization === null)).toBe(true);
  });
});

describe('URLs', () => {
  it('builds the #token= URL', () => {
    expect(authUrlFor('http://127.0.0.1:7428/', 'a-b_c')).toBe(
      'http://127.0.0.1:7428/#token=a-b_c',
    );
  });

  it('lists LAN hosts only for wildcard binds', () => {
    const interfaces = {
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
      eth0: [
        { address: '192.168.1.5', family: 'IPv4', internal: false } as never,
        { address: '2001:DB8::5', family: 'IPv6', internal: false } as never,
        { address: 'fe80::1', family: 'IPv6', internal: false } as never,
      ],
    };
    expect(isWildcardHost('0.0.0.0')).toBe(true);
    expect(isWildcardHost('[::]')).toBe(true);
    expect(isWildcardHost('127.0.0.1')).toBe(false);
    expect(lanHosts('127.0.0.1', interfaces)).toEqual([]);
    expect(lanHosts('192.168.1.5', interfaces)).toEqual([]);
    expect(lanHosts('0.0.0.0', interfaces)).toEqual(['192.168.1.5']);
    expect(lanHosts('::', interfaces)).toEqual(['192.168.1.5', '[2001:db8::5]']);
    expect(lanAuthUrls('::', 9, 'tok', interfaces)).toEqual([
      'http://192.168.1.5:9/#token=tok',
      'http://[2001:db8::5]:9/#token=tok',
    ]);
  });
});

describe('terminal-safe output (SEC-09)', () => {
  const ESC = String.fromCharCode(0x1b);
  const CR = String.fromCharCode(0x0d);
  const C1 = String.fromCharCode(0x9b);
  const RLO = String.fromCharCode(0x202e);
  const LSEP = String.fromCharCode(0x2028);

  it('escapes C0 (except tab and newline), DEL, C1, bidi and line separators', () => {
    const text = `a${ESC}[31mb${CR}c${C1}d${RLO}e${LSEP}f${String.fromCharCode(0x7f)}\tg\nh`;
    const safe = terminalSafe(text);
    for (const ch of [ESC, CR, C1, RLO, LSEP, String.fromCharCode(0x7f)]) {
      expect(safe).not.toContain(ch);
    }
    expect(safe).toBe(
      'a@u001b[31mb@u000dc@u009bd@u202ee@u2028f@u007f\tg\nh'.replaceAll(
        '@',
        String.fromCharCode(92),
      ),
    );
    expect(oneLine('x\ny\tz')).toBe('x@u000ay@u0009z'.replaceAll('@', String.fromCharCode(92)));
  });

  it('keeps JSON valid and equivalent', () => {
    const value = { name: `n${C1}${RLO}` };
    const safe = terminalSafe(JSON.stringify(value));
    expect(JSON.parse(safe)).toEqual(value);
  });

  it('wraps every write of a stream', () => {
    const capture = new Capture();
    safeOutput(capture).write(`x${ESC}y`);
    expect(capture.text).not.toContain(ESC);
  });

  it('applies to everything run() prints, e.g. an error message', async () => {
    const deps = makeDeps(dirs);
    expect(await run(['add', `${ESC}]0;OWNED${String.fromCharCode(7)}`], deps)).toBe(1);
    expect(deps.err.text).not.toContain(ESC);
    expect(deps.err.text).not.toContain(String.fromCharCode(7));
  });
});
