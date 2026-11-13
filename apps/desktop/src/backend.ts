/**
 * The backend supervisor (docs/DESKTOP.md §3.1): runs the CLI's `serve --ready-fd 3
 * --exit-with-stdin` as a child of the Electron binary in Node mode, reads the one ready line from
 * fd 3, and keeps a daemon available for the window.
 *
 * - `started`: the child is the daemon. The app owns it: an unexpected exit restarts it with
 *   backoff; after `maxFailures` failures in a row the state is `failed` (the error screen). On
 *   `stop()` the supervisor closes the child's stdin (the CLI treats EOF as a shutdown request), then
 *   sends SIGTERM and finally SIGKILL after grace periods.
 * - `attached`: a verified daemon was already running for the state dir; the child printed its
 *   details and exits 0. The app does not own that daemon: `stop()` leaves it running. The
 *   supervisor polls its health, and when it goes away runs `serve` again (which then starts one).
 *
 * stdin is always a pipe, never `ignore`: its EOF is the lifeline, so a crashed or SIGKILLed
 * Electron leaves no daemon behind. fd 3 is a pipe for the ready line. stdout/stderr go to the log:
 * straight into its file descriptor when `outputFd` is given (the app does this, so the daemon's
 * shutdown output does not hit a broken pipe after a crash), else through pipes to `log.output`.
 * The ready line holds the token in `authUrl`: it is never logged.
 *
 * Pure and Electron-free: spawning, timers and the health probe are injected (unit tests drive a
 * fake child and a fake clock; `scripts/smoke-backend.mjs` runs it against the real CLI).
 */
import type { ServeReady } from '@octopus-diff/contracts';
import { ServeReadySchema } from '@octopus-diff/contracts';

/** The fd the ready line arrives on (stdio index 3). */
export const READY_FD = 3;
/** A ready line is ~200 bytes; anything far bigger is not one (and is never buffered further). */
export const READY_LINE_MAX_BYTES = 16 * 1024;

export interface ReadableLike {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  on(event: 'end' | 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  destroy?(): void;
}

export interface WritableLike {
  end(): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  readonly destroyed?: boolean;
}

/** The part of `ChildProcess` the supervisor uses. */
export interface ChildLike {
  readonly pid?: number | undefined;
  readonly stdin: WritableLike | null;
  readonly stdout: ReadableLike | null;
  readonly stderr: ReadableLike | null;
  readonly stdio: readonly unknown[];
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | string | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(
    event: 'exit',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

export type StdioLike = ['pipe', 'pipe' | number, 'pipe' | number, 'pipe'];

export interface SpawnOptionsLike {
  env: Record<string, string | undefined>;
  stdio: StdioLike;
  windowsHide: boolean;
  cwd?: string | undefined;
}

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsLike,
) => ChildLike;

export interface TimersLike {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

export interface BackendLog {
  /** The daemon's stdout/stderr, as is (the app appends it to daemon.log). */
  output(chunk: Buffer | string): void;
  /** One supervisor line (never contains the token). */
  note(line: string): void;
}

export interface BackendPolicy {
  /** Delay before restart attempt n (1-based; the last entry repeats). */
  backoffMs: readonly number[];
  /** Consecutive failures (exits without a ready line, or a started daemon dying) before `failed`. */
  maxFailures: number;
  /** A started daemon that served this long resets the failure count when it exits. */
  stableMs: number;
  /** No ready line within this time: the attempt failed (the child is killed). */
  readyTimeoutMs: number;
  /** After closing stdin, how long the daemon gets to shut down before SIGTERM. */
  stopGraceMs: number;
  /** After SIGTERM, how long before SIGKILL. */
  killGraceMs: number;
  /** Health poll interval for an attached daemon. */
  attachedPollMs: number;
  /** Failed polls in a row before an attached daemon counts as gone. */
  attachedMisses: number;
}

export const DEFAULT_POLICY: BackendPolicy = {
  backoffMs: [500, 1_000, 2_000, 4_000, 8_000],
  maxFailures: 5,
  stableMs: 60_000,
  readyTimeoutMs: 30_000,
  // The CLI itself gives the daemon 10 s to close; most closes take well under a second.
  stopGraceMs: 8_000,
  killGraceMs: 3_000,
  attachedPollMs: 5_000,
  attachedMisses: 2,
};

export type ReadyInfo = ServeReady & {
  /** The daemon's version differs from the app's CLI (attached to another install). */
  versionMismatch: boolean;
};

export type BackendState =
  | { kind: 'idle' }
  | { kind: 'starting'; attempt: number }
  | { kind: 'ready'; ready: ReadyInfo }
  | { kind: 'restarting'; attempt: number; delayMs: number; reason: string }
  | { kind: 'failed'; reason: string; failures: number }
  | { kind: 'stopping' }
  | { kind: 'stopped' };

export interface BackendOptions {
  spawn: SpawnLike;
  /** The program: Electron's binary (`process.execPath`), run in Node mode. */
  command: string;
  /** Everything after the program: the CLI entry and `serve` flags (see `serveArgs`). */
  args: readonly string[];
  /** The child's environment (PATH already resolved); `ELECTRON_RUN_AS_NODE=1` is added. */
  env: Record<string, string | undefined>;
  cwd?: string;
  /** The app's own CLI version, compared with the ready line's. */
  appVersion: string;
  log: BackendLog;
  /** A file descriptor (append mode) for the daemon's stdout and stderr; pipes when absent. */
  outputFd?: number | null;
  timers: TimersLike;
  /** True when the daemon at `url` answers its health check (polls attached daemons). */
  probe(url: string): Promise<boolean>;
  onState?(state: BackendState): void;
  policy?: Partial<BackendPolicy>;
}

/** stdin and fd 3 are always pipes; stdout/stderr are the log file's fd when there is one. */
export function backendStdio(outputFd: number | null | undefined): StdioLike {
  const out = typeof outputFd === 'number' ? outputFd : 'pipe';
  return ['pipe', out, out, 'pipe'];
}

/** The `serve` arguments the app always passes (after the CLI entry), then the caller's extras. */
export function serveArgs(extra: readonly string[] = []): string[] {
  return ['serve', '--ready-fd', String(READY_FD), '--exit-with-stdin', '--no-open', ...extra];
}

/**
 * The child's environment: the caller's, plus `ELECTRON_RUN_AS_NODE=1` (mandatory, DESKTOP §10:
 * without it Electron's binary starts the app again, and the daemon's watch host inherits it).
 */
export function backendEnv(
  base: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return { ...base, ELECTRON_RUN_AS_NODE: '1' };
}

export type ReadyParse = { ok: true; ready: ServeReady } | { ok: false; reason: string };

/**
 * Parses the fd 3 output: one JSON line (`ServeReadySchema`). The reason never quotes the input
 * (it holds the token): only what was wrong with it.
 */
export function parseReadyLine(text: string): ReadyParse {
  const newline = text.indexOf('\n');
  const line = (newline === -1 ? text : text.slice(0, newline)).trim();
  if (line === '') return { ok: false, reason: 'no ready line' };
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return { ok: false, reason: 'the ready line is not JSON' };
  }
  const result = ServeReadySchema.safeParse(json);
  if (!result.success) {
    const fields = [...new Set(result.error.issues.map((i) => i.path.join('.') || '(root)'))];
    return { ok: false, reason: `invalid ready line (${fields.join(', ')})` };
  }
  return { ok: true, ready: result.data };
}

/** Backoff delay before restart attempt `attempt` (1-based). */
export function backoffDelay(policy: Pick<BackendPolicy, 'backoffMs'>, attempt: number): number {
  const list = policy.backoffMs;
  if (list.length === 0) return 0;
  const index = Math.min(Math.max(attempt, 1), list.length) - 1;
  return list[index] ?? 0;
}

function describeExit(code: number | null, signal: string | null): string {
  if (signal) return `killed by ${signal}`;
  return `exited with code ${code ?? 'unknown'}`;
}

interface Run {
  readonly child: ChildLike;
  readonly startedAt: number;
  ready: ServeReady | null;
  readyAt: number | null;
  exited: boolean;
  /** The ready line was dealt with (parsed, or the attempt failed): later fd 3 data is ignored. */
  settled: boolean;
  buffer: string;
  readyTimer: unknown;
  /** Why the attempt failed before a ready line (set by `#attemptFailed`). */
  failReason: string | null;
  /** fd 3 ended (or there is none): the ready line, if any, has been read. */
  fd3Ended: boolean;
  /** Called when fd 3 ends, if the child's exit is waiting for it. */
  onFd3End: (() => void) | null;
  /** Resolves when the child exited (and its exit was handled). */
  readonly exit: Promise<void>;
}

/** After the child's `exit`, how long to wait for fd 3 to deliver what the child wrote. */
const FD3_DRAIN_MS = 500;

export class BackendSupervisor {
  readonly #o: BackendOptions;
  readonly #policy: BackendPolicy;
  #state: BackendState = { kind: 'idle' };
  #run: Run | null = null;
  #failures = 0;
  #restartTimer: unknown = null;
  #pollTimer: unknown = null;
  #misses = 0;
  #stopping: Promise<void> | null = null;

  constructor(options: BackendOptions) {
    this.#o = options;
    this.#policy = { ...DEFAULT_POLICY, ...options.policy };
  }

  get state(): BackendState {
    return this.#state;
  }

  /** Pid of the child this app runs right now (a `started` daemon or a short-lived attach). */
  get childPid(): number | undefined {
    return this.#run && !this.#run.exited ? this.#run.child.pid : undefined;
  }

  /** True when the app owns the daemon (it started it): quitting stops it. */
  get ownsDaemon(): boolean {
    return this.#run?.ready?.mode === 'started' && !this.#run.exited;
  }

  start(): void {
    if (this.#stopping || this.#run) return;
    this.#launch();
  }

  /** After `failed` (the error screen's "Try again"): a fresh series of attempts. */
  retry(): void {
    if (this.#stopping) return;
    if (this.#state.kind !== 'failed' && this.#state.kind !== 'restarting') return;
    this.#clear('restart');
    this.#failures = 0;
    if (!this.#run) this.#launch();
  }

  /**
   * Stops supervising. An owned daemon (and a child that has not sent its ready line yet) is shut
   * down: stdin closed, then SIGTERM, then SIGKILL. An attached daemon is left running.
   */
  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    this.#clear('restart');
    this.#clear('poll');
    this.#setState({ kind: 'stopping' });
    const run = this.#run;
    this.#stopping = (async () => {
      if (run && !run.exited) {
        this.#clearReadyTimer(run);
        await this.#shutdown(run);
      }
      this.#setState({ kind: 'stopped' });
    })();
    return this.#stopping;
  }

  #setState(state: BackendState): void {
    this.#state = state;
    this.#o.onState?.(state);
  }

  #clear(which: 'restart' | 'poll'): void {
    const t = this.#o.timers;
    if (which === 'restart' && this.#restartTimer !== null) {
      t.clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    if (which === 'poll' && this.#pollTimer !== null) {
      t.clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
  }

  #clearReadyTimer(run: Run): void {
    if (run.readyTimer !== null) {
      this.#o.timers.clearTimeout(run.readyTimer);
      run.readyTimer = null;
    }
  }

  #launch(): void {
    const attempt = this.#failures + 1;
    this.#setState({ kind: 'starting', attempt });
    let child: ChildLike;
    try {
      child = this.#o.spawn(this.#o.command, this.#o.args, {
        env: backendEnv(this.#o.env),
        stdio: backendStdio(this.#o.outputFd),
        windowsHide: true,
        cwd: this.#o.cwd,
      });
    } catch (error) {
      this.#o.log.note(`could not start the daemon: ${errorText(error)}`);
      this.#failed(`could not start the daemon: ${errorText(error)}`);
      return;
    }
    let resolveExit: () => void = () => undefined;
    const exit = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const run: Run = {
      child,
      startedAt: this.#o.timers.now(),
      ready: null,
      readyAt: null,
      exited: false,
      settled: false,
      buffer: '',
      readyTimer: null,
      failReason: null,
      fd3Ended: false,
      onFd3End: null,
      exit,
    };
    this.#run = run;
    this.#o.log.note(`started the backend (pid ${child.pid ?? '?'}, attempt ${attempt})`);

    child.stdout?.on('data', (chunk) => this.#o.log.output(chunk));
    child.stderr?.on('data', (chunk) => this.#o.log.output(chunk));
    // A closed pipe (the child already gone) must not crash the main process.
    child.stdin?.on('error', () => undefined);
    child.stdout?.on('error', () => undefined);
    child.stderr?.on('error', () => undefined);

    const fd3 = child.stdio[READY_FD] as ReadableLike | null | undefined;
    const fd3End = () => {
      if (run.fd3Ended) return;
      run.fd3Ended = true;
      if (!run.settled && run.buffer !== '') this.#readyText(run);
      run.onFd3End?.();
    };
    if (!fd3) {
      run.fd3Ended = true;
      this.#o.log.note('the backend has no ready pipe (fd 3)');
    } else {
      fd3.on('error', () => undefined);
      fd3.on('data', (chunk) => {
        if (run.settled) return;
        run.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        if (run.buffer.includes('\n')) this.#readyText(run);
        else if (run.buffer.length > READY_LINE_MAX_BYTES) {
          run.buffer = '';
          this.#attemptFailed(run, 'the ready line is too long');
        }
        // An exit that was waiting for the line can be handled now.
        if (run.settled) run.onFd3End?.();
      });
      fd3.on('end', fd3End);
      fd3.on('close', fd3End);
    }

    run.readyTimer = this.#o.timers.setTimeout(() => {
      run.readyTimer = null;
      if (!run.settled) {
        this.#attemptFailed(run, `no ready line within ${this.#policy.readyTimeoutMs} ms`);
      }
    }, this.#policy.readyTimeoutMs);

    let gone = false;
    const onGone = (code: number | null, signal: string | null) => {
      if (gone) return;
      gone = true;
      run.exited = true;
      let finished = false;
      let drainTimer: unknown = null;
      const finish = () => {
        if (finished) return;
        finished = true;
        if (drainTimer !== null) this.#o.timers.clearTimeout(drainTimer);
        this.#clearReadyTimer(run);
        this.#onExit(run, code, signal);
        resolveExit();
      };
      // `exit` can come before the pipes are drained: an attach run exits right after its line.
      if (run.settled || run.fd3Ended) finish();
      else {
        run.onFd3End = finish;
        drainTimer = this.#o.timers.setTimeout(finish, FD3_DRAIN_MS);
      }
    };
    child.once('exit', (code, signal) => onGone(code, signal));
    // `error` without `exit` happens when the program could not be spawned at all.
    child.once('error', (error) => {
      this.#o.log.note(`backend process error: ${errorText(error)}`);
      if (child.pid === undefined) onGone(null, null);
    });
  }

  #readyText(run: Run): void {
    const parsed = parseReadyLine(run.buffer);
    run.buffer = '';
    if (!parsed.ok) {
      this.#attemptFailed(run, parsed.reason);
      return;
    }
    run.settled = true;
    this.#clearReadyTimer(run);
    if (this.#stopping) return;
    const ready = parsed.ready;
    run.ready = ready;
    run.readyAt = this.#o.timers.now();
    const versionMismatch = ready.version !== this.#o.appVersion;
    // Never authUrl: it holds the token.
    this.#o.log.note(
      `backend ready: ${ready.mode} ${ready.url} (daemon pid ${ready.pid}, version ${ready.version}` +
        `${versionMismatch ? `, app CLI ${this.#o.appVersion}` : ''})`,
    );
    if (ready.mode === 'attached') {
      // Not ours: a later exit of a started daemon no longer counts against this one.
      this.#failures = 0;
      this.#misses = 0;
      this.#schedulePoll(ready.url);
    }
    this.#setState({ kind: 'ready', ready: { ...ready, versionMismatch } });
  }

  /** This attempt cannot produce a daemon: kill the child; its exit schedules the retry. */
  #attemptFailed(run: Run, reason: string): void {
    if (run.settled) return;
    run.settled = true;
    this.#clearReadyTimer(run);
    this.#o.log.note(`backend failed to start: ${reason}`);
    run.failReason = reason;
    if (!run.exited) {
      run.child.kill('SIGTERM');
      // The exit handler takes it from here; make sure it comes.
      const t = this.#o.timers.setTimeout(() => {
        if (!run.exited) run.child.kill('SIGKILL');
      }, this.#policy.killGraceMs);
      void run.exit.then(() => this.#o.timers.clearTimeout(t));
    }
  }

  #onExit(run: Run, code: number | null, signal: string | null): void {
    if (this.#run === run) this.#run = null;
    const how = describeExit(code, signal);
    if (this.#stopping) {
      this.#o.log.note(`backend stopped (${how})`);
      return;
    }
    if (run.ready?.mode === 'attached') {
      // Expected: the attach run exits 0 after its line. The attached daemon is polled instead.
      if (code !== 0) this.#o.log.note(`the attach run ${how}`);
      return;
    }
    const reason =
      run.failReason ??
      (run.ready ? `the daemon ${how}` : `the backend ${how} before it was ready`);
    if (run.ready && run.readyAt !== null) {
      // A daemon that served for a while was healthy: start counting again.
      if (this.#o.timers.now() - run.readyAt >= this.#policy.stableMs) this.#failures = 0;
    }
    this.#o.log.note(reason);
    this.#failed(reason);
  }

  #failed(reason: string): void {
    this.#failures += 1;
    if (this.#failures >= this.#policy.maxFailures) {
      this.#o.log.note(`giving up after ${this.#failures} failures`);
      this.#setState({ kind: 'failed', reason, failures: this.#failures });
      return;
    }
    const attempt = this.#failures + 1;
    const delayMs = backoffDelay(this.#policy, this.#failures);
    this.#setState({ kind: 'restarting', attempt, delayMs, reason });
    this.#restartTimer = this.#o.timers.setTimeout(() => {
      this.#restartTimer = null;
      if (!this.#stopping && !this.#run) this.#launch();
    }, delayMs);
  }

  #schedulePoll(url: string): void {
    this.#clear('poll');
    this.#pollTimer = this.#o.timers.setTimeout(() => {
      this.#pollTimer = null;
      void this.#poll(url);
    }, this.#policy.attachedPollMs);
  }

  async #poll(url: string): Promise<void> {
    if (this.#stopping) return;
    let alive = false;
    try {
      alive = await this.#o.probe(url);
    } catch {
      alive = false;
    }
    if (this.#stopping) return;
    // Still the attached daemon we are watching? (A retry may have replaced it.)
    if (this.#state.kind !== 'ready' || this.#state.ready.mode !== 'attached') return;
    if (this.#state.ready.url !== url) return;
    this.#misses = alive ? 0 : this.#misses + 1;
    if (this.#misses >= this.#policy.attachedMisses) {
      this.#misses = 0;
      this.#o.log.note(`the attached daemon at ${url} went away; running serve again`);
      if (!this.#run) this.#launch();
      return;
    }
    this.#schedulePoll(url);
  }

  async #shutdown(run: Run): Promise<void> {
    const t = this.#o.timers;
    const timers: unknown[] = [];
    const owned = run.ready?.mode !== 'attached';
    if (owned) this.#o.log.note('stopping the daemon (closing its stdin)');
    try {
      run.child.stdin?.end();
    } catch {
      // Already closed.
    }
    timers.push(
      t.setTimeout(() => {
        if (run.exited) return;
        this.#o.log.note(`the daemon did not exit within ${this.#policy.stopGraceMs} ms: SIGTERM`);
        run.child.kill('SIGTERM');
        timers.push(
          t.setTimeout(() => {
            if (run.exited) return;
            this.#o.log.note(
              `the daemon ignored SIGTERM for ${this.#policy.killGraceMs} ms: SIGKILL`,
            );
            run.child.kill('SIGKILL');
          }, this.#policy.killGraceMs),
        );
      }, this.#policy.stopGraceMs),
    );
    await run.exit;
    for (const handle of timers) t.clearTimeout(handle);
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
