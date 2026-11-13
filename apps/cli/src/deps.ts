import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import {
  type ApiClient,
  type ApiClientOptions,
  createApiClient,
  type StartDaemon,
} from '@octopus-diff/contracts';
import { defaultHelperEntry, GitRunner, gitHelperDisabledByEnv } from '@octopus-diff/git-core';
import { openBrowser } from './open-browser.js';
import type { Env } from './paths.js';
import { type ReadTextSync, readTextSync } from './platform.js';
import { isProcessAlive } from './runtime.js';
import type { NetworkInterfaces } from './urls.js';
import { resolveExecutable } from './which.js';

export interface Output {
  write(chunk: string): unknown;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
}

/** Runs a program with an argv array (never a shell). Rejects with an errno-style error. */
export type RunProgram = (command: string, args: string[]) => Promise<CommandResult>;

export type PortProbe = 'free' | 'in_use' | 'denied' | 'error';

/** What `doctor` learned about git-core's spawn helper (#45). */
export interface GitHelperProbe {
  /** on: git runs through the helper; off: turned off; broken: asked for but not working. */
  state: 'on' | 'off' | 'broken';
  detail: string;
}

/** Runs `git --version` through git-core's spawn helper, as the daemon would start it. */
export type ProbeGitHelper = (options: {
  gitBinary: string;
  /** `git.helper` from the config file (default true). */
  enabled: boolean;
}) => Promise<GitHelperProbe>;

/**
 * Everything the commands touch outside of the filesystem paths they are given. Tests replace
 * these; the defaults are the real implementations.
 */
export interface CliDeps {
  env: Env;
  cwd: string;
  platform: NodeJS.Platform;
  nodeVersion: string;
  pid: number;
  stdout: Output;
  stderr: Output;
  /** Loaded lazily so `doctor`/`add` don't import the daemon (and its native watcher). */
  loadStartDaemon: () => Promise<StartDaemon>;
  createApiClient: (options: ApiClientOptions) => ApiClient;
  /**
   * Opens a (tokenized) URL in the browser. `stateDir` is private (0700): the default opener
   * writes a 0600 launcher file there so the URL never appears on a command line (SEC-04).
   */
  openUrl: (url: string, isWsl: boolean, stateDir: string) => Promise<string>;
  /**
   * Resolves with the signal name when the process is asked to stop (SIGINT/SIGTERM/SIGHUP). A
   * second signal while shutting down exits immediately.
   */
  waitForShutdown: () => Promise<string>;
  isProcessAlive: (pid: number) => boolean;
  runProgram: RunProgram;
  readText: ReadTextSync;
  probePort: (host: string, port: number) => Promise<PortProbe>;
  /** `os.networkInterfaces()` (LAN URLs for wildcard binds). */
  networkInterfaces: () => NetworkInterfaces;
  now: () => Date;
  /** Max time to wait for `handle.close()` before giving up (ms). */
  shutdownTimeoutMs: number;
  probeGitHelper: ProbeGitHelper;
}

/** The real `ProbeGitHelper`: a git-core runner with one helper, one `git --version`. */
export const probeGitHelper: ProbeGitHelper = async ({ gitBinary, enabled }) => {
  if (!enabled) return { state: 'off', detail: 'off ("git.helper": false in the config file)' };
  if (gitHelperDisabledByEnv(process.env)) {
    return { state: 'off', detail: 'off (OCTOPUS_DIFF_GIT_HELPER in the environment)' };
  }
  if (process.platform === 'win32') {
    return { state: 'off', detail: 'not used on Windows: the daemon starts git itself' };
  }
  const entry = defaultHelperEntry();
  if (!entry) {
    return {
      state: 'broken',
      detail: 'git-helper.js is missing next to the CLI; the daemon starts git itself',
    };
  }
  const runner = new GitRunner({ gitBinary, helper: { entry, processes: 1 } });
  try {
    const version = await runner.version();
    if (!runner.usesHelper) {
      return {
        state: 'broken',
        detail: `the helper (${entry}) did not start; the daemon starts git itself`,
      };
    }
    return { state: 'on', detail: `${version} through ${entry}` };
  } catch (error) {
    return { state: 'broken', detail: `git --version through the helper failed: ${String(error)}` };
  } finally {
    await runner.dispose();
  }
};

/** Tries to bind `host:port` and immediately releases it. */
export function probePort(host: string, port: number): Promise<PortProbe> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') resolve('in_use');
      else if (error.code === 'EACCES') resolve('denied');
      else resolve('error');
    });
    server.listen({ host, port, exclusive: true }, () => {
      server.close(() => resolve('free'));
    });
  });
}

/**
 * `runProgram` that first resolves `command` to an absolute path through the absolute `PATH`
 * entries only (SEC-03: never the cwd or an empty/relative entry). Rejects with `ENOENT` when
 * it is not found.
 */
export function createRunProgram(env: Env, platform: NodeJS.Platform): RunProgram {
  return (command, args) => {
    const executable = resolveExecutable(command, { env, platform });
    if (executable === null) {
      const error: NodeJS.ErrnoException = new Error(`${command}: not found in PATH`);
      error.code = 'ENOENT';
      return Promise.reject(error);
    }
    return execProgram(executable, args);
  };
}

const execProgram: RunProgram = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd: tmpdir(), timeout: 10_000, maxBuffer: 1024 * 1024, shell: false, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;

function processShutdownSignal(onForced: (signal: string) => void): () => Promise<string> {
  return () =>
    new Promise((resolve) => {
      let received = false;
      const handler = (signal: NodeJS.Signals) => {
        if (received) {
          onForced(signal);
          return;
        }
        received = true;
        resolve(signal);
      };
      for (const signal of SHUTDOWN_SIGNALS) process.on(signal, handler);
    });
}

export function defaultDeps(): CliDeps {
  const onForcedExit = (signal: string) => {
    process.stderr.write(`\nreceived ${signal} again, exiting without a clean shutdown\n`);
    process.exit(130);
  };
  return {
    env: process.env,
    cwd: process.cwd(),
    platform: process.platform,
    nodeVersion: process.versions.node,
    pid: process.pid,
    stdout: process.stdout,
    stderr: process.stderr,
    loadStartDaemon: async () => (await import('@octopus-diff/daemon')).startDaemon,
    createApiClient,
    openUrl: (url, isWsl, stateDir) =>
      openBrowser(url, { platform: process.platform, isWsl, stateDir, env: process.env }),
    waitForShutdown: processShutdownSignal(onForcedExit),
    isProcessAlive,
    runProgram: createRunProgram(process.env, process.platform),
    readText: readTextSync,
    probePort,
    networkInterfaces,
    now: () => new Date(),
    shutdownTimeoutMs: 10_000,
    probeGitHelper,
  };
}

let cachedVersion: string | undefined;

/** The CLI package version (from `<pkg>/package.json`, one level above `src/` and `dist/`). */
export function cliVersion(): string {
  if (cachedVersion === undefined) {
    try {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        version?: unknown;
      };
      cachedVersion = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
    } catch {
      cachedVersion = '0.0.0';
    }
  }
  return cachedVersion;
}
