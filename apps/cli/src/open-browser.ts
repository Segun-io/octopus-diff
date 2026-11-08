import { spawn as nodeSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Env } from './paths.js';
import { resolveExecutable, windowsSystemExecutable, withSafePath } from './which.js';

export interface OpenCommand {
  /** Bare name; `openBrowser` resolves it to an absolute path before spawning. */
  command: string;
  args: string[];
  /** Written to the child's stdin (then closed), instead of passing it on the command line. */
  stdin?: string;
}

/** Only plain http(s) URLs are opened; anything else could be interpreted by the opener. */
const SAFE_URL = /^https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;

/** PowerShell reading its script from stdin: nothing secret on any command line. */
export const POWERSHELL_STDIN_ARGS = [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy',
  'Bypass',
  '-Command',
  '-',
];

export function powershellOpenScript(url: string): string {
  return `Start-Process '${url.replace(/'/g, "''")}'\n`;
}

/** Name of the temporary launcher files in the state dir (`open-<hex>.html`). */
const LAUNCHER = /^open-[0-9a-f]{16}\.html$/;
/** The browser reads the launcher once; give a cold browser start plenty of time. */
export const LAUNCHER_TTL_MS = 60_000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** A page that sends the browser on to `url` (meta refresh, plus a link as a fallback). */
export function launcherHtml(url: string): string {
  const href = escapeHtml(url);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">
<meta http-equiv="refresh" content="0; url=${href}"><title>octopus-diff</title></head>
<body><p>Opening <a href="${href}">octopus-diff</a>…</p></body></html>
`;
}

/**
 * Writes the launcher as a new 0600 file in the (0700) state dir. SEC-04: the tokenized URL
 * goes into a file only this user can read, and the opener's command line (which every local
 * user can read in `/proc/<pid>/cmdline`) gets the file path instead.
 */
export async function writeLauncher(stateDir: string, url: string): Promise<string> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const file = path.join(stateDir, `open-${randomBytes(8).toString('hex')}.html`);
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(launcherHtml(url), 'utf8');
  } finally {
    await handle.close();
  }
  return file;
}

/** Deletes launchers older than `maxAgeMs` (left behind when the CLI exited before its timer). */
export async function sweepLaunchers(
  stateDir: string,
  now: number = Date.now(),
  maxAgeMs: number = LAUNCHER_TTL_MS,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(stateDir);
  } catch {
    return;
  }
  await Promise.all(
    names
      .filter((name) => LAUNCHER.test(name))
      .map(async (name) => {
        const file = path.join(stateDir, name);
        try {
          if (now - (await stat(file)).mtimeMs >= maxAgeMs) await rm(file, { force: true });
        } catch {
          // Already gone.
        }
      }),
  );
}

/**
 * Commands that open the launcher (or, on WSL, the URL via PowerShell's stdin) in the default
 * browser, in the order to try them. On WSL the Windows browser is preferred (it can't read a
 * file under the Linux home without path translation, so PowerShell gets the URL on stdin),
 * then `xdg-open` in case a Linux browser is set up. Throws for a non-http(s) URL.
 */
export function browserOpenCommands(
  url: string,
  launcher: string,
  platform: NodeJS.Platform,
  isWsl: boolean,
): OpenCommand[] {
  if (!SAFE_URL.test(url)) throw new Error(`refusing to open a non-http(s) URL: ${url}`);
  if (platform === 'darwin') return [{ command: 'open', args: [launcher] }];
  if (platform === 'win32') {
    return [{ command: 'rundll32', args: ['url.dll,FileProtocolHandler', launcher] }];
  }
  const commands: OpenCommand[] = [];
  if (isWsl) {
    commands.push({
      command: 'powershell.exe',
      args: POWERSHELL_STDIN_ARGS,
      stdin: powershellOpenScript(url),
    });
  }
  commands.push({ command: 'xdg-open', args: [launcher] });
  return commands;
}

/** The subset of a spawned child used here. */
export interface SpawnedChild {
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  unref(): void;
  stdin?: {
    end(chunk: string): unknown;
    on?(event: 'error', listener: () => void): unknown;
  } | null;
}

export interface SpawnOptions {
  detached: boolean;
  stdio: 'ignore' | ['pipe', 'ignore', 'ignore'];
  shell: false;
  cwd: string;
  env: Record<string, string>;
  windowsHide: boolean;
}

/** The subset of `child_process.spawn` used here (injectable for tests). */
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => SpawnedChild;

function trySpawn(
  spawn: SpawnFn,
  executable: string,
  candidate: OpenCommand,
  options: Omit<SpawnOptions, 'stdio'>,
): Promise<boolean> {
  return new Promise((resolve) => {
    let child: SpawnedChild;
    try {
      child = spawn(executable, candidate.args, {
        ...options,
        stdio: candidate.stdin === undefined ? 'ignore' : ['pipe', 'ignore', 'ignore'],
      });
    } catch {
      resolve(false);
      return;
    }
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      if (candidate.stdin !== undefined) {
        child.stdin?.on?.('error', () => {});
        child.stdin?.end(candidate.stdin);
      }
      child.unref();
      resolve(true);
    });
  });
}

/**
 * The absolute path for an opener (SEC-03): `%SystemRoot%\System32\rundll32.exe` on Windows,
 * else the first match in the absolute `PATH` entries. Never a bare name, never the cwd.
 */
export function resolveOpener(command: string, platform: NodeJS.Platform, env: Env): string | null {
  if (platform === 'win32' && command === 'rundll32') {
    const system = windowsSystemExecutable('rundll32.exe', env);
    if (system && existsSync(system)) return system;
  }
  const found = resolveExecutable(command, { env, platform });
  if (found) return found;
  if (platform === 'darwin' && command === 'open' && existsSync('/usr/bin/open')) {
    return '/usr/bin/open';
  }
  return null;
}

export interface OpenBrowserOptions {
  platform: NodeJS.Platform;
  isWsl: boolean;
  /** Private (0700) directory for the launcher file and the openers' working directory. */
  stateDir: string;
  env: Env;
  spawn?: SpawnFn;
  resolve?: (command: string) => string | null;
  /** When the launcher is deleted (default `LAUNCHER_TTL_MS`). */
  deleteAfterMs?: number;
}

/**
 * Opens `url` with the first opener that exists. Resolves with the command used; rejects if none
 * could be started. Never uses a shell, never spawns a bare name, never puts the URL on a
 * command line, and runs openers from the private state dir with a `PATH` reduced to absolute
 * entries (so helpers the opener starts can't be picked up from a repository either).
 */
export async function openBrowser(url: string, options: OpenBrowserOptions): Promise<string> {
  const { platform, isWsl, stateDir, env } = options;
  const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnFn);
  const resolve = options.resolve ?? ((command) => resolveOpener(command, platform, env));
  if (!SAFE_URL.test(url)) throw new Error(`refusing to open a non-http(s) URL: ${url}`);
  await sweepLaunchers(stateDir);
  const launcher = await writeLauncher(stateDir, url);
  const commands = browserOpenCommands(url, launcher, platform, isWsl);
  const spawnOptions = {
    detached: true,
    shell: false as const,
    cwd: stateDir,
    env: withSafePath(env, platform),
    windowsHide: true,
  };
  for (const candidate of commands) {
    const executable = resolve(candidate.command);
    if (executable === null) continue;
    if (await trySpawn(spawn, executable, candidate, spawnOptions)) {
      const timer = setTimeout(() => {
        void rm(launcher, { force: true }).catch(() => {});
      }, options.deleteAfterMs ?? LAUNCHER_TTL_MS);
      timer.unref?.();
      return candidate.command;
    }
  }
  await rm(launcher, { force: true }).catch(() => {});
  throw new Error(
    `could not open a browser (tried ${commands.map((c) => c.command).join(', ')}); open the URL manually`,
  );
}
