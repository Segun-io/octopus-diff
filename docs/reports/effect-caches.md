# effect-caches report

Roadmap step 32, issue #49 (tracker #24). Branch `t3/8dfae31d`, on `main` at `2d10910` (after the Effect watch
pipeline, #48). DECISIONS #453-#457.

## Shipped

1. **`StateCache`** (`apps/daemon/src/state-cache.ts`, commit `89cf2ea`, DECISIONS #453-#454) on `effect/Cache`. It
   replaces `#filesCache` + `#filesInflight` (`FlightMap`) and the per-worktree `rangeCache` in `core.ts`.
   - Same keys (worktree, scope, `stateHash`, base commits, attributes stamp; ranges: worktree, HEAD, bookmark), same
     one-entry-per-(worktree, scope) and 2000-entry bounds (a completed lookup drops the group's older states), same
     invalidation points, same refcounted cancellation (last waiter leaving aborts the computation's signal; a waiter
     without a signal pins it; an aborted waiter rejects with `aborted` at once).
   - New: an invalidation during a lookup in flight keeps its result out of the cache (before, the run `set` it after
     the entries were dropped).
   - Hit / miss / in-flight-join counters: `StateCache.stats()`, `DaemonCore.cacheStats()`.
2. **Bench counters** (`e2e/bench/daemon-child.mjs`, `bench.ts`, commit `d16f376`, DECISIONS #455): the bench prints
   them and writes them to `results.json` / `results.md`. `docs/bench/results.{json,md}` were regenerated (commit
   `7cc218a`).
3. **`DaemonCore`'s own timers on the shared clock** (commit `4e0d959`, **separate and droppable**, DECISIONS #456): GC,
   the missing-project retry, the `review.ready` batch and the reconcile timer are `Timers` fibers (`Timers.every` is
   new). `CoreOptions.context` / `DaemonInternals.context` hand a test's `TestClock` to the core, the watcher and the
   hub.
4. **Tests**: `caches.test.ts` (18), `state-cache.test.ts` (15), `caches.real-git.test.ts` (5), `core-timers.test.ts`
   (2, on `TestClock`). No assertion of an existing test changed.

## Verification

Linux (WSL2, 12 cores, Node 26.13.0, git 2.53.0). Other sessions were using the machine.

| Command | Result |
|---|---|
| `pnpm lint` | pass (4 warnings, 1 info: the same as `main`, none in files touched here). `credits:check` up to date |
| `pnpm typecheck` | pass |
| `pnpm build` | pass |
| `pnpm test` | pass: contracts 135, forge 101 (+5 skipped), fixtures 58, web 496, git-core 556 (+1), daemon 609 (+3), e2e unit 8, cli 141, scripts 34 |
| daemon suite, 3 extra runs | 3 of 3 pass: 608 passed / 4 skipped, 59 files, about 27 s each. No red run, no flake seen |
| `pnpm test:e2e` (`--workers=1`) | 106 passed (2.9 min). Read-only proof: 12 control repos, 4304 lock polls, 0 violations |
| `pnpm --filter @octopus-diff/web run perf:smoke` | exit 0 |
| `pgrep -a git` after the runs | none left |

**Failing-first.** `caches.test.ts` was run on the old code before the change: "an invalidation while a lookup is in flight
never lets its result into the cache" (a repeat request was a cache hit with the stale list), the two bounds tests (the
old code ignores the size knob) and the counter tests failed; the other 11 (share, abort, keys, invalidation points)
passed on the old code too, so they pin the behaviour that had to stay.

**Mutation check**: 37 mutants applied one at a time, each run against the cache tests (`caches`, `state-cache`,
`caches.real-git`, `cancellation`), sources restored and checked with `git status`. **34 killed, 3 survive** (also against
the whole daemon suite), none reachable from a test (DECISIONS #457):

- Killed: each key piece (`stateHash`, base, attributes, scope, worktree; range: HEAD, bookmark, worktree); the
  invalidation of a refresh, of a default-branch override, of a detected default-branch change, of a removed worktree,
  and the group / prefix invalidation (also the prefix without its separator); the store conditions (cacheable,
  `summaryState === asked`, unreachable range); the bounds (capacity unbounded, one-per-group off, a sibling drop
  that also drops a pending lookup, no LRU touch on a hit); failures cached, unstored results cached, invalidation
  that spares pending lookups; the abort rules (computation signal never aborts, waiter signal not passed, the
  aborted waiter not rejected at once, an already aborted signal still computing); `#cachedPaths` ignoring the
  attributes stamp; and 4 timer mutants (GC and retry removed or swapped periods).
- Survived: the invalidation in `#markMissing` (the cache is empty when a stored project is found missing at startup),
  the `project.worktrees.get(id) === entry` store condition (the removal's invalidation already drops that worktree's
  pending lookups), and `hit ||` in `#gitFilesAt` (equal to the `summaryState` check for any caller with the same
  `stateHash`; it keeps the old "a hit is always the summary's list").

**Bench** (`pnpm --filter @octopus-diff/e2e run bench`, 30 × 3 with the UI), alternating `main` (`2d10910`, its own
worktree and build) and this branch (`a34445e`'s sources, built), two runs each:

| Metric | main 1 | branch 1 | main 2 | branch 2 | budget |
|---|---|---|---|---|---|
| write → SSE p50 / p95 | 13 / 24 ms | 13 / 23 ms | 14 / 21 ms | 14 / 21 ms | p95 < 1000 ms |
| write → UI sidebar p95 | 38 ms | 32 ms | 35 ms | 29 ms | < 1000 ms |
| daemon listening / all summaries | 657 / 752 ms | 655 / 753 ms | 634 / 739 ms | 655 / 752 ms | report only |
| startup spawns per worktree (git wall summed) | 4.6 (1116 ms) | 4.6 (1135 ms) | 4.6 (1100 ms) | 4.6 (1108 ms) | ≤ 8 |
| idle CPU, daemon + git | 0.20 % | 0.17 % | 0.15 % | 0.17 % | < 10 % |
| first paint cold / warm | 154 / 63 ms | 152 / 66 ms | 141 / 68 ms | 147 / 69 ms | < 3000 / < 300 ms |
| diff during a 60-edit burst, p95 | 25 ms | 25 ms | 19 ms | 51 ms | < 100 ms |
| browser traffic per edit (worst) | 1452 B | 1453 B | 1452 B | 1451 B | < 100 KiB |
| `/api/projects` requests per edit | 0 | 0 | 0 | 0 | < 1 |
| daemon RSS end / peak | 150 / 166 MiB | 175 / 175 MiB | 174 / 174 MiB | 179 / 179 MiB | report only |

All budgets pass in all four runs. Edit → SSE, startup spawns, idle CPU, paint and traffic are the same within noise.
Two things to read carefully: the burst p95 of branch 2 (51 ms) is one outlier above the other three (19-25 ms) and
still half the budget; and RSS on the branch is 1-5 MiB above the `main` runs of the same position (175 / 179 vs
150 / 174 MiB), inside the spread `main` itself shows between its two runs (24 MiB).

Paged bench (`bench:paged`), alternating, two runs each: one edit is 23.2 KiB in 3 requests in all four runs; cold list
2041 / 2069 / 2064 / 2072 ms (main1, branch1, main2, branch2), warm 8-9 ms, inbox 80 / 83 / 85 / 82 ms; the app opened
on the worktree 161 / 163 / 177 / 172 ms cold, reload 117 / 82 / 125 / 82 ms.

**Cache counters** (identical in both branch runs, so deterministic): file lists 1344 hits / 359 misses / 0 in-flight
joins, 270 entries of 2000; review ranges 4 hits / 100 misses / 0 joins, 40 entries. A range is kept only once the
bookmark exists, so most first computations are misses by design.

## Decisions

All in `docs/DECISIONS.md` #453-#457: `StateCache` and its keys, bounds and cancellation (#453); the two deliberate
differences (an invalidated in-flight lookup is not stored and not joined later; pending lookups count toward
`capacity`) (#454); counters and the one edit outside `apps/daemon` and `docs` (`e2e/bench`) (#455); the core timers
(#456); tests and the mutation tally (#457).

## Contract changes

None. `packages/contracts` is untouched; the counters have no route, event or field.

## Dependencies

None added or removed (`effect@4.1.4` was already there). `pnpm credits:check` is up to date.

## Known gaps

- `#inboxInflight` (the inbox single-flight) and the file-origins cache (`SharedFlight`) are still hand-written; the
  issue named only the file-list and range caches. `FlightMap` is no longer used by `core.ts` but stays with its tests.
- The range cache drops an old range only when a new one is stored (the old field was also cleared by an unreachable
  one): a little more kept, still one per worktree.
- Pending lookups count toward `capacity` (`Cache` behaviour). It takes more than 2000 distinct concurrent lookups.
- Daemon-level tests that depend on real watcher events or real git (`watch-core.test.ts`, `incremental*.test.ts`,
  the real-git review tests) stay on the live clock; the `review.ready` batch and the reconcile timer are exercised
  only that way. The new `TestClock` tests cover the GC and the missing-project retry.
- A throwing callback in a core timer now ends its fiber instead of crashing the process (DECISIONS #456); none of the
  callbacks throws.
- macOS untested here. The timers tests use the test clock, the cache tests no fixed sleeps except short settle
  waits (`sleep(60)`) where a negative ("nothing started") is asserted.

## Notes for integration

- DECISIONS #453-#457 follow #452 (the watch pipeline). The scheduler and watch-pipeline sessions are merged on `main`;
  renumber only if another session took the same numbers.
- Commit `4e0d959` (core timers) is independent: dropping it also means dropping `core-timers.test.ts` and the
  `internal.context` lines it adds (`daemon.ts`, `core.ts`), and DECISIONS #456.
- `e2e/bench` is outside this stream's own paths (WS4); the edit is small (SIGUSR2 + a stats file in the bench child,
  two result rows) and listed in #455.
- `docs/bench/results.{json,md}` come from one branch run (branch 1). `results-paged` is not regenerated (the paged
  bench prints no counters).
