/**
 * The runner's side of the git spawn helper (#45, `git-helper.ts` is the other side): starts the
 * helper processes lazily, sends them the already-validated `{ binary, argv, cwd, env }` of each
 * git process and turns their event frames back into the callbacks `runner.ts` uses for a direct
 * child process. Nothing here decides what runs: the runner validates every command first.
 *
 * Failure model: a helper that exits while git processes are in flight reports them `lost`. The
 * pid of every git process reaches this side through the helper's pid channel (fd 3, written
 * synchronously around the call that starts git), so the groups of a crashed helper are SIGKILLed here, and a
 * lost request is retryable only once its group is gone, or when it never started. A request the
 * helper announced but whose pid never arrived (it died while starting git) is not retried: git
 * may be running. A helper that exits before it says READY counts as
 * a start failure; after `MAX_START_FAILURES` in a row, or `MAX_CRASHES` within `CRASH_WINDOW_MS`,
 * the pool turns itself off and the runner spawns git directly (logged once).
 */
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@octopus-diff/contracts';

const HEADER_BYTES = 9;
/** Largest request frame the helper accepts (`MAX_REQUEST_FRAME` there). */
export const HELPER_MAX_REQUEST_FRAME = 8 * 1024 * 1024;
/** Most argv entries and env entries the helper accepts (`MAX_ARGV`, `MAX_ENV` there). */
export const HELPER_MAX_ARGV = 65_536;
export const HELPER_MAX_ENV = 4_096;

/**
 * Runs a function in the context this module was loaded in (no call's context): a helper's pipes
 * and timers must not belong to whichever request happened to start it (review #4). Each request's
 * callbacks are bound to its own context in `startGit` instead.
 */
const inRootContext = AsyncLocalStorage.snapshot();
/** stdin is sent in frames of at most this size, within the credit the helper grants. */
const STDIN_CHUNK = 64 * 1024;
/**
 * How long a retry waits for the SIGKILLed groups of a crashed helper to disappear (init reaps
 * them; seconds on a loaded machine). The retry goes ahead after it anyway: a SIGKILLed process
 * runs no more code, so what can linger is only a process on its way out or a zombie.
 */
const GROUP_GONE_WAIT_MS = 10_000;
/** How long `reapGroup` keeps SIGKILLing a group that is still there. */
const GROUP_REAP_MS = 10_000;
/** A helper asked whether it is alive (PING) that has not answered (PONG) by then is SIGKILLed. */
const PROBE_WAIT_MS = 3_000;
/** The helper never sends larger frames (it splits output at 256 KiB). */
const MAX_EVENT_FRAME = 1024 * 1024;
const MAX_START_FAILURES = 2;
const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 60_000;
/** How long `close()` waits for a helper to exit before SIGKILLing it. */
const CLOSE_WAIT_MS = 2_000;

export const HelperFrame = {
  startGit: 1,
  stdin: 2,
  stdinEnd: 3,
  kill: 4,
  detach: 5,
  ready: 16,
  spawned: 17,
  stdout: 18,
  stderr: 19,
  exit: 20,
  close: 21,
  error: 22,
  tooLarge: 23,
  rejected: 24,
  fatal: 25,
  stdinCredit: 26,
  ping: 6,
  pong: 27,
} as const;

/** The callbacks a running git process reports through (same for direct and helper spawns). */
export interface ProcHandlers {
  stdout(chunk: Buffer): void;
  stderr(chunk: Buffer): void;
  /** The process exited (its output may still be draining). */
  exit(): void;
  /** Output drained and the process exited. */
  close(code: number | null, signal: NodeJS.Signals | null): void;
  /** Spawning failed (`code` is the errno code, e.g. `ENOENT`). */
  error(error: NodeJS.ErrnoException): void;
  /** stdout went over the request's cap; the process group was killed. */
  tooLarge(): void;
  /**
   * The helper died or refused the request. `retryable`: no process of the request can still be
   * running (it never started, or its group is gone). `refused`: the helper turned the request
   * down (nothing ran); it would refuse it again, so it is for the direct path.
   */
  lost(reason: string, retryable: boolean, refused?: boolean): void;
}

export interface ProcHandle {
  /** Signals the process group (POSIX) or the process. */
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
  /** Stops reading the process's output and closes its pipes. */
  detach(): void;
  /**
   * A SIGKILL brought no exit report (review #1): for a helper, probe it and SIGKILL it if it does
   * not answer, so its death reports its requests lost and frees their slots. Absent for a direct
   * child (the kernel always delivers its exit).
   */
  abandon?(): void;
}

export interface HelperSpawnRequest {
  binary: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  input?: Buffer;
  /** null: no cap (streaming mode). */
  maxOutputBytes: number | null;
}

export interface HelperPoolOptions {
  /** Test hooks and timings (`GitRunnerOptions.helperTest`). */
  test?: {
    crash?: string;
    delayExitMs?: number;
    startDelayMs?: number;
    missFirstGroupKill?: boolean;
    groupGoneWaitMs?: number;
    probeWaitMs?: number;
  };
  gitBinary: string;
  entry: string;
  processes: number;
  logger: Logger;
  /** Node executable (default `process.execPath`; under Electron, with `ELECTRON_RUN_AS_NODE`). */
  execPath?: string;
}

/** The helper entry next to this module: `git-helper.js` when built, `git-helper.ts` in sources. */
export function defaultHelperEntry(): string | null {
  for (const name of ['git-helper.js', 'git-helper.ts']) {
    const file = fileURLToPath(new URL(`./${name}`, import.meta.url));
    if (existsSync(file)) return file;
  }
  return null;
}

function frame(type: number, id: number, payload?: Buffer): Buffer {
  const length = payload?.length ?? 0;
  const out = Buffer.allocUnsafe(HEADER_BYTES + length);
  out.writeUInt32BE(length + 5, 0);
  out.writeUInt8(type, 4);
  out.writeUInt32BE(id, 5);
  if (payload) payload.copy(out, HEADER_BYTES);
  return out;
}

function parseJson(payload: Buffer): Record<string, unknown> {
  const value: unknown = JSON.parse(payload.toString('utf8'));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('event payload is not an object');
  }
  return value as Record<string, unknown>;
}

export interface ReapOptions {
  logger?: Logger;
  /** Between two SIGKILLs while the group is still there. */
  intervalMs?: number;
  /** Give up (with a warning) after this long. */
  maxMs?: number;
  /** Tests: the first SIGKILL is lost (macOS: a `killpg` racing a fork misses the new child). */
  skipFirst?: boolean;
}

/**
 * SIGKILLs process group `pgid` until it is gone. One `killpg` can miss a member: on macOS CI a
 * fake git's `sleep` child, forked while the group was being killed, outlived its dead leader in
 * the group for good (DECISIONS #393). So the SIGKILL is repeated every `intervalMs` while
 * `kill(-pgid, 0)` still finds the group; an ESRCH from a SIGKILL means gone only when that check
 * agrees. A group that survives `maxMs` is logged with its errno. Resolves true once it is gone.
 */
export async function reapGroup(pgid: number, options: ReapOptions = {}): Promise<boolean> {
  if (process.platform === 'win32') return true;
  const deadline = Date.now() + (options.maxMs ?? GROUP_REAP_MS);
  let lastCode: string | null = null;
  let skip = options.skipFirst === true;
  for (;;) {
    if (skip) skip = false;
    else {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch (error) {
        lastCode = (error as NodeJS.ErrnoException).code ?? null;
      }
    }
    if (!groupExists(pgid)) return true;
    if (Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 25));
  }
  options.logger?.warn('a git process group survived SIGKILL', { pgid, code: lastCode });
  return false;
}

interface Request {
  handlers: ProcHandlers;
  pid: number | undefined;
  /** The helper announced the spawn on the pid channel. */
  started: boolean;
  /** stdin not sent yet (a view of the caller's buffer, never copied), from `stdinOffset`. */
  input: Buffer | undefined;
  stdinOffset: number;
  /** stdin bytes the helper lets this request send now. */
  stdinCredit: number;
}

function groupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** One helper process. */
class HelperProcess {
  private readonly child: ChildProcess;
  private readonly requests = new Map<number, Request>();
  private nextId = 1;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private pidPending = Buffer.alloc(0);
  private referenced = true;
  private closing = false;
  ready = false;
  dead = false;
  /** Why the parent stopped trusting this helper (a protocol violation). */
  lastError: string | null = null;
  private probe: { id: number; timer: NodeJS.Timeout } | null = null;
  private nextProbe = 1;
  readonly exited: Promise<void>;

  constructor(
    private readonly options: HelperPoolOptions,
    private readonly onDead: (helper: HelperProcess, beforeReady: boolean) => void,
  ) {
    const env: Record<string, string> = {};
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    if (options.test?.crash) env.OCTOPUS_DIFF_GIT_HELPER_TEST_CRASH = options.test.crash;
    if (options.test?.startDelayMs) {
      env.OCTOPUS_DIFF_GIT_HELPER_TEST_START_DELAY_MS = String(options.test.startDelayMs);
    }
    if (options.test?.delayExitMs) {
      env.OCTOPUS_DIFF_GIT_HELPER_TEST_DELAY_EXIT_MS = String(options.test.delayExitMs);
    }
    const execArgv = options.entry.endsWith('.ts') ? ['--disable-warning=ExperimentalWarning'] : [];
    this.child = spawn(
      options.execPath ?? process.execPath,
      [...execArgv, options.entry, '--octopus-diff-git-helper', '1', options.gitBinary],
      {
        // A neutral cwd and an empty environment (no NODE_OPTIONS from the daemon's): every git
        // process gets its cwd and env from the request.
        cwd: '/',
        env,
        // fd 3: the pid channel (see git-helper.ts).
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Own session: terminal signals go to the parent, which disposes the helper itself.
        detached: true,
        shell: false,
      },
    );
    this.exited = new Promise((resolve) => {
      this.child.once('close', () => resolve());
      this.child.once('error', () => resolve());
    });
    this.child.stdin?.on('error', () => {
      // EPIPE when the helper died; its 'exit' reports the requests.
    });
    this.child.stdout?.on('data', (chunk: Buffer) => this.read(chunk));
    this.pidChannel?.on('data', (chunk: Buffer) => this.readPids(chunk));
    this.child.stdin?.on('drain', () => this.pumpAll());
    let stderr = '';
    this.child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    this.child.once('error', (error) => {
      options.logger.warn('git helper failed to start', { error: String(error) });
      this.die();
    });
    // 'close', not 'exit': everything the helper wrote, the pid channel included, has been read.
    this.child.once('close', (code, signal) => {
      if (!this.closing) {
        options.logger.warn('git helper exited', {
          code,
          signal,
          stderr: stderr.slice(0, 2048),
          inFlight: this.requests.size,
        });
      }
      this.die();
    });
    this.updateRef();
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  private get pidChannel(): NodeJS.ReadableStream | null {
    return (this.child.stdio[3] as NodeJS.ReadableStream | null | undefined) ?? null;
  }

  get load(): number {
    return this.requests.size;
  }

  /** PIDs of the in-flight git processes this helper announced. */
  childPids(): number[] {
    return [...this.requests.values()].flatMap((r) => (r.pid === undefined ? [] : [r.pid]));
  }

  startGit(request: HelperSpawnRequest, handlers: ProcHandlers): ProcHandle {
    const id = this.nextId++;
    // The request's own async context for every callback (not the helper's pipes' context).
    const resource = new AsyncResource('OctopusDiffGitHelperRequest');
    const inScope =
      <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A): void => {
        resource.runInAsyncScope(fn, null, ...args);
      };
    const bound: ProcHandlers = {
      stdout: inScope(handlers.stdout),
      stderr: inScope(handlers.stderr),
      exit: inScope(handlers.exit),
      close: inScope(handlers.close),
      error: inScope(handlers.error),
      tooLarge: inScope(handlers.tooLarge),
      lost: inScope(handlers.lost),
    };
    const state: Request = {
      handlers: bound,
      pid: undefined,
      started: false,
      input: request.input,
      stdinOffset: 0,
      stdinCredit: 0,
    };
    this.requests.set(id, state);
    const message = Buffer.from(
      JSON.stringify({
        binary: request.binary,
        argv: request.argv,
        cwd: request.cwd,
        env: request.env,
        stdin: Boolean(request.input),
        maxOutputBytes: request.maxOutputBytes,
      }),
      'utf8',
    );
    this.write(frame(HelperFrame.startGit, id, message));
    // stdin follows as the helper grants credit (STDIN_CREDIT), git's pace.
    this.updateRef();
    return {
      kill: (signal = 'SIGKILL') => {
        if (this.dead) {
          // The helper is gone; the group may still be (a crash between CLOSE and this kill).
          if (state.pid !== undefined && signal === 'SIGKILL') {
            void reapGroup(state.pid, { logger: this.options.logger });
          }
          return;
        }
        this.write(frame(HelperFrame.kill, id, Buffer.from([signal === 'SIGTERM' ? 1 : 2])));
      },
      detach: () => {
        // A cancelled or timed-out request sends no more stdin.
        state.input = undefined;
        if (!this.dead && this.requests.has(id)) this.write(frame(HelperFrame.detach, id));
      },
      abandon: () => this.probeAlive(),
    };
  }

  /** Ends the helper's stdin (it SIGKILLs its process groups and exits), then waits for it. */
  async close(): Promise<void> {
    if (this.dead) return;
    this.closing = true;
    this.updateRef();
    this.child.stdin?.end();
    const timer = setTimeout(() => this.child.kill('SIGKILL'), CLOSE_WAIT_MS);
    timer.unref();
    await this.exited;
    clearTimeout(timer);
  }

  /**
   * A SIGKILLed git process has not been reported gone (review #1): the helper may be stopped or
   * wedged, or only slow (a loaded machine reaps late). PING it, and SIGKILL it only if it does not
   * answer within `PROBE_WAIT_MS`: a helper that answers is alive and will report the exit.
   */
  probeAlive(): void {
    if (this.dead || this.probe) return;
    const id = this.nextProbe++;
    const timer = setTimeout(() => {
      if (this.probe?.id !== id) return;
      this.probe = null;
      this.lastError = 'the helper did not answer a probe (stopped or wedged)';
      this.kill();
    }, this.options.test?.probeWaitMs ?? PROBE_WAIT_MS);
    timer.unref();
    this.probe = { id, timer };
    this.write(frame(HelperFrame.ping, id));
  }

  /** SIGKILLs the helper itself (a protocol violation or an unresponsive helper). */
  kill(): void {
    if (!this.dead) this.child.kill('SIGKILL');
  }

  private write(data: Buffer): void {
    if (this.dead) return;
    this.child.stdin?.write(data);
  }

  /** Sends what the request's credit allows, as views of its input; then STDIN_END. */
  private pump(id: number, state: Request): void {
    const stdin = this.child.stdin;
    const input = state.input;
    if (!stdin || this.dead || !input) return;
    while (state.stdinCredit > 0 && state.stdinOffset < input.length) {
      if (stdin.writableNeedDrain) return; // 'drain' pumps again
      const end = Math.min(
        input.length,
        state.stdinOffset + Math.min(STDIN_CHUNK, state.stdinCredit),
      );
      const view = input.subarray(state.stdinOffset, end);
      const head = Buffer.allocUnsafe(HEADER_BYTES);
      head.writeUInt32BE(view.length + 5, 0);
      head.writeUInt8(HelperFrame.stdin, 4);
      head.writeUInt32BE(id, 5);
      stdin.cork();
      stdin.write(head);
      stdin.write(view);
      stdin.uncork();
      state.stdinCredit -= view.length;
      state.stdinOffset = end;
    }
    if (state.stdinOffset >= input.length) {
      state.input = undefined;
      this.write(frame(HelperFrame.stdinEnd, id));
    }
  }

  private pumpAll(): void {
    for (const [id, state] of this.requests) if (state.input) this.pump(id, state);
  }

  private readPids(chunk: Buffer): void {
    let data = this.pidPending.length > 0 ? Buffer.concat([this.pidPending, chunk]) : chunk;
    while (data.length >= 8) {
      const request = this.requests.get(data.readUInt32BE(0));
      const pid = data.readUInt32BE(4);
      if (request) {
        if (pid === 0) request.started = true;
        else request.pid = pid;
      }
      data = data.subarray(8);
    }
    this.pidPending = Buffer.from(data);
  }

  private updateRef(): void {
    // Idle helpers must not keep the parent alive; busy ones do, as running git processes would.
    const want = (this.requests.size > 0 || this.closing) && !this.dead;
    if (want === this.referenced) return;
    this.referenced = want;
    const streams = [
      this.child.stdin,
      this.child.stdout,
      this.child.stderr,
      this.pidChannel,
    ] as Array<{ ref?: () => void; unref?: () => void } | null | undefined>;
    if (want) {
      this.child.ref();
      for (const stream of streams) stream?.ref?.();
    } else {
      this.child.unref();
      for (const stream of streams) stream?.unref?.();
    }
  }

  private die(): void {
    if (this.dead) return;
    this.dead = true;
    const requests = [...this.requests.values()];
    this.requests.clear();
    this.updateRef();
    // The pool first (it may give up on helpers), so a retry below already knows.
    this.onDead(this, !this.ready);
    const reason = 'the git helper process exited';
    for (const request of requests) {
      request.input = undefined;
      if (request.pid !== undefined) {
        // A crashed helper cannot clean up: kill what it started, until it is all gone, and retry
        // once it is gone or after the bounded wait (a SIGKILLed process runs no more code).
        const skipFirst = this.options.test?.missFirstGroupKill === true;
        if (skipFirst && this.options.test) this.options.test.missFirstGroupKill = false;
        const reaped = reapGroup(request.pid, { logger: this.options.logger, skipFirst });
        const wait = this.options.test?.groupGoneWaitMs ?? GROUP_GONE_WAIT_MS;
        void Promise.race([reaped, new Promise((resolve) => setTimeout(resolve, wait))]).then(() =>
          request.handlers.lost(reason, true),
        );
      } else {
        // Announced but no pid: the helper died while starting git, which may be running unseen.
        request.handlers.lost(reason, !request.started);
      }
    }
  }

  private read(chunk: Buffer): void {
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
    if (this.pendingBytes < 4) return;
    let data =
      this.pending.length === 1
        ? (this.pending[0] as Buffer)
        : Buffer.concat(this.pending, this.pendingBytes);
    if (this.pending.length > 1) {
      // Wait for the whole frame before copying again.
      const need = data.readUInt32BE(0) + 4;
      if (need <= MAX_EVENT_FRAME + 4 && data.length < need) {
        this.pending = [data];
        return;
      }
    }
    let offset = 0;
    try {
      while (data.length - offset >= 4) {
        const length = data.readUInt32BE(offset);
        if (length < 5 || length > MAX_EVENT_FRAME + 5)
          throw new Error(`bad frame length ${length}`);
        if (data.length - offset - 4 < length) break;
        const type = data.readUInt8(offset + 4);
        const id = data.readUInt32BE(offset + 5);
        const payload = data.subarray(offset + HEADER_BYTES, offset + 4 + length);
        offset += 4 + length;
        this.onFrame(type, id, payload);
      }
    } catch (error) {
      // A helper that breaks the protocol is not trusted any further.
      this.pending = [];
      this.pendingBytes = 0;
      this.closing = false;
      this.kill();
      this.lastError = String(error);
      return;
    }
    data = data.subarray(offset);
    this.pending = data.length > 0 ? [data] : [];
    this.pendingBytes = data.length;
  }

  private onFrame(type: number, id: number, payload: Buffer): void {
    if (type === HelperFrame.ready) {
      this.ready = true;
      return;
    }
    if (type === HelperFrame.pong) {
      if (this.probe?.id === id) {
        clearTimeout(this.probe.timer);
        this.probe = null;
      }
      return;
    }
    if (type === HelperFrame.fatal) {
      throw new Error(`git helper refused the stream: ${payload.toString('utf8')}`);
    }
    const request = this.requests.get(id);
    if (!request) return;
    const { handlers } = request;
    switch (type) {
      case HelperFrame.spawned:
        if (payload.length !== 4) throw new Error('bad SPAWNED');
        request.pid = payload.readUInt32BE(0);
        return;
      case HelperFrame.stdout:
        handlers.stdout(payload);
        return;
      case HelperFrame.stderr:
        handlers.stderr(payload);
        return;
      case HelperFrame.exit:
        // git is gone: whatever stdin is left would not be read.
        request.input = undefined;
        handlers.exit();
        return;
      case HelperFrame.stdinCredit:
        if (payload.length !== 4) throw new Error('bad STDIN_CREDIT');
        request.stdinCredit += payload.readUInt32BE(0);
        this.pump(id, request);
        return;
      case HelperFrame.close: {
        const event = parseJson(payload);
        this.requests.delete(id);
        this.updateRef();
        handlers.close(
          typeof event.code === 'number' ? event.code : null,
          typeof event.signal === 'string' ? (event.signal as NodeJS.Signals) : null,
        );
        return;
      }
      case HelperFrame.error: {
        const event = parseJson(payload);
        const error = new Error(
          typeof event.message === 'string' ? event.message : 'git did not start',
        ) as NodeJS.ErrnoException;
        if (typeof event.code === 'string') error.code = event.code;
        handlers.error(error);
        return;
      }
      case HelperFrame.tooLarge:
        handlers.tooLarge();
        return;
      case HelperFrame.rejected: {
        const event = parseJson(payload);
        this.requests.delete(id);
        this.updateRef();
        handlers.lost(`the git helper refused the request: ${String(event.reason)}`, true, true);
        return;
      }
      default:
        throw new Error(`unknown frame type ${type}`);
    }
  }
}

/**
 * Up to `processes` helpers, started lazily; each spawn goes to the least busy one. A helper that
 * dies is replaced on the next spawn.
 */
export class HelperPool {
  private readonly helpers: Array<HelperProcess | null>;
  private startFailures = 0;
  private crashes: number[] = [];
  private closed = false;
  /** True once the pool gave up (start failures or a crash loop): spawn directly. */
  disabled = false;

  constructor(private readonly options: HelperPoolOptions) {
    this.helpers = Array.from({ length: Math.max(1, options.processes) }, () => null);
  }

  get available(): boolean {
    return !this.disabled && !this.closed;
  }

  /** PIDs of the in-flight git processes the helpers announced (tests, diagnostics). */
  childPids(): number[] {
    return this.helpers.flatMap((h) => (h && !h.dead ? h.childPids() : []));
  }

  /** PIDs of the running helpers (tests, diagnostics). */
  pids(): number[] {
    return this.helpers.flatMap((h) => (h && !h.dead && h.pid !== undefined ? [h.pid] : []));
  }

  startGit(request: HelperSpawnRequest, handlers: ProcHandlers): ProcHandle {
    // The least busy running helper; a new one only when every running one is busy.
    let best: HelperProcess | null = null;
    let free = -1;
    for (let i = 0; i < this.helpers.length; i++) {
      const helper = this.helpers[i];
      if (!helper || helper.dead) {
        if (free < 0) free = i;
        continue;
      }
      if (!best || helper.load < best.load) best = helper;
    }
    if (!best || (best.load > 0 && free >= 0)) {
      const at = free;
      best = inRootContext(
        () =>
          new HelperProcess(this.options, (dead, beforeReady) => this.onDead(dead, beforeReady)),
      );
      this.helpers[at] = best;
    }
    return best.startGit(request, handlers);
  }

  async close(): Promise<void> {
    this.closed = true;
    await Promise.all(this.helpers.map((helper) => helper?.close()));
  }

  /** SIGKILLs every helper (tests: crash recovery). */
  killHelpers(): void {
    for (const helper of this.helpers) helper?.kill();
  }

  private onDead(helper: HelperProcess, beforeReady: boolean): void {
    const at = this.helpers.indexOf(helper);
    if (at >= 0) this.helpers[at] = null;
    if (this.closed || this.disabled) return;
    if (beforeReady) this.startFailures += 1;
    else this.startFailures = 0;
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now];
    const reason =
      this.startFailures >= MAX_START_FAILURES
        ? 'it failed to start'
        : this.crashes.length >= MAX_CRASHES
          ? `it exited ${this.crashes.length} times within a minute`
          : null;
    if (reason) {
      this.disabled = true;
      this.options.logger.warn(`git helper disabled (${reason}); spawning git directly`, {
        entry: this.options.entry,
        error: helper.lastError,
      });
    }
  }
}
