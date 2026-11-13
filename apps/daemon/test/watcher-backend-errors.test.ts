import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from '@effect/vitest';
import { noopLogger } from '@octopus-diff/contracts';
import type parcelWatcher from '@parcel/watcher';
import * as Clock from 'effect/Clock';
import type * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import { expect } from 'vitest';
import {
  type DirtyReason,
  type SubscribeFn,
  WatcherService,
  type WatcherServiceOptions,
} from '../src/watcher.js';
import { onCleanup, tempDir } from './helpers.js';
import { advance, advanceUntil } from './test-clock.js';

/**
 * A subscription that reports an error (DECISIONS #130: @parcel/watcher's inotify thread dies on
 * `EINTR`, and every subscription of the shared backend gets "Unable to poll: Interrupted system
 * call") is dropped without `unsubscribe()` (native cleanup of a dead backend can block forever)
 * and re-made with a backoff, so live updates come back instead of polling forever.
 *
 * On Effect's `TestClock` (#48): the watcher's timers (debounce, backoff, polls) run on the test
 * clock, and `advanceUntil` / `advance` stand for the real-time `eventually` / `sleep` these tests
 * used, with the same bounds in virtual milliseconds. The assertions are the ones they had.
 */

const EINTR = 'Unable to poll: Interrupted system call';

interface FakeSub {
  dir: string;
  fn: parcelWatcher.SubscribeCallback;
  unsubscribed: boolean;
}

/** In-memory `subscribe`: tests drive the callbacks. `gate` delays the answer of one call. */
function fakeSubscribe(): {
  subscribe: SubscribeFn;
  subs: FakeSub[];
  of: (dir: string) => FakeSub[];
  gate: { before?: (sub: FakeSub) => Promise<void> | void; fail?: (dir: string) => Error | null };
} {
  const subs: FakeSub[] = [];
  const gate: {
    before?: (sub: FakeSub) => Promise<void> | void;
    fail?: (dir: string) => Error | null;
  } = {};
  const subscribe: SubscribeFn = async (dir, fn) => {
    const failure = gate.fail?.(dir);
    if (failure) throw failure;
    const sub: FakeSub = { dir, fn, unsubscribed: false };
    subs.push(sub);
    await gate.before?.(sub);
    return {
      unsubscribe: async () => {
        sub.unsubscribed = true;
      },
    };
  };
  return { subscribe, subs, of: (dir) => subs.filter((s) => s.dir === dir), gate };
}

async function layout() {
  const base = await tempDir();
  const main = path.join(base, 'repo');
  const common = path.join(main, '.git');
  await mkdir(path.join(common, 'refs', 'heads'), { recursive: true });
  await mkdir(path.join(main, 'src'), { recursive: true });
  return {
    main,
    common,
    worktrees: [
      { projectId: 'p1', worktreeId: 'main', root: main, bare: false, isMain: true, targets: null },
    ],
  };
}

function makeWatcher(
  context: Context.Context<never>,
  subscribe: SubscribeFn,
  overrides: Partial<WatcherServiceOptions> = {},
) {
  const dirty: Array<{ id: string; reason: DirtyReason }> = [];
  const watcher = new WatcherService({
    context,
    logger: noopLogger,
    debounceMs: 20,
    pollFocusedMs: 60_000,
    pollIdleMs: 60_000,
    relistMs: 60_000,
    resubscribeDelayMs: 50,
    subscribe,
    onWorktreeDirty: (id, reason) => dirty.push({ id, reason }),
    onWorktreeListDirty: () => {},
    ...overrides,
  });
  onCleanup(() => watcher.close());
  return { watcher, dirty };
}

const update = (p: string): parcelWatcher.Event[] => [{ type: 'update', path: p }];

describe('watcher: subscriptions that report an error', () => {
  it.effect(
    'drops a failed worktree subscription without unsubscribing it, then re-subscribes',
    () =>
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const l = yield* Effect.promise(() => layout());
        const fake = fakeSubscribe();
        const { watcher, dirty } = makeWatcher(context, fake.subscribe);
        yield* Effect.promise(() => watcher.setProject('p1', l.common, l.worktrees));
        const [first] = fake.of(l.main);
        if (!first) throw new Error('not subscribed');
        expect(watcher.status().mode).toBe('native');

        first.fn(new Error(EINTR), []);
        expect(watcher.status().mode).not.toBe('native');
        yield* advanceUntil(watcher, 're-subscribed', () => fake.of(l.main).length === 2, 2000);
        yield* advanceUntil(watcher, 'native', () => watcher.status().mode === 'native', 2000);
        // Changes made while unwatched are picked up once the new subscription is in place.
        yield* advanceUntil(
          watcher,
          'the catch-up refresh',
          () => dirty.some((d) => d.id === 'main' && d.reason === 'fs'),
          2000,
        );
        expect(first.unsubscribed).toBe(false);

        // The new subscription is live; the dead one is ignored.
        const second = fake.of(l.main)[1];
        if (!second) throw new Error('not re-subscribed');
        yield* advance(watcher, 60);
        const mark = dirty.length;
        first.fn(null, update(path.join(l.main, 'src', 'a.ts')));
        yield* advance(watcher, 80);
        expect(dirty.length).toBe(mark);
        second.fn(null, update(path.join(l.main, 'src', 'a.ts')));
        yield* advanceUntil(watcher, 'a refresh', () => dirty.length > mark, 2000);

        // close() releases the live subscription and still never touches the dead one.
        yield* Effect.promise(() => watcher.close());
        expect(second.unsubscribed).toBe(true);
        expect(first.unsubscribed).toBe(false);
      }),
  );

  it.effect('drops a failed git-dir subscription, re-subscribes, and refreshes its worktrees', () =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const l = yield* Effect.promise(() => layout());
      const fake = fakeSubscribe();
      const { watcher, dirty } = makeWatcher(context, fake.subscribe);
      yield* Effect.promise(() => watcher.setProject('p1', l.common, l.worktrees));
      const [git] = fake.of(l.common);
      const [tree] = fake.of(l.main);
      if (!git || !tree) throw new Error('not subscribed');

      // A backend error reaches every subscription of the backend at once.
      git.fn(new Error(EINTR), []);
      tree.fn(new Error(EINTR), []);
      expect(watcher.status().mode).not.toBe('native');
      yield* advanceUntil(watcher, 'native', () => watcher.status().mode === 'native', 2000);
      expect(fake.of(l.common)).toHaveLength(2);
      expect(fake.of(l.main)).toHaveLength(2);
      yield* advanceUntil(
        watcher,
        'a git refresh',
        () => dirty.some((d) => d.id === 'main' && d.reason === 'git'),
        2000,
      );
      yield* Effect.promise(() => watcher.close());
      expect(git.unsubscribed).toBe(false);
      expect(tree.unsubscribed).toBe(false);
      expect(fake.subs.filter((s) => s !== git && s !== tree).every((s) => s.unsubscribed)).toBe(
        true,
      );
    }),
  );

  it.effect('handles an error that arrives before subscribe() returns', () =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const l = yield* Effect.promise(() => layout());
      const fake = fakeSubscribe();
      let failNext = true;
      fake.gate.before = (sub) => {
        if (sub.dir === l.main && failNext) {
          failNext = false;
          sub.fn(new Error(EINTR), []);
        }
      };
      const { watcher } = makeWatcher(context, fake.subscribe);
      yield* Effect.promise(() => watcher.setProject('p1', l.common, l.worktrees));
      const [first] = fake.of(l.main);
      expect(first?.unsubscribed).toBe(false);
      yield* advanceUntil(watcher, 're-subscribed', () => fake.of(l.main).length === 2, 2000);
      yield* advanceUntil(watcher, 'native', () => watcher.status().mode === 'native', 2000);
      expect(first?.unsubscribed).toBe(false);
    }),
  );

  it.effect(
    'backs off while re-subscribing keeps failing for an unknown reason, then recovers',
    () =>
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const l = yield* Effect.promise(() => layout());
        const fake = fakeSubscribe();
        const { watcher } = makeWatcher(context, fake.subscribe);
        yield* Effect.promise(() => watcher.setProject('p1', l.common, l.worktrees));
        const [first] = fake.of(l.main);
        if (!first) throw new Error('not subscribed');

        let attempts = 0;
        const times: number[] = [];
        fake.gate.fail = (dir) => {
          if (dir !== l.main) return null;
          attempts++;
          times.push(Effect.runSyncWith(context)(Clock.currentTimeMillis));
          return attempts <= 2
            ? new Error('watch host stopped: exited (code 1, signal null)')
            : null;
        };
        first.fn(new Error(EINTR), []);
        yield* advanceUntil(watcher, 'native', () => watcher.status().mode === 'native', 3000);
        expect(attempts).toBe(3);
        // 50 ms after the error, then 100 ms, then 200 ms (timers never fire much early).
        const [a = 0, b = 0, c = 0] = times;
        expect(b - a).toBeGreaterThanOrEqual(90);
        expect(c - b).toBeGreaterThanOrEqual(180);
        // On the test clock the backoff is exact.
        expect([b - a, c - b]).toEqual([100, 200]);
      }),
  );

  it.effect(
    'does not retry an error with a known cause that polling handles (missing folder)',
    () =>
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const l = yield* Effect.promise(() => layout());
        const fake = fakeSubscribe();
        const { watcher } = makeWatcher(context, fake.subscribe);
        yield* Effect.promise(() => watcher.setProject('p1', l.common, l.worktrees));
        const [first] = fake.of(l.main);
        first?.fn(new Error(`No such file or directory: ${l.main}`), []);
        yield* advance(watcher, 300);
        expect(fake.of(l.main)).toHaveLength(1);
        expect(first?.unsubscribed).toBe(false);
      }),
  );

  it.effect('stops retrying once the worktree is no longer watched', () =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const l = yield* Effect.promise(() => layout());
      const fake = fakeSubscribe();
      const { watcher } = makeWatcher(context, fake.subscribe, { resubscribeDelayMs: 150 });
      yield* Effect.promise(() => watcher.setProject('p1', l.common, l.worktrees));
      fake.of(l.main)[0]?.fn(new Error(EINTR), []);
      yield* Effect.promise(() => watcher.setProject('p1', l.common, []));
      yield* advance(watcher, 300);
      expect(fake.of(l.main)).toHaveLength(1);
    }),
  );
});
