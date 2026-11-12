# octopus-diff perf bench

Generated 2026-11-12T15:15:56.657Z · linux 6.18.58.1-microsoft-standard-WSL2 · AMD Ryzen 7 7800X3D 8-Core Processor (12 cores) · Node v26.13.0 · git version 2.53.0

Layout `large-ci`: one monorepo, 20000 tracked files, 3 worktrees (main with a 30000-line rewrite, a stale index, 5150 untracked files) = 3 worktrees, generated in 2220 ms.

## Budgets

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| Time to first paint (cold, `data-ready`) | 126 ms | < 3000 ms | report only |
| Time to first paint (warm reload, median of 3) | 73 ms | < 300 ms | report only |
| Git spawns from the write to SSE, worst later edit of a worktree (#40) | 3.0 | ≤ 3 spawns | PASS |
| Edit → SSE p95, later edits of a worktree (#40, 100k-file target) | 34 ms | < 120 ms | report only |
| Startup git spawns per worktree | 4.7 | ≤ 8 spawns | PASS |
| Idle CPU, daemon + git children (average) | 2.18 % | < 10 % | report only |
| Refresh: write → SSE `worktree.changed` p95 | 42 ms | < 1000 ms | report only |
| Diff opened during a 60-edit burst, p95 (#44) | n/a | < 100 ms | report only |
| Browser traffic per edit (worst edit, #51) | 151216 bytes | < 102400 bytes | report only |
| `/api/projects` requests per edit (worst edit, #51) | 0 requests | < 1 requests | report only |
| Refresh: write → UI sidebar update p95 | 56 ms | < 1000 ms | report only |

Tracked budgets are known to fail until the issue they name lands: they are listed as `FAIL (tracked)` and do not turn the run red (). Large layouts report everything but judge only the startup spawns. Run `--strict` to count tracked budgets too.

## Numbers

| Metric | Result |
|---|---|
| Time to first paint (cold) | 126 ms |
| Time to first paint (warm reload; 3 samples) | 73 ms (94 / 47 / 73 ms) |
| Warm reload once the daemon is quiet: git spawns (per worktree, worst of 3; reported, not judged) | 3 / 3 / 3 (1) |
| Idle CPU, daemon + git children (avg over 60 s / worst 1 s) | 2.18 % / 65.97 % |
| Refresh: write → SSE `worktree.changed` (p50 / p95 / max) | 26 ms / 42 ms / 42 ms (15/15) |
| Refresh: write → UI sidebar update (p50 / p95 / max) | 41 ms / 56 ms / 56 ms (15/15) |
| Browser traffic per edit, Inbox view (median / worst; requests median / worst; `/api/projects` in all edits) | 8.8 KiB / 147.7 KiB; 1 / 1; 0 |
| Daemon startup: listening / all summaries | 174 ms / 948 ms |
| Daemon RSS: end of run / peak | 247.81 MiB / 247.81 MiB |

## Startup git spawns (14 for 3 worktrees = 4.7 per worktree, 1226 ms of git wall time summed)

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
| `status` | 3 | 444 ms | 175.5 ms | 183.2 ms |
| `diff` | 3 | 756 ms | 157.9 ms | 523.9 ms |
| `config` | 2 | 6 ms | 2.1 ms | 4 ms |
| `check-attr` | 2 | 8 ms | 4.1 ms | 4.3 ms |
| `--version` | 1 | 2 ms | 2.2 ms | 2.2 ms |
| `rev-parse` | 1 | 2 ms | 1.7 ms | 1.7 ms |
| `worktree` | 1 | 2 ms | 2.2 ms | 2.2 ms |
| `for-each-ref` | 1 | 5 ms | 5.2 ms | 5.2 ms |

## Spawns caused by the UI

| Phase | Git spawns | Wall time (sum) |
|---|---|---|
| coldPaint | 3 | 136 ms |
| warmReload1 | 0 | 0 ms |
| warmReload2 | 2 | 19 ms |
| warmReload3 | 2 | 7 ms |
| settledReload1 | 3 | 297 ms |
| settledReload2 | 3 | 300 ms |
| settledReload3 | 3 | 310 ms |

`warmReload1-3` start right after the cold paint and end at `data-ready`, so they also count the work the cold paint started (review states and labels still being computed). `settledReload1-3` start once no git process ran for 1 s and last until the daemon is quiet again: what one reload costs on its own (issue #74).



## Edit → SSE by worktree role

| Role | Edits | SSE p50 / p95 / max | Git spawns to SSE | Git spawns per edit |
|---|---|---|---|---|
| main | 5 | 25 ms / 29 ms / 29 ms | 3–3 | 4–4 |
| stale-index | 5 | 25 ms / 29 ms / 29 ms | 3–3 | 4–4 |
| untracked-heavy | 5 | 34 ms / 42 ms / 42 ms | 3–3 | 4–4 |

*To SSE*: processes started between the write and the worktree's `worktree.changed` (the summary and the review state the event waits for). *Per edit*: until the daemon is quiet again, the UI's refetches included.

## API payloads

| Request | Raw | Gzipped (computed) | Sent when asked for gzip | First / warm request |
|---|---|---|---|---|
| projects | 3.6 KiB | 841 B | gzip: 886 B | 5 ms / 1 ms |
| inbox, working | 1.45 MiB | 158.5 KiB | gzip: 163.6 KiB | 75 ms / 16 ms |
| inbox, review (To review) | 1.45 MiB | 158.5 KiB | gzip: 163.6 KiB | 13 ms / 13 ms |
| inbox, branch + working (All on branch) | 1.45 MiB | 158.5 KiB | gzip: 163.6 KiB | 14 ms / 12 ms |
| files main, working | 64.6 KiB | 7.4 KiB | gzip: 7.7 KiB | 2 ms / 1 ms |
| files stale-index, working | 64.3 KiB | 7.4 KiB | gzip: 7.6 KiB | 1 ms / 1 ms |
| files untracked-heavy, working | 1.32 MiB | 142.3 KiB | gzip: 146.6 KiB | 11 ms / 11 ms |

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

Raw numbers: `results-large-ci.json` next to this file. Re-run: `pnpm --filter @octopus-diff/e2e bench --layout large-ci`.
