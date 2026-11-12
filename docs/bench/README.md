# Bench scripts (issue #26)

The yardstick for the performance work in #24. All of them run against temp fixtures under the OS temp
dir, except `profile:real`, which reads your repositories and never writes to them.

| Command (repository root) | What it does | Output |
|---|---|---|
| `pnpm --filter @octopus-diff/e2e bench` | 30 repos × 3 worktrees: startup, cold/warm paint, idle CPU, edit→SSE, payloads, RSS, budgets (about 3 min) | `results.{json,md}` |
| `pnpm --filter @octopus-diff/e2e bench --layout large-ci` | One monorepo, ~20k tracked files, three worktrees (a 30k-line rewrite; a stale index; 5k untracked). Fixture in 2 s | `results-large-ci.{json,md}` |
| `pnpm --filter @octopus-diff/e2e bench --layout large` | Same shape at 100k files, 30k untracked, 300k-line rewrite. Fixture in 10 s | `results-large.{json,md}` |
| `pnpm --filter @octopus-diff/fixtures fixtures large --layout large-ci` | Only builds the large layout and prints its paths | |
| `pnpm --filter @octopus-diff/e2e profile:real <repo>... \| --scan-root <dir> [--redact] [--json f]` | Read-only profile of real repos: `status`, `ls-files`, `diff HEAD`, untracked count, speed-related git config, probable stale index; checks `.git/index` is untouched | stdout, optional JSON |
| `pnpm --filter @octopus-diff/web preview:mock` then `BASE_URL=… pnpm --filter @octopus-diff/web perf` | Render bench in Chromium on the large mock dataset (no daemon) | `web-perf.json` |

Options for `bench`: `--idle-seconds N`, `--iterations N`, `--no-ui`, `--out <dir>`, `--strict`. pnpm 12 forwards
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

A *tracked* budget is known to fail today. It prints `FAIL (tracked: #n)` and does not turn the run red. When the
issue lands, delete the entry from `TRACKED` in `e2e/bench/bench.ts` (the bench prints `PASS (tracked …; remove it)`
once it passes), so the budget is enforced from then on. `--strict` counts tracked budgets as failures.

## How the large layout is built

`tools/fixtures/src/large.ts`: `git fast-import` for the history (100k files in seconds), two linked worktrees,
then dirt per worktree (modified tracked files and untracked files in every worktree). The stale index is emulated
by changing every tracked file's mtime without touching its content in one worktree: git has to re-hash every file
on each `status`/`diff` and `--no-optional-locks` never rewrites the index, so it never heals. It is the worst case
(every file stale). At 100k files `git status` took 255 ms in the untracked-heavy worktree and 720 ms in the stale
one on the dev machine.
