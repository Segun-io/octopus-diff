import { execFile } from 'node:child_process';
import { closeSync, fstatSync, readFileSync, writeSync } from 'node:fs';
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

/** The write end of `--ready-fd`: takes exactly one line, then is closed. */
export interface ReadyChannel {
  /** Writes `line` completely (blocking); throws if the reader is gone (EPIPE) or the fd is bad. */
  write(line: string): void;
  close(): void;
}

/**
 * Which of the process's output pipes broke (EPIPE: the supervisor that read them is gone). A
 * supervised `serve` stops writing to a broken one instead of crashing on it (#22 review).
 */
export interface BrokenPipes {
  stdout(): boolean;
  stderr(): boolean;
}

/** Watches stdin for the end of the supervisor's lifeline (`--exit-with-stdin`). */
export interface StdinWatch {
  /** Resolves (never rejects) with a reason when stdin ends, errors or closes. */
  closed: Promise<string>;
  /** Stops listening and releases stdin so it cannot keep the process alive. */
  stop(): void;
}

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
  /** Opens `--ready-fd`; throws an Error if `fd` is not an open descriptor. */
  openReadyChannel: (fd: number) => ReadyChannel;
  /**
   * `--ready-stdout` (#22): a channel that writes the ready frame to stdout (blocking, whole);
   * `close()` leaves stdout open.
   */
  openStdoutReadyChannel: () => ReadyChannel;
  /**
   * Supervised runs (`--exit-with-stdin`, `--ready-stdout`): from now on an EPIPE on stdout or
   * stderr is remembered instead of thrown (see `watchBrokenPipes`).
   */
  watchBrokenPipes: () => BrokenPipes;
  /** Starts watching stdin for EOF/close/error (`--exit-with-stdin`). */
  watchStdin: () => StdinWatch;
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

const sleepSignal = new Int32Array(new SharedArrayBuffer(4));
const READY_WRITE_BUDGET_MS = 5_000;

/**
 * The real `openReadyChannel`: a blocking `fs.writeSync` on the inherited descriptor (a pipe or
 * socket the parent holds the other end of; works the same on Windows for fd >= 3 from the spawn
 * `stdio` array). It retries on `EAGAIN` (a non-blocking pipe that is full) for a bounded time.
 */
export function openReadyChannel(fd: number): ReadyChannel {
  try {
    fstatSync(fd);
  } catch {
    throw new Error(`file descriptor ${fd} is not open (the parent must pass it to this process)`);
  }
  let closed = false;
  return {
    write: (line) => writeAllSync(fd, line),
    close() {
      if (closed) return;
      closed = true;
      try {
        closeSync(fd);
      } catch {
        // already gone
      }
    },
  };
}

/**
 * The real `openStdoutReadyChannel` (#22): the frame is written to fd 1 with the same blocking
 * write as `openReadyChannel` (one `write` of a few hundred bytes, so it is not interleaved with
 * other output; the frame's leading newline starts it on a line of its own anyway). A broken
 * stdout is `watchBrokenPipes`' business (serve starts it for every supervised run).
 */
export function openStdoutReadyChannel(): ReadyChannel {
  return { write: (line) => writeAllSync(1, line), close: () => undefined };
}

interface ErrorSource {
  on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown;
}

const BROKEN_PIPE_CODES = new Set(['EPIPE', 'ERR_STREAM_DESTROYED']);

/**
 * The real `watchBrokenPipes`. The reader of a supervised `serve`'s stdout and stderr may vanish
 * (`wsl.exe` killed, the app crashed: the Linux process then sees stdin's EOF, SIGHUP, and both
 * pipes broken). An unhandled EPIPE on either would crash the daemon halfway through the shutdown
 * that stdin's EOF started (exit 1, `daemon.json` left behind), so it is remembered instead and
 * serve drops later writes to that stream. Any other error still throws.
 */
export function watchBrokenPipes(
  streams: { stdout: ErrorSource; stderr: ErrorSource } = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): BrokenPipes {
  const broken = { stdout: false, stderr: false };
  for (const name of ['stdout', 'stderr'] as const) {
    streams[name].on('error', (error) => {
      if (!BROKEN_PIPE_CODES.has(error?.code ?? '')) throw error;
      broken[name] = true;
    });
  }
  return { stdout: () => broken.stdout, stderr: () => broken.stderr };
}

function writeAllSync(fd: number, line: string): void {
  const data = Buffer.from(line, 'utf8');
  let offset = 0;
  const deadline = Date.now() + READY_WRITE_BUDGET_MS;
  while (offset < data.length) {
    try {
      offset += writeSync(fd, data, offset, data.length - offset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN' || Date.now() > deadline) throw error;
      Atomics.wait(sleepSignal, 0, 0, 5);
    }
  }
}

/**
 * The real `watchStdin`. stdin is read and discarded, and unref'd so that it never keeps the
 * process alive by itself: the daemon's own handles do, and `stop()` pauses it again.
 */
export function watchStdin(stdin: NodeJS.ReadStream = process.stdin): StdinWatch {
  let onEnd = () => {};
  let onError = (_: Error) => {};
  const closed = new Promise<string>((resolve) => {
    onEnd = () => resolve('stdin closed');
    onError = (error) => resolve(`stdin error (${error.message})`);
  });
  stdin.on('end', onEnd);
  stdin.on('close', onEnd);
  stdin.on('error', onError);
  stdin.resume();
  (stdin as { unref?: () => unknown }).unref?.();
  return {
    closed,
    stop() {
      stdin.off('end', onEnd);
      stdin.off('close', onEnd);
      stdin.off('error', onError);
      stdin.pause();
    },
  };
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
    openReadyChannel,
    openStdoutReadyChannel,
    watchBrokenPipes: () => watchBrokenPipes(),
    watchStdin: () => watchStdin(),
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

/** Set by `scripts/bundle.mjs` (esbuild `define`): a standalone bundle has no package.json above it. */
declare const __OCTOPUS_CLI_VERSION__: string | undefined;

let cachedVersion: string | undefined;

/** The CLI package version (embedded in a bundle, else `<pkg>/package.json` above `src/`/`dist/`). */
export function cliVersion(): string {
  if (cachedVersion === undefined) {
    if (typeof __OCTOPUS_CLI_VERSION__ === 'string') {
      cachedVersion = __OCTOPUS_CLI_VERSION__;
      return cachedVersion;
    }
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
