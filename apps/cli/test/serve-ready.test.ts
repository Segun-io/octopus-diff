/**
 * `serve --ready-fd` / `--exit-with-stdin` against the real built CLI and the real daemon, as a
 * supervisor (the desktop app) uses them: a child process with a `pipe` at stdio index 3.
 * Skipped when `dist/index.js` has not been built (`pnpm build`). No signals are used to stop a
 * daemon (Windows has none); stray children are killed by PID in `afterEach`.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SERVE_READY_FRAME_PREFIX,
  type ServeReady,
  ServeReadySchema,
} from '@octopus-diff/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeTempDirs, type TempDirs } from './helpers.js';

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtBin = path.join(cliRoot, 'dist', 'index.js');
const built = existsSync(builtBin);
const TIMEOUT = 20_000;

interface Served {
  child: ChildProcess;
  argv: string[];
  stdout: () => string;
  stderr: () => string;
  /** Everything written to fd 3 until it closed, as soon as it has. */
  readyFd: Promise<string>;
  exit: Promise<number | null>;
}

let dirs: TempDirs;
let stateDir: string;
let configDir: string;
const children: ChildProcess[] = [];

beforeEach(async () => {
  dirs = await makeTempDirs();
  stateDir = path.join(dirs.root, 'state');
  configDir = path.join(dirs.root, 'config');
  await mkdir(configDir, { recursive: true });
});

afterEach(async () => {
  // Stop every child and wait for it to be gone before its state dir is removed (a daemon still
  // holds its SQLite file open on Windows); a forced kill is the bounded fallback.
  await Promise.all(children.splice(0).map(stopChild));
  await dirs.cleanup();
});

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  try {
    child.kill();
  } catch {
    return;
  }
  const timer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }, 5000);
  try {
    await Promise.race([gone, new Promise<void>((r) => setTimeout(r, 10_000).unref())]);
  } finally {
    clearTimeout(timer);
  }
}

function serve(
  extra: string[],
  options: { fd?: boolean; extraEnv?: Record<string, string> } = {},
): Served {
  const argv = [
    builtBin,
    'serve',
    '--port',
    '0',
    '--no-watch',
    '--no-open',
    '--state-dir',
    stateDir,
    '--config-dir',
    configDir,
    ...extra,
  ];
  const child = spawn(process.execPath, argv, {
    // 0 stdin (the lifeline), 1 stdout, 2 stderr, 3 the ready fd.
    stdio: options.fd === false ? ['pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe', 'pipe'],
    cwd: dirs.cwd,
    env: { ...process.env, HOME: dirs.home, USERPROFILE: dirs.home, ...options.extraEnv },
    windowsHide: true,
  });
  children.push(child);
  let out = '';
  let err = '';
  child.stdout?.on('data', (c: Buffer) => {
    out += c.toString();
  });
  child.stderr?.on('data', (c: Buffer) => {
    err += c.toString();
  });
  const fd3 = child.stdio[3] as NodeJS.ReadableStream | null | undefined;
  const readyFd = new Promise<string>((resolve) => {
    if (!fd3) return resolve('');
    let text = '';
    fd3.on('data', (c: Buffer) => {
      text += c.toString();
    });
    fd3.on('end', () => resolve(text));
    fd3.on('close', () => resolve(text));
    fd3.on('error', () => resolve(text));
  });
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, argv, stdout: () => out, stderr: () => err, readyFd, exit };
}

/** The ready line (fd 3 is closed by the CLI after it), or fail with the child's output. */
async function readyLine(served: Served): Promise<{ raw: string; ready: ServeReady }> {
  const raw = await Promise.race([
    served.readyFd,
    new Promise<string>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no ready line\n${served.stderr()}`)),
        15_000,
      );
      timer.unref();
    }),
  ]);
  if (raw === '') throw new Error(`fd 3 closed without a line\n${served.stderr()}`);
  return { raw, ready: ServeReadySchema.parse(JSON.parse(raw)) };
}

async function token(): Promise<string> {
  return (await readFile(path.join(stateDir, 'token'), 'utf8')).trim();
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

const daemonJson = () => path.join(stateDir, 'daemon.json');

function withinMs<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
      timer.unref();
    }),
  ]);
}

describe.skipIf(!built)('built CLI: serve --ready-fd', () => {
  it(
    'writes one valid started line on fd 3 and nothing secret anywhere else',
    async () => {
      const served = serve(['--ready-fd', '3', '--exit-with-stdin']);
      const { raw, ready } = await readyLine(served);

      expect(raw.endsWith('\n')).toBe(true);
      expect(raw.trimEnd()).not.toContain('\n'); // exactly one line, then EOF on the fd
      expect(ready.mode).toBe('started');
      expect(ready.pid).toBe(served.child.pid);
      expect(ready.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      const secret = await token();
      expect(ready.authUrl).toBe(`${ready.url}/#token=${encodeURIComponent(secret)}`);
      const health = await fetch(`${ready.url}/api/health`);
      expect(health.status).toBe(200);
      expect(await exists(daemonJson())).toBe(true);

      // The token only travels in authUrl on the fd.
      expect(served.argv.join(' ')).not.toContain(secret);
      expect(served.stdout()).not.toContain(secret);
      expect(served.stderr()).not.toContain(secret);
      expect(served.stdout()).toContain(ready.url);

      served.child.stdin?.end();
      expect(await withinMs(served.exit, 15_000, 'exit')).toBe(0);
    },
    TIMEOUT,
  );

  it(
    'attached: a daemon already runs for the state dir, so one attached line and exit 0',
    async () => {
      const first = serve(['--ready-fd', '3', '--exit-with-stdin']);
      const started = (await readyLine(first)).ready;

      const second = serve(['--ready-fd', '3', '--exit-with-stdin']);
      const { raw, ready } = await readyLine(second);
      expect(await withinMs(second.exit, 15_000, 'second exit')).toBe(0);

      expect(raw.trimEnd()).not.toContain('\n');
      expect(ready).toMatchObject({
        mode: 'attached',
        url: started.url,
        authUrl: started.authUrl,
        pid: started.pid,
      });
      expect(ready.version).toBe(started.version);
      const secret = await token();
      expect(second.stdout()).not.toContain(secret);
      expect(second.stderr()).not.toContain(secret);
      expect(second.argv.join(' ')).not.toContain(secret);
      // Attaching leaves the first daemon untouched.
      expect(first.child.exitCode).toBeNull();
      expect((await fetch(`${started.url}/api/health`)).status).toBe(200);
      expect(await exists(daemonJson())).toBe(true);

      first.child.stdin?.end();
      expect(await withinMs(first.exit, 15_000, 'first exit')).toBe(0);
    },
    TIMEOUT * 2,
  );

  it(
    'attached without --exit-with-stdin works too (and keeps stdin unread)',
    async () => {
      const first = serve(['--ready-fd', '3', '--exit-with-stdin']);
      await readyLine(first);
      const second = serve(['--ready-fd', '3']);
      expect((await readyLine(second)).ready.mode).toBe('attached');
      expect(await withinMs(second.exit, 15_000, 'second exit')).toBe(0);
      first.child.stdin?.end();
      expect(await withinMs(first.exit, 15_000, 'first exit')).toBe(0);
    },
    TIMEOUT * 2,
  );

  it.each([
    ['0', 2, /--ready-fd must be a file descriptor of 3 or more/],
    ['2', 2, /--ready-fd must be a file descriptor of 3 or more/],
    ['abc', 2, /--ready-fd must be an integer/],
    ['-1', 2, /--ready-fd must be an integer/],
    ['1.5', 2, /--ready-fd must be an integer/],
    // Valid, but the parent passed nothing there (low numbers are Node's own internal fds).
    ['200', 1, /--ready-fd 200: file descriptor 200 is not open/],
  ])(
    'rejects --ready-fd=%s with a clear error and starts nothing',
    async (value, code, message) => {
      const served = serve([`--ready-fd=${value}`, '--exit-with-stdin']);
      expect(await withinMs(served.exit, 15_000, 'exit')).toBe(code);
      expect(served.stderr()).toMatch(message);
      expect(served.stdout()).not.toContain('is running');
      expect(await exists(daemonJson())).toBe(false);
      expect(await served.readyFd).toBe('');
    },
    TIMEOUT,
  );
});

/** The frame on stdout (`--ready-stdout`), parsed, or fail with the child's output. */
async function readyFrame(served: Served, nonce: string): Promise<ServeReady> {
  const head = `${SERVE_READY_FRAME_PREFIX}${nonce} `;
  const line = await withinMs(
    new Promise<string>((resolve) => {
      const poll = setInterval(() => {
        const found = served
          .stdout()
          .split('\n')
          .find((l) => l.startsWith(head));
        if (found !== undefined && served.stdout().includes(`${found}\n`)) {
          clearInterval(poll);
          resolve(found);
        }
      }, 25);
    }),
    15_000,
    `the ready frame\n${served.stderr()}`,
  );
  return ServeReadySchema.parse(JSON.parse(line.slice(head.length)));
}

describe.skipIf(!built)('built CLI: serve --ready-stdout (#22)', () => {
  const nonce = 'built-cli-nonce_0123456789abcdef';

  it(
    'frames one started line on stdout, no fd 3 needed, and EOF on stdin still stops it',
    async () => {
      const served = serve(['--ready-stdout', nonce, '--exit-with-stdin'], { fd: false });
      const ready = await readyFrame(served, nonce);
      expect(ready.mode).toBe('started');
      expect(ready.pid).toBe(served.child.pid);
      const secret = await token();
      expect(ready.authUrl).toBe(`${ready.url}/#token=${encodeURIComponent(secret)}`);
      expect((await fetch(`${ready.url}/api/health`)).status).toBe(200);
      // Exactly one frame; the token appears in it and nowhere else.
      const lines = served.stdout().split('\n');
      expect(lines.filter((l) => l.startsWith(SERVE_READY_FRAME_PREFIX))).toHaveLength(1);
      expect(lines.filter((l) => l.includes(secret))).toHaveLength(1);
      expect(served.stderr()).not.toContain(secret);
      expect(served.argv.join(' ')).not.toContain(secret);
      expect(served.stdout()).toContain('sent in the ready frame on stdout');

      served.child.stdin?.end();
      expect(await withinMs(served.exit, 15_000, 'exit after EOF')).toBe(0);
      expect(await exists(daemonJson())).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'attached: a second run frames an attached line and exits 0',
    async () => {
      const first = serve(['--ready-stdout', nonce, '--exit-with-stdin'], { fd: false });
      const started = await readyFrame(first, nonce);
      const other = 'second-run-nonce_abcdefghijklmnop';
      const second = serve(['--ready-stdout', other, '--exit-with-stdin'], { fd: false });
      const attached = await readyFrame(second, other);
      expect(await withinMs(second.exit, 15_000, 'second exit')).toBe(0);
      expect(attached).toMatchObject({ mode: 'attached', url: started.url, pid: started.pid });
      expect(second.stdout()).not.toContain(nonce);
      first.child.stdin?.end();
      expect(await withinMs(first.exit, 15_000, 'first exit')).toBe(0);
    },
    TIMEOUT * 2,
  );

  it(
    'closed stderr AND stdout readers (wsl.exe killed): EOF on stdin still shuts down cleanly, exit 0',
    async () => {
      const served = serve(['--ready-stdout', nonce, '--exit-with-stdin'], { fd: false });
      await readyFrame(served, nonce);
      expect(await exists(daemonJson())).toBe(true);
      served.child.stderr?.destroy();
      served.child.stdout?.destroy();
      // The shutdown writes "stdin closed, shutting down…" to the broken stderr.
      served.child.stdin?.end();
      expect(await withinMs(served.exit, 15_000, 'exit after EOF')).toBe(0);
      expect(await exists(daemonJson())).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'a closed stdout reader does not crash the daemon: EOF on stdin still shuts it down cleanly',
    async () => {
      const served = serve(['--ready-stdout', nonce, '--exit-with-stdin'], { fd: false });
      await readyFrame(served, nonce);
      served.child.stdout?.destroy();
      served.child.stdin?.end();
      expect(await withinMs(served.exit, 15_000, 'exit after EOF')).toBe(0);
      expect(served.stderr()).toContain('stdin closed, shutting down');
      expect(await exists(daemonJson())).toBe(false);
    },
    TIMEOUT,
  );
});

describe.skipIf(!built)('built CLI: serve --exit-with-stdin', () => {
  it(
    'EOF on stdin shuts the daemon down gracefully and removes daemon.json (no signal)',
    async () => {
      const served = serve(['--ready-fd', '3', '--exit-with-stdin']);
      const { ready } = await readyLine(served);
      expect(await exists(daemonJson())).toBe(true);

      served.child.stdin?.end();
      expect(await withinMs(served.exit, 15_000, 'exit after EOF')).toBe(0);
      expect(served.stderr()).toContain('stdin closed, shutting down');
      expect(await exists(daemonJson())).toBe(false);
      await expect(fetch(`${ready.url}/api/health`)).rejects.toThrow();
    },
    TIMEOUT,
  );

  it(
    'also works with no ready fd at all',
    async () => {
      const served = serve(['--exit-with-stdin'], { fd: false });
      await withinMs(
        new Promise<void>((resolve) => {
          const poll = setInterval(() => {
            if (served.stdout().includes('is running')) {
              clearInterval(poll);
              resolve();
            }
          }, 50);
        }),
        15_000,
        'banner',
      );
      // The banner of a plain serve keeps its token URL.
      expect(served.stdout()).toContain(`#token=${encodeURIComponent(await token())}`);
      served.child.stdin?.end();
      expect(await withinMs(served.exit, 15_000, 'exit after EOF')).toBe(0);
      expect(await exists(daemonJson())).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'without the flag, closing stdin does not stop the daemon',
    async () => {
      const served = serve(['--ready-fd', '3']);
      const { ready } = await readyLine(served);
      served.child.stdin?.end();
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      expect(served.child.exitCode).toBeNull();
      expect((await fetch(`${ready.url}/api/health`)).status).toBe(200);
      expect(await exists(daemonJson())).toBe(true);
      // Stop it without a signal: not on Windows; kill by PID in afterEach is enough there.
      if (process.platform !== 'win32') {
        served.child.kill('SIGINT');
        expect(await withinMs(served.exit, 15_000, 'exit after SIGINT')).toBe(0);
        expect(await exists(daemonJson())).toBe(false);
      }
    },
    TIMEOUT,
  );
});
