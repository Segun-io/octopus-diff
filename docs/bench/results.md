# octopus-diff perf bench

Generated 2026-11-12T04:23:46.919Z · linux 6.18.58.1-microsoft-standard-WSL2 · AMD Ryzen 7 7800X3D 8-Core Processor (12 cores) · Node v26.13.0 · git version 2.53.0

Layout `small`: 30 repos × 3 worktrees (all dirty) = 90 worktrees, generated in 4824 ms.

## Budgets

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| Time to first paint (cold, `data-ready`) | 152 ms | < 3000 ms | PASS |
| Time to first paint (warm reload, median of 3) | 71 ms | < 300 ms | PASS |
| Startup git spawns per worktree | 4.6 | ≤ 8 spawns | PASS |
| Idle CPU, daemon + git children (average) | 0.23 % | < 10 % | PASS |
| Refresh: write → SSE `worktree.changed` p95 | 20 ms | < 1000 ms | PASS |
| Refresh: write → UI sidebar update p95 | 40 ms | < 1000 ms | PASS |

Tracked budgets are known to fail until the issue they name lands: they are listed as `FAIL (tracked)` and do not turn the run red (). Large layouts report everything but judge only the startup spawns. Run `--strict` to count tracked budgets too.

## Numbers

| Metric | Result |
|---|---|
| Time to first paint (cold) | 152 ms |
| Time to first paint (warm reload; 3 samples) | 71 ms (101 / 71 / 67 ms) |
| Idle CPU, daemon + git children (avg over 60 s / worst 1 s) | 0.23 % / 2.00 % |
| Refresh: write → SSE `worktree.changed` (p50 / p95 / max) | 15 ms / 20 ms / 20 ms (15/15) |
| Refresh: write → UI sidebar update (p50 / p95 / max) | 26 ms / 40 ms / 40 ms (15/15) |
| Daemon startup: listening / all summaries | 699 ms / 862 ms |
| Daemon RSS: end of run / peak | 104.75 MiB / 129.31 MiB |

## Startup git spawns (415 for 90 worktrees = 4.6 per worktree, 2761 ms of git wall time summed)

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
| `status` | 90 | 670 ms | 7 ms | 11.6 ms |
| `diff` | 90 | 682 ms | 7.4 ms | 10.5 ms |
| `check-attr` | 90 | 520 ms | 5.1 ms | 9.2 ms |
| `config` | 54 | 347 ms | 6.1 ms | 11.2 ms |
| `rev-parse` | 30 | 167 ms | 5 ms | 9.9 ms |
| `worktree` | 30 | 170 ms | 5.4 ms | 8.7 ms |
| `for-each-ref` | 30 | 203 ms | 6.5 ms | 10.3 ms |
| `--version` | 1 | 2 ms | 2.3 ms | 2.3 ms |

## Spawns caused by the UI

| Phase | Git spawns | Wall time (sum) |
|---|---|---|
| coldPaint | 18 | 102 ms |
| warmReload1 | 24 | 137 ms |
| warmReload2 | 20 | 112 ms |
| warmReload3 | 4 | 10 ms |

## Edit → SSE by worktree role

| Role | Edits | SSE p50 / p95 / max | Git spawns per edit |
|---|---|---|---|
| bench | 15 | 15 ms / 20 ms / 20 ms | 7–46 |

## API payloads

| Request | Raw | Gzipped (computed) | Sent when asked for gzip | First / warm request |
|---|---|---|---|---|
| projects | 86.3 KiB | 8.1 KiB | gzip: 9.5 KiB | 10 ms / 2 ms |
| inbox, working | 192.6 KiB | 20.5 KiB | gzip: 24.1 KiB | 322 ms / 11 ms |
| inbox, review (To review) | 192.6 KiB | 20.5 KiB | gzip: 24.1 KiB | 340 ms / 11 ms |
| inbox, branch + working (All on branch) | 192.6 KiB | 20.5 KiB | gzip: 24.2 KiB | 17 ms / 14 ms |
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
