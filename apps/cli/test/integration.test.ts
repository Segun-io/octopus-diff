/**
 * End-to-end checks against the real `@octopus-diff/daemon`. While the daemon is still the Phase 0
 * placeholder (its `startDaemon` throws "placeholder"), these tests skip themselves; once WS2's
 * daemon is merged they run automatically. Nothing here opens a browser, binds a non-loopback
 * address or touches the real ~/.config / ~/.local/state.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDaemon } from '@octopus-diff/daemon';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';
import { defaultDeps } from '../src/deps.js';
import { Capture, makeTempDirs, shutdownSignal, type TempDirs } from './helpers.js';

const isPlaceholder = (error: unknown) =>
  error instanceof Error && /placeholder/i.test(error.message);

/** True while `@octopus-diff/daemon` is the placeholder (probes it once on an ephemeral port). */
async function daemonIsPlaceholder(dirs: TempDirs): Promise<boolean> {
  try {
    const handle = await startDaemon({
      host: '127.0.0.1',
      port: 0,
      stateDir: path.join(dirs.root, 'probe-state'),
      configDir: path.join(dirs.root, 'probe-config'),
      webRoot: null,
      watch: { enabled: false },
      logLevel: 'silent',
    });
    await handle.close();
    return false;
  } catch (error) {
    if (isPlaceholder(error)) return true;
    throw error;
  }
}

let dirs: TempDirs;
beforeEach(async () => {
  dirs = await makeTempDirs();
});
afterEach(async () => {
  await dirs.cleanup();
});

describe('serve with the real daemon', () => {
  it('starts, answers /api/health, writes the token 0600, and stops on a signal', async (ctx) => {
    if (await daemonIsPlaceholder(dirs)) ctx.skip();
    const out = new Capture();
    const err = new Capture();
    const shutdown = shutdownSignal();
    let healthStatus = 0;
    const deps = {
      ...defaultDeps(),
      env: { HOME: dirs.home },
      cwd: dirs.cwd,
      stdout: out,
      stderr: err,
      waitForShutdown: shutdown.wait,
      openUrl: async () => {
        throw new Error('tests must not open a browser');
      },
    };
    const code = await run(['serve', '--port', '0', '--no-watch', '--log-level', 'warn'], deps, {
      serve: {
        onReady: (handle) => {
          void fetch(`${handle.url}/api/health`)
            .then((r) => {
              healthStatus = r.status;
            })
            .finally(() => shutdown.trigger('SIGTERM'));
        },
      },
    });
    expect(err.text).not.toContain('failed to start');
    expect(code).toBe(0);
    expect(healthStatus).toBe(200);
    expect(out.text).toMatch(/Open: {3}http:\/\/127\.0\.0\.1:\d+\/#token=\S+/);
    const token = await stat(path.join(dirs.stateDir, 'token'));
    expect(token.mode & 0o777).toBe(0o600);
  });
});

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const builtBin = path.join(cliRoot, 'dist', 'index.js');

function waitForOutput(child: ChildProcess, pattern: RegExp, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    const timer = setTimeout(
      () => reject(new Error(`timed out; output so far:\n${text}`)),
      timeoutMs,
    );
    const onData = (chunk: Buffer) => {
      text += chunk.toString();
      if (pattern.test(text)) {
        clearTimeout(timer);
        resolve(text);
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error(`exited early; output:\n${text}`));
    });
  });
}

describe('built CLI binary (node apps/cli/dist/index.js)', () => {
  it('prints its version', async (ctx) => {
    if (!existsSync(builtBin)) ctx.skip();
    const child = spawn(process.execPath, [builtBin, '--version'], { stdio: 'pipe' });
    let text = '';
    child.stdout.on('data', (c: Buffer) => {
      text += c.toString();
    });
    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    const pkg = JSON.parse(await readFile(path.join(cliRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(code).toBe(0);
    expect(text.trim()).toBe(pkg.version);
  });

  it('serve prints the tokenized URL and exits 0 on SIGINT', async (ctx) => {
    if (!existsSync(builtBin) || (await daemonIsPlaceholder(dirs))) ctx.skip();
    const stateDir = path.join(dirs.root, 'state');
    const configDir = path.join(dirs.root, 'config');
    await mkdir(configDir, { recursive: true });
    const child = spawn(
      process.execPath,
      [
        builtBin,
        'serve',
        '--port',
        '0',
        '--no-watch',
        '--state-dir',
        stateDir,
        '--config-dir',
        configDir,
      ],
      { stdio: 'pipe', cwd: dirs.cwd, env: { ...process.env, HOME: dirs.home } },
    );
    try {
      const output = await waitForOutput(
        child,
        /Open: {3}http:\/\/127\.0\.0\.1:\d+\/#token=\S+/,
        15_000,
      );
      const url = /Open: {3}(http:\/\/127\.0\.0\.1:\d+)\//.exec(output)?.[1];
      expect(url).toBeDefined();
      const health = await fetch(`${url}/api/health`);
      expect(health.status).toBe(200);
      // The web UI is served from the copied assets.
      const index = await fetch(`${url}/`);
      expect([200, 302, 401]).toContain(index.status);
    } finally {
      const exited = new Promise<number | null>((resolve) => child.once('exit', resolve));
      child.kill('SIGINT');
      expect(await exited).toBe(0);
    }
  });
});
