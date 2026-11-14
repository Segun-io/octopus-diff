# desktop-cli-shim report

Roadmap #21 (desktop phase C, the `octopus-diff` command from the app; part of #15), stream WS6. Branch `t3/6a038409`,
2026-11-13. Not pushed, no PR. DECISIONS #560-#572 and, for the PR #110 review, #574-#581.

## Shipped

- **The command installer** (`apps/desktop/src/`):
  - `cli-shim.ts`, pure: `shellWord` / `cmdWord` quoting, `renderLauncher` (sh for an installed app, sh that mounts an
    AppImage, `.cmd` for Windows), the marker (`MARKER`, `isOwnLauncher`), `launcherLocation`, `resolveTarget`
    (AppImage via `$APPIMAGE`+`$APPDIR`, mounted dmg / translocated app / unknown `.mount_*` / dev run refused), PATH helpers
    (`pathContainsDir`, `pathCandidates`, `addToUserPathValue`) and `decide` (install / update / current / refuse).
    Adapted in part from T3 Code's `DesktopCliShim.ts` (MIT; credits entry, attribution in the header).
  - `cli-shim-service.ts`: `createCliShim(deps)` with `status()`, `install()`, `refresh()` over injected effects
    (filesystem, login-shell PATH, Windows user-PATH editor); installs and refreshes run one at a time.
  - `cli-shim-fs.ts`: the real effects. Never follows a symlink, reads only the top of a file, creates a launcher
    exclusively (staged file hard-linked into place), replaces only a file that still carries the marker (staged +
    `rename`), and the Windows user-PATH editor (system PowerShell by absolute path, `-EncodedCommand`, the new value in
    the environment, raw `REG_EXPAND_SZ` kept, `WM_SETTINGCHANGE` broadcast).
  - `cli-shim-ipc.ts`: `registerCliShimIpc` (sender must be on the daemon's origin, no arguments, result parsed with the
    contract's schema) and `outcomeTitle`.
  - `menu.ts`: File → Install 'octopus-diff' Command… (`MenuActions.installCommand`); `main.ts` (about 60 lines: the
    shim, the terminal PATH, the dialog, the IPC registration, the startup refresh).
- **Contracts** (separate `contracts:` commit `6acc4b8`, DECISIONS #560): `packages/contracts/src/desktop-cli.ts`
  (`DESKTOP_CLI_CHANNELS`, `DesktopCliStatusSchema`, `DesktopCliInstallResultSchema`, `DesktopCliBridge`) plus one
  `export *` line in `index.ts`. `desktop.ts` untouched.
- **Behaviour**: a launcher with a frozen marker on line 2; rewritten only when it has the marker (and the app moved); a
  non-marker file at `~/.local/bin/octopus-diff` or *any* other `octopus-diff` on the terminal's PATH means nothing is
  written and the dialog says where it is; the dialog says when the directory is not on PATH and gives the line to add;
  at startup the app refreshes its own launcher only when the app it names is gone (never creates one, never retargets to another live copy; #574).
- **Tests**: `test/cli-shim.test.ts` (54), `cli-shim-service.test.ts` (34), `cli-shim-fs.test.ts` (18),
  `cli-shim-ipc.test.ts` (8), additions to `menu.test.ts`, `packages/contracts/test/desktop-cli.test.ts` (4). The sh
  launchers are RUN against fake executables in hostile directory names (spaces, quotes, `$`, backticks, newline, tab,
  non-ASCII, emoji, leading dash) with hostile arguments, and a fake AppImage runtime (mount, stays up, unmounted on exit;
  no FUSE → extract). Tests were written before the code (red first) for the pure module, the service, the effects, the
  IPC and the menu item; the contract schemas and their test were written together.
- **Mutation check**: 32 new mutants for the marker, never-overwrite, quoting, AppImage, unstable-location, race,
  effects and bridge-guard rules in `apps/desktop/scripts/mutation-check.mjs`.
- **Packaged-app e2e** (`e2e/desktop/cli-shim.spec.ts`, 5 tests): the installer is pointed at the packaged binary and its
  asar's CLI with a temp home; the launcher is run like a terminal and `--version` equals the bundled CLI's; with the app
  running, `octopus-diff status --json` through the launcher reports the app daemon's URL (D6); an npm shim on PATH and one
  at the target are refused and untouched; a launcher whose app is gone is refreshed and then works; with
  `OCTOPUS_DESKTOP_APPIMAGE=<file>` the AppImage launcher runs a real AppImage.
- **Docs**: DECISIONS #560-#572, `docs/DESKTOP.md` §3.2 "As built", §4, §8, `apps/desktop/README.md`.

## Verification

This WSL2 machine (Linux x64, Node 26.13.0, pnpm 12.16.1, Electron 45.3.2). A fresh worktree: `pnpm install
--frozen-lockfile` first.

| Command | Result |
|---|---|
| `pnpm check` (lint incl. `credits:check`, typecheck, build, test) | **pass**, exit 0. Desktop: 11 files, 224 passed, 1 skipped (pre-existing); contracts 142; cli 174; daemon 610 (+4 skipped); git-core 556 (+1); forge 101 (+5); web 512; fixtures 59; e2e (vitest) 8 |
| `pnpm --filter @octopus-diff/desktop mutation-check` | baseline of every test file passes; **90 killed, 0 survived (of 90)**, no BROKEN (58 existing + 32 new; one new mutant survived first, `bridge: result not validated`: the install-result test was missing, added, then killed) |
| `pnpm --filter @octopus-diff/desktop run package -- --dir` then `DISPLAY=:0 pnpm --filter @octopus-diff/e2e test:e2e:desktop` (with `OCTOPUS_DESKTOP_APPIMAGE` set to the AppImage built by `package -- --platform linux --arch x64`) | **9 passed**, 11.6 s: the 4 phase B tests (refusals, main flow with the read-only proof, kill leaves no daemon, tamper test skipped on Linux) and the 5 new ones, the AppImage one included (through the extract fallback, see below) |
| `DISPLAY=:0 pnpm --filter @octopus-diff/desktop smoke:app` and `smoke:backend` (Electron from `~/.cache/octopus-diff-dev/electron` via `ELECTRON_OVERRIDE_DIST_PATH`) | all scenarios passed, with the new `main.ts` wiring (a real window and backend) |

## Decisions

All in `docs/DECISIONS.md` #560-#572. The ones worth a second look: **#562** never-overwrite in four layers (including
refusing when another install is on PATH even though our launcher already exists); **#564** the AppImage launcher mounts
the file (`--appimage-mount`) instead of passing the entry to `$APPIMAGE` (the issue's wording; the entry lives in a mount
whose name changes); **#565** refusing a dmg / translocated / unidentified-AppImage location; **#566** the Windows user
PATH edit and `.cmd` encoding; **#568** the bridge is contracts + IPC handlers now, the preload is #20's.

## PR #110 security review: findings fixed (round 1, 2026-11-13)

Each finding was fixed test first (the tests below were run red before the code changed; some failed only because the
function did not exist yet, the signal and behaviour ones failed on the old behaviour). Committed locally in
`desktop: PR #110 review round 1 …` and a follow-up; not pushed. DECISIONS #574-#580 (the HOME redirection of #580 was replaced by #581, below).

| # | Finding | Fix | Test that went red first |
|---|---|---|---|
| 1 | MEDIUM: startup refresh retargets to the last copy started; the packaged e2e used the real HOME | `launcherApp()` reads the app out of our launcher; `refresh()` writes only when that file is missing (#574). a packaged-e2e launch must never touch the real launcher: first done by redirecting HOME for the app (#580), **replaced by the `OCTOPUS_DESKTOP_NO_CLI_REFRESH=1` hook (#581, see the macOS CI round below)** | `cli-shim-service.test.ts` "only when the app the launcher names is gone" (7 tests: app still exists, two copies, deleted AppImage, existing AppImage, older body, unreadable app, Windows `.cmd`; Install may still retarget), `cli-shim.test.ts` "launcherApp" (round trip incl. hostile and `%`/non-ASCII paths), `e2e/support/desktop-app-env.test.ts` (now: the launch env carries the hook) |
| 2 | AppImage launcher: no signal forwarding, SIGHUP skipped the EXIT trap | CLI in the background + `wait`; `trap` HUP/INT/TERM → 129/130/143; one `cleanup` (CLI stopped, TERM then KILL; mounter stopped; work dir removed); stdin passed on fd 3 (#575) | `cli-shim.test.ts` AppImage: SIGTERM, SIGHUP, SIGINT × mount and extract fallback (real `/bin/sh` = dash with a fake runtime: exit code, CLI gone, mounter gone, `$TMPDIR` empty), a TERM-ignoring CLI is killed, stdin reaches the CLI |
| 3 | An unreadable `octopus-diff` on PATH was ignored | `FileFacts` `unreadable` (lstat failure other than ENOENT/ENOTDIR, a file that cannot be opened); a conflict on PATH (#576) | `decide` on PATH / at target; `cli-shim-fs.test.ts` execute-only 0711 file and a path under an unsearchable directory; service status/install refuse |
| 4 | Windows relative PATH entries searched | only drive-letter and UNC entries (#577) | `pathCandidates` with `.;bin;C:foo;\foo;..\x` and the `/`/UNC spellings that stay |
| 5 | `readTop` race (symlink / FIFO swapped in) | `O_NOFOLLOW \| O_NONBLOCK` + `fstat().isFile()` on the fd (#578) | readTop on a FIFO, a symlink to a file, a symlink to a FIFO; `inspect` with a lstat that saw a regular file while the path is a symlink to a FIFO; `/dev/zero` for the fstat check (a first version of that test survived its mutant: `readSync` at offset 0 fails on a pipe anyway) |
| 6 | The read-only-directory test was vacuous | removed; `createNodeShimFs({ ops })` injects a failing rename / EEXIST link (#579) | rename fails after staging → no staging file, old launcher kept; link EEXIST → no staging file, existing file kept |
| 7 | The no-hard-links fallback was untested | same seam: link fails with EPERM (#579) | fallback writes the file (mode 0755, no leftovers), never replaces a file / symlink / dangling symlink / directory, passes other errors on |

Mutation check after the round: `node apps/desktop/scripts/mutation-check.mjs` → baseline of every test file passes
(`desktop` and, new, `e2e/support/desktop-app-env`), **116 killed, 0 survived (of 116)**; 26 mutants added for the rules above
(refresh condition ×2, `launcherApp` ownership, HUP/TERM/INT traps, CLI/mount/work-dir cleanup, foreground child, stdin,
KILL escalation, unreadable on PATH, Windows relative entries, readTop fstat and NOFOLLOW, both unreadable returns, both
staging cleanups, fallback `wx`, fallback EEXIST, e2e HOME / LOCALAPPDATA / USERPROFILE / RUN_AS_NODE). Not mutated, on
purpose: removing `O_NONBLOCK` makes the FIFO test hang in a synchronous `open`, which no test timeout can interrupt.

Real command results of this round (same WSL machine):

| Command | Result |
|---|---|
| `pnpm check` | **exit 0**: lint (+`credits:check` up to date), typecheck, build, tests. Desktop 11 files, **263 passed**, 1 skipped (pre-existing); e2e vitest 11 (3 new); contracts 142; cli 174; daemon 610; git-core 556; forge 101; web 512; fixtures 59 |
| `node apps/desktop/scripts/mutation-check.mjs` | 116 killed, 0 survived, no BROKEN |
| rebuilt `release/` (`pnpm build` + `run package -- --platform linux --arch x64`), `OCTOPUS_DESKTOP_APPIMAGE=<that AppImage> DISPLAY=:0 pnpm exec playwright test -c playwright.desktop.config.ts` | **9 passed**, 11.9 s (every launch now in a temp HOME; `~/.local/bin/octopus-diff` does not exist on this machine afterwards) |

Honest limits of this round: the signal behaviour was tested under dash with a fake runtime, not against a real FUSE mount
(no libfuse2 here); bash/zsh-as-`sh` (macOS's `/bin/sh` is bash in POSIX mode) was not run; the Windows `.cmd` and registry
changes are still unrun on Windows. A user who runs the AppImage launcher in a terminal and presses Ctrl-C now gets the CLI
stopped with SIGTERM (the background child ignores SIGINT in a non-interactive sh), not SIGINT.

## PR #110 CI: the macOS `desktop` job (round 2, 2026-11-13)

At head 57411ac Linux and Windows passed and macOS failed twice at `packaged-app.spec.ts:141` ("timed out after 60000 ms
waiting for the web UI to be ready"): the daemon, `status` and `add` worked, only the window's UI never became ready. The one
change in that path was round 1's redirection of HOME (and USERPROFILE, LOCALAPPDATA, APPDATA, XDG_*) for the launched app
(#580), the likely cause being Chromium's Keychain / `~/Library` use on macOS. **I could not run macOS here: that cause is
the best reading of the evidence, not something I reproduced; CI will say.** Fix (DECISIONS #581, which supersedes #580):

- **App**: `OCTOPUS_DESKTOP_NO_CLI_REFRESH=1` turns the startup refresh off. `startupRefresh(shim, env, log)`
  (`cli-shim-service.ts`; `main.ts` calls it and never `refresh()` directly) does nothing and logs one line when the variable is
  exactly `1`; any other value is the normal refresh. Safe direction only: no value of any variable makes anything get written
  that the refresh would not write anyway, and the menu's Install and the bridge ignore it. Documented as a test hook in
  `docs/DESKTOP.md` §3.2.
- **e2e**: `isolatedAppEnv` / `ensureHome` and their test are gone; `appLaunchEnv(env)` adds the switch and still drops
  `ELECTRON_RUN_AS_NODE`; HOME is left alone on every OS. `launchApp` and `runApp` pass it. `e2e/support/desktop-app-env.test.ts`
  asserts the env carries the switch (and that a caller cannot turn it off), that `launchApp`/`runApp` use `appLaunchEnv`, that no
  spec or helper starts an `.executable` with a direct `spawn`, and that every other use of the binary is the Node-mode CLI
  (`ELECTRON_RUN_AS_NODE`). Checked by reading the code: every GUI launch in `e2e/desktop` (main flow, refusals, kill test, the
  tamper test and its control copy, the cli-shim spec's app) goes through those two functions. The cli-shim spec keeps its own temp
  homes for the launcher it installs (no GUI app is started with a fake HOME there).
- **Tests first** (red before the code): `cli-shim-service.test.ts` "the startup refresh and its test switch" (the constant; refresh
  as before; with the switch `refresh()` is not called, nothing written, exactly one log line naming the variable; only `1`
  counts; nothing in the environment makes a launcher get created or retargeted; `main.ts` goes through `startupRefresh`),
  `desktop-app-env.test.ts` (`appLaunchEnv is not a function`).
- **Mutants** (9 new, 4 old e2e ones replaced; `mutation-check.mjs` now 121): switch ignored, any value accepted, no log line, `main.ts`
  calling `refresh()` directly, app launched without the switch, HOME redirected again, RUN_AS_NODE inherited, `launchApp` / `runApp`
  passing the plain env.

| Command | Result |
|---|---|
| `pnpm check` | **exit 0**: lint (4 warnings, all pre-existing; one I introduced, a comma operator in a test spy, was fixed), `credits:check`, typecheck, build, tests. Desktop 11 files, **269 passed**, 1 skipped (pre-existing); e2e vitest 14 |
| `node apps/desktop/scripts/mutation-check.mjs` | **121 killed, 0 survived**, no BROKEN (re-run after the lint fix) |
| rebuilt `release/` + `OCTOPUS_DESKTOP_APPIMAGE=<AppImage> DISPLAY=:0 pnpm exec playwright test -c playwright.desktop.config.ts` (real HOME) | **9 passed**, 13.2 s; `~/.local/bin/octopus-diff` does not exist afterwards |
| the packaged Linux app by hand in a scratch HOME with a stale launcher (marker, app `/gone/app`) | with `OCTOPUS_DESKTOP_NO_CLI_REFRESH=1`: launcher byte-for-byte unchanged, `daemon.log` has "startup refresh of the octopus-diff command skipped (OCTOPUS_DESKTOP_NO_CLI_REFRESH=1)"; without it: "updated the octopus-diff command at …" and the launcher is retargeted. So the switch is what prevents the rewrite |

Not verified: the macOS job (it is the only place the cause can be confirmed); the Windows job with this change.

## Contract changes

Additive, own commit: `packages/contracts/src/desktop-cli.ts` (new) and `export * from './desktop-cli.js'` in
`packages/contracts/src/index.ts`. Expect a trivial conflict in `index.ts` with #20's `desktop.js` export line (both go
after `daemon.js`); `DesktopBridge` in `desktop.ts` should `extends DesktopCliBridge`.

## Dependencies

None added or removed. `pnpm credits` was run after adding the T3 Code `adapted` file entry
(`scripts/credits/acknowledgements.json`; `CREDITS.md` and `apps/web/src/generated/credits.json` regenerated in the same
commit); `credits:check` passes.

## Known gaps

What was **not verified**, honestly:

- **macOS, the dmg, Windows, the NSIS installer were not run at all.** The darwin and win32 branches (location, the
  `/Volumes` and translocation refusals, the `.cmd` text, the UTF-8 code-page dance, the PowerShell scripts that read and
  write `HKCU\Environment\Path` and broadcast `WM_SETTINGCHANGE`, cmd's real handling of `%`, `!`, `^`, `&` and non-ASCII
  paths) are covered only by string-level unit tests and, on a CI runner, by the e2e (whose Windows variant fakes the
  registry and runs the `.cmd` through `cmd /d /c`). I wrote the `.cmd` from T3's tested layout and the PowerShell from
  documentation; treat both as unproven until CI's `desktop` job has run them. In particular: whether `ELECTRON_RUN_AS_NODE`
  gives a console-attached `electron.exe` working stdin/stdout from a `.cmd` (T3's launcher sets a `T3CODE_DESKTOP_CLI_LAUNCHER` flag,
  which I took to be for its CLI to reopen the console; ours has no such flag, so interactive stdin on Windows is
  unverified; the commands that matter, `add`, `status`, `serve`, take none).
- **The AppImage mount path against a real FUSE runtime.** This machine has no `libfuse2`, so the real AppImage ran through
  the *extract* fallback (a 130 MB extraction per invocation, about 1 s here). `--appimage-mount` is confirmed to exist in
  this runtime (`--appimage-help`), and the mounting branch is exercised with a fake runtime that mounts, stays up and
  must be killed, but not with a real mount.
- **The deb install itself** (apt, `/opt/octopus-diff`, `chrome-sandbox`): the e2e uses `release/linux-unpacked`, the same
  layout, run directly.
- **The menu item and the IPC handlers in the packaged app.** The menu item's click is unit-tested (and `main.ts` runs in
  the unpackaged smoke), the handlers are unit-tested; neither is driven in the packaged app (a native menu cannot be
  clicked over the DevTools pipe, and there is no preload until #20). The packaged e2e runs the installer's source against
  the packaged binary.
- **Not done**: the Settings button (web, WS3/#20); NSIS uninstall cleanup of the launcher and the PATH entry (#571);
  `ELECTRON_RUN_AS_NODE=1` stays in the environment of what the CLI spawns, a browser from `octopus-diff open` included
  (#571); CI does not set `OCTOPUS_DESKTOP_APPIMAGE` yet (the workflow is WS5's, unchanged).
- The decision's tiny residual race: between `replaceOwn`'s marker re-read and its `rename`, a file that was ours a moment
  ago could be swapped for a foreign one. Creating a new launcher has no such window.

## Notes for integration

- Merge with #20: `menu.ts` (`MenuActions` gains `installCommand`; #20 may add actions: keep both), `main.ts` (my edits
  are small blocks: imports, a `cliShim` constant after the log opens, `installCommand()` next to `addFolder()`, one menu
  action, `registerCliShimIpc` + `terminalPath` + `refresh()` in `main()`), `packages/contracts/src/index.ts`,
  `docs/DECISIONS.md` (my entries are at the end under their own heading, #560-#572) and `docs/DESKTOP.md`.
- The preload (#20) needs only: `installCli: () => ipcRenderer.invoke(DESKTOP_CLI_CHANNELS.install)`,
  `cliStatus: () => ipcRenderer.invoke(DESKTOP_CLI_CHANNELS.status)`, typed by `DesktopCliBridge`. The main-process side is
  already registered and refuses anything not from the daemon's origin. If #20 builds its own `ipc.ts` with a shared
  sender check, `registerCliShimIpc`'s `isTrustedSender` can be swapped for it; its tests state the rules.
- The Settings button should call `cliStatus()` on open (it returns `state`, `path`, `onPath`, and `conflict` / `reason`)
  and `installCli()` on click, showing `result.message` as is.
- A development machine with an npm-linked `octopus-diff` on PATH (as this one may have) gets `refused` from the menu item
  by design; that is the feature.
- CI: to cover the AppImage launcher, set `OCTOPUS_DESKTOP_APPIMAGE` to the built `.AppImage` in the Linux `desktop` job
  (it needs FUSE or falls back to extracting) before the extracted-AppImage run; the spec skips without it.
