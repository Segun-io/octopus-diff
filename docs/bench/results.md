# octopus-diff perf bench

Generated 2026-11-12T03:41:16.923Z · linux 6.18.58.1-microsoft-standard-WSL2 · AMD Ryzen 7 7800X3D 8-Core Processor (12 cores) · Node v26.13.0 · git version 2.53.0

Layout `small`: 30 repos × 3 worktrees (all dirty) = 90 worktrees, generated in 4748 ms.

## Budgets

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| Time to first paint (cold, `data-ready`) | 142 ms | < 3000 ms | PASS |
| Time to first paint (warm reload, median of 3) | 86 ms | < 300 ms | PASS |
| Startup git spawns per worktree | 8.2 | ≤ 8 spawns | FAIL (tracked: #10 and #29 (compute each summary once; per-project git metadata)) |
| Idle CPU, daemon + git children (average) | 0.23 % | < 10 % | PASS |
| Refresh: write → SSE `worktree.changed` p95 | 31 ms | < 1000 ms | PASS |
| Refresh: write → UI sidebar update p95 | 50 ms | < 1000 ms | PASS |

Tracked budgets are known to fail until the issue they name lands: they are listed as `FAIL (tracked)` and do not turn the run red (`startupSpawns` → #10 and #29 (compute each summary once; per-project git metadata)). Large layouts report everything but judge only the startup spawns. Run `--strict` to count tracked budgets too.

## Numbers

| Metric | Result |
|---|---|
| Time to first paint (cold) | 142 ms |
| Time to first paint (warm reload; 3 samples) | 86 ms (95 / 77 / 86 ms) |
| Idle CPU, daemon + git children (avg over 60 s / worst 1 s) | 0.23 % / 2.00 % |
| Refresh: write → SSE `worktree.changed` (p50 / p95 / max) | 29 ms / 31 ms / 31 ms (15/15) |
| Refresh: write → UI sidebar update (p50 / p95 / max) | 44 ms / 50 ms / 50 ms (15/15) |
| Daemon startup: listening / all summaries | 782 ms / 1236 ms |
| Daemon RSS: end of run / peak | 131.96 MiB / 156.29 MiB |

## Startup git spawns (740 for 90 worktrees = 8.2 per worktree, 4295 ms of git wall time summed)

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
| `rev-parse` | 162 | 997 ms | 5.9 ms | 9.8 ms |
| `for-each-ref` | 120 | 617 ms | 5 ms | 8.2 ms |
| `config` | 97 | 549 ms | 5.7 ms | 8.2 ms |
| `status` | 90 | 616 ms | 6.3 ms | 10.2 ms |
| `diff` | 90 | 588 ms | 6.5 ms | 9.8 ms |
| `check-attr` | 90 | 461 ms | 4.7 ms | 8 ms |
| `rev-list` | 60 | 309 ms | 4.7 ms | 8.2 ms |
| `worktree` | 30 | 156 ms | 4.9 ms | 7.6 ms |
| `--version` | 1 | 2 ms | 2.2 ms | 2.2 ms |

## Spawns caused by the UI

| Phase | Git spawns | Wall time (sum) |
|---|---|---|
| coldPaint | 42 | 211 ms |
| warmReload1 | 33 | 175 ms |
| warmReload2 | 40 | 233 ms |
| warmReload3 | 65 | 343 ms |

## Edit → SSE by worktree role

| Role | Edits | SSE p50 / p95 / max | Git spawns per edit |
|---|---|---|---|
| bench | 15 | 29 ms / 31 ms / 31 ms | 19–56 |

## API payloads

| Request | Raw | Gzipped (computed) | Sent when asked for gzip | First / warm request |
|---|---|---|---|---|
| projects | 86.3 KiB | 8.0 KiB | gzip: 9.5 KiB | 8 ms / 2 ms |
| inbox, working | 192.6 KiB | 20.5 KiB | gzip: 24.1 KiB | 401 ms / 10 ms |
| inbox, review (To review) | 192.6 KiB | 20.5 KiB | gzip: 24.1 KiB | 760 ms / 13 ms |
| inbox, branch + working (All on branch) | 192.6 KiB | 20.5 KiB | gzip: 24.1 KiB | 19 ms / 14 ms |
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

Raw numbers: `results.json` next to this file. Re-run: `pnpm --filter @octopus-diff/e2e bench`.
