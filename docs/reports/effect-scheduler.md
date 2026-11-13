# effect-scheduler report

Roadmap step 30, issue #47 (tracker #24, milestone M6). Branch `t3/910390fc`, on `main` at `3c90827` (the Effect
foundation, #46 / PR #100). DECISIONS #406-#410.

## Shipped

The hand-written `LaneScheduler` / `FairQueue` of `runner.ts` are replaced by an Effect scheduler, and every git run
is a fiber that an AbortSignal interrupts. The allowlist, config pins, argv building, safety environment, executable
resolution, helper/direct spawn and retry rules are untouched; so are `GitRunOptions`, `GitCoreOptions` and the
public `GitRunner` API.

- **`packages/git-core/src/runner/scheduler.ts`: `LaneSemaphore`**, a partitioned semaphore with the two lanes of #44:
  one global limit, FIFO per `queueKey` within a lane with keys served round-robin, `interactive` first, and
  `background` gets the next permit after `INTERACTIVE_BURST` (4) interactive grants in a row while it waits. `take`
  is an interruptible `Effect.callback` (interrupted, the waiter leaves its queue); `withPermit` releases in
  `ensuring`, so a permit is freed only when the work ends, however it ends; `close(error)` fails every waiter.
  Grants are synchronous (a run that finds a free slot spawns inside `run()`, as before) and never recurse; a grant
  that races an interruption gives its permit back. Why not Effect's own `PartitionedSemaphore`: DECISIONS #406.
- **`GitRunner.schedule`** (`runner.ts`): `run()` and `version()` fork `scheduler.withPermit(queueKey, lane, work)`
  with `{ signal }`. Queued, an abort removes the run (it rejects with `aborted`, `{ queued: true }`, and never
  spawns). Running, `work` hands `execute` the callback's AbortSignal, so the interruption runs the existing abort
  path unchanged (SIGTERM to the group, SIGKILL after `ABORT_GRACE_MS`, the helper's `reapGroup`, the exit
  watchdog), and its cancel step waits until the run has settled: the slot is released only once the process has
  exited. A started run's outcome is the run's own. `dispose()` closes the semaphore where it called `rejectAll`.
- **Timers on Effect's `Clock`** (`GitRunner.timer`): the timeout, the abort grace SIGKILL and the helper exit
  watchdog. The grace and watchdog sleeps stay unref'd on the live clock. `GitRunnerOptions.runnerTest.context`
  (test-only, additive) gives the runner a context whose `TestClock` drives them.
- `runGit` (#46) is unchanged and now interrupts the run's fiber through the signal it passes.
- PLAN §5.1 updated.

## Verification

All commands were run from the repo root on Linux (WSL2, 12 cores, Node 26.13.0, git 2.53.0) unless a line says
otherwise. My fixtures lived under their own `TMPDIR` (`/tmp/od47`), so the orphan checks (`pgrep -af /tmp/od47`)
looked only at processes this session started (another session was running git-core tests at the same time).

**Test files.** `git diff 3c90827 --stat -- '*.test.ts'` lists two new files (`scheduler.test.ts`,
`runner-clock.test.ts`) and a 3-line comment change at the top of `effect-boundary.test.ts`. `lanes.test.ts`,
`runner.test.ts`, `helper.test.ts`, `hostile-config.test.ts`, `readonly.test.ts`, `effect-boundary.test.ts`'s tests
and the daemon's `cancel.real-git.test.ts` are unchanged and still run on the live clock.

| Command | Result |
|---|---|
| `pnpm lint` | pass (4 warnings, 1 info, as on `main`); `credits:check` up to date |
| `pnpm typecheck` | pass (8 packages) |
| `pnpm build` | pass |
| `pnpm test` (after build) | pass: contracts 118, forge 101 (+5 skipped), fixtures 58, web 482, git-core 527 (+1 skipped; 16 new), daemon 427 (+4 skipped), e2e unit 8, cli 141, scripts 34 |
| git-core, helper on (twice) | 527 passed / 1 skipped, both runs (48 s) |
| git-core, `OCTOPUS_DIFF_GIT_HELPER=0` (twice) | 496 passed / 32 skipped, both runs (49 s) |
| daemon, helper on (twice) | 427 passed / 4 skipped, both runs (26 s) |
| daemon, helper off (twice) | 426 passed / 5 skipped, both runs |
| folding mode `OCTOPUS_DIFF_TEST_FOLDS_CASE=1` | git-core 512 / 16 skipped; daemon 425 / 6 skipped |
| git-core 3× under 8 busy loops (started and killed by PID file) | 527 passed / 1 skipped, 3 of 3 (73 / 67 / 70 s) |
| `runner-clock.test.ts` 15× under 8 busy loops | 15 of 15 (after the fix below) |
| `pnpm test:e2e --workers=1` | 106 passed (3.1 min); read-only proof: 12 control repos, 4474 lock polls, 0 violations |
| `pnpm --filter @octopus-diff/web perf:smoke` | exit 0, 6 of 6 checks ok |
| CLI smoke (ci.yml) | `--version` 0.0.0; `doctor`: 0 problems, 1 warning (inotify instances on this machine) |
| package job (ci.yml), Node 26.13.0 and Node 24.22.3 | tarball installed in an empty directory; `--version`; doctor `git-helper` ok; `smoke-tarball.mjs`: diff through the daemon ok, 1 helper under the daemon, nothing left after SIGKILL |
| Node 24.22.3 (`node-linux-x64@24.22.3` from the npm registry), key suites | git-core scheduler, runner-clock, lanes, runner, helper, effect-boundary, supervisor, hostile-config, readonly, no-shell: 130/130; daemon cancel.real-git, cancellation, watch-host, watch-host-supervision, runtime, git-helper.real-git, integration.real-git: 23/23 |
| orphans (`pgrep -af /tmp/od47`) after every suite | none |

**New tests** (16, all pass):

- `scheduler.test.ts` (12). Two property tests per limit (1, 2, 4), 24 seeds each:
  - lockstep, 200 steps: every step is compared with the old `LaneScheduler` (kept in the test as the model);
  - bursts, 300 steps: no settling between most steps, invariants only.

  After every step the test checks: the start order, at most `limit` permits held, permits = jobs running or
  terminating, FIFO per key within a lane, at most 4 interactive starts in a row while background work waits, a lone
  waiting background job within 5 starts, no aborted queued job ever starting, no idle permit while work waits. After
  the drain: 0 permits held, 0 queued, every fiber ended. Six unit tests cover a queued interruption, a release only
  after the interruption completed, close, synchronous grants, a 20 000-job chain without recursion, and the
  grant/interruption race (forced with `MaxOpsBeforeYield = 1`).
- `runner-clock.test.ts` (4): the abort grace period and the timeout on a `TestClock`, each on the direct and the
  helper path, with a real stand-in process.
  - **Grace period.** After SIGTERM, the test moves the clock by `ABORT_GRACE_MS - 1`. The process keeps answering
    SIGUSR1 for 2 × `ABORT_GRACE_MS` of real time, and the run stays pending. One more millisecond, and the run
    rejects with `aborted` once the process and its group are gone.
  - **Timeout.** The same at 60 000 ms, with `timeout` and no SIGTERM.

  The whole file takes about 0.7 s on top of the 1 s liveness window.

**TestClock before/after (the grace period):**

- Before (unchanged, still run): `lanes.test.ts` "escalates to SIGKILL when the process ignores SIGTERM" measures real
  time: `took >= ABORT_GRACE_MS - 50` and `< ABORT_GRACE_MS + 2000`.
- New: the test clock stands at `ABORT_GRACE_MS - 1`, and the process is proved alive, through a real-time window,
  rather than merely not yet dead. At exactly `ABORT_GRACE_MS` the run settles. Both bounds are exact, and neither
  depends on how fast the machine is.
- The old test stays: process signals do not follow the test clock, and it proves the real 500 ms.

**Mutation check.** 15 mutants of the runner and the semaphore, run against the acceptance suites. A `/tmp` script
restored each file afterwards (checked with `git status`). 14 were killed:

- run fiber ignoring the signal; permit released before the aborted process exited; `execute` getting no abort
  signal;
- grace period −1 ms and +1 ms; no SIGKILL escalation; unref'd sleeps ignoring the test clock; timeout on a real
  `setTimeout`; timeout −1 ms;
- lane ignored; `queueKey` ignored; wrong rejection for a queued abort; `withPermit` releasing before the work
  ended; an uninterruptible queue wait.

Earlier, on `scheduler.ts` alone, 6 more mutants were killed by `scheduler.test.ts`:

- burst bound +1; no queue removal on interruption; no round-robin; close not failing waiters; a permit leak;
- no give-back on the grant/interruption race. It survived until the race test was added, which failed first.

Two findings along the way:

- **Equivalent, not killed: `dispose()` without `scheduler.close`.** Queued runs still reject with `disposed`
  as soon as a permit frees, because `execute` refuses after dispose, and dispose frees every running permit (it fails
  each child at once). Only the timing differs, by a few milliseconds.
- **"Ignoring the test clock" survived at first.** A real 500 ms timer fired while the test waited in real time, and
  nothing noticed. The grace test now keeps probing through 2 × `ABORT_GRACE_MS` of real time, which kills that
  mutant. The same change showed a flake under load in the test itself: it asserted the process group was gone right
  after the leader exited. It now waits for the group, as `lanes.test.ts` does.

**Bench** (default, `pnpm --filter @octopus-diff/e2e bench`, 30 × 3 with the UI), alternating `main` (`3c90827`, its
own worktree and build) and this branch, two runs each:

| Metric | main 1 | branch 1 | main 2 | branch 2 | budget |
|---|---|---|---|---|---|
| first paint, cold | 277 ms | 250 ms | 242 ms | 149 ms | < 3000 ms, all pass |
| first paint, warm (median of 3) | 139 ms | 119 ms | 104 ms | 60 ms | < 300 ms |
| write → SSE p95 | 83 ms | 59 ms | 23 ms | 21 ms | < 1000 ms |
| diff during a 60-edit burst, p95 | 29 ms | 25 ms | 50 ms | 47 ms | < 100 ms |
| burst: git wall time summed (spawns) | 1733 ms (292) | 1467 ms (291) | 697 ms (291) | 721 ms (291) | report only |
| burst phase until quiet | 3139 ms | 3108 ms | 3085 ms | 3090 ms | report only |
| startup spawns per worktree (git wall summed) | 4.6 (2530 ms) | 4.7 (1938 ms) | 4.7 (1845 ms) | 4.7 (1118 ms) | ≤ 8 |
| daemon listening / all summaries | 949 / 1380 ms | 806 / 1142 ms | 755 / 1072 ms | 649 / 756 ms | report only |
| idle CPU | 0.17 % | 0.15 % | 0.17 % | 0.18 % | < 10 % |
| daemon RSS, end of run | 153 MiB | 178 MiB | 179 MiB | 172 MiB | report only |

Every budget passes in all four runs, with the same spawn counts. The branch is equal to or better than `main` within
the noise of this shared machine: another session was running tests during the first pair, so both of those are
slower. The burst git wall time is within 4 % in the quiet pair (697 vs 721 ms; the per-spawn `diff` p50 is 2.5 vs
2.6 ms). The scheduler adds two fibers and an `AbortController` per run. That is microseconds against a git spawn of
several milliseconds.

## Decisions

DECISIONS #406-#410:

- **#406** `LaneSemaphore` rather than Effect's `PartitionedSemaphore` (one pool, no lanes, hash-order rotation), with
  the exact rules of #44; synchronous grants; the grant/interruption race.
- **#407** Every run is a fiber; AbortSignal → interruption; queued vs running outcomes, slot held until exit, dispose.
- **#408** The runner's timers on Effect's `Clock`; unref on the live clock; the test-only `runnerTest.context`; the
  helper client's own timers stay real.
- **#409** No layer or `ManagedRuntime` for the scheduler; per-run cost.
- **#410** Tests: acceptance tests unchanged on the live clock; the property test with the old scheduler as its model;
  the TestClock tests; the stand-in's stderr detail.

## Contract changes

None. `packages/contracts` is untouched. git-core: `GitRunnerOptions.runnerTest` (test-only, additive);
`INTERACTIVE_BURST` now lives in `scheduler.ts` and is re-exported from `runner.ts` (the index export is unchanged).

## Dependencies

None added or removed (`effect` came with #46). `pnpm credits:check` is up to date.

## Known gaps

- **The helper exit watchdog runs on the runner's clock but is not tested on a `TestClock`.** What it does (a PING
  probe, then a SIGKILL of an unresponsive helper) has no step a test clock could gate, so it keeps its live-clock
  tests in `helper.test.ts`, which pass unchanged.
- **The helper client's own timers stay real** (probe wait, group-gone wait, close wait, `reapGroup`). That is
  process supervision, out of #47's scope (DECISIONS #408).
- **`runnerTest.context` is test-only.** The daemon does not hand the runner its runtime's context, so the runner's
  fibers use Effect's defaults (live clock, default scheduler) in production. That is the same behaviour as before.
  Sharing one context is a candidate for #48 (Notes for integration).
- **One equivalent mutant** (dispose without `close`): see Verification.
- **macOS is untested here.** The new tests use POSIX signals, `kill(pid, 0)` and `kill(-pid, 0)` (no `ps`), wait on
  real conditions with 5-20 s deadlines, and the stand-in writes each log line with one `printf`. Only the liveness
  window is bounded by real time (2 × `ABORT_GRACE_MS`), and it can only fail if the process is killed.

## Notes for integration

- DECISIONS #406-#410 may collide with the file-explorer session (#9); renumber as needed. References: PLAN §5.1, this
  report, the `scheduler.ts` module comment.
- No lockfile, packaging or credits change.
- **For #48:** the runner's fibers take a context (`runnerTest.context` today). If the daemon's runtime should own
  them (one clock, one scheduler for the watch pipeline and git), that option is the place to make public; nothing
  else in the runner would change.
