# octopus-diff perf bench

Generated 2026-11-11T23:46:28.356Z · linux 6.18.58.1-microsoft-standard-WSL2 · AMD Ryzen 7 7800X3D 8-Core Processor (12 cores) · Node v26.13.0 · git version 2.53.0

Layout `large`: one monorepo, 100000 tracked files, 3 worktrees (main with a 300000-line rewrite, a stale index, 30400 untracked files) = 3 worktrees, generated in 9798 ms.

## Budgets

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| Time to first paint (cold, `data-ready`) | 183464 ms | < 3000 ms | report only |
| Time to first paint (warm reload, median of 3) | 89706 ms | < 300 ms | report only |
| Startup git spawns per worktree | 16.7 | ≤ 8 spawns | FAIL (tracked: #10 and #29 (compute each summary once; per-project git metadata)) |
| Idle CPU, daemon + git children (average) | 0.05 % | < 10 % | report only |
| Refresh: write → SSE `worktree.changed` p95 | 219964 ms | < 1000 ms | report only |
| Refresh: write → UI sidebar update p95 | 222490 ms | < 1000 ms | report only |

Tracked budgets are known to fail until the issue they name lands: they are listed as `FAIL (tracked)` and do not turn the run red (`warmReload` → #27 (cache the branch-scope inbox and files); `startupSpawns` → #10 and #29 (compute each summary once; per-project git metadata)). Large layouts report everything but judge only the startup spawns. Run `--strict` to count tracked budgets too.

## Numbers

| Metric | Result |
|---|---|
| Time to first paint (cold) | 183464 ms |
| Time to first paint (warm reload; 3 samples) | 89706 ms (97764 / 88763 / 89706 ms) |
| Idle CPU, daemon + git children (avg over 20 s / worst 1 s) | 0.05 % / 1.00 % |
| Refresh: write → SSE `worktree.changed` (p50 / p95 / max) | 87865 ms / 219964 ms / 219964 ms (6/6) |
| Refresh: write → UI sidebar update (p50 / p95 / max) | 87890 ms / 222490 ms / 222490 ms (6/6) |
| Daemon startup: listening / all summaries | 170 ms / 8500 ms |
| Daemon RSS: end of run / peak | 361.76 MiB / 473.89 MiB |

## Startup git spawns (50 for 3 worktrees = 16.7 per worktree, 12525 ms of git wall time summed)

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
| `rev-parse` | 13 | 57 ms | 3.7 ms | 11.2 ms |
| `for-each-ref` | 7 | 53 ms | 7.6 ms | 13.4 ms |
| `config` | 7 | 33 ms | 3.9 ms | 9.1 ms |
| `status` | 6 | 3132 ms | 473.8 ms | 881.5 ms |
| `diff` | 6 | 9183 ms | 531.3 ms | 4583.3 ms |
| `symbolic-ref` | 3 | 11 ms | 3.9 ms | 5.2 ms |
| `rev-list` | 2 | 17 ms | 6.4 ms | 10.3 ms |
| `check-attr` | 2 | 28 ms | 13.9 ms | 14.2 ms |
| `merge-base` | 2 | 6 ms | 2.4 ms | 4 ms |
| `--version` | 1 | 2 ms | 2.3 ms | 2.3 ms |
| `worktree` | 1 | 2 ms | 2.1 ms | 2.1 ms |

## Spawns caused by the UI

| Phase | Git spawns | Wall time (sum) |
|---|---|---|
| coldPaint | 38 | 103056 ms |
| warmReload1 | 30 | 9422 ms |
| warmReload2 | 40 | 11912 ms |
| warmReload3 | 36 | 9178 ms |

## Edit → SSE by worktree role

| Role | Edits | SSE p50 / p95 / max | Git spawns per edit |
|---|---|---|---|
| main | 2 | 1543 ms / 2009 ms / 2009 ms | 21–21 |
| stale-index | 2 | 93384 ms / 219964 ms / 219964 ms | 31–55 |
| untracked-heavy | 2 | 87865 ms / 115998 ms / 115998 ms | 39–62 |

## API payloads

| Request | Raw | Gzipped (computed) | Sent when asked for gzip | First / warm request |
|---|---|---|---|---|
| projects | 3.3 KiB | 798 B | none: 3.3 KiB | 108703 ms / 4 ms |
| inbox, working | 8.09 MiB | 868.5 KiB | none: 8.09 MiB | 2873 ms / 56 ms |
| inbox, review (To review) | 8.09 MiB | 868.5 KiB | none: 8.09 MiB | 57 ms / 56 ms |
| inbox, branch + working (All on branch) | 8.09 MiB | 868.5 KiB | none: 8.09 MiB | 106022 ms / 112032 ms |
| files main, working | 180.5 KiB | 20.9 KiB | none: 180.5 KiB | 3 ms / 2 ms |
| files stale-index, working | 180.3 KiB | 20.8 KiB | none: 180.3 KiB | 2 ms / 2 ms |
| files untracked-heavy, working | 7.73 MiB | 825.1 KiB | none: 7.73 MiB | 53 ms / 56 ms |

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
