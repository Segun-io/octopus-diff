/**
 * The daemon's state-keyed caches on Effect's `Cache` (#49, DECISIONS #453-#458): the changed-file
 * lists of `DaemonCore` (#27, #30) and its review ranges. What they add to a plain `Map`:
 *
 * - **Lookup dedup.** Concurrent `get`s of one key share one computation (`Cache.get`).
 * - **Cancellation by reference count.** Every waiter holds the lookup fiber; when the last one
 *   leaves (its `AbortSignal` fired) the fiber is interrupted, which aborts the computation's own
 *   signal (git-core then stops its processes) and drops the entry before anyone else can join it.
 *   A waiter without a signal is never interrupted, so it pins the computation (the old
 *   `SharedFlight`, DECISIONS #440-#444).
 * - **Nothing stale gets in.** `invalidate*` removes entries from the map, pending ones included:
 *   a lookup that finishes afterwards is not put back (`Cache` only re-inserts through `get`).
 *
 * A key is `group` + `state`: the group is what an entry is *of* (a worktree and a scope), the
 * state is what it is valid for (`stateHash`, base commit, attributes). A cache holds one
 * completed entry per group, as the `Map` it replaces did: when a lookup of a group completes and
 * is stored, the group's other completed entries are dropped, so memory stays bounded by the
 * number of groups, and `capacity` bounds the groups (least recently used first).
 *
 * `compute` says whether its result may be stored (`store`): a list git-core made of another state
 * than the one asked for is returned to its waiters and cached for nobody. A failed computation
 * is shared by its waiters and never cached (`timeToLive` zero).
 */
import { runAtBoundary } from '@octopus-diff/git-core';
import * as Cache from 'effect/Cache';
import * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as MutableHashMap from 'effect/MutableHashMap';
import * as Option from 'effect/Option';
import { abortedError, raceSignal } from './flight.js';

/** What a computation returns: the value, and whether the cache may keep it. */
export interface Computed<V> {
  value: V;
  store: boolean;
}

/** What `get` resolves to: the value, and whether a completed entry answered (no lookup ran). */
export interface Lookup<V> {
  value: V;
  hit: boolean;
}

export interface CacheStats {
  /** Lookups answered by a completed entry. */
  hits: number;
  /** Lookups that started a computation. */
  misses: number;
  /** Lookups that joined a computation already in flight. */
  joins: number;
  /** Completed entries held now. */
  entries: number;
  /** Computations in flight now. */
  pending: number;
  capacity: number;
}

interface Params {
  readonly group: string;
  /** Taken (and cleared) by the lookup: a finished fiber keeps its context, not the closure. */
  compute: ((signal: AbortSignal) => Promise<Computed<unknown>>) | null;
}

/** The per-call part of a lookup: the first waiter's computation, handed over as a service. */
class LookupParams extends Context.Service<LookupParams, Params>()(
  '@octopus-diff/daemon/StateCache/LookupParams',
) {}

const SEP = '\u0000';
const settled = (): void => {};

/** `group` + `state` as the cache key; a prefix of `group` + SEP selects a group. */
export function cacheKey(group: string, state: string): string {
  return `${group}${SEP}${state}`;
}

export class StateCache<V> {
  readonly #cache: Cache.Cache<string, Computed<V>, unknown, LookupParams>;
  readonly #capacity: number;
  #hits = 0;
  #misses = 0;
  #joins = 0;

  constructor(options: { capacity: number }) {
    this.#capacity = options.capacity;
    this.#cache = Effect.runSync(
      Cache.makeWith(
        (key: string): Effect.Effect<Computed<V>, unknown, LookupParams> =>
          Effect.flatMap(LookupParams, (params) =>
            Effect.tap(this.#run(params), (done) =>
              Effect.sync(() => {
                if (done.store) this.#dropOtherStates(params.group, key);
              }),
            ),
          ),
        {
          capacity: options.capacity,
          // Failures and results the caller says not to keep live as long as their waiters.
          timeToLive: (exit) => (Exit.isSuccess(exit) && exit.value.store ? Duration.infinity : 0),
          requireServicesAt: 'lookup',
        },
      ),
    );
  }

  /**
   * The computation as an Effect: its `AbortSignal` is the fiber's (aborted when the last waiter
   * leaves), and the interruption completes only once the computation has settled, so a cancelled
   * git run has released its process slot by then.
   */
  #run(params: Params): Effect.Effect<Computed<V>, unknown> {
    return Effect.callback<Computed<V>, unknown>((resume, signal) => {
      const compute = params.compute;
      params.compute = null;
      const run = (
        compute ? compute(signal) : Promise.reject(new Error('no computation'))
      ) as Promise<Computed<V>>;
      run.then(
        (value) => resume(Effect.succeed(value)),
        (error: unknown) => resume(Effect.fail(error)),
      );
      return Effect.promise(() => run.then(settled, settled));
    });
  }

  /** The group's other completed entries go: one entry per group (called once `key` is stored). */
  #dropOtherStates(group: string, key: string): void {
    const prefix = `${group}${SEP}`;
    for (const [other, entry] of [...this.#cache.map]) {
      if (other === key || !other.startsWith(prefix) || entry.fiber.pollUnsafe() === undefined) {
        continue;
      }
      MutableHashMap.remove(this.#cache.map, other);
    }
  }

  /** The completed, stored value of (`group`, `state`); no lookup, no recency touch. */
  peek(group: string, state: string): V | undefined {
    const entry = MutableHashMap.get(this.#cache.map, cacheKey(group, state));
    if (Option.isNone(entry)) return undefined;
    const exit = entry.value.fiber.pollUnsafe();
    return exit !== undefined && Exit.isSuccess(exit) ? exit.value.value : undefined;
  }

  /**
   * The value for (`group`, `state`): the completed entry, the computation in flight, or a new
   * `compute` (the first waiter's; later waiters' `compute` is not called). `signal` is this
   * waiter's: when it fires this waiter rejects with `aborted` at once, and the computation is
   * cancelled if no other waiter is left.
   */
  get(
    group: string,
    state: string,
    compute: (signal: AbortSignal) => Promise<Computed<V>>,
    signal?: AbortSignal,
  ): Promise<Lookup<V>> {
    const key = cacheKey(group, state);
    const lookup = (hit: boolean): Effect.Effect<Lookup<V>, unknown> =>
      Effect.map(
        Cache.get(this.#cache, key).pipe(Effect.provideService(LookupParams, { group, compute })),
        (done) => ({ value: done.value, hit }),
      );
    // A completed entry is answered without a fiber (and moves to the end of the LRU order).
    const existing = MutableHashMap.get(this.#cache.map, key);
    const exit = Option.isSome(existing) ? existing.value.fiber.pollUnsafe() : undefined;
    if (exit !== undefined && Exit.isSuccess(exit)) {
      this.#hits += 1;
      return Promise.resolve(Effect.runSync(lookup(true)));
    }
    if (signal?.aborted) return Promise.reject(abortedError());
    if (Option.isSome(existing)) this.#joins += 1;
    else this.#misses += 1;
    return raceSignal(runAtBoundary(null, lookup(false), { signal }), signal);
  }

  /** Drops every entry of `group` (pending ones too: their results are never stored). */
  invalidateGroup(group: string): void {
    this.#invalidateWhere((key) => key.startsWith(`${group}${SEP}`));
  }

  /** Drops every entry whose group starts with `prefix`. */
  invalidatePrefix(prefix: string): void {
    this.#invalidateWhere((key) => key.startsWith(prefix));
  }

  #invalidateWhere(match: (key: string) => boolean): void {
    for (const key of [...this.#cache.map].map(([k]) => k)) {
      if (match(key)) MutableHashMap.remove(this.#cache.map, key);
    }
  }

  stats(): CacheStats {
    let entries = 0;
    let pending = 0;
    for (const [, entry] of this.#cache.map) {
      if (entry.fiber.pollUnsafe() === undefined) pending += 1;
      else entries += 1;
    }
    return {
      hits: this.#hits,
      misses: this.#misses,
      joins: this.#joins,
      entries,
      pending,
      capacity: this.#capacity,
    };
  }
}
