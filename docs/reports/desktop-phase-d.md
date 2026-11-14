# desktop phase D report (the Windows app with its backend inside WSL, roadmap #22)

## Shipped

The Windows app can run its backend **inside a chosen WSL distro** instead of on Windows. It is opt-in: with no
distro chosen (the default, and the CI Windows runner) the app runs exactly the phase C code path (#610).
docs/DESKTOP.md §11 describes the design.

- **CLI** (`apps/cli`, a separate `cli:` commit; owned by WS5, requested here, #612): `serve --ready-stdout <nonce>`
  writes the `ServeReady` line to **stdout** as a frame (`\n` + RS `octopus-diff-ready <nonce> <json>\n`), because
  `wsl.exe` passes only fds 0-2. It is mutually exclusive with `--ready-fd`. The banner has no token. EPIPE on stdout
  is ignored once the channel is open, so a vanished reader cannot crash the shutdown that stdin's EOF starts.
  Help text and README updated.
- **Contracts** (a separate `contracts:` commit, additive, #611): `SERVE_READY_FRAME_PREFIX`,
  `ServeReadyNonceSchema` and `formatServeReadyFrame` in `daemon.ts`, shared by the writer and the reader;
  `desktop-wsl.ts` with `DESKTOP_WSL_CHANNELS`, the status and set-result schemas and `DesktopWslBridge`.
  `DesktopBridge` gains those two methods as **optional** ones.
- **Desktop** (`apps/desktop/src`):
  - `ready-frame.ts`: `ReadyFrameReader` splits stdout into log text and the one frame with this run's nonce. Frame-like
    lines never reach the log. `newReadyNonce()`.
  - `backend.ts`: the supervisor gets `ready: { kind: 'stdout', nonce }` (stdio `['pipe','pipe',<log fd>]`),
    `runAsNode: false`, `wrapper: true` (killing `wsl.exe` is assumed not to stop the daemon: stdin is closed first
    everywhere, and a failed start gives the EOF `stopGraceMs` before signalling) and `loopbackOnly`
    (`isLoopbackReady`) (#613).
  - `wsl.ts` (pure): `decodeWslText` / `parseWslList` for `wsl.exe -l -v` (UTF-16LE without BOM, UTF-8, localized
    headers by column, the `*` default, Running/Stopped/other, `system` for docker-desktop & co.), `isSafeDistroName`,
    the read-only `WSL_PROBE_SCRIPT` with `parseWslProbe` / `wslProblems`, and the argv builders `wslProbeArgs` /
    `wslServeArgs` (`--exec`, no shell, `--host 127.0.0.1`) (#614-#617).
  - `wsl-backend.ts`: the preflight over an injected `run`: list, then probe, then the `serve` argv or a typed failure.
  - `desktop-settings.ts`: `desktop-settings.json` in userData (`{ version: 1, wslDistro }`), used on Windows only
    (#618).
  - `wsl-ipc.ts` + `bridge.ts` + `bridge-main.ts`: `wslStatus()` / `setWslDistro()` on the bridge's shared guard
    (sender, zod), Windows only, listed and safe non-system names or null. The preload needs a user gesture to switch.
  - `daemon-api.ts`: `verifyDaemon` (the health challenge's HMAC proof, the token never sent) before the window loads
    a WSL daemon. It tells "Windows reaches *this* daemon" apart from forwarding being off and from another Windows
    program on the port (#615).
  - `screens.ts`: `wslStartingScreen`, `wslFailedScreen` (what is missing plus commands to copy, never installed),
    `wslUnreachableScreen` (mirrored vs NAT `.wslconfig`), and a new screen action **Use the Windows backend**
    (`use-windows`), also added to the failure screen of a WSL backend.
  - `main.ts`: reads the settings, runs the preflight, starts the supervisor in WSL mode, switches backends on a
    Settings change (stop, then start; a quit during a switch waits), retries a failed preflight.
- **Web** (`apps/web`, Settings only, #619): a **Desktop app** section, listed only with the bridge
  (`visibleSections`; `SETTINGS_SECTIONS`, the command palette and the browser's section order are unchanged). It has
  the **Install `octopus-diff` command** row over `cliStatus()` / `installCli()` (#21's follow-up: status, conflict
  and refusal messages). On Windows with the WSL methods it also has the **Where the backend runs** picker (This PC,
  or a user distro).
- **Credits**: the `wsl -l -v` parsing adapted from T3 Code (`parseWslDistroList`, MIT) is attributed in `wsl.ts` and
  added to `adapted` in `scripts/credits/acknowledgements.json`; `pnpm credits` regenerated `CREDITS.md` and the
  web's credits JSON.

## PR #114 review fixes (2026-11-14)

Each fix began with a test that failed on the code before it: the CLI tests against the pre-review build, the desktop
tests against the pre-review `src`. The exceptions are the two 500k-character parse tests, which hang there on the
quadratic regex, the bug itself. DECISIONS #620-#630.

- **MEDIUM 1, a WSL start that failed about 1 time in 64** (#624). The nonce is now hex (it never starts with `-`).
  The argv carries `--ready-stdout=<nonce>`, and the nonce is **fresh for every spawn attempt**: the supervisor takes
  `nonce: () => string` and `args: ({ nonce }) => argv`, and the preflight returns `argsFor(nonce)`. A desktop test
  runs the CLI's real parser on the produced argv with a nonce starting with `-` (exit 0), and on the old form (exit
  2, "ambiguous"). The backend smoke runs the real CLI with such a nonce.
- **MEDIUM 2, the daemon crashing mid-shutdown when `wsl.exe` is killed** (#621). A supervised `serve` remembers EPIPE
  on stdout *and* stderr (`CliDeps.watchBrokenPipes`) and drops later writes, the logger's included. Built-CLI test:
  close both readers, then stdin → exit 0 and `daemon.json` removed. It failed with exit 1 on the old build. The
  real-`wsl.exe` smoke now also checks that `daemon.json` is gone after `wsl.exe` is SIGKILLed.
- **LOW 1, quadratic parse** (#625): 256 lines at most, `trimEnd()`, lines over 512 characters skipped. Each
  500k-character test case runs under 250 ms.
- **LOW 2, attach to a LAN-bound daemon** (#620, #622, #626). The ready line carries the bind `host` (a `contracts:`
  commit). The CLI refuses to attach when an explicit `--host` differs from the running daemon's. The WSL backend
  accepts only `host` and `url` on the literal `127.0.0.1`.
- **LOW 3, the token after the one-time check** (#627). `UiRequestGate` holds every http(s) request of the window,
  in WSL mode only, from leaving `ready` until `verifyDaemon` passes again. The remaining windows and the listener-
  owner follow-up are in Known gaps and DESKTOP §11.
- **LOW 4, concurrent settings saves** (#628): `SettingsStore` chains the saves, uses a unique temp file per save, and
  updates memory after the rename.
- **Nits** (#629, #623): double spaces in distro names are refused; a WSL-specific hint on EADDRINUSE.
- **Mutation check** (#630): it can mutate `apps/cli/src` too; 22 new mutants (6 of them in the CLI).

## Verification

First round (before the review):


All run on 2026-11-14 in this worktree (WSL2 Ubuntu on Windows, mirrored networking, Node 26.13, Electron 45.3.2).

- **Tests first**: each new test file failed before its module existed (the CLI's 10 new tests failed against
  the old CLI). The three survivors of the first mutation run each got a test that kills them.
- `pnpm check` (lint + credits check, typecheck, build, every package's tests): **exit 0**, 1 min 59 s.
  - contracts: 150 passed
  - forge: 101 passed (5 skipped)
  - fixtures: 59 passed
  - web: 551 passed
  - git-core: 556 passed (1 skipped)
  - daemon: 610 passed (4 skipped)
  - e2e support: 27 passed
  - cli: 188 passed, including the built-CLI `--ready-stdout` tests
  - desktop: 461 passed (1 skipped)
  - scripts: 34 passed
- `node apps/desktop/scripts/mutation-check.mjs`: **239 killed, 0 survived (of 239)**; 37 of them are new for #22.
  - The first run had 235 killed and 4 survivors:
    - one existing mutant's pattern became ambiguous because `attemptFailed` now also closes stdin; the pattern was
      made unique;
    - three were real test gaps: a terminated over-long frame line, a prerequisite problem with the CLI present, and
      a hostile name inside the listing itself.
  - All four were fixed before the second run.
- `OCTOPUS_SMOKE_WSL_DISTRO=Ubuntu node apps/desktop/scripts/smoke-backend.mjs` (Electron as Node): **all scenarios
  passed**, 5 s. The old scenarios still pass:
  - started
  - attached
  - the attached daemon going away
  - restart after SIGKILL
  - no orphan after the parent is SIGKILLed
  - git missing

  The new scenarios also pass:
  - **stdout ready channel**: the frame was read, the token appears in no log line, the banner went to the log, the
    daemon proved it holds the token, and stdin EOF stopped it.
  - **Real `wsl.exe`**: the ready frame came through `wsl.exe`'s stdout relay. **From Windows (PowerShell
    `Invoke-WebRequest`), `http://127.0.0.1:<port>/api/health` answered 200** in mirrored mode. Stdin EOF crossed
    `wsl.exe` and stopped the daemon in 21 ms.
  - **SIGKILL of `wsl.exe` itself**: the daemon still exited, 50 ms later.
- `DISPLAY=:0 node apps/desktop/scripts/smoke-app.mjs` (WSLg, real window): **all scenarios passed**.
  - The bridge's member list now includes `setWslDistro` and `wslStatus`.
  - New check: `wslStatus()` goes through the guard and answers "Only the Windows app can run its backend in WSL."
    on Linux.
  - The first run failed exactly on the old member list, which is how the packaged-app spec's list was found too.
- `pnpm --filter @octopus-diff/desktop run package -- --dir`, then `DISPLAY=:0 pnpm --filter @octopus-diff/e2e run
  test:e2e:desktop`: **8 passed, 2 skipped** (the AppImage-only and the macOS window-repeat specs). This is the
  packaged-app spec CI runs on Windows, with the updated member list.
- `pnpm test:e2e` (the browser suite; the web changed): three full runs.
  - Two failed one test and passed 109; the third run passed all **110**.
  - The failing test both times was `07-readonly` ("driving every read path…"), at
    `AppPage.openFile → scrollIntoViewIfNeeded: Element is not attached to the DOM`. The file row is re-rendered
    while the agent simulator edits `live-agent` (the race class of ci-flakes #134).
  - Run alone: 14 of 15 passed on this branch.
  - For comparison, `main` built in a temporary worktree passed 3 of 3 full runs (110) and 15 of 15 isolated runs.
  - The spec never opens Settings, and the web diff only touches the Settings dialog and the section registry, so no
    causal link was found. A timing effect cannot be ruled out from these small samples, so this is **flagged, not
    dismissed**: see Known gaps.
- Read-only probes on this machine:
  - `wsl.exe -l -v`: the raw bytes are UTF-16LE with no BOM and CRLF. They are the `REAL` test fixture.
  - `winps` read `.wslconfig`: `networkingMode=mirrored`, en-US culture.
  - `wslinfo --networking-mode`: `mirrored`.
  - `wsl.exe --exec` argv round-trip: spaces, quotes, unicode, `--x` and `$HOME` arrive intact.
  - The real probe script in Ubuntu through `wsl.exe`: login PATH from zsh/mise, Node v26.13.0, git 2.53.0,
    `cli-missing`. Correct, since no `octopus-diff` is on that PATH.

  Nothing was installed and nothing on the host was changed.

Review round (2026-11-14, same machine):

- `pnpm check`: **exit 0**.
  - contracts: 151 passed
  - forge: 101 passed (5 skipped)
  - fixtures: 59 passed
  - web: 551 passed
  - git-core: 556 passed (1 skipped)
  - daemon: 610 passed (4 skipped)
  - e2e support: 27 passed
  - cli: **197 passed**, including the built-CLI `serve-ready` suite (16; its new broken-pipe test failed with exit 1
    on the pre-review build first)
  - desktop: **475 passed** (1 skipped)
  - scripts: 34 passed
- `node apps/desktop/scripts/mutation-check.mjs`: **261 killed, 0 survived (of 261)**.
  - The previous run had 260 killed and 1 survivor: "settings: memory not updated after a save". The test's second
    choice equalled the default; it now uses distinct values, and the mutant was checked by hand to fail 2 tests.
- `OCTOPUS_SMOKE_WSL_DISTRO=Ubuntu node apps/desktop/scripts/smoke-backend.mjs`: **all scenarios passed**.
  - The stdout scenario now uses a nonce that starts with `-` in the `=` form.
  - Real `wsl.exe`: from Windows, the health URL answered 200, and stdin EOF stopped the daemon in 22 ms.
  - SIGKILL of `wsl.exe`: the daemon exited 50 ms later **and shut down gracefully** (`daemon.json` removed: the
    review's crash is gone).
- `DISPLAY=:0 node apps/desktop/scripts/smoke-app.mjs`: **all scenarios passed**.
- Not re-run in this round: `pnpm test:e2e` (the browser suite) and the packaged-app e2e. This round changed no
  `apps/web` code and none of the bridge's members.

## Decisions

DECISIONS #610-#619 (docs/DECISIONS.md, "Desktop phase D"). In short:

- Opt-in, inert without a distro (#610).
- Contracts additive (#611).
- `--ready-stdout <nonce>` with an RS-prefixed frame and a per-run nonce (#612).
- The supervisor's stdout channel, wrapper and loopback options (#613).
- `--exec` argv and the probe on stdin (#614).
- Loopback bind plus a token proof from Windows, and why not the distro IP (#615).
- Probe, explain, never install (#616).
- `wsl -l -v` parsing (#617).
- Settings in the app's userData, switching by restart (#618).
- The web's Desktop app section (#619).
- The review: the bind host in the ready line (#620), the broken-pipe guard (#621), attach honouring `--host` (#622),
  the WSL port hint (#623), the per-attempt hex nonce (#624), bounded parsing (#625), the literal 127.0.0.1 (#626),
  the request gate (#627), serialized saves (#628), the nits (#629) and CLI mutants (#630).

## Contract changes

Additive only, in `209a5bd contracts: …`:

- `daemon.ts`: `SERVE_READY_FRAME_PREFIX`, `ServeReadyNonceSchema`, `formatServeReadyFrame`.
- New `desktop-wsl.ts`: `DESKTOP_WSL_CHANNELS`, `DesktopWslDistroSchema`, `DesktopWslStatusSchema`,
  `DesktopWslSetResultSchema`, `DesktopWslBridge`.
- `desktop.ts`: `DesktopBridge extends … Partial<DesktopWslBridge>` (two optional methods).
- `index.ts` exports the new file.

Review round: `3fe99bc contracts: ServeReady.host` (optional, the daemon's bind address).

## Dependencies

None added or removed. `pnpm credits` was run for the new `adapted` entry (T3 Code, `apps/desktop/src/wsl.ts`).

## Known gaps

- **Token exposure that remains** (#627). The request gate closes the restart window. Two short windows remain:
  between `verifyDaemon` and the load of `authUrl`, and while an attached daemon has died but the poll (about 10 s)
  has not noticed yet. In both, a program that took Windows' port (mainly NAT mode, behind WSL's relay) could see a
  request. The app does not check who owns the Windows listener. Follow-up: `GetExtendedTcpTable` →
  `wslrelay.exe`/the WSL service, or a custom scheme.
- The request gate is unit-tested; its `session.webRequest` wiring only runs with a distro chosen, so it has not run
  in a real window (smoke-app runs this machine's backend, where the gate stays uninstalled).

- **The Windows app itself with a distro chosen has not been run.** This session must not launch the Windows app, and
  CI's Windows runner has no WSL distro. The `main.ts` wiring has no unit tests (by design, like phases A-C):
  - the preflight before the supervisor;
  - the switch on a Settings change;
  - the "use the Windows backend" action;
  - the reachability check before the load.

  So "From Windows, the app shows repos inside WSL with live updates" (the issue's *done when*) is **not verified end
  to end**. What is verified:
  - the pieces, by unit tests and mutants;
  - the CLI and supervisor through a real `wsl.exe`;
  - Windows reaching the daemon on loopback.
- **The real-`wsl.exe` smoke ran from inside WSL** (Linux → interop → `wsl.exe`), not from a Windows process. The
  stdout relay, the stdin EOF and Windows' loopback access are the same; killing `wsl.exe` there means killing the
  interop process. A Windows `TerminateProcess` of `wsl.exe` is covered only by the unit tests' worst-case fake
  (the daemon survives the kill and stops on EOF) and the stdin-first rule.
- **NAT networking mode** (`localhostForwarding`) was not tried: this machine runs mirrored mode. The reasoning is in
  DECISIONS #615, and the unreachable screen covers forwarding being off.
- **Localized `wsl.exe` output** (German, Spanish) uses constructed fixtures; only en-US was captured.
- **The app crashing on Windows** (pipes closed by the OS) is inferred from the lifeline tests and the Linux smoke's
  "SIGKILL of the parent", not observed with `wsl.exe` in between.
- **CLI install instructions** point at a checkout plus `pnpm link --global`, or a tarball: the CLI is not on npm yet.
- **`e2e/tests/07-readonly.spec.ts` was flaky on this branch**: 3 failures in 18 runs, always the same detached-row
  race in `openFile`. `main` passed 18 of 18 here. No causal link to this change was found, but it is not proven
  unrelated. If CI shows it, `openFile` should re-query the row after the list settles: that is WS4's helper, so it
  is not changed here.
- The picker is a native `<select>`, like the other Settings choices. It does not show a distro's running/stopped
  state.

## Notes for integration

- The `cli:` commit (`serve --ready-stdout`) is WS5's area; it is small and self-contained (args, deps, serve, help,
  README, tests).
- The WSL methods are optional on `DesktopBridge`; an app older than this phase serves no Desktop picker, and the web
  feature-detects them.
- The Windows `desktop` CI job does not exercise WSL (no distro). Nothing in the packaged-app spec changes. A
  `desktop-settings.json` only exists once a user picks a distro.
- One existing mutant pattern ("quit does not close stdin") was made unique, because `attemptFailed` now closes stdin
  too.
