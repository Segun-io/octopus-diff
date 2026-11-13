import { TimerSlot, type Timers } from './timers.js';

/**
 * One worktree's coalescing window (#48, DECISIONS #448): the debounce of the watcher's refreshes,
 * on the pipeline's clock. The rules are the ones `WatcherService.markDirty` had inline:
 *
 * - a trigger (re)arms a trailing timer of `debounceMs`, capped so that a burst fires at most
 *   `maxWaitMs` after its first trigger (continuous events cannot postpone a refresh forever);
 * - the reason of a burst is its first trigger's, except that `git` wins over anything else;
 * - `leadingEdge`: a trigger on a quiet worktree (no timer armed, nothing fired within
 *   `debounceMs`) fires at once, synchronously inside `trigger`; the rest of the burst coalesces
 *   into one trailing fire;
 * - any fire (also a poll's, `noteFired`) counts as the last fire for the leading edge.
 *
 * Not `Stream.debounce`: that has no maxWait and no leading edge, and it emits from a fiber, while
 * the leading edge must fire inside the call (a focus refresh is started before the request that
 * focused the worktree goes on, so it is not started twice).
 */
export interface DirtyWindowOptions<R extends string> {
  debounceMs: number;
  maxWaitMs: number;
  leadingEdge: boolean;
  timers: Timers;
  /** The reason that wins over others within a burst (the watcher's `git`). */
  dominant: R;
  /** Fires the burst; called synchronously by `trigger` on a leading edge, else by the timer. */
  fire: (reason: R) => void;
}

export class DirtyWindow<R extends string> {
  readonly #o: DirtyWindowOptions<R>;
  readonly #slot: TimerSlot;
  #burstStart = 0;
  #reason: R | null = null;
  /** When this window last fired (any reason); `-Infinity` = never. */
  #lastFireAt = Number.NEGATIVE_INFINITY;

  constructor(options: DirtyWindowOptions<R>) {
    this.#o = options;
    this.#slot = new TimerSlot(options.timers);
  }

  /** A trailing fire is armed. */
  get armed(): boolean {
    return this.#slot.pending;
  }

  trigger(reason: R): void {
    const now = this.#o.timers.now();
    if (
      this.#o.leadingEdge &&
      !this.#slot.pending &&
      now - this.#lastFireAt >= this.#o.debounceMs
    ) {
      // Quiet worktree: fire now. Triggers in the next debounce window (the rest of the same
      // save or commit) start the normal trailing debounce below.
      this.#o.fire(reason);
      return;
    }
    if (!this.#slot.pending) {
      this.#burstStart = now;
      this.#reason = reason;
    } else if (reason === this.#o.dominant) {
      this.#reason = reason;
    }
    const wait = Math.max(
      0,
      Math.min(this.#o.debounceMs, this.#burstStart + this.#o.maxWaitMs - now),
    );
    this.#slot.set(wait, () => {
      const r = this.#reason ?? reason;
      this.#reason = null;
      this.#o.fire(r);
    });
  }

  /** Records a fire (the window's own, or another one such as a poll) at the current time. */
  noteFired(): void {
    this.#lastFireAt = this.#o.timers.now();
  }

  clear(): void {
    this.#slot.clear();
    this.#reason = null;
  }
}
