import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { formatServeReadyFrame, ServeReadySchema } from '@octopus-diff/contracts';
import type { ChildLike, SpawnOptionsLike, TimersLike } from '../src/backend.js';

/** A child process double: real streams for stdio, `exit` emitted by the test. */
export class FakeChild extends EventEmitter implements ChildLike {
  static nextPid = 1000;
  readonly pid: number | undefined;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly fd3 = new PassThrough();
  readonly stdio: unknown[];
  exitCode: number | null = null;
  signalCode: string | null = null;
  readonly kills: (string | undefined)[] = [];
  stdinEnded = false;

  constructor(pid: number | undefined = FakeChild.nextPid++, withFd3 = true) {
    super();
    this.pid = pid;
    this.stdio = withFd3
      ? [this.stdin, this.stdout, this.stderr, this.fd3]
      : [this.stdin, this.stdout, this.stderr];
    this.stdin.on('finish', () => {
      this.stdinEnded = true;
    });
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal);
    return true;
  }

  /** Writes the ready line and closes fd 3, as `serve --ready-fd 3` does. */
  ready(line: string): void {
    this.fd3.end(`${line}\n`);
  }

  exit(code: number | null, signal: string | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    if (!this.fd3.writableEnded) this.fd3.end();
    this.emit('exit', code, signal);
  }
}

/**
 * `wsl.exe -d <distro> --exec … serve --ready-stdout <nonce> --exit-with-stdin`, as seen from
 * Windows: only fds 0-2 cross, the ready line arrives framed on stdout, and **terminating wsl.exe
 * does not stop the Linux process** (the worst case the supervisor must handle). Only EOF on stdin
 * stops the daemon inside; then wsl.exe exits with its code.
 */
export class FakeWslChild extends FakeChild {
  /** The `serve` process inside the distro. */
  linuxAlive = true;
  /** wsl.exe itself is gone (killed or exited). */
  wslGone = false;
  /** A daemon stuck in startup that does not act on EOF yet (only the escalation is left). */
  ignoresEof = false;

  constructor(pid?: number) {
    super(pid, false);
    this.stdin.on('finish', () => {
      if (!this.linuxAlive || this.ignoresEof) return;
      // The daemon saw EOF and shut down; wsl.exe exits after it (unless it was killed already).
      this.linuxAlive = false;
      if (!this.wslGone) setImmediate(() => this.exit(0));
    });
  }

  override kill(signal?: NodeJS.Signals): boolean {
    this.kills.push(signal);
    // TerminateProcess(wsl.exe): it exits at once, the Linux process keeps running.
    if (!this.wslGone) setImmediate(() => this.exit(1));
    return true;
  }

  /** What `serve --ready-stdout <nonce>` prints: the frame (with a banner around it). */
  frame(nonce: string, line: string): void {
    const ready = ServeReadySchema.parse(JSON.parse(line));
    this.stdout.write(`\n  octopus-diff is running\n${formatServeReadyFrame(nonce, ready)}`);
  }

  override exit(code: number | null, signal: string | null = null): void {
    if (this.wslGone) return;
    this.wslGone = true;
    if (!this.stdout.writableEnded) this.stdout.end();
    super.exit(code, signal);
  }
}

export function fakeWslSpawn() {
  const calls: {
    command: string;
    args: readonly string[];
    options: SpawnOptionsLike;
    child: FakeWslChild;
  }[] = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptionsLike) => {
    const child = new FakeWslChild();
    calls.push({ command, args, options, child });
    return child;
  };
  return { spawn, calls, last: () => calls[calls.length - 1] as (typeof calls)[number] };
}

export interface SpawnCall {
  command: string;
  args: readonly string[];
  options: SpawnOptionsLike;
  child: FakeChild;
}

export function fakeSpawn() {
  const calls: SpawnCall[] = [];
  const spawn = (command: string, args: readonly string[], options: SpawnOptionsLike) => {
    const child = new FakeChild();
    calls.push({ command, args, options, child });
    return child;
  };
  return { spawn, calls, last: () => calls[calls.length - 1] as SpawnCall };
}

/** A manual clock: `advance` runs due timers in time order and lets promises settle. */
export class FakeClock implements TimersLike {
  #now = 0;
  #seq = 0;
  readonly #timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#timers.set(id, { at: this.#now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#timers.delete(handle as number);
  }

  get pending(): number {
    return this.#timers.size;
  }

  async advance(ms: number): Promise<void> {
    const until = this.#now + ms;
    for (;;) {
      await settle();
      let next: [number, { at: number; fn: () => void }] | undefined;
      for (const entry of this.#timers) {
        if (entry[1].at <= until && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      this.#timers.delete(next[0]);
      this.#now = next[1].at;
      next[1].fn();
    }
    this.#now = until;
    await settle();
  }
}

/** Lets stream events and promise chains run. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
}

export const TOKEN = 'tok_SECRET_abcdefghijklmnopqrstuvwxyz012345';

export function readyLine(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    mode: 'started',
    url: 'http://127.0.0.1:7428',
    authUrl: `http://127.0.0.1:7428/#token=${TOKEN}`,
    pid: 4242,
    version: '1.2.3',
    ...over,
  });
}
