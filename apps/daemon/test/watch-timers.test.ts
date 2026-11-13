/**
 * The watcher's timers on Effect's `TestClock` (#48): the coalescing window (debounce, maxWait,
 * leading edge, reason precedence, path hints), the fallback polls (focused / idle / degraded, with
 * jitter), the relist, liveness, and close. Events come from an in-memory `subscribe`; directories
 * are real (the watcher stats them). Nothing here waits for real time: the test clock is moved,
 * and only while the watcher is idle (`test-clock.ts`).
 *
 * The last part drives `DirtyWindow` and the inline debounce of `WatcherService.markDirty` before
 * #48 (kept here as the reference model, on a virtual clock) over random trigger/time sequences:
 * both fire at the same times with the same reasons.
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { noopLogger } from '@octopus-diff/contracts';
import type parcelWatcher from '@parcel/watcher';
import * as Clock from 'effect/Clock';
import type * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as TestClock from 'effect/testing/TestClock';
import { afterEach, expect, vi, it as vitestIt } from 'vitest';
import { DirtyWindow } from '../src/dirty-window.js';
import { Timers } from '../src/timers.js';
import {
  type DirtyReason,
  MAX_PENDING_PATHS,
  type SubscribeFn,
  WatcherService,
  type WatcherServiceOptions,
} from '../src/watcher.js';
import { onCleanup, tempDir } from './helpers.js';
import { advance, advanceUntil, quiesce, realTick } from './test-clock.js';

interface FakeSub {
  dir: string;
  fn: parcelWatcher.SubscribeCallback;
  active: boolean;
}

function fakeSubscribe(fail?: (dir: string) => Error | null) {
  const subs: FakeSub[] = [];
  const subscribe: SubscribeFn = async (dir, fn) => {
    const failure = fail?.(dir);
    if (failure) throw failure;
    const sub: FakeSub = { dir, fn, active: true };
    subs.push(sub);
    return {
      unsubscribe: async () => {
        sub.active = false;
      },
    };
  };
  const live = (dir: string): FakeSub => {
    const sub = subs.filter((s) => s.dir === dir && s.active).at(-1);
    if (!sub) throw new Error(`no live subscription for ${dir}`);
    return sub;
  };
  return {
    subscribe,
    subs,
    /** Delivers file events to the live subscription of `dir`. */
    emit: (dir: string, files: string[], type: parcelWatcher.EventType = 'update') =>
      live(dir).fn(
        null,
        files.map((f) => ({ type, path: path.join(dir, f) })),
      ),
  };
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

interface Fire {
  id: string;
  reason: DirtyReason;
  paths: readonly string[] | null;
  at: number;
}

function makeWatcher(
  context: Context.Context<never>,
  subscribe: SubscribeFn,
  overrides: Partial<WatcherServiceOptions> = {},
) {
  const clock = () => Effect.runSyncWith(context)(Clock.currentTimeMillis);
  const fires: Fire[] = [];
  const lists: Array<{ projectId: string; reason: string; at: number }> = [];
  const watcher = new WatcherService({
    context,
    logger: noopLogger,
    debounceMs: 150,
    maxWaitMs: 1000,
    pollFocusedMs: 30_000,
    pollIdleMs: 300_000,
    relistMs: 60_000,
    watchNewSubtrees: false,
    subscribe,
    onWorktreeDirty: (id, reason, paths) => fires.push({ id, reason, paths, at: clock() }),
    onWorktreeListDirty: (projectId, reason) => lists.push({ projectId, reason, at: clock() }),
    ...overrides,
  });
  onCleanup(() => watcher.close());
  return { watcher, fires, lists, clock };
}

/** Starts a watcher on a fresh layout, at test-clock time 0 with every subscription made. */
const started = (overrides: Partial<WatcherServiceOptions> = {}) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<never>();
    const l = yield* Effect.promise(() => layout());
    const fake = fakeSubscribe();
    const w = makeWatcher(context, overrides.subscribe ?? fake.subscribe, overrides);
    yield* Effect.promise(() => w.watcher.setProject('p1', l.common, l.worktrees));
    yield* quiesce(w.watcher);
    return { ...w, l, fake };
  });

afterEach(() => {
  vi.restoreAllMocks();
});

describe('coalescing window (TestClock)', () => {
  it.effect('reports changes after the debounce, coalescing a burst into one fs refresh', () =>
    Effect.gen(function* () {
      const { watcher, fires, l, fake } = yield* started();
      fake.emit(l.main, ['src/a.ts']);
      yield* advance(watcher, 50);
      fake.emit(l.main, ['src/b.ts']);
      yield* advance(watcher, 50);
      fake.emit(l.main, ['src/a.ts', 'src/c.ts']);
      // Re-armed by the last event (t=100): nothing at 249, one refresh at 250.
      yield* advance(watcher, 149);
      assert.deepStrictEqual(fires, []);
      yield* advance(watcher, 1);
      assert.deepStrictEqual(fires, [
        { id: 'main', reason: 'fs', paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'], at: 250 },
      ]);
      yield* advance(watcher, 1000);
      assert.strictEqual(fires.length, 1);
    }),
  );

  it.effect('continuous events cannot postpone a refresh past maxWaitMs', () =>
    Effect.gen(function* () {
      const { watcher, fires, l, fake } = yield* started();
      for (let t = 0; t < 2500; t += 100) {
        fake.emit(l.main, [`src/f${t}.ts`]);
        yield* advance(watcher, 100);
      }
      // Bursts fire 1000 ms after their first event: at 1000, 2000 (events every 100 ms).
      assert.deepStrictEqual(
        fires.map((f) => f.at),
        [1000, 2000],
      );
      yield* advance(watcher, 150);
      assert.deepStrictEqual(
        fires.map((f) => f.at),
        [1000, 2000, 2550],
      );
    }),
  );

  it.effect(
    'leadingEdge: a quiet worktree refreshes inside the call, the rest of the burst once',
    () =>
      Effect.gen(function* () {
        const { watcher, fires, l, fake } = yield* started({ leadingEdge: true });
        fake.emit(l.main, ['src/a.ts']);
        // Synchronously, at t=0.
        assert.deepStrictEqual(fires, [{ id: 'main', reason: 'fs', paths: ['src/a.ts'], at: 0 }]);
        yield* advance(watcher, 20);
        for (let i = 0; i < 5; i++) fake.emit(l.main, [`src/f${i}.ts`]);
        yield* advance(watcher, 149);
        assert.strictEqual(fires.length, 1);
        yield* advance(watcher, 1);
        assert.strictEqual(fires.length, 2);
        assert.deepStrictEqual(fires[1], {
          id: 'main',
          reason: 'fs',
          paths: ['src/f0.ts', 'src/f1.ts', 'src/f2.ts', 'src/f3.ts', 'src/f4.ts'],
          at: 170,
        });
        // Events less than a debounce apart keep re-arming the trailing timer: none of them leads,
        // even once the last fire is more than a debounce ago.
        yield* advance(watcher, 10); // t=180
        fake.emit(l.main, ['src/r1.ts']); // armed
        yield* advance(watcher, 140);
        fake.emit(l.main, ['src/r2.ts']); // t=320: 140 ms after the last fire, still armed
        yield* advance(watcher, 100);
        fake.emit(l.main, ['src/r3.ts']); // t=420: 250 ms after the last fire, still armed
        assert.strictEqual(fires.length, 2);
        yield* advance(watcher, 150);
        assert.deepStrictEqual(fires[2], {
          id: 'main',
          reason: 'fs',
          paths: ['src/r1.ts', 'src/r2.ts', 'src/r3.ts'],
          at: 570,
        });
        // Quiet again for a debounce: the next event leads again.
        yield* advance(watcher, 150);
        fake.emit(l.main, ['src/z.ts']);
        assert.strictEqual(fires.length, 4);
        assert.strictEqual(fires[3]?.at, 720);
      }),
  );

  it.effect('a burst keeps its first reason, except that git wins; paths only for fs alone', () =>
    Effect.gen(function* () {
      const { watcher, fires, l, fake } = yield* started();
      fake.emit(l.main, ['src/a.ts']);
      watcher.markDirty('main', 'git');
      fake.emit(l.main, ['src/b.ts']);
      yield* advance(watcher, 150);
      watcher.markDirty('main', 'manual');
      fake.emit(l.main, ['src/c.ts']);
      yield* advance(watcher, 150);
      watcher.markDirty('main', 'git');
      watcher.markDirty('main', 'manual');
      yield* advance(watcher, 150);
      fake.emit(l.main, ['src/d.ts']);
      watcher.markDirty('main', 'fs');
      yield* advance(watcher, 150);
      assert.deepStrictEqual(
        fires.map((f) => [f.reason, f.paths, f.at]),
        [
          ['git', null, 150],
          ['manual', null, 300],
          ['git', null, 450],
          // markDirty('fs') without paths makes it a full refresh.
          ['fs', null, 600],
        ],
      );
    }),
  );

  it.effect('more than MAX_PENDING_PATHS paths in one refresh: a full one', () =>
    Effect.gen(function* () {
      const { watcher, fires, l, fake } = yield* started();
      fake.emit(
        l.main,
        Array.from({ length: MAX_PENDING_PATHS }, (_, i) => `src/f${i}.ts`),
      );
      yield* advance(watcher, 150);
      assert.strictEqual(fires[0]?.paths?.length, MAX_PENDING_PATHS);
      fake.emit(
        l.main,
        Array.from({ length: MAX_PENDING_PATHS + 1 }, (_, i) => `src/f${i}.ts`),
      );
      yield* advance(watcher, 150);
      assert.strictEqual(fires[1]?.paths, null);
    }),
  );

  it.effect(
    'focus refreshes at once (leading edge), and moving the focus away re-arms its poll',
    () =>
      Effect.gen(function* () {
        vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter
        const { watcher, fires } = yield* started({ leadingEdge: true });
        watcher.setFocus('main');
        assert.deepStrictEqual(
          fires.map((f) => [f.reason, f.at]),
          [['focus', 0]],
        );
        assert.deepStrictEqual(watcher.liveness('main'), { mode: 'native', pollMs: 30_000 });
        yield* advance(watcher, 29_990);
        assert.strictEqual(fires.length, 1);
        yield* advanceUntil(watcher, 'the focused poll', () => fires.length === 2, 10);
        assert.deepStrictEqual(fires[1], { id: 'main', reason: 'poll', paths: null, at: 30_000 });
        watcher.setFocus(null);
        assert.deepStrictEqual(watcher.liveness('main'), { mode: 'native', pollMs: 300_000 });
        yield* advance(watcher, 299_990);
        assert.strictEqual(fires.length, 2);
        yield* advanceUntil(watcher, 'the idle poll', () => fires.length === 3, 10);
        assert.strictEqual(fires[2]?.at, 330_000);
      }),
  );
});

describe('polls and relists (TestClock)', () => {
  it.effect('polls an idle native worktree every pollIdleMs, re-armed by every refresh', () =>
    Effect.gen(function* () {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const { watcher, fires, l, fake } = yield* started();
      yield* advance(watcher, 100_000);
      fake.emit(l.main, ['src/a.ts']);
      yield* advance(watcher, 150); // refresh at 100 150: the poll is now due at 400 150
      yield* advance(watcher, 299_990);
      assert.deepStrictEqual(
        fires.map((f) => [f.reason, f.at]),
        [['fs', 100_150]],
      );
      yield* advance(watcher, 10);
      assert.deepStrictEqual(
        fires.map((f) => [f.reason, f.at]),
        [
          ['fs', 100_150],
          ['poll', 400_150],
        ],
      );
    }),
  );

  it.effect('jitter: ±25 % of the interval, a fresh draw per poll', () =>
    Effect.gen(function* () {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0);
      const { watcher, fires } = yield* started();
      random.mockReturnValue(1);
      yield* advance(watcher, 224_990); // the first poll was drawn at -25 %: 225 000
      assert.strictEqual(fires.length, 0);
      yield* advance(watcher, 10);
      assert.deepStrictEqual(
        fires.map((f) => f.at),
        [225_000],
      );
      // Then +25 %: 375 000 later.
      yield* advance(watcher, 374_990);
      assert.strictEqual(fires.length, 1);
      yield* advance(watcher, 10);
      assert.deepStrictEqual(
        fires.map((f) => f.at),
        [225_000, 600_000],
      );
    }),
  );

  it.effect('a degraded worktree is polled every 5 s focused, every pollFocusedMs otherwise', () =>
    Effect.gen(function* () {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const fake = fakeSubscribe(
        () => new Error('ENOSPC: System limit for number of file watchers'),
      );
      const { watcher, fires } = yield* started({ subscribe: fake.subscribe });
      assert.deepStrictEqual(watcher.liveness('main'), { mode: 'polling', pollMs: 30_000 });
      yield* advance(watcher, 30_000);
      assert.deepStrictEqual(
        fires.map((f) => [f.reason, f.at]),
        [['poll', 30_000]],
      );
      watcher.setFocus('main');
      yield* advance(watcher, 150); // the focus refresh (trailing, no leading edge here)
      assert.deepStrictEqual(watcher.liveness('main'), { mode: 'polling', pollMs: 5_000 });
      yield* advance(watcher, 5_000);
      assert.deepStrictEqual(
        fires.map((f) => [f.reason, f.at]),
        [
          ['poll', 30_000],
          ['focus', 30_150],
          ['poll', 35_150],
        ],
      );
    }),
  );

  it.effect('relists every relistMs ± jitter on a Schedule, and stops when the project goes', () =>
    Effect.gen(function* () {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0);
      const { watcher, lists } = yield* started();
      random.mockReturnValue(1);
      yield* advance(watcher, 44_990); // first relist drawn at -25 %: 45 000
      assert.deepStrictEqual(lists, []);
      yield* advance(watcher, 10);
      assert.deepStrictEqual(lists, [{ projectId: 'p1', reason: 'timer', at: 45_000 }]);
      // The next recurrence draws its own jitter: +25 %, 75 000 later.
      random.mockReturnValue(0.5);
      yield* advance(watcher, 74_990);
      assert.strictEqual(lists.length, 1);
      yield* advance(watcher, 10);
      // And then exactly relistMs.
      yield* advance(watcher, 60_000);
      assert.deepStrictEqual(
        lists.map((x) => x.at),
        [45_000, 120_000, 180_000],
      );
      yield* Effect.promise(() => watcher.removeProject('p1'));
      // Its relist fiber is gone with it (and its worktree's poll), not just muted.
      assert.strictEqual(watcher.pendingTimers, 0);
      yield* advance(watcher, 200_000);
      assert.strictEqual(lists.length, 3);
    }),
  );

  it.effect('git-dir events relist after the debounce (worktree add/remove)', () =>
    Effect.gen(function* () {
      const { watcher, lists, l, fake } = yield* started();
      fake.emit(l.common, ['worktrees/wt/gitdir'], 'create');
      yield* advance(watcher, 140);
      fake.emit(l.common, ['worktrees/wt/locked'], 'create');
      yield* advance(watcher, 149);
      assert.deepStrictEqual(lists, []);
      yield* advance(watcher, 1);
      assert.deepStrictEqual(lists, [{ projectId: 'p1', reason: 'git', at: 290 }]);
    }),
  );

  it.effect(
    'the re-subscribe backoff doubles per error and starts over after 10 quiet minutes',
    () =>
      Effect.gen(function* () {
        const context = yield* Effect.context<never>();
        const l = yield* Effect.promise(() => layout());
        const fake = fakeSubscribe();
        const subscribedAt: number[] = [];
        const clock = () => Effect.runSyncWith(context)(Clock.currentTimeMillis);
        const subscribe: SubscribeFn = (dir, fn, opts) => {
          if (dir === l.main) subscribedAt.push(clock());
          return fake.subscribe(dir, fn, opts);
        };
        const { watcher } = makeWatcher(context, subscribe, { resubscribeDelayMs: 1000 });
        yield* Effect.promise(() => watcher.setProject('p1', l.common, l.worktrees));
        yield* quiesce(watcher);
        const fail = () =>
          fake.subs
            .filter((s) => s.dir === l.main && s.active)
            .at(-1)
            ?.fn(new Error('Unable to poll: Interrupted system call'), []);
        const resubscribed = (n: number) =>
          advanceUntil(watcher, `subscription ${n}`, () => subscribedAt.length === n, 600_000, 100);
        fail(); // t=0
        yield* resubscribed(2);
        fail();
        yield* resubscribed(3);
        fail();
        yield* resubscribed(4);
        // 1 s, then 2 s, then 4 s after each error.
        assert.deepStrictEqual(subscribedAt.slice(1), [1000, 3000, 7000]);
        yield* advance(watcher, 600_000, 10_000);
        yield* advance(watcher, 1000, 100);
        const quietUntil = clock();
        fail(); // more than 10 minutes after the last error: the streak starts over
        yield* resubscribed(5);
        assert.strictEqual((subscribedAt[4] ?? 0) - quietUntil, 1000);
      }),
  );

  it.effect('close interrupts every timer; nothing fires afterwards', () =>
    Effect.gen(function* () {
      const { watcher, fires, lists, l, fake } = yield* started({ leadingEdge: false });
      fake.emit(l.main, ['src/a.ts']);
      watcher.setFocus('main');
      assert.isAbove(watcher.pendingTimers, 0);
      yield* Effect.promise(() => watcher.close());
      assert.strictEqual(watcher.pendingTimers, 0);
      yield* TestClock.adjust(10_000_000);
      yield* realTick;
      assert.deepStrictEqual(fires, []);
      assert.deepStrictEqual(lists, []);
    }),
  );
});

describe('timers on the live clock', () => {
  vitestIt('never hold the process open, and none is left after close', async () => {
    const l = await layout();
    const fake = fakeSubscribe();
    const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    const before = timeouts();
    const fires: string[] = [];
    const watcher = new WatcherService({
      logger: noopLogger,
      debounceMs: 50,
      subscribe: fake.subscribe,
      onWorktreeDirty: (_id, reason) => fires.push(reason),
      onWorktreeListDirty: () => {},
    });
    await watcher.setProject('p1', l.common, l.worktrees);
    watcher.setFocus('main');
    fake.emit(l.main, ['src/a.ts']);
    // Polls, the relist and a debounce are armed, and every one of them is unref'd.
    expect(watcher.pendingTimers).toBeGreaterThanOrEqual(3);
    expect(timeouts()).toBeLessThanOrEqual(before);
    await new Promise((resolve) => setTimeout(resolve, 120));
    // One burst (the focus refresh and the event), with its first reason.
    expect(fires).toEqual(['focus']);
    await watcher.close();
    expect(watcher.pendingTimers).toBe(0);
    expect(timeouts()).toBeLessThanOrEqual(before);
  });
});

// --- DirtyWindow against the inline debounce it replaced ------------------------------------

type Reason = 'fs' | 'git' | 'poll' | 'focus' | 'manual';

/**
 * `WatcherService.markDirty`'s timing before #48 (apps/daemon/src/watcher.ts at 9bf3e6d), on a
 * virtual clock: `setTimeout` is a sorted queue, `Date.now()` the virtual time plus an epoch (the
 * old `lastFireAt` started at 0, i.e. "long ago").
 */
class ReferenceWindow {
  static readonly EPOCH = 1_700_000_000_000;
  now = 0;
  readonly fires: Array<[number, Reason]> = [];
  #queue: Array<{ at: number; seq: number; fn: () => void }> = [];
  #seq = 0;
  #debounce: number | undefined;
  #burstStart = 0;
  #pendingReason: Reason = 'fs';
  #lastFireAt = 0;

  constructor(
    readonly debounceMs: number,
    readonly maxWaitMs: number,
    readonly leadingEdge: boolean,
  ) {}

  #setTimeout(fn: () => void, ms: number): number {
    const seq = ++this.#seq;
    this.#queue.push({ at: this.now + ms, seq, fn });
    return seq;
  }

  #clearTimeout(seq: number | undefined): void {
    this.#queue = this.#queue.filter((t) => t.seq !== seq);
  }

  advance(ms: number): void {
    const end = this.now + ms;
    for (;;) {
      this.#queue.sort((a, b) => a.at - b.at || a.seq - b.seq);
      const next = this.#queue[0];
      if (!next || next.at > end) break;
      this.#queue.shift();
      this.now = next.at;
      next.fn();
    }
    this.now = end;
  }

  fire(reason: Reason): void {
    this.#lastFireAt = ReferenceWindow.EPOCH + this.now;
    this.fires.push([this.now, reason]);
  }

  markDirty(reason: Reason): void {
    const now = ReferenceWindow.EPOCH + this.now;
    if (
      this.leadingEdge &&
      this.#debounce === undefined &&
      now - this.#lastFireAt >= this.debounceMs
    ) {
      this.fire(reason);
      return;
    }
    if (this.#debounce === undefined) {
      this.#burstStart = now;
      this.#pendingReason = reason;
    } else if (reason === 'git') {
      this.#pendingReason = 'git';
    }
    this.#clearTimeout(this.#debounce);
    const wait = Math.max(0, Math.min(this.debounceMs, this.#burstStart + this.maxWaitMs - now));
    this.#debounce = this.#setTimeout(() => {
      this.#debounce = undefined;
      this.fire(this.#pendingReason);
    }, wait);
  }
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const REASONS: Reason[] = ['fs', 'fs', 'fs', 'git', 'manual', 'focus'];

describe('DirtyWindow against the reference model (TestClock)', () => {
  for (let seed = 1; seed <= 30; seed++) {
    it.effect(`random triggers, polls and time steps, seed ${seed}`, () =>
      Effect.gen(function* () {
        const random = lcg(seed);
        const debounceMs = [0, 20, 150, 200][Math.floor(random() * 4)] ?? 150;
        const maxWaitMs = Math.max(debounceMs, [0, 100, 1000][Math.floor(random() * 3)] ?? 1000);
        const leadingEdge = random() < 0.5;
        const timers = new Timers(yield* Effect.context<never>());
        const fires: Array<[number, Reason]> = [];
        const window: DirtyWindow<Reason> = new DirtyWindow<Reason>({
          debounceMs,
          maxWaitMs,
          leadingEdge,
          timers,
          dominant: 'git',
          fire: (reason) => {
            window.noteFired();
            fires.push([timers.now(), reason]);
          },
        });
        const model = new ReferenceWindow(debounceMs, maxWaitMs, leadingEdge);
        for (let step = 0; step < 150; step++) {
          const r = random();
          if (r < 0.5) {
            const reason = REASONS[Math.floor(random() * REASONS.length)] ?? 'fs';
            window.trigger(reason);
            model.markDirty(reason);
          } else if (r < 0.55) {
            // A poll's refresh: it counts as the last fire for the leading edge.
            window.noteFired();
            fires.push([timers.now(), 'poll']);
            model.fire('poll');
          } else {
            const ms = [0, 1, 5, 19, 20, 21, 50, 99, 100, 149, 150, 151, 400, 1000][
              Math.floor(random() * 14)
            ] as number;
            yield* TestClock.adjust(ms);
            yield* realTick;
            model.advance(ms);
          }
          // The next event-loop turn: due timers run (a zero wait included), in both.
          yield* realTick;
          model.advance(0);
          expect(fires, `seed ${seed}, step ${step}`).toEqual(model.fires);
        }
        yield* TestClock.adjust(10_000);
        yield* realTick;
        model.advance(10_000);
        expect(fires).toEqual(model.fires);
        timers.close();
      }),
    );
  }
});
