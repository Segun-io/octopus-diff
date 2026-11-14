/**
 * The `octopus-diff` command the app installs (roadmap #21, docs/DESKTOP.md §3.2, acceptance D6),
 * against the PACKAGED app: the installer's real code writes the launcher for the packaged
 * binary and its asar'd CLI into a temp home, and the launcher is RUN like a user's terminal would
 * (sh on macOS/Linux, cmd on Windows). The installer is the repo's source (`apps/desktop/src`), not
 * the packaged main process: the menu item and the bridge are not clicked here (no preload until
 * #20), and the Windows registry is faked (the runner's real PATH is never touched).
 *
 * Optional: `OCTOPUS_DESKTOP_APPIMAGE=<file.AppImage>` also checks the AppImage launcher (mounts
 * the image, or extracts it without FUSE) against that file.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, test } from '@playwright/test';
import { MARKER, renderLauncher } from '../../apps/desktop/src/cli-shim.js';
import { createNodeShimFs } from '../../apps/desktop/src/cli-shim-fs.js';
import {
  type CliShimDeps,
  createCliShim,
  type UserPathEditor,
} from '../../apps/desktop/src/cli-shim-service.js';
import {
  alive,
  appDirs,
  daemonInfo,
  daemonLog,
  launchApp,
  type PackagedApp,
  packagedApp,
  until,
} from './support/packaged-app.js';

const IS_WIN = process.platform === 'win32';

let app: PackagedApp;
let root: string;
const launched = new Set<number>();

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  app = packagedApp();
  root = mkdtempSync(join(tmpdir(), 'octopus-diff-cli-shim-e2e-'));
});

test.afterAll(async () => {
  for (const pid of launched) {
    if (alive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
  const deadline = Date.now() + 15_000;
  while ([...launched].some(alive) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

/** The Windows user PATH, in memory: the runner's registry is never touched. */
class MemoryUserPath implements UserPathEditor {
  value: string | null = null;
  async read() {
    return { value: this.value, kind: 'ExpandString' as const };
  }
  async write(value: string) {
    this.value = value;
  }
}

/** A user's terminal: `home` is theirs, `pathDirs` come first on PATH. */
function userHome(name: string, pathDirs: string[] = []) {
  const home = join(root, name);
  const localAppData = join(home, 'AppData', 'Local');
  mkdirSync(localAppData, { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, LOCALAPPDATA: localAppData };
  delete env.ELECTRON_RUN_AS_NODE;
  const pathValue = [...pathDirs, process.env.PATH ?? ''].join(delimiter);
  env[IS_WIN ? 'Path' : 'PATH'] = pathValue;
  const userPath = new MemoryUserPath();
  const deps: CliShimDeps = {
    platform: process.platform,
    env,
    homedir: home,
    execPath: app.executable,
    entry: app.cliEntry,
    isPackaged: true,
    fs: createNodeShimFs(),
    pathValue: () => pathValue,
    ...(IS_WIN ? { userPath } : {}),
  };
  const shim = createCliShim(deps);
  const file = IS_WIN
    ? join(localAppData, 'octopus-diff', 'bin', 'octopus-diff.cmd')
    : join(home, '.local', 'bin', 'octopus-diff');
  return { home, env, shim, file, userPath, deps };
}

/** Runs `file` like a terminal: sh on macOS/Linux (the shebang), cmd on Windows. */
function runLauncher(file: string, env: NodeJS.ProcessEnv, ...args: string[]): string {
  const [command, argv] = IS_WIN
    ? [process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', file, ...args]]
    : [file, args];
  return execFileSync(command, argv, {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

/** The bundled CLI run directly, the way the supervisor runs it. */
function bundledCli(...args: string[]): string {
  return execFileSync(app.executable, [app.cliEntry, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
  });
}

test('installs a launcher that runs the packaged app’s bundled CLI', async () => {
  const u = userHome('fresh');
  expect((await u.shim.status()).state).toBe('not-installed');
  const result = await u.shim.install();
  expect(result.outcome, result.message).toBe('installed');
  expect(existsSync(u.file)).toBe(true);
  expect(readFileSync(u.file, 'utf8')).toContain(MARKER);
  expect((await u.shim.status()).state).toBe('current');
  // Windows: the directory went onto the (faked) user PATH.
  if (IS_WIN) expect(u.userPath.value).toContain(join('octopus-diff', 'bin'));

  const version = runLauncher(u.file, u.env, '--version').trim();
  expect(version).toBe(bundledCli('--version').trim());
  expect(version).toMatch(/^\d+\.\d+\.\d+/);
  // Installing again changes nothing.
  expect((await u.shim.install()).outcome).toBe('unchanged');
});

test('the command talks to the app’s daemon (D6)', async () => {
  test.setTimeout(180_000);
  const u = userHome('d6');
  expect((await u.shim.install()).outcome).toBe('installed');

  const dirs = appDirs(root, 'app-d6');
  const env = { ...u.env };
  const run = launchApp(app, dirs, env);
  if (run.child.pid) launched.add(run.child.pid);
  await until(() => daemonLog(dirs).includes('backend ready: started'), 60_000, 'the backend');
  const info = await until(() => daemonInfo(dirs), 10_000, 'daemon.json');
  launched.add(info.pid);

  const status = JSON.parse(
    runLauncher(
      u.file,
      u.env,
      'status',
      '--json',
      '--state-dir',
      dirs.stateDir,
      '--config-dir',
      dirs.configDir,
    ),
  ) as { url?: string };
  expect(status.url, 'the installed command sees the app daemon').toBe(info.url);

  run.child.kill();
  await until(() => !alive(info.pid), 30_000, 'the daemon to stop after the app quit');
});

test('never overwrites an npm-installed octopus-diff', async () => {
  const npmBin = join(root, 'npm-global', 'bin');
  mkdirSync(npmBin, { recursive: true });
  const npmShim = join(npmBin, IS_WIN ? 'octopus-diff.cmd' : 'octopus-diff');
  const npmText = IS_WIN ? '@echo off\r\necho npm\r\n' : '#!/bin/sh\necho npm\n';
  writeFileSync(npmShim, npmText, { mode: 0o755 });

  // On PATH: nothing is installed, nothing created, the npm file untouched.
  const onPath = userHome('npm-on-path', [npmBin]);
  const refused = await onPath.shim.install();
  expect(refused.outcome).toBe('refused');
  expect(refused.message).toContain(npmShim);
  expect(existsSync(onPath.file)).toBe(false);
  expect(readFileSync(npmShim, 'utf8')).toBe(npmText);
  expect((await onPath.shim.status()).state).toBe('conflict');
  if (IS_WIN) expect(onPath.userPath.value).toBeNull();

  // At the launcher's own place (an npm prefix of ~/.local): left alone too.
  const atTarget = userHome('npm-at-target');
  mkdirSync(join(atTarget.file, '..'), { recursive: true });
  writeFileSync(atTarget.file, npmText);
  const second = await atTarget.shim.install();
  expect(second.outcome).toBe('refused');
  expect(readFileSync(atTarget.file, 'utf8')).toBe(npmText);
});

test('rewrites its own launcher after the app moved, and only that', async () => {
  const u = userHome('moved');
  mkdirSync(join(u.file, '..'), { recursive: true });
  // What an earlier install left: our marker, pointing at an app that is gone.
  const stale = renderLauncher(
    IS_WIN
      ? { kind: 'windows', executable: 'C:\\gone\\octopus-diff.exe', entry: 'C:\\gone\\index.js' }
      : { kind: 'direct', executable: '/gone/app', entry: '/gone/index.js' },
  );
  writeFileSync(u.file, stale, { mode: 0o755 });
  expect((await u.shim.status()).state).toBe('outdated');
  expect(() => runLauncher(u.file, u.env, '--version')).toThrow(); // 127: the app moved

  expect(await u.shim.refresh()).toBe('updated');
  expect(runLauncher(u.file, u.env, '--version').trim()).toBe(bundledCli('--version').trim());
});

test('AppImage: the launcher runs the AppImage file itself (OCTOPUS_DESKTOP_APPIMAGE)', async () => {
  const appImage = process.env.OCTOPUS_DESKTOP_APPIMAGE;
  test.skip(!appImage || IS_WIN || process.platform === 'darwin', 'no AppImage given');
  const u = userHome('appimage');
  const dir = join(u.file, '..');
  mkdirSync(dir, { recursive: true });
  // As the installer writes it for an AppImage run: the file, and paths relative to its mount.
  writeFileSync(
    u.file,
    renderLauncher({
      kind: 'appimage',
      appImage: appImage as string,
      executable: 'octopus-diff-desktop',
      entry: 'resources/app.asar/dist/cli/index.js',
    }),
    { mode: 0o755 },
  );
  // This WSL dev machine only (AGENTS.md "e2e on this machine"): Chromium's libraries are
  // extracted user-locally, and a mounted or extracted AppImage has no copy of them next to it.
  const env = { ...u.env };
  const libs =
    process.env.OCTOPUS_DIFF_CHROMIUM_LIBS ??
    join(homedir(), '.cache/octopus-diff-dev/chromium-libs/usr/lib/x86_64-linux-gnu');
  if (!process.env.CI && existsSync(libs)) env.LD_LIBRARY_PATH = libs;
  expect(runLauncher(u.file, env, '--version').trim()).toMatch(/^\d+\.\d+\.\d+/);
});
