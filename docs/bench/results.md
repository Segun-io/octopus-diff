# octopus-diff perf bench

Generated 2026-11-08T12:41:14.310Z · linux 6.18.54.1-microsoft-standard-WSL2 · AMD Ryzen 7 7800X3D 8-Core Processor (12 cores) · Node v26.13.0 · git version 2.53.0

Layout: 30 repos × 3 worktrees = 90 worktrees (all dirty), generated in 5096 ms.

| Metric | Result | Target (PLAN §8.10) | Verdict |
|---|---|---|---|
| Time to first paint (cold, `data-ready`) | 883 ms | < 3000 ms | PASS |
| Time to first paint (warm reload) | 72 ms | — | — |
| Idle CPU, daemon + git children (avg over 60 s) | 0.38 % | single-digit % | PASS |
| Idle CPU, worst 1 s interval | 3.00 % | — | — |
| Refresh: write → SSE `worktree.changed` (p50 / p95 / max) | 14 ms / 15 ms / 15 ms (15/15) | < 1000 ms | PASS |
| Refresh: write → UI sidebar update (p50 / p95 / max) | 29 ms / 38 ms / 38 ms (15/15) | < 1000 ms | PASS |
| Daemon startup: listening / all summaries | 805 ms / 1312 ms | — | — |
| Daemon RSS at end of idle | 138 MiB | — | — |

Raw numbers: `results.json` next to this file. Re-run: `pnpm --filter @octopus-diff/fixtures bench`.
