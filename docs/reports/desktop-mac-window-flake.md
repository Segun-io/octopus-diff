# desktop-mac-window-flake report

The packaged-app e2e test "the window shows projects added with `octopus-diff add`…"
(`e2e/desktop/packaged-app.spec.ts:141`) failed now and then on macOS CI. The backend was ready, but the window never
showed the web UI. Branch `fix/mac-window-flake` (pushed only to run CI; no PR). DECISIONS #590-#596.

## Root cause

**Not proven.** The flake did not reproduce in 110 macOS launches on CI: 55 with the old load behaviour (plus the new
logging) and 55 with the fix (#596). Here is what is known and what the code allows (#590):

- **Shape (a)** (run 43549571166, job 132308645529, a branch on current main). The backend was ready and the CLI and
  the API worked within ~6 s. For the next 60 s, though, the window's only page was a `data:` screen. The old error
  printed 60 characters of the URL, which are the same for every screen, so it is not known which screen it was.
- **Shape (b)** (run 43542879523, jobs 132287236484 and 132289934396, PR #110's branch). The page was on the daemon's
  origin, but `data-ready` stayed false. It failed **2 of 2** while that branch gave the app a fake `HOME`, and
  passed once it stopped (that branch's DECISIONS #581: a fake HOME breaks Chromium's Keychain and `~/Library`).
  That is a deterministic cause of its own, not this flake.
- **Baseline rate on main** (the mac desktop job, 2026-11-13/14): 1 failed out of 11 completed runs (shape a).
  Linux and Windows: none.

Candidates for shape (a), with the evidence for each:

1. **A UI load ending in `ERR_ABORTED` with nothing replacing it** (most likely, and a real hole whatever the
   trigger). `showReady` dropped every `ERR_ABORTED` as "superseded" (`isSupersededLoad`) and logged nothing. The
   starting screen then stayed up for good, which matches (a) exactly. **Fixed (#591)**, with a failing-first test.
2. **A UI navigation that never commits.** `loadURL` has no timeout, so the window keeps the previous page and
   nothing is logged. This also matches (a). **Mitigated (#594)**: a 20 s commit watchdog retries the load.
3. **The git-missing screen** after a transient `git --version` failure in the daemon's first health answer
   (`health()` reports `supported: false` for any error, and a later call re-probes). The test's own health check
   later saw git as supported, which is consistent with this. **Not changed**: the next failure will show it as
   `daemon health answered … (git missing)` together with the screen's text.
4. **The failure screen** after a load error other than an abort. That case was logged, but no artifact had the
   log. **Mitigated**: 3 attempts before the screen.

Ruled out from the code:
- The navigation guard: `will-navigate` and `will-frame-navigate` are not emitted for `loadURL`, and the daemon does
  not redirect `/`.
- `second-instance`: the CLI runs as Node, not as a second app instance.
- `activate`: it only creates a window when there is none.
- The token in the hash: the page strips it after the load.
- `ready`/`uiOrigin` ordering: `uiOrigin` is set before `loadURL`, and the guard is not consulted for `loadURL`.

## Shipped

- `apps/desktop/src/ui-load.ts` (new, pure):
  - `LoadSequence`: every window load (a screen or the UI) takes a ticket, and the newest ticket is the load the
    window wants.
  - `UiLoad`: superseded means a newer ticket exists, never an error code. A load with no committed page within
    20 s is retried; a failed or stalled attempt is retried after 1 s, up to 3 attempts, then the failure screen.
    After the commit, the watchdog is off.
  - `urlForLog`: origin only.
- `apps/desktop/src/main.ts`:
  - `showReady` uses `UiLoad`, and `showScreen` takes tickets.
  - The window's lifecycle goes to `daemon.log` (#592): screens, `did-navigate` (origin and HTTP status),
    `did-fail-load`, `did-finish-load`, the renderer gone or unresponsive, ready-to-show, the first show, the health
    check's time and git status, `showReady`'s early returns, every UI load attempt, and `activate`.
  - `second-instance` and later shows are not logged: `smoke-app` checks that a second launch leaves the log as it
    was.
- `apps/desktop/src/policy.ts`: `isSupersededLoad` removed, `netErrorName` added.
- `e2e/desktop/support/diagnostics.ts` (new) and `withWindowDiagnostics` / `windowDiagnostics` in `packaged-app.ts`:
  - When a window wait times out, the thrown error carries: whether the app is alive; each page's URL without query
    or fragment; a screen page's decoded text; for any page its `readyState`, `visibilityState`, `hasFocus`,
    `data-ready` and visible text; the last 40 `[desktop]` lines and 25 daemon lines of `daemon.log`; and the app's
    stdout/stderr tail. Everything is redacted.
  - On success the spec prints the window timeline and annotates whether a retry was needed.
- `e2e/desktop/support/cdp-pipe.ts`: `page()` no longer prints 60 characters of each page URL. For a UI page that
  is `…/#token=` plus about 30 characters of the token, in a public CI log.
- `e2e/desktop/window-repeat.spec.ts` (new, opt-in): `OCTOPUS_DESKTOP_WINDOW_REPEAT=<n>` launches the app n times
  under the main test's load (read-only proof, agent simulator, every project and scan root added) and counts
  launches that never reached the UI, and launches that needed a retry.
- Tests:
  - `apps/desktop/test/ui-load.test.ts` (16 tests) and a `netErrorName` test in `policy.test.ts`.
  - `e2e/support/desktop-diagnostics.test.ts` (10 tests).
  - `apps/desktop/scripts/mutation-check.mjs`: 8 new mutants.
- Docs: DESKTOP.md §3.3 (loading the UI, the window log); DECISIONS #590-#596.

## Verification

- **Failing first:** `npx vitest run test/ui-load.test.ts`, run against the module with the old rule
  (`code === 'ERR_ABORTED'` means superseded): **1 failed, 15 passed** ("retries an ERR_ABORTED load that no newer
  load replaced"). With the fix: **16 passed**.
- `node apps/desktop/scripts/mutation-check.mjs`: first run **65 killed, 1 survived** (dropping the own-ticket
  check; the watchdog test was tightened); then **66 killed, 0 survived (of 66)**, ~33 s.
- `pnpm check` (lint, typecheck, build, test) on the fix: **exit 0**, 2 min 17 s.
  - apps/desktop: 123 passed, 1 skipped.
  - e2e unit tests: 18 passed.
  - daemon 610, git-core 556, web 512, cli 174, contracts 138, forge 101, fixtures 59.
  - Lint shows 4 warnings and 1 info, all in daemon and web test files this work does not touch.
- Packaged app on Linux here (WSLg `DISPLAY=:0`, `pnpm --filter @octopus-diff/desktop run package -- --dir`):
  - `pnpm --filter @octopus-diff/e2e test:e2e:desktop`: **4 passed** before the change and **4 passed** after it.
  - Window repeat with `OCTOPUS_DESKTOP_WINDOW_REPEAT=3`, then `=2` under the heavier load: all reached the UI.
  - Healthy timeline: the UI loads ~155 ms after ready and commits ~22 ms after the load starts.
- Diagnostics were checked by forcing a page wait to fail (a throwaway edit, reverted). The error showed the page
  URL without its fragment, the document state, the visible text and the app log tail. `grep -i token` over the
  whole output: nothing.
- Unpackaged smokes here (`LD_LIBRARY_PATH` set to the extracted Chromium libraries):
  - `smoke:backend`: all scenarios passed.
  - `smoke:app`: it first **failed** "the second instance did not touch the first one's log", because the new
    `second-instance` and `show` notes were written to the log. After the fix (log only the first show, not
    `second-instance`): all scenarios passed. CI's Linux job caught the same failure on the first baseline run.
- **macOS CI** (each mac desktop job = the main window test + 10 repeat launches = 11 launches):

  | Series | Commit | Run (attempts) | Mac jobs | Launches reaching the UI | Retries |
  |---|---|---|---|---|---|
  | Baseline, light repeat | e49c44c | 43551517012 (1) | 1/1 green | 11/11 | n/a |
  | Baseline, repeat under load | 73bd016 | 43552538442 (1-4) | 4/4 green | 44/44 | n/a (no stall or abort note) |
  | Fix | bf53065 | 43554882456 (1-5) | 5/5 green | 55/55 | 0 |

  Every other job of 43552538442 and 43554882456 was green (Linux, Windows, check, e2e, macOS test). Run
  43551517012's Linux desktop job failed on the `smoke-app` log check described above.
  - macOS timings: health answers in 150-350 ms, and the UI page commits 90-170 ms after the health answer.
  - Each repeat launch takes ~3 s with the light load and ~5 s with the main test's load.

## Decisions

All in DECISIONS #590-#596:
- #590: the symptom and the candidates.
- #591: superseded by load sequence.
- #592: the window log.
- #593: self-diagnosing waits, and the token leak fix in `page()`.
- #594: 3 attempts and a 20 s commit watchdog.
- #595: the opt-in window-repeat spec.
- #596: the measurements, and why the change stays without a proven cause.

## Contract changes

None.

## Dependencies

None added or removed (`pnpm credits:check`: up to date).

## Known gaps

- **The root cause is unverified.** The flake did not occur in 110 launches across 10 mac jobs. With 0 of 55 in
  each series, the per-launch rate is below ~5% in both, so "after" cannot be shown to be better than "before". The
  fix closes candidates 1, 2 and 4 (recovery in ~21 s instead of never). Candidate 3 (git-missing after a transient
  git failure) is only made visible.
- If the root cause is something the retry also hits (e.g. the network service of a Chromium that cannot reach the
  Keychain, as with shape (b)), the window still ends on the failure screen. Now the failure will name the screen,
  the window's visibility and the load attempts.
- The watchdog's 20 s and the 3 attempts are judgement calls (healthy commits take ~0.1-0.3 s). A pathological
  network stack that commits after more than 20 s would be reloaded, and logged as such.
- The window-repeat spec is skipped by default and on Windows (it needs the acceptance fixtures).

## Notes for integration

- The branch has 6 commits on top of main d7d2e6b:
  - the baseline logging and diagnostics;
  - a temporary x10 default for the measurement;
  - the smoke-log fix and the heavier repeat;
  - the UiLoad fix;
  - the revert of the temporary default;
  - plus this report and the docs.

  The temporary commit and its revert can be squashed away.
- `e2e/support/desktop-diagnostics.test.ts` lives in `e2e/support/` because the e2e vitest config collects only
  `support/**/*.test.ts` (PR #110 does the same).
- PR #110 also edits `e2e/desktop/support/packaged-app.ts` (`appLaunchEnv`). Expect a small textual conflict at the
  import block and at the end of the file.
- To look at the next macOS failure: the CI log's error message now carries `--- window diagnostics ---`. To
  measure again: `OCTOPUS_DESKTOP_WINDOW_REPEAT=10 pnpm --filter @octopus-diff/e2e test:e2e:desktop`.
