/**
 * Finding, launching and inspecting the PACKAGED desktop app (roadmap #19). Never the user's
 * state: every launch gets temp `--state-dir`, `--config-dir` and `--app-data-dir`.
 *
 * Which app: `OCTOPUS_DESKTOP_APP` (the executable, an unpacked app directory, or a macOS `.app`),
 * else electron-builder's unpacked output for this platform and arch in apps/desktop/release/
 * (`pnpm --filter @octopus-diff/desktop run package -- --dir` builds it). CI points the variable
 * at the extracted AppImage (Linux), the app copied out of the dmg (macOS) and the app installed
 * by the NSIS installer (Windows).
 */
import { type ChildProcess, execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { TEST_IDS } from '@octopus-diff/contracts';
import { REPO_ROOT } from '../../support/env.js';
import { CDP_PIPE_STDIO, CdpPipe } from './cdp-pipe.js';
import { formatDiagnostics, type PageProbe, wrapWithDiagnostics } from './diagnostics.js';

export const DESKTOP_APP_ENV = 'OCTOPUS_DESKTOP_APP';
const RELEASE_DIR = join(REPO_ROOT, 'apps', 'desktop', 'release');

export interface PackagedApp {
  /** The Electron executable of the app. */
  executable: string;
  /** `<app>/resources` (Linux, Windows) or `<app>.app/Contents/Resources` (macOS). */
  resources: string;
  /** The bundled CLI, as the supervisor runs it: `<resources>/app.asar/dist/cli/index.js`. */
  cliEntry: string;
}

function defaultLocation(): string {
  const arm = process.arch === 'arm64';
  if (process.platform === 'darwin') {
    return join(RELEASE_DIR, arm ? 'mac-arm64' : 'mac', 'octopus-diff.app');
  }
  if (process.platform === 'win32')
    return join(RELEASE_DIR, arm ? 'win-arm64-unpacked' : 'win-unpacked');
  return join(RELEASE_DIR, arm ? 'linux-arm64-unpacked' : 'linux-unpacked');
}

export function findExecutable(location: string): string {
  const abs = resolve(location);
  if (!existsSync(abs)) {
    throw new Error(
      `packaged app not found at ${abs}.\n  Build it (pnpm build && pnpm --filter @octopus-diff/desktop ` +
        `run package -- --dir) or set ${DESKTOP_APP_ENV}.`,
    );
  }
  if (statSync(abs).isFile()) return abs;
  if (abs.endsWith('.app')) {
    const macos = join(abs, 'Contents', 'MacOS');
    const [name] = readdirSync(macos);
    if (!name) throw new Error(`nothing in ${macos}`);
    return join(macos, name);
  }
  const entries = readdirSync(abs);
  const bundle = entries.find((f) => f.endsWith('.app'));
  if (bundle) return findExecutable(join(abs, bundle));
  const exe = entries.find(
    (f) =>
      (f.endsWith('.exe') && !/^(uninstall|elevate)/i.test(f)) ||
      f === 'octopus-diff-desktop' ||
      f === 'octopus-diff',
  );
  if (!exe) throw new Error(`no app executable in ${abs}`);
  return join(abs, exe);
}

export function packagedApp(): PackagedApp {
  const executable = findExecutable(process.env[DESKTOP_APP_ENV] || defaultLocation());
  const resources =
    process.platform === 'darwin'
      ? join(dirname(dirname(executable)), 'Resources')
      : join(dirname(executable), 'resources');
  const cliEntry = join(resources, 'app.asar', 'dist', 'cli', 'index.js');
  if (!existsSync(join(resources, 'app.asar'))) {
    throw new Error(`${executable}: no ${join(resources, 'app.asar')} (not a packaged app?)`);
  }
  linkDevMachineChromiumLibs(dirname(executable));
  return { executable, resources, cliEntry };
}

/**
 * This WSL dev machine only (AGENTS.md "e2e on this machine", DESKTOP.md §2): Chromium's system
 * libraries are extracted user-locally. Electron's RPATH is `$ORIGIN`, and LD_LIBRARY_PATH does not
 * reach the git helper (empty env), so they are linked next to the binary. A normal machine and CI
 * have the libraries installed and skip this.
 */
function linkDevMachineChromiumLibs(appDir: string): void {
  if (process.platform !== 'linux' || process.env.CI) return;
  const libs =
    process.env.OCTOPUS_DIFF_CHROMIUM_LIBS ??
    join(homedir(), '.cache/octopus-diff-dev/chromium-libs/usr/lib/x86_64-linux-gnu');
  if (!existsSync(libs)) return;
  for (const name of readdirSync(libs)) {
    const target = join(appDir, name);
    if (!existsSync(target)) symlinkSync(join(libs, name), target);
  }
}

export interface AppDirs {
  root: string;
  stateDir: string;
  configDir: string;
  appData: string;
}

export function appDirs(parent: string, name: string): AppDirs {
  const root = join(parent, name);
  mkdirSync(root, { recursive: true });
  return {
    root,
    stateDir: join(root, 'state'),
    configDir: join(root, 'config'),
    appData: join(root, 'appdata'),
  };
}

export interface AppRun {
  child: ChildProcess;
  cdp: CdpPipe;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  output(): string;
}

/** Launches the packaged app with temp dirs, a free port and the DevTools pipe. */
export function launchApp(
  app: PackagedApp,
  dirs: AppDirs,
  env: NodeJS.ProcessEnv,
  extra: readonly string[] = [],
): AppRun {
  const child = spawn(
    app.executable,
    [
      '--state-dir',
      dirs.stateDir,
      '--config-dir',
      dirs.configDir,
      '--app-data-dir',
      dirs.appData,
      '--port',
      '0',
      '--remote-debugging-pipe',
      ...extra,
    ],
    { env: appLaunchEnv(env), stdio: [...CDP_PIPE_STDIO] },
  );
  let output = '';
  child.stdout?.on('data', (c) => {
    output += c;
  });
  child.stderr?.on('data', (c) => {
    output += c;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    child.on('exit', (code, signal) => done({ code, signal })),
  );
  return { child, cdp: new CdpPipe(child), exited, output: () => output };
}

/**
 * The environment of a GUI launch. The app starts the backend itself, so it must not inherit
 * RUN_AS_NODE from the test runner. And it must not rewrite the developer's real `octopus-diff`
 * launcher (`~/.local/bin`, `%LOCALAPPDATA%`) at startup (DECISIONS #574): the switch
 * `OCTOPUS_DESKTOP_NO_CLI_REFRESH=1` turns that refresh off. HOME is NOT redirected: on macOS a
 * fake HOME broke Chromium (Keychain, ~/Library) and the UI never became ready (PR #110 CI,
 * DECISIONS #581). Every launch of the app goes through `launchApp` / `runApp`.
 */
export function appLaunchEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, OCTOPUS_DESKTOP_NO_CLI_REFRESH: '1' };
  delete out.ELECTRON_RUN_AS_NODE;
  return out;
}

/** Runs a short-lived launch to completion (for the refusal checks). */
export function runApp(
  app: PackagedApp,
  dirs: AppDirs,
  env: NodeJS.ProcessEnv,
  extra: readonly string[],
): { status: number | null; signal: NodeJS.Signals | null; output: string } {
  const result = spawnSync(
    app.executable,
    [
      '--app-data-dir',
      dirs.appData,
      '--state-dir',
      dirs.stateDir,
      '--config-dir',
      dirs.configDir,
      ...extra,
    ],
    { env: appLaunchEnv(env), encoding: 'utf8', timeout: 30_000 },
  );
  return {
    status: result.status,
    signal: result.signal,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

/** The app's bundled CLI, run the way the app runs it (and the phase C command will). */
export function cli(
  app: PackagedApp,
  dirs: AppDirs,
  env: NodeJS.ProcessEnv,
  ...args: string[]
): string {
  return execFileSync(
    app.executable,
    [app.cliEntry, ...args, '--state-dir', dirs.stateDir, '--config-dir', dirs.configDir],
    {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    },
  );
}

export interface DaemonInfo {
  pid: number;
  url: string;
  token: string;
}

export function daemonInfo(dirs: AppDirs): DaemonInfo | null {
  try {
    const json = JSON.parse(readFileSync(join(dirs.stateDir, 'daemon.json'), 'utf8')) as {
      pid: number;
      url: string;
    };
    const token = readFileSync(join(dirs.stateDir, 'token'), 'utf8').trim();
    return { pid: json.pid, url: json.url, token };
  } catch {
    return null;
  }
}

export function daemonLog(dirs: AppDirs): string {
  try {
    return readFileSync(join(dirs.appData, 'logs', 'daemon.log'), 'utf8');
  } catch {
    return '';
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface ProcessRow {
  pid: number;
  ppid: number;
  args: string;
}

/** Child processes of `pid` (macOS, Linux: `ps`). */
export function childProcesses(pid: number): ProcessRow[] {
  if (process.platform === 'win32') throw new Error('childProcesses: POSIX only');
  const out = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,args='], { encoding: 'utf8' });
  return out
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] ?? '' }))
    .filter((row) => row.ppid === pid);
}

export async function until<T>(
  condition: () => T | Promise<T>,
  timeoutMs: number,
  what: string,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await condition();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline)
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** Short name for logs: `octopus-diff-desktop` / `octopus-diff.exe` / `octopus-diff`. */
export function appLabel(app: PackagedApp): string {
  return basename(app.executable);
}

/** Rejects after `ms` (a hung app must not hang the diagnostics too). */
function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: no answer within ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

const PAGE_PROBE = `(() => {
  const app = document.querySelector('[data-testid="${TEST_IDS.app}"]');
  return {
    readyState: document.readyState,
    visibilityState: document.visibilityState,
    hasFocus: document.hasFocus(),
    appReady: app ? app.getAttribute('data-ready') : null,
    text: (document.body ? document.body.innerText : '').slice(0, 800),
  };
})()`;

/**
 * What the window shows right now, and what the app and the daemon logged (diagnostics.ts): for the
 * error of a window wait that timed out. Never throws; the token is redacted.
 */
export async function windowDiagnostics(
  run: AppRun,
  dirs: AppDirs,
  secrets: readonly (string | null | undefined)[],
): Promise<string> {
  let pages: PageProbe[] | { error: string };
  try {
    const targets = (await within(run.cdp.targets(), 5_000, 'Target.getTargets')).filter(
      (t) => t.type === 'page',
    );
    pages = [];
    for (const target of targets) {
      const probe: PageProbe = { url: target.url };
      try {
        const attached = await within(
          run.cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true }),
          3_000,
          'Target.attachToTarget',
        );
        const sessionId = attached.sessionId as string;
        const result = await within(
          run.cdp.send(
            'Runtime.evaluate',
            { expression: PAGE_PROBE, returnByValue: true },
            sessionId,
          ),
          3_000,
          'Runtime.evaluate',
        );
        probe.state = (result.result as { value?: PageProbe['state'] } | undefined)?.value ?? {};
        await within(run.cdp.send('Target.detachFromTarget', { sessionId }), 2_000, 'detach').catch(
          () => undefined,
        );
      } catch (error) {
        probe.probeError = error instanceof Error ? error.message : String(error);
      }
      pages.push(probe);
    }
  } catch (error) {
    pages = { error: error instanceof Error ? error.message : String(error) };
  }
  return formatDiagnostics({
    pages,
    log: daemonLog(dirs),
    output: run.output(),
    secrets,
    appAlive: run.child.exitCode === null && run.child.signalCode === null,
  });
}

/**
 * Runs a window wait; when it fails, the thrown error carries `windowDiagnostics` (so the CI log
 * shows what the window was on, and why).
 */
export async function withWindowDiagnostics<T>(
  run: AppRun,
  dirs: AppDirs,
  secrets: readonly (string | null | undefined)[],
  wait: () => Promise<T>,
): Promise<T> {
  try {
    return await wait();
  } catch (error) {
    throw wrapWithDiagnostics(error, await windowDiagnostics(run, dirs, secrets), secrets);
  }
}
