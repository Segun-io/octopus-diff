/**
 * The supervisor (#46): lazy start, restart on crash with a bounded schedule, give up, release on
 * scope close. Every test runs on Effect's `TestClock`: the crash window and the backoff advance
 * only with `TestClock.adjust`, never with real time, so no test sleeps and none depends on how
 * fast the machine is. The last block supervises real git helper processes the same way.
 */
import { existsSync } from 'node:fs';
import { assert, describe, it } from '@effect/vitest';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Schedule from 'effect/Schedule';
import * as Scope from 'effect/Scope';
import * as TestClock from 'effect/testing/TestClock';
import { defaultHelperEntry, HelperPool, type ProcHandlers } from '../src/runner/helper-client.js';
import { resolveExecutable } from '../src/runner/runner.js';
import {
  type Death,
  makeSupervisor,
  type RestartDecision,
  restartPolicy,
  SupervisorUnavailable,
} from '../src/runner/supervisor.js';

interface Fake {
  readonly id: number;
  readonly die: (death?: Partial<Death>) => void;
}

/** Instances that only record their lifecycle; `die` reports a crash to the supervisor. */
function fakes() {
  const started: number[] = [];
  const released: number[] = [];
  let next = 1;
  const acquire = (died: (death: Death) => void) =>
    Effect.acquireRelease(
      Effect.sync((): Fake => {
        const id = next++;
        started.push(id);
        return { id, die: (death = {}) => died({ reason: 'crashed', ...death }) };
      }),
      (fake) => Effect.sync(() => released.push(fake.id)),
    );
  return { started, released, acquire };
}

/** Lets forked fibers run up to their next real suspension (no time passes on the TestClock). */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
});

describe('restartPolicy', () => {
  const decide = (
    step: (
      now: number,
      death: Death,
    ) => Effect.Effect<[RestartDecision, Duration.Duration], unknown>,
    now: number,
    death: Death = { reason: 'x' },
  ) => Effect.exit(step(now, death));

  it.effect('restarts at once, then backs off exponentially up to the cap', () =>
    Effect.gen(function* () {
      const step = yield* Schedule.toStep(
        restartPolicy({ window: '1 minute', backoff: { base: '1 second', max: '5 seconds' } }),
      );
      const delays: number[] = [];
      for (let i = 0; i < 6; i++) {
        const exit = yield* decide(step, i);
        assert.isTrue(Exit.isSuccess(exit));
        if (Exit.isSuccess(exit)) delays.push(Duration.toMillis(exit.value[1]));
      }
      assert.deepStrictEqual(delays, [0, 1000, 2000, 4000, 5000, 5000]);
    }),
  );

  it.effect('forgets deaths older than the window (the backoff restarts with it)', () =>
    Effect.gen(function* () {
      const step = yield* Schedule.toStep(
        restartPolicy({ window: '1 minute', backoff: { base: '1 second', max: '1 minute' } }),
      );
      yield* decide(step, 0);
      const second = yield* decide(step, 1_000);
      const later = yield* decide(step, 1_000 + 60_000);
      assert.isTrue(Exit.isSuccess(second) && Duration.toMillis(second.value[1]) === 1000);
      // At 61 s the death at 0 is out of the window, the one at 1 s is exactly at its edge.
      assert.isTrue(Exit.isSuccess(later) && later.value[0].deaths === 1);
      assert.isTrue(Exit.isSuccess(later) && Duration.toMillis(later.value[1]) === 0);
    }),
  );

  it.effect('gives up at the death limit within the window, and at start failures in a row', () =>
    Effect.gen(function* () {
      const deaths = yield* Schedule.toStep(restartPolicy({ window: '1 minute', maxDeaths: 3 }));
      assert.isTrue(Exit.isSuccess(yield* decide(deaths, 0)));
      assert.isTrue(Exit.isSuccess(yield* decide(deaths, 10)));
      assert.isTrue(Exit.isFailure(yield* decide(deaths, 20)));

      const starts = yield* Schedule.toStep(
        restartPolicy({ window: '1 minute', maxStartFailures: 2 }),
      );
      assert.isTrue(Exit.isSuccess(yield* decide(starts, 0, { reason: 'x', beforeReady: true })));
      // A death after ready resets the count.
      assert.isTrue(Exit.isSuccess(yield* decide(starts, 1, { reason: 'x' })));
      assert.isTrue(Exit.isSuccess(yield* decide(starts, 2, { reason: 'x', beforeReady: true })));
      assert.isTrue(Exit.isFailure(yield* decide(starts, 3, { reason: 'x', beforeReady: true })));
    }),
  );
});

describe('makeSupervisor', () => {
  const policy = restartPolicy({
    window: '1 minute',
    maxDeaths: 4,
    backoff: { base: '1 second', max: '10 seconds' },
  });

  it.effect('starts nothing until asked, then one instance per slot', () =>
    Effect.gen(function* () {
      const f = fakes();
      const sup = yield* makeSupervisor({ name: 'fake', slots: 2, acquire: f.acquire, policy });
      assert.deepStrictEqual(f.started, []);
      const a = yield* sup.get;
      assert.strictEqual((yield* sup.get).id, a.id); // `get` reuses the running one
      const b = sup.startNow();
      assert.strictEqual(b?.id, 2);
      assert.isNull(sup.startNow()); // both slots taken
      assert.deepStrictEqual(
        sup.running.map((x) => x.id),
        [1, 2],
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    'restarts a crashed instance at once, then after a backoff that only the clock ends',
    () =>
      Effect.gen(function* () {
        const f = fakes();
        const sup = yield* makeSupervisor({ name: 'fake', acquire: f.acquire, policy });
        (yield* sup.get).die();
        // First death within the window: no backoff, and the dead one was released.
        assert.isTrue(sup.canStartNow);
        const second = yield* sup.get;
        assert.strictEqual(second.id, 2);
        second.die();
        // Second death: 1 s of backoff. A caller waits on the clock, a synchronous one is refused.
        assert.isFalse(sup.canStartNow);
        assert.isNull(sup.startNow());
        const waiting = yield* Effect.forkChild(sup.get);
        yield* settle;
        assert.deepStrictEqual(f.started, [1, 2]);
        yield* TestClock.adjust('999 millis');
        yield* settle;
        assert.deepStrictEqual(f.started, [1, 2]);
        yield* TestClock.adjust('1 millis');
        const third = yield* Fiber.join(waiting);
        assert.strictEqual(third.id, 3);
        assert.deepStrictEqual(f.started, [1, 2, 3]);
        // Releases run off the death's call stack: both dead ones are released by now.
        yield* settle;
        assert.deepStrictEqual(f.released, [1, 2]);
        // A minute later the window is clear: the next crash restarts at once again.
        yield* TestClock.adjust('1 minute');
        third.die();
        assert.isTrue(sup.canStartNow);
      }).pipe(Effect.scoped),
  );

  it.effect(
    'gives up when the policy runs out: once, with the decision; nothing starts again',
    () =>
      Effect.gen(function* () {
        const f = fakes();
        const decisions: RestartDecision[] = [];
        const sup = yield* makeSupervisor({
          name: 'fake',
          acquire: f.acquire,
          policy: restartPolicy({ window: '1 minute', maxDeaths: 2 }),
          onGiveUp: (decision) => decisions.push(decision),
        });
        (yield* sup.get).die();
        const last = yield* sup.get;
        last.die();
        last.die(); // a second report of the same death is ignored
        assert.deepStrictEqual(decisions, [{ deaths: 2, startFailures: 0, gaveUp: 'deaths' }]);
        assert.deepStrictEqual(sup.gaveUp, decisions[0]);
        assert.isNull(sup.startNow());
        const error = yield* Effect.flip(sup.get);
        assert.instanceOf(error, SupervisorUnavailable);
        assert.strictEqual(error.state, 'gave-up');
        assert.deepStrictEqual(f.started, [1, 2]);
      }).pipe(Effect.scoped),
  );

  it.effect('a stopped instance is released and not counted as a death', () =>
    Effect.gen(function* () {
      const f = fakes();
      const sup = yield* makeSupervisor({
        name: 'fake',
        acquire: f.acquire,
        policy: restartPolicy({ window: '1 minute', maxDeaths: 1 }),
      });
      const a = yield* sup.get;
      yield* sup.stop(a);
      assert.deepStrictEqual(f.released, [1]);
      a.die(); // its exit event after the stop: not a death
      assert.isNull(sup.gaveUp);
      const b = sup.startNow();
      assert.strictEqual(b?.id, 2);
      if (b) sup.stopNow(b);
      assert.deepStrictEqual(f.released, [1, 2]);
    }).pipe(Effect.scoped),
  );

  it.effect('closing its scope releases every instance; it never starts one again', () =>
    Effect.gen(function* () {
      const f = fakes();
      const scope = yield* Scope.make();
      const sup = yield* Scope.provide(scope)(
        makeSupervisor({ name: 'fake', slots: 3, acquire: f.acquire, policy }),
      );
      const a = yield* sup.get;
      sup.startNow();
      sup.startNow();
      yield* Scope.close(scope, Exit.void);
      assert.deepStrictEqual([...f.released].sort(), [1, 2, 3]);
      assert.isTrue(sup.closed);
      assert.deepStrictEqual(sup.running, []);
      a.die(); // a late exit report: ignored
      assert.isNull(sup.startNow());
      const error = yield* Effect.flip(sup.get);
      assert.strictEqual(error.state, 'closed');
      assert.deepStrictEqual(f.started, [1, 2, 3]);
    }),
  );

  it.effect('a caller waiting out a backoff is refused when the scope closes meanwhile', () =>
    Effect.gen(function* () {
      const f = fakes();
      const scope = yield* Scope.make();
      const sup = yield* Scope.provide(scope)(
        makeSupervisor({ name: 'fake', acquire: f.acquire, policy }),
      );
      (yield* sup.get).die();
      (yield* sup.get).die();
      const waiting = yield* Effect.forkChild(Effect.flip(sup.get));
      yield* settle;
      yield* Scope.close(scope, Exit.void);
      yield* TestClock.adjust('1 second');
      const error = yield* Fiber.join(waiting);
      assert.strictEqual(error.state, 'closed');
      assert.deepStrictEqual(f.started, [1, 2]);
    }),
  );

  it.effect('an instance that dies while it is being started is handled after its start', () =>
    Effect.gen(function* () {
      const deaths: RestartDecision[] = [];
      const sup = yield* makeSupervisor({
        name: 'fake',
        acquire: (died) =>
          Effect.sync(() => {
            died({ reason: 'exited at once', beforeReady: true });
            return 'instance';
          }),
        policy: restartPolicy({ window: '1 minute', maxStartFailures: 1 }),
        onGiveUp: (decision) => deaths.push(decision),
      });
      assert.strictEqual(sup.startNow(), 'instance');
      assert.deepStrictEqual(sup.running, []);
      assert.strictEqual(deaths[0]?.gaveUp, 'start-failures');
    }).pipe(Effect.scoped),
  );
});

// --- real git helper processes, supervised on the TestClock ---------------------------------

const helperEntry = defaultHelperEntry();
const gitBinary = resolveExecutable('git', process.env.PATH ?? '');
const posix = process.platform !== 'win32' && helperEntry !== null;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Waits for a real condition (a process exit, an event from a pipe) without touching the
 * TestClock: polls on the real event loop, at most `ms` of real time.
 */
const until = (what: string, check: () => boolean, ms = 20_000) =>
  Effect.promise(async () => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

/** `git --version` through the pool; resolves with stdout. */
const gitVersion = (pool: HelperPool) =>
  Effect.callback<string, Error>((resume) => {
    let out = '';
    const handlers: ProcHandlers = {
      stdout: (chunk) => {
        out += chunk.toString('utf8');
      },
      stderr: () => {},
      exit: () => {},
      close: (code) =>
        resume(code === 0 ? Effect.succeed(out.trim()) : Effect.fail(new Error(`exit ${code}`))),
      error: (error) => resume(Effect.fail(error)),
      tooLarge: () => resume(Effect.fail(new Error('too large'))),
      lost: (reason) => resume(Effect.fail(new Error(`lost: ${reason}`))),
    };
    const handle = pool.startGit(
      {
        binary: gitBinary,
        argv: ['--version'],
        cwd: '/',
        env: { PATH: process.env.PATH ?? '', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1' },
        maxOutputBytes: 1 << 20,
      },
      handlers,
    );
    if (!handle) resume(Effect.fail(new Error('no helper available')));
  });

describe.skipIf(!posix)('the git helper pool under supervision (real helpers, TestClock)', () => {
  const warnings: string[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: (message: string) => warnings.push(message),
    error: () => {},
  };
  const options = () => ({
    gitBinary,
    entry: helperEntry as string,
    processes: 1,
    logger,
  });

  it.effect(
    'restarts a crashed helper at once, then on the backoff the test clock ends; closes it with the scope',
    () =>
      Effect.gen(function* () {
        assert.isTrue(existsSync(helperEntry as string));
        const scope = yield* Scope.make();
        const pool = yield* Scope.provide(scope)(
          HelperPool.make(options(), {
            window: '1 minute',
            maxDeaths: 5,
            backoff: { base: '30 seconds', max: '1 minute' },
          }),
        );
        // Lazy: no helper until the first request.
        assert.deepStrictEqual(pool.pids(), []);
        assert.match(yield* gitVersion(pool), /^git version /);
        const [first] = pool.pids();
        assert.isDefined(first);

        // Crash 1: replaced on the next request, at once.
        process.kill(first as number, 'SIGKILL');
        yield* until('the first helper to be reported dead', () => pool.pids().length === 0);
        assert.isTrue(pool.available);
        assert.match(yield* gitVersion(pool), /^git version /);
        const [second] = pool.pids();
        assert.notStrictEqual(second, first);

        // Crash 2: a 30 s backoff, which no real time ends: no helper can take a request.
        process.kill(second as number, 'SIGKILL');
        yield* until('the second helper to be reported dead', () => pool.pids().length === 0);
        assert.isFalse(pool.available);
        const refused = yield* Effect.flip(gitVersion(pool));
        assert.match(refused.message, /no helper available/);
        yield* TestClock.adjust('29 seconds');
        assert.isFalse(pool.available);
        yield* TestClock.adjust('1 second');
        assert.isTrue(pool.available);
        assert.match(yield* gitVersion(pool), /^git version /);
        const [third] = pool.pids();
        assert.isDefined(third);
        assert.isFalse([first, second].includes(third));
        assert.isFalse(pool.disabled);

        // Closing the scope releases the helper: it exits, and nothing starts any more.
        yield* Scope.close(scope, Exit.void);
        yield* until('the third helper to exit', () => !alive(third as number));
        assert.deepStrictEqual(pool.pids(), []);
        assert.isFalse(pool.available);
        assert.isFalse(alive(first as number) || alive(second as number));
      }),
    60_000,
  );

  it.effect(
    'gives up after the crash budget (logged once) and stays off: the runner spawns directly',
    () =>
      Effect.gen(function* () {
        warnings.length = 0;
        const pool = yield* HelperPool.make(options(), {
          window: '1 minute',
          maxDeaths: 2,
          backoff: { base: '1 second', max: '1 second' },
        });
        const killed: number[] = [];
        for (let i = 0; i < 2; i++) {
          if (i > 0) yield* TestClock.adjust('1 second');
          assert.match(yield* gitVersion(pool), /^git version /);
          const [pid] = pool.pids();
          killed.push(pid as number);
          process.kill(pid as number, 'SIGKILL');
          yield* until('the helper to be reported dead', () => pool.pids().length === 0);
        }
        assert.isTrue(pool.disabled);
        assert.isFalse(pool.available);
        yield* TestClock.adjust(Duration.minutes(5));
        assert.isFalse(pool.available);
        assert.deepStrictEqual(
          warnings.filter((w) => w.startsWith('git helper disabled')),
          ['git helper disabled (it exited 2 times within a minute); spawning git directly'],
        );
        yield* until('the killed helpers to be gone', () => killed.every((pid) => !alive(pid)));
      }).pipe(Effect.scoped),
    60_000,
  );
});
