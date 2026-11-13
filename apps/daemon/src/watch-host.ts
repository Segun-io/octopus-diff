import { type ChildProcess, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { Logger } from '@octopus-diff/contracts';
import {
  makeSupervisor,
  type RestartPolicyOptions,
  restartPolicy,
  type SupervisorUnavailable,
} from '@octopus-diff/git-core';
import type parcelWatcher from '@parcel/watcher';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as Scope from 'effect/Scope';

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
 *
 * Its lifecycle is an Effect `Supervisor` (#46, `@octopus-diff/git-core`): started lazily, a
 * dead host is replaced on the next subscribe (at once the first time within a minute, then after
 * a backoff from 1 s doubling to 30 s), and the request timeout runs on Effect's `Clock`, so
 * tests drive both with `TestClock`. `makeWatchHost` / `WatchHostService.layer` build it in a
 * scope whose close kills it for good; `createWatchHost` is the Promise-only form.
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
  /** How a dead host is replaced (default `WATCH_HOST_RESTART_POLICY`). */
  restart?: RestartPolicyOptions;
}

/**
 * A dead host is replaced on the next subscribe: at once the first time within a minute, then
 * after 1 s, 2 s, ... at most 30 s (a host that keeps dying costs a process each time; the
 * watcher polls meanwhile). It never gives up.
 */
export const WATCH_HOST_RESTART_POLICY: RestartPolicyOptions = {
  window: Duration.minutes(1),
  backoff: { base: Duration.seconds(1), max: Duration.seconds(30), immediate: 1 },
};

export interface WatchHost {
  subscribe(
    dir: string,
    fn: Callback,
    opts?: parcelWatcher.Options,
  ): Promise<parcelWatcher.AsyncSubscription>;
  /** Starts the host process now, so the first subscribe does not wait for it to boot. */
  warm(): void;
  /**
   * Kills the host process (never waits for it) and rejects every subscribe still waiting for a
   * host ("watch host closed: stopped"). Later subscribes start a new one, with no backoff.
   */
  close(): void;
  /** The current host's pid, if one is running (tests). */
  readonly pid: number | undefined;
  /** How many host processes this watch host has started (diagnostics, tests). */
  readonly started: number;
}

interface Host {
  child: ChildProcess;
  callbacks: Map<number, Callback>;
  pending: Map<number, { resolve: () => void; reject: (error: Error) => void }>;
  stderr: string;
  stopped: boolean;
  /** Reports this host's death to its supervisor (after `stop`). */
  died: (reason: string) => void;
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

const toError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const unavailableError = (error: SupervisorUnavailable): Error =>
  new Error(`watch host ${error.state === 'closed' ? 'closed' : 'gave up'}: ${error.reason}`);

/**
 * The watch host in the current scope and context: closing the scope kills the host for good
 * (later subscribes reject); the restart backoff and the request timeout use Effect's `Clock`.
 */
export const makeWatchHost = (
  options: WatchHostOptions,
): Effect.Effect<WatchHost, never, Scope.Scope> =>
  Effect.gen(function* () {
    const log = options.logger;
    const timeoutMs = options.requestTimeoutMs ?? 60_000;
    const context = yield* Effect.context<never>();
    const runPromise = Effect.runPromiseWith(context);
    let nextId = 1;
    let started = 0;

    const stop = (h: Host, reason: string, notify: boolean): void => {
      if (h.stopped) return;
      h.stopped = true;
      liveHosts.delete(h.child);
      h.child.kill('SIGKILL');
      const error = new Error(`watch host stopped: ${reason}`);
      // A subscribe still in flight rejects; it gets no error callback as well.
      for (const [id, p] of h.pending) {
        h.callbacks.delete(id);
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

    /** A death: stop the host (notifying its subscribers), then tell the supervisor. */
    const fail = (h: Host, reason: string): void => {
      const first = !h.stopped;
      stop(h, reason, true);
      if (first) h.died(reason);
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

    const start = (died: Host['died']): Host => {
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
      started += 1;
      const h: Host = {
        child,
        callbacks: new Map(),
        pending: new Map(),
        stderr: '',
        stopped: false,
        died,
      };
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
        if (raw.t === 'ok') p.resolve();
        else p.reject(new Error(raw.error));
      });
      child.on('error', (error) => fail(h, `could not run: ${error.message}`));
      child.on('exit', (code, signal) => fail(h, `exited (code ${code}, signal ${signal})`));
      return h;
    };

    const supervisor = yield* makeSupervisor<Host>({
      name: 'watch host',
      policy: restartPolicy(options.restart ?? WATCH_HOST_RESTART_POLICY),
      acquire: (died) =>
        Effect.acquireRelease(
          Effect.sync(() => start((reason) => died({ reason }))),
          // Released when it died (a no-op then), on close(), or when the scope closes.
          (h) => Effect.sync(() => stop(h, 'closed', false)),
        ),
    });

    /** Sends one subscribe and waits for its answer; interrupted (a timeout), it is forgotten. */
    const request = (h: Host, id: number, dir: string, opts: parcelWatcher.Options | undefined) =>
      Effect.callback<void, Error>((resume) => {
        h.pending.set(id, {
          resolve: () => resume(Effect.void),
          reject: (error) => resume(Effect.fail(error)),
        });
        syncRef(h);
        try {
          h.child.send({ t: 'sub', id, dir, opts: opts ?? {} });
        } catch (error) {
          h.pending.delete(id);
          syncRef(h);
          resume(Effect.fail(toError(error)));
        }
        return Effect.sync(() => {
          h.pending.delete(id);
          syncRef(h);
        });
      });

    const subscribeEffect = (
      dir: string,
      fn: Callback,
      opts: parcelWatcher.Options | undefined,
    ): Effect.Effect<parcelWatcher.AsyncSubscription, Error> =>
      Effect.gen(function* () {
        const h = yield* Effect.mapError(supervisor.get, unavailableError);
        const id = nextId++;
        h.callbacks.set(id, fn);
        yield* request(h, id, dir, opts).pipe(
          Effect.timeoutOrElse({
            duration: Duration.millis(timeoutMs),
            orElse: () =>
              Effect.suspend(() => {
                h.callbacks.delete(id);
                fail(h, 'not answering');
                return Effect.fail(new Error(`watch host did not answer within ${timeoutMs} ms`));
              }),
          }),
          Effect.tapError(() => Effect.sync(() => h.callbacks.delete(id))),
        );
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
      });

    const host: WatchHost = {
      subscribe: (dir, fn, opts) => runPromise(subscribeEffect(dir, fn, opts)),
      warm() {
        if (supervisor.running.length === 0) supervisor.startNow();
      },
      close() {
        // Stops the host and fails every subscribe still waiting for one (a restart backoff
        // included) at once, so the watcher's close never waits for a backoff or for a host
        // started after it (PR #100 review, P1). Later subscribes start a host again.
        supervisor.stopAllNow();
      },
      get pid() {
        return supervisor.running[0]?.child.pid;
      },
      get started() {
        return started;
      },
    };
    return host;
  });

/** The watch host for Promise-only callers: never closed for good (`close()` stops the current one). */
export function createWatchHost(options: WatchHostOptions): WatchHost {
  return Effect.runSync(Scope.provide(Scope.makeUnsafe())(makeWatchHost(options)));
}

/** The daemon's watch host as a scoped service (#46): released with the daemon's runtime. */
export class WatchHostService extends Context.Service<WatchHostService, WatchHost>()(
  '@octopus-diff/daemon/WatchHost',
) {
  static layer(options: WatchHostOptions): Layer.Layer<WatchHostService> {
    return Layer.effect(WatchHostService, makeWatchHost(options));
  }
}
