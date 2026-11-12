# Bench scripts (issue #26)

The yardstick for the performance work in #24. All of them run against temp fixtures under the OS temp
dir, except `profile:real`, which reads your repositories and never writes to them.

| Command (repository root) | What it does | Output |
|---|---|---|
| `pnpm --filter @octopus-diff/e2e bench` | 30 repos × 3 worktrees: startup, cold/warm paint, idle CPU, edit→SSE, payloads, RSS, budgets (about 3 min) | `results.{json,md}` |
| `pnpm --filter @octopus-diff/e2e bench --after-fetch` | The 30 × 3 layout where every repo has a bare `origin`, every linked worktree merged `origin/main` and a fetch moved `origin/main` before the daemon starts (the UI opens on To review). Also records the time until every worktree's merge-noise labels are known, then a second fetch while the daemon runs: relabel time, git spawns by subcommand, RSS (issue #35; about 3 min) | `results-after-fetch.{json,md}` |
| `pnpm --filter @octopus-diff/e2e bench --to-review` | Control for the above: the plain 30 × 3 layout with the UI opening on To review (no origins). Not committed (`--out <dir>` to keep it) | `results-to-review.{json,md}` |
| `pnpm --filter @octopus-diff/e2e bench --layout large-ci` | One monorepo, ~20k tracked files, three worktrees (a 30k-line rewrite; a stale index; 5k untracked). Fixture in 2 s | `results-large-ci.{json,md}` |
| `pnpm --filter @octopus-diff/e2e bench --layout large` | Same shape at 100k files, 30k untracked, 300k-line rewrite. Fixture in 10 s | `results-large.{json,md}` |
| `pnpm --filter @octopus-diff/fixtures fixtures large --layout large-ci` | Only builds the large layout and prints its paths | |
| `pnpm --filter @octopus-diff/e2e profile:real <repo>... \| --scan-root <dir> [--redact] [--json f]` | Read-only profile of real repos: `status`, `ls-files`, `diff HEAD`, untracked count, speed-related git config, probable stale index; checks `.git/index` is untouched | stdout, optional JSON |
| `pnpm --filter @octopus-diff/web build` then `pnpm --filter @octopus-diff/web perf` | Render bench in Chromium on the large mock dataset (30 worktrees × 200 files; no daemon). Starts its own mock + `vite preview` (fresh every run, about 15 s). `SCOPE=review`, `MOCK_MERGE_NOISE=0`, `PERF_OUT=<file>`, `BASE_URL` for a server you started (must serve `MOCK_DATASET=large`) | `web-perf.json` |
| `pnpm --filter @octopus-diff/web perf:smoke` | Same script, fewer iterations (about 8 s); structural checks only. Runs in the CI `e2e` job | exit code |

Options for `bench`: `--idle-seconds N`, `--iterations N`, `--no-ui`, `--out <dir>`, `--strict`, `--after-fetch`, `--to-review` (both small layout only), `--no-incremental` (#40: the daemon with every summary and file list in full, the A/B), `--keep-trace <dir>` (keeps the raw spawn trace, one JSON line per git process with its full argv, and the phase windows and edits (`edits`: write time and SSE time) in epoch ms, for diagnosis; the fixtures are still deleted). pnpm 12 forwards
arguments as they are (no `--` needed; a literal `--` is tolerated). Build first (`pnpm build`).

## Budgets and the exit code

`bench` exits 1 when a budget fails. Large layouts report everything but judge only the startup spawns.

| Budget | Limit | Applies to | Status |
|---|---|---|---|
| Time to first paint, cold | < 3000 ms | small | enforced |
| Idle CPU | < 10 % | small | enforced |
| Edit → SSE and → UI, p95 | < 1000 ms | small | enforced |
| Warm reload (median of 3) | < 300 ms | small at 30 × 3 | enforced (#27 fixed it) |
| Startup git spawns per worktree | ≤ 8 | every layout | enforced (since #29) |
| Diff opened during a 60-edit burst, p95 | < 100 ms | small | enforced (#44) |
| Browser traffic per edit (worktree view, worst edit) | < 100 KB | small | enforced (#51) |
| `/api/projects` requests per edit (worst edit) | 0 | small | enforced (#51) |
| Git spawns from the write to SSE, later edits of a worktree | ≤ 3 | every layout with a worktree edited twice | enforced (#40) |
| Edit → SSE p95, later edits of a worktree | < 120 ms | the 100k-file target | report only (#40) |

A *tracked* budget is known to fail today. It prints `FAIL (tracked: #n)` and does not turn the run red. When the
issue lands, delete the entry from `TRACKED` in `e2e/bench/bench.ts` (the bench prints `PASS (tracked …; remove it)`
once it passes), so the budget is enforced from then on. `--strict` counts tracked budgets as failures.

`--after-fetch` is judged by the same budgets as the plain 30 × 3 run (cold paint, warm reload, idle CPU, refresh, startup spawns per worktree); the fetch figures are report-only (no new budget). Its fixtures come from `addBenchOrigins` in `tools/fixtures/src/merge-noise.ts`, an opt-in: `generateFixtures({ bench })` and every other bench stay without remotes. The labels cost shows up as the live-fetch table: `merge-base` + `diff-tree` are the label work (about 3.3 per linked worktree, at most 2 at once); `status` and `diff` are the summary refreshes the moved ref triggers in every worktree.

## Spawns per edit and incremental refreshes (issue #40)

The *Edit → SSE by worktree role* table has two spawn columns: **to SSE** (processes started between the write and
the worktree's `worktree.changed`: the summary and the review state the event waits for) and **per edit** (until
the daemon is quiet again, the UI's refetches included). Since #40 one edit is `status` and `diff --numstat` side by
side, then one `diff -p` for the review state's list, all three limited to the edited path. The first edit of a
worktree in a daemon session also computes its first review state (one diff of every changed file); later edits do
not. `--no-incremental` gives the old numbers for comparison: `results-large-edits.{md,json}` (incremental) and
`results-large-edits-full.{md,json}` (`--no-incremental`) are that A/B on the 100k layout with `--no-ui
--idle-seconds 1 --iterations 15` (12 for the full run), 2026-11-12. Reading the large layouts: run them with `--no-ui`
for the edit numbers (the UI's cold paint of the 8 MB inbox alone takes minutes there), and see the stale-index
row, whose full refresh re-hashes every file.

## Summary by worktree role (issue #43)

Large layouts only: once the daemon is stopped, `e2e/bench/summary-roles.ts` times each worktree's summary through
git-core in the bench process (nothing else running): one full summary with a new git-core (*cold*, as at daemon
startup), three full ones with a kept state (*warm*: what the reconciliation, focus, polls and git-dir events cost),
three incremental ones after a one-line append to `README.md`, and the size of the working list of the last summary.
Report only. The untracked-heavy row is the #43 acceptance (a full summary under 600 ms, a small list): above
2000 untracked files git-core counts the rest without inspecting or listing them (`untrackedOmitted`). The
stale-index row's full summaries stay slow by design: git re-hashes every file there.

## Traffic per edit (issue #51)

During the refresh loop the page sits on a worktree (no Inbox view since #83); each sample appends to `README.md` in a different worktree.
Every finished `/api/*` request of the page inside the sample's window counts (body + headers as sent, gzip included;
the SSE stream itself is not a finished request). Since #51 an edit costs one `GET /api/inbox?worktreeIds=` (and the
Activity feed when it is open) and no `/api/projects`; before it, the projects list and the whole inbox or the changed
worktree's file list. The request-count tests (`apps/web/test/event-deltas.test.ts`, e2e `04-live-updates`) are the
primary proof; this is the end-to-end number.

## Spawns per reload (issue #74)

The UI table has two kinds of reload. `warmReload1-3` start right after the cold paint and end at `data-ready`: they
are what the warm-reload *time* budget judges, but their spawn counts include whatever the cold paint started and has
not finished (with To review that is every review state and, with origins, every label: about 12 processes per linked
worktree, 1.9-5 s in all), so they say little about a reload itself. `settledReload1-3` start once no git process ran
for 1 s and last until the daemon is quiet again: that is what one reload costs on its own. It is reported (per
worktree, worst of three), not judged: a reload refetches the open file's diff (3 processes; diffs are not cached,
roadmap #41), focusing a worktree re-checks it with one `status`, and timers (the worktree relist every 60 s, the
forge poll) can fall into the window. Read it with `--keep-trace` when it is not 3-4.

## A diff during an edit burst (issue #44)

`e2e/bench/burst.ts` runs after the refresh loop (small layout): 7 `GET /diff` probes of one changed file on the quiet
daemon, then 60 appends to `README.md` in 60 other worktrees **back to back**, with one probe at a time every 100 ms
until 2 s after the last edit. The probes spawn git themselves, so the phase waits for a quiet daemon only once they
stop; a phase that never gets quiet fails the budget. Keep the edits back to back: 20 ms apart, the summary queue never
builds on a fast machine and the number cannot tell the interactive lane from a single queue (both measured 24-69 ms;
back to back: 26-28 ms with the lane, 214-221 ms without, 2026-11-12). The proof of the lane is the gated-runner test
`packages/git-core/test/lanes.test.ts`; this number is the end-to-end check.

## How the large layout is built

`tools/fixtures/src/large.ts`: `git fast-import` for the history (100k files in seconds), two linked worktrees,
then dirt per worktree (modified tracked files and untracked files in every worktree). The stale index is emulated
by changing every tracked file's mtime without touching its content in one worktree: git has to re-hash every file
on each `status`/`diff` and `--no-optional-locks` never rewrites the index, so it never heals. It is the worst case
(every file stale). At 100k files `git status` took 255 ms in the untracked-heavy worktree and 720 ms in the stale
one on the dev machine.

## The web render bench (`apps/web/scripts/perf.ts`, #68)

It drives the production build in headless Chromium, so it rots when the UI's waiting conditions change
(it broke in #26 and again in #68). Rules that keep it honest:

- **Run it when** you change the file list, the sidebar, J/K/j/k navigation, the scope select, the diff viewer's
  states or the live-refresh path in `apps/web`, and after any change to the mock backend. Build first
  (`pnpm --filter @octopus-diff/web build`): it measures `dist/`, not the sources.
- Every wait is on a condition the app exposes (`data-scope`, `data-state`, `data-placeholder`, `aria-current`,
  `data-worktree-id`, the refresh indicator's `data-state`), never a sleep; a timeout prints the page's state. If you
  rename one of those, update the script in the same commit.
- The dataset must be the large mock one. The script starts its own; with `BASE_URL` it checks the worktree count and
  stops with the reason (`preview:mock` alone serves the 10-worktree `demo` dataset).
- Live refresh is timed inside the page (a `MutationObserver` on the indicator). Do not time it with a Playwright
  `waitFor`: those poll on a 100 ms grid and turned an 85 ms refresh into 190 ms for a few ms of server time.
- `perf:smoke` runs in CI (the `e2e` job, where Chromium is installed) and fails on structure only: page errors, a
  non-virtualised list, `J` not reaching distinct worktrees, a refresh that fetches nothing, or a timed-out wait.
  Timings are never a gate (shared runners); compare against `web-perf.json` by hand, three runs, medians.
