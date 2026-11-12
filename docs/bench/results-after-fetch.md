# octopus-diff perf bench

Generated 2026-11-12T07:36:26.074Z · linux 6.18.58.1-microsoft-standard-WSL2 · AMD Ryzen 7 7800X3D 8-Core Processor (12 cores) · Node v26.13.0 · git version 2.53.0

Layout `small`: 30 repos × 3 worktrees (all dirty), the UI opens on To review, each linked worktree merged origin/main, then a fetch moved origin/main in every repo = 90 worktrees, generated in 6074 ms.

## Budgets

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| Time to first paint (cold, `data-ready`) | 145 ms | < 3000 ms | PASS |
| Time to first paint (warm reload, median of 3) | 106 ms | < 300 ms | PASS |
| Startup git spawns per worktree | 5.2 | ≤ 8 spawns | PASS |
| Idle CPU, daemon + git children (average) | 0.38 % | < 10 % | PASS |
| Refresh: write → SSE `worktree.changed` p95 | 33 ms | < 1000 ms | PASS |
| Refresh: write → UI sidebar update p95 | 93 ms | < 1000 ms | PASS |

Tracked budgets are known to fail until the issue they name lands: they are listed as `FAIL (tracked)` and do not turn the run red (). Large layouts report everything but judge only the startup spawns. Run `--strict` to count tracked budgets too.

## Numbers

| Metric | Result |
|---|---|
| Time to first paint (cold) | 145 ms |
| Time to first paint (warm reload; 3 samples) | 106 ms (106 / 112 / 101 ms) |
| Idle CPU, daemon + git children (avg over 60 s / worst 1 s) | 0.38 % / 4.00 % |
| Refresh: write → SSE `worktree.changed` (p50 / p95 / max) | 18 ms / 33 ms / 33 ms (15/15) |
| Refresh: write → UI sidebar update (p50 / p95 / max) | 35 ms / 93 ms / 93 ms (15/15) |
| Daemon startup: listening / all summaries | 739 ms / 970 ms |
| Daemon RSS: end of run / peak | 162.14 MiB / 162.27 MiB |

## Startup git spawns (472 for 90 worktrees = 5.2 per worktree, 3159 ms of git wall time summed)

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
| `config` | 111 | 677 ms | 5.7 ms | 10.1 ms |
| `status` | 90 | 749 ms | 7.7 ms | 12.8 ms |
| `diff` | 90 | 647 ms | 6.4 ms | 11.8 ms |
| `check-attr` | 90 | 555 ms | 5.8 ms | 10.6 ms |
| `rev-parse` | 30 | 169 ms | 5.4 ms | 9.2 ms |
| `worktree` | 30 | 156 ms | 5 ms | 8.1 ms |
| `for-each-ref` | 30 | 203 ms | 6.2 ms | 9.5 ms |
| `--version` | 1 | 2 ms | 2.5 ms | 2.5 ms |

## Spawns caused by the UI

| Phase | Git spawns | Wall time (sum) |
|---|---|---|
| coldPaint | 31 | 194 ms |
| warmReload1 | 69 | 362 ms |
| warmReload2 | 68 | 339 ms |
| warmReload3 | 71 | 418 ms |


## After a fetch that moved origin/main (`--after-fetch`, issue #35)

30 repositories each have a bare `origin`; the 60 linked worktrees committed one own file and merged `origin/main` (the local `main` is stale). A fetch then moved `origin/main` in every repository (315 ms) **before the daemon started**, so every worktree's labels are computed from scratch; the numbers above (startup spawns, cold paint, warm reloads, RSS) are for that cold start.

| Metric | Result |
|---|---|
| Time until every worktree's labels are known (from the cold paint's start) | 1889 ms (90 worktrees) |
| To review inbox afterwards: worktrees with base files / base files / via merge | 60 / 60 / 60 |
| **Live fetch** (second fetch, daemon running, every label invalidated at once): fetch time | 414 ms |
| Live fetch: time until the To review inbox shows the new labels in every worktree | 1067 ms (60/60 worktrees relabelled) |
| Live fetch: git spawns (per worktree) | 647 (7.2) |
| Daemon RSS before / after the live fetch | 133.07 MiB / 162.14 MiB |

Live fetch, git spawns by subcommand:

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
| `diff` | 183 | 1304 ms | 6.9 ms | 10 ms |
| `status` | 182 | 1377 ms | 7.6 ms | 10.5 ms |
| `merge-base` | 140 | 547 ms | 2.9 ms | 8.8 ms |
| `config` | 61 | 284 ms | 4.3 ms | 8 ms |
| `diff-tree` | 60 | 202 ms | 3 ms | 3.7 ms |
| `worktree` | 21 | 60 ms | 2.9 ms | 3.2 ms |

## Edit → SSE by worktree role

| Role | Edits | SSE p50 / p95 / max | Git spawns per edit |
|---|---|---|---|
| bench | 15 | 18 ms / 33 ms / 33 ms | 6–46 |

## API payloads

| Request | Raw | Gzipped (computed) | Sent when asked for gzip | First / warm request |
|---|---|---|---|---|
| projects | 105.1 KiB | 10.0 KiB | gzip: 11.7 KiB | 8 ms / 2 ms |
| inbox, working | 192.6 KiB | 21.9 KiB | gzip: 25.6 KiB | 354 ms / 11 ms |
| inbox, review (To review) | 223.4 KiB | 24.9 KiB | gzip: 29.7 KiB | 20 ms / 16 ms |
| inbox, branch + working (All on branch) | 207.1 KiB | 23.9 KiB | gzip: 28.4 KiB | 430 ms / 29 ms |
| files bench, working | 1.3 KiB | 448 B | gzip: 453 B | 1 ms / 1 ms |

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
