# effect-foundation report

Roadmap step 29, issue #46 (tracker #24, milestone M6), decision 1 of #25. Branch `t3/ddbc7073`, on `main` at
`373c76a`. DECISIONS #395-#402.

## Shipped

Effect 4 (`effect@4.1.4`, MIT, no dependencies) in git-core's runner internals and in the daemon, with
`@effect/vitest` for their tests. The long-lived child processes are supervised by scoped Layers in a
`ManagedRuntime` per owner, behind the same Promise APIs as before.

- **`packages/git-core/src/runner/supervisor.ts`**: `makeSupervisor(spec)` is a generic supervisor. Instances start
  lazily, one per slot, each in its own `Scope`. A dead instance reports `died(death)`. The restart policy is an
  Effect `Schedule<RestartDecision, Death>`: its delay is the backoff before the next start, and when it ends the
  supervisor gives up. Closing the supervisor's scope releases every instance, and nothing starts afterwards.
  `restartPolicy({ window, maxDeaths, maxStartFailures, backoff })` is the bounded schedule: a sliding crash window,
  limits, and an exponential backoff that starts over with the window. The policy reads time from Effect's `Clock`,
  so `TestClock` drives it. Synchronous reads (`running`, `canStartNow`, `startNow`) keep the spawn hot path free
  of fibers.
- **Git spawn helpers** (`helper-client.ts`): `HelperPool`'s slots, crash budget and close now go through the
  supervisor. `HelperPool.make(options, policy)` is an Effect constructor, and `gitHelperPoolLayer` /
  `GitHelperPool` provide the Layer. `GitRunner` builds a `ManagedRuntime` over that layer on the first helper spawn,
  and `dispose()` disposes it.
  - Unchanged: the limits (#368), the warning text, `HelperProcess` and the whole failure model.
  - New: after the first death within a minute, the replacement waits 250 ms, doubling up to 2 s. Meanwhile git is
    spawned directly (`startGit` returns null).
- **Watch host** (`apps/daemon/src/watch-host.ts`): `makeWatchHost(options)` builds the host on the supervisor in the
  current scope, and `WatchHostService.layer` is the scoped Layer.
  - A dead host is replaced on the next subscribe: at once the first time within a minute, then after 1 s doubling
    to 30 s. It never gives up.
  - The 60 s subscribe timeout is now `Effect.timeoutOrElse` on the `Clock`.
  - Unchanged: `createWatchHost`, the `WatchHost` interface, the protocol and the messages.
- **The boundary** (`packages/git-core/src/runner/effect-boundary.ts`, exported from git-core):
  - `runGit(runner, args, options)`: interrupting the fiber aborts the run's AbortSignal, and the interruption only
    completes once git has exited.
  - `runAtBoundary(runtime, effect, { signal })`: the signal interrupts the fiber. A typed failure rejects with the
    error itself, an interruption with `GitCoreError('aborted')`, a defect with the defect.
  - `decodeUnknown(schema, input)`: decodes with any Standard Schema, so the contracts' zod schemas work as they are.
- **Daemon runtime** (`apps/daemon/src/runtime.ts`): `makeDaemonRuntime({ logger })` is a `ManagedRuntime` over the
  watch-host layer, plus a logger that writes `Effect.log*` to the daemon's `Logger`. `startDaemon` builds it, hands
  its watch host to the watcher (through `DaemonCore`'s new optional `watchHost`, unless a test injects `subscribe`),
  and disposes it on close. `run()` is `runAtBoundary`.
- **PLAN §5.1** updated.

Commits: `c768574` (deps + credits), `719f34a` (git-core), `511859f` (daemon), plus the docs commit.

## Verification

All commands were run from the repo root on Linux (WSL2, Node 26.13.0, git 2.53.0) unless a line says otherwise.
Every pre-existing test file is unchanged (`git diff 373c76a --stat -- '*.test.ts'` lists only the 4 new files, all added).

| Command | Result |
|---|---|
| `pnpm lint` | pass (4 warnings and 1 info, the same as on `main`); `credits:check` up to date |
| `pnpm typecheck` | pass, 16 packages |
| `pnpm build` | pass |
| `pnpm test` (after build) | pass: contracts 118, forge 101 (+5 skipped), fixtures 58, web 482, git-core 505 (+1), daemon 426 (+4), e2e unit 8, cli 141, scripts 34 |
| git-core, helper on (twice) | 505 passed / 1 skipped, both runs (52.8 s) |
| git-core, `OCTOPUS_DIFF_GIT_HELPER=0` (twice) | 474 passed / 32 skipped, both runs |
| daemon, helper on (twice) | 426 passed / 4 skipped, both runs (26 s) |
| daemon, helper off (twice) | 426 / 4 skipped, then 425 / 5 skipped (the conditional skip below) |
| folding mode `OCTOPUS_DIFF_TEST_FOLDS_CASE=1` | git-core 490 / 16 skipped; daemon 424 / 6 skipped |
| `pnpm test:e2e -- --workers=1` | 106 passed (2.9 min); read-only proof: 12 control repos, 4295 lock polls, 0 violations |
| `pnpm --filter @octopus-diff/web perf:smoke` | exit 0, 6 of 6 checks ok |
| CLI smoke (ci.yml) | `--version` 0.0.0; `doctor`: 0 problems, 1 warning (inotify instances on this machine), git helper ok |
| package job (ci.yml) | tarball installed in an empty directory; `--version`; doctor `git-helper` check ok; `smoke-tarball.mjs`: diff through the daemon ok, 1 helper under the daemon, nothing left after SIGKILL |
| Node 24.22.3 (`node-linux-x64@24.22.3` from the npm registry; there is no Node 24 in mise/nvm here) | tarball doctor + `smoke-tarball.mjs` pass; git-core supervisor, effect-boundary, helper, lanes, runner, no-shell, readonly: 104/104; daemon watch-host, watch-host-supervision, runtime, watcher, git-helper, cancel, watch, integration (real git): 42 passed / 2 skipped |
| `pgrep -a git` before and after every suite | empty; no `--octopus-diff-git-helper` or watch-host process left either |

**New tests** (all pass):

- `packages/git-core/test/supervisor.test.ts`, 12 tests on `TestClock`. Covers policy steps, lazy start, an
  immediate restart and then a backoff that only `TestClock.adjust` ends, give-up, stop vs death, scope close,
  close while waiting.
  - Real git helpers: crash, replacement, a 30 s backoff ended by the test clock, scope close kills the helper.
  - The crash budget gives up, logged once.
- `packages/git-core/test/effect-boundary.test.ts`, 7 tests.
  - Interrupting a running `runGit` SIGTERMs git, and the interrupt returns once git has exited.
  - A SIGTERM-ignoring git gets SIGKILL after `ABORT_GRACE_MS`, and the slot is held until then.
  - Interrupted while queued, it never spawns. The caller's signal still works.
  - `runAtBoundary` signal → `aborted`. Typed failures and defects pass through. `decodeUnknown` with
    `RepoPathSchema`.
- `apps/daemon/test/watch-host-supervision.test.ts`, 3 tests on `TestClock`.
  - Restart at once, then a 1 s backoff (999 ms: nothing; 1 ms more: a new host that delivers events). Scope close
    kills the host, and later subscribes are refused.
  - A stuck host's 60 s timeout ended by the test clock.
  - `close()` does not count as a death.
- `apps/daemon/test/runtime.test.ts`, 3 tests: the boundary with an AbortSignal, logs reaching the daemon logger,
  dispose killing the watch host.

**TestClock before/after (one timer test):**

- Before: `watch-host.test.ts` "kills a host that stops answering" runs a real 500 ms timeout and asserts
  `Date.now() - started < 3000`.
- After: `watch-host-supervision.test.ts` "a stuck host times out on the test clock" keeps the default 60 s. It
  adjusts the clock by 59 s (still pending, host alive), then by 1 s ("did not answer within 60000 ms"), then waits
  for the host to be killed. Nothing is measured in real time.
- The old test stays unchanged.

**Mutation check** of the new supervision and boundary tests: 14 mutants, all killed (`/tmp` script; sources
restored, checked with `git status`).

- **Supervisor:** backoff ignored, never gives up, scope close releases nothing, the crash window never forgets,
  `stop()` counted as a death, `startNow` ignores the backoff.
- **Pool:** `available` ignores the backoff, the pool release does not close helpers.
- **`runGit` / boundary:** interruption does not wait for git, `runGit` drops the fiber's signal, wrong interrupt
  mapping at the boundary.
- **Watch host:** the timeout is not 60 s on the Clock, a death is not reported, the release does not kill.

**Bundle size** (`pnpm --filter octopus-diff run pack:tarball`):

| | before (`main`) | after | growth |
|---|---|---|---|
| CLI tarball | 9 461 344 B | 9 896 452 B | +435 108 B (+4.6 %) |
| bundled `dist/index.js` | 1 895 520 B | 2 064 589 B | +169 069 B (+8.9 %); Effect's share is 150 912 B over 42 modules |
| `dist/index.js.map` | 3 641 574 B | 6 555 256 B | +2.9 MB (Effect's sources) |
| tarball `dist/` unpacked | 51 436 571 B | 54 520 822 B | +3.08 MB (mostly the map) |
| `apps/daemon/dist` / `packages/git-core/dist` | 955 516 / 1 030 705 B | 972 961 / 1 076 711 B | +17 KB / +46 KB |

**Cold start and perf:**

CLI `--version` from the unpacked tarball, median of 15 runs, two rounds: 88.8 / 90.6 ms → 97.3 / 95.6 ms
(+5 to +8 ms).

Default bench (`pnpm --filter @octopus-diff/fixtures bench`, 30 × 3), alternating `main` and this branch, two runs
each:

| Metric | main 1 | branch 1 | main 2 | branch 2 | budget |
|---|---|---|---|---|---|
| first paint, cold | 157 ms | 165 ms | 156 ms | 163 ms | < 3000 ms, all pass |
| first paint, warm (median) | 78 ms | 69 ms | 73 ms | 75 ms | < 300 ms |
| write → SSE p95 | 23 ms | 24 ms | 34 ms | 21 ms | < 1000 ms |
| diff during a 60-edit burst, p95 | 14 ms | 22 ms | 23 ms | 17 ms | < 100 ms |
| startup spawns per worktree | 4.6 | 4.6 | 4.6 | 4.6 | ≤ 8 |
| daemon listening / all summaries | 610 / 725 ms | 663 / 783 ms | 575 / 683 ms | 663 / 782 ms | report only |
| daemon RSS, end of run | 141 MiB | 176 MiB | 140 MiB | 176 MiB | report only |

Every budget passes and edit → SSE is unchanged. The first single runs (before the A/B) were 177 / 209 ms cold,
22 / 23 ms SSE p95.

The bench starts the **unbundled** `apps/daemon/dist`, which costs +45-50 ms and +10 MiB RSS (+5.3 MiB heap) to import.
A 30-repository start leaves +5.6 MiB of heap after GC, which is the import's share. RSS beyond that follows
V8's heap sizing, whose `heapTotal` swings between 27 and 53 MiB from run to run. The **bundled** daemon (as the
tarball ships it) imports +6 ms slower, with +0.8 MiB heap and +3-8 MiB RSS, and its startup is within noise. So
the cost is loading Effect's code, not running it.

## Decisions

All logged in `docs/DECISIONS.md` #395-#402:

- **#395** Layering: Effect only in git-core's runner internals and the daemon; public APIs stay Promise-based; one
  `ManagedRuntime` per owner; per-module imports; synchronous hot paths.
- **#396** The generic supervisor and both restart policies (new: the helper backoff, the watch host's backoff).
- **#397** The error model: typed errors, mapped at the boundary, no `any`; decoding through Standard Schema.
- **#398** Interruption ↔ AbortSignal.
- **#399** Logging through the existing logger.
- **#400** `TestClock` for time, real-condition waits for processes, `it.live` for the runner's grace timer.
- **#401** What is not migrated.
- **#402** The cost.

## Contract changes

None. `packages/contracts` is untouched.

git-core's `index.ts` gained exports (`makeSupervisor`, `restartPolicy`, `SupervisorUnavailable` and their types;
`runGit`, `runAtBoundary`, `boundaryError`, `decodeUnknown`). The daemon gained `DaemonCore`'s optional `watchHost`
and `WatcherServiceOptions.host`. All are additive.

## Dependencies

- Added: `effect@^4.1.4` (dependency of `@octopus-diff/git-core` and `@octopus-diff/daemon`) and `@effect/vitest@^4.1.4`
  (dev dependency of both).
- `pnpm credits` was run in the same commit. The license gate passes: MIT, and `effect` has no dependencies.
- The web app does not import Effect.

## Known gaps

- **Unbundled startup cost.** Dev and bench runs, which load `apps/daemon/dist` from `node_modules`, start about
  60 ms slower and end the bench with about 35 MiB more RSS. The shipped bundle pays about 6 ms and a few MiB. Not
  fixed: lazily importing Effect is not possible where the watch host starts synchronously.
- **New behaviour in two places.** A helper that dies a second time within a minute is replaced after a short
  backoff, and git is spawned directly in the meantime. A watch host that keeps dying waits up to 30 s between
  restarts, and the watcher polls meanwhile. No existing test covers repeated crashes. The new TestClock tests do.
- **A load-sensitive skip that predates this work.** `watch.real-git.test.ts` "through the default watch host: later
  writes below a new subtree are announced" calls `ctx.skip()` when it reads the watcher health before the
  subscription is native. Under full-suite load it skipped on `main` in 2 of 3 runs and here in 3 of 3. In
  isolation it ran 8 of 8 on both trees.
- **Not yet in Effect.** The runner's scheduling and grace timers (so the runner interruption tests use `it.live`),
  the watcher pipeline, the caches, and Hono handlers. Those are #47-#49. The boundary is ready for them, but no
  handler calls the runtime yet.
- **macOS is untested here.** The new tests use POSIX signals and `kill(pid, 0)` checks (no `ps`); the real-helper
  and watch-host tests wait on real conditions with 20 s deadlines.

## Notes for integration

- DECISIONS numbers #395-#402 may collide with the file-explorer session; renumber as needed. The references to
  them are in PLAN §5.1, this report, and comments in `supervisor.ts`, `effect-boundary.ts` and `runtime.ts`.
- `pnpm-lock.yaml` gained `effect` and `@effect/vitest`; re-run `pnpm install` on conflict, then `pnpm credits`.
- No packaging change: `pack.mjs` bundles Effect into `dist/index.js`. `git-helper.js` does not import Effect.
- **For #47:** replace `LaneScheduler` inside `GitRunner` and keep `runGit`'s interruption contract (the
  effect-boundary tests). The runner already owns a `ManagedRuntime`; the scheduler's layer can join the helper
  pool's.
- **For #48:** the watch host's `Supervisor` and `WatchHostService` are the place to hang a `Stream` of events.
- **For #49:** caches can live in `makeDaemonRuntime`'s layer.
