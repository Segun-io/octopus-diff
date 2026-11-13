import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  GitCoreError,
  type GitHelperOptions,
  type GitPriority,
  type Logger,
  noopLogger,
} from '@octopus-diff/contracts';
import * as Cause from 'effect/Cause';
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import { assertAllowedGitArgs, assertStdinAllowed, DIFF_FAMILY } from './allowlist.js';
import { abortedError, currentCall } from './call-context.js';
import { CONFIG_PIN_ARGS } from './config-pins.js';
import { buildGitEnv, withConfigEnv } from './env.js';
import {
  defaultHelperEntry,
  GitHelperPool,
  gitHelperPoolLayer,
  HELPER_MAX_ARGV,
  HELPER_MAX_ENV,
  HELPER_MAX_REQUEST_FRAME,
  type HelperPool,
  type HelperSpawnRequest,
  type ProcHandle,
  type ProcHandlers,
  reapGroup,
} from './helper-client.js';
import { INTERACTIVE_BURST, LaneSemaphore } from './scheduler.js';

export { INTERACTIVE_BURST };

export interface GitRunnerOptions {
  gitBinary?: string;
  /** Max concurrent git processes overall (default 4). */
  concurrency?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  logger?: Logger;
  /** `core.bigFileThreshold` pinned on every call (default: max(maxOutputBytes, 1 MiB)). */
  bigFileThreshold?: number;
  /**
   * Start git through the spawn helper (#45): `true` (the default, except on Windows), `false`
   * for the direct path, or the helper's settings. `OCTOPUS_DIFF_GIT_HELPER=0` turns it off
   * whatever this says.
   */
  helper?: boolean | GitHelperOptions;
  /** Tests only (not in the contracts): helper hooks and timings. */
  helperTest?: HelperTestOptions;
  /** Tests only (not in the contracts): the Effect context of the runner's fibers. */
  runnerTest?: RunnerTestOptions;
}

export interface RunnerTestOptions {
  /**
   * The context the runner's fibers run with (default: empty, i.e. the live clock). Inside
   * `it.effect`, `yield* Effect.context<never>()`: its `TestClock` then drives the runner's
   * timeouts, the abort grace period and the helper exit watchdog.
   */
  context?: Context.Context<never>;
}

export interface HelperTestOptions {
  /** `OCTOPUS_DIFF_GIT_HELPER_TEST_CRASH` for the helpers (see `git-helper.ts`). */
  crash?: string;
  /** The helpers report each git process's exit this much later (slow reaping under load). */
  delayExitMs?: number;
  /** The helpers start this much later (a slow CI runner). */
  startDelayMs?: number;
  /** This process's first group SIGKILL after a helper crash is lost (macOS: killpg racing a fork). */
  missFirstGroupKill?: boolean;
  /** Replaces `HELPER_EXIT_WAIT_MS`. */
  exitWaitMs?: number;
  /** How long a retry waits for a crashed helper's SIGKILLed groups to disappear. */
  groupGoneWaitMs?: number;
  /** How long a probed helper may take to answer before it is SIGKILLed. */
  probeWaitMs?: number;
}

/** Off when `OCTOPUS_DIFF_GIT_HELPER` is `0`, `false`, `no` or `off`. */
export function gitHelperDisabledByEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(0|false|no|off)$/i.test(env.OCTOPUS_DIFF_GIT_HELPER?.trim() ?? '');
}

interface HelperConfig {
  entry: string;
  processes: number;
  execPath: string | undefined;
}

function helperConfig(
  option: GitRunnerOptions['helper'],
  concurrency: number,
  logger: Logger,
): HelperConfig | null {
  if (option === false || gitHelperDisabledByEnv()) return null;
  // Windows keeps the direct path: no process groups to kill there (see docs/reports/spawn-helper.md).
  if (process.platform === 'win32') return null;
  const settings = typeof option === 'object' ? option : {};
  const entry = settings.entry ?? defaultHelperEntry();
  if (!entry) {
    logger.warn('git helper entry not found; spawning git directly');
    return null;
  }
  return {
    entry,
    // Two by default: one helper's event loop starts about 1 000 processes a second, two keep up
    // with the runner's whole concurrency (docs/reports/spawn-helper.md).
    processes: Math.min(4, Math.max(1, Math.floor(settings.processes ?? Math.min(2, concurrency)))),
    execPath: settings.execPath,
  };
}

export interface GitRunOptions {
  cwd: string;
  /** Queue key for per-repository fairness (default: `cwd`). */
  queueKey?: string;
  /** Exit codes that count as success (default `[0]`; `diff --no-index` also accepts 1). */
  okExitCodes?: readonly number[];
  timeoutMs?: number;
  /** Buffered mode only: kill the process once stdout exceeds this many bytes. */
  maxOutputBytes?: number;
  /**
   * Streaming mode: stdout chunks are passed here and not retained (`stdout` in the result is
   * empty). The callback may throw to abort the process.
   */
  onStdout?: (chunk: Buffer) => void;
  /** Extra config entries passed via `GIT_CONFIG_COUNT` (e.g. filter neutralization). */
  configEnv?: ReadonlyArray<readonly [string, string]>;
  /**
   * Repository location, passed as `--git-dir` / `--work-tree` global options. An explicit
   * work tree wins over repository config (`core.worktree`), and an explicit git dir skips
   * discovery (SEC-06). Both must be absolute.
   */
  location?: GitLocation;
  /**
   * Written to the process's stdin, which is then closed (default: no stdin at all). Only
   * `check-attr --stdin` and `patch-id` may get input (`assertStdinAllowed`).
   */
  input?: Buffer;
  /**
   * Called right before the git process is spawned (after any wait for a free slot), so a caller
   * can tell whether the process that will read the repository has started yet.
   */
  onSpawn?: () => void;
  /**
   * Cancels this process (#44): while queued it never starts; while running it gets SIGTERM
   * (its process group), then SIGKILL after `ABORT_GRACE_MS`; the run rejects with `aborted`
   * once the process has exited. Default: the signal of the `GitCore` call running
   * (`currentCall`).
   */
  signal?: AbortSignal;
  /** Scheduling lane (default: the running call's, else `background`). */
  priority?: GitPriority;
}

export interface GitLocation {
  gitDir?: string;
  workTree?: string;
}

export interface GitRunResult {
  exitCode: number;
  stdout: Buffer;
  stderr: string;
  args: string[];
}

const STDERR_CAP = 64 * 1024;
const STDERR_DETAIL = 4 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT = 64 * 1024 * 1024;

/** After an abort, SIGTERM; SIGKILL if the process group is still there after this long. */
export const ABORT_GRACE_MS = 500;
/**
 * A SIGKILLed process that has not exited this long after is given up on: its helper (stopped or
 * wedged) is SIGKILLed, which settles the run and frees its slot (review #1).
 */
export const HELPER_EXIT_WAIT_MS = ABORT_GRACE_MS + 1_000;

/** The live clock (Effect's default), whose timers can be unref'd. */
const LIVE_CLOCK: Clock.Clock = Effect.runSync(Clock.clockWith(Effect.succeed));

/**
 * `Effect.sleep(ms)`, except that on the live clock its timer never holds the process open (as the
 * `setTimeout(...).unref()` it replaces). Any other clock (a test's `TestClock`) sleeps as usual.
 */
function sleepUnref(ms: number): Effect.Effect<void> {
  return Clock.clockWith((clock) =>
    clock !== LIVE_CLOCK
      ? clock.sleep(Duration.millis(ms))
      : Effect.callback<void>((resume) => {
          const handle = setTimeout(() => resume(Effect.void), ms);
          handle.unref();
          return Effect.sync(() => clearTimeout(handle));
        }),
  );
}

function hasNoIndex(args: readonly string[]): boolean {
  if (args[0] !== 'diff') return false;
  for (const arg of args) {
    if (arg === '--') return false;
    if (arg === '--no-index') return true;
  }
  return false;
}

/** Inserts the mandatory per-subcommand safety flags right after the subcommand. */
export function withSafetyFlags(args: readonly string[]): string[] {
  const [sub, ...rest] = args;
  if (sub === undefined) return [];
  const flags: string[] = [];
  if (DIFF_FAMILY.has(sub)) flags.push('--no-ext-diff', '--no-textconv', '--no-color');
  if (sub === 'log' || sub === 'show') flags.push('--no-show-signature');
  return [sub, ...flags, ...rest];
}

function locationArgs(location: GitLocation | undefined): string[] {
  const out: string[] = [];
  for (const [option, value] of [
    ['--git-dir', location?.gitDir],
    ['--work-tree', location?.workTree],
  ] as const) {
    if (value === undefined) continue;
    if (!path.isAbsolute(value) || value.includes('\u0000')) {
      throw new GitCoreError('invalid_argument', `${option} must be an absolute path: ${value}`);
    }
    out.push(`${option}=${value}`);
  }
  return out;
}

/** Full argv passed to the git binary for `args`. */
export function buildGitArgv(
  args: readonly string[],
  extraPins: readonly string[] = [],
  location?: GitLocation,
): string[] {
  return [
    '--no-pager',
    '--no-optional-locks',
    ...locationArgs(location),
    ...CONFIG_PIN_ARGS,
    ...extraPins,
    ...withSafetyFlags(args),
  ];
}

function classifyFailure(
  args: string[],
  cwd: string,
  exitCode: number | null,
  signal: string | null,
  stderr: string,
): GitCoreError {
  const details = { args, cwd, exitCode, signal, stderr: stderr.slice(0, STDERR_DETAIL) };
  if (/not a git repository/i.test(stderr)) {
    return new GitCoreError('not_a_repository', `not a git repository: ${cwd}`, details);
  }
  if (/dubious ownership/i.test(stderr)) {
    return new GitCoreError(
      'not_a_repository',
      `git refuses to use ${cwd}: the repository is owned by another user (see git's safe.directory)`,
      details,
    );
  }
  const firstLine = stderr.split('\n').find((line) => line.trim().length > 0) ?? '';
  return new GitCoreError(
    'git_failed',
    `git ${args[0] ?? ''} failed (exit ${exitCode ?? signal ?? '?'})${firstLine ? `: ${firstLine.trim()}` : ''}`,
    details,
  );
}

/**
 * The single git runner (PLAN §5.5). Every git process in git-core is spawned here, with an
 * argv array (never a shell), after the allowlist check, with `--no-optional-locks`, pinned
 * config, the safety environment, a timeout and an output cap.
 */
export class GitRunner {
  readonly gitBinary: string;
  private readonly timeoutMs: number;
  private readonly maxOutputBytes: number;
  private readonly env: Record<string, string>;
  private readonly logger: Logger;
  private readonly scheduler: LaneSemaphore<GitCoreError>;
  /** Starts the runner's fibers (scheduling, timers) with the runner's Effect context. */
  private readonly runFork: ReturnType<typeof Effect.runForkWith<never>>;
  private readonly children = new Map<ProcHandle, (error: GitCoreError) => void>();
  private disposed = false;
  private resolvedBinary: string | null = null;
  private readonly helper: HelperConfig | null;
  private pool: HelperPool | null = null;
  /** Owns the helper pool's scope (#46): built on the first helper spawn, disposed by `dispose`. */
  private runtime: ManagedRuntime.ManagedRuntime<GitHelperPool, never> | null = null;
  private readonly helperTest: HelperTestOptions;

  constructor(options: GitRunnerOptions = {}) {
    this.gitBinary = options.gitBinary ?? 'git';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    this.env = buildGitEnv(process.env, options.env);
    this.logger = options.logger ?? noopLogger;
    const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
    this.scheduler = new LaneSemaphore<GitCoreError>(concurrency);
    this.runFork = Effect.runForkWith(options.runnerTest?.context ?? Context.empty());
    // Diff files above the threshold as binary, so no single file's patch can exceed about
    // twice this size while it is streamed and hashed (`core.bigFileThreshold`).
    const threshold = options.bigFileThreshold ?? defaultBigFileThreshold(this.maxOutputBytes);
    this.extraPins = ['-c', `core.bigFileThreshold=${Math.floor(threshold)}`];
    this.helper = helperConfig(options.helper, concurrency, this.logger);
    this.helperTest = options.helperTest ?? {};
  }

  private readonly extraPins: readonly string[];

  /**
   * Absolute path of the git executable. A bare name is looked up in the absolute entries of
   * PATH only: spawning a bare name would let the OS resolve relative PATH entries (or, on
   * Windows, the working directory) against the repository being inspected.
   */
  binary(): string {
    if (this.resolvedBinary) return this.resolvedBinary;
    this.resolvedBinary = resolveExecutable(
      this.gitBinary,
      this.env.PATH ?? process.env.PATH ?? '',
    );
    return this.resolvedBinary;
  }

  /** A variable of the environment git processes get (e.g. `HOME`, `XDG_CONFIG_HOME`). */
  envValue(name: string): string | undefined {
    return this.env[name];
  }

  /** Runs an allowlisted git command. Rejects with `GitCoreError`. */
  run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
    if (this.disposed) return Promise.reject(disposedError());
    let argv: string[];
    try {
      assertAllowedGitArgs(args);
      if (options.input !== undefined) assertStdinAllowed(args);
      argv = buildGitArgv(args, this.extraPins, options.location);
    } catch (error) {
      return Promise.reject(error);
    }
    const okExitCodes = options.okExitCodes ?? (hasNoIndex(args) ? [0, 1] : [0]);
    const call = currentCall();
    const signal = options.signal ?? call?.signal;
    const lane = options.priority ?? call?.lane ?? 'background';
    return this.schedule(options.queueKey ?? options.cwd, lane, signal, (abort) =>
      this.execute(argv, [...args], { ...options, okExitCodes, signal: abort }),
    );
  }

  /** `git --version` (the one invocation outside the subcommand allowlist). */
  async version(): Promise<string> {
    if (this.disposed) throw disposedError();
    const call = currentCall();
    const result = await this.schedule(
      '\u0000version',
      call?.lane ?? 'background',
      call?.signal,
      (abort) =>
        this.execute(['--version'], ['--version'], {
          cwd: process.cwd(),
          okExitCodes: [0],
          signal: abort,
        }),
    );
    return result.stdout.toString('utf8').trim();
  }

  /** Kills in-flight processes and rejects queued work with `disposed`. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler.close(disposedError());
    for (const fail of [...this.children.values()]) fail(disposedError());
    // The helpers SIGKILL whatever is still running and exit (no orphans): closing the runtime's
    // scope releases the pool's supervisor, which closes every helper.
    await this.runtime?.dispose();
  }

  /**
   * Runs `start` once the lanes give it a slot (#47). The run is a fiber that waits for a permit of
   * the runner's `LaneSemaphore` and holds it until the run has settled; `signal` interrupts it.
   * Queued, it leaves the queue and `start` is never called (rejects with `aborted`). Running,
   * `start`'s own signal aborts, so its process gets SIGTERM and later SIGKILL (`execute`), and
   * the permit is released only once the run has settled, i.e. once its process has exited. A
   * started run's outcome is the run's own (an aborted one rejects with `aborted` and its args).
   */
  private schedule(
    key: string,
    lane: GitPriority,
    signal: AbortSignal | undefined,
    start: (signal: AbortSignal) => Promise<GitRunResult>,
  ): Promise<GitRunResult> {
    if (signal?.aborted) return Promise.reject(abortedError({ queued: true }));
    return new Promise<GitRunResult>((resolve, reject) => {
      let run: Promise<GitRunResult> | null = null;
      const work = Effect.callback<void>((resume, abort) => {
        let started: Promise<GitRunResult>;
        try {
          started = start(abort);
        } catch (error) {
          started = Promise.reject(error);
        }
        run = started;
        const settled = (): void => resume(Effect.void);
        started.then(settled, settled);
        // Interrupted: `abort` has fired; the permit is held until the run has settled.
        return Effect.callback<void>((done) => {
          const gone = (): void => done(Effect.void);
          started.then(gone, gone);
        });
      });
      const fiber = this.runFork(
        this.scheduler.withPermit(key, lane, work),
        signal ? { signal } : undefined,
      );
      fiber.addObserver((exit) => {
        const started = run as Promise<GitRunResult> | null;
        if (started) {
          started.then(resolve, reject);
          return;
        }
        // Never started: the queue was closed (dispose), or the signal fired while queued.
        const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
        reject(failure?._tag === 'Some' ? failure.value : abortedError({ queued: true }));
      });
    });
  }

  /**
   * Runs `fn` after `ms` on the runner's Effect clock (a test's `TestClock`, if it has one) and
   * returns what cancels it. `unref`: on the live clock the timer never holds the process open.
   */
  private timer(ms: number, fn: () => void, unref = false): () => void {
    const fiber = this.runFork(
      Effect.andThen(unref ? sleepUnref(ms) : Effect.sleep(Duration.millis(ms)), Effect.sync(fn)),
    );
    return () => fiber.interruptUnsafe();
  }

  private execute(
    argv: string[],
    args: string[],
    options: GitRunOptions & { okExitCodes: readonly number[] },
    attempt = 0,
    direct = false,
  ): Promise<GitRunResult> {
    if (this.disposed) return Promise.reject(disposedError());
    const { cwd } = options;
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const maxOutputBytes = options.maxOutputBytes ?? this.maxOutputBytes;
    const env = options.configEnv?.length ? withConfigEnv(this.env, options.configEnv) : this.env;
    const startedAt = performance.now();

    return new Promise<GitRunResult>((resolve, reject) => {
      let settled = false;
      let failure: GitCoreError | null = null;
      const stdoutChunks: Buffer[] = [];
      let stdoutBytes = 0;
      const stderrChunks: Buffer[] = [];
      let stderrBytes = 0;

      let proc: ProcHandle;
      let binary: string;
      const { signal } = options;
      // The scheduler already refuses aborted jobs; this keeps `execute` safe on its own.
      if (signal?.aborted) {
        reject(abortedError({ args, cwd }));
        return;
      }
      try {
        binary = this.binary();
      } catch (error) {
        reject(error);
        return;
      }

      let exited = false;
      let aborting = false;
      let retrying = false;
      const handlers: ProcHandlers = {
        exit: () => {
          exited = true;
          // An aborted run settles once its process is gone (its slot stays taken until then). The
          // forced cleanup of its process group (`onAbort`) stays armed: a filter or hook that
          // ignored SIGTERM may outlive git.
          if (aborting && failure) finish(failure);
        },
        stdout: (chunk: Buffer) => {
          if (failure) return;
          stdoutBytes += chunk.length;
          if (options.onStdout) {
            try {
              options.onStdout(chunk);
            } catch (error) {
              fail(
                error instanceof GitCoreError
                  ? error
                  : new GitCoreError(
                      'git_failed',
                      `processing git output failed: ${String(error)}`,
                      { args, cwd },
                    ),
              );
            }
            return;
          }
          if (stdoutBytes > maxOutputBytes) {
            fail(tooLargeError(args, cwd, maxOutputBytes));
            return;
          }
          stdoutChunks.push(chunk);
        },
        stderr: (chunk: Buffer) => {
          if (stderrBytes >= STDERR_CAP) return;
          stderrChunks.push(chunk);
          stderrBytes += chunk.length;
        },
        error: (error) => {
          finish(spawnError(error, this.gitBinary, args, cwd));
        },
        tooLarge: () => {
          if (!failure) fail(tooLargeError(args, cwd, maxOutputBytes));
        },
        lost: (reason, retryable, refused) => {
          // The helper died (or refused the request): the process is gone, its group killed.
          exited = true;
          if (failure) {
            finish(failure);
            return;
          }
          if (refused && attempt === 0) {
            // The helper would refuse it again (a limit or a shape it does not take): directly.
            this.logger.warn('git helper refused a request; running it directly', {
              args,
              cwd,
              reason,
            });
            retrying = true;
            finish(null);
            this.execute(argv, args, options, attempt + 1, true).then(resolve, reject);
            return;
          }
          // Once (#45): a read-only command can run again, unless streamed output already went out.
          // Once more when the pool just gave up (a helper that cannot start): then directly.
          const again = attempt === 0 || (attempt === 1 && !this.usesHelper);
          // Never next to a process of the first try that may still run (`retryable`).
          if (retryable && again && (!options.onStdout || stdoutBytes === 0)) {
            this.logger.debug('git retried', { args, cwd, reason });
            retrying = true;
            finish(null);
            this.execute(argv, args, options, attempt + 1).then(resolve, reject);
            return;
          }
          fail(
            new GitCoreError('git_failed', `git ${args[0] ?? ''} failed: ${reason}`, {
              args,
              cwd,
              helper: 'lost',
            }),
          );
        },
        close: (code, closeSignal) => {
          if (failure) {
            finish(failure);
            return;
          }
          const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, STDERR_CAP);
          if (code === null || !options.okExitCodes.includes(code)) {
            finish(classifyFailure(args, cwd, code, closeSignal, stderr));
            return;
          }
          finish(null, { exitCode: code, stdout: Buffer.concat(stdoutChunks), stderr, args });
        },
      };

      try {
        options.onSpawn?.();
        proc = this.spawnProcess(binary, argv, direct, {
          cwd,
          env,
          input: options.input,
          maxOutputBytes: options.onStdout ? null : maxOutputBytes,
          handlers,
        });
      } catch (error) {
        reject(spawnError(error, this.gitBinary, args, cwd));
        return;
      }

      let watchdog = false;
      /** SIGKILL, and give up on the helper if even that brings no exit (review #1). */
      const kill = (): void => {
        proc.kill();
        if (watchdog || !proc.abandon) return;
        watchdog = true;
        this.timer(
          this.helperTest.exitWaitMs ?? HELPER_EXIT_WAIT_MS,
          () => {
            if (!exited) proc.abandon?.();
          },
          true,
        );
      };
      const fail = (error: GitCoreError): void => {
        if (failure) {
          // Already stopping (an abort's grace period): a timeout or dispose escalates, and an
          // aborted run whose process still has not exited gives up on its helper now.
          if (!exited) {
            proc.kill();
            proc.abandon?.();
          }
          return;
        }
        failure = error;
        kill();
        // Settle now: a grandchild may keep the pipes (and so 'close') open.
        proc.detach();
        finish(error);
      };
      this.children.set(proc, fail);
      const onAbort = (): void => {
        if (failure) return;
        failure = abortedError({ args, cwd });
        aborting = true;
        proc.detach();
        if (exited) {
          finish(failure);
          return;
        }
        proc.kill('SIGTERM');
        // SIGKILL for the whole group after the grace period, also when git itself exited on the
        // SIGTERM: helpers that ignore it (a trusted filter) must not outlive the request. Not
        // cleared by `finish` or the exit; unref'd so it never holds the process open. A group that
        // is already gone makes the kill a no-op. On the runner's Effect clock (#47).
        this.timer(ABORT_GRACE_MS, kill, true);
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const cancelTimeout = this.timer(timeoutMs, () => {
        fail(
          new GitCoreError('timeout', `git ${args[0]} timed out after ${timeoutMs} ms`, {
            args,
            cwd,
          }),
        );
      });

      const finish = (error: GitCoreError | null, result?: GitRunResult): void => {
        if (settled) return;
        settled = true;
        cancelTimeout();
        signal?.removeEventListener('abort', onAbort);
        this.children.delete(proc);
        if (retrying) return;
        const elapsed = Math.round(performance.now() - startedAt);
        if (error) {
          this.logger.debug('git failed', { args, cwd, code: error.code, ms: elapsed });
          reject(error);
        } else if (result) {
          this.logger.debug('git', { args, cwd, ms: elapsed, bytes: stdoutBytes });
          resolve(result);
        }
      };
    });
  }

  /** Starts git through the helper pool when it is on, else directly (`spawn` may throw). */
  private spawnProcess(
    binary: string,
    argv: string[],
    direct: boolean,
    request: {
      cwd: string;
      env: Record<string, string>;
      input: Buffer | undefined;
      maxOutputBytes: number | null;
      handlers: ProcHandlers;
    },
  ): ProcHandle {
    const pool = direct ? null : this.helperPool(binary);
    if (pool) {
      const message: HelperSpawnRequest = {
        binary,
        argv,
        // The helper runs in `/`: resolve here, as spawn would against this process's cwd.
        cwd: path.resolve(request.cwd),
        env: request.env,
        input: request.input,
        maxOutputBytes: request.maxOutputBytes,
      };
      // null: no helper can take it right now (a restart backoff): spawn directly.
      const handle = helperRequestFits(message) ? pool.startGit(message, request.handlers) : null;
      if (handle) return handle;
    }
    return spawnDirect(binary, argv, request);
  }

  private helperPool(binary: string): HelperPool | null {
    if (!this.helper) return null;
    if (!this.pool) {
      const runtime = ManagedRuntime.make(
        gitHelperPoolLayer({
          gitBinary: binary,
          entry: this.helper.entry,
          processes: this.helper.processes,
          logger: this.logger,
          ...(this.helper.execPath ? { execPath: this.helper.execPath } : {}),
          test: this.helperTest,
        }),
      );
      // The layer builds synchronously (nothing starts until the first spawn asks for a helper).
      this.pool = runtime.runSync(GitHelperPool);
      this.runtime = runtime;
    }
    return this.pool.available ? this.pool : null;
  }

  /** Whether git processes go through the spawn helper (#45) right now. */
  get usesHelper(): boolean {
    return this.helper !== null && (this.pool?.available ?? true);
  }

  /** PIDs of the git processes the helpers told this process about (tests and diagnostics). */
  helperChildPids(): number[] {
    return this.pool?.childPids() ?? [];
  }

  /** PIDs of the running helper processes (tests and diagnostics). */
  helperPids(): number[] {
    return this.pool?.pids() ?? [];
  }

  /** SIGKILLs the helper processes (tests: crash recovery). */
  killHelpersForTest(): void {
    this.pool?.killHelpers();
  }
}

function tooLargeError(args: string[], cwd: string, maxOutputBytes: number): GitCoreError {
  return new GitCoreError(
    'output_too_large',
    `git ${args[0]} produced more than ${maxOutputBytes} bytes`,
    { args, cwd, maxOutputBytes },
  );
}

/** A SPAWN frame the helper accepts (else the call spawns directly, as before #45). */
function helperRequestFits(request: HelperSpawnRequest): boolean {
  // The helper's own limits (review #2): above them it refuses, and spawn would not.
  if (request.argv.length > HELPER_MAX_ARGV) return false;
  if (Object.keys(request.env).length > HELPER_MAX_ENV) return false;
  let bytes = 256;
  for (const arg of request.argv) bytes += Buffer.byteLength(arg) * 2 + 8;
  for (const [key, value] of Object.entries(request.env)) {
    bytes += (Buffer.byteLength(key) + Buffer.byteLength(value)) * 2 + 8;
  }
  bytes += Buffer.byteLength(request.cwd) * 2;
  return bytes <= HELPER_MAX_REQUEST_FRAME;
}

/** The direct path: `child_process.spawn` in this process (the helper's kill switch). */
function spawnDirect(
  binary: string,
  argv: string[],
  request: {
    cwd: string;
    env: Record<string, string>;
    input: Buffer | undefined;
    handlers: ProcHandlers;
  },
): ProcHandle {
  const { handlers } = request;
  const child = spawn(binary, argv, {
    cwd: request.cwd,
    env: request.env,
    stdio: [request.input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // Own process group on POSIX, so a timeout kills git's children too.
    detached: USE_PROCESS_GROUP,
  });
  child.once('exit', () => handlers.exit());
  if (request.input && child.stdin) {
    // git may exit before reading everything (e.g. on an error): ignore EPIPE.
    child.stdin.on('error', () => {});
    child.stdin.end(request.input);
  }
  child.stdout?.on('data', (chunk: Buffer) => handlers.stdout(chunk));
  child.stderr?.on('data', (chunk: Buffer) => handlers.stderr(chunk));
  child.on('error', (error) => handlers.error(error));
  child.on('close', (code, signal) => handlers.close(code, signal));
  return {
    kill: (signal = 'SIGKILL') => killTree(child, signal),
    detach: () => {
      child.stdout?.destroy();
      child.stderr?.destroy();
    },
  };
}

const USE_PROCESS_GROUP = process.platform !== 'win32';

/** Files above this size are diffed as binary (one patch then stays below ~2x this size). */
export function defaultBigFileThreshold(maxOutputBytes: number): number {
  return Math.max(maxOutputBytes, 1024 * 1024);
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (process.platform !== 'win32') accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves a command to an absolute path using only absolute PATH entries. */
export function resolveExecutable(command: string, searchPath: string): string {
  if (command.includes('/') || command.includes('\\') || path.isAbsolute(command)) {
    return path.resolve(command);
  }
  const names =
    process.platform === 'win32' && !path.extname(command)
      ? [`${command}.exe`, `${command}.com`]
      : [command];
  for (const dir of searchPath.split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  throw new GitCoreError('git_not_found', `git executable not found in PATH (${command})`);
}

function killTree(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): void {
  if (USE_PROCESS_GROUP && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      // One SIGKILL to a group can miss a member forked at that moment (macOS): repeat it while
      // the group is still there (DECISIONS #393).
      if (signal === 'SIGKILL') void reapGroup(child.pid, { maxMs: 5_000 });
      return;
    } catch {
      // Group already gone, or not a group leader: fall back to the process itself.
    }
  }
  child.kill(signal);
}

function disposedError(): GitCoreError {
  return new GitCoreError('disposed', 'git-core has been disposed');
}

function spawnError(error: unknown, binary: string, args: string[], cwd: string): GitCoreError {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    // ENOENT is reported both for a missing binary and a missing cwd.
    if (!existsSync(cwd)) {
      return new GitCoreError('not_found', `directory does not exist: ${cwd}`, { args, cwd });
    }
    return new GitCoreError('git_not_found', `git executable not found (${binary})`, {
      args,
      cwd,
    });
  }
  return new GitCoreError('git_failed', `failed to start git: ${String(error)}`, { args, cwd });
}
