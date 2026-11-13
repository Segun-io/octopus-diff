/**
 * The daemon's Effect runtime (#46, DECISIONS #395-#397): one `ManagedRuntime` per daemon, built
 * lazily from scoped Layers and disposed on close. Promise-based code (Hono handlers, the CLI,
 * `DaemonCore`, tests) calls into it through `runAtBoundary` (`@octopus-diff/git-core`): an
 * AbortSignal interrupts the Effect, typed failures reject as themselves (`GitCoreError`,
 * `ApiError`), so `toApiError` maps them to an `ApiErrorBody` exactly as before.
 *
 * What runs in it today: the watch host's supervision (`WatchHostService`). The rest of the core
 * moves in later, one piece at a time (#47 scheduling, #48 the watch pipeline, #49 caches).
 *
 * Logging: Effect's loggers are replaced by one that writes to the daemon's `Logger` (redaction,
 * level filter and JSON lines stay where they are), so `Effect.log*` and the existing log lines
 * end up in the same place.
 */
import type { LogFields, Logger } from '@octopus-diff/contracts';
import { runAtBoundary } from '@octopus-diff/git-core';
import * as Cause from 'effect/Cause';
import type * as Effect from 'effect/Effect';
import * as Layer from 'effect/Layer';
import * as EffectLogger from 'effect/Logger';
import type * as LogLevel from 'effect/LogLevel';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import * as References from 'effect/References';
import { type WatchHostOptions, WatchHostService } from './watch-host.js';

/** The services the daemon's Effect code may use. */
export type DaemonServices = WatchHostService;

export interface DaemonRuntime {
  readonly runtime: ManagedRuntime.ManagedRuntime<DaemonServices, never>;
  /** Runs `effect` for a Promise caller; `signal` interrupts it (see `runAtBoundary`). */
  run<A, E>(
    effect: Effect.Effect<A, E, DaemonServices>,
    options?: { signal?: AbortSignal | undefined },
  ): Promise<A>;
  /** Closes every scoped service (the watch host is killed); idempotent. */
  dispose(): Promise<void>;
}

export interface DaemonRuntimeOptions {
  logger: Logger;
  watchHost?: Omit<WatchHostOptions, 'logger'>;
}

const LEVELS: Record<LogLevel.LogLevel, keyof Logger | null> = {
  All: 'debug',
  Trace: 'debug',
  Debug: 'debug',
  Info: 'info',
  Warn: 'warn',
  Error: 'error',
  Fatal: 'error',
  None: null,
};

/**
 * An Effect logger that writes to a contracts `Logger`: the first string of the message is the
 * message, the rest and the fiber's log annotations are fields, a failure cause is `error`.
 */
export function effectLoggerFor(logger: Logger): EffectLogger.Logger<unknown, void> {
  return EffectLogger.make(({ message, logLevel, cause, fiber }) => {
    const method = LEVELS[logLevel];
    if (!method) return;
    const parts = Array.isArray(message) ? [...message] : [message];
    const text = typeof parts[0] === 'string' ? (parts.shift() as string) : '';
    const fields: LogFields = { ...fiber.getRef(References.CurrentLogAnnotations) };
    if (parts.length === 1) fields.data = parts[0];
    else if (parts.length > 1) fields.data = parts;
    if (cause.reasons.length > 0) fields.error = Cause.squash(cause);
    logger[method](text, Object.keys(fields).length > 0 ? fields : undefined);
  });
}

/** The layer of a daemon's runtime: its scoped services and its logger. */
export function daemonLayer(options: DaemonRuntimeOptions): Layer.Layer<DaemonServices> {
  return Layer.mergeAll(
    WatchHostService.layer({ ...options.watchHost, logger: options.logger }),
    EffectLogger.layer([effectLoggerFor(options.logger)]),
    // The daemon's logger filters by level itself.
    Layer.succeed(References.MinimumLogLevel, 'All'),
  );
}

export function makeDaemonRuntime(options: DaemonRuntimeOptions): DaemonRuntime {
  const runtime = ManagedRuntime.make(daemonLayer(options));
  let disposing: Promise<void> | null = null;
  return {
    runtime,
    run: (effect, runOptions) => runAtBoundary(runtime, effect, runOptions),
    dispose: () => {
      disposing ??= runtime.dispose();
      return disposing;
    },
  };
}
