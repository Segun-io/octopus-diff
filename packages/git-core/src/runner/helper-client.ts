/**
 * The runner's side of the git spawn helper (#45, `git-helper.ts` is the other side): starts the
 * helper processes lazily, sends them the already-validated `{ binary, argv, cwd, env }` of each
 * git process and turns their event frames back into the callbacks `runner.ts` uses for a direct
 * child process. Nothing here decides what runs: the runner validates every command first.
 *
 * Failure model: a helper that exits while git processes are in flight reports them `lost` (the
 * runner retries once or fails with a `GitCoreError`), and the runner SIGKILLs their process
 * groups, so nothing outlives a crashed helper. A helper that exits before it says READY counts as
 * a start failure; after `MAX_START_FAILURES` in a row, or `MAX_CRASHES` within `CRASH_WINDOW_MS`,
 * the pool turns itself off and the runner spawns git directly (logged once).
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Logger } from '@octopus-diff/contracts';

const HEADER_BYTES = 9;
/** Largest request frame the helper accepts (`MAX_REQUEST_FRAME` there). */
export const HELPER_MAX_REQUEST_FRAME = 8 * 1024 * 1024;
/** stdin is sent in chunks of at most this size. */
const STDIN_CHUNK = 1024 * 1024;
/** The helper never sends larger frames (it splits output at 256 KiB). */
const MAX_EVENT_FRAME = 1024 * 1024;
const MAX_START_FAILURES = 2;
const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 60_000;
/** How long `close()` waits for a helper to exit before SIGKILLing it. */
const CLOSE_WAIT_MS = 2_000;

export const HelperFrame = {
  spawn: 1,
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
  /** The helper died or refused the request: the process may never have run. */
  lost(reason: string): void;
}

export interface ProcHandle {
  /** Signals the process group (POSIX) or the process. */
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
  /** Stops reading the process's output and closes its pipes. */
  detach(): void;
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

function killGroupDirect(pid: number): void {
  if (process.platform === 'win32') return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

interface Request {
  handlers: ProcHandlers;
  pid: number | undefined;
}

/** One helper process. */
class HelperProcess {
  private readonly child: ChildProcess;
  private readonly requests = new Map<number, Request>();
  private nextId = 1;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private referenced = true;
  private closing = false;
  ready = false;
  dead = false;
  /** Why the parent stopped trusting this helper (a protocol violation). */
  lastError: string | null = null;
  readonly exited: Promise<void>;

  constructor(
    options: HelperPoolOptions,
    private readonly onDead: (helper: HelperProcess, beforeReady: boolean) => void,
  ) {
    const env: Record<string, string> = {};
    if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
    const execArgv = options.entry.endsWith('.ts') ? ['--disable-warning=ExperimentalWarning'] : [];
    this.child = spawn(
      options.execPath ?? process.execPath,
      [...execArgv, options.entry, '--octopus-diff-git-helper', '1', options.gitBinary],
      {
        // A neutral cwd and an empty environment (no NODE_OPTIONS from the daemon's): every git
        // process gets its cwd and env from the request.
        cwd: '/',
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
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
    let stderr = '';
    this.child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    this.child.once('error', (error) => {
      options.logger.warn('git helper failed to start', { error: String(error) });
      this.die();
    });
    // 'close', not 'exit': every frame the helper wrote has been read by then (a SPAWNED pid
    // still in the pipe at 'exit' would leave that process group unkilled after a crash).
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

  get load(): number {
    return this.requests.size;
  }

  startGit(request: HelperSpawnRequest, handlers: ProcHandlers): ProcHandle {
    const id = this.nextId++;
    const state: Request = { handlers, pid: undefined };
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
    this.write(frame(HelperFrame.spawn, id, message));
    if (request.input) {
      for (let at = 0; at < request.input.length; at += STDIN_CHUNK) {
        this.write(frame(HelperFrame.stdin, id, request.input.subarray(at, at + STDIN_CHUNK)));
      }
      this.write(frame(HelperFrame.stdinEnd, id));
    }
    this.updateRef();
    return {
      kill: (signal = 'SIGKILL') => {
        if (this.dead) {
          // The helper is gone; the group may still be (a crash between CLOSE and this kill).
          if (state.pid !== undefined && signal === 'SIGKILL') killGroupDirect(state.pid);
          return;
        }
        this.write(frame(HelperFrame.kill, id, Buffer.from([signal === 'SIGTERM' ? 1 : 2])));
      },
      detach: () => {
        if (!this.dead && this.requests.has(id)) this.write(frame(HelperFrame.detach, id));
      },
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

  /** SIGKILLs the helper itself (a protocol violation or an unresponsive helper). */
  kill(): void {
    if (!this.dead) this.child.kill('SIGKILL');
  }

  private write(data: Buffer): void {
    if (this.dead) return;
    this.child.stdin?.write(data);
  }

  private updateRef(): void {
    // Idle helpers must not keep the parent alive; busy ones do, as running git processes would.
    const want = (this.requests.size > 0 || this.closing) && !this.dead;
    if (want === this.referenced) return;
    this.referenced = want;
    const streams = [this.child.stdin, this.child.stdout, this.child.stderr] as Array<
      { ref?: () => void; unref?: () => void } | null | undefined
    >;
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
    for (const request of requests) {
      // A crashed helper cannot clean up: kill what it started.
      if (request.pid !== undefined) killGroupDirect(request.pid);
      request.handlers.lost('the git helper process exited');
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
        handlers.exit();
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
          typeof event.message === 'string' ? event.message : 'spawn failed',
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
        handlers.lost(`the git helper refused the request: ${String(event.reason)}`);
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
      best = new HelperProcess(this.options, (dead, beforeReady) => this.onDead(dead, beforeReady));
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
