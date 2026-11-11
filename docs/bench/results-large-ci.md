# octopus-diff perf bench

Generated 2026-11-11T22:55:40.098Z · linux 6.18.58.1-microsoft-standard-WSL2 · AMD Ryzen 7 7800X3D 8-Core Processor (12 cores) · Node v26.13.0 · git version 2.53.0

Layout `large-ci`: one monorepo, 20000 tracked files, 3 worktrees (main with a 30000-line rewrite, a stale index, 5150 untracked files) = 3 worktrees, generated in 2401 ms.

## Budgets

| Metric | Result | Budget | Verdict |
|---|---|---|---|
| Time to first paint (cold, `data-ready`) | 8937 ms | < 3000 ms | report only |
| Time to first paint (warm reload, median of 3) | 4854 ms | < 300 ms | report only |
| Startup git spawns per worktree | 16.7 | ≤ 8 spawns | FAIL (tracked: #10 and #29 (compute each summary once; per-project git metadata)) |
| Idle CPU, daemon + git children (average) | 0.00 % | < 10 % | report only |
| Refresh: write → SSE `worktree.changed` p95 | 6513 ms | < 1000 ms | report only |
| Refresh: write → UI sidebar update p95 | 6529 ms | < 1000 ms | report only |

Tracked budgets are known to fail until the issue they name lands: they are listed as `FAIL (tracked)` and do not turn the run red (`warmReload` → #27 (cache the branch-scope inbox and files); `startupSpawns` → #10 and #29 (compute each summary once; per-project git metadata)). Large layouts report everything but judge only the startup spawns. Run `--strict` to count tracked budgets too.

## Numbers

| Metric | Result |
|---|---|
| Time to first paint (cold) | 8937 ms |
| Time to first paint (warm reload; 3 samples) | 4854 ms (4854 / 4862 / 4852 ms) |
| Idle CPU, daemon + git children (avg over 20 s / worst 1 s) | 0.00 % / 0.00 % |
| Refresh: write → SSE `worktree.changed` (p50 / p95 / max) | 3642 ms / 6513 ms / 6513 ms (15/15) |
| Refresh: write → UI sidebar update (p50 / p95 / max) | 3649 ms / 6529 ms / 6529 ms (15/15) |
| Daemon startup: listening / all summaries | 194 ms / 5395 ms |
| Daemon RSS: end of run / peak | 238.75 MiB / 273.25 MiB |

## Startup git spawns (50 for 3 worktrees = 16.7 per worktree, 3786 ms of git wall time summed)

| Subcommand | Spawns | Wall time (sum) | p50 | p95 |
|---|---|---|---|---|
| `rev-parse` | 13 | 105 ms | 3.8 ms | 20.4 ms |
| `for-each-ref` | 7 | 37 ms | 4.1 ms | 10.4 ms |
| `config` | 7 | 38 ms | 3.6 ms | 12.4 ms |
| `status` | 6 | 1160 ms | 186.7 ms | 214.2 ms |
| `diff` | 6 | 2363 ms | 191 ms | 998.5 ms |
| `symbolic-ref` | 3 | 9 ms | 3.2 ms | 3.6 ms |
| `check-attr` | 2 | 20 ms | 5.2 ms | 15.2 ms |
| `rev-list` | 2 | 43 ms | 11.8 ms | 31 ms |
| `merge-base` | 2 | 6 ms | 2 ms | 3.9 ms |
| `--version` | 1 | 2 ms | 2.5 ms | 2.5 ms |
| `worktree` | 1 | 2 ms | 1.9 ms | 1.9 ms |

## Spawns caused by the UI

| Phase | Git spawns | Wall time (sum) |
|---|---|---|
| coldPaint | 30 | 8469 ms |
| warmReload1 | 29 | 2930 ms |
| warmReload2 | 25 | 2381 ms |
| warmReload3 | 25 | 2142 ms |

## Edit → SSE by worktree role

| Role | Edits | SSE p50 / p95 / max | Git spawns per edit |
|---|---|---|---|
| main | 5 | 3340 ms / 3815 ms / 3815 ms | 20–23 |
| stale-index | 5 | 5317 ms / 6513 ms / 6513 ms | 16–19 |
| untracked-heavy | 5 | 3527 ms / 3642 ms / 3642 ms | 26–33 |

## API payloads

| Request | Raw | Gzipped (computed) | Sent when asked for gzip | First / warm request |
|---|---|---|---|---|
| projects | 3.3 KiB | 792 B | none: 3.3 KiB | 2799 ms / 2 ms |
| inbox, working | 1.45 MiB | 158.4 KiB | none: 1.45 MiB | 396 ms / 13 ms |
| inbox, review (To review) | 1.45 MiB | 158.4 KiB | none: 1.45 MiB | 12 ms / 10 ms |
| inbox, branch + working (All on branch) | 1.45 MiB | 158.4 KiB | none: 1.45 MiB | 5745 ms / 4840 ms |
| files main, working | 64.6 KiB | 7.4 KiB | none: 64.6 KiB | 1 ms / 1 ms |
| files stale-index, working | 64.3 KiB | 7.4 KiB | none: 64.3 KiB | 1 ms / 1 ms |
| files untracked-heavy, working | 1.32 MiB | 142.3 KiB | none: 1.32 MiB | 10 ms / 10 ms |

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
