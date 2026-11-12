# web-perf-script report

Issue #68 "Web perf script is broken again (times out on main)". Branch `fix/web-perf-script`, from `main` at
`62e98ae` (PR #67 merged). Paths touched: `apps/web/scripts/perf.ts`, `apps/web/mock/preview.ts` +
`preview-server.ts` (new), `apps/web/package.json` (`perf`, `perf:smoke`), `apps/web/README.md`, `.github/workflows/ci.yml`
(one step, outside web: see Notes), `docs/`. No app source (`apps/web/src`) changed: there was no app bug.

## Shipped

- `pnpm --filter @octopus-diff/web perf` now **starts its own mock + `vite preview`** (large dataset, simulator off,
  merge noise on, `MOCK_MERGE_NOISE=0` to turn it off) in-process (`mock/preview-server.ts`, shared with `preview:mock`),
  fresh every run, stopped at the end. After `pnpm --filter @octopus-diff/web build` it is one command, no PID to track.
  `BASE_URL=…` still measures a server you started, but first counts its worktrees and stops with "start it with
  `MOCK_DATASET=large`" if it serves fewer than 30 (the demo dataset has 10).
- Waits are on real conditions only; every timed-out wait throws with the page's state (scope, rows, groups,
  worktree items, current worktree, first row's worktree, viewer state/placeholder).
  - Load: scope select `data-scope`, rows, **all 30 worktree items**, viewer `ready` and not `data-placeholder`, then
    **all 30 Inbox groups** (the Inbox fills in project batches: 3 of 30 groups at first paint, all ~1.4 s later; the
    old script measured `j`/scroll on a list that was still filling). New field `load.inboxCompleteAt`.
  - `J` (step 4): the press must **change** the current worktree and the first row must belong to the new one (the
    old condition could be satisfied by the previous worktree), 10 s timeout, `visited` worktrees checked.
  - Live refresh (step 5): see Root causes 2.
- Structural checks (exit 1, printed in `checks`): 0 page errors, mounted rows < 120 at load and after scrolling, list
  height of a 6000-file inbox, `J` reached distinct worktrees, every refresh made at least the projects + files
  requests. Timings are reported, never judged. New outputs: `requestsPerRefresh`, `usedJsHeapMB`,
  `load.inboxCompleteAt`, `dataset.{mode,server}`. `PERF_OUT=<absolute file>` also writes the JSON.
- `perf:smoke` (`PERF_SMOKE=1`: 20 `j`, 8 `J`, 3 refreshes, ~8 s) as a step of the CI `e2e` job, and a "when and how to
  run it" section in `docs/bench/README.md`. `docs/bench/web-perf.json` refreshed (it was the #26 run).
- DECISIONS **#212**.

## Root causes

1. **The script needed `MOCK_DATASET=large` and nothing said so, nor checked.** The documented command was a bare
   `preview:mock`, whose default dataset is `demo` (10 worktrees, 0-34 files each; in the `working` scope several have no
   files). Step 4 waits for the first `file-item` of the current worktree: an empty worktree has none, so it can never be
   met. **The script was wrong, the app right** (an empty worktree has an empty list; `J` selected each worktree in
   order, checked by hand: files 34, 1, 2, 19, 2, 6, then 0, 0, 0...). Reproduced exactly: on `main` before #67
   (`1f12172`, old script, demo) the timeout is `perf.ts:124`, which is the **`J` step**, not the load wait as the issue
   and the #67 report said (line 124 of that file is step 4's `waitForFunction`); on `62e98ae` with demo it is
   `perf.ts:141`, the same step. Both scripts **pass** on the large dataset (old script: ready 960 ms; current script,
   default and `SCOPE=review`, passes on `62e98ae`). The load wait itself is fine since #67's scope-aware wait; I made
   it stricter anyway (all worktree items and groups, see above).
2. **The "86 → 187 ms live refresh with merge noise" was a script artifact, not a UI regression.** Traced one refresh
   in the page (fetch + indicator transitions): mutate returns at 7 ms, `/api/projects` 8→77 ms, `files?scope=…` 78→85 ms,
   the indicator goes `refreshing` at 8 ms and `idle` at **86-96 ms**, one cycle, same sequence with noise on and off
   (2 requests, 3 when the mutated worktree is the open one, whose diff is refetched). The old script timed it with two
   Playwright `locator.waitFor` calls, which poll on a ~100 ms grid: whether the 85-95 ms idle fell before or after the
   100 ms tick decided 90 ms vs 190 ms (the same run printed 93 and 188 for the same sequence; the noise's few ms of
   server time just moved which side it landed on). Server side the noise costs the mock's `/api/projects` +6 ms
   (65 vs 59 ms median of 5, curl); the UI's work is identical (a MutationObserver over the document counted the same 19 /
   23 / 115 DOM records for the three edits with noise on and off; 0 long tasks). Now the script observes the indicator
   **inside the page** (clock started just before the mutate request, ended in the MutationObserver callback that sees
   `idle` after `refreshing`), and fails if it never sees `refreshing`/`idle` (the old `.catch(() => undefined)` hid that).
3. A smaller one found on the way: the load wait returned while the Inbox was still filling (above), and `J` could
   match the worktree it started on.

## Verification

Machine: 12-core WSL2, Node 26.13, Chromium headless 1440x900. From the repo root.

- Reproduction: `pnpm --filter @octopus-diff/web build`; `preview:mock` with no env (demo) then the old script (`62e98ae`):
  `page.waitForFunction: Timeout 30000ms exceeded at perf.ts:141` (step 4). Same on `1f12172` (detached worktree,
  removed afterwards): `perf.ts:124`. With `MOCK_DATASET=large MOCK_INTERVAL_MS=0`: both pass.
- After the fix: `BASE_URL` at a demo mock exits 1 with "serves 10 worktrees, this benchmark needs the large mock dataset
  (30): start it with MOCK_DATASET=large"; at nothing: "cannot reach …". **Mutation check**: renaming the sidebar's
  `aria-current` (reverted) makes `perf:smoke` exit 1 in 17 s with `perf: J #1 (from worktree none): … Timeout 10000ms exceeded.
  page state: {"scope":"working","files":49,"groups":0,"worktrees":30,"firstFile":"be767b0f705f8393","viewer":"ready",…}`.
- `pnpm --filter @octopus-diff/web perf`, 3 runs each, fresh mock per run, **all 12 runs exit 0, 0 page errors, all checks ok**
  (default = `working`, noise on). Per run (ms unless noted):

  | run | FCP | ready | inbox complete | groups / rows at load | `j` p50 / p95 / max | frames > 50 ms | rows after scroll | `J` p50 / p95 | live refresh p50 / p95 | reqs | heap MB |
  |---|---|---|---|---|---|---|---|---|---|---|---|
  | working, noise on #1 | 80 | 908 | 1192 | 30 / 46 | 33.3 / 34.0 / 37.8 | 0 | 46 | 31 / 40 | 84.5 / 95.8 | 2 | 54 |
  | working, noise on #2 | 80 | 903 | 1178 | 30 / 46 | 33.3 / 35.2 / 39.2 | 0 | 46 | 39 / 57 | 111 / 126 | 3 | 51 |
  | working, noise on #3 | 92 | 967 | 1276 | 30 / 46 | 33.3 / 34.1 / 38.0 | 0 | 46 | 31 / 42 | 82.7 / 99.6 | 2 | 61 |
  | working, `MOCK_MERGE_NOISE=0` #1 | 80 | 847 | 1103 | 30 / 46 | 33.3 / 34.1 / 37.3 | 0 | 46 | 32 / 45 | 90.0 / 93.6 | 2 | 73 |
  | working, noise off #2 | 88 | 994 | 1274 | 30 / 46 | 33.3 / 33.9 / 37.0 | 0 | 46 | 31 / 47 | 84.0 / 89.1 | 2 | 45 |
  | working, noise off #3 | 80 | 858 | 1117 | 30 / 46 | 33.3 / 34.0 / 37.0 | 0 | 46 | 31 / 40 | 80.7 / 126 | 2 | 51 |
  | `SCOPE=review`, noise on #1 | 72 | 984 | 1595 | 30 / 47 | 33.3 / 34.2 / 37.4 | 0 | 45 | 30 / 44 | 84.5 / 94.0 | 2 | 65 |
  | review, noise on #2 | 88 | 1012 | 1621 | 30 / 47 | 33.1 / 34.0 / 37.2 | 0 | 45 | 30 / 47 | 84.1 / 94.2 | 2 | 58 |
  | review, noise on #3 | 88 | 1019 | 1641 | 30 / 47 | 33.1 / 34.1 / 36.8 | 0 | 45 | 30 / 44 | 84.6 / 92.8 | 2 | 54 |
  | review, noise off #1 | 80 | 1025 | 1555 | 30 / 46 | 33.3 / 34.1 / 36.9 | 0 | 46 | 31 / 45 | 83.8 / 95.9 | 2 | 61 |
  | review, noise off #2 | 72 | 1029 | 1565 | 30 / 46 | 33.3 / 34.6 / 37.5 | 0 | 46 | 31 / 43 | 84.2 / 100 | 2 | 51 |
  | review, noise off #3 | 88 | 1014 | 1552 | 30 / 46 | 33.3 / 34.1 / 37.3 | 0 | 46 | 31 / 44 | 85.2 / 92.1 | 2 | 48 |

  Spread over the 3 default runs: ready 903-967, `j` p50 33.3 (p95 34.0-35.2), `J` p50 31-39, refresh p50 82.7-111
  (one run had a noisy machine, the others 83-85). Live refresh noise on vs off, p50 of the 3-run medians:
  **84.5 vs 84.0 (working), 84.5 vs 84.2 (review)**: no difference. Rows mounted: 46 of 6000, no frame over 50 ms, list
  height 156900 px (158980 px in review). `docs/bench/web-perf.json` is run #1 above.
- `perf:smoke` 3 times: exit 0, 7.8-8.1 s each.
- `pnpm check`: **exit 0**: contracts 93, forge 101 (+5 skipped), git-core 254, fixtures 53, **web 284**, daemon 284 (+1
  skipped), e2e unit 5, cli 139, scripts 34 (lint incl. `credits:check`, typecheck, build, tests).
- e2e (Playwright) not run: no e2e spec uses the mock, `preview:mock` or the perf script, and no app source changed.

## Decisions

#212 (above).

## Contract changes

None.

## Dependencies

None added or removed (`vite` and `@playwright/test` were already web devDependencies; `pnpm credits:check` passes
inside `pnpm lint`).

## Known gaps

- The CI step is not exercised on a real runner (the repository has no remote; `ci.yml` was never pushed): it relies on
  Chromium being installed by the `e2e` job's `playwright install --with-deps` step, the same as the e2e suite. Locally
  it runs with the browser libraries from `~/.cache/octopus-diff-dev/chromium-libs`.
- It adds ~10 s (the script) to the `e2e` job of the CI. It has no timing gate by design; regressions in numbers are still
  found by comparing `docs/bench/web-perf.json` by hand (three runs, medians: single runs vary, e.g. refresh p50 83-111).
- `p95` of 10 refreshes is effectively the max. `usedJsHeapMB` (Chromium's `performance.memory`) is coarse.
- No React render counts: "renders" of a refresh were profiled as DOM mutation records (identical with/without noise).
- The smoke does not run the `SCOPE=review` path; run it by hand after touching the merge-noise group.

## Notes for integration

- `.github/workflows/ci.yml` is outside the web stream's paths (WS5): the single added step is `pnpm --filter
  @octopus-diff/web perf:smoke` after `pnpm test:e2e`. Drop it if you do not want a perf step in CI; the script and
  the README section stand on their own.
- DECISIONS #212 (renumbered from #209 when #70 took #209-#211).
- `PERF_OUT` must be an absolute path (pnpm runs the script from `apps/web`).

## PR review round 1 (Greptile on #72)

- **The live-refresh timeout omitted the page details** (valid). The refresh measurement ran its `page.evaluate` outside `waitStep`, so a stuck refresh printed only the indicator's state, unlike every other wait. It is now wrapped the same way (`waitStep` also returns the wrapped value): a stuck refresh prints which refresh it was, the scope, the current worktree, the file and group counts and the viewer state. Checked by forcing the in-page timeout to 1 ms: `perf: live refresh 1 of 3: ... stuck in "idle"` followed by `page state: {"scope":"working","files":46,"groups":30,...}`; the normal smoke still passes.
