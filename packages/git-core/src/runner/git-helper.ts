/**
 * The git spawn helper (#45): a small long-lived process that starts git for the runner, so the
 * daemon's event loop never pays for `fork`/`exec`. It is a dumb executor. The runner
 * (`runner.ts`) validates everything (subcommand allowlist, config pins, safety environment,
 * paths) and sends the finished `{ binary, argv, cwd, env }`; this process only checks that the
 * request has exactly that shape and that `binary` is the one git binary it was started with.
 * It never builds a command, never reads argv's meaning, never runs a shell, and never executes
 * any other file.
 *
 * Self-contained on purpose: Node built-ins only and erasable TypeScript only, so plain Node runs
 * the source in development and tests (type stripping) and the build ships it as one `.js` file
 * next to the runner (`dist/runner/git-helper.js`) or next to the CLI bundle (`dist/git-helper.js`).
 *
 * Started as `node git-helper.js --octopus-diff-git-helper 1 <absolute git binary>`. The protocol
 * runs over stdin (requests) and stdout (events) as binary frames:
 *
 *   u32 BE length of the rest | u8 type | u32 BE request id | payload
 *
 * Requests: SPAWN (JSON), STDIN (bytes, within the credit granted), STDIN_END, KILL (1 byte:
 * 1 SIGTERM, 2 SIGKILL; the request's process group), DETACH (stop forwarding output, close the
 * pipes). Events: READY, SPAWNED (u32 pid), STDOUT / STDERR (bytes, never decoded), EXIT / CLOSE /
 * ERROR (JSON), TOO_LARGE, REJECTED (JSON reason), FATAL (JSON reason), STDIN_CREDIT (u32). The
 * pid of every git process also goes, synchronously, to the pid channel on fd 3 (`PID_FD`). A frame that is not exactly this shape
 * is fatal: the helper kills every process it started and exits. A SPAWN whose JSON is not exactly
 * the request shape is refused (REJECTED) and nothing runs.
 *
 * When stdin ends (the parent exited, was killed, or disposed git-core), on SIGTERM, and on a
 * write error to stdout, the helper SIGKILLs the process group of every git process it started
 * and exits. It runs in its own session (the runner starts it detached), so terminal signals go
 * to the parent only.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, fstatSync, unlinkSync, writeSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const PROTOCOL = '1';
const HEADER_BYTES = 9;
/** Largest request frame (a SPAWN's JSON or a stdin chunk); above it the stream is refused. */
const MAX_REQUEST_FRAME = 8 * 1024 * 1024;
/** Output is forwarded in frames of at most this many bytes. */
const MAX_EVENT_PAYLOAD = 256 * 1024;
const MAX_CHILDREN = 256;
const MAX_ARGV = 65_536;
const MAX_ENV = 4_096;
/** stderr forwarded per process (the runner keeps 64 KiB). */
const STDERR_CAP = 64 * 1024;
/** A finished process's group stays killable this long (the runner's post-abort SIGKILL). */
const CLOSED_TTL_MS = 5_000;

const REQ_SPAWN = 1;
const REQ_STDIN = 2;
const REQ_STDIN_END = 3;
const REQ_KILL = 4;
const REQ_DETACH = 5;

const EV_READY = 16;
const EV_SPAWNED = 17;
const EV_STDOUT = 18;
const EV_STDERR = 19;
const EV_EXIT = 20;
const EV_CLOSE = 21;
const EV_ERROR = 22;
const EV_TOO_LARGE = 23;
const EV_REJECTED = 24;
const EV_FATAL = 25;
/** u32: more stdin bytes the parent may send for this request (flow control). */
const EV_STDIN_CREDIT = 26;

/** stdin bytes a request may have in flight between the parent and git. */
const STDIN_WINDOW = 256 * 1024;
/**
 * fd 3: the pid channel. 8-byte records `u32 id | u32 pid`, pid 0 meaning "about to spawn",
 * written synchronously around `spawn()` so they reach the kernel before this process can do
 * anything else: a helper that dies at any point after spawning git has told the parent which
 * process group to kill (stdout frames may still be queued in this process when it dies).
 */
const PID_FD = 3;

const SPAWN_KEYS = ['argv', 'binary', 'cwd', 'env', 'maxOutputBytes', 'stdin'];
const USE_PROCESS_GROUP = process.platform !== 'win32';

interface Entry {
  child: ChildProcess;
  pid: number | undefined;
  maxOutputBytes: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  detached: boolean;
  closed: boolean;
  /** stdin bytes the parent may still send (granted and not yet used). */
  stdinCredit: number;
}

interface SpawnRequest {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: boolean;
  maxOutputBytes: number | null;
}

function startupBinary(argv: readonly string[]): string {
  // Exactly: <node> <this file> --octopus-diff-git-helper <protocol> <absolute git binary>.
  const [flag, protocol, binary, ...rest] = argv.slice(2);
  if (
    flag !== '--octopus-diff-git-helper' ||
    protocol !== PROTOCOL ||
    typeof binary !== 'string' ||
    rest.length > 0 ||
    !path.isAbsolute(binary) ||
    binary.includes('\u0000')
  ) {
    process.stderr.write('octopus-diff git helper: bad startup arguments\n');
    process.exit(2);
  }
  return binary;
}

const GIT = startupBinary(process.argv);
// The parent passes a stdio 'pipe', which libuv creates as a socket pair on every POSIX system.
// Anything else on fd 3 is not the channel: Node's own descriptors take the number when the parent
// passed none (an epoll fd on Linux, a wakeup pipe on macOS, hence no FIFOs).
if (!isPidChannel()) {
  process.stderr.write('octopus-diff git helper: no pid channel on fd 3\n');
  process.exit(2);
}

function isPidChannel(): boolean {
  try {
    const stat = fstatSync(PID_FD);
    return stat.isSocket();
  } catch {
    return false;
  }
}
const pidRecord = Buffer.alloc(8);

/** Writes one pid-channel record before returning (blocking; EAGAIN is retried). */
function announce(id: number, pid: number): void {
  pidRecord.writeUInt32BE(id, 0);
  pidRecord.writeUInt32BE(pid, 4);
  let written = 0;
  while (written < pidRecord.length) {
    try {
      written += writeSync(PID_FD, pidRecord, written, pidRecord.length - written);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') shutdown(1);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }
}
const entries = new Map<number, Entry>();
const input = new net.Socket({ fd: 0, readable: true, writable: false });
const output = new net.Socket({ fd: 1, readable: false, writable: true });
/** Entries whose process has not closed yet (the others only stay killable for a while). */
let running = 0;
let shuttingDown = false;

/**
 * Test hook (#45 review): `<before-spawn|after-spawn>:<file>` in this process's environment makes
 * the helper SIGKILL itself once (when `<file>` exists, which it deletes) right before or right
 * after spawning git, with no event-loop turn in between. `after-spawn` first waits (synchronously,
 * at most 3 s) for `<file>.ready`, which the test's git creates. Only the runner's
 * `helperTestCrash` option sets it; the helper's environment is otherwise empty.
 */
const TEST_CRASH = /^(before-spawn|after-spawn):(.+)$/.exec(
  process.env.OCTOPUS_DIFF_GIT_HELPER_TEST_CRASH ?? '',
);

function testCrash(at: 'before-spawn' | 'after-spawn'): void {
  if (!TEST_CRASH || TEST_CRASH[1] !== at) return;
  const file = TEST_CRASH[2] as string;
  if (!existsSync(file)) return;
  unlinkSync(file);
  if (at === 'after-spawn') {
    const deadline = Date.now() + 3_000;
    while (!existsSync(`${file}.ready`) && Date.now() < deadline) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  process.kill(process.pid, 'SIGKILL');
}
let outputBlocked = false;

function header(type: number, id: number, payloadBytes: number): Buffer {
  const head = Buffer.allocUnsafe(HEADER_BYTES);
  head.writeUInt32BE(payloadBytes + 5, 0);
  head.writeUInt8(type, 4);
  head.writeUInt32BE(id, 5);
  return head;
}

function send(type: number, id: number, payload?: Buffer): void {
  if (shuttingDown) return;
  const body = payload ?? Buffer.alloc(0);
  output.cork();
  output.write(header(type, id, body.length));
  const ok = body.length > 0 ? output.write(body) : true;
  output.uncork();
  if (!ok && !outputBlocked) {
    // Back-pressure: stop reading git's pipes until the parent has read what is queued.
    outputBlocked = true;
    for (const entry of entries.values()) pauseEntry(entry);
    output.once('drain', () => {
      outputBlocked = false;
      for (const entry of entries.values()) resumeEntry(entry);
    });
  }
}

function sendJson(type: number, id: number, value: unknown): void {
  send(type, id, Buffer.from(JSON.stringify(value), 'utf8'));
}

function sendBytes(type: number, id: number, chunk: Buffer): void {
  for (let at = 0; at < chunk.length; at += MAX_EVENT_PAYLOAD) {
    send(type, id, chunk.subarray(at, at + MAX_EVENT_PAYLOAD));
  }
}

function pauseEntry(entry: Entry): void {
  if (entry.detached) return;
  entry.child.stdout?.pause();
  entry.child.stderr?.pause();
}

function resumeEntry(entry: Entry): void {
  if (entry.detached) return;
  entry.child.stdout?.resume();
  entry.child.stderr?.resume();
}

function killGroup(entry: Entry, signal: NodeJS.Signals): void {
  if (USE_PROCESS_GROUP && entry.pid !== undefined) {
    try {
      process.kill(-entry.pid, signal);
      return;
    } catch {
      // Group already gone, or not a group leader: fall back to the process itself.
    }
  }
  if (!entry.closed) entry.child.kill(signal);
}

function detach(entry: Entry): void {
  entry.detached = true;
  entry.child.stdout?.destroy();
  entry.child.stderr?.destroy();
  // Drop stdin still queued for git (a cancelled or timed-out request).
  entry.child.stdin?.destroy();
}

function shutdown(code: number): never {
  shuttingDown = true;
  for (const entry of entries.values()) killGroup(entry, 'SIGKILL');
  entries.clear();
  process.exit(code);
}

function fatal(reason: string): never {
  // Written synchronously: the process exits right after.
  const body = Buffer.from(JSON.stringify({ reason }), 'utf8');
  try {
    writeSync(1, Buffer.concat([header(EV_FATAL, 0, body.length), body]));
  } catch {
    // The parent may be gone already.
  }
  shutdown(2);
}

function isNulFree(value: string): boolean {
  return !value.includes('\u0000');
}

/** The request shape, exactly; anything else is refused with the reason. */
function parseSpawn(payload: Buffer): SpawnRequest | string {
  let value: unknown;
  try {
    value = JSON.parse(payload.toString('utf8'));
  } catch {
    return 'not JSON';
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return 'not an object';
  const message = value as Record<string, unknown>;
  const keys = Object.keys(message).sort();
  if (keys.length !== SPAWN_KEYS.length || keys.some((key, i) => key !== SPAWN_KEYS[i])) {
    return `keys must be exactly ${SPAWN_KEYS.join(', ')}`;
  }
  if (message.binary !== GIT) return 'binary is not the git binary this helper runs';
  const { argv, cwd, env, stdin, maxOutputBytes } = message;
  if (!Array.isArray(argv) || argv.length > MAX_ARGV) return 'argv must be an array';
  for (const arg of argv) {
    if (typeof arg !== 'string' || !isNulFree(arg)) return 'argv must hold strings only';
  }
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || !isNulFree(cwd)) {
    return 'cwd must be an absolute path';
  }
  if (typeof env !== 'object' || env === null || Array.isArray(env)) {
    return 'env must be a map of strings';
  }
  const envEntries = Object.entries(env as Record<string, unknown>);
  if (envEntries.length > MAX_ENV) return 'env has too many entries';
  const cleanEnv: Record<string, string> = Object.create(null);
  for (const [key, entry] of envEntries) {
    if (
      key.length === 0 ||
      key.includes('=') ||
      !isNulFree(key) ||
      typeof entry !== 'string' ||
      !isNulFree(entry)
    ) {
      return 'env must be a map of strings';
    }
    cleanEnv[key] = entry;
  }
  if (typeof stdin !== 'boolean') return 'stdin must be a boolean';
  if (
    maxOutputBytes !== null &&
    (typeof maxOutputBytes !== 'number' ||
      !Number.isSafeInteger(maxOutputBytes) ||
      maxOutputBytes <= 0)
  ) {
    return 'maxOutputBytes must be null or a positive integer';
  }
  return { argv: [...(argv as string[])], cwd, env: cleanEnv, stdin, maxOutputBytes };
}

function startGit(id: number, payload: Buffer): void {
  if (entries.has(id)) {
    sendJson(EV_REJECTED, id, { reason: 'request id in use' });
    return;
  }
  if (running >= MAX_CHILDREN) {
    sendJson(EV_REJECTED, id, { reason: 'too many processes' });
    return;
  }
  const request = parseSpawn(payload);
  if (typeof request === 'string') {
    sendJson(EV_REJECTED, id, { reason: request });
    return;
  }
  let child: ChildProcess;
  announce(id, 0);
  testCrash('before-spawn');
  try {
    child = spawn(GIT, request.argv, {
      cwd: request.cwd,
      env: request.env,
      stdio: [request.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      // Own process group, so a kill reaches git's children too.
      detached: USE_PROCESS_GROUP,
    });
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    sendJson(EV_ERROR, id, { code: err?.code ?? null, message: String(err?.message ?? error) });
    sendJson(EV_CLOSE, id, { code: null, signal: null });
    return;
  }
  if (child.pid !== undefined) announce(id, child.pid);
  testCrash('after-spawn');
  const entry: Entry = {
    child,
    pid: child.pid,
    maxOutputBytes: request.maxOutputBytes,
    stdoutBytes: 0,
    stderrBytes: 0,
    detached: false,
    closed: false,
    stdinCredit: request.stdin ? STDIN_WINDOW : 0,
  };
  entries.set(id, entry);
  running += 1;
  if (child.pid !== undefined) {
    const pid = Buffer.allocUnsafe(4);
    pid.writeUInt32BE(child.pid, 0);
    send(EV_SPAWNED, id, pid);
  }
  if (request.stdin) {
    const credit = Buffer.allocUnsafe(4);
    credit.writeUInt32BE(STDIN_WINDOW, 0);
    send(EV_STDIN_CREDIT, id, credit);
  }
  if (outputBlocked) pauseEntry(entry);
  child.stdin?.on('error', () => {
    // git may exit before reading everything (EPIPE).
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    if (entry.detached) return;
    entry.stdoutBytes += chunk.length;
    if (entry.maxOutputBytes !== null && entry.stdoutBytes > entry.maxOutputBytes) {
      killGroup(entry, 'SIGKILL');
      detach(entry);
      send(EV_TOO_LARGE, id);
      return;
    }
    sendBytes(EV_STDOUT, id, chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    if (entry.detached || entry.stderrBytes >= STDERR_CAP) return;
    entry.stderrBytes += chunk.length;
    sendBytes(EV_STDERR, id, chunk);
  });
  child.once('exit', (code, signal) => sendJson(EV_EXIT, id, { code, signal }));
  child.on('error', (error: NodeJS.ErrnoException) => {
    sendJson(EV_ERROR, id, { code: error.code ?? null, message: error.message });
  });
  child.once('close', (code, signal) => {
    entry.closed = true;
    running -= 1;
    sendJson(EV_CLOSE, id, { code, signal });
    // The group stays killable a little longer (a trusted filter that ignored SIGTERM).
    setTimeout(() => {
      if (entries.get(id) === entry) entries.delete(id);
    }, CLOSED_TTL_MS).unref();
  });
}

function onFrame(type: number, id: number, payload: Buffer): void {
  switch (type) {
    case REQ_SPAWN:
      startGit(id, payload);
      return;
    case REQ_STDIN: {
      const entry = entries.get(id);
      if (!entry) return;
      // Never more than the parent was granted: git's pace bounds what this process holds.
      if (payload.length > entry.stdinCredit) fatal('stdin over its credit');
      entry.stdinCredit -= payload.length;
      const length = payload.length;
      const grant = (): void => {
        entry.stdinCredit += length;
        const credit = Buffer.allocUnsafe(4);
        credit.writeUInt32BE(length, 0);
        send(EV_STDIN_CREDIT, id, credit);
      };
      const stdin = entry.child.stdin;
      if (stdin && !stdin.destroyed && !stdin.writableEnded) stdin.write(payload, grant);
      else grant();
      return;
    }
    case REQ_STDIN_END: {
      if (payload.length !== 0) fatal('STDIN_END has a payload');
      const stdin = entries.get(id)?.child.stdin;
      if (stdin && !stdin.writableEnded) stdin.end();
      return;
    }
    case REQ_KILL: {
      if (payload.length !== 1 || (payload[0] !== 1 && payload[0] !== 2)) fatal('bad KILL');
      const entry = entries.get(id);
      if (entry) killGroup(entry, payload[0] === 1 ? 'SIGTERM' : 'SIGKILL');
      return;
    }
    case REQ_DETACH: {
      if (payload.length !== 0) fatal('DETACH has a payload');
      const entry = entries.get(id);
      if (entry) detach(entry);
      return;
    }
    default:
      fatal(`unknown frame type ${type}`);
  }
}

let pending: Buffer[] = [];
let pendingBytes = 0;

input.on('data', (chunk: Buffer) => {
  pending.push(chunk);
  pendingBytes += chunk.length;
  let data = pending.length === 1 ? (pending[0] as Buffer) : Buffer.concat(pending, pendingBytes);
  let offset = 0;
  while (data.length - offset >= 4) {
    const length = data.readUInt32BE(offset);
    if (length < 5 || length > MAX_REQUEST_FRAME + 5) fatal(`bad frame length ${length}`);
    if (data.length - offset - 4 < length) break;
    const type = data.readUInt8(offset + 4);
    const id = data.readUInt32BE(offset + 5);
    const payload = data.subarray(offset + HEADER_BYTES, offset + 4 + length);
    offset += 4 + length;
    onFrame(type, id, payload);
  }
  data = data.subarray(offset);
  pending = data.length > 0 ? [data] : [];
  pendingBytes = data.length;
});
// The parent is gone (exit, crash, SIGKILL) or closed the channel: no orphans.
input.on('end', () => shutdown(0));
input.on('close', () => shutdown(0));
input.on('error', () => shutdown(1));
output.on('error', () => shutdown(1));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));
// Terminal Ctrl-C belongs to the parent, which disposes git-core (and so this helper) itself.
process.on('SIGINT', () => {});

sendJson(EV_READY, 0, { protocol: Number(PROTOCOL), pid: process.pid });
