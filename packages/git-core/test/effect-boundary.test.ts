/**
 * The Effect boundary (#46): interrupting an Effect that runs git through the runner cancels the
 * git process the way an aborted AbortSignal does (lanes.test.ts "cancellation"), and Promise
 * callers see the same errors as before. The runner's grace period is a real timer, so these run
 * on the live clock (`it.live`) and wait on real conditions (a process gone, a log line).
 */
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import { GitCoreError, isGitCoreError, RepoPathSchema } from '@octopus-diff/contracts';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import * as Fiber from 'effect/Fiber';
import * as Layer from 'effect/Layer';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import { afterAll, beforeAll } from 'vitest';
import { decodeUnknown, runAtBoundary, runGit } from '../src/runner/effect-boundary.js';
import { ABORT_GRACE_MS, GitRunner } from '../src/runner/runner.js';
import { createFixture, type Fixture } from './helpers/fixture.js';

let fx: Fixture;
let fakeGit: string;
let log: string;
let gates: string;

const job = (name: string): string[] => ['status', '--', name];

beforeAll(() => {
  fx = createFixture();
  log = path.join(fx.root, 'starts.log');
  gates = path.join(fx.root, 'gates');
  fx.write(path.join(gates, '.keep'), '');
  fakeGit = path.join(fx.root, 'fake-git');
  // Logs `start <pid> <name>` with one printf; `hang` sleeps, `stubborn` ignores SIGTERM; a name
  // with a gate file waits until the file is removed.
  writeFileSync(
    fakeGit,
    [
      '#!/bin/sh',
      'for last in "$@"; do :; done',
      `printf 'start %s %s\\n' "$$" "$last" >> "${log}"`,
      'case "$FAKE_MODE" in',
      `  stubborn) trap '' TERM; printf 'trapped %s %s\\n' "$$" "$last" >> "${log}"; sleep 120 ;;`,
      '  hang) sleep 120 ;;',
      'esac',
      `while [ -e "${gates}/$last" ]; do sleep 0.01; done`,
      `printf 'out:%s' "$last"`,
      'exit 0',
      '',
    ].join('\n'),
  );
  chmodSync(fakeGit, 0o755);
});

afterAll(() => fx.dispose());

function starts(): Array<{ pid: number; name: string }> {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.startsWith('start '))
    .map((line) => {
      const [, pid, name] = line.split(' ');
      return { pid: Number(pid), name: name ?? '' };
    });
}

function alive(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch {
    return false;
  }
}

const until = (what: string, check: () => boolean, ms = 20_000) =>
  Effect.promise(async () => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

const runner = (env: Record<string, string> = {}, concurrency = 4) =>
  Effect.acquireRelease(
    Effect.sync(() => new GitRunner({ gitBinary: fakeGit, env, concurrency, timeoutMs: 60_000 })),
    (r) => Effect.promise(() => r.dispose()),
  );

describe('runGit: interrupting the fiber cancels the git process', () => {
  it.live('a running process is terminated; the interruption completes once it is gone', () =>
    Effect.gen(function* () {
      writeFileSync(log, '');
      const r = yield* runner({ FAKE_MODE: 'hang' });
      const fiber = yield* Effect.forkChild(runGit(r, job('running'), { cwd: fx.root }));
      yield* until('git to start', () => starts().length === 1);
      const pid = starts()[0]?.pid as number;
      assert.isTrue(alive(-pid));
      const started = Date.now();
      const exit = yield* Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)));
      assert.isTrue(Exit.hasInterrupts(exit));
      // SIGTERM was enough (well before the grace period), and the leader is already reaped:
      // `Fiber.interrupt` returned only after the run settled.
      assert.isBelow(Date.now() - started, ABORT_GRACE_MS + 2_000);
      assert.isFalse(alive(pid));
      yield* until('the rest of the group to go', () => !alive(-pid), 2_000);
    }).pipe(Effect.scoped),
  );

  it.live(
    'a process that ignores SIGTERM gets SIGKILL after the grace period; the slot is held until then',
    () =>
      Effect.gen(function* () {
        writeFileSync(log, '');
        const r = yield* runner({ FAKE_MODE: 'stubborn' }, 1);
        const fiber = yield* Effect.forkChild(runGit(r, job('first'), { cwd: fx.root }));
        // The fake logs once its SIGTERM trap is installed: no sleep before the signal.
        yield* until('the trap', () => readFileSync(log, 'utf8').includes('trapped '));
        const pid = starts()[0]?.pid as number;
        const second = r.run(job('second'), { cwd: fx.root, queueKey: 'other' });
        const interruptedAt = Date.now();
        yield* Fiber.interrupt(fiber);
        const took = Date.now() - interruptedAt;
        assert.isAtLeast(took, ABORT_GRACE_MS - 50);
        assert.isBelow(took, ABORT_GRACE_MS + 3_000);
        assert.isFalse(alive(pid));
        // The second run could only start once the interrupted one had given its slot back.
        yield* until('the second run to start', () => starts().length === 2);
        assert.deepStrictEqual(
          starts().map((s) => s.name),
          ['first', 'second'],
        );
        // `second` is stubborn too: let the runner's dispose kill it.
        second.catch(() => {});
      }).pipe(Effect.scoped),
  );

  it.live('a run interrupted while queued never spawns', () =>
    Effect.gen(function* () {
      writeFileSync(log, '');
      const r = yield* runner({}, 1);
      const blockerGate = path.join(gates, 'blocker');
      writeFileSync(blockerGate, '');
      const blocker = r.run(job('blocker'), { cwd: fx.root });
      yield* until('the blocker to start', () => starts().length === 1);
      const queued = yield* Effect.forkChild(
        runGit(r, job('queued'), { cwd: fx.root, queueKey: 'other' }),
      );
      yield* Effect.yieldNow;
      const exit = yield* Fiber.interrupt(queued).pipe(Effect.andThen(Fiber.await(queued)));
      assert.isTrue(Exit.hasInterrupts(exit));
      // Interrupted while the blocker holds the only slot: it returned without waiting for it.
      assert.isTrue(existsSync(blockerGate));
      rmSync(blockerGate, { force: true });
      yield* Effect.promise(() => blocker);
      assert.deepStrictEqual(
        starts().map((s) => s.name),
        ['blocker'],
      );
    }).pipe(Effect.scoped),
  );

  it.live('a caller signal still cancels it; success and git failures pass through typed', () =>
    Effect.gen(function* () {
      writeFileSync(log, '');
      const r = yield* runner({ FAKE_MODE: 'hang' });
      const controller = new AbortController();
      const fiber = yield* Effect.forkChild(
        Effect.flip(runGit(r, job('signalled'), { cwd: fx.root, signal: controller.signal })),
      );
      yield* until('git to start', () => starts().length === 1);
      controller.abort();
      const error = yield* Fiber.join(fiber);
      assert.isTrue(isGitCoreError(error, 'aborted'));

      const ok = yield* runner();
      const result = yield* runGit(ok, job('fine'), { cwd: fx.root });
      assert.strictEqual(result.stdout.toString(), 'out:fine');
      const refused = yield* Effect.flip(runGit(ok, ['push'], { cwd: fx.root }));
      assert.isTrue(isGitCoreError(refused, 'command_not_allowed'));
    }).pipe(Effect.scoped),
  );
});

describe('runAtBoundary: Effect to Promise', () => {
  it.live(
    'an AbortSignal interrupts the Effect; the promise rejects with aborted once git is gone',
    () =>
      Effect.gen(function* () {
        writeFileSync(log, '');
        const r = yield* runner({ FAKE_MODE: 'hang' });
        const controller = new AbortController();
        const promise = runAtBoundary(null, runGit(r, job('boundary'), { cwd: fx.root }), {
          signal: controller.signal,
        });
        yield* until('git to start', () => starts().length === 1);
        const pid = starts()[0]?.pid as number;
        controller.abort();
        const error = yield* Effect.promise(() =>
          promise.then(
            () => null,
            (e: unknown) => e,
          ),
        );
        assert.isTrue(isGitCoreError(error, 'aborted'));
        assert.isFalse(alive(pid));
      }).pipe(Effect.scoped),
  );

  it.live('typed failures reject with the error itself, defects with the defect', () =>
    Effect.gen(function* () {
      const runtime = ManagedRuntime.make(Layer.empty);
      const failure = new GitCoreError('not_found', 'nope');
      const rejected = yield* Effect.promise(() =>
        runAtBoundary(runtime, Effect.fail(failure)).catch((e: unknown) => e),
      );
      assert.strictEqual(rejected, failure);
      const defect = new Error('bug');
      const died = yield* Effect.promise(() =>
        runAtBoundary(runtime, Effect.die(defect)).catch((e: unknown) => e),
      );
      assert.strictEqual(died, defect);
      assert.strictEqual(yield* Effect.promise(() => runAtBoundary(runtime, Effect.succeed(1))), 1);
      yield* Effect.promise(() => runtime.dispose());
    }),
  );
});

describe('decodeUnknown: contracts zod schemas through Standard Schema', () => {
  it.effect('passes a valid value through and fails with invalid_argument otherwise', () =>
    Effect.gen(function* () {
      const ok = yield* decodeUnknown(RepoPathSchema, 'src/a.ts', 'path');
      assert.strictEqual(ok, 'src/a.ts');
      const error = yield* Effect.flip(decodeUnknown(RepoPathSchema, '../etc/passwd', 'path'));
      assert.isTrue(isGitCoreError(error, 'invalid_argument'));
      assert.strictEqual(error.message, 'invalid path: path must not contain "." or ".." segments');
      assert.isArray(error.details.issues);
      const wrongType = yield* Effect.flip(decodeUnknown(RepoPathSchema, 42));
      assert.match(wrongType.message, /^invalid input: /);
    }),
  );
});
