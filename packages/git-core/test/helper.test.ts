/**
 * The git spawn helper (#45): the protocol is strict (the helper is a dumb executor that a bad
 * message cannot turn into a shell), the runner's observable behaviour is the same as with a
 * direct spawn (output bytes, caps, timeouts, stdin, cancellation, concurrency), and no process
 * outlives a crashed helper or a killed parent.
 *
 * The fake binary logs events, one line each, written with ONE `printf '%s\n'` of a string it
 * built first (a format applied once per argument is several writes in macOS's /bin/sh, and
 * concurrent fakes then interleave their fields): `start␟pid␟ppid␟argc␟args…` (every argument up to
 * 32 of them, else only the last) and `end␟pid` when it exits normally. Fields separated by \x1f.
 */
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type GitCoreError, isGitCoreError } from '@octopus-diff/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
import {
  ABORT_GRACE_MS,
  defaultHelperEntry,
  GitRunner,
  gitHelperDisabledByEnv,
} from '../src/index.js';
import { currentCall, withCall } from '../src/runner/call-context.js';
import { HELPER_MAX_ARGV, HELPER_MAX_REQUEST_FRAME } from '../src/runner/helper-client.js';
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
      'for last in "$@"; do :; done',
      `rec="start${SEP}$$${SEP}$PPID${SEP}$#"`,
      `if [ "$#" -le 32 ]; then for a in "$@"; do rec="$rec${SEP}$a"; done; else rec="$rec${SEP}$last"; fi`,
      `printf '%s\\n' "$rec" >> "${log}"`,
      `trap 'printf "%s\\n" "end${SEP}$$" >> "${log}"' EXIT`,
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
      `  crashonce) if mkdir "${gates}/crash.first" 2>/dev/null; then printf '%s' "$$" > "${gates}/crash.first/pid"; : > "$CRASH_FILE.ready"; sleep 30; else st=$(ps -o stat= -p "$(cat "${gates}/crash.first/pid")" 2>/dev/null | tr -d ' '); case "$st" in ''|Z*) printf 'retried' ;; *) printf 'alongside:%s' "$st" ;; esac; fi ;;`,
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

beforeEach(() => {
  tracked.clear();
  logged.length = 0;
});

interface Start {
  pid: number;
  ppid: number;
  args: string[];
}

/** The fake's event lines, in the order they were written. */
function events(): string[][] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(SEP));
}

function starts(): Start[] {
  return events().flatMap((fields) => {
    if (fields[0] !== 'start') return [];
    const count = Number(fields[3]);
    const args = fields.slice(4);
    // A record cut short (still being written) is not a start yet.
    if (!Number.isInteger(count) || (count <= 32 && args.length !== count)) return [];
    return [{ pid: Number(fields[1]), ppid: Number(fields[2]), args }];
  });
}

const ends = (): number[] =>
  events().flatMap((fields) => (fields[0] === 'end' ? [Number(fields[1])] : []));

const last = (s: Start): string => s.args[s.args.length - 1] ?? '';
const job = (name: string): string[] => ['status', '--', name];

function gate(name: string): () => void {
  const file = path.join(gates, name);
  writeFileSync(file, '');
  return () => rmSync(file, { force: true });
}

async function until(
  check: () => boolean,
  ms = 20_000,
  what = 'condition',
  every = 10,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`${what} not reached within ${ms} ms\n${diagnostics()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, every));
  }
}

/** Runners and log lines of the running test, for `diagnostics()`. */
const tracked = new Set<GitRunner>();
const logged: string[] = [];
const testLogger = {
  debug: () => {},
  info: () => {},
  warn: (message: string, fields?: Record<string, unknown>) => {
    logged.push(`warn ${message} ${JSON.stringify(fields ?? {})}`);
  },
  error: (message: string, fields?: Record<string, unknown>) => {
    logged.push(`error ${message} ${JSON.stringify(fields ?? {})}`);
  },
};

/** A runner whose state goes into the diagnostics of a failed wait (and logs to `logged`). */
function newRunner(options: ConstructorParameters<typeof GitRunner>[0]): GitRunner {
  // OCTOPUS_DIFF_TEST_HELPER_START_DELAY_MS: every helper starts that late (macOS CI rehearsal).
  const startDelayMs = Number(process.env.OCTOPUS_DIFF_TEST_HELPER_START_DELAY_MS ?? 0) || 0;
  const helperTest =
    startDelayMs > 0 ? { startDelayMs, ...options?.helperTest } : options?.helperTest;
  const runner = new GitRunner({
    logger: testLogger,
    ...options,
    ...(helperTest ? { helperTest } : {}),
  });
  tracked.add(runner);
  return runner;
}

/**
 * What a failed wait prints: the fake's events, the processes the test knows (the fakes, their
 * parents, the helpers, their groups) as `ps` shows them, the helpers' state, and the warnings.
 */
function diagnostics(): string {
  const known = new Set<number>();
  for (const s of starts()) {
    known.add(s.pid);
    known.add(s.ppid);
  }
  for (const runner of tracked) {
    for (const pid of [...runner.helperPids(), ...runner.helperChildPids()]) known.add(pid);
  }
  const ps =
    spawnSync('ps', ['-A', '-o', 'pid=,ppid=,pgid=,stat=,command='], { encoding: 'utf8' }).stdout ??
    '';
  const processes = ps
    .split('\n')
    .filter((line) => {
      const ids = /^\s*(\d+)\s+(\d+)\s+(\d+)/.exec(line);
      return ids?.slice(1, 4).some((id) => known.has(Number(id))) ?? false;
    })
    .map((line) => line.trim().slice(0, 200));
  const text = existsSync(log) ? readFileSync(log, 'utf8') : '(no log)';
  return [
    '--- fake git events (last 4 KB) ---',
    text.slice(-4096).replaceAll(SEP, ' | ').slice(0, 4096),
    '--- processes the test knows (pid ppid pgid stat command) ---',
    ...(processes.length ? processes : ['(none)']),
    '--- helpers ---',
    ...[...tracked].map(
      (r) =>
        `helpers ${JSON.stringify(r.helperPids())} children ${JSON.stringify(r.helperChildPids())} usesHelper ${r.usesHelper}`,
    ),
    '--- warnings ---',
    ...(logged.length ? logged.slice(-20) : ['(none)']),
  ].join('\n');
}

/**
 * Every process with its group and state, from POSIX `ps` (the same columns on Linux and macOS;
 * no /proc). A zombie (`Z`) is dead: it only waits for its parent, often init, to reap it, which
 * can take seconds on a loaded machine.
 */
function processTable(): Array<{ pid: number; pgid: number; zombie: boolean }> {
  // Dead: a zombie (Z), dead (X, Linux), or exiting (an E flag, BSD/macOS `ps`: killed, on its way
  // out). Anything else may still run code.
  const out = spawnSync('ps', ['-A', '-o', 'pid=,pgid=,stat='], { encoding: 'utf8' }).stdout ?? '';
  return out.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (!match) return [];
    const stat = match[3] as string;
    return [{ pid: Number(match[1]), pgid: Number(match[2]), zombie: /^[ZX]|E/.test(stat) }];
  });
}

/**
 * Waits until none of `pids` and no member of the groups `groups` is still running (only the
 * processes this test started: other tests and sessions run git too).
 */
async function untilGone(what: string, pids: number[], groups: number[] = []): Promise<void> {
  await until(
    () =>
      !processTable().some((p) => !p.zombie && (pids.includes(p.pid) || groups.includes(p.pgid))),
    20_000,
    what,
    50,
  );
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

const T = { spawn: 1, stdin: 2, stdinEnd: 3, kill: 4, detach: 5, ping: 6 } as const;
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
  pong: 27,
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

  async next(id: number, type: number, ms = 20_000): Promise<Frame> {
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

describe.skipIf(process.platform === 'win32')(
  'helper protocol: strict, never a shell',
  { timeout: 60_000 },
  () => {
    it('runs a well-formed request: argv reaches the binary verbatim, with no shell in between', async () => {
      writeFileSync(log, '');
      const helper = new RawHelper();
      await helper.next(0, E.ready);
      const marker = path.join(fx.root, 'pwned');
      const tricky = [
        'status',
        '--',
        `$(touch ${marker})`,
        '`touch x`',
        '; rm -rf /',
        '*',
        '"a b"',
      ];
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
        expect(helper.json(frame).reason, bad[i - 10]?.[0] ?? 'not json').toEqual(
          expect.any(String),
        );
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

    it('answers a PING with a PONG of the same id, and refuses a PING with a payload', async () => {
      const helper = new RawHelper();
      helper.send(T.ping, 7);
      await helper.next(7, E.pong);
      helper.send(T.ping, 8, Buffer.from('x'));
      expect(await helper.exited).toBe(2);
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
      await until(() => helper.pids.some(([id, pid]) => id === 2 && pid > 0), 20_000, 'pid of 2');
      const pid = helper.pids.find(([id, p]) => id === 2 && p > 0)?.[1] as number;
      expect(helper.of(2, E.spawned)).toEqual([]);
      helper.child.kill('SIGKILL');
      await helper.exited;
      // What the parent does with it (helper-client die()): the group is killable.
      expect(alive(-pid)).toBe(true);
      process.kill(-pid, 'SIGKILL');
      await untilGone('the group to die', [], [pid]);
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
      await untilGone('the group of a helper that threw to die', [], [pid]);
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
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          FAKE_MODE: 'zeros',
          FAKE_BYTES: '5000000',
        },
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
      await untilGone('the group to be gone', [pid, family], [pid]);
    });
  },
);

// ---------------------------------------------------------------------------------------------
// The runner on the helper path.

const helperOn = !gitHelperDisabledByEnv() && process.platform !== 'win32';

/** What exec takes for argv and env together (POSIX getconf: 2 MiB on Linux, 1 MiB on macOS). */
const ARG_MAX = ((): number => {
  const value = Number(spawnSync('getconf', ['ARG_MAX'], { encoding: 'utf8' }).stdout?.trim());
  return Number.isFinite(value) && value > 0 ? value : 256 * 1024;
})();
/**
 * Pathspecs `p0`, `p1`, ... that fit: about 15 bytes each as exec counts them (text, NUL, 8-byte
 * pointer), in 60 % of ARG_MAX (the environment and the runner's pins take the rest).
 */
const FITTING_PATHSPECS = Math.min(70_000, Math.floor((0.6 * ARG_MAX) / 15));

function runnerWith(env: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
  return newRunner({ gitBinary: fakeGit, env, helper: { processes: 1 }, ...extra });
}

describe.skipIf(!helperOn)('runner through the helper', { timeout: 60_000 }, () => {
  it('is the default: git is a child of a helper process, not of this one', async () => {
    writeFileSync(log, '');
    // Constructed exactly as lanes.test.ts and runner.test.ts construct theirs.
    const runner = newRunner({ gitBinary: fakeGit, concurrency: 1 });
    const result = await runner.run(job('who'), { cwd: fx.root });
    expect(result.stdout.toString()).toBe('out:who');
    expect(runner.usesHelper).toBe(true);
    const helpers = runner.helperPids();
    expect(helpers).toHaveLength(1);
    expect(starts()[0]?.ppid).toBe(helpers[0]);
    expect(starts()[0]?.ppid).not.toBe(process.pid);
    await runner.dispose();
    await untilGone('the helper to exit on dispose', [helpers[0] as number]);
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
    const direct = newRunner({ gitBinary: fakeGit, env, helper: false });
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
    await untilGone('the capped process to be gone', [pid]);
    await runner.dispose();
  });

  it('times out with the same error and kills the group', async () => {
    writeFileSync(log, '');
    const runner = runnerWith({ FAKE_MODE: 'hang' });
    // A started helper: the timeout below must find git running, not a helper still starting
    // (the timeout counts from the request, as a direct spawn's does).
    await runner.run(job('warm'), { cwd: fx.root, timeoutMs: 60_000 }).catch(() => {});
    writeFileSync(log, '');
    const error = await runner
      .run(job('slow'), { cwd: fx.root, timeoutMs: 1_500 })
      .catch((e: unknown) => e);
    expect(isGitCoreError(error, 'timeout')).toBe(true);
    expect((error as Error).message).toBe('git status timed out after 1500 ms');
    // git did run (else this test would prove nothing), and its group is gone.
    expect(starts()).toHaveLength(1);
    const pid = starts()[0]?.pid as number;
    await untilGone('the group to be gone', [], [pid]);
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
    const runner = newRunner({
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
    const viaHelper = newRunner({
      gitBinary: fakeGit,
      env,
      timeoutMs: 60_000,
      helper: { processes: 1 },
    });
    const direct = newRunner({ gitBinary: fakeGit, env, timeoutMs: 60_000, helper: false });
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
    const runner = newRunner({
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
    const counted = newRunner({
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

  const quietLogger = (warnings: string[]) => ({
    debug: () => {},
    info: () => {},
    warn: (message: string) => warnings.push(message),
    error: () => {},
  });
  const pathspecs = (n: number) => Array.from({ length: n }, (_, i) => `p${i}`);

  it('as many pathspecs as this platform can exec: the helper answers as the direct path does (review #2)', async () => {
    writeFileSync(log, '');
    // At most the helper's own limit: this one goes through the helper.
    const count = Math.min(FITTING_PATHSPECS, HELPER_MAX_ARGV - 200);
    const warnings: string[] = [];
    const viaHelper = newRunner({
      gitBinary: fakeGit,
      env: { FAKE_MODE: 'argc' },
      helper: { processes: 1 },
      logger: quietLogger(warnings),
    });
    const direct = newRunner({ gitBinary: fakeGit, env: { FAKE_MODE: 'argc' }, helper: false });
    const a = await viaHelper.run(['diff', '--', ...pathspecs(count)], { cwd: fx.root });
    const b = await direct.run(['diff', '--', ...pathspecs(count)], { cwd: fx.root });
    expect(a.stdout.toString()).toBe(b.stdout.toString());
    expect(Number(a.stdout.toString())).toBeGreaterThan(count);
    expect(starts()[0]?.ppid).toBe(viaHelper.helperPids()[0]);
    expect(warnings).toEqual([]);
    await Promise.all([viaHelper.dispose(), direct.dispose()]);
  });

  // Only where that many arguments can be exec'd at all (Linux: 2 MiB; macOS gives 1 MiB to argv
  // and env together, pointers included, so 70 000 arguments are E2BIG there on any path).
  it.runIf(FITTING_PATHSPECS > HELPER_MAX_ARGV)(
    'more pathspecs than the helper takes: sent directly up front, same answer (review #2)',
    async () => {
      const count = FITTING_PATHSPECS;
      const warnings: string[] = [];
      const viaHelper = newRunner({
        gitBinary: fakeGit,
        env: { FAKE_MODE: 'argc' },
        helper: { processes: 1 },
        logger: quietLogger(warnings),
      });
      const direct = newRunner({
        gitBinary: fakeGit,
        env: { FAKE_MODE: 'argc' },
        helper: false,
      });
      const [a, b] = await Promise.all([
        viaHelper.run(['diff', '--', ...pathspecs(count)], { cwd: fx.root }),
        direct.run(['diff', '--', ...pathspecs(count)], { cwd: fx.root }),
      ]);
      expect(a.stdout.toString()).toBe(b.stdout.toString());
      expect(Number(a.stdout.toString())).toBeGreaterThan(HELPER_MAX_ARGV);
      expect(viaHelper.usesHelper).toBe(true);
      // Sent directly up front: the helper never had to refuse it.
      expect(warnings).toEqual([]);
      await Promise.all([viaHelper.dispose(), direct.dispose()]);
    },
  );

  // 1.5 times what exec takes, in arguments of 100 KB (Linux caps one argument at 128 KB): E2BIG on
  // every platform, and still a request the client sends to the helper (it estimates 2 bytes per
  // character against HELPER_MAX_REQUEST_FRAME). Skipped where ARG_MAX is huge.
  it.runIf(2 * 1.5 * ARG_MAX + 64 * 1024 < HELPER_MAX_REQUEST_FRAME)(
    'an argv beyond what the OS can exec: the same error on both paths, no retry, no lost helper',
    async () => {
      writeFileSync(log, '');
      const big = Array.from({ length: Math.ceil((1.5 * ARG_MAX) / 100_000) }, (_, i) =>
        `${i}`.padEnd(100_000, 'x'),
      );
      const warnings: string[] = [];
      const viaHelper = newRunner({
        gitBinary: fakeGit,
        helper: { processes: 1 },
        logger: quietLogger(warnings),
      });
      const direct = newRunner({ gitBinary: fakeGit, helper: false });
      await viaHelper.run(job('warm'), { cwd: fx.root });
      const [helper] = viaHelper.helperPids();
      const errorOf = (runner: GitRunner) =>
        runner.run(['diff', '--', ...big], { cwd: fx.root }).then(
          () => null,
          (e: unknown) => e as GitCoreError,
        );
      const [a, b] = [await errorOf(viaHelper), await errorOf(direct)];
      expect(isGitCoreError(b, 'git_failed')).toBe(true);
      expect(b?.message).toMatch(/E2BIG/);
      expect(a?.code).toBe(b?.code);
      expect(a?.message).toBe(b?.message);
      expect(a?.details.helper).toBeUndefined();
      // Nothing ran, nothing was retried, and the helper is the same one.
      expect(starts().map(last)).toEqual(['warm']);
      expect(viaHelper.helperPids()).toEqual([helper]);
      expect(warnings).toEqual([]);
      await Promise.all([viaHelper.dispose(), direct.dispose()]);
    },
  );

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
    const runner = newRunner({
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
    const runner = newRunner({
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
    await until(() => starts().length === 2, 20_000);
    // Stopped before it wrote a pid, a helper leaves that git unknown, and unkillable (DECISIONS
    // #385, #388): this test is about the slots, so it stops them once both pids are known.
    const known = starts().map((s) => s.pid);
    await until(
      () => known.every((pid) => runner.helperChildPids().includes(pid)),
      20_000,
      'both pids announced',
    );
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
      // The watchdog (1.5 s), the probe (3 s) and the group wait: seconds, not forever.
      expect(Date.now() - abortedAt).toBeLessThan(20_000);
      // The stopped helpers were given up on, and their git processes killed.
      await untilGone('the stopped helpers and their git processes', helpers, gits);
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

  it('a timeout that fires while an abort waits on a stopped helper probes it at once (review #1)', async () => {
    writeFileSync(log, '');
    const release = gate('wt');
    onTestFinished(release);
    // The watchdog far away: only the timeout can start giving up on the helper.
    const runner = newRunner({
      gitBinary: fakeGit,
      concurrency: 1,
      // Long enough for the abort below to come first on a loaded machine, far below the watchdog.
      timeoutMs: 3_000,
      helper: { processes: 1 },
      helperTest: { exitWaitMs: 50_000 },
    });
    // A started helper first: the timeout counts from the request, and must find git running.
    await runner.run(job('warm'), { cwd: fx.root, timeoutMs: 60_000 });
    writeFileSync(log, '');
    const controller = new AbortController();
    const run = runner
      .run(job('wt'), { cwd: fx.root, signal: controller.signal })
      .catch((e: unknown) => e);
    await until(() => starts().length === 1, 20_000, 'the git of the aborted run started');
    const first = starts()[0]?.pid as number;
    await until(() => runner.helperChildPids().includes(first), 20_000, 'the pid announced');
    const [helper] = runner.helperPids();
    releaseStopped([helper as number]);
    process.kill(helper as number, 'SIGSTOP');
    const abortedAt = Date.now();
    controller.abort();
    expect(isGitCoreError(await run, 'aborted')).toBe(true);
    // The timeout (3 s) and the probe (3 s), long before the 50 s watchdog.
    expect(Date.now() - abortedAt).toBeLessThan(25_000);
    await untilGone('the stopped helper', [helper as number]);
    await runner.dispose();
  });

  it('a helper slow to report a SIGKILLed exit is probed, not killed (load)', async () => {
    writeFileSync(log, '');
    const releaseSlow = gate('slow');
    const releaseOther = gate('other');
    onTestFinished(() => {
      releaseSlow();
      releaseOther();
    });
    const runner = newRunner({
      gitBinary: fakeGit,
      concurrency: 2,
      timeoutMs: 60_000,
      helper: { processes: 1 },
      // Exits are reported 4 s late: longer than HELPER_EXIT_WAIT_MS (1.5 s).
      helperTest: { delayExitMs: 4_000 },
    });
    const other = runner.run(job('other'), { cwd: fx.root, queueKey: 'o' });
    await until(() => starts().length === 1, 20_000);
    const slow = runner
      .run(job('slow'), { cwd: fx.root, queueKey: 's', timeoutMs: 1_500 })
      .catch((e: unknown) => e);
    // It must time out with its git running (the helper is warm: `other` runs on it).
    await until(() => starts().length === 2, 20_000, 'the slow git started');
    expect(isGitCoreError(await slow, 'timeout')).toBe(true);
    const [helper] = runner.helperPids();
    // Past the watchdog: the helper answered its probe and is still the one serving `other`.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(runner.helperPids()).toEqual([helper]);
    releaseOther();
    expect((await other).stdout.toString()).toBe('out:other');
    // `other` ran once, on the helper that was kept.
    expect(starts().map(last)).toEqual(['other', 'slow']);
    expect(runner.helperPids()).toEqual([helper]);
    await runner.dispose();
  });

  it('keeps the concurrency limit', async () => {
    writeFileSync(log, '');
    const runner = newRunner({ gitBinary: fakeGit, concurrency: 3, helper: { processes: 2 } });
    const releases = Array.from({ length: 9 }, (_, i) => gate(`c${i}`));
    onTestFinished(() => {
      for (const release of releases) release();
    });
    const runs = releases.map((_, i) =>
      runner.run(job(`c${i}`), { cwd: fx.root, queueKey: `k${i}` }),
    );
    // Helpers start slowly on a loaded or macOS runner: wait for the starts themselves.
    await until(() => starts().length >= 3, 30_000, 'three starts');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(starts()).toHaveLength(3);
    for (const release of releases) release();
    await Promise.all(runs);
    await until(() => ends().length === 9, 30_000, 'nine ends');
    // From the fake's own events, in the order they were written: never more than three running,
    // and every job started once and ended.
    let running = 0;
    let most = 0;
    for (const fields of events()) {
      running += fields[0] === 'start' ? 1 : fields[0] === 'end' ? -1 : 0;
      most = Math.max(most, running);
    }
    expect(most).toBe(3);
    expect(starts().map(last).sort()).toEqual(Array.from({ length: 9 }, (_, i) => `c${i}`).sort());
    expect(new Set(ends())).toEqual(new Set(starts().map((s) => s.pid)));
    // Spread over both helpers while they were busy.
    expect(new Set(starts().map((s) => s.ppid)).size).toBe(2);
    await runner.dispose();
  });

  it('cancels as the direct path does: queued never spawns, SIGTERM, SIGKILL after the grace period, slot held until exit', async () => {
    writeFileSync(log, '');
    rmSync(path.join(gates, 'family.pid'), { force: true });
    const runner = newRunner({
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
    // git died on SIGTERM (reaped by its helper before EXIT); the member that ignores SIGTERM goes
    // only with the SIGKILL after the grace period (it would sleep 30 s otherwise). Whether it is
    // still alive at this instant depends on the machine's load, so that is not asserted.
    expect(alive(pid)).toBe(false);
    await untilGone('the SIGKILL after the grace', [family]);
    expect(Date.now() - abortedAt).toBeGreaterThanOrEqual(ABORT_GRACE_MS - 50);
    await until(() => starts().length === 2);
    expect(starts().map(last)).toEqual(['first', 'second']);
    controller.abort();
    await runner.dispose();
    await second;
  });

  it('holds the slot while an aborted process ignores SIGTERM, then SIGKILLs it', async () => {
    writeFileSync(log, '');
    const runner = newRunner({
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
      .run(job('second'), { cwd: fx.root, queueKey: 'x', signal: AbortSignal.timeout(30_000) })
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
    const missing = newRunner({
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

describe.skipIf(!helperOn)('helper crashes', { timeout: 60_000 }, () => {
  it('a helper killed with SIGKILL mid-request: the request runs again cleanly, the next one works', async () => {
    writeFileSync(log, '');
    rmSync(path.join(gates, 'once.done'), { force: true });
    const runner = runnerWith({ FAKE_MODE: 'once' }, { timeoutMs: 60_000 });
    const run = runner.run(job('once'), { cwd: fx.root });
    await until(() => starts().length === 1);
    const [helper] = runner.helperPids();
    const firstGit = starts()[0]?.pid as number;
    // An external SIGKILL can land after git started and before the helper announced its pid (a
    // loaded machine deschedules it there): then nothing may be retried (DECISIONS #376). This
    // test is about the retry, so it kills once the parent knows the pid.
    await until(() => runner.helperChildPids().includes(firstGit), 20_000, 'the pid announced');
    process.kill(helper as number, 'SIGKILL');
    const result = await run;
    expect(result.stdout.toString()).toBe('second run');
    // The first git process did not outlive its helper.
    await untilGone('the orphaned group to die', [firstGit], [firstGit]);
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
    const runner = newRunner({
      gitBinary: fakeGit,
      env: { FAKE_MODE: 'crashonce', CRASH_FILE: crash },
      timeoutMs: 60_000,
      helper: { processes: 1 },
      helperTest: { crash: `after-spawn:${crash}` },
    });
    const result = await runner.run(job('crash'), { cwd: fx.root });
    // The hook fired (it deletes the file) after git had started.
    expect(existsSync(crash)).toBe(false);
    expect(result.stdout.toString()).toBe('retried');
    const first = Number(readFileSync(path.join(gates, 'crash.first', 'pid'), 'utf8'));
    await untilGone('the first git', [first], [first]);
    expect(starts()).toHaveLength(2);
    await runner.dispose();
  });

  it("a crashed helper's request is retried even when its killed group lingers past the wait (slow reaping)", async () => {
    writeFileSync(log, '');
    rmSync(path.join(gates, 'once.done'), { force: true });
    // No wait at all for the SIGKILLed group: it still exists (dying, or a zombie) when checked.
    const runner = runnerWith(
      { FAKE_MODE: 'once' },
      { timeoutMs: 60_000, helperTest: { groupGoneWaitMs: 0 } },
    );
    const run = runner.run(job('once'), { cwd: fx.root });
    await until(() => starts().length === 1, 20_000);
    const firstGit = starts()[0]?.pid as number;
    await until(() => runner.helperChildPids().includes(firstGit), 20_000, 'the pid announced');
    process.kill(runner.helperPids()[0] as number, 'SIGKILL');
    // SIGKILLed, it runs no more code: the retry goes ahead.
    expect((await run).stdout.toString()).toBe('second run');
    await untilGone('the first git', [firstGit], [firstGit]);
    await runner.dispose();
  });

  it('a helper that dies between announcing a spawn and its pid: no retry (git may be running), a clear error', async () => {
    writeFileSync(log, '');
    const crash = path.join(fx.root, 'crash-before');
    writeFileSync(crash, '');
    const runner = newRunner({
      gitBinary: fakeGit,
      timeoutMs: 60_000,
      helper: { processes: 1 },
      helperTest: { crash: `before-spawn:${crash}` },
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
    await untilGone('the orphaned group to die', [gitPid], [gitPid]);
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
    const runner = newRunner({ gitBinary: fakeGit, helper: { entry: broken }, logger });
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

describe.skipIf(!helperOn)('parent death', { timeout: 60_000 }, () => {
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
        30_000,
        `the parent to start two git processes (${stderr})`,
      );
      const helpers = readFileSync(pidFile, 'utf8').trim().split(' ').map(Number);
      const gits = starts().map((s) => s.pid);
      const family = Number(readFileSync(path.join(gates, 'family.pid'), 'utf8').trim());
      expect(starts().every((s) => helpers.includes(s.ppid))).toBe(true);
      expect([...helpers, ...gits, family].every(alive)).toBe(true);
      parent.kill('SIGKILL');
      await untilGone(
        'the helpers and the git processes this test started',
        [...helpers, ...gits, family],
        gits,
      );
    } finally {
      if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
    }
  });
});
