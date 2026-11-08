/**
 * Single-flight with one queued re-run: while a run is in flight, any number of callers share
 * one follow-up run that starts after it, so a caller never observes a result computed before
 * its request (no stampedes, no lost updates).
 */
export class Coalescer {
  #current: Promise<void> | null = null;
  #queued: Promise<void> | null = null;
  readonly #fn: () => Promise<void>;

  constructor(fn: () => Promise<void>) {
    this.#fn = fn;
  }

  get running(): boolean {
    return this.#current !== null;
  }

  /** The in-flight run (if any), without scheduling a new one. */
  get current(): Promise<void> | null {
    return this.#queued ?? this.#current;
  }

  run(): Promise<void> {
    if (!this.#current) {
      const p = this.#fn()
        .catch(() => {})
        .finally(() => {
          if (this.#current === p) this.#current = null;
        });
      this.#current = p;
      return p;
    }
    if (!this.#queued) {
      this.#queued = this.#current.then(() => {
        this.#queued = null;
        return this.run();
      });
    }
    return this.#queued;
  }
}

/** Resolves when `promise` settles or after `ms`, whichever comes first. */
export function settleWithin(promise: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}
