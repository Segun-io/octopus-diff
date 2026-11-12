# octopus-diff perf bench

Generated 2026-11-12T04:14:33.250Z · linux 6.18.58.1-microsoft-standard-WSL2 · AMD Ryzen 7 7800X3D 8-Core Processor (12 cores) · Node v26.13.0 · git version 2.53.0

Layout `small`: 30 repos × 3 worktrees (all dirty) = 90 worktrees, generated in 4772 ms.

## Budgets

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| Time to first paint (cold, `data-ready`) | 874 ms | < 3000 ms | PASS |
| Time to first paint (warm reload, median of 3) | 127 ms | < 300 ms | PASS (tracked: #27 (cache the branch-scope inbox and files); remove it from `TRACKED`) |
| Startup git spawns per worktree | 7.0 | ≤ 8 spawns | PASS |
| Idle CPU, daemon + git children (average) | 0.23 % | < 10 % | PASS |
| Refresh: write → SSE `worktree.changed` p95 | 31 ms | < 1000 ms | PASS |
| Refresh: write → UI sidebar update p95 | 64 ms | < 1000 ms | PASS |

Tracked budgets are known to fail until the issue they name lands: they are listed as `FAIL (tracked)` and do not turn the run red (`warmReload` → #27 (cache the branch-scope inbox and files)). Large layouts report everything but judge only the startup spawns. Run `--strict` to count tracked budgets too.

## Numbers

| Metric | Result |
|---|---|
| Time to first paint (cold) | 874 ms |
| Time to first paint (warm reload; 3 samples) | 127 ms (148 / 123 / 127 ms) |
| Idle CPU, daemon + git children (avg over 60 s / worst 1 s) | 0.23 % / 2.00 % |
| Refresh: write → SSE `worktree.changed` (p50 / p95 / max) | 15 ms / 31 ms / 31 ms (15/15) |
| Refresh: write → UI sidebar update (p50 / p95 / max) | 32 ms / 64 ms / 64 ms (15/15) |
| Daemon startup: listening / all summaries | 788 ms / 1241 ms |
| Daemon RSS: end of run / peak | 105.78 MiB / 162.70 MiB |

## Startup git spawns (626 for 90 worktrees = 7 per worktree, 4253 ms of git wall time summed)

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
| `status` | 180 | 1257 ms | 6.6 ms | 10.6 ms |
| `diff` | 180 | 1295 ms | 6.8 ms | 10.5 ms |
| `check-attr` | 90 | 587 ms | 6.1 ms | 10.6 ms |
| `rev-parse` | 60 | 385 ms | 6.4 ms | 8.9 ms |
| `config` | 55 | 354 ms | 6.6 ms | 10.3 ms |
| `worktree` | 30 | 179 ms | 5.6 ms | 8.7 ms |
| `for-each-ref` | 30 | 193 ms | 5.9 ms | 10.9 ms |
| `--version` | 1 | 2 ms | 2.2 ms | 2.2 ms |

## Spawns caused by the UI

| Phase | Git spawns | Wall time (sum) |
|---|---|---|
| coldPaint | 363 | 2515 ms |
| warmReload1 | 3 | 9 ms |
| warmReload2 | 3 | 9 ms |
| warmReload3 | 11 | 35 ms |

## Edit → SSE by worktree role

| Role | Edits | SSE p50 / p95 / max | Git spawns per edit |
|---|---|---|---|
| bench | 15 | 15 ms / 31 ms / 31 ms | 9–49 |

## API payloads

| Request | Raw | Gzipped (computed) | Sent when asked for gzip | First / warm request |
|---|---|---|---|---|
| projects | 99.1 KiB | 8.3 KiB | gzip: 9.9 KiB | 8 ms / 2 ms |
| inbox, working | 192.6 KiB | 20.5 KiB | gzip: 24.3 KiB | 12 ms / 9 ms |
| inbox, review (To review) | 192.6 KiB | 20.5 KiB | gzip: 24.3 KiB | 10 ms / 7 ms |
| inbox, branch + working (All on branch) | 192.6 KiB | 20.5 KiB | gzip: 24.3 KiB | 18 ms / 14 ms |
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
