# review-perf report

Performance review of `main` at `f777775` (Phase 2c, PLAN §6), on branch `review/perf`.
Everything below was measured on this machine on 2026-11-08; prototypes are separate commits the
lead can take or leave.

## Headline

The MVP meets every PLAN §8.10 target at 30 × 3, but the bench hides where time goes:

1. **Every git spawn blocks the daemon's event loop**, and the cost grows with the daemon's RSS
   (`fork()` copies page tables: ~0.015 ms per MiB, ≈ 2 ms at today's 130–150 MiB). Startup is
   bound by this, not by git concurrency (2, 4 or 8 slots all give ~1150 ms). This is the main
   scaling limit; the fix is a small spawn-helper process (measured 4.6× faster in a
   micro-benchmark). Not prototyped (too large for this pass).
2. **Idle CPU spikes come from timers that fire in lockstep**: the 60 s relist (13–16 % for 2 s)
   and the 5 min fallback poll of all 90 worktrees (**108 % for one second**, outside bench.ts's
   60 s window). Jitter fixes it (worst second 6 %).
3. **Refresh latency is the 200 ms debounce plus the UI's 60 ms batch window.** Leading-edge
   refresh + immediate client flush: write → UI sidebar p50 **290–296 → 23–30 ms** (profiler /
   bench).
4. **Each edit refetched the whole inbox**: 267 KB at 30 × 3, 1.57 MB at 6000 files, 4.7 MB at
   18 000 files. Per-worktree patching in the client: 80 KB / 77 KB / 130 KB.
5. **Diff highlighting never ran in the workers** when served by the daemon: the API CSP
   (`default-src 'none'`) on `/assets/worker-*.js` blocked the workers' Shiki import. Opening a
   10 000-line diff froze the page for 1.8 s; with the fix it is ready in 110 ms.
6. **First paint is dominated by the cold inbox** (90 × `listChangedFiles` on the first request):
   0.5 s at 30 × 3, 1.5–1.8 s at 100 × 3 or 18 000 files. Not prototyped; recommendation R3.

| PLAN §8.10 metric, 30 × 3 (`bench.ts`, 15 refreshes per run) | baseline `f777775` (3 runs: committed `docs/bench`, 2 re-runs) | `review/perf` (2 runs) | target |
|---|---|---|---|
| First paint, cold | 883 / 1018 / 1029 ms | 963 / 967 ms | < 3000 ms |
| Idle CPU avg / worst 1 s (60 s window) | 0.35–0.43 % / 13.0–16.0 % | 0.27–0.35 % / 3.0 % | single-digit % |
| Idle CPU worst 1 s over 330 s (`profile.ts`) | 108.1 % | 6 % | — |
| Write → SSE p50 / p95 | 216–217 / 217–219 ms | 12–13 / 14–26 ms | < 1000 ms |
| Write → UI sidebar p50 / p95 | 296 / 298–301 ms | 29–30 / 32–46 ms | < 1000 ms |
| Daemon listening / all summaries | 1044–1073 / 1099–1125 ms | 627–629 / 1057 ms | — |
| RSS end of idle | 137–146 MiB | 127 MiB | — |

## Environment and method

- Machine: AMD Ryzen 7 7800X3D (12 logical cores visible to WSL), 19 GiB RAM, WSL2 kernel
  6.18.54.1-microsoft-standard-WSL2, Node 26.13.0, git 2.53.0, pnpm 12.16.1,
  `fs.inotify.max_user_watches=524288`, `max_user_instances=128`. Two other reviewers ran on the
  same machine at the same time, so numbers are repeated (spread shown as `a / b` or ranges) and
  CPU is read per process from `/proc/<pid>/stat` (daemon + reaped git children; 100 Hz ticks, so
  one tick in a 1 s interval = 1 %).
- Fixtures: the WS4 generator's bench layout (default 30 repos × 3 worktrees, 40 files per repo,
  3 dirty + 1 untracked file per worktree), all under `mkdtemp(os.tmpdir())` with the fixtures'
  isolated git config and removed afterwards. Daemon on `127.0.0.1:0` with temp state/config dirs.
- Tools:
  - `e2e/bench/bench.ts` (WS4, unchanged): startup, first paint, 60 s idle, 15 refreshes.
  - `e2e/bench/profile.ts` + `e2e/bench/spawn-trace.mjs` (new): runs the built daemon as a child
    with a preload that logs every git process (subcommand, cwd, duration) and
    `process.memoryUsage()` every 2 s, plus debug logs (time the debounce fired). Reports startup
    git spawns by subcommand, inotify instances/watches from `/proc/<pid>/fdinfo` and when they
    settle, RSS, idle CPU per second correlated with the spawns in that second, a per-refresh
    stage breakdown (write → debounce fired → git work → SSE → UI, with the UI's refetches from
    Resource Timing and browser main-thread time from CDP `Performance.getMetrics`), direct
    `/api` timings, an agent-simulator burst, a big repository, and a large diff opened in the UI
    (click → ready, long tasks, page CPU profile, scroll frames, console/CSP errors).
    Run from `e2e/`: `pnpm exec tsx bench/profile.ts --out /tmp/x [--repos --worktrees --files
    --dirty --idle-seconds --iterations --no-ui --cpu-prof --big-files --node-modules-files
    --burst-seconds --burst-worktrees --large-diff-lines --refresh-target --relist-ms
    --git-concurrency]`.
  - `node --cpu-prof` on the daemon for attribution only (the sampler adds ~4.5 % idle CPU).
  - Micro-benchmarks in `/tmp` (not committed, described where used): spawn cost vs RSS, a spawn
    helper process, `@parcel/watcher` subscribe cost, zod validation cost.
- Baseline = `f777775`. For the scale scenarios the baseline was also built from
  `git archive f777775` in a temp dir, with the same `profile.ts`, so both builds ran on
  identical fixtures (same seed).

## Where the time goes (baseline, 30 × 3)

### Startup (spawn → listening 1054–1109 ms, all summaries 1097–1160 ms; 5 runs)

- **646 git spawns**: `rev-parse` 165, `for-each-ref` 120, `config --get-regexp ^filter.` 90,
  `status` 90, `diff --numstat` 90, `rev-list` 60, `worktree list` 30, `--version` 1. That is
  ~3 per project (resolve: `rev-parse`, `worktree list`, default-branch `for-each-ref`) plus ~6
  per worktree (`rev-parse` for the repo cache, summary: `config`, `status`, `diff --numstat`,
  `for-each-ref` to resolve the default branch, `rev-list` for agent branches).
- **628 of the 646 spawns happen before the port opens**: `startDaemon` awaited each startup
  project's registration in turn (`apps/daemon/src/daemon.ts:179`), and every registration kicks
  off its summaries, which compete for the same git slots.
- **The event loop, not git, is the bottleneck.** CPU profile of the first 2 s: 782 ms of the
  ~1200 ms of non-idle main-thread samples are in `ChildProcess.spawn` itself (≈ 1.2 ms per spawn
  under the profiler). Git concurrency 2 / 4 / 8 gives all summaries in 1176–1203 /
  1164–1178 / 1132–1146 ms: more slots don't help because spawning is serialized on the main
  thread.
- **Spawn cost is proportional to RSS.** `spawn('/usr/bin/git', ['--version'])` from a Node
  process holding extra memory (synchronous part, p50 of 200): 54 MiB → 0.63 ms, 154 MiB →
  2.17 ms, 456 MiB → 6.7 ms, 1059 MiB → 16.0 ms. The daemon is 86 MiB empty (45 MiB bare Node +
  38 MiB of imported modules), 130–150 MiB at 30 × 3, ~200 MiB at 100 × 3, 220–280 MiB with
  18 000 dirty files, so every git call gets slower as the fleet grows.
- **Spawn helper** (micro-benchmark, 640 × `git status` at concurrency 4 from a 153 MiB process):
  direct 1367 ms wall with the event loop blocked 1321 ms; via one small helper process (IPC,
  the helper spawns) 495 ms, loop blocked 7 ms; two helpers 298 ms. From a 365 MiB process:
  direct 3512 ms, two helpers 290 ms.

### Idle (60 s window: average 0.34–0.43 %, worst second 13–16 %)

- The worst seconds are always t ≈ 60 s after start: **all 30 project relists fire together**
  (`watcher.ts:604`, armed at the same time): 72 spawns (`rev-parse` + `worktree list`, the repo
  cache's 30 s TTL has expired) in 2 s, 8–10 % of it daemon self time (spawn cost).
- Over 330 s: **at t = 300 s all 90 fallback polls fire in the same second** (`watcher.ts:623`):
  702 spawns in 2 s, **108 %** CPU (44 % daemon + 64 % git) then 61 %. Average 0.76 %.
- SSE heartbeats (15 s), the focused worktree's 30 s poll (one summary, 5 spawns) and GC are
  negligible. With the UI open and idle the browser uses ~20 ms of task time per 70 s.

### Single-file refresh (write → SSE 216 ms, → UI 290 ms)

| Stage | Time | Notes |
|---|---|---|
| write → watcher event | ≤ 1 ms | `@parcel/watcher` inotify latency 0.3–0.5 ms |
| debounce | 200 ms | `WATCH_DEFAULTS.debounceMs`; 93 % of write → SSE |
| summary git work | 13–16 ms | 5–6 spawns of 2.2–3.6 ms: `rev-parse` (repo cache expired), `config`, `status`, `for-each-ref`, `diff --numstat`, `rev-list` |
| SSE emit → client | < 1 ms | |
| client batch window | 60 ms | `EVENT_BATCH_MS` |
| refetch | 12–19 ms | `/api/projects` 78 KB (2–3 ms) ‖ `/api/inbox` 187 KB (TTFB 11–15 ms: ~9 ms is `listChangedFiles` of the changed worktree, 3 spawns) ‖ open file's `/diff` |
| render | 5–10 ms script, 22–34 ms task time | CDP metrics per refresh |

What one `worktree.changed` costs the client: 267 KB at 30 × 3 (78 KB projects + 187 KB inbox),
884 KB at 100 × 3, 1.57 MB at 30 worktrees × 200 files, 4.7 MB at 90 worktrees × 200 files;
browser task time 22–34 / 44 / 44 / 90 ms. zod validation of the response in the browser client
(`validate: true` by default) is part of it: 0.8 ms for 150 KB, 5.3 ms for 1.5 MB, 16.6 ms for
4.7 MB (plus 0.3 / 2.3 / 6.8 ms `JSON.parse`), measured in Node.

### First paint (cold 881–1029 ms)

The first `/api/inbox` takes 420–550 ms because the file-list cache is empty: 90 ×
`listChangedFiles(working)` = 270 spawns. It is ~half of first paint at 30 × 3 and 80–90 % at
larger scales (1.5–1.8 s at 100 × 3 and at 18 000 files).

### Memory

RSS 130–146 MiB at 30 × 3 (V8 heap 55 MiB total / 29 MiB used; the rest is code, native modules,
allocator). `@parcel/watcher` keeps an in-memory tree of every watched file: +52 MiB for a
50 000-file tree in a bare process. File-list caches and inbox JSON add ~60 MiB at 6000 dirty
files and ~130 MiB at 18 000 (RSS 127 → 185 and 151 → 278 MiB over the baseline runs).

## Findings, ranked by impact

Line numbers refer to `f777775`.

| # | Finding | Evidence | Location | Recommendation | Status |
|---|---|---|---|---|---|
| F1 | Git spawns block the event loop; cost ∝ RSS; startup and bursts are bound by it | CPU profile (782 ms of ~1200 ms in `spawn`), concurrency 2/4/8 equal, spawn-vs-RSS and helper micro-benchmarks | `packages/git-core/src/runner/runner.ts:274` | R1 spawn helper; R2 fewer spawns | R2 partly (P4) |
| F2 | Highlight workers blocked by CSP → all highlighting on the main thread | `request failed /assets/shiki-…js: csp`, 1.73–1.82 s long task (`findNextMatchSync`) for a 10 000-line diff | `apps/daemon/src/app.ts:151,360` | serve scripts with `UI_CSP` | **P8** |
| F3 | Debounce + client batch dominate refresh latency | stage table above | `apps/daemon/src/watcher.ts:297`, `apps/web/src/api/hooks.ts:64` | leading edge; immediate flush when quiet | **P3, P7** |
| F4 | Every edit refetches the whole inbox (and projects) | 267 KB → 4.7 MB per edit; 20.7 MB of inbox in a 30 s burst | `apps/web/src/api/cache.ts:186` | patch per worktree (done); R4 summary in the event | **P6**, R4 |
| F5 | Lockstep timers: 60 s relist and 5 min poll herd | 108 % worst second at t = 300 s; 13–16 % at t = 60 s | `apps/daemon/src/watcher.ts:604,623` | jitter | **P2** |
| F6 | Cold inbox dominates first paint and grows with dirty worktrees × files | 0.5 s (30 × 3) → 1.5–1.8 s (100 × 3, 18 000 files) | `apps/daemon/src/core.ts:980` | R3 precompute / stream | open |
| F7 | Watcher ignore globs: 24 `**/name` regexes per crawled path | 50k-file subscribe 1.8 s vs 0.33 s compacted vs 0.1 s none | `apps/daemon/src/watcher.ts:152,216` | one brace glob | **P5** |
| F8 | Startup registration is sequential | 98 % of startup git work before listening | `apps/daemon/src/daemon.ts:179` | parallel | **P1** |
| F9 | Repo-info cache TTL 30 s → extra `rev-parse` per refresh / relist | 5.5 → 4.5 spawns per edit | `packages/git-core/src/context.ts:55` | 5 min | **P4** |
| F10 | `/api/projects` is refetched on every edit and grows with worktrees | 261 KB per edit at 100 × 3 (now the largest per-edit cost) | `apps/web/src/api/cache.ts` | R4 | open |
| F11 | `pnpm lint` red on `main`: bench writes Biome-incompatible `results.json` | `biome check` error on `docs/bench/results.json` | `e2e/bench/bench.ts:299` | format output or exclude `docs/bench` | file formatted (commit 598e7a1) |
| F12 | The bench's 60 s idle window misses the 5 min poll herd; no worst-case UI scenarios | see F5, F2 | `e2e/bench/bench.ts` | add a ≥ 330 s idle mode and a large-diff step, assert no console errors | open |

## Prototype commits (on `review/perf`, oldest first)

| Commit | What | Measured effect | Risk |
|---|---|---|---|
| `598e7a1` docs | Biome-format `docs/bench/results.json` | `pnpm lint` green again | none |
| `9f7969c`, `8058526`, `79e1952`, `1f75c95`, `d3ec326` e2e | profiler tooling (`profile.ts`, `spawn-trace.mjs`) | — | none (tooling) |
| `f2bc9c9` **P1** daemon | register startup projects in parallel (8 at a time) | listening 1097 → 680 ms median (5 runs each; 1054–1109 → 672–692); all summaries unchanged (~1150 → ~1170) | low |
| `9b8a8ba` **P2** daemon | ±25 % jitter on relist and fallback-poll timers | worst idle second over 330 s 108.1 % → 6 %; 60 s relist spike gone; average 0.76 → 0.68 % | low |
| `08ae0de` **P3** daemon | leading-edge refresh (quiet worktree refreshes on first event; bursts still debounced) | write → SSE p50 216 → 13 ms, → UI 290 → 90 ms (2 × 10 edits each); 1 summary per single edit | low–medium: transient intermediate states for ~200 ms; deviates from PLAN §5.6 (DECISIONS) |
| `8ae2fe8` **P7** web | flush the SSE batch on the next tick after ≥ 60 ms quiet | write → UI p50 90 → 23 ms on top of P3 (2 × 10) | low |
| `c0f503e` **P6** web | patch ≤ 8 changed worktrees into the cached inbox via `/files` instead of refetching `/api/inbox` | bytes per edit 267 KB → 80 KB (30 × 3), 1.57 MB → 77 KB (6000 files), 4.7 MB → 130 KB (18 000 files); browser task 40 → 13 ms per edit (6000 files); burst: inbox traffic 20.7 MB → 2.5 MB + 0.2 MB of `/files` | medium–low: client mirrors `DaemonCore.inbox()` rules (DECISIONS) |
| `f18b1e0` **P8** daemon | serve JS assets with `UI_CSP` so the highlight workers can import their chunks | 10 000-line diff click → ready 1810 / 1937 → 111 / 109 ms; long task 1.73–1.82 s → none / 62 ms; page heap 114 → ~20 MiB; console worker errors 4 → 0 | low (security review should confirm) |
| `090c396` **P5** daemon | merge the `**/name` ignore globs into one brace glob | 50k-file subscribe 1.8 s → 0.33 s (micro); watchers settled 3192 / 3219 → 1379 / 1381 ms after start with a 50k-file repo | low |
| `402f3e7` **P4** git-core | repo-info cache TTL 30 s → 5 min | spawns per edit 5.5 → 4.5; SSE p50 15 → 12 ms; relist 2 → 1 spawn (4 of 5 min) | low: a moved git dir is picked up after an error or ≤ 5 min |

`pnpm check` (lint, typecheck, build, unit tests) was run on every commit; see Verification.

## Scaling (baseline `f777775` vs `review/perf`, same fixtures, one run each unless noted)

| Scenario | Build | Listening / all summaries | Git spawns | First paint (cold inbox) | Idle avg / worst s | SSE p50 | UI p50 | Bytes / edit | Browser task / edit | RSS | inotify watches |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 30 × 3 (bench) | base | 1097 / 1145 ms (5 runs) | 646 | 881–1029 ms (420–550) | 0.34–0.43 % / 13–16 % | 216 ms | 290 ms | 267 KB | 22–34 ms | 130–146 MiB | 480 |
| 30 × 3 (bench) | branch | 620–626 / 1065–1079 ms (2 runs) | 631 | 981–1009 ms (398–405) | 0.34–0.36 % / 3 % | 12–15 ms | 24 ms | 80 KB | 15 ms | 110–131 MiB | 480 |
| 100 × 3 | base | 3916 / 3977 ms | 2127 | 1916 ms (1766) | 1.32 % / 22 % | 218 ms | 305 ms | 884 KB | 44 ms | 170 → 201 MiB | 1600 |
| 100 × 3 | branch | 3048 / 3606 ms | 2101 | 1909 ms (1523) | 1.27 % / 6 % | 14 ms | 36 ms | 263 KB | 27 ms | 158 → 152 MiB | 1600 |
| 10 × 3 × 200 dirty (6000 files) | base | 612 / 677 ms | 213 | 867 ms (504, 1.54 MB) | — | 232 ms | 306 ms | 1570 KB | 44 ms | 127 → 185 MiB | 160 |
| 10 × 3 × 200 dirty | branch | 296 / 736 ms | 211 | 873 ms (498) | — | 29 ms | 41 ms | 77 KB | 13 ms | 125 → 187 MiB | 160 |
| 30 × 3 × 200 dirty (18 000 files) | base | 1712 / 1788 ms | 642 | 1873 ms (1477, 4.6 MB) | — | 232 ms | 308 ms | 4708 KB | 90 ms | 151 → 278 MiB | 480 |
| 30 × 3 × 200 dirty | branch | 937 / 1825 ms | 631 | 1888 ms (1430) | — | 31 ms | 41 ms | 130 KB | 28 ms | 173 → 227 MiB | 480 |
| 30 × 3 + 50k-file repo + 100k-file `node_modules` | branch w/o P5 (2 runs) | 733–739 / 1228–1260 ms | 640 | — | 0.03 % / 1 % | 56–64 ms in the big repo (1 run, 6 edits; `status` 34 ms, numstat 20 ms) | 62–88 ms | 81 KB | — | 146–148 MiB | 1011, settled 3192–3219 ms |
| same | branch (2 runs) | 677–679 / 1156–1158 ms | 640 | — | — | — | — | — | — | 134–136 MiB | 1011, settled 1379–1381 ms |

Agent burst (30 simulators, one per worktree, actions every 150–1200 ms for 30 s, 1319 identical
seeded actions, UI open):

| | Daemon CPU avg (self) / max | SSE events | Git spawns (git time) | UI requests | UI bytes | RSS |
|---|---|---|---|---|---|---|
| base | 86.9 % (34.9 %) / 133 % | 1045 | 8787 (57.5 s) | 225: 98 inbox (20.7 MB), 98 projects (7.7 MB) | 28.5 MB | 168 MiB |
| branch | 59.5 % (23.4 %) / 137 % | 729 | 6171 (39.1 s) | 225: 134 `/files` (0.2 MB), 13 inbox (2.5 MB), 65 projects (5.1 MB) | 7.9 MB | 194 MiB |

The branch emitted fewer `worktree.changed` events for the same actions (729 vs 1045); I did not
investigate why (likely fewer intermediate states reaching a summary while the event loop is less
busy), so treat the burst comparison as one sample.

Large diff (one modified file rewritten to 10 000 lines, ~800 KB patch, opened in the UI after
another file): base 1810 / 1937 ms click → ready, one long task of 1731 / 1816 ms, page heap
114 MiB; branch (P8) 111 / 109 ms, no long task / one of 62 ms, ~20 MiB. Scrolling the whole
diff (240 steps) is smooth in both: frame p50 16.7 ms, p95 16.8–17.9 ms. A 20 000-line rewrite
(1.6 MB) is above the 1 MiB `maxPatchBytes` and shows the too-large placeholder as designed.

### Where it breaks first

1. **Event-loop time spent forking** (F1). Startup is linear in spawns × spawn cost, and spawn
   cost is linear in RSS: 646 spawns ≈ 1.15 s at 30 × 3, 2100 spawns ≈ 3.6–4.0 s at 100 × 3.
   Every refresh, inbox build and burst pays it on the main thread, so HTTP and SSE latency
   degrade together under load (35 % daemon self CPU in the baseline burst; in the startup CPU
   profile `spawn` is ~65 % of the daemon's main-thread time).
2. **Cold inbox / first paint** (F6): ~5–6 ms per dirty worktree with a few files, ~17 ms per
   worktree with 200 dirty files. Extrapolated (and ignoring the growing spawn cost), the 3 s
   first-paint target fails around 400 dirty worktrees with few files, or ~150 worktrees × 200
   dirty files (~30 000 files).
3. **Per-edit client traffic** (F4, F10): fixed by P6 for the inbox; `/api/projects` (~870 B per
   worktree) remains: 261 KB per edit at 300 worktrees.
4. **inotify**: one watch per watched directory (480 for 30 × 3, 527 for a 50 000-file repo with
   100 files per directory); ignored directories are not crawled or watched, so `node_modules`
   is free. With `max_user_watches` = 524288 here the limit is far away; on systems with 8192
   (older default) it is reached at ~16 repos the size of the 50k-file one. One inotify instance
   in total (parcel shares it), so `max_user_instances` is not a concern. The daemon degrades to
   polling as designed (not exercised here: changing sysctl was out of bounds).
5. **Memory**: RSS grows ~0.3–1 KiB per watched file (parcel's tree: +16–27 MiB end to end and
   +52 MiB in a bare process for 50 000 files) and with cached file lists; it matters mostly
   through F1.

## Recommendations not prototyped (estimated impact)

- **R1 — spawn helper process in git-core** (largest win). Keep the allowlist, argv building and
  env in the daemon's runner; send `{binary, argv, cwd, env}` to one or two small long-lived
  helper processes that spawn git and stream stdout/stderr back (kill, timeout and output caps
  stay in the runner; restart the helper if it dies). Estimate from the micro-benchmark: startup
  git phase 3–4× faster (30 × 3: ~1.15 s → ~0.35 s; 100 × 3: ~3.6 s → ~1 s), event loop no
  longer blocked during bursts, and spawn cost independent of daemon RSS. Effort: medium (runner
  only). Needs the read-only proof and hostile-config tests to keep passing.
- **R2 — fewer spawns per summary** (today 4.5 after P4): (a) cache the filter-driver
  neutralization per repository keyed by the stat signatures of `config`, `config.worktree` and
  the global/system files, falling back to a per-operation read when the config uses
  `include`/`includeIf` (−1 spawn per summary and per file list, ~−22 %); (b) resolve the default
  branch's oid once per project per refresh round, or use `for-each-ref
  --format='%(objectname) %(ahead-behind:HEAD)'` on git ≥ 2.41 to merge `for-each-ref` +
  `rev-list` (−1 spawn on agent branches); (c) skip timer relists when native watching is healthy
  and `<commonDir>/worktrees` is unchanged (−30 spawns/min at 30 projects). Together ~35–45 % fewer
  spawns; security-sensitive for (a), so WS1 should decide.
- **R3 — cold inbox**: after the initial summaries, precompute the working-scope file lists of
  dirty worktrees at low priority while an SSE client is connected (or when the first one
  connects), or let the UI render the sidebar from `/api/projects` and fill the inbox per
  worktree. First paint at 100 × 3: ~1.9 s → ~0.4 s.
- **R4 — summary in `worktree.changed`** (additive optional field `summary`): the client patches
  the projects cache instead of refetching `/api/projects`; with P6 a single edit then costs one
  `/files` request (~1–50 KB) at any fleet size. Contract change for the lead. Alternatively a
  daemon-side `/api/inbox?worktreeIds=` delta would replace P6's client-side reconstruction.
- **R5 — bench coverage**: a ≥ 330 s idle mode (or shorter poll intervals) to catch timer herds,
  a large-diff step that fails on console errors / long tasks, and Biome-compatible output.
- **R6 — browser response validation**: `validate: true` in the browser client costs ~3.4 ms per
  MB of inbox; with P6 the per-edit payloads are small, so this only matters for the initial
  inbox (16.6 ms at 4.7 MB). Low priority.

## Verification

All on this machine, 2026-11-08, Node 26.13.0.

- `pnpm check` (Biome lint, `tsc` typecheck in every package, topological build, vitest) on
  **every commit** of `review/perf`, checked out one by one: 14/14 pass, 13–15 s each. Unit tests:
  437 passed at `598e7a1` → 440 at `402f3e7` (+1 leading-edge watcher test, +1 inbox-patch cache
  test, +1 ignore-compaction test; P8 adds an assertion to the static-assets test). On `f777775`
  itself `pnpm lint` fails (F11), which `598e7a1` fixes.
- `pnpm test:e2e` on the final commit: **36 passed** (1.0 min), including the global read-only
  proof teardown. The log contains `git-core has been disposed` request errors from tests that
  stop their daemon while the UI still has requests in flight; they don't fail any test.
- Watcher unit tests run 3× in a row after P3 and 2× after P5 (no flakes); `cache.test.ts`
  (P6) and the daemon suite (P3, P8) re-run after each change.
- Benchmarks: as listed in each table (run counts next to the numbers). Raw outputs stayed in
  `/tmp/perf-review` (not committed); `docs/bench/results.*` were not regenerated (the committed
  ones are the baseline's first run).

## Notes for the lead

- The prototypes are independent in behavior, but P6's one-line `hooks.ts` change sits on P7's
  restructured `useServerEvents`, so take P7 before P6 (or resolve that one line). P3 and P7
  together give the latency win; P1, P2, P4, P5 and P8 stand alone.
- P8 changes a security header (scripts now carry the page's CSP instead of `default-src
  'none'`); the security reviewer should look at it.
- P6 duplicates `DaemonCore.inbox()`'s entry rules in the client; prefer R4 or a daemon-side
  delta if that duplication is unwelcome.
- `profile.ts` needs a built tree (`pnpm build`) and takes 1–6 min per run; examples:
  `--repos 100 --worktrees 3`, `--repos 10 --worktrees 3 --files 400 --dirty 200`,
  `--big-files 50000 --node-modules-files 100000`, `--burst-seconds 30`,
  `--large-diff-lines 10000`, `--idle-seconds 330 --no-ui`.
