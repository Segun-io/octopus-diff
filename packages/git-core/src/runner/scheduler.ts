/**
 * The runner's scheduler (#47, replacing the hand-written `LaneScheduler` of #44): a partitioned
 * semaphore with two lanes, as an Effect.
 *
 * - **One global limit** (`limit` permits): the maximum number of git processes overall. Both lanes
 *   share it; no permit is reserved for either.
 * - **Partitions**: each waiter queues behind its key (`queueKey`, the repository), FIFO; within a
 *   lane the keys are served round-robin in the order they started waiting, so one busy repository
 *   cannot starve the others.
 * - **Lanes** (#44): a free permit goes to the `interactive` lane first; while `background` work
 *   waits it gets the next permit after `INTERACTIVE_BURST` interactive grants in a row, so it keeps
 *   at least one grant in `INTERACTIVE_BURST + 1` under any interactive load.
 * - **Interruption**: a fiber interrupted while it waits leaves its queue and never gets a permit
 *   (so its work never starts). A permit is released when the work ends, however it ends (success,
 *   failure, interruption), and only then: interrupting running work releases the permit once the
 *   work's own interruption has completed (for a git process: once it has exited).
 * - **Close**: every waiter fails with the close error, and so does every later `take`.
 *
 * Effect's `PartitionedSemaphore` has the partitions and the interruption-safe take/release shape
 * this follows, but no lanes (one pool cannot give one class of waiters priority with a starvation
 * bound) and it rotates partitions in hash order; this keeps the exact order of #44 (DECISIONS
 * #406). Grants are synchronous: no fiber is forked to hand out a permit, and a waiter granted while
 * it is suspended resumes at once.
 */
import type { GitPriority } from '@octopus-diff/contracts';
import * as Effect from 'effect/Effect';

/** Background jobs start after at most this many interactive starts in a row (#44). */
export const INTERACTIVE_BURST = 4;

/** A held permit. `release` is idempotent. */
export interface Permit {
  readonly release: () => void;
}

type WaiterState = 'queued' | 'granted' | 'cancelled' | 'failed';

interface Waiter {
  state: WaiterState;
  grant: () => void;
  fail: (error: unknown) => void;
}

/** Per-key FIFO queues served round-robin, so one busy repository cannot starve the others. */
class FairQueue<T> {
  private readonly queues = new Map<string, T[]>();
  private readonly ring: string[] = [];
  size = 0;

  push(key: string, item: T): void {
    let queue = this.queues.get(key);
    if (!queue) {
      queue = [];
      this.queues.set(key, queue);
      this.ring.push(key);
    }
    queue.push(item);
    this.size += 1;
  }

  shift(): T | undefined {
    while (this.ring.length > 0) {
      const key = this.ring.shift() as string;
      const queue = this.queues.get(key);
      const item = queue?.shift();
      if (!queue || item === undefined) {
        this.queues.delete(key);
        continue;
      }
      if (queue.length > 0) this.ring.push(key);
      else this.queues.delete(key);
      this.size -= 1;
      return item;
    }
    return undefined;
  }

  /** Removes a queued item; false when it is not queued (already served). */
  remove(key: string, item: T): boolean {
    const queue = this.queues.get(key);
    const index = queue ? queue.indexOf(item) : -1;
    if (!queue || index < 0) return false;
    queue.splice(index, 1);
    this.size -= 1;
    if (queue.length === 0) {
      this.queues.delete(key);
      const at = this.ring.indexOf(key);
      if (at >= 0) this.ring.splice(at, 1);
    }
    return true;
  }

  drain(): T[] {
    const items = [...this.queues.values()].flat();
    this.queues.clear();
    this.ring.length = 0;
    this.size = 0;
    return items;
  }
}

/** See the module comment. `E` is the error waiters fail with once the semaphore is closed. */
export class LaneSemaphore<E = never> {
  readonly limit: number;
  private held = 0;
  private interactiveRun = 0;
  private pumping = false;
  private closed: { error: E } | null = null;
  private readonly lanes: Record<GitPriority, FairQueue<Waiter>> = {
    interactive: new FairQueue(),
    background: new FairQueue(),
  };

  constructor(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  /** Permits held right now. */
  get active(): number {
    return this.held;
  }

  /** Waiters queued in `lane` (both lanes when absent). */
  queued(lane?: GitPriority): number {
    if (lane) return this.lanes[lane].size;
    return this.lanes.interactive.size + this.lanes.background.size;
  }

  /**
   * Waits for a permit in `lane`, behind `key`'s earlier waiters. Interrupted while it waits, it
   * leaves the queue (no permit is taken). The caller must release the permit it gets: use
   * `withPermit` unless the permit has to outlive the effect that took it.
   */
  take(key: string, lane: GitPriority): Effect.Effect<Permit, E> {
    return Effect.callback<Permit, E>((resume) => {
      if (this.closed) {
        resume(Effect.fail(this.closed.error));
        return;
      }
      let released = false;
      const permit: Permit = {
        release: () => {
          if (released) return;
          released = true;
          this.held -= 1;
          this.pump();
        },
      };
      const waiter: Waiter = {
        state: 'queued',
        grant: () => resume(Effect.succeed(permit)),
        fail: (error) => resume(Effect.fail(error as E)),
      };
      this.lanes[lane].push(key, waiter);
      this.pump();
      if (waiter.state !== 'queued') return;
      // Interrupted while suspended. A grant that raced the interruption (the fiber will never see
      // its permit) gives the permit back.
      return Effect.sync(() => {
        if (waiter.state === 'queued') {
          waiter.state = 'cancelled';
          this.lanes[lane].remove(key, waiter);
        } else if (waiter.state === 'granted') {
          permit.release();
        }
      });
    });
  }

  /**
   * Runs `effect` with a permit of `lane`/`key`: it waits (interruptibly) for the permit, runs
   * `effect` (interruptibly), and releases the permit once `effect` has ended, however it ended.
   * Interrupted before the permit was granted, `effect` never runs.
   */
  withPermit<A, E2, R>(
    key: string,
    lane: GitPriority,
    effect: Effect.Effect<A, E2, R>,
  ): Effect.Effect<A, E | E2, R> {
    return Effect.uninterruptibleMask((restore) =>
      Effect.flatMap(restore(this.take(key, lane)), (permit) =>
        Effect.ensuring(
          restore(effect),
          Effect.sync(() => permit.release()),
        ),
      ),
    );
  }

  /** Fails every waiter with `error`, and every later `take`. Held permits stay held. */
  close(error: E): void {
    if (this.closed) return;
    this.closed = { error };
    for (const lane of Object.values(this.lanes)) {
      for (const waiter of lane.drain()) {
        waiter.state = 'failed';
        waiter.fail(error);
      }
    }
  }

  private next(): Waiter | undefined {
    const { interactive, background } = this.lanes;
    if (
      interactive.size > 0 &&
      (background.size === 0 || this.interactiveRun < INTERACTIVE_BURST)
    ) {
      this.interactiveRun += 1;
      return interactive.shift();
    }
    this.interactiveRun = 0;
    return background.shift() ?? interactive.shift();
  }

  /**
   * Grants free permits. A grant may resume a fiber synchronously, which may release (or take)
   * again: the loop that is running sees that, so grants never recurse.
   */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.held < this.limit && !this.closed) {
        const waiter = this.next();
        if (!waiter) return;
        this.held += 1;
        waiter.state = 'granted';
        waiter.grant();
      }
    } finally {
      this.pumping = false;
    }
  }
}
