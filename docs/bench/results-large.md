# octopus-diff perf bench

Generated 2026-11-11T23:19:19.138Z · linux 6.18.58.1-microsoft-standard-WSL2 · AMD Ryzen 7 7800X3D 8-Core Processor (12 cores) · Node v26.13.0 · git version 2.53.0

Layout `large`: one monorepo, 100000 tracked files, 3 worktrees (main with a 300000-line rewrite, a stale index, 30400 untracked files) = 3 worktrees, generated in 9335 ms.

## Budgets

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| Time to first paint (cold, `data-ready`) | 89194 ms | < 3000 ms | report only |
| Time to first paint (warm reload, median of 3) | 91710 ms | < 300 ms | report only |
| Startup git spawns per worktree | 17.3 | ≤ 8 spawns | FAIL (tracked: #10 and #29 (compute each summary once; per-project git metadata)) |
| Idle CPU, daemon + git children (average) | 0.05 % | < 10 % | report only |
| Refresh: write → SSE `worktree.changed` p95 | no result | < 1000 ms | report only |
| Refresh: write → UI sidebar update p95 | no result | < 1000 ms | report only |

Tracked budgets are known to fail until the issue they name lands: they are listed as `FAIL (tracked)` and do not turn the run red (`warmReload` → #27 (cache the branch-scope inbox and files); `startupSpawns` → #10 and #29 (compute each summary once; per-project git metadata)). Large layouts report everything but judge only the startup spawns. Run `--strict` to count tracked budgets too.

## Numbers

| Metric | Result |
|---|---|
| Time to first paint (cold) | 89194 ms |
| Time to first paint (warm reload; 3 samples) | 91710 ms (91710 / 91750 / 90806 ms) |
| Idle CPU, daemon + git children (avg over 20 s / worst 1 s) | 0.05 % / 1.00 % |
| Refresh: write → SSE `worktree.changed` (p50 / p95 / max) | 736 ms / 736 ms / 736 ms (1/9) |
| Refresh: write → UI sidebar update (p50 / p95 / max) | 758 ms / 758 ms / 758 ms (1/9) |
| Daemon startup: listening / all summaries | 162 ms / 100329 ms |
| Daemon RSS: end of run / peak | 366.13 MiB / 486.16 MiB |

## Startup git spawns (52 for 3 worktrees = 17.3 per worktree, 11670 ms of git wall time summed)

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
| `rev-parse` | 13 | 98 ms | 3.5 ms | 19.7 ms |
| `config` | 9 | 38 ms | 3.5 ms | 8.8 ms |
| `for-each-ref` | 7 | 45 ms | 4.3 ms | 14 ms |
| `status` | 6 | 2692 ms | 289.8 ms | 898.1 ms |
| `diff` | 6 | 8738 ms | 230.1 ms | 4521.6 ms |
| `symbolic-ref` | 3 | 7 ms | 2.2 ms | 3 ms |
| `check-attr` | 2 | 30 ms | 12.7 ms | 17.2 ms |
| `rev-list` | 2 | 13 ms | 5.8 ms | 7.5 ms |
| `merge-base` | 2 | 5 ms | 2.1 ms | 2.4 ms |
| `--version` | 1 | 2 ms | 2.2 ms | 2.2 ms |
| `worktree` | 1 | 2 ms | 2 ms | 2 ms |

## Spawns caused by the UI

| Phase | Git spawns | Wall time (sum) |
|---|---|---|
| coldPaint | 39 | 98130 ms |
| warmReload1 | 34 | 9855 ms |
| warmReload2 | 33 | 10291 ms |
| warmReload3 | 28 | 7558 ms |

## Edit → SSE by worktree role

| Role | Edits | SSE p50 / p95 / max | Git spawns per edit |
|---|---|---|---|
| main | 1 | 736 ms / 736 ms / 736 ms | 0–21 |
| stale-index | 0 | n/a / n/a / n/a | 0–18 |
| untracked-heavy | 0 | n/a / n/a / n/a | 0–0 |

## API payloads

| Request | Raw | Gzipped (computed) | Sent when asked for gzip | First / warm request |
|---|---|---|---|---|
| projects | 3.3 KiB | 801 B | none: 3.3 KiB | 13190 ms / 8 ms |
| inbox, working | 8.09 MiB | 868.4 KiB | none: 8.09 MiB | 90520 ms / 128551 ms |
| inbox, review (To review) | 8.09 MiB | 868.5 KiB | none: 8.09 MiB | 72 ms / 82 ms |
| inbox, branch + working (All on branch) | 8.09 MiB | 868.5 KiB | none: 8.09 MiB | 115972 ms / 108582 ms |
| files main, working | 180.5 KiB | 20.9 KiB | none: 180.5 KiB | 3 ms / 2 ms |
| files stale-index, working | 180.3 KiB | 20.8 KiB | none: 180.3 KiB | 4 ms / 2 ms |
| files untracked-heavy, working | 7.73 MiB | 825.1 KiB | none: 7.73 MiB | 59 ms / 57 ms |

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

Raw numbers: `results-large.json` next to this file. Re-run: `pnpm --filter @octopus-diff/e2e bench --layout large`.
