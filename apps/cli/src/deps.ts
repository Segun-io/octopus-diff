import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import {
  type ApiClient,
  type ApiClientOptions,
  createApiClient,
  type StartDaemon,
} from '@octopus-diff/contracts';
import { openBrowser } from './open-browser.js';
import type { Env } from './paths.js';
import { type ReadTextSync, readTextSync } from './platform.js';
import { isProcessAlive } from './runtime.js';

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
  openUrl: (url: string, isWsl: boolean) => Promise<string>;
  /**
   * Resolves with the signal name when the process is asked to stop (SIGINT/SIGTERM/SIGHUP). A
   * second signal while shutting down exits immediately.
   */
  waitForShutdown: () => Promise<string>;
  isProcessAlive: (pid: number) => boolean;
  runProgram: RunProgram;
  readText: ReadTextSync;
  probePort: (host: string, port: number) => Promise<PortProbe>;
  now: () => Date;
  /** Max time to wait for `handle.close()` before giving up (ms). */
  shutdownTimeoutMs: number;
}

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

export const runProgram: RunProgram = (command, args) =>
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
    openUrl: (url, isWsl) => openBrowser(url, process.platform, isWsl),
    waitForShutdown: processShutdownSignal(onForcedExit),
    isProcessAlive,
    runProgram,
    readText: readTextSync,
    probePort,
    now: () => new Date(),
    shutdownTimeoutMs: 10_000,
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
