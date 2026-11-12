import { GitCoreError } from '@octopus-diff/contracts';

/** The rejection of a request that went away (the client aborted it, #44). */
export function abortedError(): GitCoreError {
  return new GitCoreError('aborted', 'the request was cancelled');
}

/** `work`, or a rejection with `aborted` as soon as `signal` fires (the work itself goes on). */
export function raceSignal<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => {});
    return Promise.reject(abortedError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      work.catch(() => {});
      reject(abortedError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * One computation several requests wait on (#44). Each waiter joins with its own signal (or none):
 * a waiter whose signal fires stops waiting at once (rejects with `aborted`) while the others keep
 * waiting; only when the last waiter has left is the computation's own signal aborted (git-core
 * then stops its processes) and `onCancel` called, so the owner drops the entry before anyone else
 * can join a run that is being cancelled. A waiter without a signal pins the computation (it
 * always runs to the end). A computation that is never cancelled settles as it would without
 * this class, so a cache filled by it is filled exactly as before.
 */
export class SharedFlight<T> {
  readonly #controller = new AbortController();
  readonly #promise: Promise<T>;
  readonly #onCancel: (() => void) | undefined;
  #waiting = 0;
  #pinned = false;
  #done = false;
  /** Settles (never rejects) when the computation does; waiting on it pins nothing. */
  readonly settled: Promise<void>;

  constructor(compute: (signal: AbortSignal) => Promise<T>, onCancel?: () => void) {
    this.#onCancel = onCancel;
    this.#promise = compute(this.#controller.signal);
    const done = (): void => {
      this.#done = true;
    };
    this.settled = this.#promise.then(done, done);
  }

  get cancelled(): boolean {
    return this.#controller.signal.aborted;
  }

  /** Waiters still interested (tests). */
  get waiting(): number {
    return this.#waiting;
  }

  join(signal?: AbortSignal): Promise<T> {
    if (!signal) {
      this.#pinned = true;
      return this.#promise;
    }
    if (signal.aborted) {
      this.#maybeCancel();
      return Promise.reject(abortedError());
    }
    this.#waiting += 1;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        this.#waiting -= 1;
        reject(abortedError());
        this.#maybeCancel();
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.#promise.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });
  }

  #maybeCancel(): void {
    if (this.#waiting > 0 || this.#pinned || this.#done || this.cancelled) return;
    this.#promise.catch(() => {});
    this.#onCancel?.();
    this.#controller.abort();
  }
}

/** Single-flight by key over `SharedFlight`: an entry lives while its run is wanted and running. */
export class FlightMap<K, T> {
  readonly #runs = new Map<K, SharedFlight<T>>();

  get size(): number {
    return this.#runs.size;
  }

  /** Joins the run for `key`, starting `compute` when there is none. */
  run(
    key: K,
    signal: AbortSignal | undefined,
    compute: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    let flight = this.#runs.get(key);
    if (!flight || flight.cancelled) {
      const created: SharedFlight<T> = new SharedFlight(compute, () => {
        if (this.#runs.get(key) === created) this.#runs.delete(key);
      });
      flight = created;
      this.#runs.set(key, created);
      void created.settled.then(() => {
        if (this.#runs.get(key) === created) this.#runs.delete(key);
      });
    }
    return flight.join(signal);
  }
}
