# effect-watch-pipeline report

Roadmap step 31, issue #48 (tracker #24, milestone M6). Branch `t3/42bd744d`, on `main` at `9bf3e6d` (the Effect
foundation #46 / PR #100 and the scheduler #47 / PR #101). DECISIONS #445-#452.

## Shipped

The daemon's watch pipeline (watcher events → coalescing window → summary refresh → fan-out → SSE) runs on Effect's
clock, fibers and `PubSub`, behind the same `WatcherService`, `EventHub` and `Coalescer` APIs. The SSE event
contracts, the wire format and every coalescing rule are unchanged. Each step landed in its own commit, with the old
code removed only once the new code passed the existing tests.

1. **`EventHub` on a `PubSub`** (`apps/daemon/src/events.ts`, commit `89683f5`, DECISIONS #446).
   - Each SSE connection holds a subscription in a `Scope` of its own. The scope is subscribed before the replay
     buffer is read, and the stream's `pull` drains it.
   - The scope is closed when the body stream is cancelled, when the request's `AbortSignal` aborts (new optional
     argument, passed by `app.ts`), when the client is more than 2000 frames behind, or when the hub closes.
   - The heartbeat is a fiber on the hub's clock, running while at least one client is connected.
   - The replay buffer is a ring with the same `Last-Event-ID` and slim-replay rules.
   - In-process listeners stay synchronous.
2. **The pipeline's time source** (`apps/daemon/src/timers.ts`, DECISIONS #445).
   - `Timers` forks and owns fibers on one Effect context; `close()` interrupts all of them.
   - `TimerSlot` replaces `clearTimeout` + `setTimeout`. `unrefClock` is the live clock with unref'd sleeps, so no
     timer holds the process open, as before.
   - A test's `TestClock` drives every timer.
3. **`Coalescer`** (`apps/daemon/src/coalesce.ts`, commit `704ffb9`, DECISIONS #447): a serial consumer fiber with a
   one-slot request buffer. The API and guarantees are the same, and the first run still starts inside `run()`.
   `settleWithin` is on the same clock.
4. **The watcher's timers** (`apps/daemon/src/watcher.ts`, `dirty-window.ts`, `watch-subtree.ts`, commit `299a9a5`,
   DECISIONS #448-#449).
   - `DirtyWindow` is the per-worktree debounce: maxWait, leading edge, `git` wins.
   - Polls, the ignore recheck, the list debounce and the backoffs are `TimerSlot`s.
   - The relist is a jittered `Schedule`.
   - `NewSubtreeWatch` and `ResubscribeGate` run on the watcher's clock.
   - `close()` interrupts everything left. `Date.now()` reads go through the same clock.
   - Follow-ups: `c95f98f` (four tests found by the mutation check), `6da222d` (a failing relist callback no longer
     ends the schedule) and `5fde9cc` (a dropped SSE client's abort listener leaves the request signal).
5. **Docs**: PLAN §5.1, DECISIONS #445-#452, this report.

## Verification

All commands ran from the repo root on Linux (WSL2, 12 cores, Node 26.13.0, git 2.53.0) unless a line says
otherwise. Other agent sessions were active on the same machine throughout, so timings carry that noise.

- **Existing test assertions are unchanged.** `git diff 9bf3e6d --stat -- '*.test.ts'` lists the 4 new files and
  two that were edited:
  - `watcher-backend-errors.test.ts`: all six tests moved to `TestClock`;
  - `watch-new-subtree.test.ts`: the `ResubscribeGate` test and two `NewSubtreeWatch` tests moved to `TestClock`,
    plus one new test.

  In both, the old `expect`s are all still there. Exact checks were added next to two bounds the test clock makes
  exact: the backoff is 100 / 200 ms, the gap is 150 ms.

| Command | Result |
|---|---|
| `pnpm lint` | pass. 4 warnings and 1 info, the same as `main`, none in files touched here. `credits:check` up to date |
| `pnpm typecheck` | pass (2 s) |
| `pnpm build` | pass |
| `pnpm test`, 3 runs | all pass: contracts 118, forge 101 (+5 skipped), fixtures 58, web 482, git-core 527 (+1), daemon 524 (+4), e2e unit 8, cli 141, scripts 34; 90-92 s each |
| git-core, helper on (twice) | 527 passed / 1 skipped, both (47 s) |
| git-core, `OCTOPUS_DIFF_GIT_HELPER=0` (twice) | 496 passed / 32 skipped, both (49 s) |
| **daemon suite under 8 busy loops** (started and killed by PID file) | **20 of 20 runs pass**: 10 with the helper on (525 / 3 skipped, once 524 / 4), 10 with it off (523 / 5, once 524 / 4); 26-27 s each |
| folding mode `OCTOPUS_DIFF_TEST_FOLDS_CASE=1` | git-core 512 / 16 skipped. Daemon: the first run failed once (below), then 2 of 2 passed (522 / 6 skipped) |
| watch-related real-fs and real-git files, 20 runs | **20 of 20 pass** (93 passed / 3 skipped each). Files: `watch.real-git`, `event-deltas.real-git`, `incremental.real-git`, `status-flow.real-git`, `watcher`, `watcher-review-fixes`, `watch-paths`, `watch-new-subtree`, `watch-core`, `live` |
| `watcher-review-fixes.test.ts` ×30 under 8 busy loops, branch and `main` | 0 failed runs on either tree |
| `pnpm test:e2e` (`playwright test --workers=1`) | 106 passed (2.9 min), twice. Read-only proof: 12 control repos, 4269 lock polls, 0 violations |
| e2e `04-live-updates` ×20 (`--repeat-each=20 --workers=1`) | 120 of 120 passed (4.8 min) |
| `pnpm --filter @octopus-diff/web perf:smoke` | exit 0 |
| CLI smoke (ci.yml) | `--version` 0.0.0; `doctor`: 0 problems, 1 warning (inotify instances on this machine) |
| package job (ci.yml), Node 26 and Node 24 | tarball installed in an empty directory; `--version`; doctor `git-helper` ok; `smoke-tarball.mjs`: diff through the daemon ok, 1 helper, nothing left after SIGKILL |
| Node 24.22.3 (`node-linux-x64@24.22.3` from the npm registry) | 17 daemon files (events, events-pubsub, coalesce, watch-timers, watcher-backend-errors, watch-new-subtree, watcher, watcher-review-fixes, watch-paths, watch.real-git, event-deltas, incremental, live, watch-host, watch-host-supervision, runtime, integration): 202 passed / 3 skipped |
| `pgrep -a git`, helper and watch-host processes after the suites | none left; busy loops gone |

**The one red run** was the first folding-mode daemon run. It failed `watcher-review-fixes.test.ts` "heals on the
fallback poll ...", which timed out at line 250. That line waits for the inotify delete event of an `rm`ed worktree
root, before any timer is involved. The neighbouring test's comment already names this race as a rare Linux flake
("inotify can lose the race too when the machine is busy"). In this session it showed up twice in about 120 runs of
that file, both in full-suite runs (the other one is described below). The file then passed 30 of 30 on this branch
and 30 of 30 on `main` under 8 busy loops, and 2 of 2 folding-mode reruns passed. It is pre-existing and not caused by
this change: `main` has the same test and the same code path up to that line.

**The varying skip count** is `watch.real-git.test.ts` "through the default watch host ...". It calls `ctx.skip()`
when `/api/health` is not yet `native` right after `isWatched`, which turns true before the host's subscription
completes. Under 8 busy loops with the helper off, it skipped in 9 of 10 runs on this branch and 4 of 5 on `main`;
with the helper on, 1 of 10 here. This predates the change (the foundation report has it too), and the watcher's
subscribe path is unchanged.

**New tests** (all pass):

- `events-pubsub.test.ts`: 7 tests.
  - The heartbeat on `TestClock`: nothing at 14 999 ms, a ping at 15 000 ms, stopped with the last client.
  - A stalled client is dropped at `maxQueuedFrames` while a fast one gets all 100 events in order, and the dropped
    one gets its gap from the replay buffer on reconnect.
  - The request signal's abort releases the subscription; an already aborted signal never subscribes; the listener
    leaves the signal.
  - Slim replay vs full live frames, and ids in order across a batched burst.
  - `close` interrupts every fiber.
  - **1000 SSE connect/disconnect cycles over HTTP** (cancel and abort, half with a pull in flight): 0 clients,
    0 open subscriptions, 0 fibers, no ref'd timers above the baseline, heap growth < 8 MiB after GC. The same for
    1000 in-process stream cycles.
- `coalesce.test.ts`: 45 tests.
  - The differential test against the old `Coalescer`: 40 random seeds × 120 steps of requests and completions.
  - Synchronous start, the follow-up guarantee, a request made in the reaction to a run's end, close, `settleWithin`.
- `watch-timers.test.ts`: 43 tests on `TestClock`, except one live-clock test.
  - The coalescing window: debounce exact to the millisecond, maxWait, leading edge (also while armed), reason
    precedence, path hints and their limit, focus.
  - Polls: idle and focused, re-armed by every refresh, degraded, ±25 % jitter drawn per poll.
  - The relist `Schedule`, with jitter per recurrence and its teardown on `removeProject`.
  - The list debounce, the backoff with its 10-minute streak reset, close.
  - On the live clock: no timer holds the process open, and none is left after close.
  - **The differential test** of `DirtyWindow` against the old inline debounce: 30 seeds × 150 steps.

**Mutation check:** 41 mutants, applied one at a time, each with its tests run, sources restored and checked with
`git status`.

- **Hub, 11 mutants: 9 killed, 2 equivalent.**
  - Killed: scope not closed, heartbeat never stops, no slow-client drop, heartbeat on `setTimeout`, heartbeat 1 ms
    late, request signal ignored, replay keeps the full event, replay off by one, ring keeps the oldest.
  - Equivalent: the waiting pull is not interrupted on drop (unsubscribing already ends it); `close` does not close
    the timers (it already drops every client and stops the heartbeat).
- **Abort listener left on the signal**: killed.
- **Coalescer, 7 of 7 killed**: no follow-up, one run per request, a first run after a yield, a failure stops the
  loop, callers resolved early, interrupted callers left waiting, `settleWithin` without a timer.
- **Watch pipeline, 22 of 22 killed.** Four of them survived at first and their tests were added in `c95f98f`: a
  leading edge while armed, the relist kept after `removeProject`, the new-subtree maxWait, the backoff on the real
  clock. The others:
  - the window: maxWait ignored, `git` not winning, the last reason winning, the leading edge ignoring the last fire;
  - a fire not counted for the leading edge, the poll not re-armed, no jitter, relist recurrences without jitter,
    the relist without its first delay;
  - close leaving timers, no backoff doubling, the degraded poll at the normal rate, the path limit off by one;
  - timers: ref'd live sleeps, the unref clock ignoring the duration, close interrupting nothing, `TimerSlot` not
    replacing;
  - the re-subscribe gate without its gap.

**Bench.** Default (`pnpm --filter @octopus-diff/e2e bench`, 30 × 3 with the UI), alternating `main` (`9bf3e6d`, its
own worktree and build) and this branch, two runs each. The branch build was `6da222d`; `5fde9cc` only removes an abort
listener when a client is dropped. Every other row of the table above ran on `5fde9cc` or later:

| Metric | main 1 | branch 1 | main 2 | branch 2 | budget |
|---|---|---|---|---|---|
| write → SSE p50 / p95 | 13 / 21 ms | 14 / 22 ms | 13 / 21 ms | 14 / 22 ms | p95 < 1000 ms |
| write → UI sidebar p95 | 30 ms | 32 ms | 29 ms | 30 ms | < 1000 ms |
| daemon listening / all summaries | 617 / 728 ms | 632 / 744 ms | 651 / 755 ms | 639 / 740 ms | report only |
| startup spawns per worktree (git wall summed) | 4.7 (1078 ms) | 4.6 (1113 ms) | 4.6 (1082 ms) | 4.6 (1083 ms) | ≤ 8 |
| idle CPU, daemon + git | 0.15 % | 0.15 % | 0.13 % | 0.17 % | < 10 % |
| first paint cold / warm | 148 / 69 ms | 143 / 69 ms | 149 / 67 ms | 146 / 64 ms | < 3000 / < 300 ms |
| diff during a 60-edit burst, p95 | 26 ms | 18 ms | 27 ms | 24 ms | < 100 ms |
| browser traffic per edit (worst edit, #51) | 1453 B | 1453 B | 1452 B | 1453 B | < 100 KiB |
| `/api/projects` requests per edit | 0 | 0 | 0 | 0 | < 1 |
| daemon RSS end / peak | 180 / 181 MiB | 177 / 177 MiB | 178 / 179 MiB | 152 / 169 MiB | report only |

Paged bench (`bench:paged`, the browser's `/api/*` traffic for one edit), alternating, two runs each: one edit is
23.2 KiB in 3 requests in all four runs. Opening the worktree took 177 / 112 / 110 ms (cold / warm / from another
worktree) on `main` 1, 177 / 114 / 115 on the branch 1, 172 / 113 / 116 on `main` 2 and 154 / 118 / 110 on the
branch 2.

Every budget passes in all runs. Edit → SSE, startup, idle CPU and traffic per edit are identical within noise (±1 ms
p95, ±20 ms startup, the same bytes and requests per edit).

## Decisions

All logged in `docs/DECISIONS.md` #445-#452:

- **#445** Effect clock and fibers, not `Stream` operators, and why: no maxWait or leading edge in `Stream.debounce`,
  and the leading edge must fire inside `markDirty`. Covers `Timers` / `TimerSlot` / `unrefClock`, a zero wait that
  still yields on every clock, and the test-only options.
- **#446** `EventHub` on `PubSub`: scoped subscription per connection, release paths, slow-client policy counted in the
  subscription's backlog, heartbeat fiber, synchronous listeners.
- **#447** `Coalescer` as a consumer fiber; the one timing difference (the follow-up starts at once).
- **#448** `DirtyWindow` with the old rules; "never fired" is `-Infinity`.
- **#449** The watcher's timers: polls as slots (not a `Schedule`), the relist `Schedule` with ±25 % jitter, the
  backoff function, close.
- **#450** Which tests moved to `TestClock` (assertions unchanged), which are new, which stay real-time, and why.
- **#451** Not migrated: `DaemonCore`'s own intervals (left alone because PR #99 edits `core.ts`), the forge timers,
  the watch host protocol.
- **#452** Cost.

## Contract changes

None. `packages/contracts` is untouched, and so are the SSE event types, ids, replay, heartbeat and the HTTP API.

The daemon gained additive, internal options: `EventHub.createStream(hello, lastEventId, signal?)`,
`EventHubOptions.context`, `EventHub.diagnostics`, `WatcherServiceOptions.context`, `WatcherService.pendingTimers` /
`busy`, `NewSubtreeWatchOptions.timers`, `NewSubtreeWatch.busy`, `ResubscribeGate(gap, timers?)`, and
`Coalescer(fn, { timers? })`. They are not in the contracts.

## Dependencies

None added or removed. `PubSub`, `Schedule`, `Scope` and `TestClock` come from `effect@4.1.4` /
`@effect/vitest@4.1.4`, which were already dependencies. `pnpm credits:check` is up to date.

## Known gaps

- **Not `Stream` operators.** The stages are our own small combinators on Effect's clock, fibers, `Schedule` and
  `PubSub` (DECISIONS #445). `Stream.debounce` has no maxWait and no leading edge, and a fiber-driven emit would
  break the synchronous leading edge that focus and the spawn counts rely on.
- **`DaemonCore`'s own timers are still `setInterval` / `setTimeout`**: GC, the missing-project retry, the
  `review.ready` batch. So daemon-level tests (`watch-core.test.ts`, `incremental-core.test.ts`) stay real-time.
  `core.ts` was left alone because PR #99 edits it. #49 can move them onto `Timers`.
- **Real-time on purpose:** every test driven by real `@parcel/watcher` events or real processes (list in DECISIONS
  #450). Their timing sensitivity is the file system's, not ours. `watch-paths.test.ts` and the file-event half of
  `watch-new-subtree.test.ts` would need a fake subscribe to move, which would stop them from testing the real
  backend.
- **Pre-existing load-sensitive tests**, seen here and on `main`:
  - the `watcher-review-fixes` root-delete race: two failures in about 120 runs of that file in this session, both
    in full-suite runs, none in 60 isolated runs under load (30 per tree);
  - the conditional skip in `watch.real-git.test.ts` (it reads health before the host's subscription is native).

  Neither is caused or fixed here.
- **The slow-client threshold is now counted in the subscription's backlog** instead of the `ReadableStream`'s
  queue. It is the same number (2000 frames) for the same situation (a stalled socket), but frames are sent to the
  socket in batches.
- **macOS is untested here.** The new tests use no fixed sleeps and wait on real conditions or the test clock. The
  live-clock leak test relies on `process.getActiveResourcesInfo()`, which macOS Node has too.

## Notes for integration

- DECISIONS numbers #445-#452 follow the scheduler's #440-#444. The file-explorer session (PR #99) may take
  the same numbers: renumber as needed. They are referenced in PLAN §5.1, this report, and comments in `timers.ts`,
  `events.ts`, `coalesce.ts` and `dirty-window.ts`.
- `core.ts` is untouched, so PR #99 does not conflict with it. `app.ts` changed one call (the SSE route passes the
  request signal). `daemon.ts` is unchanged.
- **For #49:** `Timers` is the place for the core's own intervals and for cache TTLs on the same clock. A
  `DaemonCore` option handing a context to the watcher and the hub would let daemon-level tests (`watch-core`) use
  `TestClock` too.
