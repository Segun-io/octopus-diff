/**
 * Supervision of the long-lived child processes (#46, DECISIONS #395): the git spawn helpers of
 * `helper-client.ts` and the daemon's watch host. A supervisor owns up to `slots` instances, each
 * in a scope of its own, and decides only lifecycle:
 *
 * - **lazily started**: nothing runs until someone asks (`get`, `startNow`);
 * - **restarted on crash with a bounded schedule**: an instance reports its own death, the
 *   restart policy (an Effect `Schedule` fed one `Death` per crash) says how long to wait before
 *   the next start, or that the supervisor gives up for good;
 * - **released on scope close**: closing the supervisor's scope (a `Layer` being released, a
 *   `ManagedRuntime` disposed) marks it closed, then closes every instance's scope, which kills
 *   the process; nothing can start afterwards, so nothing is orphaned.
 *
 * What an instance does (its protocol, its requests, what a death means for them) stays in the
 * module that owns it: only the bookkeeping that used to be ad hoc there (slots, crash windows,
 * give-up rules, close) lives here. Time comes from Effect's `Clock`, so a test's `TestClock`
 * drives the crash window and the backoff deterministically.
 *
 * Synchronous callers (the runner's spawn path) use `running`, `slots` and `startNow` without
 * entering a fiber on their hot path; Effect callers use `get`, which waits out a backoff.
 */
import * as Cause from 'effect/Cause';
import * as Clock from 'effect/Clock';
import type * as Context from 'effect/Context';
import * as Data from 'effect/Data';
import * as Deferred from 'effect/Deferred';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Pull from 'effect/Pull';
import * as Result from 'effect/Result';
import * as Schedule from 'effect/Schedule';
import * as Scope from 'effect/Scope';

/** What an instance reports when it ends on its own (a crash, a kill, a failed start). */
export interface Death {
  /** Why it ended (for logs). */
  readonly reason: string;
  /** It ended before it said it was ready: a start failure. */
  readonly beforeReady?: boolean;
}

/** Why `get` cannot return an instance. */
export class SupervisorUnavailable extends Data.TaggedError('SupervisorUnavailable')<{
  readonly name: string;
  /**
   * `closed`: its scope was closed (reason `closed`), or `stopAll` ended the wait (reason
   * `stopped`). `gave-up`: the restart policy ran out.
   */
  readonly state: 'closed' | 'gave-up';
  readonly reason: string;
}> {
  override get message(): string {
    return `${this.name} is unavailable (${this.state}): ${this.reason}`;
  }
}

/** The output of `restartPolicy` for one death. */
export interface RestartDecision {
  /** Deaths within the window, this one included. */
  readonly deaths: number;
  /** Deaths before ready in a row, this one included (0 when this one was ready). */
  readonly startFailures: number;
  /** Set when the policy gives up: which limit was reached. */
  readonly gaveUp: 'start-failures' | 'deaths' | null;
}

export interface RestartPolicyOptions {
  /** The crash window: deaths older than this are forgotten. */
  readonly window: Duration.Input;
  /** Give up at this many deaths within the window (default: never). */
  readonly maxDeaths?: number;
  /** Give up at this many start failures in a row (default: never). */
  readonly maxStartFailures?: number;
  /**
   * Wait before the next start. The first `immediate` deaths within the window (default 1) restart
   * at once; after that the wait is `base` · 2^(k − immediate − 1) for the k-th, at most `max`.
   * Absent: every restart is immediate.
   */
  readonly backoff?: {
    readonly base: Duration.Input;
    readonly max: Duration.Input;
    readonly immediate?: number;
  };
}

/** A restart policy: one step per death; done means give up. */
export type RestartPolicy = Schedule.Schedule<RestartDecision, Death>;

/**
 * The bounded restart policy of a supervisor, as a `Schedule` whose input is each `Death`: a
 * sliding crash window, an optional limit on deaths within it and on start failures in a row,
 * and an exponential backoff that restarts with the window (`Schedule.exponential` would never
 * forget old crashes). Its clock is the schedule's `now`, i.e. Effect's `Clock`.
 */
export function restartPolicy(options: RestartPolicyOptions): RestartPolicy {
  const windowMs = Duration.toMillis(Duration.fromInputUnsafe(options.window));
  const maxDeaths = options.maxDeaths ?? Number.POSITIVE_INFINITY;
  const maxStartFailures = options.maxStartFailures ?? Number.POSITIVE_INFINITY;
  const backoff = options.backoff
    ? {
        base: Duration.toMillis(Duration.fromInputUnsafe(options.backoff.base)),
        max: Duration.toMillis(Duration.fromInputUnsafe(options.backoff.max)),
        immediate: Math.max(0, options.backoff.immediate ?? 1),
      }
    : null;
  return Schedule.fromStep(
    Effect.sync(() => {
      let deaths: number[] = [];
      let startFailures = 0;
      return (now: number, death: Death) => {
        startFailures = death.beforeReady ? startFailures + 1 : 0;
        deaths = [...deaths.filter((t) => now - t < windowMs), now];
        const gaveUp =
          startFailures >= maxStartFailures
            ? 'start-failures'
            : deaths.length >= maxDeaths
              ? 'deaths'
              : null;
        const decision: RestartDecision = { deaths: deaths.length, startFailures, gaveUp };
        if (gaveUp) return Cause.done(decision);
        let delay = 0;
        if (backoff && deaths.length > backoff.immediate) {
          const exponent = Math.min(30, deaths.length - backoff.immediate - 1);
          delay = Math.min(backoff.max, backoff.base * 2 ** exponent);
        }
        return Effect.succeed([decision, Duration.millis(delay)] as [
          RestartDecision,
          Duration.Duration,
        ]);
      };
    }),
  );
}

export interface SupervisorSpec<A> {
  /** For error messages. */
  readonly name: string;
  /** How many instances may run at once (default 1). */
  readonly slots?: number;
  /**
   * Starts one instance. Everything it starts must be released by finalizers of the `Scope` it
   * gets (the supervisor closes that scope when the instance dies, is stopped, or the supervisor
   * closes). It must call `died` once if it ends on its own (later calls are ignored). Must be
   * synchronous for `startNow`.
   */
  readonly acquire: (died: (death: Death) => void) => Effect.Effect<A, never, Scope.Scope>;
  readonly policy: RestartPolicy;
  /** Called once, synchronously, when the policy gives up (the dead instance and the decision). */
  readonly onGiveUp?: (decision: RestartDecision, death: Death, instance: A) => void;
}

export interface Supervisor<A> {
  /** The running instances, in slot order (no fiber: a plain read). */
  readonly running: ReadonlyArray<A>;
  /** One entry per slot: the instance there, or null. */
  readonly slots: ReadonlyArray<A | null>;
  /** True while a start is allowed now: open, not given up, no backoff pending, a slot free. */
  readonly canStartNow: boolean;
  /** The give-up decision, once the policy ran out. */
  readonly gaveUp: RestartDecision | null;
  readonly closed: boolean;
  /** Starts an instance in the first free slot, now, or returns null (see `canStartNow`). */
  startNow(): A | null;
  /**
   * The first running instance, else a new one once any backoff is over (`Clock`: a `TestClock`
   * advances it). Fails when the supervisor is closed or gave up.
   */
  readonly get: Effect.Effect<A, SupervisorUnavailable>;
  /** Releases an instance on purpose (not a death: the restart policy is not consulted). */
  stop(instance: A): Effect.Effect<void>;
  /** `stop` from synchronous code: runs the release at once (it must be synchronous then). */
  stopNow(instance: A): void;
  /**
   * Stops every running instance (not deaths) and fails every pending `get` at once with
   * `SupervisorUnavailable` (`closed`, reason `stopped`), including gets sleeping out a backoff
   * or joined to a start in flight; such a start releases what it acquires. The supervisor stays
   * open: later calls start again, with no backoff (PR #100 review, P1).
   */
  readonly stopAll: Effect.Effect<void>;
  /** `stopAll` from synchronous code (the releases must be synchronous then). */
  stopAllNow(): void;
}

/** A running instance in its slot. */
interface Slot<A> {
  readonly kind: 'running';
  readonly value: A;
  readonly scope: Scope.Closeable;
}

/**
 * A start in flight (PR #100 review, P2): the slot is reserved and the instance's scope exists
 * before `acquire` runs, so a concurrent start picks another slot, a concurrent `get` joins this
 * one, and a close or `stopAll` meanwhile is seen when the acquisition ends (what it acquired is
 * released then, never installed).
 */
interface Starting<A> {
  readonly kind: 'starting';
  readonly scope: Scope.Closeable;
  /** The generation it was started in (`stopAll` begins a new one). */
  readonly generation: number;
  /** Completes with the instance, or fails when it was cancelled or its acquisition failed. */
  readonly done: Deferred.Deferred<A, SupervisorUnavailable>;
}

type Entry<A> = Slot<A> | Starting<A>;

/**
 * Makes a supervisor in the current scope: when that scope closes, the supervisor closes and
 * releases every instance (in parallel, waiting for each release, and for starts in flight).
 */
export const makeSupervisor = <A>(
  spec: SupervisorSpec<A>,
): Effect.Effect<Supervisor<A>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const context: Context.Context<never> = yield* Effect.context<never>();
    const runSync = Effect.runSyncWith(context);
    const runFork = Effect.runForkWith(context);
    const step = yield* Schedule.toStep(spec.policy);
    const slots: Array<Entry<A> | null> = Array.from(
      { length: Math.max(1, Math.floor(spec.slots ?? 1)) },
      () => null,
    );
    let closed = false;
    let gaveUp: RestartDecision | null = null;
    let gaveUpReason = '';
    /** `Clock` millis before which no instance starts (a backoff). */
    let retryAt = 0;
    /**
     * The current generation and its gate: every wait in `get` races the gate, which fails when
     * `stopAll` or the close ends the generation (PR #100 review, P1).
     */
    let generation = 0;
    let gate = Deferred.makeUnsafe<never, SupervisorUnavailable>();

    const closedError = (reason: string) =>
      new SupervisorUnavailable({ name: spec.name, state: 'closed', reason });
    const release = (slot: Entry<A>): Effect.Effect<void> => Scope.close(slot.scope, Exit.void);
    const indexOf = (value: A): number =>
      slots.findIndex((s) => s !== null && s.kind === 'running' && s.value === value);
    const isRunning = (s: Entry<A> | null): s is Slot<A> => s !== null && s.kind === 'running';
    const isStarting = (s: Entry<A> | null): s is Starting<A> =>
      s !== null && s.kind === 'starting';

    /** Ends the current generation: its waiters fail with `error`, later calls get a new gate. */
    const endGeneration = (error: SupervisorUnavailable): void => {
      const ended = gate;
      generation += 1;
      gate = Deferred.makeUnsafe<never, SupervisorUnavailable>();
      Deferred.doneUnsafe(ended, Effect.fail(error));
    };

    /** An instance's own death: free its slot, consult the policy, release what is left of it. */
    const onDeath = (slot: Slot<A>, death: Death): void => {
      const at = slots.indexOf(slot);
      if (at < 0) return; // stopped or released already: not a death to count
      slots[at] = null;
      if (!closed && !gaveUp) {
        const now = runSync(Clock.currentTimeMillis);
        const outcome = runSync(Effect.exit(step(now, death)));
        if (Exit.isSuccess(outcome)) {
          const [, delay] = outcome.value;
          retryAt = Math.max(retryAt, now + Duration.toMillis(delay));
        } else {
          const decision = decisionOf(outcome.cause);
          gaveUp = decision ?? { deaths: 0, startFailures: 0, gaveUp: 'deaths' };
          gaveUpReason = death.reason;
          spec.onGiveUp?.(gaveUp, death, slot.value);
        }
      }
      // A dead instance's finalizers run off this call stack (they may wait on its streams).
      runFork(release(slot));
    };

    /** Reserves slot `at` for a start, with the instance's scope, before anything is acquired. */
    const reserve = (at: number): Starting<A> => {
      const reservation: Starting<A> = {
        kind: 'starting',
        scope: Scope.makeUnsafe(),
        generation,
        done: Deferred.makeUnsafe<A, SupervisorUnavailable>(),
      };
      slots[at] = reservation;
      return reservation;
    };

    /**
     * Acquires into a reservation: installs the instance if the reservation is still current, else
     * (a failure, an interruption, a close or `stopAll` meanwhile) releases what was acquired, so
     * nothing it started outlives the reservation. `done` tells every waiter.
     */
    const acquireInto = (
      at: number,
      reservation: Starting<A>,
    ): Effect.Effect<A, SupervisorUnavailable> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          let slot: Slot<A> | null = null;
          let pending: Death | null = null;
          const died = (death: Death): void => {
            if (slot) onDeath(slot, death);
            else pending ??= death; // died while starting
          };
          const acquired = yield* Effect.exit(
            restore(Scope.provide(reservation.scope)(spec.acquire(died))),
          );
          if (slots[at] === reservation) slots[at] = null;
          if (Exit.isSuccess(acquired) && !closed && reservation.generation === generation) {
            slot = { kind: 'running', value: acquired.value, scope: reservation.scope };
            slots[at] = slot;
            Deferred.doneUnsafe(reservation.done, Effect.succeed(acquired.value));
            if (pending) onDeath(slot, pending);
            return acquired.value;
          }
          yield* Scope.close(reservation.scope, acquired);
          const error = closedError(closed ? 'closed' : 'stopped');
          Deferred.doneUnsafe(reservation.done, Effect.fail(error));
          if (Exit.isFailure(acquired) && !Exit.hasInterrupts(acquired)) {
            return yield* Effect.failCause(acquired.cause as Cause.Cause<never>);
          }
          if (Exit.isFailure(acquired)) return yield* Effect.interrupt;
          return yield* Effect.fail(error);
        }),
      );

    const freeSlot = (): number => slots.indexOf(null);
    const unavailable = (): SupervisorUnavailable | null =>
      closed
        ? closedError('closed')
        : gaveUp
          ? new SupervisorUnavailable({ name: spec.name, state: 'gave-up', reason: gaveUpReason })
          : null;

    const canStartNow = (): boolean =>
      !closed && !gaveUp && freeSlot() >= 0 && runSync(Clock.currentTimeMillis) >= retryAt;

    /** `effect`, or the failure of the current generation's gate if that comes first. */
    const gated = <X>(effect: Effect.Effect<X, SupervisorUnavailable>) =>
      Effect.raceFirst(effect, Deferred.await(gate));

    const get: Effect.Effect<A, SupervisorUnavailable> = Effect.gen(function* () {
      for (;;) {
        const error = unavailable();
        if (error) return yield* Effect.fail(error);
        const live = slots.find(isRunning);
        if (live) return live.value;
        const starting = slots.filter(isStarting);
        const current = starting.find((s) => s.generation === generation);
        // A start in flight in this generation: share it.
        if (current) return yield* gated(Deferred.await(current.done));
        const now = yield* Clock.currentTimeMillis;
        if (now < retryAt) {
          yield* gated(Effect.sleep(Duration.millis(retryAt - now)));
          continue;
        }
        const at = freeSlot();
        if (at < 0) {
          // Every slot holds a cancelled start still acquiring: wait for one to end.
          yield* gated(Effect.raceAll(starting.map((s) => Effect.ignore(Deferred.await(s.done)))));
          continue;
        }
        // Reserved now, acquired in a fiber of its own: every caller, this one included, waits
        // through the gate, so `stopAll` or a close ends the wait even while an (uninterruptible)
        // acquisition runs; the start itself is shared and finishes or is released either way.
        const reservation = reserve(at);
        runFork(acquireInto(at, reservation));
        return yield* gated(Deferred.await(reservation.done));
      }
    });

    const stop = (instance: A): Effect.Effect<void> =>
      Effect.suspend(() => {
        const at = indexOf(instance);
        if (at < 0) return Effect.void;
        const slot = slots[at] as Slot<A>;
        slots[at] = null;
        return release(slot);
      });

    const stopAll: Effect.Effect<void> = Effect.suspend(() => {
      if (closed) return Effect.void;
      // A deliberate stop: no backoff for the next start (the crash window is kept).
      retryAt = 0;
      endGeneration(closedError('stopped'));
      const live = slots.filter(isRunning);
      for (const slot of live) slots[slots.indexOf(slot)] = null;
      return Effect.forEach(live, release, { concurrency: 'unbounded', discard: true });
    });

    yield* Effect.addFinalizer(() =>
      Effect.suspend(() => {
        closed = true;
        endGeneration(closedError('closed'));
        const live = slots.filter(isRunning);
        const starting = slots.filter(isStarting);
        for (const slot of live) slots[slots.indexOf(slot)] = null;
        return Effect.forEach(live, release, { concurrency: 'unbounded', discard: true }).pipe(
          // Starts in flight release what they acquired themselves once their acquisition ends.
          Effect.andThen(
            Effect.forEach(starting, (s) => Effect.ignore(Deferred.await(s.done)), {
              concurrency: 'unbounded',
              discard: true,
            }),
          ),
        );
      }),
    );

    const supervisor: Supervisor<A> = {
      get running() {
        return slots.flatMap((s) => (isRunning(s) ? [s.value] : []));
      },
      get slots() {
        return slots.map((s) => (isRunning(s) ? s.value : null));
      },
      get canStartNow() {
        return canStartNow();
      },
      get gaveUp() {
        return gaveUp;
      },
      get closed() {
        return closed;
      },
      startNow() {
        if (!canStartNow()) return null;
        const at = freeSlot();
        const exit = runSync(Effect.exit(acquireInto(at, reserve(at))));
        return Exit.isSuccess(exit) ? exit.value : null;
      },
      get,
      stop,
      stopNow(instance) {
        runSync(stop(instance));
      },
      stopAll,
      stopAllNow() {
        runSync(stopAll);
      },
    };
    return supervisor;
  });

/** The decision a policy ended with (its `Cause.done` leftover), or null for any other failure. */
function decisionOf(cause: Cause.Cause<Cause.Done<RestartDecision>>): RestartDecision | null {
  const done = Pull.filterDoneLeftover(cause);
  return Result.isSuccess(done) ? done.success : null;
}
