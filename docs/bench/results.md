# octopus-diff perf bench

Generated 2026-11-08T10:00:18.263Z · linux 6.18.54.1-microsoft-standard-WSL2 · AMD Ryzen 7 7800X3D 8-Core Processor (12 cores) · Node v26.13.0 · git version 2.53.0

Layout: 30 repos × 3 worktrees = 90 worktrees (all dirty), generated in 5246 ms.

| Metric | Result | Target (PLAN §8.10) | Verdict |
|---|---|---|---|
| Time to first paint (cold, `data-ready`) | 1018 ms | < 3000 ms | PASS |
| Time to first paint (warm reload) | 67 ms | — | — |
| Idle CPU, daemon + git children (avg over 60 s) | 0.38 % | single-digit % | PASS |
| Idle CPU, worst 1 s interval | 14.99 % | — | — |
| Refresh: write → SSE `worktree.changed` (p50 / p95 / max) | 216 ms / 218 ms / 218 ms (15/15) | < 1000 ms | PASS |
| Refresh: write → UI sidebar update (p50 / p95 / max) | 296 ms / 298 ms / 298 ms (15/15) | < 1000 ms | PASS |
| Daemon startup: listening / all summaries | 1044 ms / 1103 ms | — | — |
| Daemon RSS at end of idle | 142 MiB | — | — |

Raw numbers: `results.json` next to this file. Re-run: `pnpm --filter @octopus-diff/fixtures bench`.
