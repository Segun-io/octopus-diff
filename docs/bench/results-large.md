# octopus-diff perf bench

Generated 2026-11-12T20:13:33.504Z · linux 6.18.58.1-microsoft-standard-WSL2 · AMD Ryzen 7 7800X3D 8-Core Processor (12 cores) · Node v26.13.0 · git version 2.53.0

Layout `large`: one monorepo, 100000 tracked files, 3 worktrees (main with a 300000-line rewrite, a stale index, 30400 untracked files) = 3 worktrees, generated in 9907 ms.

## Budgets

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| Time to first paint (cold, `data-ready`) | 166 ms | < 3000 ms | report only |
| Time to first paint (warm reload, median of 3) | 53 ms | < 300 ms | report only |
| Git spawns from the write to SSE, worst later edit of a worktree (#40) | 3.0 | ≤ 3 spawns | PASS |
| Edit → SSE p95, later edits of a worktree (#40, 100k-file target) | 78 ms | < 120 ms | report only |
| Startup git spawns per worktree | 4.7 | ≤ 8 spawns | PASS |
| Idle CPU, daemon + git children (average) | 2.68 % | < 10 % | report only |
| Refresh: write → SSE `worktree.changed` p95 | 268 ms | < 1000 ms | report only |
| Diff opened during a 60-edit burst, p95 (#44) | n/a | < 100 ms | report only |
| Browser traffic per edit (worst edit, #51) | 47144 bytes | < 102400 bytes | report only |
| `/api/projects` requests per edit (worst edit, #51) | 0 requests | < 1 requests | report only |
| Refresh: write → UI sidebar update p95 | 276 ms | < 1000 ms | report only |

Tracked budgets are known to fail until the issue they name lands: they are listed as `FAIL (tracked)` and do not turn the run red (). Large layouts report everything but judge only the startup spawns. Run `--strict` to count tracked budgets too.

## Numbers

| Metric | Result |
|---|---|
| Time to first paint (cold) | 166 ms |
| Time to first paint (warm reload; 3 samples) | 53 ms (66 / 44 / 53 ms) |
| Warm reload once the daemon is quiet: git spawns (per worktree, worst of 3; reported, not judged) | 4 / 4 / 4 (1.33) |
| Idle CPU, daemon + git children (avg over 60 s / worst 1 s) | 2.68 % / 81.97 % |
| Refresh: write → SSE `worktree.changed` (p50 / p95 / max) | 61 ms / 268 ms / 268 ms (15/15) |
| Refresh: write → UI sidebar update (p50 / p95 / max) | 76 ms / 276 ms / 276 ms (15/15) |
| Browser traffic per edit, worktree view (median / worst; requests median / worst; `/api/projects` in all edits) | 22.8 KiB / 46.0 KiB; 1 / 3; 0 |
| Daemon startup: listening / all summaries | 192 ms / 3153 ms |
| Daemon RSS: end of run / peak | 223.96 MiB / 238.37 MiB |

## Startup git spawns (14 for 3 worktrees = 4.7 per worktree, 4973 ms of git wall time summed)

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
| `diff` | 3 | 3322 ms | 489.8 ms | 2617.6 ms |
| `status` | 3 | 1606 ms | 428.7 ms | 881.2 ms |
| `config` | 2 | 5 ms | 2.2 ms | 2.4 ms |
| `check-attr` | 2 | 29 ms | 13.7 ms | 15.7 ms |
| `--version` | 1 | 2 ms | 2.3 ms | 2.3 ms |
| `rev-parse` | 1 | 2 ms | 1.7 ms | 1.7 ms |
| `worktree` | 1 | 2 ms | 2.2 ms | 2.2 ms |
| `for-each-ref` | 1 | 5 ms | 5.1 ms | 5.1 ms |

## Spawns caused by the UI

| Phase | Git spawns | Wall time (sum) |
|---|---|---|
| coldPaint | 4 | 1176 ms |
| warmReload1 | 1 | 3 ms |
| warmReload2 | 1 | 2 ms |
| warmReload3 | 1 | 3 ms |
| settledReload1 | 4 | 405 ms |
| settledReload2 | 4 | 394 ms |
| settledReload3 | 4 | 394 ms |

`warmReload1-3` start right after the cold paint and end at `data-ready`, so they also count the work the cold paint started (review states and labels still being computed). `settledReload1-3` start once no git process ran for 1 s and last until the daemon is quiet again: what one reload costs on its own (issue #74).



## Edit → SSE by worktree role

| Role | Edits | SSE p50 / p95 / max | Git spawns to SSE | Git spawns per edit |
|---|---|---|---|---|
| main | 5 | 58 ms / 69 ms / 69 ms | 3–4 | 4–5 |
| stale-index | 5 | 57 ms / 65 ms / 65 ms | 3–3 | 4–4 |
| untracked-heavy | 5 | 75 ms / 268 ms / 268 ms | 3–3 | 4–4 |

*To SSE*: processes started between the write and the worktree's `worktree.changed` (the summary and the review state the event waits for). *Per edit*: until the daemon is quiet again, the UI's refetches included.

## API payloads

| Request | Raw | Gzipped (computed) | Sent when asked for gzip | First / warm request |
|---|---|---|---|---|
| projects | 3.7 KiB | 909 B | gzip: 960 B | 5 ms / 1 ms |
| inbox, working | 546.6 KiB | 64.3 KiB | gzip: 67.3 KiB | 517 ms / 6 ms |
| inbox, review (To review) | 546.6 KiB | 64.3 KiB | gzip: 67.3 KiB | 6 ms / 6 ms |
| inbox, branch + working (All on branch) | 546.7 KiB | 64.3 KiB | gzip: 67.3 KiB | 8 ms / 6 ms |
| files main, working | 180.5 KiB | 20.9 KiB | gzip: 21.7 KiB | 2 ms / 2 ms |
| files stale-index, working | 180.3 KiB | 20.8 KiB | gzip: 21.6 KiB | 2 ms / 2 ms |
| files untracked-heavy, working | 182.8 KiB | 20.9 KiB | gzip: 21.8 KiB | 2 ms / 2 ms |

## Summary by worktree role (#43)

git-core in the bench process after the daemon stopped (nothing else running): a full summary with a new git-core (*cold*, as at startup), full summaries with a kept state (*warm*: reconciliation, focus, polls, git-dir events), and incremental ones after a one-line append to `README.md` (*edit*); then the working list of the last summary as JSON.

| Role | Untracked files | Cold | Warm (3) | Edit (3) | Working list |
|---|---|---|---|---|---|
| main | 400 | 524 ms | 422 ms / 414 ms / 416 ms | 41 ms / 38 ms / 38 ms | 702 rows, 168.8 KiB |
| stale-index | 400 | 2494 ms | 2421 ms / 2397 ms / 2424 ms | 41 ms / 39 ms / 40 ms | 701 rows, 168.5 KiB |
| untracked-heavy | 30400 (30000 not listed) | 338 ms | 317 ms / 299 ms / 316 ms | 55 ms / 57 ms / 55 ms | 701 rows, 170.9 KiB |

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
