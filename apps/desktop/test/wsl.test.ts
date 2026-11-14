/** #22: the pure WSL rules: `wsl.exe -l -v`, the prerequisite probe, the `wsl.exe` command lines. */
import { type CliDeps, run as runCli } from 'octopus-diff';
import { describe, expect, it } from 'vitest';
import {
  decodeWslText,
  isSafeDistroName,
  isSystemDistro,
  parseWslList,
  parseWslProbe,
  WSL_LIST_ARGS,
  WSL_PROBE_SCRIPT,
  type WslProbe,
  wslProbeArgs,
  wslProblems,
  wslServeArgs,
} from '../src/wsl.js';

const utf16 = (text: string, bom = false) =>
  Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, 'utf16le')]);

/** The real bytes of `wsl.exe -l -v` on the dev machine (2026-11-14, WSL 2.x, en-US): no BOM. */
const REAL = Buffer.from(
  '20002000 4e004100 4d004500 20002000 20002000 20002000 53005400 41005400 45002000 20002000 20002000 20002000 20002000 20002000 56004500 52005300 49004f00 4e000d00 0a002a00 20005500 62007500 6e007400 75002000 20002000 20005200 75006e00 6e006900 6e006700 20002000 20002000 20002000 20002000 20003200 0d000a00'.replace(
    / /g,
    '',
  ),
  'hex',
);

describe('decodeWslText', () => {
  it('decodes UTF-16LE without a BOM (what wsl.exe writes to a pipe)', () => {
    expect(decodeWslText(REAL)).toBe(
      '  NAME      STATE           VERSION\r\n* Ubuntu    Running         2\r\n',
    );
  });

  it('decodes UTF-16LE with a BOM, and UTF-8 (WSL_UTF8=1), and drops the BOM', () => {
    expect(decodeWslText(utf16('  NAME\r\n', true))).toBe('  NAME\r\n');
    expect(decodeWslText(Buffer.from('﻿  NAME  STATE\n', 'utf8'))).toBe('  NAME  STATE\n');
    expect(decodeWslText(Buffer.from('* Übuntu  Running  2\n', 'utf8'))).toBe(
      '* Übuntu  Running  2\n',
    );
  });

  it('keeps non-ASCII names in UTF-16 (CJK, accents)', () => {
    expect(decodeWslText(utf16('  名前 Ünï\r\n'))).toBe('  名前 Ünï\r\n');
  });

  it('empty input is empty', () => {
    expect(decodeWslText(Buffer.alloc(0))).toBe('');
  });
});

describe('parseWslList', () => {
  it('parses the real output: one default, running, WSL 2 distro', () => {
    expect(parseWslList(REAL)).toEqual([
      {
        name: 'Ubuntu',
        state: 'running',
        stateText: 'Running',
        version: 2,
        isDefault: true,
        system: false,
      },
    ]);
  });

  it('several distros: stopped ones, WSL 1, docker-desktop, names with spaces and unicode', () => {
    const text = [
      '  NAME                   STATE           VERSION',
      '* Ubuntu-24.04           Running         2',
      '  docker-desktop         Stopped         2',
      '  docker-desktop-data    Stopped         2',
      '  Debian                 Stopped         1',
      '  My Distro              Running         2',
      '  Ubuntu 日本語           Stopped         2',
      '  rancher-desktop        Running         2',
      '',
    ].join('\r\n');
    const list = parseWslList(utf16(text));
    expect(list.map((d) => [d.name, d.state, d.version, d.isDefault, d.system])).toEqual([
      ['Ubuntu-24.04', 'running', 2, true, false],
      ['docker-desktop', 'stopped', 2, false, true],
      ['docker-desktop-data', 'stopped', 2, false, true],
      ['Debian', 'stopped', 1, false, false],
      ['My Distro', 'running', 2, false, false],
      ['Ubuntu 日本語', 'stopped', 2, false, false],
      ['rancher-desktop', 'running', 2, false, true],
    ]);
  });

  it('localized headers and states (German, Spanish): parsed by column, state kept as text', () => {
    const de = [
      '  NAME            STATUS             VERSION',
      '* Ubuntu          Wird ausgeführt    2',
      '  Debian          Beendet            2',
    ].join('\r\n');
    expect(parseWslList(utf16(de))).toEqual([
      {
        name: 'Ubuntu',
        state: 'other',
        stateText: 'Wird ausgeführt',
        version: 2,
        isDefault: true,
        system: false,
      },
      {
        name: 'Debian',
        state: 'other',
        stateText: 'Beendet',
        version: 2,
        isDefault: false,
        system: false,
      },
    ]);
    const es = ['  NOMBRE      ESTADO           VERSIÓN', '* Ubuntu      En ejecución     2'].join(
      '\n',
    );
    expect(parseWslList(utf16(es))).toMatchObject([
      { name: 'Ubuntu', stateText: 'En ejecución', version: 2, isDefault: true },
    ]);
  });

  it('a header-less list still parses (from the right: version, state, name)', () => {
    expect(parseWslList('* Ubuntu  Running  2\n  Alpine  Stopped  1\n')).toEqual([
      expect.objectContaining({ name: 'Ubuntu', isDefault: true, version: 2 }),
      expect.objectContaining({ name: 'Alpine', isDefault: false, version: 1 }),
    ]);
  });

  it('nothing installed, a usage text or garbage: no distros', () => {
    expect(
      parseWslList(
        utf16(
          "Windows Subsystem for Linux has no installed distributions.\r\nUse 'wsl.exe --list --online' to list available distributions\r\n",
        ),
      ),
    ).toEqual([]);
    expect(parseWslList('')).toEqual([]);
    expect(parseWslList('\u0000\u0000\u0000')).toEqual([]);
    expect(parseWslList('  NAME  STATE  VERSION\n* Ubuntu  Running  3\n')).toEqual([]);
  });

  it('drops names that are not safe to pass on a command line (and duplicates)', () => {
    const text = [
      '  NAME        STATE      VERSION',
      '  --exec      Running    2',
      '  a"b         Running    2',
      '  Ubuntu      Running    2',
      '  Ubuntu      Stopped    2',
    ].join('\n');
    expect(parseWslList(text).map((d) => d.name)).toEqual(['Ubuntu']);
  });
});

describe('parseWslList on hostile output (review LOW 1)', () => {
  it('a 500k-character line of spaces is parsed in linear time, and skipped', () => {
    const line = `${' '.repeat(500_000)}x`;
    const t0 = performance.now();
    expect(parseWslList(`  NAME  STATE  VERSION\n${line}\n* Ubuntu  Running  2\n`)).toEqual([
      expect.objectContaining({ name: 'Ubuntu' }),
    ]);
    expect(performance.now() - t0).toBeLessThan(250);
  });

  it('trailing whitespace of 500k characters after a row: still fast, row still read', () => {
    const t0 = performance.now();
    const list = parseWslList(`* Ubuntu  Running  2${' '.repeat(500_000)}\n`);
    expect(performance.now() - t0).toBeLessThan(250);
    expect(list).toEqual([expect.objectContaining({ name: 'Ubuntu', isDefault: true })]);
  });

  it('a row longer than 512 characters is skipped, not parsed', () => {
    const long = `  Ubuntu  ${'Running '.repeat(80).trim()}  2`;
    expect(long.length).toBeGreaterThan(512);
    expect(parseWslList(`  NAME  STATE  VERSION\n${long}\n  Debian  Stopped  2\n`)).toEqual([
      expect.objectContaining({ name: 'Debian' }),
    ]);
  });

  it('only the first 256 lines are read', () => {
    const rows = Array.from({ length: 300 }, (_, i) => `  d${i}  Stopped  2`).join('\n');
    const list = parseWslList(`  NAME  STATE  VERSION\n${rows}\n`);
    expect(list.length).toBe(255);
    expect(list.at(-1)?.name).toBe('d254');
  });
});

describe('isSystemDistro / isSafeDistroName', () => {
  it('marks the distros tools run for themselves', () => {
    for (const name of [
      'docker-desktop',
      'docker-desktop-data',
      'Docker-Desktop',
      'rancher-desktop',
      'rancher-desktop-data',
      'podman-machine-default',
      'podman-machine-dev',
    ]) {
      expect(isSystemDistro(name), name).toBe(true);
    }
    for (const name of ['Ubuntu', 'docker', 'my-docker-desktop', 'podman']) {
      expect(isSystemDistro(name), name).toBe(false);
    }
  });

  it('accepts letters, digits, spaces and ._- inside; nothing hostile', () => {
    for (const ok of ['Ubuntu', 'Ubuntu-24.04', 'My Distro', 'Ubuntu 日本語', 'a', 'x_y.z']) {
      expect(isSafeDistroName(ok), ok).toBe(true);
    }
    for (const bad of [
      '',
      '-d',
      '--exec',
      ' Ubuntu',
      'Ubuntu ',
      'a"b',
      "a'b",
      'a\\b',
      'a/b',
      'a;b',
      'a&b',
      'a|b',
      'a$b',
      'a`b',
      'a\nb',
      'a\u0000b',
      'a\tb',
      'x'.repeat(65),
      'My  Distro',
    ]) {
      expect(isSafeDistroName(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('wsl.exe command lines', () => {
  it('lists with --list --verbose', () => {
    expect(WSL_LIST_ARGS).toEqual(['--list', '--verbose']);
  });

  it('probes with the script on stdin: no shell command line, the distro its own argument', () => {
    expect(wslProbeArgs('My Distro')).toEqual([
      '-d',
      'My Distro',
      '--cd',
      '~',
      '--exec',
      '/bin/sh',
      '-s',
    ]);
    expect(() => wslProbeArgs('--exec')).toThrow(/not a valid WSL distro name/);
  });

  it('the probe script only asks (no install, no write) and prints RS-prefixed answers', () => {
    expect(WSL_PROBE_SCRIPT).toContain('command -v octopus-diff');
    expect(WSL_PROBE_SCRIPT).toContain('node --version');
    expect(WSL_PROBE_SCRIPT).toContain('git --version');
    expect(WSL_PROBE_SCRIPT).toContain('--ready-stdout');
    expect(WSL_PROBE_SCRIPT).not.toMatch(
      /\b(apt|apt-get|dnf|yum|npm|pnpm|curl|wget|sudo|rm|mkdir)\b/,
    );
    expect(WSL_PROBE_SCRIPT).not.toMatch(/>\s*[^&/]/); // no redirect into a file other than /dev/null
  });

  it('serve: --exec env with the probed PATH, the CLI by absolute path, stdout ready frame, loopback', () => {
    const nonce = 'n'.repeat(32);
    expect(
      wslServeArgs({
        distro: 'Ubuntu 日本語',
        path: '/home/u/.nvm/versions/node/v24.1.0/bin:/usr/bin:/bin',
        cli: '/home/u/.nvm/versions/node/v24.1.0/bin/octopus-diff',
        nonce,
        port: null,
      }),
    ).toEqual([
      '-d',
      'Ubuntu 日本語',
      '--cd',
      '~',
      '--exec',
      '/usr/bin/env',
      'PATH=/home/u/.nvm/versions/node/v24.1.0/bin:/usr/bin:/bin',
      '/home/u/.nvm/versions/node/v24.1.0/bin/octopus-diff',
      'serve',
      `--ready-stdout=${nonce}`,
      '--exit-with-stdin',
      '--no-open',
      '--host',
      '127.0.0.1',
    ]);
    expect(
      wslServeArgs({
        distro: 'Ubuntu',
        path: '/usr/bin',
        cli: '/usr/bin/octopus-diff',
        nonce,
        port: 0,
      }),
    ).toEqual(expect.arrayContaining(['--port', '0']));
  });

  it('serve: a nonce starting with "-" survives the real CLI parser (the --ready-stdout=<nonce> form)', async () => {
    const nonce = `-${'a'.repeat(31)}`;
    const args = wslServeArgs({
      distro: 'Ubuntu',
      path: '/usr/bin',
      cli: '/usr/bin/octopus-diff',
      nonce,
      port: 0,
    });
    expect(args).toContain(`--ready-stdout=${nonce}`);
    expect(args).not.toContain('--ready-stdout');
    // What octopus-diff receives after `env PATH=… <cli>`: the CLI's own parser, with --help so it
    // stops after parsing (an ambiguous option value exits 2 before that).
    const tail = args.slice(args.indexOf('/usr/bin/octopus-diff') + 1);
    const out: string[] = [];
    const deps = {
      stdout: { write: (t: string) => out.push(t) },
      stderr: { write: (t: string) => out.push(t) },
    } as unknown as CliDeps;
    expect(await runCli([...tail, '--help'], deps)).toBe(0);
    // The separate-argument form is exactly what failed 1 run in 64 (review MEDIUM 1).
    expect(await runCli(['serve', '--ready-stdout', nonce, '--help'], deps)).toBe(2);
    expect(out.join('')).toContain('ambiguous');
  });

  it('serve: hostile values are refused, never passed', () => {
    const base = {
      distro: 'Ubuntu',
      path: '/usr/bin',
      cli: '/usr/bin/octopus-diff',
      nonce: 'n'.repeat(32),
      port: null,
    };
    expect(() => wslServeArgs({ ...base, distro: '-e' })).toThrow(/distro/);
    expect(() => wslServeArgs({ ...base, cli: 'octopus-diff' })).toThrow(/absolute/);
    expect(() => wslServeArgs({ ...base, cli: '/a=b/octopus-diff' })).toThrow(/=/);
    expect(() => wslServeArgs({ ...base, cli: '/a\nb' })).toThrow(/control/);
    expect(() => wslServeArgs({ ...base, path: '/usr/bin\n/x' })).toThrow(/control/);
    expect(() => wslServeArgs({ ...base, nonce: 'short' })).toThrow(/nonce/);
    expect(() => wslServeArgs({ ...base, port: 70_000 })).toThrow(/port/);
  });
});

const RS = '\u001e';
const probeOutput = (lines: Record<string, string>, end = true) =>
  `${Object.entries(lines)
    .map(([k, v]) => `${RS}od:${k}=${v}`)
    .join('\n')}\n${end ? `${RS}od:end=1\n` : ''}`;

const GOOD = {
  path: '/home/u/.nvm/versions/node/v24.1.0/bin:/usr/bin',
  home: '/home/u',
  cli: '/home/u/.nvm/versions/node/v24.1.0/bin/octopus-diff',
  node: 'v24.1.0',
  git: 'git version 2.43.0',
  cliVersion: '0.1.0',
  readyStdout: '1',
  env: '/usr/bin/env',
};

describe('parseWslProbe', () => {
  it('reads the answers and ignores everything else (shell noise, other lines)', () => {
    const text = `Welcome to Ubuntu!\n\u001b]0;title\u0007${probeOutput(GOOD)}od:node=v1\n`;
    expect(parseWslProbe(text)).toEqual({
      path: GOOD.path,
      home: '/home/u',
      cli: GOOD.cli,
      node: 'v24.1.0',
      git: 'git version 2.43.0',
      cliVersion: '0.1.0',
      readyStdout: true,
      env: '/usr/bin/env',
    } satisfies WslProbe);
  });

  it('CRLF, the first answer wins, control characters in a value drop it', () => {
    const text = `${RS}od:node=v24.0.0\r\n${RS}od:node=v99.0.0\r\n${RS}od:git=git\u0007 version 2.50\r\n${RS}od:end=1\r\n`;
    expect(parseWslProbe(text)).toMatchObject({ node: 'v24.0.0', git: null });
  });

  it('no end marker: the probe did not finish (null)', () => {
    expect(parseWslProbe(probeOutput(GOOD, false))).toBeNull();
    expect(parseWslProbe('')).toBeNull();
  });
});

describe('wslProblems', () => {
  const probe = (over: Partial<WslProbe> = {}): WslProbe => ({
    ...(parseWslProbe(probeOutput(GOOD)) as WslProbe),
    ...over,
  });
  const kinds = (p: WslProbe) => wslProblems(p, { minNode: 24, minGit: '2.31' }).map((x) => x.kind);

  it('nothing missing', () => {
    expect(kinds(probe())).toEqual([]);
  });

  it('each missing or old prerequisite, with copyable instructions', () => {
    expect(kinds(probe({ cli: null, cliVersion: null, readyStdout: false }))).toEqual([
      'cli-missing',
    ]);
    expect(kinds(probe({ node: null }))).toEqual(['node-missing']);
    expect(kinds(probe({ node: 'v22.11.0' }))).toEqual(['node-old']);
    expect(kinds(probe({ node: 'v24.0.0' }))).toEqual([]);
    expect(kinds(probe({ node: 'garbage' }))).toEqual(['node-old']);
    expect(kinds(probe({ git: null }))).toEqual(['git-missing']);
    expect(kinds(probe({ git: 'git version 2.30.9' }))).toEqual(['git-old']);
    expect(kinds(probe({ git: 'git version 2.31.0.windows.1' }))).toEqual([]);
    expect(kinds(probe({ readyStdout: false }))).toEqual(['cli-old']);
    expect(kinds(probe({ cli: '/a=b/octopus-diff' }))).toEqual(['cli-path']);
    expect(kinds(probe({ cli: 'octopus-diff' }))).toEqual(['cli-path']);
    expect(kinds(probe({ env: null }))).toEqual(['env-missing']);
    expect(kinds(probe({ node: null, git: null, cli: null }))).toEqual([
      'cli-missing',
      'node-missing',
      'git-missing',
    ]);
    for (const p of wslProblems(probe({ node: null, git: null, cli: null }), {
      minNode: 24,
      minGit: '2.31',
    })) {
      expect(p.text.length).toBeGreaterThan(10);
      expect(p.commands.length).toBeGreaterThan(0);
    }
  });
});
