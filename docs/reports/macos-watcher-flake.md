# macos-watcher-flake report

Issue #65: `watcher-review-fixes` > "F5: build-output directories" > "skips build directories that
.gitignore / info/exclude ignore, and only those" failed on roughly half of the `test (macOS, Node 26)`
runs with `AssertionError: expected true to be false`. Branch `fix/macos-watcher-flake`, daemon test
only (no change under `apps/daemon/src`), plus one related Linux flake in F1 found while looping.

## Shipped

- **Root cause: a test race, not a daemon bug** (high confidence, reproduced on Linux; not observed
  on a Mac, see Known gaps). The three failing CI logs I read (jobs 130840171237, 130982665769 and
  130985268349: the `main` run after PR #52, and the runs of #56 and #64) all fail at the same line,
  the *first* probe (`changed(…, 'dist/index.js')`, test line 359), never a later one. That is the
  signature of start-up noise, not of a build directory being watched: a watched `dist/` would fail
  every run on macOS, and the later probes of the same run pass.
  DECISIONS #164(d) (PR #52) already recorded the mechanism: FSEvents replays changes made just
  before a subscription (the fixture's `.gitignore`, `app/.gitignore`, `tools/build/run.sh`, the
  `info/exclude` write) some time after it starts. Those paths are not build directories, so the
  daemon rightly marks the worktree dirty for them (a replayed change may be a real one). The test
  waited a fixed `sleep(300)` before writing its probe and then asked "was `main` dirtied in the next
  500 ms?", so a replay arriving late (plus the 150 ms debounce) landed inside the window and was read
  as the probe's own event. PR #52 fixed F3 and the node_modules test with the same `sleep(300)`,
  which only moved the odds.
- **Reproduction on Linux** with the `subscribe` injection seam: a wrapper that delivers a synthetic
  replay (`.gitignore` create, `info/exclude` update) 600 ms after subscribing, ahead of real events
  (stream order, like FSEvents), run against the old `changed()` helper, fails with the CI's exact
  assertion at the same line (`expected true to be false`, first probe).
- **Fix (`apps/daemon/test/watcher-review-fixes.test.ts`):** no fixed waits. `probe()` orders by the
  stream instead of by time:
  - `settle()` after every subscription writes a file into each stream (worktree root, git dir) and
    polls (10 s deadline) until the watcher has been handed those events; a replay always precedes
    events of later writes, so the replay is over. It then waits one debounce (+50 ms): the timer set
    by any earlier event always expires before a later timer of ours, so every replayed refresh has
    fired.
  - `changed()` writes the probe and then a *quiet barrier*, a file under `app/build/` (ignored by a
    nested `.gitignore` in every layout and by no root rule, so the watcher receives the event and
    drops it without refreshing). Once the barrier is back the probe's event has been handled; one
    more debounce shows whether a refresh was scheduled.
  - `tracking()` records the raw events it hands to the watcher and can simulate the FSEvents replay.
  - The "skips build directories" and "re-subscribes" tests also run in a variant with the simulated
    late replay, so the Linux run covers the macOS ordering. Re-subscription (new `.gitignore` rule,
    new `info/exclude`, `noteTrackedPaths`) replays again, so those tests `settle()` after each one
    instead of `sleep(300)`.
- Sanity check of the new tests: with `#buildVerdict` mutated to never drop (reverted), the negative
  assertions fail, so the barrier does not hide real regressions.
- The read-only guarantee is untouched (tests write only into their temp dirs; no daemon code
  changed).

## Verification

Linux (WSL2, Node 26), from the repo root. The six watcher files are `watch-core`, `watch-host`,
`watch.real-git`, `watcher-backend-errors`, `watcher-review-fixes` and `watcher` (`apps/daemon/test`).

| Command | Result |
|---|---|
| `pnpm --filter @octopus-diff/daemon exec vitest run test/watcher-review-fixes.test.ts` | 20 passed (18 tests before: 2 replay variants added) |
| old `changed()` + simulated 600 ms replay (temporary, reverted) | fails with `expected true to be false` at the first probe, as on macOS CI |
| mutation: `#buildVerdict` never drops (reverted) | the F5 negative assertions fail: the barrier hides nothing |
| `pnpm check` (final) | exit 0: lint, typecheck, build, tests: contracts 93, forge 101 (+5 skipped), git-core 253, fixtures 53, web 254, daemon 266 (+1 skipped), e2e 5, cli 139, scripts 34 |
| the six watcher files × 20, final code (`/tmp/loop20.sh`: vitest, one run after another) | **20 / 20 passed** (54 tests each) |
| same loop, original test file from `cf85c2b` | 20 / 20 passed (the F5 flake is macOS-only in practice) |

Honest note on flakiness seen on the way. Earlier loops of this branch, run while another session was
using the machine, passed 19/20, 17/20 and 18/20. Every failure was a test that is not F5:

- F1 "reports degraded watching after the root is deleted" (4 times), F1 "heals on the fallback poll"
  (2 times): `rm` the worktree folder, `mkdir` it again at once; inotify did not report the delete
  within 5 s. A pre-existing Linux flake under load (PR #52 only handled it on `darwin`), unrelated
  to F5. Reproduced alone under CPU load (12 cores, 12 busy loops): 1 failure in 25 runs of that test.
  The test now waits for the delete before re-creating the folder on every platform (it cannot be
  coalesced when the folder stays absent); 40/40 under 24 busy loops afterwards, and the final loops
  above are clean. The "heals on the fallback poll" failures (2 runs) were not reproduced alone and
  were not changed (it already waits for the delete first); watch it.
- One F5 failure ("keeps watching a build directory re-included by a negation") was mine: the quiet
  barrier directory `app/build/` was created during the test, and inotify can miss a file written
  into a directory the instant it appears. The layout now creates it before subscribing; no F5
  failure in the 40 runs since.

## Decisions

None needed: a test-only change. No `docs/DECISIONS.md` entry was added (other branches use #201-#204
and up; the next free number would be #205).

## Contract changes

None.

## Dependencies

None added or removed (`pnpm credits` not needed).

## Known gaps

- **Not verified on macOS.** There is no Mac here; the cause is established from the CI failure
  pattern (always the first probe), DECISIONS #164(d), and a Linux reproduction of the mechanism, not
  by observing FSEvents. A maintainer with a Mac can confirm in two minutes: run the old test with a
  `console.log(JSON.stringify(events))` in the `onWorktreeEvents` callback and see `.gitignore` /
  `tools/build/run.sh` create events arriving 300 ms or more after `setProject` returns; then run
  the new test ~50 times on the Mac
  (`pnpm --filter @octopus-diff/daemon exec vitest run test/watcher-review-fixes.test.ts`).
  The change relies on one FSEvents property, ordering within one stream (event ids are monotonic per
  stream), which Apple documents.
- **Same fixed-sleep pattern, not changed (not seen failing):** F3's "routes the main worktree's
  submodule git dirs" (`sleep(300)` before `start`, `watcher-review-fixes.test.ts`) and
  `watcher.test.ts` "ignores node_modules, .git internals…"
  (`sleep(300)`). They assert quiet after a fixed wait, so they have the same exposure to a late replay. A follow-up can reuse `tracking()` + a `settle()` like `probe()` (move it to `helpers.ts`).
  The other `idsOf(rec)`-from-zero tests only wait for positives, so a replay cannot fail them.
- **Daemon, observed but out of scope and unrelated to this flake:** `#subscribeWorktree` reads the
  root ignore rules before it subscribes, and `#recheckIgnores` returns early while `st.sub` is
  unset. A `.gitignore` / `info/exclude` edit made between the read and the live subscription is not
  seen by inotify (FSEvents may replay it), so the build-directory ignore list can stay stale until
  the next ignore-file change or re-subscribe. The effect is bounded (watching a directory git
  ignores, or missing nothing). Worth a small follow-up (re-read the rules once after the subscription
  is live and compare the key), not done here.
- The replayed events are never suppressed by the daemon, on purpose: a replayed change may be a
  genuine edit made between reading the worktree and subscribing, and one extra refresh costs little.

## Notes for integration

- Only `apps/daemon/test/watcher-review-fixes.test.ts` (F5 helpers; the F1 root-delete test) and this report change; no merge hazards.
- After merging, watch the `test (macOS, Node 26)` job for a few runs; if F3 or the node_modules test
  start flaking, apply the follow-up above. #65 can be closed once macOS CI has been green for a few
  runs.
