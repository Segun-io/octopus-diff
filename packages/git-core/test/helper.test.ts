/**
 * The git spawn helper (#45): the protocol is strict (the helper is a dumb executor that a bad
 * message cannot turn into a shell), the runner's observable behaviour is the same as with a
 * direct spawn (output bytes, caps, timeouts, stdin, cancellation, concurrency), and no process
 * outlives a crashed helper or a killed parent.
 *
 * The fake binary logs every start with ONE printf (macOS CI: one line per spawn), fields
 * separated by \x1f: pid, parent pid, argument count, then the arguments.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isGitCoreError } from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import {
  ABORT_GRACE_MS,
  defaultHelperEntry,
  GitRunner,
  gitHelperDisabledByEnv,
} from '../src/index.js';
import { currentCall, withCall } from '../src/runner/call-context.js';
import { createFixture, type Fixture } from './helpers/fixture.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENTRY = defaultHelperEntry() as string;
const SEP = '\u001f';

let fx: Fixture;
let fakeGit: string;
let log: string;
let gates: string;
let blob: Buffer;
let blobFile: string;

beforeAll(() => {
  fx = createFixture();
  log = path.join(fx.root, 'starts.log');
  gates = path.join(fx.root, 'gates');
  fx.write(path.join(gates, '.keep'), '');
  // Every byte value, NUL separators, invalid UTF-8, and enough of it to span many frames.
  blob = Buffer.concat([
    Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
    Buffer.from('a\u0000b\u0000', 'latin1'),
    Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0xa0, 0xa1, 0xe2, 0x28, 0xa1]),
    randomBytes(3 * 1024 * 1024 + 17),
  ]);
  blobFile = path.join(fx.root, 'blob.bin');
  writeFileSync(blobFile, blob);
  fakeGit = path.join(fx.root, 'fake-git');
  writeFileSync(
    fakeGit,
    [
      '#!/bin/sh',
      `printf '%s${SEP}' "$$" "$PPID" "$#" "$@" >> "${log}"`,
      'for last in "$@"; do :; done',
      'case "$FAKE_MODE" in',
      '  blob) cat "$FAKE_FILE"; cat "$FAKE_FILE" >&2 ;;',
      '  stdin) cat ;;',
      '  zeros) head -c "$FAKE_BYTES" /dev/zero ;;',
      '  hang) sleep 30 ;;',
      "  stubborn) trap '' TERM; sleep 30 ;;",
      `  family) sh -c 'trap "" TERM; echo $$ > "${gates}/family.pid"; exec sleep 30' & sleep 30 ;;`,
      `  once) if [ ! -e "${gates}/once.done" ]; then : > "${gates}/once.done"; sleep 30; fi; printf 'second run' ;;`,
      "  stream) printf 'first chunk'; sleep 30 ;;",
      '  count) wc -c | tr -d " " ;;',
      '  argc) printf \'%s\' "$#" ;;',
      '  cksum) cksum ;;',
      // The first run records its pid, tells the helper's crash hook it is running and sleeps; the
      // retry says whether the first one is still alive (it must not be).
      `  crashonce) if mkdir "${gates}/crash.first" 2>/dev/null; then printf '%s' "$$" > "${gates}/crash.first/pid"; : > "$CRASH_FILE.ready"; sleep 30; elif kill -0 "$(cat "${gates}/crash.first/pid")" 2>/dev/null; then printf 'alongside'; else printf 'retried'; fi ;;`,
      '  *) printf \'out:%s\' "$last" ;;',
      'esac',
      `while [ -e "${gates}/$last" ]; do sleep 0.01; done`,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(fakeGit, 0o755);
});

afterAll(() => fx.dispose());

interface Start {
  pid: number;
  ppid: number;
  args: string[];
}

function starts(): Start[] {
  if (!existsSync(log)) return [];
  const fields = readFileSync(log, 'utf8').split(SEP);
  const out: Start[] = [];
  let at = 0;
  while (at + 3 <= fields.length) {
    const count = Number(fields[at + 2]);
    if (!Number.isInteger(count)) break;
    out.push({
      pid: Number(fields[at]),
      ppid: Number(fields[at + 1]),
      args: fields.slice(at + 3, at + 3 + count),
    });
    at += 3 + count;
  }
  return out;
}

const last = (s: Start): string => s.args[s.args.length - 1] ?? '';
const job = (name: string): string[] => ['status', '--', name];

function gate(name: string): () => void {
  const file = path.join(gates, name);
  writeFileSync(file, '');
  return () => rmSync(file, { force: true });
}

async function until(check: () => boolean, ms = 5_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`${what} not reached`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function alive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
}

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/**
 * SIGCONT + SIGKILL for helpers a test stops, also when the test fails or times out: vitest
 * abandons a timed-out test without running its `finally`, and a stopped helper never sees its
 * stdin close.
 */
function releaseStopped(pids: number[]): void {
  onTestFinished(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, 'SIGCONT');
        process.kill(pid, 'SIGKILL');
      } catch {
        // gone
      }
    }
  });
}

// ---------------------------------------------------------------------------------------------
// The raw protocol, against the helper process itself.

interface Frame {
  type: number;
  id: number;
  payload: Buffer;
}

const T = { spawn: 1, stdin: 2, stdinEnd: 3, kill: 4, detach: 5 } as const;
const E = {
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
} as const;

function encode(type: number, id: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const head = Buffer.alloc(9);
  head.writeUInt32BE(payload.length + 5, 0);
  head.writeUInt8(type, 4);
  head.writeUInt32BE(id, 5);
  return Buffer.concat([head, payload]);
}

class RawHelper {
  readonly child: ChildProcess;
  readonly frames: Frame[] = [];
  readonly exited: Promise<number | null>;
  /** Pid-channel records (fd 3): [id, pid], pid 0 = about to spawn. */
  readonly pids: Array<[number, number]> = [];
  private buffer = Buffer.alloc(0);
  private pidBuffer = Buffer.alloc(0);

  constructor(
    args: string[] = ['--octopus-diff-git-helper', '1', fakeGit],
    pidChannel = true,
    env: Record<string, string> = {},
  ) {
    this.child = spawn(
      process.execPath,
      ['--disable-warning=ExperimentalWarning', ENTRY, ...args],
      {
        stdio: pidChannel ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
        cwd: '/',
        env,
      },
    );
    (this.child.stdio[3] as NodeJS.ReadableStream | null)?.on('data', (chunk: Buffer) => {
      this.pidBuffer = Buffer.concat([this.pidBuffer, chunk]);
      while (this.pidBuffer.length >= 8) {
        this.pids.push([this.pidBuffer.readUInt32BE(0), this.pidBuffer.readUInt32BE(4)]);
        this.pidBuffer = this.pidBuffer.subarray(8);
      }
    });
    this.child.stdin?.on('error', () => {});
    this.child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE(0);
        if (this.buffer.length < length + 4) break;
        this.frames.push({
          type: this.buffer.readUInt8(4),
          id: this.buffer.readUInt32BE(5),
          payload: this.buffer.subarray(9, length + 4),
        });
        this.buffer = this.buffer.subarray(length + 4);
      }
    });
    this.exited = new Promise((resolve) => this.child.once('exit', (code) => resolve(code)));
  }

  send(type: number, id: number, payload?: Buffer): void {
    this.child.stdin?.write(encode(type, id, payload));
  }

  spawnRaw(id: number, message: unknown): void {
    this.send(T.spawn, id, Buffer.from(JSON.stringify(message)));
  }

  of(id: number, type?: number): Frame[] {
    return this.frames.filter((f) => f.id === id && (type === undefined || f.type === type));
  }

  async next(id: number, type: number, ms = 5_000): Promise<Frame> {
    await until(() => this.of(id, type).length > 0, ms, `frame ${type} for ${id}`);
    return this.of(id, type)[0] as Frame;
  }

  json(frame: Frame): Record<string, unknown> {
    return JSON.parse(frame.payload.toString('utf8'));
  }

  close(): Promise<number | null> {
    this.child.stdin?.end();
    return this.exited;
  }
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    binary: fakeGit,
    argv: ['status', '--', 'proto'],
    cwd: fx.root,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
    stdin: false,
    maxOutputBytes: null,
    ...overrides,
  };
}

describe.skipIf(process.platform === 'win32')('helper protocol: strict, never a shell', () => {
  it('runs a well-formed request: argv reaches the binary verbatim, with no shell in between', async () => {
    writeFileSync(log, '');
    const helper = new RawHelper();
    await helper.next(0, E.ready);
    const marker = path.join(fx.root, 'pwned');
    const tricky = ['status', '--', `$(touch ${marker})`, '`touch x`', '; rm -rf /', '*', '"a b"'];
    helper.spawnRaw(1, request({ argv: tricky }));
    const close = helper.json(await helper.next(1, E.close));
    expect(close).toEqual({ code: 0, signal: null });
    expect(starts().map((s) => s.args)).toEqual([tricky]);
    expect(Buffer.concat(helper.of(1, E.stdout).map((f) => f.payload)).toString()).toBe(
      'out:"a b"',
    );
    expect(helper.of(1, E.spawned)[0]?.payload.readUInt32BE(0)).toBe(starts()[0]?.pid);
    // The pid channel announced the spawn, then its pid.
    expect(helper.pids).toEqual([
      [1, 0],
      [1, starts()[0]?.pid],
    ]);
    expect(existsSync(marker)).toBe(false);
    expect(await helper.close()).toBe(0);
  });

  it('refuses every request that is not exactly the shape, and runs nothing', async () => {
    writeFileSync(log, '');
    const helper = new RawHelper();
    const other = path.join(fx.root, 'other-binary');
    writeFileSync(other, '#!/bin/sh\nexit 0\n');
    chmodSync(other, 0o755);
    const bad: Array<[string, unknown]> = [
      ['a different binary', request({ binary: other })],
      ['a shell as binary', request({ binary: '/bin/sh', argv: ['-c', 'touch pwned'] })],
      ['argv as a string', request({ argv: 'status; touch pwned' })],
      ['argv with a number', request({ argv: ['status', 1] })],
      ['argv with an object', request({ argv: ['status', { toString: 'x' }] })],
      ['argv with null', request({ argv: [null] })],
      ['argv with NUL', request({ argv: ['status\u0000--exec'] })],
      ['env as an array', request({ env: [['PATH', '/bin']] })],
      ['env with a number', request({ env: { PATH: '/bin', N: 1 } })],
      ['env with an object', request({ env: { PATH: { a: 1 } } })],
      ['env key with =', request({ env: { 'A=B': 'c' } })],
      ['env null', request({ env: null })],
      ['relative cwd', request({ cwd: 'repo' })],
      ['cwd not a string', request({ cwd: ['/'] })],
      ['an extra key', request({ shell: true })],
      ['a missing key', (({ stdin: _, ...rest }) => rest)(request())],
      ['stdin not a boolean', request({ stdin: 'yes' })],
      ['a negative cap', request({ maxOutputBytes: -1 })],
      ['a fractional cap', request({ maxOutputBytes: 1.5 })],
      ['an array', [request()]],
      ['a string', 'status'],
    ];
    let id = 10;
    for (const [, message] of bad) helper.spawnRaw(id++, message);
    helper.send(T.spawn, id++, Buffer.from('{not json'));
    for (let i = 10; i < id; i++) {
      const frame = await helper.next(i, E.rejected);
      expect(helper.json(frame).reason, bad[i - 10]?.[0] ?? 'not json').toEqual(expect.any(String));
      expect(helper.of(i, E.spawned)).toEqual([]);
    }
    // Nothing ran, and the helper still serves well-formed requests.
    expect(starts()).toEqual([]);
    helper.spawnRaw(99, request());
    await helper.next(99, E.close);
    expect(starts()).toHaveLength(1);
    expect(await helper.close()).toBe(0);
  });

  it('a frame over the size cap, an unknown type or a bad KILL ends the helper; nothing runs', async () => {
    writeFileSync(log, '');
    const oversize = new RawHelper();
    const head = Buffer.alloc(9);
    head.writeUInt32BE(8 * 1024 * 1024 + 6, 0);
    head.writeUInt8(T.spawn, 4);
    head.writeUInt32BE(1, 5);
    oversize.child.stdin?.write(head);
    expect(await oversize.exited).toBe(2);
    expect(oversize.of(0, E.fatal)).toHaveLength(1);

    const unknown = new RawHelper();
    unknown.send(42, 1, Buffer.from('x'));
    expect(await unknown.exited).toBe(2);

    const badKill = new RawHelper();
    badKill.send(T.kill, 1, Buffer.from([9]));
    expect(await badKill.exited).toBe(2);

    const tooShort = new RawHelper();
    tooShort.child.stdin?.write(Buffer.from([0, 0, 0, 1, 1]));
    expect(await tooShort.exited).toBe(2);
    expect(starts()).toEqual([]);
  });

  it('refuses to start without its pid channel on fd 3', async () => {
    const helper = new RawHelper(undefined, false);
    expect(await helper.exited).toBe(2);
    expect(helper.of(0, E.ready)).toEqual([]);
  });

  it('grants stdin credit as git reads, and ends on stdin beyond its credit', async () => {
    const helper = new RawHelper();
    helper.spawnRaw(1, {
      ...request({ stdin: true }),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_MODE: 'stdin' },
    });
    const window = (await helper.next(1, E.stdinCredit)).payload.readUInt32BE(0);
    expect(window).toBe(256 * 1024);
    helper.send(T.stdin, 1, Buffer.from('hello'));
    await until(() => helper.of(1, E.stdinCredit).length === 2);
    expect(helper.of(1, E.stdinCredit)[1]?.payload.readUInt32BE(0)).toBe(5);
    helper.send(T.stdinEnd, 1);
    await helper.next(1, E.close);
    expect(Buffer.concat(helper.of(1, E.stdout).map((f) => f.payload)).toString()).toBe('hello');
    // A stdin frame over the credit (a request without stdin has none) is a protocol violation.
    helper.spawnRaw(2, request());
    await helper.next(2, E.spawned);
    helper.send(T.stdin, 2, Buffer.from('x'));
    expect(await helper.exited).toBe(2);
  });

  it('holds at most its window of stdin while git does not read', async () => {
    const helper = new RawHelper();
    helper.spawnRaw(1, {
      ...request({ stdin: true }),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_MODE: 'hang' },
    });
    // Send whatever credit allows, for a while: git never reads its stdin.
    let sent = 0;
    let used = 0;
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const granted = helper
        .of(1, E.stdinCredit)
        .reduce((n, f) => n + f.payload.readUInt32BE(0), 0);
      while (used < granted) {
        const n = Math.min(64 * 1024, granted - used);
        helper.send(T.stdin, 1, Buffer.alloc(n));
        used += n;
        sent += n;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    // The window plus what the kernel buffers for git's stdin, nowhere near unbounded.
    expect(sent).toBeGreaterThanOrEqual(256 * 1024);
    expect(sent).toBeLessThan(4 * 1024 * 1024);
    expect(await helper.close()).toBe(0);
  });

  it('the pid reaches the parent even while its frames are stuck behind a flood (review #3)', async () => {
    writeFileSync(log, '');
    const helper = new RawHelper();
    // The parent stops reading: request 1 fills every buffer, request 2's frames queue behind it.
    helper.child.stdout?.pause();
    helper.spawnRaw(1, {
      ...request(),
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        FAKE_MODE: 'zeros',
        FAKE_BYTES: '50000000',
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    helper.spawnRaw(2, {
      ...request(),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_MODE: 'hang' },
    });
    await until(() => helper.pids.some(([id, pid]) => id === 2 && pid > 0), 5_000, 'pid of 2');
    const pid = helper.pids.find(([id, p]) => id === 2 && p > 0)?.[1] as number;
    expect(helper.of(2, E.spawned)).toEqual([]);
    helper.child.kill('SIGKILL');
    await helper.exited;
    // What the parent does with it (helper-client die()): the group is killable.
    expect(alive(-pid)).toBe(true);
    process.kill(-pid, 'SIGKILL');
    await until(() => !alive(-pid), 3_000, 'the group to die');
  });

  it('an uncaught exception in the helper still kills every group it started (review #3)', async () => {
    const crash = path.join(fx.root, 'crash-throw');
    writeFileSync(crash, '');
    const helper = new RawHelper(undefined, true, {
      OCTOPUS_DIFF_GIT_HELPER_TEST_CRASH: `throw-after-spawn:${crash}`,
    });
    helper.spawnRaw(1, {
      ...request(),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_MODE: 'hang' },
    });
    expect(await helper.exited).not.toBe(0);
    const pid = helper.pids.find(([id, p]) => id === 1 && p > 0)?.[1] as number;
    expect(pid).toBeGreaterThan(0);
    await until(() => !alive(-pid), 3_000, 'the group of a helper that threw to die');
  });

  it('refuses to start without exactly its startup arguments', async () => {
    for (const args of [
      [],
      ['--octopus-diff-git-helper', '2', fakeGit],
      ['--octopus-diff-git-helper', '1', 'fake-git'],
      ['--octopus-diff-git-helper', '1', fakeGit, '--extra'],
      ['--other', '1', fakeGit],
    ]) {
      const helper = new RawHelper(args);
      expect(await helper.exited, args.join(' ')).toBe(2);
      expect(helper.of(0, E.ready)).toEqual([]);
    }
  });

  it('caps stdout itself: kills the group and reports TOO_LARGE without forwarding past the cap', async () => {
    const helper = new RawHelper();
    helper.spawnRaw(1, {
      ...request({ maxOutputBytes: 100_000 }),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_MODE: 'zeros', FAKE_BYTES: '5000000' },
    });
    await helper.next(1, E.tooLarge);
    await helper.next(1, E.close);
    const forwarded = helper.of(1, E.stdout).reduce((n, f) => n + f.payload.length, 0);
    expect(forwarded).toBeLessThanOrEqual(100_000);
    expect(await helper.close()).toBe(0);
  });

  it('kills the process groups it started when its stdin ends', async () => {
    writeFileSync(log, '');
    rmSync(path.join(gates, 'family.pid'), { force: true });
    const helper = new RawHelper();
    helper.spawnRaw(1, {
      ...request(),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', FAKE_MODE: 'family' },
    });
    await until(() => existsSync(path.join(gates, 'family.pid')));
    const pid = starts()[0]?.pid as number;
    const family = Number(readFileSync(path.join(gates, 'family.pid'), 'utf8').trim());
    expect(alive(pid) && alive(family)).toBe(true);
    expect(await helper.close()).toBe(0);
    await until(() => !alive(pid) && !alive(family), 3_000, 'the group to be gone');
  });
});

// ---------------------------------------------------------------------------------------------
// The runner on the helper path.

const helperOn = !gitHelperDisabledByEnv() && process.platform !== 'win32';

function runnerWith(env: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return new GitRunner({ gitBinary: fakeGit, env, helper: { processes: 1 }, ...extra });
}

describe.skipIf(!helperOn)('runner through the helper', () => {
  it('is the default: git is a child of a helper process, not of this one', async () => {
    writeFileSync(log, '');
    // Constructed exactly as lanes.test.ts and runner.test.ts construct theirs.
    const runner = new GitRunner({ gitBinary: fakeGit, concurrency: 1 });
    const result = await runner.run(job('who'), { cwd: fx.root });
    expect(result.stdout.toString()).toBe('out:who');
    expect(runner.usesHelper).toBe(true);
    const helpers = runner.helperPids();
    expect(helpers).toHaveLength(1);
    expect(starts()[0]?.ppid).toBe(helpers[0]);
    expect(starts()[0]?.ppid).not.toBe(process.pid);
    await runner.dispose();
    await until(() => !alive(helpers[0] as number), 3_000, 'the helper to exit on dispose');
    expect(runner.helperPids()).toEqual([]);
  });

  it('passes stdout and stderr byte for byte (every byte value, NUL, invalid UTF-8, 3 MiB)', async () => {
    const runner = runnerWith({ FAKE_MODE: 'blob', FAKE_FILE: blobFile });
    const result = await runner.run(job('blob'), { cwd: fx.root });
    expect(result.stdout.length).toBe(blob.length);
    expect(sha(result.stdout)).toBe(sha(blob));
    // stderr is decoded by the runner (as before), and capped at 64 KiB.
    expect(result.stderr).toBe(
      blob
        .subarray(0, 64 * 1024)
        .toString('utf8')
        .slice(0, 64 * 1024),
    );
    const chunks: Buffer[] = [];
    const streamed = await runner.run(job('blob'), {
      cwd: fx.root,
      onStdout: (chunk) => chunks.push(Buffer.from(chunk)),
    });
    expect(streamed.stdout.length).toBe(0);
    expect(sha(Buffer.concat(chunks))).toBe(sha(blob));
    await runner.dispose();
  });

  it('matches the direct path exactly on the same output', async () => {
    const env = { FAKE_MODE: 'blob', FAKE_FILE: blobFile };
    const viaHelper = runnerWith(env);
    const direct = new GitRunner({ gitBinary: fakeGit, env, helper: false });
    expect(direct.usesHelper).toBe(false);
    const [a, b] = await Promise.all([
      viaHelper.run(job('same'), { cwd: fx.root }),
      direct.run(job('same'), { cwd: fx.root }),
    ]);
    expect(a.stdout.equals(b.stdout)).toBe(true);
    expect(a.stderr).toBe(b.stderr);
    expect(a.exitCode).toBe(b.exitCode);
    await Promise.all([viaHelper.dispose(), direct.dispose()]);
  });

  it('enforces maxOutputBytes with the same error, and kills the process', async () => {
    writeFileSync(log, '');
    const runner = runnerWith({ FAKE_MODE: 'zeros', FAKE_BYTES: '50000000' });
    const error = await runner
      .run(job('big'), { cwd: fx.root, maxOutputBytes: 200_000 })
      .catch((e: unknown) => e);
    expect(isGitCoreError(error, 'output_too_large')).toBe(true);
    expect((error as Error).message).toBe('git status produced more than 200000 bytes');
    const pid = starts()[0]?.pid as number;
    await until(() => !alive(pid), 3_000, 'the capped process to be gone');
    await runner.dispose();
  });

  it('times out with the same error and kills the group', async () => {
    writeFileSync(log, '');
    const runner = runnerWith({ FAKE_MODE: 'hang' }, { timeoutMs: 300 });
    const error = await runner.run(job('slow'), { cwd: fx.root }).catch((e: unknown) => e);
    expect(isGitCoreError(error, 'timeout')).toBe(true);
    expect((error as Error).message).toBe('git status timed out after 300 ms');
    const pid = starts()[0]?.pid as number;
    await until(() => !alive(-pid), 3_000, 'the group to be gone');
    await runner.dispose();
  });

  it('sends stdin byte for byte, in several frames', async () => {
    const runner = runnerWith({ FAKE_MODE: 'stdin' });
    const result = await runner.run(['patch-id', '--stable'], { cwd: fx.root, input: blob });
    expect(sha(result.stdout)).toBe(sha(blob));
    await runner.dispose();
  });

  it('streams a large stdin as the pipes drain: two 64 MiB inputs at once, little extra memory', async () => {
    const size = 64 * 1024 * 1024;
    const inputs = [Buffer.alloc(size, 0x61), Buffer.alloc(size, 0x62)];
    const runner = new GitRunner({
      gitBinary: fakeGit,
      env: { FAKE_MODE: 'count' },
      timeoutMs: 60_000,
      helper: { processes: 2 },
    });
    await runner.run(job('warm'), { cwd: fx.root });
    const base = process.memoryUsage().arrayBuffers;
    let peak = base;
    const sample = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    }, 1);
    const results = await Promise.all(
      inputs.map((input, i) =>
        runner.run(['patch-id', '--stable'], { cwd: fx.root, queueKey: `in${i}`, input }),
      ),
    );
    clearInterval(sample);
    peak = Math.max(peak, process.memoryUsage().arrayBuffers);
    expect(results.map((r) => r.stdout.toString().trim())).toEqual([String(size), String(size)]);
    // Without streaming, each request copied its whole input into queued frames (+128 MiB).
    expect(peak - base).toBeLessThan(16 * 1024 * 1024);
    await runner.dispose();
  });

  it('a 64 MiB random stdin reaches git byte for byte (cksum equal to the direct path)', async () => {
    const input = randomBytes(64 * 1024 * 1024);
    const env = { FAKE_MODE: 'cksum' };
    const viaHelper = new GitRunner({
      gitBinary: fakeGit,
      env,
      timeoutMs: 60_000,
      helper: { processes: 1 },
    });
    const direct = new GitRunner({ gitBinary: fakeGit, env, timeoutMs: 60_000, helper: false });
    const [a, b] = await Promise.all([
      viaHelper.run(['patch-id', '--stable'], { cwd: fx.root, input }),
      direct.run(['patch-id', '--stable'], { cwd: fx.root, input }),
    ]);
    expect(a.stdout.toString()).toBe(b.stdout.toString());
    expect(a.stdout.toString().trim().split(/\s+/)[1]).toBe(String(input.length));
    await Promise.all([viaHelper.dispose(), direct.dispose()]);
  });

  it('a request aborted while its stdin is being sent stops sending, and the next request works', async () => {
    writeFileSync(log, '');
    const runner = new GitRunner({
      gitBinary: fakeGit,
      env: { FAKE_MODE: 'hang' },
      timeoutMs: 60_000,
      helper: { processes: 1 },
    });
    const controller = new AbortController();
    const run = runner
      .run(['patch-id', '--stable'], {
        cwd: fx.root,
        input: Buffer.alloc(64 * 1024 * 1024, 0x63),
        signal: controller.signal,
      })
      .catch((e: unknown) => e);
    await until(() => starts().length === 1);
    controller.abort();
    expect(isGitCoreError(await run, 'aborted')).toBe(true);
    const counted = new GitRunner({
      gitBinary: fakeGit,
      env: { FAKE_MODE: 'count' },
      helper: { processes: 1 },
    });
    expect(
      (
        await counted.run(['patch-id', '--stable'], { cwd: fx.root, input: Buffer.from('abc') })
      ).stdout
        .toString()
        .trim(),
    ).toBe('3');
    await Promise.all([runner.dispose(), counted.dispose()]);
  });

  it('70,000 pathspecs: the helper path answers as the direct path does (review #2)', async () => {
    const paths = Array.from({ length: 70_000 }, (_, i) => `p${i}`);
    const warnings: string[] = [];
    const viaHelper = new GitRunner({
      gitBinary: fakeGit,
      env: { FAKE_MODE: 'argc' },
      helper: { processes: 1 },
      logger: {
        debug: () => {},
        info: () => {},
        warn: (message: string) => warnings.push(message),
        error: () => {},
      },
    });
    const direct = new GitRunner({ gitBinary: fakeGit, env: { FAKE_MODE: 'argc' }, helper: false });
    const [a, b] = await Promise.all([
      viaHelper.run(['diff', '--', ...paths], { cwd: fx.root }),
      direct.run(['diff', '--', ...paths], { cwd: fx.root }),
    ]);
    expect(a.stdout.toString()).toBe(b.stdout.toString());
    expect(Number(a.stdout.toString())).toBeGreaterThan(70_000);
    expect(viaHelper.usesHelper).toBe(true);
    // Sent directly up front: the helper never had to refuse it.
    expect(warnings).toEqual([]);
    await Promise.all([viaHelper.dispose(), direct.dispose()]);
  });

  it('a request the helper refuses runs directly instead of failing (review #2)', async () => {
    writeFileSync(log, '');
    const warnings: string[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (message: string) => warnings.push(message),
      error: () => {},
    };
    // The helper refuses an env key with '='; spawn takes it.
    const runner = new GitRunner({
      gitBinary: fakeGit,
      env: { 'ODD=KEY': 'x' },
      helper: { processes: 1 },
      logger,
    });
    const result = await runner.run(job('refused'), { cwd: fx.root });
    expect(result.stdout.toString()).toBe('out:refused');
    expect(starts()).toHaveLength(1);
    expect(starts()[0]?.ppid).toBe(process.pid);
    expect(warnings.some((w) => w.includes('refused'))).toBe(true);
    // The helper itself still serves the next request.
    expect(runner.usesHelper).toBe(true);
    await runner.dispose();
  });

  it('each request sees its own call context in its callbacks (review #4)', async () => {
    const runner = runnerWith();
    const seen: string[] = [];
    const call = (name: string, signal: AbortSignal) =>
      withCall({ lane: 'interactive', signal }, () =>
        runner.run(job(name), {
          cwd: fx.root,
          queueKey: name,
          onStdout: () => {
            seen.push(`${name}:${currentCall()?.signal === signal ? 'own' : 'other'}`);
          },
        }),
      );
    await call('A', new AbortController().signal);
    await call('B', new AbortController().signal);
    expect(seen).toEqual(['A:own', 'B:own']);
    await runner.dispose();
  });

  it('a stopped helper does not wedge the runner: aborted runs settle, their slots come back (review #1)', async () => {
    writeFileSync(log, '');
    const releaseA = gate('wa');
    const releaseB = gate('wb');
    // A timeout far away: only the watchdog after the forced SIGKILL can settle them.
    const runner = new GitRunner({
      gitBinary: fakeGit,
      concurrency: 2,
      timeoutMs: 60_000,
      helper: { processes: 2 },
    });
    const a = new AbortController();
    const b = new AbortController();
    const runA = runner
      .run(job('wa'), { cwd: fx.root, queueKey: 'a', signal: a.signal })
      .catch((e: unknown) => e);
    const runB = runner
      .run(job('wb'), { cwd: fx.root, queueKey: 'b', signal: b.signal })
      .catch((e: unknown) => e);
    await until(() => starts().length === 2);
    const helpers = runner.helperPids();
    releaseStopped(helpers);
    onTestFinished(() => {
      releaseA();
      releaseB();
    });
    expect(helpers).toHaveLength(2);
    const gits = starts().map((s) => s.pid);
    try {
      for (const pid of helpers) process.kill(pid, 'SIGSTOP');
      const abortedAt = Date.now();
      a.abort();
      b.abort();
      const third = runner.run(job('c'), { cwd: fx.root, queueKey: 'c' });
      expect(isGitCoreError(await runA, 'aborted')).toBe(true);
      expect(isGitCoreError(await runB, 'aborted')).toBe(true);
      expect((await third).stdout.toString()).toBe('out:c');
      expect(Date.now() - abortedAt).toBeLessThan(5_000);
      // The stopped helpers were given up on, and their git processes killed.
      for (const pid of helpers) await until(() => !alive(pid), 3_000, `helper ${pid} gone`);
      for (const pid of gits) await until(() => !alive(-pid), 3_000, `group ${pid} gone`);
    } finally {
      for (const pid of helpers) {
        try {
          process.kill(pid, 'SIGCONT');
          process.kill(pid, 'SIGKILL');
        } catch {
          // gone
        }
      }
      releaseA();
      releaseB();
    }
    await runner.dispose();
  });

  it('a timeout that fires while an abort waits on a stopped helper gives up on it at once (review #1)', async () => {
    writeFileSync(log, '');
    const release = gate('wt');
    const runner = new GitRunner({
      gitBinary: fakeGit,
      concurrency: 1,
      timeoutMs: 1_000,
      helper: { processes: 1 },
    });
    const controller = new AbortController();
    const startedAt = Date.now();
    const run = runner
      .run(job('wt'), { cwd: fx.root, signal: controller.signal })
      .catch((e: unknown) => e);
    await until(() => starts().length === 1);
    const [helper] = runner.helperPids();
    releaseStopped([helper as number]);
    onTestFinished(release);
    try {
      process.kill(helper as number, 'SIGSTOP');
      controller.abort();
      expect(isGitCoreError(await run, 'aborted')).toBe(true);
      // At the timeout (1 s after the start), well before the watchdog (2 s after the abort).
      expect(Date.now() - startedAt).toBeLessThan(1_000 + 700);
    } finally {
      try {
        process.kill(helper as number, 'SIGCONT');
        process.kill(helper as number, 'SIGKILL');
      } catch {
        // gone
      }
      release();
    }
    await runner.dispose();
  });

  it('keeps the concurrency limit', async () => {
    writeFileSync(log, '');
    const runner = new GitRunner({ gitBinary: fakeGit, concurrency: 3, helper: { processes: 2 } });
    const releases = Array.from({ length: 9 }, (_, i) => gate(`c${i}`));
    const runs = releases.map((_, i) =>
      runner.run(job(`c${i}`), { cwd: fx.root, queueKey: `k${i}` }),
    );
    await until(() => starts().length === 3);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(starts()).toHaveLength(3);
    for (const release of releases) release();
    await Promise.all(runs);
    expect(starts()).toHaveLength(9);
    // Spread over both helpers while they were busy.
    expect(new Set(starts().map((s) => s.ppid)).size).toBe(2);
    await runner.dispose();
  });

  it('cancels as the direct path does: queued never spawns, SIGTERM, SIGKILL after the grace period, slot held until exit', async () => {
    writeFileSync(log, '');
    rmSync(path.join(gates, 'family.pid'), { force: true });
    const runner = new GitRunner({
      gitBinary: fakeGit,
      env: { FAKE_MODE: 'family' },
      concurrency: 1,
      timeoutMs: 60_000,
      helper: { processes: 1 },
    });
    const controller = new AbortController();
    const first = runner
      .run(job('first'), { cwd: fx.root, signal: controller.signal })
      .catch((e: unknown) => e);
    await until(() => existsSync(path.join(gates, 'family.pid')));
    const family = Number(readFileSync(path.join(gates, 'family.pid'), 'utf8').trim());
    const pid = starts()[0]?.pid as number;
    const queuedController = new AbortController();
    const queued = runner
      .run(job('queued'), { cwd: fx.root, queueKey: 'q', signal: queuedController.signal })
      .catch((e: unknown) => e);
    queuedController.abort();
    expect(isGitCoreError(await queued, 'aborted')).toBe(true);
    const second = runner.run(job('second'), { cwd: fx.root, queueKey: 'x' }).catch((e) => e);
    const abortedAt = Date.now();
    controller.abort();
    expect(isGitCoreError(await first, 'aborted')).toBe(true);
    // git died on SIGTERM; the member that ignores it is killed once the grace period ends.
    expect(alive(pid)).toBe(false);
    expect(alive(family)).toBe(true);
    await until(() => !alive(family), ABORT_GRACE_MS + 3_000, 'the SIGKILL after the grace');
    expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(ABORT_GRACE_MS - 50);
    await until(() => starts().length === 2);
    expect(starts().map(last)).toEqual(['first', 'second']);
    controller.abort();
    await runner.dispose();
    await second;
  });

  it('holds the slot while an aborted process ignores SIGTERM, then SIGKILLs it', async () => {
    writeFileSync(log, '');
    const runner = new GitRunner({
      gitBinary: fakeGit,
      env: { FAKE_MODE: 'stubborn' },
      concurrency: 1,
      timeoutMs: 60_000,
      helper: { processes: 1 },
    });
    const controller = new AbortController();
    const first = runner
      .run(job('first'), { cwd: fx.root, signal: controller.signal })
      .catch((e: unknown) => e);
    await until(() => starts().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const pid = starts()[0]?.pid as number;
    const second = runner
      .run(job('second'), { cwd: fx.root, queueKey: 'x', signal: AbortSignal.timeout(5_000) })
      .catch((e: unknown) => e);
    const abortedAt = Date.now();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, ABORT_GRACE_MS / 2));
    expect(starts().map(last)).toEqual(['first']);
    expect(isGitCoreError(await first, 'aborted')).toBe(true);
    expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(ABORT_GRACE_MS - 50);
    expect(alive(pid)).toBe(false);
    await until(() => starts().length === 2);
    await runner.dispose();
    await second;
  });

  it('reports a missing binary and a missing cwd as before', async () => {
    const missing = new GitRunner({
      gitBinary: path.join(fx.root, 'no-such-git'),
      helper: { processes: 1 },
    });
    const error = await missing.run(job('x'), { cwd: fx.root }).catch((e: unknown) => e);
    expect(isGitCoreError(error, 'git_not_found')).toBe(true);
    const runner = runnerWith();
    const noDir = await runner
      .run(job('x'), { cwd: path.join(fx.root, 'no-such-dir') })
      .catch((e: unknown) => e);
    expect(isGitCoreError(noDir, 'not_found')).toBe(true);
    await Promise.all([missing.dispose(), runner.dispose()]);
  });
});

describe.skipIf(!helperOn)('helper crashes', () => {
  it('a helper killed with SIGKILL mid-request: the request runs again cleanly, the next one works', async () => {
    writeFileSync(log, '');
    rmSync(path.join(gates, 'once.done'), { force: true });
    const runner = runnerWith({ FAKE_MODE: 'once' }, { timeoutMs: 60_000 });
    const run = runner.run(job('once'), { cwd: fx.root });
    await until(() => starts().length === 1);
    const [helper] = runner.helperPids();
    const firstGit = starts()[0]?.pid as number;
    process.kill(helper as number, 'SIGKILL');
    const result = await run;
    expect(result.stdout.toString()).toBe('second run');
    // The first git process did not outlive its helper.
    await until(() => !alive(-firstGit) && !alive(firstGit), 3_000, 'the orphaned group to die');
    expect(starts()).toHaveLength(2);
    const [replacement] = runner.helperPids();
    expect(replacement).not.toBe(helper);
    expect(starts()[1]?.ppid).toBe(replacement);
    const next = await runner.run(job('next'), { cwd: fx.root });
    expect(next.stdout.toString()).toBe('second run');
    await runner.dispose();
  });

  it('a helper SIGKILLed right after spawning git: that git is killed, and the retry starts only once it is gone', async () => {
    writeFileSync(log, '');
    rmSync(path.join(gates, 'crash.first'), { recursive: true, force: true });
    const crash = path.join(fx.root, 'crash-after');
    writeFileSync(crash, '');
    rmSync(`${crash}.ready`, { force: true });
    const runner = new GitRunner({
      gitBinary: fakeGit,
      env: { FAKE_MODE: 'crashonce', CRASH_FILE: crash },
      timeoutMs: 60_000,
      helper: { processes: 1 },
      helperTestCrash: `after-spawn:${crash}`,
    });
    const result = await runner.run(job('crash'), { cwd: fx.root });
    // The hook fired (it deletes the file) after git had started.
    expect(existsSync(crash)).toBe(false);
    expect(result.stdout.toString()).toBe('retried');
    const first = Number(readFileSync(path.join(gates, 'crash.first', 'pid'), 'utf8'));
    expect(alive(first)).toBe(false);
    expect(alive(-first)).toBe(false);
    expect(starts()).toHaveLength(2);
    await runner.dispose();
  });

  it('a helper that dies between announcing a spawn and its pid: no retry (git may be running), a clear error', async () => {
    writeFileSync(log, '');
    const crash = path.join(fx.root, 'crash-before');
    writeFileSync(crash, '');
    const runner = new GitRunner({
      gitBinary: fakeGit,
      timeoutMs: 60_000,
      helper: { processes: 1 },
      helperTestCrash: `before-spawn:${crash}`,
    });
    const error = await runner.run(job('before'), { cwd: fx.root }).catch((e: unknown) => e);
    expect(existsSync(crash)).toBe(false);
    expect(isGitCoreError(error, 'git_failed')).toBe(true);
    expect((error as { details: Record<string, unknown> }).details.helper).toBe('lost');
    // The helper died before spawning: nothing ran, and nothing ran twice.
    expect(starts()).toEqual([]);
    const next = await runner.run(job('after'), { cwd: fx.root });
    expect(next.stdout.toString()).toBe('out:after');
    await runner.dispose();
  });

  it('a streamed request whose output already went out fails with a clear error instead', async () => {
    writeFileSync(log, '');
    const runner = runnerWith({ FAKE_MODE: 'stream' }, { timeoutMs: 60_000 });
    const chunks: string[] = [];
    const run = runner
      .run(job('stream'), { cwd: fx.root, onStdout: (c) => chunks.push(c.toString()) })
      .catch((e: unknown) => e);
    await until(() => chunks.length > 0);
    const gitPid = starts()[0]?.pid as number;
    process.kill(runner.helperPids()[0] as number, 'SIGKILL');
    const error = await run;
    expect(isGitCoreError(error, 'git_failed')).toBe(true);
    expect((error as { details: Record<string, unknown> }).details.helper).toBe('lost');
    expect(starts()).toHaveLength(1);
    await until(() => !alive(-gitPid) && !alive(gitPid), 3_000, 'the orphaned group to die');
    await runner.dispose();
  });

  it('an entry that cannot start falls back to the direct path (logged), and requests still succeed', async () => {
    writeFileSync(log, '');
    const broken = path.join(fx.root, 'broken-helper.mjs');
    writeFileSync(broken, 'process.exit(3);\n');
    const warnings: string[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (message: string) => warnings.push(message),
      error: () => {},
    };
    const runner = new GitRunner({ gitBinary: fakeGit, helper: { entry: broken }, logger });
    const results = await Promise.all([
      runner.run(job('a'), { cwd: fx.root, queueKey: 'a' }),
      runner.run(job('b'), { cwd: fx.root, queueKey: 'b' }),
    ]);
    expect(results.map((r) => r.stdout.toString())).toEqual(['out:a', 'out:b']);
    expect(runner.usesHelper).toBe(false);
    expect(warnings.some((w) => w.startsWith('git helper disabled'))).toBe(true);
    // Run directly: this process is the parent.
    expect(starts().every((s) => s.ppid === process.pid)).toBe(true);
    await runner.dispose();
  });
});

describe.skipIf(!helperOn)('parent death', () => {
  it('SIGKILL of the parent: the helper kills every process group it started and exits', async () => {
    writeFileSync(log, '');
    rmSync(path.join(gates, 'family.pid'), { force: true });
    const pidFile = path.join(fx.root, 'parent-helper.pid');
    const script = path.join(fx.root, 'parent.mts');
    const source = path.join(REPO_ROOT, 'packages', 'git-core', 'src', 'index.ts');
    writeFileSync(
      script,
      [
        `import { writeFileSync } from 'node:fs';`,
        `import { GitRunner } from ${JSON.stringify(source)};`,
        `const runner = new GitRunner({ gitBinary: ${JSON.stringify(fakeGit)}, env: { FAKE_MODE: 'family' }, timeoutMs: 60_000 });`,
        `const runs = [runner.run(['status', '--', 'orphan-a'], { cwd: ${JSON.stringify(fx.root)}, queueKey: 'a' }),`,
        `  runner.run(['status', '--', 'orphan-b'], { cwd: ${JSON.stringify(fx.root)}, queueKey: 'b' })];`,
        `const timer = setInterval(() => {`,
        `  if (runner.helperPids().length > 0) { writeFileSync(${JSON.stringify(pidFile)}, runner.helperPids().join(' ')); clearInterval(timer); }`,
        `}, 10);`,
        `await Promise.all(runs);`,
        '',
      ].join('\n'),
    );
    const parent = spawn(
      process.execPath,
      ['--import', 'tsx', '--conditions=@octopus-diff/source', script],
      { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, ...fx.env } },
    );
    let stderr = '';
    parent.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    try {
      await until(
        () =>
          existsSync(pidFile) &&
          starts().length === 2 &&
          existsSync(path.join(gates, 'family.pid')),
        15_000,
        `the parent to start two git processes (${stderr})`,
      );
      const helpers = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
      const gits = starts().map((s) => s.pid);
      const family = Number(readFileSync(path.join(gates, 'family.pid'), 'utf8').trim());
      expect(starts().every((s) => helpers.includes(s.ppid))).toBe(true);
      expect([...helpers, ...gits, family].every(alive)).toBe(true);
      parent.kill('SIGKILL');
      await until(
        () => [...helpers, ...gits, family].every((pid) => !alive(pid)),
        5_000,
        'the helpers and every git process to be gone',
      );
      for (const pid of gits) expect(alive(-pid)).toBe(false);
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
    }
  });
});
