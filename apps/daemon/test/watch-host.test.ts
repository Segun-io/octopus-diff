import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { noopLogger } from '@octopus-diff/contracts';
import type parcelWatcher from '@parcel/watcher';
import { describe, expect, it } from 'vitest';
import { createWatchHost, type WatchHost } from '../src/watch-host.js';
import { eventually, onCleanup, sleep, tempDir } from './helpers.js';

/**
 * The watch host runs @parcel/watcher in a child process (DECISIONS #130), so a native hang can
 * never block the daemon: a stuck host times out and is killed, a dead one reports an error to
 * every subscriber, and closing or exiting never waits for it.
 */

const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function host(requestTimeoutMs?: number): WatchHost {
  const h = createWatchHost({
    logger: noopLogger,
    ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
  });
  onCleanup(() => h.close());
  return h;
}

function recorder() {
  const calls: Array<{ error: string | null; paths: string[] }> = [];
  const fn: parcelWatcher.SubscribeCallback = (error, events) => {
    calls.push({ error: error ? error.message : null, paths: events.map((e) => e.path) });
  };
  return { fn, calls };
}

describe('watch host', () => {
  it('delivers events from the child process; unsubscribe stops them', async () => {
    const dir = await tempDir();
    const h = host();
    const rec = recorder();
    const sub = await h.subscribe(dir, rec.fn, { ignore: ['ignored'] });
    expect(alive(h.pid)).toBe(true);
    expect(h.pid).not.toBe(process.pid);

    await writeFile(path.join(dir, 'a.txt'), 'x');
    await eventually(() => rec.calls.some((c) => c.paths.includes(path.join(dir, 'a.txt'))), 3000);
    expect(rec.calls.every((c) => c.error === null)).toBe(true);

    await sub.unsubscribe();
    await sleep(100);
    const mark = rec.calls.length;
    await writeFile(path.join(dir, 'b.txt'), 'x');
    await sleep(300);
    expect(rec.calls.length).toBe(mark);
  });

  it('rejects a subscribe that fails in the host', async () => {
    const h = host();
    await expect(h.subscribe(path.join(await tempDir(), 'missing'), () => {})).rejects.toThrow();
  });

  it('reports an error to every subscriber when the host dies, and starts a new one', async () => {
    const dir = await tempDir();
    const h = host();
    const a = recorder();
    const b = recorder();
    await h.subscribe(dir, a.fn);
    await h.subscribe(dir, b.fn);
    const first = h.pid;
    process.kill(first ?? 0, 'SIGKILL');
    await eventually(() => a.calls.some((c) => c.error) && b.calls.some((c) => c.error), 3000);
    expect(a.calls.find((c) => c.error)?.error).toMatch(/watch host stopped/);

    const c = recorder();
    await h.subscribe(dir, c.fn);
    expect(h.pid).not.toBe(first);
    await writeFile(path.join(dir, 'c.txt'), 'x');
    await eventually(() => c.calls.some((x) => x.paths.length > 0), 3000);
  });

  it('kills a host that stops answering instead of waiting for it', async () => {
    const dir = await tempDir();
    const h = host(500);
    const live = recorder();
    await h.subscribe(dir, live.fn);
    const stuck = h.pid;
    process.kill(stuck ?? 0, 'SIGSTOP'); // the host's JavaScript thread is "deadlocked"
    const started = Date.now();
    await expect(h.subscribe(dir, () => {})).rejects.toThrow(/did not answer/);
    expect(Date.now() - started).toBeLessThan(3000);
    // The subscription made on the stuck host learns that it is dead.
    await eventually(() => live.calls.some((c) => c.error), 3000);
    await eventually(() => !alive(stuck), 3000);
  });

  it('close() kills the host at once, even a stuck one', async () => {
    const h = host();
    await h.subscribe(await tempDir(), () => {});
    const pid = h.pid;
    process.kill(pid ?? 0, 'SIGSTOP');
    const started = Date.now();
    h.close();
    expect(Date.now() - started).toBeLessThan(100);
    await eventually(() => !alive(pid), 3000);
  });

  it('does not keep a process alive, and dies with it', async () => {
    const dir = await tempDir();
    const script = path.join(dir, 'exit.mts');
    const source = fileURLToPath(new URL('../src/watch-host.ts', import.meta.url));
    await writeFile(
      script,
      [
        `import { createWatchHost } from ${JSON.stringify(source)};`,
        `const h = createWatchHost({ logger: { debug() {}, info() {}, warn() {}, error() {} } });`,
        `await h.subscribe(${JSON.stringify(dir)}, () => {});`,
        `console.log(h.pid);`,
        // No close(): the event loop drains and the process must exit on its own.
      ].join('\n'),
    );
    const root = fileURLToPath(new URL('../../../', import.meta.url));
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', '--conditions=@octopus-diff/source', script],
      { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] },
    );
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('the process did not exit'));
      }, 15_000);
      child.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    expect(code).toBe(0);
    const pid = Number(out.trim());
    expect(pid).toBeGreaterThan(0);
    await eventually(() => !alive(pid), 3000);
  }, 30_000);
});
