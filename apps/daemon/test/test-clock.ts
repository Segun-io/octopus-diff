/**
 * Helpers for watch-pipeline tests on Effect's `TestClock` (#48). The watcher's timers run on the
 * test clock (`WatcherServiceOptions.context`), while its I/O (stat, ignore files, a fake
 * subscribe's promises) is real: virtual time only moves while the watcher has nothing in flight
 * (`busy`), so no real delay can make a timer fire earlier or later than it would in production.
 */
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import * as TestClock from 'effect/testing/TestClock';

/** One real event-loop turn (promise reactions, resumed fibers, finished I/O callbacks). */
export const realTick = Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));

/** Waits (in real time, at most `ms`) for a real condition; never moves the test clock. */
export const untilReal = (what: string, check: () => boolean, ms = 10_000) =>
  Effect.promise(async () => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });

export interface Idle {
  readonly busy: boolean;
}

/** Lets real work finish: waits until `target` is idle, then a few event-loop turns. */
export const quiesce = (target: Idle) =>
  Effect.gen(function* () {
    for (let i = 0; i < 3; i++) {
      yield* untilReal('the watcher to be idle', () => !target.busy);
      yield* realTick;
    }
  });

/**
 * The TestClock version of `eventually(check, ms)`: lets real work finish, checks, and moves the
 * test clock `stepMs` at a time, failing once `maxMs` of virtual time went by without `check`.
 */
export const advanceUntil = (
  target: Idle,
  what: string,
  check: () => boolean,
  maxMs: number,
  stepMs = 10,
) =>
  Effect.gen(function* () {
    for (let elapsed = 0; ; elapsed += stepMs) {
      yield* quiesce(target);
      if (check()) return elapsed;
      if (elapsed >= maxMs) throw new Error(`not within ${maxMs} ms (test clock): ${what}`);
      yield* TestClock.adjust(stepMs);
    }
  });

/** The TestClock version of `sleep(ms)`: moves the clock by `ms`, letting real work finish. */
export const advance = (target: Idle, ms: number, stepMs = 10) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed < ms; elapsed += stepMs) {
      yield* quiesce(target);
      yield* TestClock.adjust(Math.min(stepMs, ms - elapsed));
    }
    yield* quiesce(target);
  });

/** The current time of the test's clock (what `Date.now()` was for the real-time versions). */
export const now = Clock.currentTimeMillis;
