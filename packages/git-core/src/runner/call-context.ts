import { AsyncLocalStorage } from 'node:async_hooks';
import { type CallOptions, GitCoreError, type GitPriority } from '@octopus-diff/contracts';

/**
 * What the `GitCore` call that is running asked for (#44): its lane and its abort signal. Set
 * once per call (`withCall` in `createGitCore`) and read by the runner for every git process the
 * call starts, so the many internal functions between the two need not pass them along.
 */
export interface CallContext {
  lane: GitPriority;
  signal?: AbortSignal;
}

const storage = new AsyncLocalStorage<CallContext>();

/** The running call's context, if any. */
export function currentCall(): CallContext | undefined {
  return storage.getStore();
}

/** The context for `options` (default lane `background`; anything else than `interactive` is). */
export function callContext(options: CallOptions | undefined): CallContext {
  const lane: GitPriority = options?.priority === 'interactive' ? 'interactive' : 'background';
  return options?.signal ? { lane, signal: options.signal } : { lane };
}

/** Runs `fn` as (part of) the call described by `call`. */
export function withCall<T>(call: CallContext, fn: () => T): T {
  return storage.run(call, fn);
}

/**
 * Runs work that other calls may join (a single-flight read, a memoized fact) without the
 * current call's signal: one caller leaving must not cancel what the others still wait for. The
 * lane is kept: the call that started the work decides how urgent it is.
 */
export function shared<T>(fn: () => T): T {
  const call = storage.getStore();
  return storage.run({ lane: call?.lane ?? 'background' }, fn);
}

export function abortedError(details: Record<string, unknown> = {}): GitCoreError {
  return new GitCoreError('aborted', 'the git-core call was cancelled', details);
}

/**
 * `work`, or a rejection with `aborted` as soon as `signal` fires (whichever comes first). The
 * work itself is cancelled by the runner (it sees the same signal); its own late rejection is
 * swallowed here.
 */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
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
 * Work several calls may wait on (a single-flight read), cancelled only when every caller that
 * waits for it has aborted (#44). `join` is called by each caller (the one that started it too):
 * a caller whose call has no signal pins the work (it always completes); a caller whose signal
 * fires stops waiting at once (rejects with `aborted`) and, if it was the last one, the work's
 * own signal fires (its git processes stop, queued ones never start) and `onCancel` runs, so the
 * owner can drop the entry and a later caller starts afresh instead of joining a cancelled run.
 * The work runs in the lane of the call that started it.
 */
export class Flight<T> {
  readonly #controller = new AbortController();
  readonly #promise: Promise<T>;
  readonly #onCancel: (() => void) | undefined;
  #waiting = 0;
  #pinned = false;
  #done = false;
  /** Settles (never rejects) when the work does; waiting on it pins nothing. */
  readonly settled: Promise<void>;

  constructor(compute: () => Promise<T>, onCancel?: () => void) {
    this.#onCancel = onCancel;
    const lane = storage.getStore()?.lane ?? 'background';
    this.#promise = storage.run({ lane, signal: this.#controller.signal }, compute);
    const done = (): void => {
      this.#done = true;
    };
    this.settled = this.#promise.then(done, done);
  }

  /** True once every waiter left and the work was told to stop. */
  get cancelled(): boolean {
    return this.#controller.signal.aborted;
  }

  /** Waits for the work as the running call (its signal, if any, may withdraw this waiter). */
  join(): Promise<T> {
    const signal = storage.getStore()?.signal;
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
    this.#controller.abort();
    this.#onCancel?.();
  }
}
