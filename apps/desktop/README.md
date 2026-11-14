# @octopus-diff/desktop

The Electron desktop shell (stream WS6; plan: [`docs/DESKTOP.md`](../../docs/DESKTOP.md), phase A: roadmap #18).
A thin shell: the main process runs the CLI's `serve --ready-fd 3 --exit-with-stdin` under Electron's Node
(`ELECTRON_RUN_AS_NODE=1`) and shows the daemon's web UI in a window. It never runs git and never touches a
repository; the daemon does all of that.

## Commands

| Command (from the repo root) | What it does |
|---|---|
| `pnpm build` | Also builds `apps/desktop/dist`: `main.js` (esbuild) and `cli/` (the CLI bundle from `apps/cli/scripts/bundle.mjs`) |
| `pnpm --filter @octopus-diff/desktop start [-- <options>]` | Runs the built app (`electron .`) |
| `pnpm --filter @octopus-diff/desktop dev [-- <options>]` | Dev loop: the CLI from sources (tsx hook, Electron's Node), DevTools, restart on `src/` changes |
| `pnpm --filter @octopus-diff/desktop test` | Unit tests (no Electron binary, no display) |
| `pnpm --filter @octopus-diff/desktop smoke:backend` | The real supervisor against the built CLI under Electron's Node (no display) |
| `pnpm --filter @octopus-diff/desktop smoke:app` | The real app window, inspected over CDP (needs a display; WSL: `DISPLAY=:0`) |
| `pnpm --filter @octopus-diff/desktop mutation-check` | Mutates the security policy, the packaged-build argument rules, the supervisor rules and the `octopus-diff` command's marker/never-overwrite rules; the unit tests must catch each mutation |
| `pnpm --filter @octopus-diff/desktop run package [-- --arch x64,arm64] [--dir]` | UNSIGNED installers in `release/` (after `pnpm build`): AppImage + deb, dmg + zip, or NSIS for this OS (`--platform` to pick another; `--dir` = only the unpacked app) |
| `pnpm --filter @octopus-diff/desktop run check-fuses <app>` | Asserts the fuses (and the embedded asar integrity data on macOS/Windows) of a packaged app |
| `pnpm --filter @octopus-diff/e2e test:e2e:desktop` | The packaged-app smoke (`e2e/desktop`): the app in `release/<platform>-unpacked`, or `OCTOPUS_DESKTOP_APP=<app>` |

The smoke scripts skip (exit 0) without the Electron binary or a build.

**The Electron binary.** Electron 45 has no install script: `pnpm install` does not download it. The first `start`
or `dev` downloads it (about 100 MB, cached in `~/.cache/electron`), or run
`pnpm --filter @octopus-diff/desktop exec install-electron`. Nothing in `pnpm check` needs it.

**This WSL machine** also needs the extracted Chromium libraries next to the binary (`docs/DESKTOP.md` §2):
`d=$(readlink -f apps/desktop/node_modules/electron)/dist; for f in ~/.cache/octopus-diff-dev/chromium-libs/usr/lib/x86_64-linux-gnu/*; do [ -e "$d/$(basename "$f")" ] || ln -s "$f" "$d/"; done`.
A window opens under WSLg with `DISPLAY=:0`.

## Packaging (phase B, roadmap #19)

`scripts/package.mjs` stages the app per platform and arch in `.stage/<platform>-<arch>/` (a generated
`package.json` whose only dependency is `@parcel/watcher`, installed with `npm --os --cpu` so each build has only its
target's prebuilt; `dist/` without source maps; `resources/` as the icons) and runs electron-builder there with
`electron-builder.yml`. Layout inside the app: `resources/app.asar` holds `package.json`, `dist/main.js`,
`dist/cli/` (the CLI bundle with `web/`) and `node_modules/` (`@parcel/watcher` and its platform package);
`app.asar.unpacked` has the watcher packages and `dist/cli/git-helper.js`. Fuses: `RunAsNode` on, everything else
hardened (DESKTOP §5); `check-fuses` reads them back. Builds are **unsigned** (macOS: ad-hoc signature from the fuse
step; open with right-click → Open). The Linux executable is `octopus-diff-desktop` (`octopus-diff` stays the CLI's
command). Nothing is signed, notarized or published (phase E).

An installed app (`app.isPackaged`) refuses `--dev`, `--backend source`, `--renderer-url`, `--remote-debugging-port`
and `--inspect*` (exit 2). The packaged smoke inspects the window over `--remote-debugging-pipe` instead (DECISIONS
#509, #510).

## Options

After `--` (see `src/args.ts`): `--state-dir <dir>`, `--config-dir <dir>`, `--port <n>` (passed to `serve`),
`--app-data-dir <dir>` (Electron's userData: window state, logs, Chromium profile, single-instance lock; default
`<appData>/octopus-diff-desktop`), and, unpackaged only, `--dev`, `--backend bundle|source`, `--renderer-url <url>`
(loopback hosts only).

UI work with hot reload: run the app with a known daemon port and point the window at Vite:

```sh
pnpm --filter @octopus-diff/desktop dev -- --port 7431 --renderer-url http://localhost:5173
OCTOPUS_DIFF_API=http://127.0.0.1:7431 pnpm --filter @octopus-diff/web dev     # in another terminal
```

## Layout

| File | Role |
|---|---|
| `src/main.ts` | Electron wiring: lifecycle, single-instance lock, window, security handlers, menus, screens, quit |
| `src/backend.ts` | The supervisor: spawn, ready line, attach/start, restart with backoff, attached health polling, shutdown |
| `src/backend-command.ts` | Bundle vs source command line |
| `src/policy.ts` | Navigation, window-open and permission policy; window options (DESKTOP §5) |
| `src/menu.ts` | Menu template and the accelerator rule (never a bare key) |
| `src/page-actions.ts` | Phase A's menu scripts (Settings, Refresh, Undo), the fallback for a web build without the bridge |
| `src/screens.ts` | Starting / error / git-missing screens (static `data:` pages) |
| `src/shell-env.ts` | Login-shell PATH (macOS/Linux) |
| `src/window-state.ts` | Saved window bounds, validated and clamped to the displays |
| `src/daemon-api.ts` | Health (liveness, git check) and Add Folder through the daemon API |
| `src/log-file.ts` | `daemon.log` (the daemon writes to it directly) |

The `window.octopusDesktop` bridge (phase C, #20; DESKTOP §3.4, DECISIONS #530-#545):

| File | What |
|---|---|
| `src/preload.ts` | The sandboxed preload (bundled to `dist/preload.cjs`): `contextBridge` only |
| `src/bridge.ts` | The object it exposes; actions that act on the OS need a user gesture |
| `src/ipc-channels.ts`, `src/ipc.ts` | Channel names; the main-process handlers (sender check, zod, refusals as values) |
| `src/path-guard.ts` | The path check: worktree from the daemon, plain segments, realpath inside the worktree |
| `src/open-safety.ts` | `openPath` never runs a program (executables, scripts, launchers, app bundles) |
| `src/editor-url.ts` | `vscode://` / `cursor://` / `zed://` file URLs and their allowlist |
| `src/badge.ts`, `src/page-commands.ts`, `src/worktrees-api.ts` | Badge plan, menu-command routing, `GET /api/projects` |
| `src/bridge-main.ts` | Wires all of it to Electron (`ipcMain`, shell, dialog, clipboard, badge) |
No preload and no IPC yet: the `window.octopusDesktop` bridge is phase C (#20).

## The `octopus-diff` command (phase C, roadmap #21)

File → Install 'octopus-diff' Command… writes a small launcher that runs this app's bundled CLI with
`ELECTRON_RUN_AS_NODE=1`, so `octopus-diff add .` in a terminal talks to the app's daemon: `~/.local/bin/octopus-diff`
(macOS, Linux; the dialog says if that directory is not on PATH) or `%LOCALAPPDATA%\octopus-diff\bin\octopus-diff.cmd`
plus a user-PATH entry (Windows, no admin). The launcher's second line is a marker: only files with it are ever rewritten
(the app does that itself at startup if it moved), and nothing is installed when another `octopus-diff` (an npm install)
is on PATH or in the way. Code: `src/cli-shim.ts` (pure), `cli-shim-service.ts`, `cli-shim-fs.ts`, `cli-shim-ipc.ts`
(the bridge's `installCli` / `cliStatus` handlers, on the bridge's guard from `ipc.ts`, DECISIONS #547). Tests: `test/cli-shim*.test.ts` (the sh
launchers are run for real, against hostile paths and a fake AppImage runtime) and, against the packaged app,
`pnpm --filter @octopus-diff/e2e test:e2e:desktop` (`desktop/cli-shim.spec.ts`; `OCTOPUS_DESKTOP_APPIMAGE=<file>` adds the
AppImage check).
