# ci-flakes report

Branch `fix/ci-flakes` (from `origin/main` 421bdc4), PR https://github.com/Segun-io/octopus-diff/pull/3.
Fixes the red CI on `main` (runs 42572487669, 42595070350), PR #1 (42594624346) and PR #2 (42606731213).

## Shipped

- **Watch host** (`apps/daemon/src/watch-host.ts`, DECISIONS #130). `@parcel/watcher` runs in a child Node process
  (`node --input-type=commonjs -e <source> <resolved @parcel/watcher>`, IPC). The daemon never loads the native addon.
  Requests time out after 60 s, and then the host is SIGKILLed and its subscribers get an error. `close()` and a process
  `exit` hook kill it without waiting. It is started with the `WatcherService` (`warm()`). `WatcherService` uses it
  unless `subscribe` is injected.
- **Failed subscriptions** (`apps/daemon/src/watcher.ts`, #131). An error callback marks the subscription dead
  (`#dead`, `#dispose` never unsubscribes it), drops it, polls, and re-subscribes after `resubscribeDelayMs` (1 s,
  doubling to 5 min), then refreshes. This works for worktree and git-dir subscriptions, and for errors that arrive
  before `subscribe()` resolves.
- **Test timeouts** (#133): git-core read-only proof 30 s, `testTimeout: 20_000` in git-core and web.
- **e2e races** (#134): `07-readonly` tolerates `not_found` from `getDiff` on `live-agent` only; `01-projects` waits for
  the picker's Watch action before clicking it.
- PLAN §5.1 / §5.6 lines updated.

## Verification

Root cause, reproduced locally (scripts were in `/tmp`, not committed):
- `tgkill(SIGUSR2)` to the inotify thread of an in-process subscription gives
  `Unable to poll: Interrupted system call` on every subscription. The thread then sits in a futex wait.
- The same `EINTR` while a subscribe of a 45k-file tree is in flight leaves Node's main thread in `futex_do_wait`
  forever (killed by `timeout`, exit 124). This is the CI hang's signature.
- The same scenario through the watch host (signal 33 to the host's inotify thread): the host deadlocks, the parent
  keeps running (33 timer ticks in 3.3 s), the subscribe rejects after the 3 s test timeout, and a new host delivers
  events.

Commands and results:
- `pnpm check`: exit 0. contracts 83, forge 94 (+4 skipped), git-core 170, fixtures 48, web 209, daemon 199,
  e2e unit 5, cli 139 tests passed.
- `pnpm --filter @octopus-diff/daemon exec vitest run test/watcher-backend-errors.test.ts test/watch-host.test.ts`:
  12/12 passed.
- Packed CLI (`pnpm --filter octopus-diff run pack:tarball`, `npm install` of the tarball into an empty directory,
  `octopus-diff serve` on a temp repo): health `watcher.mode = native`, a host child under the daemon, `worktree.changed`
  over SSE after an edit; SIGTERM stops the daemon and the host.
- Full `pnpm test:e2e`: see "e2e runs" below.

### e2e runs

Four full `pnpm test:e2e` runs in a row (`timeout 1500` each, so a hang would show as exit 124), on this machine:

| Run | Exit | Result | Time |
|---|---|---|---|
| 1 | 0 | 83 passed | 3.6 min |
| 2 | 0 | 83 passed | 3.5 min |
| 3 | 0 | 83 passed | 3.3 min |
| 4 | 0 | 83 passed | 3.4 min |

No hang, no failure, and none of the four logs has a `watcher error`, `Interrupted system call` or `watch host
stopped` line. Before this fix, the PR #2 branch completed 1 of 4 full runs here (BLOCKERS), and every CI e2e log had
bursts of `Interrupted system call`.

CI on PR #3: the first run (head 2e4fa25) failed Node 24 only, on `apps/web` `request.test.tsx` "appears only for
worktrees with a request" timing out at 5 s (5.26 s; same class as git-core), fixed in cb48b9d (web `testTimeout`). The
second run (cb48b9d) passed all checks: lint/typecheck/test/build on Node 24 and 26, package, and e2e (83 passed in
5.0 min, 0 watcher errors in the log).

## Decisions

DECISIONS #130–#134 (numbering starts at #130 because PR #2 uses #116 onwards and was still adding entries).
Not done: the native patch (#132), and changing registration to wait for watching to start. Registration has never
waited. `live.test.ts` now waits for `watcher.mode = native` before measuring latency.

## Contract changes

None.

## Dependencies

None added or removed (`@parcel/watcher` stays a daemon dependency, resolved by the host at runtime).

## Known gaps

- The native bug is still there inside the host. It no longer gets `SIGCHLD` (it spawns nothing), and if it ever
  deadlocks, only the host is affected. It is detected by a subscribe timeout (60 s), or never if no subscribe is
  made: a dead host whose subscriptions all reported an error is replaced at the next re-subscribe, which times out
  if the host's JavaScript thread is stuck.
- One extra Node process per daemon (~40 MB RSS).
- UI: the folder picker's two buttons swap actions (and test ids) when a listing arrives. That is a real, if small,
  usability hazard (WS3 follow-up, #134).
- Upstream: worth reporting the `EINTR` bug to parcel-bundler/watcher (not done: outward-facing).

## Notes for integration

- PR #2's BLOCKERS entry (the e2e hang) moves to "Resolved" once this merges. PR #2's unit-test failure is the same
  git-core timeout and goes green after it is updated from `main`.
- `WatcherServiceOptions` gains `resubscribeDelayMs`. `WATCH_DEFAULTS` gains `resubscribeDelayMs`.
