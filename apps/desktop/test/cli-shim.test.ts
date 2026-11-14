// biome-ignore-all lint/suspicious/noTemplateCurlyInString: hostile test strings contain `${…}` on purpose.
/**
 * The pure parts of the `octopus-diff` command installer (docs/DESKTOP.md §3.2, roadmap #21): quoting
 * for sh and cmd, the launcher text, the marker, where the launcher goes, which target it runs
 * (AppImage, mounted dmg), PATH checks and the install/update/refuse decision. The sh launchers are
 * also RUN here (POSIX only) against fake executables in hostile directory names.
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  addToUserPathValue,
  CliShimError,
  cmdText,
  cmdWord,
  decide,
  type FileFacts,
  isOwnLauncher,
  type LauncherTarget,
  launcherApp,
  launcherLocation,
  MARKER,
  pathCandidates,
  pathContainsDir,
  renderLauncher,
  resolveTarget,
  shellWord,
} from '../src/cli-shim.js';

const posix = process.platform !== 'win32';
const root = mkdtempSync(path.join(tmpdir(), 'octopus-diff-shim-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Names that break naive quoting in a shell. */
const HOSTILE = [
  'plain',
  'with space',
  "it's",
  'say "hi"',
  'dollar $HOME and ${X} and $(id)',
  'back `id` tick',
  'semi; amp & pipe | gt > lt < star * q ? bang !',
  'back\\slash',
  'two\nlines',
  'tab\there',
  'ünï–cødé 日本語 🐙',
  '-dash-first',
  '',
];

describe('shellWord', () => {
  it('quotes everything inside single quotes', () => {
    expect(shellWord('/a b/c')).toBe("'/a b/c'");
    expect(shellWord("it's")).toBe(`'it'"'"'s'`);
    expect(shellWord('')).toBe("''");
  });

  it('rejects a NUL (no path holds one, and a shell cannot)', () => {
    expect(() => shellWord('a\0b')).toThrow(CliShimError);
  });

  it.runIf(posix)('survives a real sh for every hostile string', () => {
    for (const value of HOSTILE) {
      const run = spawnSync('/bin/sh', ['-c', `printf %s ${shellWord(value)}`], {
        encoding: 'utf8',
      });
      expect(run.stdout, JSON.stringify(value)).toBe(value);
    }
  });
});

describe('cmdText / cmdWord', () => {
  it('doubles % (cmd expands it even inside quotes) and leaves the other specials alone', () => {
    expect(cmdText('C:\\100%\\%PATH%')).toBe('C:\\100%%\\%%PATH%%');
    expect(cmdWord('C:\\Program Files (x86)\\a&b^c!d')).toBe('"C:\\Program Files (x86)\\a&b^c!d"');
  });

  it('rejects what a Windows path cannot hold and what would end the line or the quote', () => {
    for (const bad of ['a"b', 'a\nb', 'a\rb', 'a\0b']) {
      expect(() => cmdWord(bad), JSON.stringify(bad)).toThrow(CliShimError);
      expect(() => cmdText(bad), JSON.stringify(bad)).toThrow(CliShimError);
    }
  });
});

const direct: LauncherTarget = {
  kind: 'direct',
  executable: '/opt/octopus-diff/octopus-diff-desktop',
  entry: '/opt/octopus-diff/resources/app.asar/dist/cli/index.js',
};
const windows: LauncherTarget = {
  kind: 'windows',
  executable: 'C:\\Users\\a\\AppData\\Local\\Programs\\octopus-diff\\octopus-diff.exe',
  entry:
    'C:\\Users\\a\\AppData\\Local\\Programs\\octopus-diff\\resources\\app.asar\\dist\\cli\\index.js',
};
const appImage: LauncherTarget = {
  kind: 'appimage',
  appImage: '/home/a/Apps/octopus-diff-1.0.0.AppImage',
  executable: 'octopus-diff-desktop',
  entry: 'resources/app.asar/dist/cli/index.js',
};

describe('renderLauncher (sh, installed layout)', () => {
  const text = renderLauncher(direct);

  it('is a sh script with the marker on line 2 and RUN_AS_NODE exported', () => {
    const lines = text.split('\n');
    expect(lines[0]).toBe('#!/bin/sh');
    expect(lines[1]).toBe(`# ${MARKER}`);
    expect(text).toContain('export ELECTRON_RUN_AS_NODE=1');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('runs the app binary on the bundled entry and forwards the arguments', () => {
    expect(text).toContain(
      `exec "$app" '/opt/octopus-diff/resources/app.asar/dist/cli/index.js' "$@"`,
    );
    expect(text).toContain("app='/opt/octopus-diff/octopus-diff-desktop'");
  });

  it('says the app moved (exit 127) instead of failing obscurely', () => {
    expect(text).toContain('if [ ! -x "$app" ]; then');
    expect(text).toContain('exit 127');
  });

  it('never puts a path outside a quoted word (a hostile path cannot add a line)', () => {
    const hostile = renderLauncher({
      kind: 'direct',
      executable: "/x/a'\n; rm -rf ~ #",
      entry: '/x/$(id)`id`\nexit 0',
    });
    expect(hostile.split('\n').filter((l) => l.startsWith('rm'))).toEqual([]);
    expect(isOwnLauncher(hostile)).toBe(true);
  });
});

describe.runIf(posix)('the sh launcher, run for real', () => {
  const runLauncher = (
    target: LauncherTarget,
    args: string[],
    env: Record<string, string> = {},
  ) => {
    const dir = mkdtempSync(path.join(root, 'l-'));
    const file = path.join(dir, 'octopus-diff');
    writeFileSync(file, renderLauncher(target), { mode: 0o755 });
    return spawnSync('/bin/sh', [file, ...args], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    });
  };
  /** A fake app: prints RUN_AS_NODE, then each argument NUL-terminated; exits with 7. */
  const fakeApp = (file: string): void => {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `#!/bin/sh\nprintf 'node=%s\\0' "$ELECTRON_RUN_AS_NODE"\nfor a in "$@"; do printf '%s\\0' "$a"; done\nexit 7\n`,
      { mode: 0o755 },
    );
    chmodSync(file, 0o755);
  };

  it('passes the entry and every argument through, with RUN_AS_NODE set, and keeps the exit code', () => {
    for (const name of HOSTILE.filter((n) => n !== '')) {
      const executable = path.join(root, 'hostile', name, 'app bin');
      fakeApp(executable);
      const entry = path.join(root, 'hostile', name, 'resources', 'app.asar', 'index.js');
      const run = runLauncher({ kind: 'direct', executable, entry }, [
        'add',
        name,
        '--flag=a b',
        '',
        '$HOME',
      ]);
      expect(run.status, JSON.stringify(name)).toBe(7);
      expect(run.stdout.split('\0'), JSON.stringify(name)).toEqual([
        'node=1',
        entry,
        'add',
        name,
        '--flag=a b',
        '',
        '$HOME',
        '',
      ]);
    }
  });

  it('says so (127) when the app is gone', () => {
    const run = runLauncher({ kind: 'direct', executable: '/no/such/app', entry: '/x' }, [
      'status',
    ]);
    expect(run.status).toBe(127);
    expect(run.stderr).toMatch(/octopus-diff/);
    expect(run.stderr).toMatch(/moved or removed/);
  });

  describe('AppImage', () => {
    /** A fake AppImage runtime: `--appimage-mount` prints the mount dir and stays up. */
    const fakeAppImage = (dir: string, mode: 'mount' | 'extract-only') => {
      const mount = path.join(dir, 'mnt with space');
      fakeApp(path.join(mount, 'octopus-diff-desktop'));
      const pidfile = path.join(dir, 'mounter.pid');
      const file = path.join(dir, 'fake.AppImage');
      writeFileSync(
        file,
        [
          '#!/bin/sh',
          'case "$1" in',
          '  --appimage-mount)',
          mode === 'mount'
            ? `    echo $$ > ${shellWord(pidfile)}; printf '%s\\n' ${shellWord(mount)}; exec sleep 30 ;;`
            : '    echo "FUSE missing" >&2; exit 1 ;;',
          '  --appimage-extract)',
          `    mkdir squashfs-root && cp -R ${shellWord(`${mount}/`)}. squashfs-root/ && echo extracted > ${shellWord(path.join(dir, 'extracted'))} ;;`,
          'esac',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      return { file, mount, pidfile };
    };
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    const entryRel = 'resources/app.asar/dist/cli/index.js';

    it('mounts the image, runs the CLI inside it, forwards arguments and the exit code, unmounts', () => {
      const dir = mkdtempSync(path.join(root, 'ai-'));
      const { file, mount, pidfile } = fakeAppImage(dir, 'mount');
      const run = runLauncher(
        { kind: 'appimage', appImage: file, executable: 'octopus-diff-desktop', entry: entryRel },
        ['status', 'a b'],
        { APPIMAGE_EXTRACT_AND_RUN: '1' },
      );
      expect(run.stderr, 'no noise from the polling loop').toBe('');
      expect(run.status).toBe(7);
      expect(run.stdout.split('\0')).toEqual([
        'node=1',
        path.join(mount, entryRel),
        'status',
        'a b',
        '',
      ]);
      const pid = Number(readFileSync(pidfile, 'utf8'));
      const deadline = Date.now() + 3000;
      while (alive(pid) && Date.now() < deadline) spawnSync('sleep', ['0.05']);
      expect(alive(pid), 'the mounter is stopped when the command ends').toBe(false);
    });

    it('extracts the image when it cannot be mounted (no FUSE)', () => {
      const dir = mkdtempSync(path.join(root, 'ai-'));
      const { file } = fakeAppImage(dir, 'extract-only');
      const run = runLauncher(
        { kind: 'appimage', appImage: file, executable: 'octopus-diff-desktop', entry: entryRel },
        ['status'],
      );
      expect(run.stderr).toBe('');
      expect(run.status).toBe(7);
      expect(run.stdout.split('\0')[0]).toBe('node=1');
      expect(run.stdout.split('\0')[1]).toMatch(
        /squashfs-root\/resources\/app\.asar\/dist\/cli\/index\.js$/,
      );
    });

    /** A fake app that records its pid and then sleeps (`exec` keeps the pid). */
    const sleepingApp = (file: string, pidfile: string): void => {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, `#!/bin/sh\necho $$ > ${shellWord(pidfile)}\nexec sleep 30\n`, {
        mode: 0o755,
      });
    };
    const waitFor = async (what: string, condition: () => boolean, ms = 8000) => {
      const deadline = Date.now() + ms;
      while (!condition()) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 25));
      }
    };
    const pidOf = (file: string) => Number(readFileSync(file, 'utf8').trim());

    // Findings of the PR #110 review: no signal forwarding, and SIGHUP skipped the EXIT trap.
    for (const [signal, code] of [
      ['SIGTERM', 143],
      ['SIGHUP', 129],
      ['SIGINT', 130],
    ] as const) {
      for (const mode of ['mount', 'extract-only'] as const) {
        it(`${signal} (${mode}): the CLI is stopped, the mount and the work dir are cleaned up, exit ${code}`, async () => {
          const dir = mkdtempSync(path.join(root, 'sig-'));
          const tmp = path.join(dir, 'tmp');
          mkdirSync(tmp);
          const { file, mount, pidfile } = fakeAppImage(dir, mode);
          const childPid = path.join(dir, 'child.pid');
          sleepingApp(path.join(mount, 'octopus-diff-desktop'), childPid);
          const launcher = path.join(dir, 'octopus-diff');
          writeFileSync(
            launcher,
            renderLauncher({
              kind: 'appimage',
              appImage: file,
              executable: 'octopus-diff-desktop',
              entry: entryRel,
            }),
            { mode: 0o755 },
          );
          const run = spawn('/bin/sh', [launcher, 'serve'], {
            env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmp },
            stdio: 'ignore',
          });
          const exited = new Promise<{ code: number | null; signal: string | null }>((done) =>
            run.on('exit', (c, s) => done({ code: c, signal: s })),
          );
          await waitFor('the CLI to start', () => existsSync(childPid));
          const cli = pidOf(childPid);
          run.kill(signal);
          const result = await exited;
          expect(result, signal).toEqual({ code, signal: null });
          await waitFor('the CLI to stop', () => !alive(cli));
          if (mode === 'mount') {
            await waitFor('the mounter to stop', () => !alive(pidOf(pidfile)));
          }
          expect(readdirSync(tmp), 'the work dir is removed').toEqual([]);
        });
      }
    }

    it('a CLI that ignores TERM is killed after a few seconds, and the work dir still goes', async () => {
      const dir = mkdtempSync(path.join(root, 'stubborn-'));
      const tmp = path.join(dir, 'tmp');
      mkdirSync(tmp);
      const { file, mount } = fakeAppImage(dir, 'mount');
      const childPid = path.join(dir, 'child.pid');
      writeFileSync(
        path.join(mount, 'octopus-diff-desktop'),
        `#!/bin/sh\ntrap '' TERM\necho $$ > ${shellWord(childPid)}\nwhile :; do sleep 1; done\n`,
        { mode: 0o755 },
      );
      const launcher = path.join(dir, 'octopus-diff');
      writeFileSync(
        launcher,
        renderLauncher({
          kind: 'appimage',
          appImage: file,
          executable: 'octopus-diff-desktop',
          entry: entryRel,
        }),
        { mode: 0o755 },
      );
      const run = spawn('/bin/sh', [launcher], {
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', TMPDIR: tmp },
        stdio: 'ignore',
      });
      const exited = new Promise<number | null>((done) => run.on('exit', (c) => done(c)));
      await waitFor('the CLI to start', () => existsSync(childPid));
      const cli = pidOf(childPid);
      run.kill('SIGTERM');
      expect(await exited).toBe(143);
      await waitFor('the CLI to be killed', () => !alive(cli), 3000);
      expect(readdirSync(tmp)).toEqual([]);
    }, 20_000);

    it('stdin reaches the CLI (it runs in the background so it can be signalled)', () => {
      const dir = mkdtempSync(path.join(root, 'in-'));
      const { file, mount } = fakeAppImage(dir, 'mount');
      writeFileSync(path.join(mount, 'octopus-diff-desktop'), '#!/bin/sh\ncat\nexit 3\n', {
        mode: 0o755,
      });
      const launcher = path.join(dir, 'octopus-diff');
      writeFileSync(
        launcher,
        renderLauncher({
          kind: 'appimage',
          appImage: file,
          executable: 'octopus-diff-desktop',
          entry: entryRel,
        }),
        { mode: 0o755 },
      );
      const run = spawnSync('/bin/sh', [launcher], {
        input: 'typed input\n',
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      });
      expect(run.stdout).toBe('typed input\n');
      expect(run.status).toBe(3);
    });

    it('says so (127) when the AppImage file is gone', () => {
      const run = runLauncher(
        { kind: 'appimage', appImage: '/no/such.AppImage', executable: 'x', entry: entryRel },
        [],
      );
      expect(run.status).toBe(127);
      expect(run.stderr).toMatch(/moved or removed/);
    });
  });
});

describe('renderLauncher (AppImage text)', () => {
  const text = renderLauncher(appImage);
  it('runs the AppImage file itself, never a mount path from the install run', () => {
    expect(text).toContain("app='/home/a/Apps/octopus-diff-1.0.0.AppImage'");
    expect(text).toContain('--appimage-mount');
    expect(text).not.toMatch(/\.mount_/);
    expect(text).toContain('unset APPIMAGE_EXTRACT_AND_RUN');
    expect(text).toContain('export ELECTRON_RUN_AS_NODE=1');
    expect(text.split('\n')[1]).toBe(`# ${MARKER}`);
  });
  it('keeps the relative paths quoted', () => {
    const hostile = renderLauncher({
      ...appImage,
      executable: "bin/it's",
      entry: 'a b/$(id)',
    });
    expect(hostile).toContain(`"$mount"/'bin/it'"'"'s'`);
    expect(hostile).toContain(`"$mount"/'a b/$(id)'`);
  });
});

describe('renderLauncher (Windows .cmd)', () => {
  const text = renderLauncher(windows);
  const lines = text.split('\r\n');

  it('uses CRLF, hides echo, carries an ASCII marker on line 2 and no delayed expansion', () => {
    expect(text).not.toMatch(/(?<!\r)\n/);
    expect(lines[0]).toBe('@echo off');
    expect(lines[1]).toBe(`rem ${MARKER}`);
    expect(text).toContain('setlocal EnableExtensions DisableDelayedExpansion');
    expect(text).toContain('set "ELECTRON_RUN_AS_NODE=1"');
  });

  it('checks the app exists with a goto (a parenthesized block breaks on "Program Files (x86)")', () => {
    expect(text).toContain(`if exist "${windows.executable}" goto run`);
    expect(lines.some((l) => l.trim() === ')' || l.endsWith('('))).toBe(false);
    expect(text).toContain('exit /b 127');
    expect(text).toContain(':run');
  });

  it('runs the app on the entry, forwards %* and returns its exit code', () => {
    const i = lines.indexOf(':run');
    const run = `"${(windows as { executable: string }).executable}" "${(windows as { entry: string }).entry}" %*`;
    expect(lines[i + 1]).toBe(run);
    expect(lines.slice(i + 2).join('\r\n')).toContain('exit /b');
  });

  it('ASCII paths: no code-page switching', () => {
    expect(text).not.toContain('chcp');
  });

  it('doubles % in paths', () => {
    const t = renderLauncher({ ...windows, executable: 'C:\\100%\\app.exe' });
    expect(t).toContain('"C:\\100%%\\app.exe"');
  });

  it('keeps cmd specials inside quotes untouched', () => {
    const t = renderLauncher({ ...windows, executable: 'C:\\a&b (x86)\\^c!d\\app.exe' });
    expect(t).toContain('"C:\\a&b (x86)\\^c!d\\app.exe"');
  });

  it('non-ASCII paths: UTF-8 code page before the first such line, restored on every exit', () => {
    const t = renderLauncher({
      ...windows,
      executable: 'C:\\Users\\Zoë 日本\\AppData\\Local\\Programs\\octopus-diff\\octopus-diff.exe',
    });
    const l = t.split('\r\n');
    const first = l.findIndex((line) => /[\u0080-\u{10ffff}]/u.test(line));
    const switchTo = l.indexOf('chcp 65001 >nul');
    expect(first).toBeGreaterThan(0);
    expect(switchTo).toBeGreaterThan(0);
    expect(switchTo).toBeLessThan(first);
    // The marker and every line before the switch stay ASCII (cmd reads them in the old code page).
    expect(l.slice(0, switchTo).join('')).not.toMatch(/[\u0080-\u{10ffff}]/u);
    const restores = l.filter((line) => line === 'chcp %octopus_codepage% >nul');
    expect(restores.length).toBeGreaterThanOrEqual(2); // the "moved" exit and the normal exit
    expect(t).toContain('exit /b %octopus_exit%');
  });

  it('refuses a path that would break the quoting or the line', () => {
    expect(() => renderLauncher({ ...windows, executable: 'C:\\a"b\\x.exe' })).toThrow(
      CliShimError,
    );
    expect(() => renderLauncher({ ...windows, entry: 'C:\\a\nb' })).toThrow(CliShimError);
  });
});

describe('isOwnLauncher', () => {
  it('recognises every launcher we render', () => {
    for (const t of [direct, windows, appImage])
      expect(isOwnLauncher(renderLauncher(t))).toBe(true);
  });

  it('keeps recognising an older body that has the marker line', () => {
    expect(isOwnLauncher(`#!/bin/sh\n# ${MARKER}\nexec /old/app "$@"\n`)).toBe(true);
    expect(isOwnLauncher(`@echo off\r\nrem ${MARKER}\r\nold\r\n`)).toBe(true);
  });

  it('rejects an npm shim, any other script, binary data and the empty file', () => {
    const npmCmd = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\n';
    const npmSh =
      '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\nexec node "$basedir/../octopus-diff/dist/index.js" "$@"\n';
    const npmBin = '#!/usr/bin/env node\nimport "../dist/index.js";\n';
    for (const text of [npmCmd, npmSh, npmBin, '', '\0\u0001\u0002ELF', 'octopus-diff']) {
      expect(isOwnLauncher(text), JSON.stringify(text.slice(0, 20))).toBe(false);
    }
  });

  it('needs the exact marker comment near the top, not the text anywhere', () => {
    expect(isOwnLauncher(`#!/bin/sh\necho ${MARKER}\n`)).toBe(false);
    expect(isOwnLauncher(`#!/bin/sh\n# note: ${MARKER}\n`)).toBe(false);
    expect(isOwnLauncher(`#!/bin/sh\n# ${MARKER} (copied)\n`)).toBe(false);
    const buried = `#!/bin/sh\n${'echo x\n'.repeat(20)}# ${MARKER}\n`;
    expect(isOwnLauncher(buried)).toBe(false);
  });
});

describe('launcherLocation', () => {
  it('macOS and Linux: ~/.local/bin/octopus-diff', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(launcherLocation({ platform, env: {}, homedir: '/home/a b' })).toEqual({
        dir: '/home/a b/.local/bin',
        file: '/home/a b/.local/bin/octopus-diff',
      });
    }
  });

  it('Windows: %LOCALAPPDATA%\\octopus-diff\\bin\\octopus-diff.cmd', () => {
    expect(
      launcherLocation({
        platform: 'win32',
        env: { LOCALAPPDATA: 'C:\\Users\\Zoë\\AppData\\Local' },
        homedir: 'C:\\Users\\Zoë',
      }),
    ).toEqual({
      dir: 'C:\\Users\\Zoë\\AppData\\Local\\octopus-diff\\bin',
      file: 'C:\\Users\\Zoë\\AppData\\Local\\octopus-diff\\bin\\octopus-diff.cmd',
    });
  });

  it('Windows without a usable LOCALAPPDATA: under the home directory', () => {
    for (const env of [{}, { LOCALAPPDATA: '' }, { LOCALAPPDATA: 'relative\\dir' }]) {
      expect(launcherLocation({ platform: 'win32', env, homedir: 'C:\\Users\\a' }).dir).toBe(
        'C:\\Users\\a\\AppData\\Local\\octopus-diff\\bin',
      );
    }
  });
});

describe('resolveTarget', () => {
  const base = {
    platform: 'linux' as NodeJS.Platform,
    env: {} as Record<string, string | undefined>,
    execPath: '/opt/octopus-diff/octopus-diff-desktop',
    entry: '/opt/octopus-diff/resources/app.asar/dist/cli/index.js',
    isPackaged: true,
  };

  it('a development run has nothing to install', () => {
    const r = resolveTarget({ ...base, isPackaged: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/installed app/);
  });

  it('an installed Linux app: the binary and the entry as they are', () => {
    expect(resolveTarget(base)).toEqual({
      ok: true,
      target: { kind: 'direct', executable: base.execPath, entry: base.entry },
    });
  });

  it('an AppImage: the AppImage file and paths relative to the mount', () => {
    const r = resolveTarget({
      ...base,
      env: { APPIMAGE: '/home/a/octopus-diff.AppImage', APPDIR: '/tmp/.mount_octopXYZ' },
      execPath: '/tmp/.mount_octopXYZ/octopus-diff-desktop',
      entry: '/tmp/.mount_octopXYZ/resources/app.asar/dist/cli/index.js',
    });
    expect(r).toEqual({
      ok: true,
      target: {
        kind: 'appimage',
        appImage: '/home/a/octopus-diff.AppImage',
        executable: 'octopus-diff-desktop',
        entry: 'resources/app.asar/dist/cli/index.js',
      },
    });
  });

  it('a stale APPIMAGE in the environment of an installed app is ignored', () => {
    const r = resolveTarget({
      ...base,
      env: { APPIMAGE: '/home/a/old.AppImage', APPDIR: '/tmp/.mount_gone' },
    });
    expect(r).toEqual({
      ok: true,
      target: { kind: 'direct', executable: base.execPath, entry: base.entry },
    });
  });

  it('a relative APPIMAGE is not trusted; running from a mount without one cannot be installed', () => {
    const r = resolveTarget({
      ...base,
      env: { APPIMAGE: 'octopus-diff.AppImage', APPDIR: '/tmp/.mount_octopXYZ' },
      execPath: '/tmp/.mount_octopXYZ/octopus-diff-desktop',
      entry: '/tmp/.mount_octopXYZ/resources/app.asar/dist/cli/index.js',
    });
    expect(r.ok).toBe(false);
  });

  it('macOS: a disk image or a translocated app will not stay where it is', () => {
    for (const execPath of [
      '/Volumes/octopus-diff/octopus-diff.app/Contents/MacOS/octopus-diff',
      '/private/var/folders/x/T/AppTranslocation/ABC/d/octopus-diff.app/Contents/MacOS/octopus-diff',
    ]) {
      const r = resolveTarget({
        ...base,
        platform: 'darwin',
        execPath,
        entry: `${execPath}/../../Resources/app.asar/dist/cli/index.js`,
      });
      expect(r.ok, execPath).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/Applications/);
    }
  });

  it('macOS from /Applications is fine', () => {
    const execPath = '/Applications/octopus-diff.app/Contents/MacOS/octopus-diff';
    const entry = '/Applications/octopus-diff.app/Contents/Resources/app.asar/dist/cli/index.js';
    expect(resolveTarget({ ...base, platform: 'darwin', execPath, entry })).toEqual({
      ok: true,
      target: { kind: 'direct', executable: execPath, entry },
    });
  });

  it('Windows: a windows target', () => {
    expect(
      resolveTarget({
        ...base,
        platform: 'win32',
        execPath: windows.executable,
        entry: windows.entry,
      }),
    ).toEqual({
      ok: true,
      target: { kind: 'windows', executable: windows.executable, entry: windows.entry },
    });
  });
});

describe('pathContainsDir', () => {
  it('POSIX: exact entries, trailing slashes ignored, case matters', () => {
    expect(
      pathContainsDir('/usr/bin:/home/a/.local/bin:/bin', '/home/a/.local/bin', 'linux', {}),
    ).toBe(true);
    expect(pathContainsDir('/usr/bin:/home/a/.local/bin/', '/home/a/.local/bin', 'linux', {})).toBe(
      true,
    );
    expect(pathContainsDir('/usr/bin:/home/a/.local/BIN', '/home/a/.local/bin', 'linux', {})).toBe(
      false,
    );
    expect(pathContainsDir('/usr/bin::', '/home/a/.local/bin', 'linux', {})).toBe(false);
    expect(pathContainsDir('', '/x', 'linux', {})).toBe(false);
    expect(pathContainsDir('relative/.local/bin', '/home/a/.local/bin', 'linux', {})).toBe(false);
  });

  it('Windows: case-insensitive, slashes, quotes, trailing backslash, %VAR% expansion', () => {
    const dir = 'C:\\Users\\Zoë\\AppData\\Local\\octopus-diff\\bin';
    const env = { LOCALAPPDATA: 'C:\\Users\\Zoë\\AppData\\Local' };
    for (const value of [
      `C:\\Windows;${dir}`,
      `c:\\users\\zoë\\appdata\\local\\OCTOPUS-DIFF\\bin;C:\\x`,
      `"${dir}"`,
      'C:/Users/Zoë/AppData/Local/octopus-diff/bin',
      '%LOCALAPPDATA%\\octopus-diff\\bin',
      '%localappdata%\\octopus-diff\\bin\\',
    ]) {
      expect(pathContainsDir(value, dir, 'win32', env), value).toBe(true);
    }
    expect(pathContainsDir('C:\\Windows;C:\\other', dir, 'win32', env)).toBe(false);
    expect(pathContainsDir('%UNKNOWN%\\octopus-diff\\bin', dir, 'win32', env)).toBe(false);
  });
});

describe('addToUserPathValue', () => {
  const env = { LOCALAPPDATA: 'C:\\L' };
  const dir = 'C:\\L\\octopus-diff\\bin';

  it('appends the directory, keeping the existing entries byte for byte (%VARS% stay unexpanded)', () => {
    expect(addToUserPathValue('%USERPROFILE%\\bin;C:\\Tools', dir, env)).toEqual({
      changed: true,
      value: `%USERPROFILE%\\bin;C:\\Tools;${dir}`,
    });
  });

  it('no doubled separator after a trailing ;', () => {
    expect(addToUserPathValue('C:\\Tools;', dir, env).value).toBe(`C:\\Tools;${dir}`);
  });

  it('an empty or missing value becomes just the directory', () => {
    expect(addToUserPathValue('', dir, env)).toEqual({ changed: true, value: dir });
    expect(addToUserPathValue(null, dir, env)).toEqual({ changed: true, value: dir });
  });

  it('already there (any spelling): unchanged', () => {
    for (const current of [
      `C:\\Tools;${dir}`,
      `${dir.toLowerCase()}\\`,
      `%LOCALAPPDATA%\\octopus-diff\\bin;C:\\Tools`,
    ]) {
      expect(addToUserPathValue(current, dir, env), current).toEqual({
        changed: false,
        value: current,
      });
    }
  });
});

describe('decide', () => {
  const ours = (c = 'new') =>
    ({ kind: 'file', content: `#!/bin/sh\n# ${MARKER}\n${c}\n` }) as const;
  const foreign: FileFacts = { kind: 'file', content: '#!/usr/bin/env node\n' };
  const desired = ours('new').content;
  const targetPath = '/home/a/.local/bin/octopus-diff';

  it('nothing at the target and nothing on PATH: install', () => {
    expect(decide({ desired, targetPath, target: { kind: 'missing' }, others: [] })).toEqual({
      action: 'install',
    });
  });

  it('our launcher at the target, identical: already current', () => {
    expect(decide({ desired, targetPath, target: ours('new'), others: [] })).toEqual({
      action: 'current',
    });
  });

  it('our launcher at the target, different (the app moved): update', () => {
    expect(decide({ desired, targetPath, target: ours('old'), others: [] })).toEqual({
      action: 'update',
    });
  });

  it('a file we did not write at the target: refuse, whatever its kind', () => {
    for (const target of [foreign, { kind: 'symlink' }, { kind: 'other' }] as FileFacts[]) {
      expect(decide({ desired, targetPath, target, others: [] }), target.kind).toEqual({
        action: 'refuse',
        conflict: { kind: 'at-target', path: targetPath },
      });
    }
  });

  it('another octopus-diff on PATH: refuse, naming it, even when our launcher is installed', () => {
    for (const target of [{ kind: 'missing' }, ours('old'), ours('new')] as FileFacts[]) {
      expect(
        decide({
          desired,
          targetPath,
          target,
          others: [{ path: '/usr/local/bin/octopus-diff', facts: foreign }],
        }),
        target.kind,
      ).toEqual({
        action: 'refuse',
        conflict: { kind: 'on-path', path: '/usr/local/bin/octopus-diff' },
      });
    }
  });

  it('our own launcher elsewhere on PATH, a missing file and a directory are no conflict', () => {
    expect(
      decide({
        desired,
        targetPath,
        target: { kind: 'missing' },
        others: [
          { path: '/opt/bin/octopus-diff', facts: ours('older') },
          { path: '/x/octopus-diff', facts: { kind: 'missing' } },
          { path: '/y/octopus-diff', facts: { kind: 'other' } },
        ],
      }),
    ).toEqual({ action: 'install' });
  });

  it('a symlink on PATH (npm links its bin) is another install', () => {
    expect(
      decide({
        desired,
        targetPath,
        target: { kind: 'missing' },
        others: [{ path: '/home/a/.npm-global/bin/octopus-diff', facts: { kind: 'symlink' } }],
      }),
    ).toEqual({
      action: 'refuse',
      conflict: { kind: 'on-path', path: '/home/a/.npm-global/bin/octopus-diff' },
    });
  });
});

describe('pathCandidates (which candidates to inspect)', () => {
  it('lists each absolute PATH entry once with the command name, skipping the target', () => {
    const list = pathCandidates({
      platform: 'linux',
      env: {},
      pathValue: '/usr/bin:/home/a/.local/bin:relative/bin::/usr/bin:/opt/x',
      target: '/home/a/.local/bin/octopus-diff',
    });
    expect(list).toEqual(['/usr/bin/octopus-diff', '/opt/x/octopus-diff']);
  });

  it('Windows: every extension a command can have, the target and its case variants skipped', () => {
    const list = pathCandidates({
      platform: 'win32',
      env: {},
      pathValue: 'C:\\Users\\a\\AppData\\Roaming\\npm;C:\\L\\octopus-diff\\bin',
      target: 'c:\\l\\OCTOPUS-DIFF\\bin\\octopus-diff.cmd',
    });
    expect(list).toEqual([
      'C:\\Users\\a\\AppData\\Roaming\\npm\\octopus-diff',
      'C:\\Users\\a\\AppData\\Roaming\\npm\\octopus-diff.cmd',
      'C:\\Users\\a\\AppData\\Roaming\\npm\\octopus-diff.exe',
      'C:\\Users\\a\\AppData\\Roaming\\npm\\octopus-diff.bat',
      'C:\\Users\\a\\AppData\\Roaming\\npm\\octopus-diff.com',
      'C:\\Users\\a\\AppData\\Roaming\\npm\\octopus-diff.ps1',
      'C:\\L\\octopus-diff\\bin\\octopus-diff',
      'C:\\L\\octopus-diff\\bin\\octopus-diff.exe',
      'C:\\L\\octopus-diff\\bin\\octopus-diff.bat',
      'C:\\L\\octopus-diff\\bin\\octopus-diff.com',
      'C:\\L\\octopus-diff\\bin\\octopus-diff.ps1',
    ]);
  });
});

describe('pathCandidates: Windows relative entries (PR #110 review)', () => {
  it('drops `.`, a bare name, a drive-relative path, a root-relative path and `..` entries', () => {
    const list = pathCandidates({
      platform: 'win32',
      env: {},
      pathValue: '.;bin;C:foo;\\foo;..\\x;"";C:\\npm',
      target: 'C:\\L\\octopus-diff\\bin\\octopus-diff.cmd',
    });
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((f) => f.startsWith('C:\\npm\\'))).toBe(true);
  });

  it('keeps drive-letter and UNC entries, `/` spelled ones included', () => {
    const list = pathCandidates({
      platform: 'win32',
      env: {},
      pathValue: 'D:/tools;\\\\server\\share\\bin',
      target: 'C:\\x\\octopus-diff.cmd',
    });
    expect(list).toContain('D:\\tools\\octopus-diff.exe');
    expect(list).toContain('\\\\server\\share\\bin\\octopus-diff.exe');
  });
});

describe('decide: a command that cannot be read is a conflict (PR #110 review)', () => {
  const targetPath = '/home/a/.local/bin/octopus-diff';
  const desired = `#!/bin/sh\n# ${MARKER}\nx\n`;

  it('on PATH: refuse, naming it', () => {
    expect(
      decide({
        desired,
        targetPath,
        target: { kind: 'missing' },
        others: [{ path: '/opt/bin/octopus-diff', facts: { kind: 'unreadable' } }],
      }),
    ).toEqual({ action: 'refuse', conflict: { kind: 'on-path', path: '/opt/bin/octopus-diff' } });
  });

  it('at the target: refuse', () => {
    expect(decide({ desired, targetPath, target: { kind: 'unreadable' }, others: [] })).toEqual({
      action: 'refuse',
      conflict: { kind: 'at-target', path: targetPath },
    });
  });
});

describe('launcherApp: the app a launcher runs (what the startup refresh checks)', () => {
  const cases: [string, LauncherTarget][] = [
    ['direct', direct],
    ['AppImage', appImage],
    ['Windows', windows],
    [
      'hostile sh path',
      {
        kind: 'direct',
        executable: '/x/it\'s "q" $HOME `id`\nnew ünï 🐙/app',
        entry: '/x/entry',
      },
    ],
    [
      'Windows with % and non-ASCII',
      {
        kind: 'windows',
        executable: 'C:\\100%\\Zoë 日本\\octopus-diff.exe',
        entry: 'C:\\100%\\Zoë\\index.js',
      },
    ],
  ];
  for (const [name, target] of cases) {
    it(`${name}: reads back the file that is run`, () => {
      const want = target.kind === 'appimage' ? target.appImage : target.executable;
      expect(launcherApp(renderLauncher(target))).toBe(want);
    });
  }

  it('null when it cannot tell (an older body, another file, nothing)', () => {
    expect(launcherApp(`#!/bin/sh\n# ${MARKER}\nexec /old/app "$@"\n`)).toBeNull();
    expect(launcherApp('#!/usr/bin/env node\n')).toBeNull();
    expect(launcherApp('')).toBeNull();
    expect(launcherApp(`#!/bin/sh\n# ${MARKER}\napp=$(evil)\n`)).toBeNull();
    expect(launcherApp(`#!/bin/sh\n# ${MARKER}\napp='unterminated\n`)).toBeNull();
    // Not ours: never read anything out of another file.
    expect(launcherApp("#!/bin/sh\napp='/x/app'\n")).toBeNull();
    expect(launcherApp('if exist "C:\\x.exe" goto run\r\n')).toBeNull();
  });
});
