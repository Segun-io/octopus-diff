/**
 * The runner's scheduler (#47): `LaneSemaphore`, the Effect partitioned semaphore with the two
 * lanes of #44. No git here: jobs are fibers that record when they start and wait until the test
 * finishes them, so the test decides exactly when each permit is released.
 *
 * The property test drives random sequences of enqueue / abort / complete / exit across
 * repositories (`queueKey`s) and lanes and checks, after every step:
 * - never more than `limit` jobs hold a permit, and a job that was aborted while running keeps its
 *   permit until its process has "exited" (slots are released only after exit);
 * - the start order is exactly the one the hand-written `LaneScheduler` of #44 produced (kept
 *   below as the reference model);
 * - per-`queueKey` FIFO within a lane;
 * - the starvation bound: while background work waits, at most `INTERACTIVE_BURST` interactive
 *   starts in a row, so a lone waiting background job starts within `INTERACTIVE_BURST + 1`;
 * - an aborted queued job never starts;
 * - no idle permit while work waits (no deadlock), and when everything has settled no permit is
 *   held and nothing is queued (slots are conserved).
 *
 * A failure prints the seed and the steps: rerun with SCHED_SEED=<seed>.
 */
import type { GitPriority } from '@octopus-diff/contracts';
import * as Context from 'effect/Context';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import type * as Fiber from 'effect/Fiber';
import * as Scheduler from 'effect/Scheduler';
import { describe, expect, it } from 'vitest';
import { INTERACTIVE_BURST, LaneSemaphore } from '../src/runner/scheduler.js';
import { prng } from './helpers/fuzz-ops.js';

/** Lets every fiber that was resumed run until it suspends again (no timers involved). */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise((resolve) => setImmediate(resolve));
}

type JobState = 'queued' | 'running' | 'terminating' | 'done' | 'cancelled';

interface Job {
  id: number;
  key: string;
  lane: GitPriority;
  state: JobState;
  fiber?: Fiber.Fiber<void, string>;
  /** Ends a running job (its process exited by itself). */
  finish?: () => void;
  /** Ends an aborted running job (its process exited after the signal). */
  exit?: () => void;
}

/** Real jobs on a `LaneSemaphore`. */
class RealDriver {
  readonly sem: LaneSemaphore<string>;
  readonly jobs: Job[] = [];
  readonly starts: number[] = [];
  /** For each start: the jobs that were still waiting at that moment. */
  readonly waitingAtStart = new Map<number, Job[]>();
  /** Jobs inside their work (running or terminating), counted by the work itself. */
  inside = 0;
  maxInside = 0;
  /**
   * Interactive starts while background work waited, since the later of the last background start
   * and the moment the background lane stopped being empty.
   */
  streak = 0;
  maxStreak = 0;

  constructor(limit: number) {
    this.sem = new LaneSemaphore<string>(limit);
  }

  enqueue(key: string, lane: GitPriority): Job {
    const job: Job = { id: this.jobs.length, key, lane, state: 'queued' };
    this.jobs.push(job);
    if (lane === 'background' && this.sem.queued('background') === 0) this.streak = 0;
    const work = Effect.callback<void>((resume) => {
      job.state = 'running';
      this.starts.push(job.id);
      this.waitingAtStart.set(
        job.id,
        this.jobs.filter((j) => j.state === 'queued'),
      );
      if (lane === 'background') this.streak = 0;
      else if (this.sem.queued('background') > 0) {
        this.streak += 1;
        this.maxStreak = Math.max(this.maxStreak, this.streak);
      }
      this.inside += 1;
      this.maxInside = Math.max(this.maxInside, this.inside);
      job.finish = () => resume(Effect.void);
      // Interrupted while running: SIGTERM sent; the process exits when the test says so.
      return Effect.callback<void>((exited) => {
        job.state = 'terminating';
        job.exit = () => exited(Effect.void);
      });
    });
    job.fiber = Effect.runFork(
      this.sem.withPermit(
        key,
        lane,
        Effect.ensuring(
          work,
          Effect.sync(() => {
            this.inside -= 1;
            job.state = 'done';
          }),
        ),
      ),
    );
    job.fiber.addObserver(() => {
      if (job.state === 'queued') job.state = 'cancelled';
    });
    return job;
  }

  abort(job: Job): void {
    job.fiber?.interruptUnsafe();
  }
}

/** The hand-written scheduler of #44 (`LaneScheduler` + `FairQueue`), synchronous, as a model. */
class ModelScheduler {
  private active = 0;
  private interactiveRun = 0;
  private readonly lanes: Record<GitPriority, { ring: string[]; queues: Map<string, number[]> }> = {
    interactive: { ring: [], queues: new Map() },
    background: { ring: [], queues: new Map() },
  };
  readonly starts: number[] = [];
  readonly state = new Map<number, JobState>();
  private readonly where = new Map<number, { key: string; lane: GitPriority }>();

  constructor(private readonly limit: number) {}

  private size(lane: GitPriority): number {
    let n = 0;
    for (const q of this.lanes[lane].queues.values()) n += q.length;
    return n;
  }

  private shift(lane: GitPriority): number | undefined {
    const { ring, queues } = this.lanes[lane];
    while (ring.length > 0) {
      const key = ring.shift() as string;
      const queue = queues.get(key);
      const id = queue?.shift();
      if (!queue || id === undefined) {
        queues.delete(key);
        continue;
      }
      if (queue.length > 0) ring.push(key);
      else queues.delete(key);
      return id;
    }
    return undefined;
  }

  private next(): number | undefined {
    const interactive = this.size('interactive');
    const background = this.size('background');
    if (interactive > 0 && (background === 0 || this.interactiveRun < INTERACTIVE_BURST)) {
      this.interactiveRun += 1;
      return this.shift('interactive');
    }
    this.interactiveRun = 0;
    return this.shift('background') ?? this.shift('interactive');
  }

  private pump(): void {
    while (this.active < this.limit) {
      const id = this.next();
      if (id === undefined) return;
      this.active += 1;
      this.state.set(id, 'running');
      this.starts.push(id);
    }
  }

  enqueue(id: number, key: string, lane: GitPriority): void {
    this.where.set(id, { key, lane });
    this.state.set(id, 'queued');
    const { ring, queues } = this.lanes[lane];
    let queue = queues.get(key);
    if (!queue) {
      queue = [];
      queues.set(key, queue);
      ring.push(key);
    }
    queue.push(id);
    this.pump();
  }

  abort(id: number): void {
    const state = this.state.get(id);
    if (state === 'queued') {
      const { key, lane } = this.where.get(id) as { key: string; lane: GitPriority };
      const { ring, queues } = this.lanes[lane];
      const queue = queues.get(key) as number[];
      queue.splice(queue.indexOf(id), 1);
      if (queue.length === 0) {
        queues.delete(key);
        ring.splice(ring.indexOf(key), 1);
      }
      this.state.set(id, 'cancelled');
    } else if (state === 'running') {
      this.state.set(id, 'terminating');
    }
  }

  /** The job's process is gone (finished, or exited after an abort): its slot is free. */
  release(id: number): void {
    this.state.set(id, 'done');
    this.active -= 1;
    this.pump();
  }
}

const KEYS = ['repo-a', 'repo-b', 'repo-c', 'repo-d'];

interface RunOptions {
  seed: number;
  steps: number;
  limit: number;
  /** Settle after every step and compare with the model (else: steps run in bursts). */
  lockstep: boolean;
}

async function runSequence({ seed, steps, limit, lockstep }: RunOptions): Promise<void> {
  const rand = prng(seed);
  const real = new RealDriver(limit);
  const model = new ModelScheduler(limit);
  const log: string[] = [];
  const fail = (message: string): never => {
    throw new Error(
      `seed ${seed} (limit ${limit}, ${lockstep ? 'lockstep' : 'bursts'}): ${message}\n${log.join('\n')}`,
    );
  };
  let checkedStarts = 0;
  const startedEver = new Set<number>();
  /** For each background job: interactive starts while it was the only background waiter. */
  const loneWait = new Map<number, number>();

  const check = (): void => {
    // Starts since the last check, in order, judged against the queue as it was before each.
    for (; checkedStarts < real.starts.length; checkedStarts++) {
      const id = real.starts[checkedStarts] as number;
      const job = real.jobs[id] as Job;
      startedEver.add(id);
      const waitingBefore = real.waitingAtStart.get(id) ?? [];
      // FIFO per key within a lane: no earlier job of the same key and lane still waits.
      if (waitingBefore.some((j) => j.key === job.key && j.lane === job.lane && j.id < id)) {
        fail(`job ${id} (${job.key}/${job.lane}) started ahead of an earlier job of its key`);
      }
      const bgWaiting = waitingBefore.filter((j) => j.lane === 'background');
      if (job.lane === 'interactive') {
        if (bgWaiting.length === 1) {
          const lone = bgWaiting[0] as Job;
          loneWait.set(lone.id, (loneWait.get(lone.id) ?? 0) + 1);
        }
      } else {
        if ((loneWait.get(id) ?? 0) > INTERACTIVE_BURST) {
          fail(`background job ${id} waited ${loneWait.get(id)} interactive starts alone`);
        }
      }
    }
    const holding = real.jobs.filter((j) => j.state === 'running' || j.state === 'terminating');
    if (holding.length > limit) fail(`${holding.length} jobs hold a permit (limit ${limit})`);
    if (real.sem.active !== holding.length) {
      fail(`${real.sem.active} permits held, ${holding.length} jobs running or terminating`);
    }
    if (real.maxStreak > INTERACTIVE_BURST) {
      fail(`${real.maxStreak} interactive starts in a row while background work waited`);
    }
    if (real.maxInside > limit) fail(`${real.maxInside} jobs ran at once`);
    for (const j of real.jobs) {
      if (j.state === 'cancelled' && startedEver.has(j.id)) fail(`aborted queued job ${j.id} ran`);
    }
    const queued = real.jobs.filter((j) => j.state === 'queued').length;
    if (real.sem.queued() !== queued) fail(`${real.sem.queued()} queued, expected ${queued}`);
    if (queued > 0 && real.sem.active < limit) fail(`a permit is idle while ${queued} jobs wait`);
    if (lockstep) {
      if (real.starts.join(',') !== model.starts.join(',')) {
        fail(`start order ${real.starts.join(',')}\n     model ${model.starts.join(',')}`);
      }
      for (const j of real.jobs) {
        if (model.state.get(j.id) !== j.state) {
          fail(`job ${j.id} is ${j.state}, the model says ${model.state.get(j.id)}`);
        }
      }
    }
  };

  for (let step = 0; step < steps; step++) {
    const r = rand();
    const live = real.jobs.filter((j) => j.state !== 'done' && j.state !== 'cancelled');
    const running = live.filter((j) => j.state === 'running');
    const terminating = live.filter((j) => j.state === 'terminating');
    if (r < 0.45 || live.length === 0) {
      const key = KEYS[Math.floor(rand() * KEYS.length)] as string;
      const lane: GitPriority = rand() < 0.5 ? 'interactive' : 'background';
      const job = real.enqueue(key, lane);
      model.enqueue(job.id, key, lane);
      log.push(`enqueue ${job.id} ${key} ${lane}`);
    } else if (r < 0.6) {
      const job = live[Math.floor(rand() * live.length)] as Job;
      if (job.state === 'terminating') continue;
      log.push(`abort ${job.id} (${job.state})`);
      model.abort(job.id);
      real.abort(job);
    } else if (r < 0.85 && running.length > 0) {
      const job = running[Math.floor(rand() * running.length)] as Job;
      log.push(`complete ${job.id}`);
      model.release(job.id);
      job.finish?.();
    } else if (terminating.length > 0) {
      const job = terminating[Math.floor(rand() * terminating.length)] as Job;
      log.push(`exit ${job.id}`);
      model.release(job.id);
      job.exit?.();
    } else {
      continue;
    }
    if (lockstep || rand() < 0.3) {
      await settle();
      check();
    }
  }
  await settle();
  check();
  // Drain: finish everything running, let every aborted process exit, until all settle.
  for (let round = 0; round < 10_000; round++) {
    const live = real.jobs.filter((j) => j.state === 'running' || j.state === 'terminating');
    if (live.length === 0) break;
    for (const job of live) {
      if (job.state === 'running') {
        model.release(job.id);
        job.finish?.();
      } else {
        model.release(job.id);
        job.exit?.();
      }
    }
    await settle();
    check();
  }
  await settle();
  check();
  for (const job of real.jobs) {
    if (job.state !== 'done' && job.state !== 'cancelled') fail(`job ${job.id} is ${job.state}`);
    if (!job.fiber?.pollUnsafe()) fail(`job ${job.id}'s fiber has not ended (deadlock)`);
  }
  expect(real.sem.active).toBe(0);
  expect(real.sem.queued()).toBe(0);
}

const SEEDS = process.env.SCHED_SEED
  ? [Number(process.env.SCHED_SEED)]
  : Array.from({ length: 24 }, (_, i) => 0x5c4ed00 + i);

describe('LaneSemaphore: random sequences of enqueue, abort, complete and exit', () => {
  for (const limit of [1, 2, 4]) {
    it(`matches the #44 scheduler step by step, limit ${limit}`, async () => {
      for (const seed of SEEDS) await runSequence({ seed, steps: 200, limit, lockstep: true });
    });
    it(`keeps its invariants when steps come in bursts, limit ${limit}`, async () => {
      for (const seed of SEEDS) await runSequence({ seed, steps: 300, limit, lockstep: false });
    });
  }
});

describe('LaneSemaphore', () => {
  it('a waiter interrupted while queued never runs and leaves no trace', async () => {
    const sem = new LaneSemaphore<string>(1);
    let ran = 0;
    let release: () => void = () => {};
    const blocker = Effect.runFork(
      sem.withPermit(
        'a',
        'background',
        Effect.callback<void>((resume) => {
          release = () => resume(Effect.void);
        }),
      ),
    );
    const queued = Effect.runFork(
      sem.withPermit(
        'b',
        'interactive',
        Effect.sync(() => {
          ran += 1;
        }),
      ),
    );
    await settle();
    expect(sem.queued()).toBe(1);
    queued.interruptUnsafe();
    await settle();
    expect(sem.queued()).toBe(0);
    const exit = queued.pollUnsafe();
    expect(exit && Exit.hasInterrupts(exit)).toBe(true);
    release();
    await settle();
    expect(blocker.pollUnsafe()?._tag).toBe('Success');
    expect(ran).toBe(0);
    expect(sem.active).toBe(0);
  });

  it('a grant that races an interruption gives the permit back (the fiber never sees it)', async () => {
    const sem = new LaneSemaphore<string>(1);
    let release: () => void = () => {};
    Effect.runFork(
      sem.withPermit(
        'a',
        'background',
        Effect.callback<void>((resume) => {
          release = () => resume(Effect.void);
        }),
      ),
    );
    let ran = false;
    // One op per scheduler turn: the interruption's cleanup runs a turn after it was requested.
    const slow = Effect.runForkWith(Context.make(Scheduler.MaxOpsBeforeYield, 1));
    const waiter = slow(
      sem.withPermit(
        'b',
        'background',
        Effect.sync(() => {
          ran = true;
        }),
      ),
    );
    await settle();
    expect(sem.queued()).toBe(1);
    waiter.interruptUnsafe();
    // Its cleanup has not run yet: still queued, so the release grants it the permit.
    expect(sem.queued()).toBe(1);
    release();
    expect(sem.active).toBe(1);
    for (let i = 0; i < 100 && !waiter.pollUnsafe(); i++) await settle();
    const exit = waiter.pollUnsafe();
    expect(exit && Exit.hasInterrupts(exit)).toBe(true);
    expect(ran).toBe(false);
    expect(sem.active).toBe(0);
    expect(sem.queued()).toBe(0);
  });

  it('releases the permit of running work only once its interruption has completed', async () => {
    const sem = new LaneSemaphore<string>(1);
    let exited: () => void = () => {};
    const running = Effect.runFork(
      sem.withPermit(
        'a',
        'interactive',
        Effect.callback<void>(() =>
          Effect.callback<void>((resume) => {
            exited = () => resume(Effect.void);
          }),
        ),
      ),
    );
    let secondRan = false;
    const second = Effect.runFork(
      sem.withPermit(
        'b',
        'background',
        Effect.sync(() => {
          secondRan = true;
        }),
      ),
    );
    await settle();
    running.interruptUnsafe();
    await settle();
    // Still "terminating": the permit is held, the second job waits.
    expect(sem.active).toBe(1);
    expect(secondRan).toBe(false);
    expect(running.pollUnsafe()).toBeUndefined();
    exited();
    await settle();
    expect(running.pollUnsafe() && Exit.hasInterrupts(running.pollUnsafe() as never)).toBe(true);
    expect(secondRan).toBe(true);
    expect(second.pollUnsafe()?._tag).toBe('Success');
    expect(sem.active).toBe(0);
  });

  it('close fails every waiter and every later take; held permits stay held', async () => {
    const sem = new LaneSemaphore<string>(1);
    let release: () => void = () => {};
    const held = Effect.runFork(
      sem.withPermit(
        'a',
        'background',
        Effect.callback<void>((resume) => {
          release = () => resume(Effect.void);
        }),
      ),
    );
    const waiting = [
      Effect.runFork(sem.withPermit('a', 'background', Effect.void)),
      Effect.runFork(sem.withPermit('b', 'interactive', Effect.void)),
    ];
    await settle();
    sem.close('disposed');
    await settle();
    for (const fiber of waiting) {
      const exit = fiber.pollUnsafe();
      const error = exit && Exit.isFailure(exit) ? Exit.findErrorOption(exit) : undefined;
      expect(error?._tag === 'Some' && error.value).toBe('disposed');
    }
    expect(sem.active).toBe(1);
    const late = Effect.runFork(sem.withPermit('c', 'interactive', Effect.void));
    await settle();
    expect(late.pollUnsafe()?._tag).toBe('Failure');
    release();
    await settle();
    expect(held.pollUnsafe()?._tag).toBe('Success');
    expect(sem.active).toBe(0);
  });

  it('grants a free permit synchronously, without a scheduler tick', () => {
    const sem = new LaneSemaphore<string>(2);
    let ran = false;
    const fiber = Effect.runFork(
      sem.withPermit(
        'a',
        'background',
        Effect.sync(() => {
          ran = true;
        }),
      ),
    );
    expect(ran).toBe(true);
    expect(fiber.pollUnsafe()?._tag).toBe('Success');
    expect(sem.active).toBe(0);
  });

  it('a permit released from inside a grant does not recurse (a long chain of instant jobs)', async () => {
    const sem = new LaneSemaphore<string>(1);
    let release: () => void = () => {};
    Effect.runFork(
      sem.withPermit(
        'a',
        'background',
        Effect.callback<void>((resume) => {
          release = () => resume(Effect.void);
        }),
      ),
    );
    let ran = 0;
    const fibers = Array.from({ length: 20_000 }, (_, i) =>
      Effect.runFork(
        sem.withPermit(
          `k${i % 7}`,
          i % 3 === 0 ? 'interactive' : 'background',
          Effect.sync(() => {
            ran += 1;
          }),
        ),
      ),
    );
    await settle();
    release();
    await settle();
    expect(ran).toBe(20_000);
    expect(fibers.every((f) => f.pollUnsafe()?._tag === 'Success')).toBe(true);
    expect(sem.active).toBe(0);
  });
});
