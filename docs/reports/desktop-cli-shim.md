# desktop-cli-shim report

Roadmap #21 (desktop phase C, the `octopus-diff` command from the app; part of #15), stream WS6. Branch `t3/6a038409`,
2026-11-13. Not pushed, no PR. DECISIONS #560-#572 (this session's range was #560-#589).

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
  at startup the app refreshes its own stale launcher (never creates one).
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
  at the target are refused and untouched; a stale launcher is refreshed and then works; with
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
