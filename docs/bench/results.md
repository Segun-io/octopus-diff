# octopus-diff perf bench

Generated 2026-11-12T11:24:30.964Z · linux 6.18.58.1-microsoft-standard-WSL2 · AMD Ryzen 7 7800X3D 8-Core Processor (12 cores) · Node v26.13.0 · git version 2.53.0

Layout `small`: 30 repos × 3 worktrees (all dirty) = 90 worktrees, generated in 5286 ms.

## Budgets

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| Time to first paint (cold, `data-ready`) | 162 ms | < 3000 ms | PASS |
| Time to first paint (warm reload, median of 3) | 75 ms | < 300 ms | PASS |
| Startup git spawns per worktree | 4.5 | ≤ 8 spawns | PASS |
| Idle CPU, daemon + git children (average) | 0.33 % | < 10 % | PASS |
| Refresh: write → SSE `worktree.changed` p95 | 20 ms | < 1000 ms | PASS |
| Diff opened during a 60-edit burst, p95 (#44) | 44 ms | < 100 ms | PASS |
| Refresh: write → UI sidebar update p95 | 39 ms | < 1000 ms | PASS |

Tracked budgets are known to fail until the issue they name lands: they are listed as `FAIL (tracked)` and do not turn the run red (). Large layouts report everything but judge only the startup spawns. Run `--strict` to count tracked budgets too.

## Numbers

| Metric | Result |
|---|---|
| Time to first paint (cold) | 162 ms |
| Time to first paint (warm reload; 3 samples) | 75 ms (96 / 75 / 71 ms) |
| Warm reload once the daemon is quiet: git spawns (per worktree, worst of 3; reported, not judged) | 3 / 3 / 3 (0.03) |
| Idle CPU, daemon + git children (avg over 60 s / worst 1 s) | 0.33 % / 3.00 % |
| Refresh: write → SSE `worktree.changed` (p50 / p95 / max) | 16 ms / 20 ms / 20 ms (15/15) |
| Refresh: write → UI sidebar update (p50 / p95 / max) | 26 ms / 39 ms / 39 ms (15/15) |
| Daemon startup: listening / all summaries | 814 ms / 988 ms |
| Daemon RSS: end of run / peak | 151.23 MiB / 151.23 MiB |

## Startup git spawns (407 for 90 worktrees = 4.5 per worktree, 2976 ms of git wall time summed)

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
| `status` | 90 | 719 ms | 7.8 ms | 12.7 ms |
| `diff` | 90 | 738 ms | 7.7 ms | 12 ms |
| `check-attr` | 90 | 631 ms | 6.7 ms | 10.3 ms |
| `config` | 46 | 310 ms | 5.9 ms | 12.4 ms |
| `rev-parse` | 30 | 191 ms | 6.4 ms | 10.5 ms |
| `worktree` | 30 | 173 ms | 5.5 ms | 10.9 ms |
| `for-each-ref` | 30 | 211 ms | 6.5 ms | 11.6 ms |
| `--version` | 1 | 3 ms | 2.7 ms | 2.7 ms |

## Spawns caused by the UI

| Phase | Git spawns | Wall time (sum) |
|---|---|---|
| coldPaint | 33 | 220 ms |
| warmReload1 | 7 | 30 ms |
| warmReload2 | 21 | 137 ms |
| warmReload3 | 3 | 10 ms |
| settledReload1 | 3 | 9 ms |
| settledReload2 | 3 | 8 ms |
| settledReload3 | 3 | 9 ms |
| editBurst | 449 | 2994 ms |

`warmReload1-3` start right after the cold paint and end at `data-ready`, so they also count the work the cold paint started (review states and labels still being computed). `settledReload1-3` start once no git process ran for 1 s and last until the daemon is quiet again: what one reload costs on its own (issue #74).



## A diff opened during a 60-edit burst (issue #44)

60 appends to `README.md` over 60 other worktrees, back to back, each one a summary refresh in the background; meanwhile `GET /diff` of one changed file of an untouched worktree, one at a time, every 100 ms from the first edit until 2 s after the last; the phase ends when the daemon is quiet again (3087 ms). git-core runs `/diff` in its interactive lane, ahead of queued summaries.

| Metric | Result |
|---|---|
| Diff on the quiet daemon (p50 / max of 7) | 8 ms / 9 ms |
| Diff under the burst (p50 / p95 / max of 18) | 9 ms / 44 ms / 44 ms |
| Added by the burst (p95 − quiet p50) | 36 ms |
| Git spawns during the phase | 449 |

## Edit → SSE by worktree role

| Role | Edits | SSE p50 / p95 / max | Git spawns per edit |
|---|---|---|---|
| bench | 15 | 16 ms / 20 ms / 20 ms | 6–12 |

## API payloads

| Request | Raw | Gzipped (computed) | Sent when asked for gzip | First / warm request |
|---|---|---|---|---|
| projects | 98.8 KiB | 8.3 KiB | gzip: 10.0 KiB | 5 ms / 2 ms |
| inbox, working | 204.4 KiB | 21.6 KiB | gzip: 25.4 KiB | 291 ms / 8 ms |
| inbox, review (To review) | 204.4 KiB | 21.6 KiB | gzip: 25.4 KiB | 156 ms / 7 ms |
| inbox, branch + working (All on branch) | 204.4 KiB | 21.6 KiB | gzip: 25.4 KiB | 30 ms / 30 ms |
| files bench, working | 1.3 KiB | 447 B | gzip: 455 B | 1 ms / 1 ms |

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
