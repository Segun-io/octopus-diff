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

  If a helper dies with requests in flight, the runner kills their process groups: each pid reaches it synchronously
  on the helper's pid channel (fd 3; PR #98 review). It runs a lost request again once, but only when nothing of the
  first try can still run (its group is gone, or it never started), and not when that request already streamed output
  to `onStdout`. Otherwise the request fails with `git_failed`, `details.helper: 'lost'`. A request the helper refuses
  runs directly. A helper whose SIGKILLed git never reports its exit (stopped, wedged) is SIGKILLed itself. Two start failures in a row, or 5 crashes within a minute,
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

DECISIONS #365-#374 (`docs/DECISIONS.md`, "Spawn helper for git"), and #375-#384 for the PR #98 reviews (below):

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
- **Fixed in the PR #98 reviews:** the hung-helper slot leak (watchdog, DECISIONS #380), git outliving a helper
  that died with its SPAWNED still queued (pid channel, #375/#382), whole-input stdin copies (credit, #377). See
  "PR #98 review round" below.
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

## PR #98 review round (Greptile + security review, 2026-11-12)

DECISIONS #375-#384; #368 amended. Every new test was written first and failed on `fdef217` for the reason under test,
except the flood repro of security review 3, which the pid channel (Greptile 1) already fixed when it was written.

| Item | Change | Test (failed first with) |
|---|---|---|
| Greptile 1 (P1) = review 3 | Pid channel on the helper's fd 3: `id\|0` before and `id\|pid` after starting git, written with `writeSync`, so a helper that dies right after has told the parent what to kill. A lost request is retried only once its group is gone, never when it was announced without a pid. `uncaughtException` / `unhandledRejection` handlers kill every group. The helper refuses to start unless fd 3 is a socket. | helper SIGKILLed right after spawn (test hook): the retry ran `alongside` the survivor; helper SIGKILLed after the announce, before spawn: it was retried; the flood repro: the pid is known while SPAWNED is stuck; uncaught exception: the group survived; no fd 3: exits 2 |
| Greptile 2 (P2) | Credit-based stdin: 256 KiB window per request, given back as git reads; 64 KiB frames that are views of the caller's buffer; over-credit is FATAL; dropped on detach and exit | two 64 MiB inputs at once: +134 MB peak before, now < 16 MiB; 64 MiB random `cksum` equal to direct; a git that reads nothing holds < 4 MiB; abort while sending |
| Greptile 3 (P2) | Bench fixture sets `init.defaultBranch` and `commit.gpgsign`; other configs checked | review |
| Review 1 (P2) | Watchdog: no exit `HELPER_EXIT_WAIT_MS` after a SIGKILL means the helper is SIGKILLed (`ProcHandle.abandon`); a timeout while aborting gives up at once | SIGSTOPped helpers + two aborted runs: never settled before (test timed out), now aborted and the third run done in < 5 s; the timeout variant settles before the watchdog would |
| Review 2 (P3) | `HELPER_MAX_ARGV` / `HELPER_MAX_ENV` checked before sending; a refusal runs directly; a clear reason | 70 000 pathspecs: `git_failed` before, now the same argc as direct with no refusal; an env key with `=`: runs directly |
| Review 4 (P3) | Handlers bound to the request's context (`AsyncResource`); helpers created in the module's root context | A then B: `A:own, A:other` before, now `A:own, B:own` |
| Review 5 (P3) | `spawnHygieneProblems`: one exact import per allowed file, pinned calls, no other `spawn` reference, `shell: false` only, no `fork` / `exec*` / bindings / `child_process` elsewhere | negative tests for each bypass (alias, namespace, require, dynamic import, fork, exec, execFile, a second call, `const run = spawn`, `shell: someVar`/`true`/a path, bindings); a test that the client's limits equal the helper's |

Also: the merged #93 test "a `.gitignore` written just before the state was read" failed 6 of 6 times on `fdef217`
with the helper on (a cold core can take longer than the 100 ms margin; DECISIONS #379); it now warms its core
first. The SIGSTOP tests release their helpers through `onTestFinished`: a timed-out test must not leave stopped
processes behind, which the first mutation run did (11 stopped helpers and their zombie children, killed by PID).

**Mutation check** (each mutant alone, `helper.test.ts` or `no-shell.test.ts`): 22 applied (10 in the Greptile round, 12 in the security round), 21 killed.
- Greptile round: no pid announce after spawn; no start announce; pid channel ignored by the parent; an announced
  request without a pid still retried; `retryable` ignored by the runner; credit given on receipt instead of after
  git's write; credit check removed; client copying the whole input up front; fd 3 check accepting anything.
- Security round: no watchdog; timeout-while-aborting not abandoning; `abandon` a no-op; count checks removed; refusal
  retried through the helper; no `uncaughtException` handler; handlers not bound; and five checker rules weakened
  (any `child_process` mention, `spawn` references not counted, the `shell` rule only rejecting `true`, `fork`
  allowed, `child_process` allowed elsewhere).
- **Survived: "retry without waiting for the group to disappear".** The wait only matters for a group that still
  exists after SIGKILL (a process in uninterruptible sleep, or an unreaped zombie). Neither can be produced in a test
  here: init reaps at once. The wait stays (bounded, 1 s).
- Not tested: creating helpers in the root context (review 4, second half). It keeps a later request from holding the
  first request's context alive, which no test can observe without a forced GC.

**Verification** (head after this round; `pgrep -a git` empty of my processes before and after every run):
- `pnpm lint` exit 0 (4 warnings, 1 info, in files this branch does not touch; credits up to date).
  `pnpm typecheck` exit 0. `pnpm build` exit 0.
- `pnpm test` exit 0: contracts 118; forge 101 (5 skipped); fixtures 58; web 482; git-core 477 (1 skipped);
  daemon 420 (4 skipped); e2e unit 8; cli 141; scripts 34.
- Helper on / off:

  | Package | Helper on | Helper off |
  |---|---|---|
  | git-core | 477 passed, 1 skipped | 453 passed, 25 skipped |
  | daemon | 420 passed, 4 skipped | 419 passed, 5 skipped |

- Folding mode: git-core 462 passed, 16 skipped; daemon 418 passed, 6 skipped.
- `pnpm test:e2e --workers=1`: 106 passed (2.9 min). Read-only proof: 12 control repos, 4353 lock polls,
  0 violations.
- `perf:smoke`: exit 0, no failed check.
- Package steps: tarball (9.46 MB, 1070 files); `npm install` exit 0; `--version` printed `0.0.0`; doctor "ok git
  helper … dist/git-helper.js"; the JSON assertion exit 0; `smoke-tarball.mjs` exit 0 with the helper on and off.
- Busy time per spawn (`spawn-helper.bench.ts`, 640 × `status`):

  | Path | Retained 0 MiB | 100 MiB | 1000 MiB |
  |---|---|---|---|
  | Direct | 0.93 ms | 0.97 ms | 0.96 ms |
  | 1 helper | 0.215 ms | 0.217 ms | 0.216 ms |
  | 2 helpers (wall 514-516 ms) | 0.238 ms | 0.248 ms | 0.242 ms |

  At `fdef217`, measured the same way, it was 0.183 ms (1 helper) and 0.203 ms (2 helpers): **+0.02-0.03 ms per spawn
  (about 12 %)**. It is spread over the review fixes, with no single cause: without the per-request context binding
  it is 0.005 ms less, without the pid-channel listener 0.005 ms less, without both and the `AsyncResource` 0.01 ms
  less. It is still about 4 × below direct and flat across heap sizes.
- 30 × 3 bench, helper on / direct:

  | Metric | Helper on | Direct |
  |---|---|---|
  | Startup to all summaries | 666 ms | 1003 ms |
  | Startup git wall time, summed | 1112 ms | 3164 ms |
  | 60-edit burst: spawns / git wall time summed | 292 / 688 ms (725 ms before this round) | 291 / 2382 ms |
  | Diff during the burst, p95 | 18 ms | 30 ms |
  | Edit → SSE, p50 / p95 | 13 / 23 ms | 15 / 26 ms |
  | Idle CPU | 0.23 % | 0.40 % |

  Every budget passes in both runs.

## Stability under load (lead repro, 2026-11-13)

**Repro recipe.**
1. Start busy loops, recording their PIDs to a file: `node -e 'for (;;) {}' & printf '%s\n' "$!" >> pids`, 8 or 14
   of them on this 12-core machine.
2. Run `pnpm test`, every package in parallel as CI does.
3. Stop the loops by PID from the file (never `pkill -f`).

CPU load alone (`helper.test.ts` under 14 loops) passed 5 of 5. `pnpm test` under 8 loops failed 2 of 3 with the
lead's errors.

| Failure | Product or test | Fix |
|---|---|---|
| "a helper killed with SIGKILL mid-request": `git status failed: the git helper process exited` | **Product** (DECISIONS #385). Two parts: (1) after the group wait, a group the reaper had not taken yet made the request non-retryable, contradicting #376; (2) an external SIGKILL that lands between starting git and the pid record (a real window under load) correctly gives no retry, and the test raced into it | Retry after the bounded wait whatever the reaper did (the wait is 10 s); failing-first test with `groupGoneWaitMs: 0`. The test now kills once `helperChildPids()` knows the pid |
| "parent death": helpers and git "not reached" in 5 s | **Test**: `kill(pid, 0)` counts zombies that init had not reaped, a 5 s wait | Zombie-aware, scoped `untilGone` through POSIX `ps -A -o pid=,pgid=,stat=` (macOS too, no /proc), 20 s, only the test's own pids and groups |
| "a stopped helper does not wedge the runner": `group … gone` | **Test**, plus the residual gap of #388: stopped before it wrote the pid, a helper leaves that git unknown and unkillable (the run still settles); 3 s waits counted zombies | The test stops the helpers once both pids are known; zombie-aware 20 s waits |
| (found while analysing) the watchdog SIGKILLed a helper that was only slow to report an exit | **Product** (DECISIONS #386) | PING/PONG probe before the SIGKILL; failing-first test with exits reported 4 s late (it killed the healthy helper and restarted the other request) |

Mutation check of the new code: 4 of 4 killed (retry only when the group is gone; no probe; PONG ignored; the helper
not answering PING). The tests use only POSIX process semantics: `kill(-pgid, 0)`, `ps` with POSIX columns,
`$PPID`, BSD-compatible `head -c`, `wc -c`, `cksum`, `sleep 0.01`; nothing reads /proc.

**Results** (head `33b2f7b`, plus this doc):
- `helper.test.ts` under 14 busy loops: **10 of 10 green with the helper on** (38 passed each) and **10 of 10 with it
  off** (12 passed, 26 skipped each).
- `pnpm test` under 8 busy loops: **10 of 10 green** (git-core 480 passed, 1 skipped; daemon 420 passed, 4 skipped,
  each run). Before the fixes the same recipe failed 4 of 10 on the stopped-helper test and 1 of 3 on the
  mid-request one.
- Folding mode: git-core 465 passed, 16 skipped; daemon 418 passed, 6 skipped. Helper off: git-core 454 passed,
  27 skipped; daemon 419 passed, 5 skipped.
- `pnpm lint` exit 0, `pnpm typecheck` exit 0. No helper process and none of my git processes left after the runs.

## macOS argv limit (CI run 43381831331, 2026-11-13)

**The failure.** On macOS CI, "70,000 pathspecs: the helper path answers as the direct path does" failed with
`spawn E2BIG`. macOS gives argv and env 1 MiB together, counting the 8-byte pointers, so 70 000 arguments cannot be
exec'd there at all, on any path. That is the OS limit, not a helper bug.

**The tests now size themselves from `getconf ARG_MAX`:**
- parity at the largest argv that fits;
- the > 65 536 parity only where it can exist (Linux);
- beyond the OS limit, the same `GitCoreError` (`git_failed`, `failed to start git: Error: spawn E2BIG`) through the
  helper and directly, with no retry, no refusal and the same helper. Mutants killed: a spawn error reported as a
  refusal, an altered spawn-error message, and the helper exiting on a spawn error.

My first sizing (2 × ARG_MAX) let both mutants survive, because a request that large goes direct before reaching the
helper. Found by the mutation check; it is now 1.5 × ARG_MAX, which the client still sends to the helper.

**Production, pre-existing.** The direct path can hit E2BIG on macOS through `PATHSPEC_BUDGET`: 512 000 bytes of short
pathspecs plus their pointers is more than 1 MiB. The fix is the one-line change in `pathspecsExcluding` that counts
`1 + 8` bytes per argument (DECISIONS #389), with a failing-first test. Above the budget, git-core already falls back
to the whole-worktree command.

**Verification** (head `84ad415` plus these docs):
- `pnpm lint`, `pnpm typecheck` and `pnpm build`: exit 0.
- `helper.test.ts` + `pathspec-budget.test.ts` with Linux `ulimit -s 4096` (ARG_MAX 1 MiB, as on macOS): 40 passed,
  1 skipped (the > 65 536 test). With `ulimit -s 2048` (512 KiB): the same. With the default limits: 41 passed.
- `helper.test.ts` under 14 busy loops: 5 of 5 green with the helper on (40 passed each) and 5 of 5 with it off
  (12 passed, 28 skipped each).
- `pnpm test` under 8 busy loops: 3 of 3 green (git-core 483 passed, 1 skipped; daemon 420 passed, 4 skipped).
- Folding mode: git-core 468 passed, 16 skipped; daemon 418 passed, 6 skipped.
- No helper process and none of my git processes left.

## macOS CI: concurrency and lingering-group tests (run 43384632348, 2026-11-13)

**"keeps the concurrency limit" (6 of 9 starts).** All nine runs had resolved, so the starts happened; the *log* was
broken.
- Cause: the fake logged with a `printf` whose format repeats per argument. A shell can flush that in several writes,
  and concurrent fakes interleaved their fields. The parser stops at the first broken record.
- Shown on Linux: bash with 4.6 KB records, 300 concurrent writers, 11 of 300 parsed (dash: 300). With the new
  format, 300 of 300 for both.
- macOS's `/bin/sh` is bash 3.2. With the runner's ~2.5 KB records it fits the macOS failure: the best hypothesis.
- Fix: one line per event, one `printf '%s\n'` of a prebuilt string; start and end events. The limit is now proven
  from the event order: never more than 3 running, every job started once and ended.
- Mutant "the scheduler allows limit + 1": killed ("expected length 3, got 4").

**"retried even when its killed group lingers" (the first git not reached).** The retry happened (the request
returned "second run"); the first git still looked alive to `ps` 20 s after the parent's group SIGKILL.
- Best hypothesis, no evidence yet: BSD `ps` shows a process on its way out with an `E` flag, which the check read as
  alive. It now counts as dead, as `Z`/`X` do.
- The other candidate is a failing `killpg` on macOS. It used to be swallowed silently; it is now logged as a warning.
- Both, and anything else, will show in the new failure diagnostics: every wait prints the fake's events, `ps` lines
  for the test's pids and groups, the helpers' state and the warnings.

**Other waits reviewed** (DECISIONS #392): default waits are now 20 s. Three tests whose short timeout could fire
before a slow helper started (one would then have passed vacuously) warm the helper first and assert that git ran.
`helperTest.startDelayMs` rehearses a slow runner: the file passes with 1.5 s and 3 s start delays. Nothing in the
tests relies on `setsid(1)`, `/proc` or path strings from scripts (`fx.root` is a realpath; scripts report pids, not
paths).

**Verification** (head `d531ba4` plus these docs):
- `pnpm lint`, `pnpm typecheck`: exit 0.
- Under 14 busy loops:
  - `helper.test.ts`, helper on: 10 of 10 green, 40 passed each;
  - helper off: 10 of 10 green, 12 passed and 28 skipped each;
  - with a 1.5 s helper start delay: 3 of 3 green.
- `pnpm test` under 8 busy loops: 3 of 3 green (git-core 483 passed, 1 skipped; daemon 420-421 passed).
- Folding mode: git-core 468 passed, 16 skipped; daemon 418 passed, 6 skipped.
- No helper and none of my git processes left.
