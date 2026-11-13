# spawn-helper report (roadmap #45, step 28)

## Shipped

- **A git spawn helper** (`packages/git-core/src/runner/git-helper.ts`). It is a small, long-lived Node process that
  starts git for the runner, so the daemon's event loop no longer pays for `spawn()`. It is a dumb executor. It gets
  the finished `{binary, argv, cwd, env, stdin, maxOutputBytes}` and refuses anything that is not exactly that shape:
  - `binary` must equal the one absolute git binary the helper was started with;
  - `argv` must be an array of NUL-free strings, `cwd` an absolute path, `env` a map of strings;
  - extra or missing keys, or wrong types, mean REJECTED, and nothing runs;
  - a framing error (a frame over 8 MiB, an unknown type, a bad KILL) is FATAL: the helper kills everything it started
    and exits with code 2.

  It never uses a shell and never runs another file. It enforces `maxOutputBytes` itself (it kills the process group
  and reports TOO_LARGE) and caps stderr at 64 KiB. Output passes as raw bytes in length-prefixed frames, with no
  decoding. When its pipe to the daemon is full, it pauses git's pipes (back-pressure). When its stdin closes (the
  parent exited, was SIGKILLed, or disposed git-core), on SIGTERM, and on a write error, it SIGKILLs every process group
  it started and exits. It runs in its own session, in `/`, with an empty environment.
- **The runner side** (`runner/helper-client.ts`, `runner/runner.ts`). `execute` now drives a `ProcHandle`, which is
  either a direct child (`spawnDirect`, the code from before) or a helper request; both report the same callbacks. Every
  check and policy stays in the runner and behaves the same as before:
  - the allowlist, stdin allowlist, pins, safety env and location checks;
  - the lanes and the fair scheduler, `queueKey` and `onSpawn`;
  - timeouts, `maxOutputBytes` (also checked in the runner);
  - abort: SIGTERM to the group, SIGKILL after `ABORT_GRACE_MS`, and the slot is freed only once the process has
    exited;
  - dispose and the `GitCoreError` mapping.

  Helpers start lazily: up to 2, the second only while the first is busy, 1 with `concurrency: 1`. Idle helpers are
  unref'd. `dispose()` closes them and waits for them to exit.

  If a helper dies with requests in flight, the runner kills their process groups (it learned each pid from the
  helper). It runs a lost request again once, unless that request already streamed output to `onStdout`; then the
  request fails with `git_failed`, `details.helper: 'lost'`. Two start failures in a row, or 5 crashes within a minute,
  turn the pool off for that runner: git is then spawned directly, with one warning.
- **Kill switches.** `OCTOPUS_DIFF_GIT_HELPER=0` always wins. The others are `GitCoreOptions.helper: false` (contracts),
  the daemon's `internal.gitHelper: false` and the CLI config file's `git.helper: false`. Windows always uses the
  direct path.
- **CLI packaging.** `pack.mjs` builds `dist/git-helper.js` next to the bundle; `pnpm build` emits
  `dist/runner/git-helper.js` next to the runner. The runner finds the file with
  `new URL('./git-helper.js', import.meta.url)`; in sources that is `git-helper.ts`, which plain Node runs with type
  stripping. `doctor` has a new `git-helper` check: it runs `git --version` through a real helper (ok / info when off /
  warn when broken). The CI `package` job now checks that this doctor check is ok and runs
  `apps/cli/scripts/smoke-tarball.mjs`, which:
  1. serves a scratch repository from the installed tarball;
  2. reads a diff through the API;
  3. checks that a helper process runs under the daemon;
  4. SIGKILLs the daemon and checks that no helper or git process is left.
- **Electron (#16/#19).** The helper is started as `spawn(process.execPath, [entry, …])` with stdio frames, not `fork`
  IPC or `utilityProcess`. Plain pipes work the same under Node and under `ELECTRON_RUN_AS_NODE=1`, which the client
  sets when `process.versions.electron` is present. For #19: unpack `git-helper.js` from the asar, or pass
  `helper.entry`. `helper.execPath` is there if the packaged Node is not `process.execPath`.
- **Bench.** `packages/git-core/test/bench/spawn-helper.bench.ts` is the event-loop micro-benchmark. The e2e bench's
  spawn trace (`e2e/bench/spawn-trace.mjs`) now preloads itself into the helpers, so git processes started there are
  still traced.

## Verification

All runs are on this machine (12-core WSL2, Ryzen 7 7800X3D, Node 26.13.0, libuv 1.52.1, git 2.53.0), from the repo
root.

- `pnpm lint`: exit 0. Biome reports 4 warnings and 1 info, all in files this branch does not touch
  (`apps/web/test/cache.test.ts`, `apps/daemon/test/file-origins.real-git.test.ts`). `credits:check` is up to date
  (no dependency changes).
- `pnpm typecheck`: exit 0. `pnpm build`: exit 0.
- `pnpm test`: exit 0. Results: contracts 107; forge 101 (5 skipped); fixtures 58; web 461; git-core 460
  (1 skipped); daemon 412 (4 skipped); e2e unit 8; cli 141; scripts 34. An earlier full run failed once in
  `helper.test.ts` (crash recovery: the orphaned group was not killed). That was a real race: the client handled the
  helper's `exit` before reading its last frames, so a pid sent just before the crash was unknown. It is fixed by
  handling the death on `close` (commit `bab4d11`). Since then: 5 isolated runs of `helper.test.ts` green and a full
  `pnpm test` green.
- git-core and daemon, helper on and off:

  | Package | Helper on | Helper off (`OCTOPUS_DIFF_GIT_HELPER=0`) |
  |---|---|---|
  | git-core | 460 passed, 1 skipped (46.7 s) | 446 passed, 15 skipped (49.8 s) |
  | daemon | 412 passed, 4 skipped (25.9 s) | 411 passed, 5 skipped (25.5 s) |

  With the helper off, the 14 git-core tests and the 1 daemon test that need the helper are skipped. `lanes.test.ts`,
  `runner.test.ts`, `hostile-config.test.ts`, `readonly.test.ts` and the daemon's `cancel.real-git.test.ts` pass
  unchanged on both paths.
- Folding mode (`OCTOPUS_DIFF_TEST_FOLDS_CASE=1`): git-core 445 passed, 16 skipped; daemon 410 passed, 6 skipped.
- `pnpm test:e2e --workers=1`: **102 passed (3.0 min)**. The read-only proof: 12 control repos, 4364 lock polls,
  **0 violations**.
- `pnpm --filter @octopus-diff/web perf:smoke`: exit 0, every check ok.
- The package job steps, run locally:
  - `pnpm build`, then `pack:tarball` (9.4 MB, 1066 files, with `dist/git-helper.js`);
  - `npm install` of the tarball into an empty directory; `--version` printed `0.0.0`;
  - `doctor`: "ok git helper: git version 2.53.0 through …/node_modules/octopus-diff/dist/git-helper.js";
  - `smoke-tarball.mjs`: exit 0 with the helper on (diff ok, 1 helper under the daemon, nothing left after SIGKILL)
    and exit 0 with it off;
  - the CI doctor assertion fails when the helper is off (checked).
- New tests:
  - `packages/git-core/test/helper.test.ts` (20 tests):
    - *Protocol*, against the raw helper process:
      - a well-formed request reaches a fake binary that logs its argv; shell metacharacters arrive verbatim and
        nothing runs them;
      - 21 malformed SPAWNs are REJECTED and run nothing: another binary, `/bin/sh -c`, argv as a string, number,
        object, null or NUL elements, env as an array, numbers or objects, a key with `=`, null env, a relative cwd,
        an extra `shell` key, a missing key, bad `stdin`, bad caps, non-objects, invalid JSON;
      - an oversize frame, an unknown frame type, a bad KILL and a too-short frame each end the helper with code 2;
      - bad startup arguments (wrong flag, wrong protocol, relative binary, an extra argument) end it with code 2;
      - the helper's own output cap holds;
      - its process groups are killed when its stdin ends.
    - *Runner through the helper*:
      - it is the default: git's parent is a helper pid, constructed exactly as `lanes.test.ts` constructs its runner;
        the helper is gone after dispose;
      - output is byte-exact for every byte value, NUL, invalid UTF-8 and 3 MiB, buffered and streamed, and equal to
        the direct path's;
      - cap, timeout and stdin give the same errors and messages as the direct path; stdin is sent in several
        frames;
      - the concurrency limit holds across 2 helpers;
      - cancellation: a queued run never spawns; SIGTERM, then SIGKILL after the grace period, including a group
        member that ignores SIGTERM; the slot is held until exit;
      - a missing binary gives `git_not_found` and a missing cwd `not_found`.
    - *Crashes*:
      - SIGKILL of the helper mid-request: the request runs again and succeeds, the orphaned group dies, a new helper
        serves the next request;
      - a streamed request that already delivered output fails with `helper: 'lost'`;
      - a broken entry falls back to the direct path, logged.
    - *Parent death*: a parent process (tsx) runs a real `GitRunner` with two helpers; after SIGKILL of the parent,
      the helpers, both git processes and a TERM-ignoring group member are all gone (checked through PID files).
  - `apps/daemon/test/git-helper.real-git.test.ts` (2 tests): the daemon's git runs under helpers that exit with the
    daemon; with `internal.gitHelper: false`, git's parent is the daemon process.
  - `apps/cli/test/doctor.test.ts` (+2 tests): the check's states and config passthrough, and a real probe.
- **Mutation check.** I applied each mutation alone and ran `helper.test.ts`. All 16 were caught:
  - binary check removed; argv element check removed; env value check removed; extra keys allowed;
  - no group kill on stdin end; helper ignores KILL; no cap in the helper;
  - stdout decoded as UTF-8 in transit; frame cap removed;
  - parent does not kill orphans; no retry; retry even after streamed output; no fallback when the pool gives up;
  - helper not used by default; abort settles before exit; no SIGKILL after the grace period.

  Daemon: removing the `internal.gitHelper` wiring fails its test.
- `pgrep -a git` before and after the runs: only another session's `bench-paged` processes, none of mine. No
  `--octopus-diff-git-helper` process was left after any run.

### Event-loop cost per spawn (acceptance: independent of RSS)

`spawn-helper.bench.ts`: 640 × `git status --porcelain=v2 -z` at concurrency 4, while the main process retains a V8
heap (arrays of doubles). Each configuration runs in a fresh process. "Busy" is `eventLoopUtilization().active` during
the runs; the delay columns come from `monitorEventLoopDelay`.

| Retained heap | RSS | Path | Wall | Main-thread busy | Busy per spawn | Loop delay p50 / p99 / max |
|---|---|---|---|---|---|---|
| 0 MiB | 107 MiB | direct | 604 ms | 602 ms | 0.94 ms | 0.99 / 2.21 / 3.84 ms |
| 0 MiB | 110 MiB | 1 helper | 737 ms | 117 ms | 0.18 ms | 1.00 / 1.89 / 2.01 ms |
| 0 MiB | 110 MiB | 2 helpers | 511 ms | 132 ms | 0.21 ms | 0.98 / 1.58 / 1.72 ms |
| 100 MiB | 260 MiB | direct | 621 ms | 619 ms | 0.97 ms | 1.03 / 2.19 / 4.46 ms |
| 100 MiB | 259 MiB | 1 helper | 725 ms | 121 ms | 0.19 ms | 1.00 / 1.86 / 2.02 ms |
| 100 MiB | 259 MiB | 2 helpers | 511 ms | 133 ms | 0.21 ms | 0.99 / 1.60 / 1.75 ms |
| 1000 MiB | 1418 MiB | direct | 617 ms | 616 ms | 0.96 ms | 1.06 / 2.27 / 4.20 ms |
| 1000 MiB | 1418 MiB | 1 helper | 733 ms | 119 ms | 0.19 ms | 0.99 / 1.86 / 2.01 ms |
| 1000 MiB | 1419 MiB | 2 helpers | 516 ms | 134 ms | 0.21 ms | 1.00 / 1.63 / 1.76 ms |

Through the helper, the main thread does 0.18-0.21 ms of work per git process at every heap size; the direct path does
0.94-0.97 ms, and the main thread is busy 100 % of the burst. Two helpers are faster than direct (511 vs 604 ms); one
is slower (its own loop is the bottleneck), hence the default of 2.

The old premise did not reproduce. Measuring a bare `spawn('/usr/bin/git', ['--version'])` synchronously (p50 of 200)
gives 0.67 ms at 56 MiB RSS, 0.78 ms at 307 MiB and 1.21 ms at 1381 MiB. Review-perf F1 measured 0.63 → 16 ms. So with
Node 26.13 / libuv 1.52 the spawn cost here grows only mildly with RSS, and the per-spawn main-thread cost is mostly
`spawn()` plus the stdio setup and teardown around it. The helper still removes most of that, and makes it flat.

### Daemon bench, 30 × 3 (default `bench`, with the UI)

| Metric | Helper on | Direct (`OCTOPUS_DIFF_GIT_HELPER=0`) |
|---|---|---|
| Daemon startup: listening / all summaries | 548 / 645 ms | 796 / 1004 ms |
| Startup git spawns (per worktree) | 421 (4.7) | 407 (4.5) |
| Startup git wall time, summed | 970 ms | 3157 ms |
| Cold paint / warm reload median | 146 / 71 ms | 143 / 66 ms |
| Edit → SSE p50 / p95 | 13 / 21 ms | 15 / 25 ms |
| 60-edit burst: git spawns / git wall time summed | 292 / 725 ms | 291 / 2377 ms |
| 60-edit burst: phase until quiet (includes the 2 s probe tail) | 3166 ms | 3103 ms |
| Diff during the burst p50 / p95 | 5 / 22 ms | 6 / 30 ms |
| Idle CPU avg / worst 1 s | 0.17 % / 2 % | 0.33 % / 2 % |
| Daemon RSS end / peak (the daemon only) | 166.7 / 166.7 MiB | 162.6 / 165.5 MiB |

Every budget passes in both runs. The burst's git wall time is **0.7 s with the helper** (2.4 s direct; the acceptance
asks for < 5 s; the old figure was 15.6 s). The phase itself lasts about 3.1 s in both runs because the bench keeps
probing for 2 s after the last edit. *Git wall time* is measured from `spawn()` to `close` by the trace preload: in the
daemon on the direct path, in the helper otherwise. Part of the drop is therefore that a direct spawn's time includes
the daemon's blocked event loop before the process's output is read. Startup spawns are 14 more with the helper
(421 vs 407): a different interleaving of the same work (startup is faster), not new calls; the budget of ≤ 8 per
worktree passes.

### Daemon bench, 100k layout (`--layout large --no-ui --idle-seconds 1 --iterations 5`)

| Metric | Helper on | Direct |
|---|---|---|
| Daemon startup: listening / all summaries | 212 / 3255 ms | 188 / 3243 ms |
| Startup git spawns (per worktree) / git wall time summed | 17 (5.7) / 5381 ms | 17 (5.7) / 6013 ms |
| Edit → SSE p50 / p95 (all edits) | 243 / 543 ms | 239 / 553 ms |
| Edit → SSE p95, later edits of a worktree (#40 target < 120 ms) | 65 ms | 68 ms |
| Git spawns to SSE, worst later edit (budget ≤ 3) | 3 | 3 |
| Daemon RSS end (the daemon only) | 210.7 MiB | 202.2 MiB |

The two runs are the same within noise: startup here is git-bound (100k-file `status` and lists of up to 9.5 MB), not
spawn-bound. The large outputs pass through the helper without slowing it down (startup is 12 ms apart, out of 3.2 s).

### Helper memory

The built helper (`dist/runner/git-helper.js`), measured after a 5.3 MB `git log -p` and 200 `status` calls through two
helpers: VmRSS 64 MB and 61 MB, of which **RssAnon 20 MB and 17 MB** (the rest are pages of the Node binary, shared
with the daemon's). The peak RSS (VmHWM) equals the final RSS, so moving the 5.3 MB output did not grow the helper
beyond its baseline. Dev runs that start `git-helper.ts` through type stripping use about 30 MB anonymous each. Two
helpers therefore add about 40 MB of private memory to a daemon that uses 140-210 MB.

## Decisions

DECISIONS #365-#374 (`docs/DECISIONS.md`, "Spawn helper for git"):

- #365: the contracts field;
- #366: stdio frames from `spawn(process.execPath)` rather than fork IPC or `utilityProcess`, for Node and Electron;
- #367: what stays in the runner, the helper's strictness rules and caps;
- #368: the failure model (retry, orphan kill, fallback);
- #369: two lazy helpers by default;
- #370: Windows keeps the direct path;
- #371: the kill switches;
- #372: `no-shell.test.ts` lists the three spawning modules;
- #373: CLI packaging, doctor and the CI smoke;
- #374: the RSS premise no longer reproduces.

## Contract changes

Two `contracts:` commits, both additive: `GitCoreOptions.helper?: boolean | GitHelperOptions`, the new
`GitHelperOptions { entry?, processes?, execPath? }`, and a doc-comment fix of the `processes` default.

## Dependencies

None added or removed. The tarball's second esbuild entry uses the existing esbuild. `credits:check` is up to date.

## Known gaps

- **Windows uses the direct path** (no process groups to kill, untested here). The helper code is POSIX-first.
- **No watchdog for a hung helper.** A helper that stops answering without exiting would hold an aborted run's slot
  (the run waits for EXIT); timeouts and dispose still settle at once. Never seen; a wedged helper is a bug, not a
  git-behaviour case.
- **A retried request restarts its timeout**, and `onSpawn` is called again for the second process.
- **`no-shell.test.ts` changed** (the only existing test that did): it had asserted that only `runner.ts` imports
  `node:child_process`, which is false by design now. It pins what each of the three modules may spawn.
- **Helper stderr** (a crash message) is logged as a warning, capped at 2 KiB; nothing else of the helper is logged.
- **The micro-benchmark's heap is a few large arrays.** Page-table size, which is what the old fork cost depended on,
  scales with RSS either way; a heap of many small objects was not measured separately.

## Notes for integration

- Commit order: `contracts:` (f1c64c8) → git-core → daemon → cli → `contracts:` doc fix → tests → orphan race fix →
  e2e trace. The DECISIONS numbers #365-#374 may collide with the #42 session's entries; renumber freely (the report
  and the code comments cite the numbers only in this file and `DECISIONS.md`).
- #19 (Electron packaging) must ship `dist/git-helper.js` outside the asar (or pass `helper.entry`). With
  `ELECTRON_RUN_AS_NODE`, nothing else is needed.
- `docs/bench/results*.{json,md}` were not regenerated (the results above come from `/tmp`); regenerate them when
  merging if the committed bench numbers should reflect the helper.
