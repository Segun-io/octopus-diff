# octopus-diff perf bench

Generated 2026-11-12T08:36:45.679Z · linux 6.18.58.1-microsoft-standard-WSL2 · AMD Ryzen 7 7800X3D 8-Core Processor (12 cores) · Node v26.13.0 · git version 2.53.0

Layout `small`: 30 repos × 3 worktrees (all dirty), the UI opens on To review, each linked worktree merged origin/main, then a fetch moved origin/main in every repo = 90 worktrees, generated in 11883 ms.

## Budgets

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| Time to first paint (cold, `data-ready`) | 292 ms | < 3000 ms | PASS |
| Time to first paint (warm reload, median of 3) | 210 ms | < 300 ms | PASS |
| Startup git spawns per worktree | 4.5 | ≤ 8 spawns | PASS |
| Idle CPU, daemon + git children (average) | 0.30 % | < 10 % | PASS |
| Refresh: write → SSE `worktree.changed` p95 | 20 ms | < 1000 ms | PASS |
| Refresh: write → UI sidebar update p95 | 39 ms | < 1000 ms | PASS |

Tracked budgets are known to fail until the issue they name lands: they are listed as `FAIL (tracked)` and do not turn the run red (). Large layouts report everything but judge only the startup spawns. Run `--strict` to count tracked budgets too.

## Numbers

| Metric | Result |
|---|---|
| Time to first paint (cold) | 292 ms |
| Time to first paint (warm reload; 3 samples) | 210 ms (226 / 141 / 210 ms) |
| Warm reload once the daemon is quiet: git spawns (per worktree, worst of 3; reported, not judged) | 3 / 3 / 3 (0.03) |
| Idle CPU, daemon + git children (avg over 60 s / worst 1 s) | 0.30 % / 3.00 % |
| Refresh: write → SSE `worktree.changed` (p50 / p95 / max) | 18 ms / 20 ms / 20 ms (15/15) |
| Refresh: write → UI sidebar update (p50 / p95 / max) | 34 ms / 39 ms / 39 ms (15/15) |
| Daemon startup: listening / all summaries | 1623 ms / 2001 ms |
| Daemon RSS: end of run / peak | 166.25 MiB / 166.67 MiB |

## Startup git spawns (408 for 90 worktrees = 4.5 per worktree, 6709 ms of git wall time summed)

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
| `status` | 90 | 1418 ms | 15.5 ms | 28.1 ms |
| `diff` | 90 | 1477 ms | 15.5 ms | 27.7 ms |
| `check-attr` | 90 | 1647 ms | 17.4 ms | 32 ms |
| `config` | 47 | 775 ms | 14 ms | 33.6 ms |
| `rev-parse` | 30 | 439 ms | 12.8 ms | 26.3 ms |
| `worktree` | 30 | 432 ms | 13.6 ms | 26.8 ms |
| `for-each-ref` | 30 | 516 ms | 15.7 ms | 31.5 ms |
| `--version` | 1 | 5 ms | 4.7 ms | 4.7 ms |

## Spawns caused by the UI

| Phase | Git spawns | Wall time (sum) |
|---|---|---|
| coldPaint | 25 | 480 ms |
| warmReload1 | 53 | 625 ms |
| warmReload2 | 17 | 325 ms |
| warmReload3 | 57 | 908 ms |
| settledReload1 | 3 | 20 ms |
| settledReload2 | 3 | 28 ms |
| settledReload3 | 3 | 28 ms |

`warmReload1-3` start right after the cold paint and end at `data-ready`, so they also count the work the cold paint started (review states and labels still being computed). `settledReload1-3` start once no git process ran for 1 s and last until the daemon is quiet again: what one reload costs on its own (issue #74).


## After a fetch that moved origin/main (`--after-fetch`, issue #35)

30 repositories each have a bare `origin`; the 60 linked worktrees committed one own file and merged `origin/main` (the local `main` is stale). A fetch then moved `origin/main` in every repository (965 ms) **before the daemon started**, so every worktree's labels are computed from scratch; the numbers above (startup spawns, cold paint, warm reloads, RSS) are for that cold start.

| Metric | Result |
|---|---|
| Time until every worktree's labels are known (from the cold paint's start) | 4050 ms (90 worktrees) |
| To review inbox afterwards: worktrees with base files / base files / via merge | 60 / 60 / 60 |
| **Live fetch** (second fetch, daemon running, every label invalidated at once): fetch time | 404 ms |
| Live fetch: time until the To review inbox shows the new labels in every worktree | 1071 ms (60/60 worktrees relabelled) |
| Live fetch: git spawns (per worktree) | 565 (6.3) |
| Daemon RSS before / after the live fetch | 163.65 MiB / 166.25 MiB |

Live fetch, git spawns by subcommand:

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
| `diff` | 183 | 1327 ms | 7.2 ms | 10.2 ms |
| `status` | 182 | 1389 ms | 7.4 ms | 10.6 ms |
| `merge-base` | 140 | 557 ms | 3 ms | 9.9 ms |
| `diff-tree` | 60 | 220 ms | 3.1 ms | 6.5 ms |

## Edit → SSE by worktree role

| Role | Edits | SSE p50 / p95 / max | Git spawns per edit |
|---|---|---|---|
| bench | 15 | 18 ms / 20 ms / 20 ms | 4–8 |

## API payloads

| Request | Raw | Gzipped (computed) | Sent when asked for gzip | First / warm request |
|---|---|---|---|---|
| projects | 105.1 KiB | 10.1 KiB | gzip: 11.7 KiB | 7 ms / 2 ms |
| inbox, working | 192.6 KiB | 21.9 KiB | gzip: 25.5 KiB | 336 ms / 10 ms |
| inbox, review (To review) | 223.4 KiB | 24.8 KiB | gzip: 29.4 KiB | 17 ms / 16 ms |
| inbox, branch + working (All on branch) | 207.1 KiB | 23.8 KiB | gzip: 28.2 KiB | 422 ms / 26 ms |
| files bench, working | 1.3 KiB | 447 B | gzip: 453 B | 1 ms / 1 ms |

## Baseline: the 2026-11-11 profiling pass (issue #24)

Static reference from the roadmap issue (12-core WSL2, Node 26, git 2.53), not measured by this run:

| Measurement | Baseline |
|---|---|
| Warm reload, 30 × 3 | 864 ms (72 ms on 2026-11-08) |
| Cold UI paint, 30 × 3 / with big repos | 2.5 s / 4.4 s |
| Default view ("All on branch"), 30 × 3 | 540 spawns, about 700 ms per load; fetched twice on first load |
| Startup git spawns, 90 worktrees | 1357 (180 `status`: every summary twice), about 15 per worktree |
| One-file edit → SSE, 100k-file repo | 440 ms, 8–13 spawns |
| One-file edit → SSE, stale-index worktree | 1.0 s |
| `git status`, 100k files: normal / stale index | 98 ms / 320 ms (their machine) |
| Inbox payload, 4.5k files | 1.18 MB raw, 129 KB gzipped |
| File list, 30k untracked files | 8 MB |

Raw numbers: `results-after-fetch.json` next to this file. Re-run: `pnpm --filter @octopus-diff/e2e bench --after-fetch`.
