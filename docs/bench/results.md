# octopus-diff perf bench

Generated 2026-11-12T19:24:51.211Z · linux 6.18.58.1-microsoft-standard-WSL2 · AMD Ryzen 7 7800X3D 8-Core Processor (12 cores) · Node v26.13.0 · git version 2.53.0

Layout `small`: 30 repos × 3 worktrees (all dirty) = 90 worktrees, generated in 4998 ms.

## Budgets

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| Time to first paint (cold, `data-ready`) | 145 ms | < 3000 ms | PASS |
| Time to first paint (warm reload, median of 3) | 61 ms | < 300 ms | PASS |
| Git spawns from the write to SSE, worst later edit of a worktree (#40) | n/a | ≤ 3 spawns | skipped |
| Edit → SSE p95, later edits of a worktree (#40, 100k-file target) | n/a | < 120 ms | report only |
| Startup git spawns per worktree | 4.5 | ≤ 8 spawns | PASS |
| Idle CPU, daemon + git children (average) | 0.37 % | < 10 % | PASS |
| Refresh: write → SSE `worktree.changed` p95 | 24 ms | < 1000 ms | PASS |
| Diff opened during a 60-edit burst, p95 (#44) | 37 ms | < 100 ms | PASS |
| Browser traffic per edit (worst edit, #51) | 1420 bytes | < 102400 bytes | PASS |
| `/api/projects` requests per edit (worst edit, #51) | 0 requests | < 1 requests | PASS |
| Refresh: write → UI sidebar update p95 | 40 ms | < 1000 ms | PASS |

Tracked budgets are known to fail until the issue they name lands: they are listed as `FAIL (tracked)` and do not turn the run red (). Large layouts report everything but judge only the startup spawns. Run `--strict` to count tracked budgets too.

## Numbers

| Metric | Result |
|---|---|
| Time to first paint (cold) | 145 ms |
| Time to first paint (warm reload; 3 samples) | 61 ms (87 / 59 / 61 ms) |
| Warm reload once the daemon is quiet: git spawns (per worktree, worst of 3; reported, not judged) | 4 / 4 / 4 (0.04) |
| Idle CPU, daemon + git children (avg over 60 s / worst 1 s) | 0.37 % / 4.00 % |
| Refresh: write → SSE `worktree.changed` (p50 / p95 / max) | 14 ms / 24 ms / 24 ms (15/15) |
| Refresh: write → UI sidebar update (p50 / p95 / max) | 25 ms / 40 ms / 40 ms (15/15) |
| Browser traffic per edit, worktree view (median / worst; requests median / worst; `/api/projects` in all edits) | 1.4 KiB / 1.4 KiB; 1 / 1; 0 |
| Daemon startup: listening / all summaries | 754 ms / 957 ms |
| Daemon RSS: end of run / peak | 142.09 MiB / 146.84 MiB |

## Startup git spawns (406 for 90 worktrees = 4.5 per worktree, 3010 ms of git wall time summed)

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
| `status` | 90 | 649 ms | 6.9 ms | 10.8 ms |
| `diff` | 90 | 957 ms | 9.3 ms | 20.4 ms |
| `check-attr` | 90 | 595 ms | 6.4 ms | 10.8 ms |
| `config` | 45 | 252 ms | 5.1 ms | 9.9 ms |
| `rev-parse` | 30 | 210 ms | 6.4 ms | 13.6 ms |
| `worktree` | 30 | 161 ms | 5.1 ms | 6.9 ms |
| `for-each-ref` | 30 | 183 ms | 5.6 ms | 7.5 ms |
| `--version` | 1 | 2 ms | 2.2 ms | 2.2 ms |

## Spawns caused by the UI

| Phase | Git spawns | Wall time (sum) |
|---|---|---|
| coldPaint | 11 | 80 ms |
| warmReload1 | 11 | 65 ms |
| warmReload2 | 13 | 79 ms |
| warmReload3 | 4 | 12 ms |
| settledReload1 | 4 | 12 ms |
| settledReload2 | 4 | 13 ms |
| settledReload3 | 4 | 13 ms |
| editBurst | 329 | 2468 ms |

`warmReload1-3` start right after the cold paint and end at `data-ready`, so they also count the work the cold paint started (review states and labels still being computed). `settledReload1-3` start once no git process ran for 1 s and last until the daemon is quiet again: what one reload costs on its own (issue #74).



## A diff opened during a 60-edit burst (issue #44)

60 appends to `README.md` over 60 other worktrees, back to back, each one a summary refresh in the background; meanwhile `GET /diff` of one changed file of an untouched worktree, one at a time, every 100 ms from the first edit until 2 s after the last; the phase ends when the daemon is quiet again (3160 ms). git-core runs `/diff` in its interactive lane, ahead of queued summaries.

| Metric | Result |
|---|---|
| Diff on the quiet daemon (p50 / max of 7) | 8 ms / 9 ms |
| Diff under the burst (p50 / p95 / max of 19) | 8 ms / 37 ms / 37 ms |
| Added by the burst (p95 − quiet p50) | 29 ms |
| Git spawns during the phase | 329 |

## Edit → SSE by worktree role

| Role | Edits | SSE p50 / p95 / max | Git spawns to SSE | Git spawns per edit |
|---|---|---|---|---|
| bench | 15 | 14 ms / 24 ms / 24 ms | 3–5 | 4–7 |

*To SSE*: processes started between the write and the worktree's `worktree.changed` (the summary and the review state the event waits for). *Per edit*: until the daemon is quiet again, the UI's refetches included.

## API payloads

| Request | Raw | Gzipped (computed) | Sent when asked for gzip | First / warm request |
|---|---|---|---|---|
| projects | 101.3 KiB | 8.5 KiB | gzip: 10.3 KiB | 5 ms / 2 ms |
| inbox, working | 204.4 KiB | 21.5 KiB | gzip: 25.3 KiB | 217 ms / 9 ms |
| inbox, review (To review) | 204.4 KiB | 21.5 KiB | gzip: 25.3 KiB | 107 ms / 8 ms |
| inbox, branch + working (All on branch) | 204.4 KiB | 21.5 KiB | gzip: 25.3 KiB | 30 ms / 27 ms |
| files bench, working | 1.3 KiB | 447 B | gzip: 452 B | 1 ms / 1 ms |

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
