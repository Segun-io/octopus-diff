# octopus-diff perf bench

Generated 2026-11-12T03:58:06.457Z · linux 6.18.58.1-microsoft-standard-WSL2 · AMD Ryzen 7 7800X3D 8-Core Processor (12 cores) · Node v26.13.0 · git version 2.53.0

Layout `large-ci`: one monorepo, 20000 tracked files, 3 worktrees (main with a 30000-line rewrite, a stale index, 5150 untracked files) = 3 worktrees, generated in 2204 ms.

## Budgets

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| Time to first paint (cold, `data-ready`) | 122 ms | < 3000 ms | report only |
| Time to first paint (warm reload, median of 3) | 40 ms | < 300 ms | report only |
| Startup git spawns per worktree | 9.0 | ≤ 8 spawns | FAIL (tracked: #10 and #29 (compute each summary once; per-project git metadata)) |
| Idle CPU, daemon + git children (average) | 10.19 % | < 10 % | report only |
| Refresh: write → SSE `worktree.changed` p95 | 5831 ms | < 1000 ms | report only |
| Refresh: write → UI sidebar update p95 | 5841 ms | < 1000 ms | report only |

Tracked budgets are known to fail until the issue they name lands: they are listed as `FAIL (tracked)` and do not turn the run red (`startupSpawns` → #10 and #29 (compute each summary once; per-project git metadata)). Large layouts report everything but judge only the startup spawns. Run `--strict` to count tracked budgets too.

## Numbers

| Metric | Result |
|---|---|
| Time to first paint (cold) | 122 ms |
| Time to first paint (warm reload; 3 samples) | 40 ms (63 / 40 / 39 ms) |
| Idle CPU, daemon + git children (avg over 60 s / worst 1 s) | 10.19 % / 159.99 % |
| Refresh: write → SSE `worktree.changed` (p50 / p95 / max) | 700 ms / 5831 ms / 5831 ms (15/15) |
| Refresh: write → UI sidebar update (p50 / p95 / max) | 721 ms / 5841 ms / 5841 ms (15/15) |
| Daemon startup: listening / all summaries | 162 ms / 881 ms |
| Daemon RSS: end of run / peak | 178.25 MiB / 204.03 MiB |

## Startup git spawns (27 for 3 worktrees = 9 per worktree, 1513 ms of git wall time summed)

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
| `rev-parse` | 7 | 81 ms | 16.4 ms | 19 ms |
| `for-each-ref` | 4 | 29 ms | 7.3 ms | 11.4 ms |
| `config` | 4 | 23 ms | 2.5 ms | 9.4 ms |
| `status` | 3 | 510 ms | 166.1 ms | 178.4 ms |
| `diff` | 3 | 829 ms | 166.1 ms | 498.6 ms |
| `check-attr` | 2 | 21 ms | 8.8 ms | 12.5 ms |
| `rev-list` | 2 | 15 ms | 4.6 ms | 10.8 ms |
| `--version` | 1 | 2 ms | 2.4 ms | 2.4 ms |
| `worktree` | 1 | 2 ms | 2 ms | 2 ms |

## Spawns caused by the UI

| Phase | Git spawns | Wall time (sum) |
|---|---|---|
| coldPaint | 16 | 835 ms |
| warmReload1 | 0 | 0 ms |
| warmReload2 | 0 | 0 ms |
| warmReload3 | 0 | 0 ms |

## Edit → SSE by worktree role

| Role | Edits | SSE p50 / p95 / max | Git spawns per edit |
|---|---|---|---|
| main | 5 | 481 ms / 483 ms / 483 ms | 22–28 |
| stale-index | 5 | 5512 ms / 5831 ms / 5831 ms | 27–36 |
| untracked-heavy | 5 | 700 ms / 708 ms / 708 ms | 29–38 |

## API payloads

| Request | Raw | Gzipped (computed) | Sent when asked for gzip | First / warm request |
|---|---|---|---|---|
| projects | 3.3 KiB | 797 B | gzip: 835 B | 6 ms / 1 ms |
| inbox, working | 1.45 MiB | 158.5 KiB | gzip: 163.5 KiB | 5867 ms / 14 ms |
| inbox, review (To review) | 1.45 MiB | 158.5 KiB | gzip: 163.5 KiB | 14 ms / 14 ms |
| inbox, branch + working (All on branch) | 1.45 MiB | 158.5 KiB | gzip: 163.5 KiB | 12 ms / 11 ms |
| files main, working | 64.6 KiB | 7.4 KiB | gzip: 7.7 KiB | 2 ms / 1 ms |
| files stale-index, working | 64.3 KiB | 7.4 KiB | gzip: 7.6 KiB | 1 ms / 1 ms |
| files untracked-heavy, working | 1.32 MiB | 142.3 KiB | gzip: 146.5 KiB | 10 ms / 10 ms |

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
