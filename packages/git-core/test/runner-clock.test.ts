/**
 * The runner's timers on Effect's clock (#47): the abort grace period (SIGTERM, then SIGKILL after
 * `ABORT_GRACE_MS`) and the timeout read the runner's Effect clock, so with a `TestClock` they fire
 * exactly when the test advances it, never with real time. Processes are real (a stand-in git), so
 * the test still waits on real conditions: a log line the process writes, its exit.
 *
 * "Not yet" is proved positively: the process answers a SIGUSR1 (it logs it) after the clock was
 * moved to one millisecond before the deadline, which a SIGKILLed process cannot do. The live-clock
 * versions of the same paths stay in lanes.test.ts and helper.test.ts (process signals do not
 * follow the test clock, and those prove the real 500 ms).
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { isGitCoreError } from '@octopus-diff/contracts';
import * as Effect from 'effect/Effect';
import * as TestClock from 'effect/testing/TestClock';
import { afterAll, beforeAll } from 'vitest';
import { defaultHelperEntry } from '../src/runner/helper-client.js';
import { ABORT_GRACE_MS, GitRunner, gitHelperDisabledByEnv } from '../src/runner/runner.js';
import { createFixture, type Fixture } from './helpers/fixture.js';

let fx: Fixture;
let fakeGit: string;
let log: string;

const job = (name: string): string[] => ['status', '--', name];

beforeAll(() => {
  fx = createFixture();
  log = path.join(fx.root, 'events.log');
  fakeGit = path.join(fx.root, 'fake-git');
  // Logs `start <pid> <name>` with one printf, installs its traps, logs `ready`; then loops (each
  // short `sleep` lets a trap run). SIGTERM is logged and ignored (a SIGTERM to the group ends the
  // current `sleep` only); SIGUSR1 is logged: the process is alive and running its loop.
  writeFileSync(
    fakeGit,
    [
      '#!/bin/sh',
      // The shell reports a child killed by SIGTERM ("Terminated") on stderr, which the runner has
      // already closed after an abort: that SIGPIPE would end the shell before its trap runs.
      'exec 2>/dev/null',
      'for last in "$@"; do :; done',
      `printf 'start %s %s\\n' "$$" "$last" >> "${log}"`,
      `trap 'printf "term %s\\n" "$$" >> "${log}"' TERM`,
      `trap 'printf "usr1 %s\\n" "$$" >> "${log}"' USR1`,
      `printf 'ready %s\\n' "$$" >> "${log}"`,
      'while :; do sleep 0.05; done',
      '',
    ].join('\n'),
  );
  chmodSync(fakeGit, 0o755);
});

afterAll(() => fx.dispose());

const events = (): string[] =>
  existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
const has = (line: string) => (): boolean => events().includes(line);

function alive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
}

/** Waits on a real condition (real time: processes do not follow the test clock). */
const until = (what: string, check: () => boolean, ms = 20_000) =>
  Effect.promise(async () => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

/** The process answers SIGUSR1, so it has not been SIGKILLed. */
const answers = (pid: number, nth: number) =>
  Effect.gen(function* () {
    process.kill(pid, 'SIGUSR1');
    yield* until(
      `usr1 #${nth} answered`,
      () => events().filter((e) => e === `usr1 ${pid}`).length >= nth,
    );
  });

const HELPER = defaultHelperEntry() !== null && !gitHelperDisabledByEnv();
const PATHS = [
  { name: 'direct', helper: false },
  // Without a helper (OCTOPUS_DIFF_GIT_HELPER=0) this runs the direct path a second time.
  { name: HELPER ? 'helper' : 'helper (off: direct)', helper: true },
] as const;

/** A runner on the test's clock (`it.effect` runs on a `TestClock`), disposed with the test. */
const clockRunner = (helper: boolean, timeoutMs: number) =>
  Effect.acquireRelease(
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      return new GitRunner({
        gitBinary: fakeGit,
        timeoutMs,
        helper: helper ? { processes: 1 } : false,
        runnerTest: { context },
      });
    }),
    (r) => Effect.promise(() => r.dispose()),
  );

/** Starts `name` and waits until its process has installed its traps. */
const started = (runner: GitRunner, name: string, signal?: AbortSignal) =>
  Effect.gen(function* () {
    writeFileSync(log, '');
    let settled = false;
    const run = runner.run(job(name), { cwd: fx.root, ...(signal ? { signal } : {}) }).then(
      (value) => {
        settled = true;
        return value as unknown;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    yield* until('the process started', () => events().some((e) => e.startsWith('start ')));
    const pid = Number(events()[0]?.split(' ')[1]);
    yield* until('its traps installed', has(`ready ${pid}`));
    return { run, pid, settled: () => settled };
  });

describe('the abort grace period on the TestClock', () => {
  for (const { name, helper } of PATHS) {
    it.effect(`${name}: SIGKILL exactly ABORT_GRACE_MS after the SIGTERM, not before`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runner = yield* clockRunner(helper, 60_000);
          const controller = new AbortController();
          const { run, pid, settled } = yield* started(runner, `grace-${name}`, controller.signal);
          controller.abort();
          // SIGTERM reached the process, which ignores it.
          yield* until('SIGTERM delivered', has(`term ${pid}`));
          yield* TestClock.adjust(ABORT_GRACE_MS - 1);
          // Still running one millisecond before the grace period ends: no SIGKILL yet.
          yield* answers(pid, 1);
          assert.isFalse(settled());
          yield* TestClock.adjust(1);
          const error = yield* Effect.promise(() => run);
          assert.isTrue(isGitCoreError(error, 'aborted'));
          // The run settled once its process had exited: the SIGKILL ended it.
          yield* until('the process gone', () => !alive(pid), 5_000);
          assert.isFalse(alive(-pid));
        }),
      ),
    );
  }
});

describe('the timeout on the TestClock', () => {
  for (const { name, helper } of PATHS) {
    it.effect(`${name}: fires exactly at timeoutMs and kills the process`, () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runner = yield* clockRunner(helper, 60_000);
          const { run, pid, settled } = yield* started(runner, `timeout-${name}`);
          yield* TestClock.adjust(60_000 - 1);
          yield* answers(pid, 1);
          assert.isFalse(settled());
          yield* TestClock.adjust(1);
          const error = yield* Effect.promise(() => run);
          assert.isTrue(isGitCoreError(error, 'timeout'), String(error));
          // A timeout settles at once and SIGKILLs the group (no grace period).
          yield* until('the process gone', () => !alive(pid), 5_000);
          assert.isFalse(events().includes(`term ${pid}`));
        }),
      ),
    );
  }
});
