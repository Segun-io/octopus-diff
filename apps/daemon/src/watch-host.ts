import { type ChildProcess, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Logger } from '@octopus-diff/contracts';
import type parcelWatcher from '@parcel/watcher';

/**
 * `@parcel/watcher` in a child process, the "watch host" (DECISIONS #130).
 *
 * Why: @parcel/watcher 2.6.0's inotify thread throws on `poll()` returning `EINTR` (any signal
 * delivered to that thread, e.g. `SIGCHLD` from the daemon's many short git processes). The
 * thread ends without signalling that it ended, every subscription of the shared backend gets
 * "Unable to poll: Interrupted system call", and the backend's destructor, which waits for
 * that signal, never returns. Whichever thread drops the last reference to the backend runs
 * the destructor; when that is the JavaScript thread (an in-flight subscribe or unsubscribe
 * holds a reference), the whole process hangs. The daemon cannot avoid that from JavaScript.
 *
 * The host spawns no processes, so it receives no `SIGCHLD` and its inotify thread is not
 * interrupted. If it ever stops answering anyway, it is a separate process: requests time out,
 * the host is killed (never waited for), every subscription reports an error (the watcher
 * re-subscribes, on a fresh host) and `close()` kills it without waiting.
 */

/** The host's source, run with `node -e`; argv[1] is `@parcel/watcher`'s resolved entry point. */
const HOST_SOURCE = `'use strict';
const watcher = require(process.argv[1]);
const subs = new Map();
const dead = new Set();
const message = (error) => String((error && error.message) || error);
const send = (m) => { if (process.connected) process.send(m); };
process.on('disconnect', () => process.exit(0));
process.on('message', (m) => {
  if (m.t === 'sub') {
    const id = m.id;
    subs.set(id, null);
    const onEvents = (error, events) => {
      if (error) {
        dead.add(id);
        send({ t: 'ev', id, error: message(error) });
      } else {
        send({ t: 'ev', id, events: events.map((e) => ({ type: e.type, path: e.path })) });
      }
    };
    watcher.subscribe(m.dir, onEvents, m.opts).then(
      (sub) => {
        if (!subs.has(id)) {
          if (!dead.has(id)) sub.unsubscribe().catch(() => {});
          dead.delete(id);
          return;
        }
        subs.set(id, sub);
        send({ t: 'ok', id });
      },
      (error) => {
        subs.delete(id);
        dead.delete(id);
        send({ t: 'fail', id, error: message(error) });
      },
    );
  } else if (m.t === 'unsub') {
    const sub = subs.get(m.id);
    subs.delete(m.id);
    // Never unsubscribe after an error: the backend is dead and its cleanup can block.
    if (sub && !dead.has(m.id)) sub.unsubscribe().catch(() => {});
    if (sub) dead.delete(m.id);
  }
});
`;

type HostMessage =
  | { t: 'ok'; id: number }
  | { t: 'fail'; id: number; error: string }
  | { t: 'ev'; id: number; error?: string; events?: parcelWatcher.Event[] };

type Callback = parcelWatcher.SubscribeCallback;

export interface WatchHostOptions {
  logger: Logger;
  /** How long a subscribe may take before the host is considered stuck (default 60 s). */
  requestTimeoutMs?: number;
}

export interface WatchHost {
  subscribe(
    dir: string,
    fn: Callback,
    opts?: parcelWatcher.Options,
  ): Promise<parcelWatcher.AsyncSubscription>;
  /** Starts the host process now, so the first subscribe does not wait for it to boot. */
  warm(): void;
  /** Kills the host process (never waits for it). Later subscribes start a new one. */
  close(): void;
  /** The current host's pid, if one is running (tests). */
  readonly pid: number | undefined;
}

interface Host {
  child: ChildProcess;
  callbacks: Map<number, Callback>;
  pending: Map<
    number,
    {
      resolve: () => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >;
  stderr: string;
  stopped: boolean;
}

const liveHosts = new Set<ChildProcess>();
let exitHookInstalled = false;

/** Kills every host when this process exits, however it exits (sync, no waiting). */
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const child of liveHosts) child.kill('SIGKILL');
  });
}

let watcherEntry: string | undefined;

function resolveWatcher(): string {
  watcherEntry ??= createRequire(import.meta.url).resolve('@parcel/watcher');
  return watcherEntry;
}

export function createWatchHost(options: WatchHostOptions): WatchHost {
  const log = options.logger;
  const timeoutMs = options.requestTimeoutMs ?? 60_000;
  let host: Host | null = null;
  let nextId = 1;

  const stop = (h: Host, reason: string, notify: boolean): void => {
    if (h.stopped) return;
    h.stopped = true;
    if (host === h) host = null;
    liveHosts.delete(h.child);
    h.child.kill('SIGKILL');
    const error = new Error(`watch host stopped: ${reason}`);
    // A subscribe still in flight rejects; it gets no error callback as well.
    for (const [id, p] of h.pending) {
      h.callbacks.delete(id);
      clearTimeout(p.timer);
      p.reject(error);
    }
    h.pending.clear();
    const callbacks = [...h.callbacks.values()];
    h.callbacks.clear();
    if (!notify) return;
    log.warn('watch host stopped; its subscriptions are re-made on a new one', {
      reason,
      ...(h.stderr ? { stderr: h.stderr.slice(-2000) } : {}),
    });
    for (const fn of callbacks) deliver(fn, error, []);
  };

  /** The channel keeps this process alive only while a request waits for an answer. */
  const syncRef = (h: Host): void => {
    if (h.pending.size > 0) h.child.channel?.ref();
    else h.child.channel?.unref();
  };

  const deliver = (fn: Callback, error: Error | null, events: parcelWatcher.Event[]): void => {
    try {
      fn(error, events);
    } catch (err) {
      log.error('watch callback failed', { error: err });
    }
  };

  const start = (): Host => {
    const env = { ...process.env };
    // The host needs no loaders or flags of the daemon (tsx in development, for instance).
    delete env.NODE_OPTIONS;
    const child = spawn(
      process.execPath,
      ['--input-type=commonjs', '-e', HOST_SOURCE, resolveWatcher()],
      {
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env,
        windowsHide: true,
      },
    );
    const h: Host = { child, callbacks: new Map(), pending: new Map(), stderr: '', stopped: false };
    liveHosts.add(child);
    installExitHook();
    // Neither the process nor its pipes keep the daemon alive.
    child.unref();
    child.channel?.unref();
    child.stderr?.on('data', (chunk: Buffer) => {
      h.stderr = (h.stderr + chunk.toString('utf8')).slice(-4000);
    });
    (child.stderr as unknown as { unref?: () => void } | null)?.unref?.();
    child.on('message', (raw: HostMessage) => {
      if (h.stopped) return;
      if (raw.t === 'ev') {
        const fn = h.callbacks.get(raw.id);
        if (!fn) return;
        if (raw.error !== undefined) {
          // The host drops a failed subscription itself; so does this side.
          h.callbacks.delete(raw.id);
          deliver(fn, new Error(raw.error), []);
        } else {
          deliver(fn, null, raw.events ?? []);
        }
        return;
      }
      const p = h.pending.get(raw.id);
      if (!p) return;
      h.pending.delete(raw.id);
      syncRef(h);
      clearTimeout(p.timer);
      if (raw.t === 'ok') p.resolve();
      else p.reject(new Error(raw.error));
    });
    child.on('error', (error) => stop(h, `could not run: ${error.message}`, true));
    child.on('exit', (code, signal) => stop(h, `exited (code ${code}, signal ${signal})`, true));
    return h;
  };

  const subscribe: WatchHost['subscribe'] = async (dir, fn, opts) => {
    if (!host || host.stopped) host = start();
    const h = host;
    const id = nextId++;
    h.callbacks.set(id, fn);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        h.pending.delete(id);
        h.callbacks.delete(id);
        reject(new Error(`watch host did not answer within ${timeoutMs} ms`));
        stop(h, 'not answering', true);
      }, timeoutMs);
      timer.unref();
      h.pending.set(id, { resolve, reject, timer });
      syncRef(h);
      try {
        h.child.send({ t: 'sub', id, dir, opts: opts ?? {} });
      } catch (error) {
        h.pending.delete(id);
        syncRef(h);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    }).catch((error: unknown) => {
      h.callbacks.delete(id);
      throw error;
    });
    return {
      unsubscribe: async () => {
        // Fire and forget: the host may be stuck; nothing here may wait for it.
        if (!h.callbacks.delete(id) || h.stopped) return;
        try {
          if (h.child.connected) h.child.send({ t: 'unsub', id });
        } catch {
          // The host is gone; nothing to release.
        }
      },
    };
  };

  return {
    subscribe,
    warm() {
      if (!host || host.stopped) host = start();
    },
    close() {
      if (host) stop(host, 'closed', false);
    },
    get pid() {
      return host?.child.pid;
    },
  };
}
