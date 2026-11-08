import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { GitCoreError, type Logger, noopLogger } from '@octopus-diff/contracts';
import { assertAllowedGitArgs, DIFF_FAMILY } from './allowlist.js';
import { CONFIG_PIN_ARGS } from './config-pins.js';
import { buildGitEnv, withConfigEnv } from './env.js';

export interface GitRunnerOptions {
  gitBinary?: string;
  /** Max concurrent git processes overall (default 4). */
  concurrency?: number;
  timeoutMs?: number;
  maxOutputBytes?: number;
  env?: Record<string, string>;
  logger?: Logger;
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

interface Job {
  start: () => Promise<GitRunResult>;
  resolve: (value: GitRunResult) => void;
  reject: (error: unknown) => void;
}

/**
 * Global concurrency limit with per-key FIFO queues served round-robin, so one busy
 * repository cannot starve the others.
 */
class FairScheduler {
  private active = 0;
  private readonly queues = new Map<string, Job[]>();
  private readonly ring: string[] = [];

  constructor(private readonly limit: number) {}

  schedule(key: string, start: () => Promise<GitRunResult>): Promise<GitRunResult> {
    return new Promise<GitRunResult>((resolve, reject) => {
      let queue = this.queues.get(key);
      if (!queue) {
        queue = [];
        this.queues.set(key, queue);
        this.ring.push(key);
      }
      queue.push({ start, resolve, reject });
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.limit && this.ring.length > 0) {
      const key = this.ring.shift() as string;
      const queue = this.queues.get(key);
      const job = queue?.shift();
      if (!queue || !job) {
        this.queues.delete(key);
        continue;
      }
      if (queue.length > 0) this.ring.push(key);
      else this.queues.delete(key);
      this.active += 1;
      job
        .start()
        .then(job.resolve, job.reject)
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }

  rejectAll(error: unknown): void {
    for (const queue of this.queues.values()) {
      for (const job of queue) job.reject(error);
    }
    this.queues.clear();
    this.ring.length = 0;
  }
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

/** Full argv passed to the git binary for `args`. */
export function buildGitArgv(args: readonly string[]): string[] {
  return ['--no-pager', '--no-optional-locks', ...CONFIG_PIN_ARGS, ...withSafetyFlags(args)];
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
  private readonly scheduler: FairScheduler;
  private readonly children = new Map<ChildProcess, (error: GitCoreError) => void>();
  private disposed = false;

  constructor(options: GitRunnerOptions = {}) {
    this.gitBinary = options.gitBinary ?? 'git';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    this.env = buildGitEnv(process.env, options.env);
    this.logger = options.logger ?? noopLogger;
    this.scheduler = new FairScheduler(Math.max(1, Math.floor(options.concurrency ?? 4)));
  }

  /** Runs an allowlisted git command. Rejects with `GitCoreError`. */
  run(args: readonly string[], options: GitRunOptions): Promise<GitRunResult> {
    if (this.disposed) return Promise.reject(disposedError());
    try {
      assertAllowedGitArgs(args);
    } catch (error) {
      return Promise.reject(error);
    }
    const argv = buildGitArgv(args);
    const okExitCodes = options.okExitCodes ?? (hasNoIndex(args) ? [0, 1] : [0]);
    return this.scheduler.schedule(options.queueKey ?? options.cwd, () =>
      this.execute(argv, [...args], { ...options, okExitCodes }),
    );
  }

  /** `git --version` (the one invocation outside the subcommand allowlist). */
  async version(): Promise<string> {
    if (this.disposed) throw disposedError();
    const result = await this.scheduler.schedule('\u0000version', () =>
      this.execute(['--version'], ['--version'], { cwd: process.cwd(), okExitCodes: [0] }),
    );
    return result.stdout.toString('utf8').trim();
  }

  /** Kills in-flight processes and rejects queued work with `disposed`. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.scheduler.rejectAll(disposedError());
    for (const fail of [...this.children.values()]) fail(disposedError());
  }

  private execute(
    argv: string[],
    args: string[],
    options: GitRunOptions & { okExitCodes: readonly number[] },
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

      let child: ChildProcess;
      try {
        child = spawn(this.gitBinary, argv, {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          // Own process group on POSIX, so a timeout kills git's children too.
          detached: USE_PROCESS_GROUP,
        });
      } catch (error) {
        reject(spawnError(error, this.gitBinary, args, cwd));
        return;
      }

      const fail = (error: GitCoreError): void => {
        if (failure) return;
        failure = error;
        killTree(child);
        // Settle now: a grandchild may keep the pipes (and so 'close') open.
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(error);
      };
      this.children.set(child, fail);

      const timer = setTimeout(() => {
        fail(
          new GitCoreError('timeout', `git ${args[0]} timed out after ${timeoutMs} ms`, {
            args,
            cwd,
          }),
        );
      }, timeoutMs);

      const finish = (error: GitCoreError | null, result?: GitRunResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(child);
        const elapsed = Math.round(performance.now() - startedAt);
        if (error) {
          this.logger.debug('git failed', { args, cwd, code: error.code, ms: elapsed });
          reject(error);
        } else if (result) {
          this.logger.debug('git', { args, cwd, ms: elapsed, bytes: stdoutBytes });
          resolve(result);
        }
      };

      child.stdout?.on('data', (chunk: Buffer) => {
        if (failure) return;
        stdoutBytes += chunk.length;
        if (options.onStdout) {
          try {
            options.onStdout(chunk);
          } catch (error) {
            fail(
              error instanceof GitCoreError
                ? error
                : new GitCoreError('git_failed', `processing git output failed: ${String(error)}`, {
                    args,
                    cwd,
                  }),
            );
          }
          return;
        }
        if (stdoutBytes > maxOutputBytes) {
          fail(
            new GitCoreError(
              'output_too_large',
              `git ${args[0]} produced more than ${maxOutputBytes} bytes`,
              { args, cwd, maxOutputBytes },
            ),
          );
          return;
        }
        stdoutChunks.push(chunk);
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        if (stderrBytes >= STDERR_CAP) return;
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      });

      child.on('error', (error) => {
        finish(spawnError(error, this.gitBinary, args, cwd));
      });

      child.on('close', (code, signal) => {
        if (failure) {
          finish(failure);
          return;
        }
        const stderr = Buffer.concat(stderrChunks).toString('utf8').slice(0, STDERR_CAP);
        if (code === null || !options.okExitCodes.includes(code)) {
          finish(classifyFailure(args, cwd, code, signal, stderr));
          return;
        }
        finish(null, { exitCode: code, stdout: Buffer.concat(stdoutChunks), stderr, args });
      });
    });
  }
}

const USE_PROCESS_GROUP = process.platform !== 'win32';

function killTree(child: ChildProcess): void {
  if (USE_PROCESS_GROUP && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Group already gone, or not a group leader: fall back to the process itself.
    }
  }
  child.kill('SIGKILL');
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
