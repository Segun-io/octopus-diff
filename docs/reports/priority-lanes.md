# priority-lanes report (roadmap #44, step 21)

## Shipped

- **Interactive lane in the git runner** (`packages/git-core/src/runner/runner.ts`). `FairScheduler` is now
  `LaneScheduler`: two `FairQueue`s (the old per-repository round-robin), `interactive` and `background`, under the one
  global limit. Queued interactive work starts first. Background work gets the next start after `INTERACTIVE_BURST`
  (4) interactive starts in a row while it waits, so it always gets at least one start in five. No slot is reserved,
  and `concurrency` still means "git processes overall" (DECISIONS #235).
- **Cancellation.** `GitRunOptions.signal`: a queued job whose signal fires leaves the queue and is never spawned. A
  running process gets SIGTERM (to its process group), then SIGKILL after `ABORT_GRACE_MS` (500 ms). The run settles,
  and frees its slot, only once the process has exited. Timeouts and dispose still kill at once (#236).
- **`signal` and `priority` through `GitCore`** (`contracts:` commit, `CallOptions`, #233). `createGitCore`'s guard runs
  each call under `AsyncLocalStorage` (`runner/call-context.ts`), so every git process the call starts gets its lane
  and signal without new parameters inside git-core. A cancelled call rejects at once with `aborted`, even while it
  waits on shared work. A call whose signal is already aborted starts nothing.
- **Shared work is refcounted** (#237). git-core's single-flight reads are `Flight`s: repository discovery, config
  reads, memoized commit facts and the ahead/behind batch. One caller aborting does not cancel them; they are
  cancelled when the last waiter leaves, and dropped before anyone can join a cancelled run. The daemon has the
  same pattern (`apps/daemon/src/flight.ts`: `SharedFlight`, `FlightMap`) for the in-flight changed-file lists
  (`#gitFiles`) and the file origins (`#labelFiles`). A cancelled run caches nothing.
- **Daemon wiring** (`apps/daemon/src/core.ts`, `app.ts`). `/files`, `/diff`, `/commits` and `/blob` pass
  `c.req.raw.signal` and run in the interactive lane. The waits on shared summary and review work are raced against
  the signal. An aborted request answers 499 with no body and gets a debug log instead of an error log (#238).
- **API client and web.** Additive `contracts:` commit (#234): `RequestParams { signal? }` on the client's GET calls,
  passed to `fetch`; an aborted request is `ApiClientError('aborted')`. In `apps/web/src/api`, React Query's `signal`
  is now passed to the files, diff, commits, activity and blob requests (`filesQueryOptions` is shared with the inbox
  patch), so a superseded or unobserved fetch aborts its request (#239).
- **Bench** (`e2e/bench/burst.ts`, budget `burstDiff` < 100 ms p95, #240), documented in `docs/bench/README.md`.

## Verification

All commands run from the repo root on this machine (12-core WSL2, Node 26, git 2.53):

- `pnpm lint`: exit 0 (biome: 488 files, 1 info from an existing file; `credits:check` up to date).
- `pnpm typecheck`: exit 0.
- `pnpm build`: exit 0.
- `pnpm test`: exit 0. contracts 106, forge 101 (5 skipped), fixtures 58, git-core 295, web 360, daemon 373
  (3 skipped), e2e unit 5, cli 139, scripts 34.
- `pnpm test:e2e`: see the end of this section.
- New tests, every one mutation-checked (each fails with the behaviour it guards removed):
  - `packages/git-core/test/lanes.test.ts` (14 tests).
    - Gated stand-in binary: interactive work starts ahead of queued background work; the starvation bound (the
      background job starts after exactly 4 interactive starts); per-key fairness is unchanged; a queued abort
      rejects at once and never spawns; a running process is gone after an abort; SIGKILL after the grace period
      when SIGTERM is ignored (not the 15 s timeout); the slot is held until the process has exited.
    - Real git behind a gated wrapper: an aborted `getFileDiff` stops its `diff` process; a call aborted while queued
      spawns nothing for its repository; shared discovery survives one caller's abort; it is cancelled, and later
      restarted fresh, when its only waiter aborts; an already-aborted call spawns nothing; a call rejects at once
      while it waits on the shared version probe; an interactive diff jumps six repositories' queued summaries.
    - Mutations used: lane forced to background, burst bound removed, queue removal removed, runner abort listener
      removed, SIGKILL escalation removed, settle-on-exit removed, `Flight` computing under the caller's signal,
      `Flight.join` ignoring signals, `maybeCancel` disabled, `onCancel` not dropping the entry, guard pre-check
      removed, `raceAbort` removed.
  - `apps/daemon/test/flight.test.ts` (6), `apps/daemon/test/cancellation.test.ts` (4, fake git-core: one of two
    `/files` waiters aborting neither cancels nor poisons the shared list, which is then cached; the last waiter
    leaving cancels the run, caches nothing, and the next request starts anew; lanes per route, none for the inbox;
    an aborted `/diff` returns 499 with no body), `apps/daemon/test/cancel.real-git.test.ts` (2, real daemon and real
    git: an aborted `/diff` and an aborted `/files` leave no git process group; the daemon still answers).
  - `packages/contracts/test/client.test.ts` (+1: the signal reaches `fetch`, an abort gives `aborted` and not
    `network`, a pre-aborted signal makes no request). `apps/web/test/cache.test.ts` (+1: an invalidation while the
    file list is in flight aborts the old request).
- Bench, `pnpm --filter @octopus-diff/e2e bench` (30 × 3, with the UI): every budget passes. The new budget, diff
  during the burst: p95 44 ms (quiet p50 8 ms; 18 probes; 449 git spawns in the phase). Committed as
  `docs/bench/results.{json,md}`.
- Control runs (`--no-ui --idle-seconds 1 --iterations 2`, 3 runs each, edits back to back), burst p95:
  - with the lane: 28 / 26 / 27 ms;
  - runner locally edited to put every request in the background lane: 218 / 214 / 221 ms.
  - With the edits 20 ms apart, both variants measured 24-69 ms, which is why the bench uses back-to-back edits.
- `pnpm test:e2e`: exit 0, **99 passed (2.9 min)**, including `07-readonly` and the read-only proof (12 control repos, 4265 lock polls, 0 violations). The git-core `readonly.test.ts` passes inside `pnpm test`, and the subcommand allowlist is unchanged (`runner.test.ts`, "allows exactly the PLAN §5.5 subcommands").

## Decisions

DECISIONS #233-#240:

- #233, #234: the two additive contracts commits.
- #235: lanes and the starvation rule.
- #236: runner cancellation and `AsyncLocalStorage`.
- #237: refcounted shared work.
- #238: 499 with no body for aborted requests.
- #239: web signals and the duplicate `files` fetch.
- #240: the bench phase.

## Contract changes

Two separate `contracts:` commits, both additive:

- `GitPriority`, `CallOptions { signal?, priority? }`. `ScopeOptions` now extends `CallOptions`; `listCommits` and
  `readBlob` take `… & CallOptions`. An aborted call uses the existing code `aborted`.
- `RequestParams { signal? }`. `ScopeParams` now extends it; `listCommits`, `getActivity` and `getBlob` params take
  `… & RequestParams`. An aborted request uses the existing client code `aborted`.

Nothing is renamed or removed, and calls without these fields behave as before.

## Dependencies

None added or removed (`pnpm credits:check` up to date).

## Known gaps

- **No priority inheritance.** A shared run keeps the lane of the call that started it. A `/files` request that
  joins a list the inbox started waits in the background lane.
- **The inbox does not take a signal.** In the daemon, its in-flight run and `#buildInbox` do not use one; in the
  web, the inbox and projects queries do not pass React Query's signal (streamed batches).
- **Waits are raced, not cancelled.** `/files` and `/diff` stop waiting for shared summary and review work on abort,
  but that work runs to the end.
- **No diff cache to protect.** The task mentions a daemon diff cache; none exists (`/diff` calls git-core
  directly). #41 should build its cache on `FlightMap`.
- **Duplicate `files` fetch per edit: inferred, not reproduced.** Within one event flush there has been a single
  request since #170. The remaining duplicate is my reading of React Query: a second invalidation while a refetch is
  in flight cancels it and starts another, and before this change the cancelled request kept running. It is now
  aborted (unit test). I did not reproduce the duplicate in a browser.
- **Short gaps go to background work.** An interactive call may lose the slot to one background process between two
  of its own processes (it queues the next one only after parsing the output). This is bounded, and the lane test
  asserts at most one background process per gap.
- **Windows.** Process-group kill is POSIX only, as before; on Windows an abort signals the git process itself.

## Notes for integration

- Merge order does not matter; the two `contracts:` commits are separate.
- DECISIONS numbers #233-#240 may collide with other open branches; renumber at merge if needed.
- `docs/bench/results.{json,md}` were regenerated by this branch's bench run. Re-run the bench after rebasing if
  other perf work lands first.
- New exports: `ABORT_GRACE_MS` and `INTERACTIVE_BURST` from `@octopus-diff/git-core`; `filesQueryOptions` from
  `apps/web/src/api/queries.ts`.
- Web edits are limited to `apps/web/src/api`, plus one test in `apps/web/test/cache.test.ts`. Nothing under
  `components/` was touched.
