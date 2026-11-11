# octopus-diff perf bench

Generated 2026-11-11T22:50:12.304Z · linux 6.18.58.1-microsoft-standard-WSL2 · AMD Ryzen 7 7800X3D 8-Core Processor (12 cores) · Node v26.13.0 · git version 2.53.0

Layout `small`: 30 repos × 3 worktrees (all dirty) = 90 worktrees, generated in 4942 ms.

## Budgets

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| Time to first paint (cold, `data-ready`) | 1382 ms | < 3000 ms | PASS |
| Time to first paint (warm reload, median of 3) | 852 ms | < 300 ms | FAIL (tracked: #27 (cache the branch-scope inbox and files)) |
| Startup git spawns per worktree | 15.9 | ≤ 8 spawns | FAIL (tracked: #10 and #29 (compute each summary once; per-project git metadata)) |
| Idle CPU, daemon + git children (average) | 0.32 % | < 10 % | PASS |
| Refresh: write → SSE `worktree.changed` p95 | 40 ms | < 1000 ms | PASS |
| Refresh: write → UI sidebar update p95 | 59 ms | < 1000 ms | PASS |

Tracked budgets are known to fail until the issue they name lands: they are listed as `FAIL (tracked)` and do not turn the run red (`warmReload` → #27 (cache the branch-scope inbox and files); `startupSpawns` → #10 and #29 (compute each summary once; per-project git metadata)). Large layouts report everything but judge only the startup spawns. Run `--strict` to count tracked budgets too.

## Numbers

| Metric | Result |
|---|---|
| Time to first paint (cold) | 1382 ms |
| Time to first paint (warm reload; 3 samples) | 852 ms (858 / 851 / 852 ms) |
| Idle CPU, daemon + git children (avg over 60 s / worst 1 s) | 0.32 % / 2.00 % |
| Refresh: write → SSE `worktree.changed` (p50 / p95 / max) | 29 ms / 40 ms / 40 ms (15/15) |
| Refresh: write → UI sidebar update (p50 / p95 / max) | 44 ms / 59 ms / 59 ms (15/15) |
| Daemon startup: listening / all summaries | 729 ms / 1972 ms |
| Daemon RSS: end of run / peak | 177.85 MiB / 179.16 MiB |

## Startup git spawns (1428 for 90 worktrees = 15.9 per worktree, 7246 ms of git wall time summed)

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
| `rev-parse` | 342 | 1664 ms | 4.8 ms | 7.9 ms |
| `for-each-ref` | 210 | 1003 ms | 4.7 ms | 7.3 ms |
| `config` | 185 | 915 ms | 4.7 ms | 7.7 ms |
| `status` | 180 | 1081 ms | 5.8 ms | 8.8 ms |
| `diff` | 180 | 1058 ms | 5.7 ms | 7.8 ms |
| `check-attr` | 90 | 444 ms | 4.7 ms | 8 ms |
| `symbolic-ref` | 90 | 394 ms | 4.2 ms | 6.6 ms |
| `rev-list` | 60 | 296 ms | 5 ms | 7.2 ms |
| `merge-base` | 60 | 240 ms | 3.9 ms | 6.5 ms |
| `worktree` | 30 | 148 ms | 4.6 ms | 8.6 ms |
| `--version` | 1 | 2 ms | 2.3 ms | 2.3 ms |

## Spawns caused by the UI

| Phase | Git spawns | Wall time (sum) |
|---|---|---|
| coldPaint | 840 | 4398 ms |
| warmReload1 | 554 | 2828 ms |
| warmReload2 | 547 | 2789 ms |
| warmReload3 | 547 | 2805 ms |

## Edit → SSE by worktree role

| Role | Edits | SSE p50 / p95 / max | Git spawns per edit |
|---|---|---|---|
| bench | 15 | 29 ms / 40 ms / 40 ms | 21–31 |

## API payloads

| Request | Raw | Gzipped (computed) | Sent when asked for gzip | First / warm request |
|---|---|---|---|---|
| projects | 99.1 KiB | 8.4 KiB | none: 99.1 KiB | 11 ms / 2 ms |
| inbox, working | 192.6 KiB | 20.5 KiB | none: 192.6 KiB | 4 ms / 4 ms |
| inbox, review (To review) | 192.6 KiB | 20.5 KiB | none: 192.6 KiB | 4 ms / 3 ms |
| inbox, branch + working (All on branch) | 192.6 KiB | 20.5 KiB | none: 192.6 KiB | 757 ms / 741 ms |
| files bench, working | 1.3 KiB | 447 B | none: 1.3 KiB | 1 ms / 1 ms |

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

Raw numbers: `results.json` next to this file. Re-run: `pnpm --filter @octopus-diff/e2e bench`.
