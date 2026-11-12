# octopus-diff perf bench

Generated 2026-11-12T14:52:39.044Z · linux 6.18.58.1-microsoft-standard-WSL2 · AMD Ryzen 7 7800X3D 8-Core Processor (12 cores) · Node v26.13.0 · git version 2.53.0

Layout `large`: one monorepo, 100000 tracked files, 3 worktrees (main with a 300000-line rewrite, a stale index, 30400 untracked files) = 3 worktrees, generated in 9908 ms.

## Budgets

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| Time to first paint (cold, `data-ready`) | n/a | < 3000 ms | report only |
| Time to first paint (warm reload, median of 3) | n/a | < 300 ms | report only |
| Startup git spawns per worktree | 4.7 | ≤ 8 spawns | PASS |
| Idle CPU, daemon + git children (average) | 0.00 % | < 10 % | report only |
| Refresh: write → SSE `worktree.changed` p95 | 122810 ms | < 1000 ms | report only |
| Diff opened during a 60-edit burst, p95 (#44) | n/a | < 100 ms | report only |
| Browser traffic per edit (worst edit, #51) | n/a | < 102400 bytes | report only |
| `/api/projects` requests per edit (worst edit, #51) | n/a | < 1 requests | report only |
| Refresh: write → UI sidebar update p95 | n/a | < 1000 ms | report only |

Tracked budgets are known to fail until the issue they name lands: they are listed as `FAIL (tracked)` and do not turn the run red (). Large layouts report everything but judge only the startup spawns. Run `--strict` to count tracked budgets too.

## Numbers

| Metric | Result |
|---|---|
| Time to first paint (cold) | skipped |
| Time to first paint (warm reload; 3 samples) | skipped |
| Warm reload once the daemon is quiet: git spawns (per worktree, worst of 3; reported, not judged) | n/a |
| Idle CPU, daemon + git children (avg over 1 s / worst 1 s) | 0.00 % / 0.00 % |
| Refresh: write → SSE `worktree.changed` (p50 / p95 / max) | 3645 ms / 122810 ms / 122810 ms (12/12) |
| Refresh: write → UI sidebar update (p50 / p95 / max) | skipped |
| Browser traffic per edit, Inbox view (median / worst; requests median / worst; `/api/projects` in all edits) | skipped |
| Daemon startup: listening / all summaries | 179 ms / 4091 ms |
| Daemon RSS: end of run / peak | 291.10 MiB / 382.98 MiB |

## Startup git spawns (14 for 3 worktrees = 4.7 per worktree, 5649 ms of git wall time summed)

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
| `status` | 3 | 1908 ms | 607.6 ms | 935.1 ms |
| `diff` | 3 | 3696 ms | 480.1 ms | 2864.1 ms |
| `config` | 2 | 5 ms | 2.2 ms | 2.6 ms |
| `check-attr` | 2 | 25 ms | 12.4 ms | 12.5 ms |
| `--version` | 1 | 2 ms | 2.4 ms | 2.4 ms |
| `rev-parse` | 1 | 2 ms | 2.1 ms | 2.1 ms |
| `worktree` | 1 | 2 ms | 1.9 ms | 1.9 ms |
| `for-each-ref` | 1 | 9 ms | 9.1 ms | 9.1 ms |



## Edit → SSE by worktree role

| Role | Edits | SSE p50 / p95 / max | Git spawns to SSE | Git spawns per edit |
|---|---|---|---|---|
| main | 4 | 1146 ms / 1244 ms / 1244 ms | 4–5 | 4–5 |
| stale-index | 4 | 113001 ms / 122810 ms / 122810 ms | 5–7 | 5–7 |
| untracked-heavy | 4 | 3645 ms / 3781 ms / 3781 ms | 5–5 | 5–5 |

*To SSE*: processes started between the write and the worktree's `worktree.changed` (the summary and the review state the event waits for). *Per edit*: until the daemon is quiet again, the UI's refetches included. **Run with `--no-incremental`** (every refresh in full).

## API payloads

| Request | Raw | Gzipped (computed) | Sent when asked for gzip | First / warm request |
|---|---|---|---|---|
| projects | 3.6 KiB | 852 B | gzip: 891 B | 8 ms / 1 ms |
| inbox, working | 8.09 MiB | 868.5 KiB | gzip: 896.2 KiB | 142326 ms / 84 ms |
| inbox, review (To review) | 8.09 MiB | 868.5 KiB | gzip: 896.2 KiB | 84 ms / 78 ms |
| inbox, branch + working (All on branch) | 8.09 MiB | 868.5 KiB | gzip: 896.2 KiB | 126506 ms / 79 ms |
| files main, working | 180.5 KiB | 20.9 KiB | gzip: 21.7 KiB | 5 ms / 3 ms |
| files stale-index, working | 180.3 KiB | 20.8 KiB | gzip: 21.6 KiB | 3 ms / 3 ms |
| files untracked-heavy, working | 7.73 MiB | 825.1 KiB | gzip: 850.7 KiB | 71 ms / 67 ms |

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
