import * as Effect from 'effect/Effect';
import type * as Fiber from 'effect/Fiber';
import { Timers } from './timers.js';

/** The fibers of coalescers and `settleWithin` that no owner closes (they end on their own). */
const shared = new Timers();

interface Waiters {
  promise: Promise<void>;
  resolve: () => void;
}

function waiters(): Waiters {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Single-flight with one queued re-run: while a run is in flight, any number of callers share
 * one follow-up run that starts after it, so a caller never observes a result computed before
 * its request (no stampedes, no lost updates).
 *
 * On Effect (#48, DECISIONS #447): one consumer fiber runs `fn` while requests keep coming, with a
 * one-slot request buffer (a sliding buffer of size 1: any number of requests during a run are one
 * follow-up). The first run starts synchronously inside `run()`, as before. A follow-up starts in
 * the same fiber as soon as the run before it ends (the Promise version waited a few microtasks,
 * in which a request could start a run of its own and push the queued callers to a third one).
 * `run()` never rejects. Interrupting the fiber (closing its `Timers`) settles every waiting
 * caller and starts nothing more; a run already in flight is a Promise and runs to its end.
 */
export class Coalescer {
  readonly #fn: () => Promise<void>;
  readonly #timers: Timers;
  #fiber: Fiber.Fiber<void> | null = null;
  #current: Waiters | null = null;
  #queued: Waiters | null = null;

  constructor(fn: () => Promise<void>, options: { timers?: Timers } = {}) {
    this.#fn = fn;
    this.#timers = options.timers ?? shared;
  }

  get running(): boolean {
    return this.#fiber !== null;
  }

  /** The in-flight run (if any), without scheduling a new one. */
  get current(): Promise<void> | null {
    return (this.#queued ?? this.#current)?.promise ?? null;
  }

  run(): Promise<void> {
    if (this.#fiber && this.#current) {
      this.#queued ??= waiters();
      return this.#queued.promise;
    }
    if (this.#timers.closed) return Promise.resolve();
    const first = waiters();
    this.#current = first;
    const loop = Effect.gen({ self: this }, function* () {
      for (;;) {
        yield* Effect.ignore(Effect.tryPromise(() => this.#fn()));
        const done = this.#current;
        const next = this.#queued;
        this.#queued = null;
        this.#current = next;
        done?.resolve();
        if (!next) return;
      }
    });
    const fiber = this.#timers.fork(
      Effect.ensuring(
        loop,
        Effect.sync(() => {
          if (this.#fiber === fiber) this.#fiber = null;
          // Interrupted (the owner closed): nobody waits forever.
          this.#current?.resolve();
          this.#queued?.resolve();
          this.#current = null;
          this.#queued = null;
        }),
      ),
    );
    if (fiber.pollUnsafe() === undefined) this.#fiber = fiber;
    return first.promise;
  }
}

/** Resolves when `promise` settles or after `ms`, whichever comes first. */
export function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const cancel = shared.after(ms, resolve);
    promise.then(
      () => {
        cancel();
        resolve();
      },
      () => {
        cancel();
        resolve();
      },
    );
  });
}
