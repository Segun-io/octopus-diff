import { rename } from 'node:fs/promises';
import path from 'node:path';
import { assert, describe, it } from '@effect/vitest';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as TestClock from 'effect/testing/TestClock';
import { expect } from 'vitest';
import { FakeGitCore } from './fake-git-core.js';
import { client, eventually, sleep, startTestDaemon, tempDir } from './helpers.js';

/**
 * `DaemonCore`'s own timers (GC, the missing-project retry) on Effect's `TestClock` (#49,
 * `Timers`): the daemon's `internal.context` hands the test's context to every daemon timer, so no
 * test waits for a real day or a real minute. The timers that need a real review state (the
 * `review.ready` batch, the reconcile timer) are covered with real git and the live clock.
 */
describe('DaemonCore timers on the test clock (#49)', () => {
  it.effect('collects garbage once at start, then every gcIntervalMs, until it is closed', () =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const fake = new FakeGitCore();
      const daemon = yield* Effect.promise(async () =>
        startTestDaemon({ fake, stateDir: await tempDir(), internal: { context } }),
      );
      let sweeps = 0;
      const original = daemon.store.gcReviewMarks.bind(daemon.store);
      daemon.store.gcReviewMarks = (before) => {
        sweeps += 1;
        return original(before);
      };
      yield* TestClock.adjust(Duration.minutes(24 * 60 - 1));
      assert.strictEqual(sweeps, 0);
      yield* TestClock.adjust(Duration.minutes(1));
      assert.strictEqual(sweeps, 1);
      yield* TestClock.adjust(Duration.hours(24));
      assert.strictEqual(sweeps, 2);
      yield* Effect.promise(() => daemon.close());
      yield* TestClock.adjust(Duration.hours(72));
      assert.strictEqual(sweeps, 2);
    }),
  );

  it.effect('retries a missing project every relistMs and restores it when it is back', () =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const fake = new FakeGitCore();
      const base = yield* Effect.promise(() => tempDir());
      const stateDir = yield* Effect.promise(() => tempDir());
      const a = yield* Effect.promise(() => fake.createRepo(base, 'a'));
      const first = yield* Effect.promise(() => startTestDaemon({ fake, stateDir }));
      yield* Effect.promise(() => client(first).addProject({ path: a.mainPath }));
      yield* Effect.promise(() => first.close());

      const parked = path.join(base, 'parked');
      yield* Effect.promise(() => rename(a.mainPath, parked));
      const second = yield* Effect.promise(() =>
        startTestDaemon({ fake, stateDir, internal: { relistMs: 60_000, context } }),
      );
      const api = client(second);
      const item = () =>
        api.listProjects().then((l) => l.projects.find((p) => p.project.id === a.projectId));
      yield* Effect.promise(() =>
        eventually(async () => (await item())?.worktrees[0]?.worktree.missing === true),
      );
      // The repository is back, but the retry is a timer on the test clock: not before its time.
      yield* Effect.promise(() => rename(parked, a.mainPath));
      yield* TestClock.adjust(Duration.seconds(59));
      yield* Effect.promise(() => sleep(150));
      expect((yield* Effect.promise(item))?.worktrees[0]?.worktree.missing).toBe(true);
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Effect.promise(() =>
        eventually(async () => (await item())?.worktrees[0]?.worktree.missing === false),
      );
    }),
  );
});
