import { isGitCoreError } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { type Computed, StateCache } from '../src/state-cache.js';

/** A computation a test settles by hand; records the signal it was started with. */
function work<V>(store = true) {
  let resolve!: (value: Computed<V>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Computed<V>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const run = {
    starts: 0,
    signal: undefined as AbortSignal | undefined,
    compute: (signal: AbortSignal) => {
      run.starts += 1;
      run.signal = signal;
      return promise;
    },
    done: (value: V, keep = store) => resolve({ value, store: keep }),
    fail: (error: unknown) => reject(error),
  };
  return run;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
const immediate =
  <V>(value: V, store = true) =>
  async () => ({ value, store });
const aborted = (error: unknown) => isGitCoreError(error, 'aborted');

describe('StateCache lookups (#49)', () => {
  it('concurrent identical lookups share one computation; later ones are hits', async () => {
    const cache = new StateCache<string>({ capacity: 10 });
    const w = work<string>();
    const all = [1, 2, 3].map(() => cache.get('g', 's', w.compute));
    await tick();
    expect(w.starts).toBe(1);
    w.done('v');
    expect((await Promise.all(all)).map((r) => r.value)).toEqual(['v', 'v', 'v']);
    const again = await cache.get('g', 's', immediate('other'));
    expect(again).toEqual({ value: 'v', hit: true });
    expect(cache.stats()).toMatchObject({ hits: 1, misses: 1, joins: 2, entries: 1, pending: 0 });
  });

  it('different states, groups and keys are different computations', async () => {
    const cache = new StateCache<string>({ capacity: 10 });
    const a = await cache.get('g', 's1', immediate('a'));
    const b = await cache.get('g', 's2', immediate('b'));
    const c = await cache.get('h', 's2', immediate('c'));
    expect([a.value, b.value, c.value]).toEqual(['a', 'b', 'c']);
  });

  it('an aborted waiter leaves at once; the computation goes on for the one still waiting', async () => {
    const cache = new StateCache<string>({ capacity: 10 });
    const w = work<string>();
    const a = new AbortController();
    const b = new AbortController();
    const first = cache.get('g', 's', w.compute, a.signal).catch((e: unknown) => e);
    const second = cache.get('g', 's', w.compute, b.signal);
    await tick();
    a.abort();
    expect(aborted(await first)).toBe(true);
    await tick();
    expect(w.signal?.aborted).toBe(false);
    w.done('v');
    expect((await second).value).toBe('v');
    expect(cache.peek('g', 's')).toBe('v');
  });

  it('the last waiter leaving aborts the computation and drops the entry', async () => {
    const cache = new StateCache<string>({ capacity: 10 });
    const w = work<string>();
    const a = new AbortController();
    const b = new AbortController();
    const first = cache.get('g', 's', w.compute, a.signal).catch((e: unknown) => e);
    const second = cache.get('g', 's', w.compute, b.signal).catch((e: unknown) => e);
    await tick();
    a.abort();
    await tick();
    expect(w.signal?.aborted).toBe(false);
    b.abort();
    expect(aborted(await first)).toBe(true);
    expect(aborted(await second)).toBe(true);
    await tick();
    expect(w.signal?.aborted).toBe(true);
    // The cancelled run is gone: the next lookup starts a new computation, nobody joins the old.
    const w2 = work<string>();
    const next = cache.get('g', 's', w2.compute);
    await tick();
    expect(w2.starts).toBe(1);
    w2.done('fresh');
    expect((await next).value).toBe('fresh');
    expect(cache.stats().entries).toBe(1);
  });

  it('a waiter without a signal pins the computation', async () => {
    const cache = new StateCache<string>({ capacity: 10 });
    const w = work<string>();
    const a = new AbortController();
    const pinned = cache.get('g', 's', w.compute);
    const leaving = cache.get('g', 's', w.compute, a.signal).catch((e: unknown) => e);
    await tick();
    a.abort();
    expect(aborted(await leaving)).toBe(true);
    await tick();
    expect(w.signal?.aborted).toBe(false);
    w.done('v');
    expect((await pinned).value).toBe('v');
  });

  it('a lookup with a signal that already fired computes nothing', async () => {
    const cache = new StateCache<string>({ capacity: 10 });
    const w = work<string>();
    const controller = new AbortController();
    controller.abort();
    await expect(cache.get('g', 's', w.compute, controller.signal)).rejects.toSatisfy(aborted);
    expect(w.starts).toBe(0);
    expect(cache.stats()).toMatchObject({ misses: 0, joins: 0, entries: 0, pending: 0 });
  });

  it('a failure is shared by its waiters and cached for nobody', async () => {
    const cache = new StateCache<string>({ capacity: 10 });
    const w = work<string>();
    const all = [1, 2].map(() => cache.get('g', 's', w.compute).catch((e: unknown) => e));
    await tick();
    const error = new Error('git failed');
    w.fail(error);
    expect(await Promise.all(all)).toEqual([error, error]);
    expect(w.starts).toBe(1);
    expect(cache.stats()).toMatchObject({ entries: 0, pending: 0 });
    expect((await cache.get('g', 's', immediate('ok'))).value).toBe('ok');
  });

  it('a result the computation says not to store is shared but not kept', async () => {
    const cache = new StateCache<string>({ capacity: 10 });
    const w = work<string>(false);
    const all = [1, 2].map(() => cache.get('g', 's', w.compute));
    await tick();
    w.done('now');
    expect((await Promise.all(all)).map((r) => r.value)).toEqual(['now', 'now']);
    expect(cache.stats().entries).toBe(0);
    expect(cache.peek('g', 's')).toBeUndefined();
    expect(w.starts).toBe(1);
  });
});

describe('StateCache invalidation (#49)', () => {
  it('an invalidation during a lookup in flight never lets its result in', async () => {
    const cache = new StateCache<string>({ capacity: 10 });
    const w = work<string>();
    const waiting = cache.get('g', 's', w.compute);
    await tick();
    cache.invalidateGroup('g');
    w.done('stale');
    // Its waiter still gets the answer it waited for ...
    expect((await waiting).value).toBe('stale');
    // ... but the cache did not keep it.
    expect(cache.peek('g', 's')).toBeUndefined();
    expect(cache.stats().entries).toBe(0);
    expect((await cache.get('g', 's', immediate('fresh'))).value).toBe('fresh');
  });

  it('a lookup that starts after an invalidation does not join the invalidated run', async () => {
    const cache = new StateCache<string>({ capacity: 10 });
    const old = work<string>();
    const first = cache.get('g', 's', old.compute);
    await tick();
    cache.invalidatePrefix('g');
    const second = work<string>();
    const later = cache.get('g', 's', second.compute);
    await tick();
    expect(second.starts).toBe(1);
    second.done('new');
    old.done('old');
    expect((await later).value).toBe('new');
    expect((await first).value).toBe('old');
    expect(cache.peek('g', 's')).toBe('new');
  });

  it('an invalidated lookup finishing late does not prune the newer state stored after it (PR #104)', async () => {
    const cache = new StateCache<string>({ capacity: 10 });
    const a = work<string>();
    const first = cache.get('g', 'A', a.compute);
    await tick();
    cache.invalidateGroup('g');
    // The newer state is looked up and stored while A is still running ...
    expect((await cache.get('g', 'B', immediate('b'))).value).toBe('b');
    expect(cache.peek('g', 'B')).toBe('b');
    // ... and A finishing (not stored: it was invalidated) must not delete it.
    a.done('a');
    expect((await first).value).toBe('a');
    await tick();
    expect(cache.peek('g', 'B')).toBe('b');
    expect(cache.peek('g', 'A')).toBeUndefined();
    expect(await cache.get('g', 'B', immediate('again'))).toEqual({ value: 'b', hit: true });
  });

  it('a lookup that still owns its entry prunes the older states of its group', async () => {
    const cache = new StateCache<string>({ capacity: 10 });
    await cache.get('g', 'A', immediate('a'));
    await cache.get('g', 'B', immediate('b'));
    expect(cache.peek('g', 'A')).toBeUndefined();
    expect(cache.peek('g', 'B')).toBe('b');
  });

  it('invalidates a group, or every group under a prefix, and nothing else', async () => {
    const cache = new StateCache<string>({ capacity: 10 });
    await cache.get('w1\u0000working', 's', immediate('a'));
    await cache.get('w1\u0000staged', 's', immediate('b'));
    await cache.get('w2\u0000working', 's', immediate('c'));
    cache.invalidateGroup('w1\u0000working');
    expect(cache.peek('w1\u0000working', 's')).toBeUndefined();
    expect(cache.peek('w1\u0000staged', 's')).toBe('b');
    cache.invalidatePrefix('w1\u0000');
    expect(cache.peek('w1\u0000staged', 's')).toBeUndefined();
    expect(cache.peek('w2\u0000working', 's')).toBe('c');
    // A group that merely starts with the same characters is not the group.
    await cache.get('w', 's', immediate('d'));
    cache.invalidateGroup('w');
    expect(cache.peek('w2\u0000working', 's')).toBe('c');
  });
});

describe('StateCache bounds (#49)', () => {
  it('keeps at most `capacity` entries and drops the least recently used', async () => {
    const cache = new StateCache<number>({ capacity: 3 });
    for (const n of [1, 2, 3]) await cache.get(`g${n}`, 's', immediate(n));
    // A hit refreshes g1: g2 is the oldest now.
    expect((await cache.get('g1', 's', immediate(0))).hit).toBe(true);
    await cache.get('g4', 's', immediate(4));
    expect(cache.stats().entries).toBe(3);
    expect(cache.peek('g2', 's')).toBeUndefined();
    expect([cache.peek('g1', 's'), cache.peek('g3', 's'), cache.peek('g4', 's')]).toEqual([
      1, 3, 4,
    ]);
  });

  it('holds one completed entry per group: a stored new state replaces the old one', async () => {
    const cache = new StateCache<string>({ capacity: 10 });
    await cache.get('g', 's1', immediate('one'));
    await cache.get('h', 's1', immediate('other group'));
    await cache.get('g', 's2', immediate('two'));
    expect(cache.stats().entries).toBe(2);
    expect(cache.peek('g', 's1')).toBeUndefined();
    expect(cache.peek('g', 's2')).toBe('two');
    expect(cache.peek('h', 's1')).toBe('other group');
  });

  it('keeps the old state while the new one is in flight, or when it is not stored', async () => {
    const cache = new StateCache<string>({ capacity: 10 });
    await cache.get('g', 's1', immediate('one'));
    const w = work<string>();
    const pending = cache.get('g', 's2', w.compute);
    await tick();
    expect(cache.peek('g', 's1')).toBe('one');
    w.done('unstored', false);
    await pending;
    expect(cache.peek('g', 's1')).toBe('one');
    expect(cache.peek('g', 's2')).toBeUndefined();
  });

  it('a finishing lookup does not drop a sibling that is still in flight', async () => {
    const cache = new StateCache<string>({ capacity: 10 });
    const slow = work<string>();
    const fast = work<string>();
    const first = cache.get('g', 's1', slow.compute);
    const second = cache.get('g', 's2', fast.compute);
    await tick();
    fast.done('fast');
    await second;
    expect(cache.stats().pending).toBe(1);
    // A third lookup of the slow state still joins it.
    const third = cache.get('g', 's1', slow.compute);
    await tick();
    expect(slow.starts).toBe(1);
    slow.done('slow');
    expect((await Promise.all([first, third])).map((r) => r.value)).toEqual(['slow', 'slow']);
  });
});
