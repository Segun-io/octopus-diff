/**
 * The watch host's supervision (#46) on Effect's `TestClock`: a crashed host is replaced at once,
 * a second crash within a minute waits out a backoff that only `TestClock.adjust` ends, a stuck
 * host's subscribe times out on the test clock, and closing the scope kills the host for good.
 * The host processes are real; the tests wait on real conditions (a process exit, an event), and
 * no test depends on how much real time passes.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { noopLogger } from '@octopus-diff/contracts';
import type parcelWatcher from '@parcel/watcher';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Scope from 'effect/Scope';
import * as TestClock from 'effect/testing/TestClock';
import { makeWatchHost, WATCH_HOST_RESTART_POLICY, type WatchHost } from '../src/watch-host.js';
import { tempDir } from './helpers.js';

const alive = (pid: number | undefined): boolean => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits for a real condition on the real event loop (never the TestClock), at most `ms`. */
const until = (what: string, check: () => boolean, ms = 20_000) =>
  Effect.promise(async () => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

/** Lets the host's fibers run up to their next suspension; no time passes on the TestClock. */
const settle = Effect.promise(() => new Promise((resolve) => setImmediate(resolve)));

function recorder() {
  const calls: Array<{ error: string | null; paths: string[] }> = [];
  const fn: parcelWatcher.SubscribeCallback = (error, events) => {
    calls.push({ error: error ? error.message : null, paths: events.map((e) => e.path) });
  };
  return { fn, calls };
}

const subscribe = (h: WatchHost, dir: string, fn: parcelWatcher.SubscribeCallback = () => {}) =>
  Effect.promise(() => h.subscribe(dir, fn));

/** SIGKILLs the current host and waits until the supervisor has seen it die. */
const crash = (h: WatchHost) =>
  Effect.gen(function* () {
    const pid = h.pid as number;
    process.kill(pid, 'SIGKILL');
    yield* until('the host to be reported dead', () => h.pid === undefined);
    return pid;
  });

describe('watch host supervision (TestClock)', () => {
  it.effect(
    'restarts a crashed host at once, then after a backoff the test clock ends; killed when the scope closes',
    () =>
      Effect.gen(function* () {
        const dir = yield* Effect.promise(() => tempDir());
        const scope = yield* Scope.make();
        const h = yield* Scope.provide(scope)(makeWatchHost({ logger: noopLogger }));
        // Lazy: nothing runs before the first subscribe.
        assert.isUndefined(h.pid);
        const a = recorder();
        yield* subscribe(h, dir, a.fn);
        const first = yield* crash(h);
        // Its subscribers learned that it died.
        yield* until('the error callback', () => a.calls.some((c) => c.error !== null));

        // First death within the window: the next subscribe starts a new host at once.
        yield* subscribe(h, dir);
        const second = h.pid;
        assert.isTrue(alive(second));
        assert.notStrictEqual(second, first);
        yield* crash(h);

        // Second death: 1 s of backoff on the TestClock. The subscribe waits; no host starts.
        const b = recorder();
        let settled = false;
        const pending = h.subscribe(dir, b.fn).then(() => {
          settled = true;
        });
        yield* settle;
        yield* TestClock.adjust('999 millis');
        yield* settle;
        assert.isFalse(settled);
        assert.isUndefined(h.pid);
        yield* TestClock.adjust('1 millis');
        yield* Effect.promise(() => pending);
        const third = h.pid;
        assert.isTrue(alive(third));
        assert.isFalse([first, second].includes(third));
        // The new host delivers events.
        yield* Effect.promise(() => writeFile(path.join(dir, 'c.txt'), 'x'));
        yield* until('an event from the new host', () => b.calls.some((c) => c.paths.length > 0));

        // Closing the scope kills the host for good: it exits, and later subscribes are refused.
        yield* Scope.close(scope, Exit.void);
        yield* until('the host to exit', () => !alive(third));
        assert.isUndefined(h.pid);
        const refused = yield* Effect.promise(() =>
          h
            .subscribe(dir, () => {})
            .then(
              () => null,
              (e: unknown) => e as Error,
            ),
        );
        assert.match(refused?.message ?? '', /watch host closed/);
        assert.isFalse(alive(first) || alive(second));
      }),
    30_000,
  );

  /*
   * The TestClock version of "kills a host that stops answering instead of waiting for it"
   * (watch-host.test.ts). Before: a real 500 ms request timeout, and `Date.now() - started <
   * 3000` to prove it did not wait, which a loaded CI runner can break either way. After: the
   * default 60 s timeout, ended by the test clock, with nothing measured in real time.
   */
  it.effect(
    'a stuck host times out on the test clock and is killed; its subscribers learn it',
    () =>
      Effect.gen(function* () {
        const dir = yield* Effect.promise(() => tempDir());
        const h = yield* makeWatchHost({ logger: noopLogger });
        const live = recorder();
        yield* subscribe(h, dir, live.fn);
        const stuck = h.pid as number;
        process.kill(stuck, 'SIGSTOP'); // the host's JavaScript thread is "deadlocked"
        let outcome: Error | null = null;
        const pending = h
          .subscribe(dir, () => {})
          .catch((error: unknown) => {
            outcome = error as Error;
          });
        yield* settle;
        yield* TestClock.adjust('59 seconds');
        yield* settle;
        assert.isNull(outcome);
        assert.isTrue(alive(stuck));
        yield* TestClock.adjust('1 second');
        yield* Effect.promise(() => pending);
        assert.match((outcome as Error | null)?.message ?? '', /did not answer within 60000 ms/);
        // The subscription made on the stuck host learns that it is dead, and the host is gone.
        yield* until('the error callback', () => live.calls.some((c) => c.error !== null));
        yield* until('the stuck host to be killed', () => !alive(stuck));
        // Not answering counts as a death: the next subscribe gets a new host at once.
        yield* subscribe(h, dir);
        assert.isTrue(alive(h.pid));
        assert.notStrictEqual(h.pid, stuck);
      }).pipe(Effect.scoped),
  );

  it.effect('close() stops the current host without counting a death; warm() starts one', () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() => tempDir());
      const h = yield* makeWatchHost({
        logger: noopLogger,
        restart: { window: '1 minute', maxDeaths: 1 },
      });
      h.warm();
      const warmed = h.pid;
      assert.isTrue(alive(warmed));
      h.close();
      yield* until('the closed host to exit', () => !alive(warmed));
      // With `maxDeaths: 1`, a counted death would have made the supervisor give up.
      yield* subscribe(h, dir);
      assert.isTrue(alive(h.pid));
      yield* crash(h);
      const refused = yield* Effect.promise(() =>
        h
          .subscribe(dir, () => {})
          .then(
            () => null,
            (e: unknown) => e as Error,
          ),
      );
      assert.match(refused?.message ?? '', /watch host gave up/);
    }).pipe(Effect.scoped),
  );

  /*
   * PR #100 review (Greptile P1): a subscribe sleeping out a restart backoff when `close()` runs
   * must reject at once (the watcher's close waits for its subscribes), start no host, and leave
   * the watch host usable: a later subscribe starts one normally.
   */
  it.effect(
    'close() rejects a subscribe sleeping out a long backoff at once, starts no host, and later subscribes work',
    () =>
      Effect.gen(function* () {
        assert.deepStrictEqual(WATCH_HOST_RESTART_POLICY.backoff?.max, Duration.seconds(30));
        const dir = yield* Effect.promise(() => tempDir());
        const h = yield* makeWatchHost({ logger: noopLogger });
        // Crash until the backoff is at its 30 s cap: each wait is the backoff the previous crash
        // left (0, 0, 1, 2, 4, 8, 16 s); the 7th crash leaves 30 s, all within the 1 min window.
        const waits = [0, 0, 1, 2, 4, 8, 16];
        for (const seconds of waits) {
          if (seconds > 0) yield* TestClock.adjust(Duration.seconds(seconds));
          yield* subscribe(h, dir);
          yield* crash(h);
        }
        const startedBefore = h.started;
        assert.strictEqual(startedBefore, waits.length);
        let outcome: Error | null = null;
        let settled = false;
        h.subscribe(dir, () => {}).then(
          () => {
            settled = true;
          },
          (error: unknown) => {
            outcome = error as Error;
            settled = true;
          },
        );
        yield* settle;
        yield* TestClock.adjust('29 seconds');
        yield* settle;
        assert.isFalse(settled); // still sleeping: 1 s of the backoff is left
        assert.strictEqual(h.started, startedBefore);
        h.close();
        // No clock advance: the close alone settles it (a real deadline only reports a failure).
        yield* until('the sleeping subscribe to reject', () => settled, 5_000);
        assert.match((outcome as Error | null)?.message ?? '', /watch host closed/);
        assert.strictEqual(h.started, startedBefore);
        assert.isUndefined(h.pid);
        // Past the rest of the backoff, nothing starts by itself either.
        yield* TestClock.adjust('1 second');
        yield* settle;
        assert.strictEqual(h.started, startedBefore);
        // A later subscribe starts a host normally, at once.
        yield* subscribe(h, dir);
        assert.strictEqual(h.started, startedBefore + 1);
        assert.isTrue(alive(h.pid));
      }).pipe(Effect.scoped),
    30_000,
  );
});
