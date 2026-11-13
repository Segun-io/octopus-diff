# octopus-diff perf bench

Generated 2026-11-13T16:35:54.063Z · linux 6.18.58.1-microsoft-standard-WSL2 · AMD Ryzen 7 7800X3D 8-Core Processor (12 cores) · Node v26.13.0 · git version 2.53.0

Layout `small`: 30 repos × 3 worktrees (all dirty) = 90 worktrees, generated in 5155 ms.

## Budgets

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| Time to first paint (cold, `data-ready`) | 152 ms | < 3000 ms | PASS |
| Time to first paint (warm reload, median of 3) | 66 ms | < 300 ms | PASS |
| Git spawns from the write to SSE, worst later edit of a worktree (#40) | n/a | ≤ 3 spawns | skipped |
| Edit → SSE p95, later edits of a worktree (#40, 100k-file target) | n/a | < 120 ms | report only |
| Startup git spawns per worktree | 4.6 | ≤ 8 spawns | PASS |
| Idle CPU, daemon + git children (average) | 0.17 % | < 10 % | PASS |
| Refresh: write → SSE `worktree.changed` p95 | 23 ms | < 1000 ms | PASS |
| Diff opened during a 60-edit burst, p95 (#44) | 25 ms | < 100 ms | PASS |
| Browser traffic per edit (worst edit, #51) | 1453 bytes | < 102400 bytes | PASS |
| `/api/projects` requests per edit (worst edit, #51) | 0 requests | < 1 requests | PASS |
| Refresh: write → UI sidebar update p95 | 32 ms | < 1000 ms | PASS |

Tracked budgets are known to fail until the issue they name lands: they are listed as `FAIL (tracked)` and do not turn the run red (). Large layouts report everything but judge only the startup spawns. Run `--strict` to count tracked budgets too.

## Numbers

| Metric | Result |
|---|---|
| Time to first paint (cold) | 152 ms |
| Time to first paint (warm reload; 3 samples) | 66 ms (73 / 66 / 61 ms) |
| Warm reload once the daemon is quiet: git spawns (per worktree, worst of 3; reported, not judged) | 2 / 2 / 2 (0.02) |
| Idle CPU, daemon + git children (avg over 60 s / worst 1 s) | 0.17 % / 1.00 % |
| Refresh: write → SSE `worktree.changed` (p50 / p95 / max) | 13 ms / 23 ms / 23 ms (15/15) |
| Refresh: write → UI sidebar update (p50 / p95 / max) | 22 ms / 32 ms / 32 ms (15/15) |
| Browser traffic per edit, worktree view (median / worst; requests median / worst; `/api/projects` in all edits) | 1.4 KiB / 1.4 KiB; 1 / 1; 0 |
| Daemon startup: listening / all summaries | 655 ms / 753 ms |
| Daemon RSS: end of run / peak | 174.77 MiB / 174.77 MiB |
| File list cache (#49): hits / misses / in-flight joins (entries / capacity) | 1344 / 359 / 0 (270 / 2000) |
| Review range cache (#49): hits / misses / in-flight joins | 4 / 100 / 0 |

## Startup git spawns (416 for 90 worktrees = 4.6 per worktree, 1135 ms of git wall time summed)

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
| `status` | 90 | 234 ms | 2.5 ms | 3.3 ms |
| `diff` | 90 | 248 ms | 2.6 ms | 3.6 ms |
| `check-attr` | 90 | 350 ms | 3.4 ms | 6.8 ms |
| `config` | 55 | 106 ms | 1.8 ms | 2.9 ms |
| `rev-parse` | 30 | 66 ms | 1.8 ms | 6.1 ms |
| `worktree` | 30 | 59 ms | 1.8 ms | 2.8 ms |
| `for-each-ref` | 30 | 70 ms | 2.2 ms | 2.7 ms |
| `--version` | 1 | 3 ms | 3.4 ms | 3.4 ms |

## Spawns caused by the UI

| Phase | Git spawns | Wall time (sum) |
|---|---|---|
| coldPaint | 15 | 44 ms |
| warmReload1 | 7 | 19 ms |
| warmReload2 | 11 | 30 ms |
| warmReload3 | 2 | 5 ms |
| settledReload1 | 2 | 5 ms |
| settledReload2 | 2 | 5 ms |
| settledReload3 | 2 | 5 ms |
| editBurst | 292 | 669 ms |

`warmReload1-3` start right after the cold paint and end at `data-ready`, so they also count the work the cold paint started (review states and labels still being computed). `settledReload1-3` start once no git process ran for 1 s and last until the daemon is quiet again: what one reload costs on its own (issue #74).



## A diff opened during a 60-edit burst (issue #44)

60 appends to `README.md` over 60 other worktrees, back to back, each one a summary refresh in the background; meanwhile `GET /diff` of one changed file of an untouched worktree, one at a time, every 100 ms from the first edit until 2 s after the last; the phase ends when the daemon is quiet again (3167 ms). git-core runs `/diff` in its interactive lane, ahead of queued summaries.

| Metric | Result |
|---|---|
| Diff on the quiet daemon (p50 / max of 7) | 4 ms / 5 ms |
| Diff under the burst (p50 / p95 / max of 20) | 4 ms / 25 ms / 37 ms |
| Added by the burst (p95 − quiet p50) | 21 ms |
| Git spawns during the phase | 292 |

## Edit → SSE by worktree role

| Role | Edits | SSE p50 / p95 / max | Git spawns to SSE | Git spawns per edit |
|---|---|---|---|---|
| bench | 15 | 13 ms / 23 ms / 23 ms | 3–5 | 4–8 |

*To SSE*: processes started between the write and the worktree's `worktree.changed` (the summary and the review state the event waits for). *Per edit*: until the daemon is quiet again, the UI's refetches included.

## API payloads

| Request | Raw | Gzipped (computed) | Sent when asked for gzip | First / warm request |
|---|---|---|---|---|
| projects | 101.3 KiB | 8.5 KiB | gzip: 10.3 KiB | 5 ms / 2 ms |
| inbox, working | 211.4 KiB | 21.6 KiB | gzip: 25.8 KiB | 119 ms / 10 ms |
| inbox, review (To review) | 211.4 KiB | 21.6 KiB | gzip: 25.8 KiB | 84 ms / 11 ms |
| inbox, branch + working (All on branch) | 211.4 KiB | 21.6 KiB | gzip: 25.8 KiB | 31 ms / 27 ms |
| files bench, working | 1.5 KiB | 512 B | gzip: 531 B | 1 ms / 1 ms |

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
