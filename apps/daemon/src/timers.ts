/**
 * Time for the watch pipeline (#48, DECISIONS #445): every timer of the watcher, the event hub's
 * heartbeat and the new-subtree checks is a fiber sleeping on Effect's `Clock`, started with one
 * Effect context. In production that context holds `unrefClock` (the live clock, whose sleeps
 * never hold the process open, as the `setTimeout(...).unref()` they replace); a test hands in the
 * context of an `it.effect` body, so its `TestClock` drives every timer and nothing waits for real
 * time.
 *
 * `Timers` also owns the fibers it started: `close()` interrupts every one still sleeping or
 * running, so a forgotten cancel cannot leak a timer past the owner's close.
 */
import * as Clock from 'effect/Clock';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import type * as Fiber from 'effect/Fiber';

/** Effect's default (live) clock. */
const LIVE_CLOCK: Clock.Clock = Effect.runSync(Clock.clockWith(Effect.succeed));
const MAX_TIMER_MS = 2 ** 31 - 1;

function sleepUnref(ms: number): Effect.Effect<void> {
  if (ms <= 0) return Effect.yieldNow;
  if (!Number.isFinite(ms)) return Effect.never;
  return Effect.callback<void>((resume) => {
    const step = Math.min(ms, MAX_TIMER_MS);
    const handle = setTimeout(() => resume(step < ms ? sleepUnref(ms - step) : Effect.void), step);
    handle.unref();
    return Effect.sync(() => clearTimeout(handle));
  });
}

/** The live clock, except that its sleeps never keep the process alive. */
export const unrefClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => LIVE_CLOCK.currentTimeMillisUnsafe(),
  currentTimeMillis: LIVE_CLOCK.currentTimeMillis,
  currentTimeNanosUnsafe: () => LIVE_CLOCK.currentTimeNanosUnsafe(),
  currentTimeNanos: LIVE_CLOCK.currentTimeNanos,
  monotonicTimeNanosUnsafe: () => LIVE_CLOCK.monotonicTimeNanosUnsafe(),
  monotonicTimeNanos: LIVE_CLOCK.monotonicTimeNanos,
  sleep: (duration) => sleepUnref(Duration.toMillis(duration)),
};

/**
 * The context the pipeline's fibers run with: `context` as given, except that the live clock is
 * replaced by `unrefClock` (a `TestClock`, or any other clock, is kept).
 */
export function pipelineContext(context?: Context.Context<never>): Context.Context<never> {
  const base = context ?? Context.empty();
  const clock = Effect.runSyncWith(base)(Clock.clockWith(Effect.succeed));
  return clock === LIVE_CLOCK ? Context.add(base, Clock.Clock, unrefClock) : base;
}

/** Cancels a timer; a no-op once it fired or was cancelled. */
export type Cancel = () => void;

export class Timers {
  readonly #context: Context.Context<never>;
  readonly #clock: Clock.Clock;
  readonly #fork: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly #fibers = new Set<Fiber.Fiber<unknown, unknown>>();
  #closed = false;

  constructor(context?: Context.Context<never>) {
    this.#context = pipelineContext(context);
    this.#clock = Effect.runSyncWith(this.#context)(Clock.clockWith(Effect.succeed));
    this.#fork = Effect.runForkWith(this.#context);
  }

  /** The context of the fibers (for code that runs Effects itself). */
  get context(): Context.Context<never> {
    return this.#context;
  }

  /** Milliseconds since the epoch on the pipeline's clock (`Date.now()` on the live clock). */
  now(): number {
    return this.#clock.currentTimeMillisUnsafe();
  }

  /** Fibers started and not yet ended (diagnostics and tests). */
  get size(): number {
    return this.#fibers.size;
  }

  get closed(): boolean {
    return this.#closed;
  }

  /**
   * Starts `effect` as a fiber of this owner; `close()` interrupts it. After close nothing starts
   * (the returned fiber is already interrupted).
   */
  fork<A, E>(effect: Effect.Effect<A, E>): Fiber.Fiber<A, E> {
    // Closed: an interrupted fiber that never ran any of `effect` (a fork starts synchronously).
    if (this.#closed) return this.#fork(Effect.interrupt);
    const fiber = this.#fork(effect);
    if (fiber.pollUnsafe() === undefined) {
      this.#fibers.add(fiber);
      fiber.addObserver(() => this.#fibers.delete(fiber));
    }
    return fiber;
  }

  /** Runs `fn` once after `ms` on the pipeline's clock; returns what cancels it. */
  after(ms: number, fn: () => void): Cancel {
    if (this.#closed) return () => {};
    // `ms <= 0` still runs `fn` later, never inside this call, on every clock (a TestClock
    // completes a zero sleep at once; the live clock yields).
    const wait = ms > 0 ? Effect.sleep(Duration.millis(ms)) : Effect.yieldNow;
    const fiber = this.fork(Effect.andThen(wait, Effect.sync(fn)));
    return () => fiber.interruptUnsafe();
  }

  /**
   * Runs `fn` every `ms` on the pipeline's clock (the first run after one period), until the
   * returned cancel is called or `close()`. A throwing `fn` ends the loop like an uncaught timer
   * error would end the process: callers that must survive it catch inside `fn`.
   */
  every(ms: number, fn: () => void): Cancel {
    if (this.#closed) return () => {};
    const period = Duration.millis(Math.max(1, ms));
    const fiber = this.fork(Effect.forever(Effect.andThen(Effect.sleep(period), Effect.sync(fn))));
    return () => fiber.interruptUnsafe();
  }

  /** Interrupts every fiber still running; nothing starts afterwards. Idempotent. */
  close(): void {
    this.#closed = true;
    for (const fiber of [...this.#fibers]) fiber.interruptUnsafe();
    this.#fibers.clear();
  }
}

/**
 * One pending timer that a new `set` replaces (the `clearTimeout` + `setTimeout` pattern of the
 * hand-written timers).
 */
export class TimerSlot {
  readonly #timers: Timers;
  #cancel: Cancel | null = null;

  constructor(timers: Timers) {
    this.#timers = timers;
  }

  get pending(): boolean {
    return this.#cancel !== null;
  }

  /** Cancels the pending run, if any, and runs `fn` after `ms`. */
  set(ms: number, fn: () => void): void {
    this.clear();
    const cancel = this.#timers.after(ms, () => {
      if (this.#cancel === cancel) this.#cancel = null;
      fn();
    });
    this.#cancel = cancel;
  }

  clear(): void {
    const cancel = this.#cancel;
    this.#cancel = null;
    cancel?.();
  }
}
