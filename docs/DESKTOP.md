# octopus-diff desktop app (Electron): plan

> Status: accepted 2026-11-13 (phase 0 done, roadmap #16; `docs/reports/desktop-phase0.md`). Aligned with T3 Code's
> model (user-confirmed 2026-11-08). PLAN §2 lists the Electron desktop app as in scope (DECISIONS #466-#475).
> Verified on **Electron 45.3.2, which bundles Node 24.22.2** (the spike of 2026-11-08 used 45.2.3). Roadmap decisions
> (2026-11-11, #24) are at the end of this file (§10).

## 1. Goal and model

Ship octopus-diff as an installable app (macOS, Windows, Linux) that opens straight to the main view, without giving up
the CLI or the browser. This is **the same model as T3 Code** ([pingdotgg/t3code](https://github.com/pingdotgg/t3code), MIT):

| | T3 Code | octopus-diff |
|---|---|---|
| CLI + browser | `t3` npm package (`apps/server`, bin `dist/bin.mjs`) serves the web UI | `octopus-diff serve` (`apps/cli`) serves `apps/web` from the daemon |
| Web UI | `apps/web`, one build for browser and app | `apps/web`, one build for browser and app |
| Desktop | `apps/desktop` runs the **bundled server** as a child process (`ELECTRON_RUN_AS_NODE=1`, bootstrap over fd 3) and shows the UI in a window | `apps/desktop` runs the **bundled CLI's `serve`** as a child process (`ELECTRON_RUN_AS_NODE=1`, ready line over fd 3) and shows the UI in a window |
| CLI from the app | `DesktopCliShim.ts` installs a `t3` command that runs the app's bundled CLI | the app installs an `octopus-diff` command that runs its bundled CLI |
| WSL | the Windows app runs the server inside a distro via `wsl.exe` | Phase D, same approach |

Two places where we deliberately differ from T3:

- **The UI loads from the daemon's HTTP origin** (`http://127.0.0.1:7428/#token=…`), not a custom `t3code://`
  scheme. The existing token flow, Host/Origin checks and CSP work unchanged, with no daemon or web changes. The cost
  is that prefs in `localStorage` are tied to the port (§3.3). A custom scheme stays a later option.
- **One daemon per state dir, shared with the CLI.** T3 gives the app its own backend. Ours share one SQLite store
  and set of watchers with the CLI, so the app attaches to a running daemon instead of starting a second one.
  `serve` already enforces this (`apps/cli/src/commands/serve.ts`, `findRunningDaemon`).

Principles:

- **Same CLI, same daemon, same UI, same contracts.** The app is a shell. It never forks the daemon or the web build.
- **The read-only guarantee doesn't move.** Electron code never spawns `git`. Native features (reveal in file
  manager, open in editor, folder dialog) only touch the OS shell, never a repository.
- **Progressive enhancement.** Desktop-only features come through an optional `window.octopusDesktop` bridge. The web
  build feature-detects it and works the same when it's missing.

Why Electron fits: the daemon is Node, and Electron ships Node. One runtime runs the CLI, the daemon and the UI, with
no sidecar binary.

## 2. Verified (spike 2026-11-08, phase 0 2026-11-13)

Electron `45.3.2` (latest 45.x on 2026-11-13; it bundles **Node 24.22.2**, V8 15.6, libuv 1.52.1, SQLite 3.53.4, which meets
`engines: >=24`), run with `ELECTRON_RUN_AS_NODE=1`, which is exactly how the app will run the CLI. The spike of
2026-11-08 used 45.2.3 with the same Node.

- `node:sqlite` (`DatabaseSync`) works: created a table, inserted a row, read it back.
- `@parcel/watcher` 2.6 (N-API, prebuilt) loads and subscribes. N-API binaries are ABI-stable, so
  **no `electron-rebuild`**.
- **The `cli`, `daemon`, `forge` and `git-core` vitest suites** run under Electron's Node. One test-only gap (a test
  spawned `process.execPath` without `ELECTRON_RUN_AS_NODE`) was fixed; the figures are in
  `docs/reports/desktop-phase0.md`.
- **The CLI bundle serves from inside an `app.asar`** (`serve`, `doctor`): `/` and the hashed assets, the diff API,
  the spawn helper (#45) and the watch host (`@parcel/watcher`) all work with **nothing unpacked**, including with the
  hardening fuses of §5 flipped. What is still worth unpacking, and why, is in §10.
- On this WSL machine Electron needs the extracted Chromium libraries. `LD_LIBRARY_PATH` is **not enough**: the
  daemon starts the git helper with an empty environment, so it loses it (the watch host inherits `process.env` minus
  `NODE_OPTIONS`, so it keeps it). Put the libraries next
  to the binary instead (Electron's RPATH is `$ORIGIN`): `ln -s ~/.cache/octopus-diff-dev/chromium-libs/usr/lib/x86_64-linux-gnu/* <electron dir>/`
  (see AGENTS.md "e2e on this machine"; note the `usr/lib/x86_64-linux-gnu` subpath). A normal machine needs neither.

## 3. Architecture

```
Electron main (apps/desktop)                        child: Electron binary, ELECTRON_RUN_AS_NODE=1
 ├─ single-instance lock, menus, window state         └─ <app>/cli/dist/index.js serve --ready-fd 3 --exit-with-stdin
 ├─ backend supervisor ──spawn / fd3 ready / stdin──▶      ├─ attached? print ready line, exit 0
 ├─ CLI shim installer                                     └─ started:  startDaemon() ← apps/daemon, unchanged
 ├─ IPC handlers (validated) ◀─ preload bridge                ├─ git-core runner ──spawn──▶ git
 └─ BrowserWindow ──HTTP + SSE (token)─────────────▶          ├─ @parcel/watcher, node:sqlite
       loads <authUrl from ready line>                         └─ serves the web UI at /
```

### 3.1 The backend is the bundled CLI, run as Node

- The main process spawns `process.execPath` with `ELECTRON_RUN_AS_NODE=1` and the bundled CLI entry:
  `serve --ready-fd 3 --exit-with-stdin`. stdio is `['pipe', 'pipe', 'pipe', 'pipe']`: stdin is the lifeline,
  stdout/stderr go to `app.getPath('logs')/daemon.log`, and fd 3 carries one JSON ready line.
- Ready line (zod schema `ServeReadySchema` in `packages/contracts/src/daemon.ts`, additive):
  `{ mode: 'started' | 'attached', url, authUrl, pid, version }`. The main process validates it and never logs `authUrl`
  (it holds the token).
- **Attach-or-start comes from the CLI.** If a verified daemon is already running for the state dir, `serve` writes
  `mode: 'attached'` and exits 0. The app loads that daemon's URL and doesn't own it; quitting the app leaves it
  running. Otherwise `serve` starts the daemon (writing `daemon.json` as it does today), writes `mode: 'started'`
  and stays up. Then `octopus-diff add .` in any terminal talks to the app's daemon.
- **Shutdown is portable.** On quit, the main process closes the child's stdin. With `--exit-with-stdin`, the CLI
  treats EOF as a shutdown request (Windows has no SIGTERM). The same EOF fires if Electron crashes, so no orphan
  daemons. After a grace period (T3 uses SIGTERM then SIGKILL), the supervisor kills the child.
- **Supervision.** If a daemon the app started exits unexpectedly, restart it with backoff. After repeated failures,
  show an error screen with the log path. If an attached daemon goes away (SSE drops and health fails), run `serve`
  again; it will start one.
- Version skew: an attached daemon may be an npm-installed CLI of another version. Compare `version` from the ready
  line and show a quiet notice if they differ (`/api/health` already reports the version).

### 3.2 The `octopus-diff` command from the app (CLI shim)

As in T3's `apps/desktop/src/app/DesktopCliShim.ts`: a menu item (**Install `octopus-diff` command…**, and a
Settings button) writes a small launcher that runs the app's bundled CLI with `ELECTRON_RUN_AS_NODE=1`.

- Location: `~/.local/bin/octopus-diff` (macOS, Linux; tell the user if that dir isn't on PATH),
  `%LOCALAPPDATA%\octopus-diff\bin\octopus-diff.cmd` plus a user-PATH entry (Windows). No admin rights.
- The launcher carries a marker line. The app rewrites only files with its marker (for example after an update moves
  the app), and **never overwrites** a real npm-installed `octopus-diff`. If one is on PATH, the app says so and
  installs nothing.
- AppImage: the mount path changes on every run, so the launcher must run the AppImage file itself
  (`$APPIMAGE`), which re-enters the CLI. T3 solves this; copy the approach with attribution.
- Quote paths for `sh` and `cmd` (T3's `shellWord` / `cmdWord`). Paths with non-ASCII characters need care on
  Windows `.cmd`.

### 3.3 Renderer and the auth token

- Load `authUrl` from the ready line. `apps/web/src/api/token.ts` already moves the fragment into `localStorage`
  and strips it, so **the web build needs no auth changes**.
- Electron's storage is separate from the user's browsers, so the token never reaches a browser profile.
- Prefs live in origin-scoped `localStorage`, so the port matters. The daemon normally sits on `DEFAULT_PORT` (7428),
  so prefs persist across launches. If 7428 is taken by something else and the CLI falls back to another port, that run
  starts with default prefs. Acceptable for v1. Later option: a custom `app://` scheme (needs a daemon
  `allowedOrigins` option and a configurable API base URL in the web client).

### 3.4 Preload bridge (`window.octopusDesktop`)

A sandboxed CommonJS preload exposes a small, typed API through `contextBridge`. The type lives in
`packages/contracts/src/desktop.ts` (types only, browser-safe; an additive `contracts:` commit).

| Method | Main-process behavior |
|---|---|
| `platform` | `'darwin' \| 'win32' \| 'linux'` (title bar layout) |
| `pickFolder({ title, defaultPath })` | `dialog.showOpenDialog({ properties: ['openDirectory'] })` → path or null |
| `revealPath(worktreeId, relPath)` | `shell.showItemInFolder`, only after the path is checked (below) |
| `openPath(worktreeId, relPath)` | `shell.openPath` (default app), same check |
| `openInEditor(worktreeId, relPath, line?)` | allowlisted editor URL schemes (`vscode://file/…`, `cursor://…`, `zed://…`) via `shell.openExternal` |
| `setBadge(count)` | dock badge / taskbar overlay / Unity count = unreviewed files |
| `getPathForFile(file)` | `webUtils.getPathForFile` (drop a folder on the window to add it) |
| `installCli()` / `cliStatus()` | the shim installer in §3.2 |

**Path check:** the main process never trusts a path from the renderer. It resolves `worktreeId` through the
daemon API (`GET /api/projects`, with the token from the ready line), joins `relPath`, `realpath`s the result and
refuses anything outside that worktree. No git involved.

## 4. Repository layout and ownership

New stream **WS6 — desktop**, owning `apps/desktop/` (package `@octopus-diff/desktop`, private):

```
apps/desktop/
  src/main.ts            app lifecycle, single-instance lock, menus, window state, security policy
  src/backend.ts         supervisor: spawn the CLI (RUN_AS_NODE), fd 3 ready line, stdin lifeline, restart/backoff
  src/cli-shim.ts        install/inspect the `octopus-diff` launcher (marker, sh/cmd quoting, AppImage)
  src/preload.cts        contextBridge (bundled to CJS; sandboxed preloads can't be ESM)
  src/ipc.ts             handlers: sender-origin check, zod validation, path check
  src/shell-env.ts       login-shell PATH resolution (macOS/Linux GUI launches)
  scripts/build.mjs      esbuild main + preload; copies the CLI bundle (with dist/web) into the app
  electron-builder.yml   targets, asar/asarUnpack, fuses, icons
  test/                  vitest (supervisor, ready-line parsing, shim rendering, nav policy, IPC validation)
```

It follows the repo conventions: an `exports` source condition, `build`/`typecheck`/`test`/`lint` scripts, Biome,
strict TS. The root `pnpm build` places it after `cli` and `web`. Builds go to `dist/`. Installers go to `release/`
(gitignored).

Small changes that other streams make (logged in DECISIONS, not done by WS6):

| Owner | Change |
|---|---|
| WS5 (CLI) | `serve --ready-fd <n>`: one JSON ready line (`ServeReadySchema`) when listening, or right away when attaching (then exit 0). `serve --exit-with-stdin`: EOF on stdin shuts down gracefully. Factor `scripts/pack.mjs`'s esbuild step into a reusable bundle output (`dist/index.js` + `dist/web`, `@parcel/watcher` external) that both the tarball and the app ship. Later: `octopus-diff open` launches the app when it's installed |
| lead (contracts) | `ServeReadySchema` in `daemon.ts`; `desktop.ts` with the `DesktopBridge` type and `declare global { interface Window { octopusDesktop?: DesktopBridge } }` |
| WS3 (web) | `lib/desktop.ts` feature detection; a **Browse…** button in `AddProjectForm` (native dialog, then the existing add flow); Reveal / Open / Open in editor items in the file and worktree menus; `data-desktop-platform` on `<html>` for macOS traffic-light padding and `-webkit-app-region: drag` on the header; `setBadge` from the existing unreviewed count; drop a folder to add it; "Install command" in Settings |
| WS4 (e2e) | Playwright `_electron.launch` smoke suite; the read-only proof harness also runs against the app |

The daemon (WS2) and git-core (WS1) need **no changes**.

## 5. Security baseline (non-negotiable, test it)

- `BrowserWindow`: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`,
  no `webviewTag`.
- Navigation lock: `will-navigate` / `will-redirect` allow only the daemon origin. `setWindowOpenHandler` denies
  everything and passes `http(s)` URLs to `shell.openExternal`.
- `session.setPermissionRequestHandler` / `setPermissionCheckHandler`: deny everything. Badges and notifications go
  through the bridge.
- IPC: every handler checks `event.senderFrame.url` against the daemon origin and validates arguments with zod.
- The daemon keeps its token, loopback bind, Host/Origin checks and CSP (`apps/web/scripts/csp-check.ts`). The
  app adds no API surface.
- Electron fuses (`@electron/fuses`, set by electron-builder): **`RunAsNode` stays on**, because the backend and the
  CLI shim need it (same as T3 Code and VS Code). That means anyone who can run the app binary can run Node with it,
  which is no more than having Node installed. Everything else is hardened: `EnableNodeOptionsEnvironmentVariable` off,
  `EnableNodeCliInspectArguments` off, `EnableCookieEncryption` on, `OnlyLoadAppFromAsar` on,
  `EnableEmbeddedAsarIntegrityValidation` on.
- The ready line and the shim never put the token on a command line or in a log (tokens on argv show up in `ps`).
- No remote content, no auto-download of anything except (later) signed updates.

## 6. Platform specifics

- **`git` on PATH.** A GUI launch on macOS gets a minimal PATH (`/usr/bin:/bin:…`), so Homebrew or MacPorts git is
  missing and `/usr/bin/git` may be the Xcode CLT stub. Before spawning the CLI, resolve PATH from the login shell
  (`$SHELL -ilc 'printf %s "$PATH"'`, with a timeout; VS Code and T3 do the same) and pass it in the child's env. If
  no usable git is found (`octopus-diff doctor`'s check), show a friendly screen with install instructions instead of
  an empty window.
- **Native module.** `@parcel/watcher` is a dependency of `apps/desktop`, so its platform package lands in
  `app.asar.unpacked/node_modules` (`asarUnpack`) and the bundled CLI resolves it from there. Each OS/arch build
  includes only its own prebuilt binary.
- **Window chrome.** macOS: `titleBarStyle: 'hiddenInset'` plus a drag region in the web header. Windows/Linux:
  native frame in v1 (`titleBarOverlay` later).
- **Menus.** Standard App/Edit/View/Window menus. Accelerators must **never** be bare letters: `j/k/n/r/s` stay
  the web UI's. Add `Cmd/Ctrl+O` (add folder: native dialog), `Cmd/Ctrl+,` (Settings route), `Cmd/Ctrl+R`
  (refresh data, not a page reload), and DevTools only in dev builds or behind a menu flag.
- **WSL (this machine).** A Windows build would see Windows paths, and git over `\\wsl$` is slow and can't be
  watched. v1: run the **Linux** build under WSLg (it works today with the Chromium libraries installed).
  Phase D: the Windows app runs the backend **inside** a chosen distro (`wsl.exe -d <distro> -- octopus-diff serve
  --ready-fd …`; `wsl.exe` drops extra fds, so T3 delivers its bootstrap over stdin, and we'd move the ready line to a
  stdout marker there). It needs the CLI and Node ≥ 24 in the distro, and loads `http://127.0.0.1:N` (WSL2 localhost
  forwarding, or mirrored networking). T3's `apps/desktop/src/wsl/` is the reference (MIT).

## 7. Build, packaging, distribution

- **Bundling:** the CLI bundle (from WS5's refactored `pack.mjs` step: one ESM file with contracts, git-core and
  daemon inlined, plus `dist/web`) is copied to `app.asar/cli/`. `webRootCandidates` already finds `<pkg>/dist/web`
  next to the bundle. esbuild builds the main process (ESM) and the preload (CJS). The npm tarball and the app ship
  the **same** CLI bundle.
- **Packaging:** electron-builder (T3 Code uses it; the most mature cross-platform targets):
  Linux AppImage + deb (x64, arm64); macOS dmg + zip (arm64, x64, or universal); Windows NSIS (x64, arm64).
  Icons come from the existing set (`apps/web/scripts/icons.ts` gets a 1024 px PNG, `.icns` and `.ico` output).
  Expect an installer of about 100 MB.
- **Dev loop:** `pnpm --filter @octopus-diff/desktop dev` spawns the CLI from sources (`tsx --conditions=@octopus-diff/source
  apps/cli/src/index.ts serve --ready-fd 3 --exit-with-stdin`, run with Electron's Node too, so dev matches prod)
  and loads the daemon URL. For UI work, point the window at the Vite dev server (it already proxies `/api`).
  Main/preload rebuild via esbuild watch.
- **CI** (committed, not pushed, per PLAN §7): a matrix job builds **unsigned** artifacts on
  ubuntu/macos/windows and runs the Electron smoke test (`xvfb-run` on Linux). Node 24 coverage already exists
  (the `check` job runs on Node 24 and 26, `package` on Node 24, DECISIONS #472), so nothing new is needed to stop
  code depending on Node 26 APIs; the Electron smoke job runs on Node 24.
- **User-gated (Phase E):** code signing and notarization (Apple Developer ID, a Windows certificate or Azure
  Trusted Signing), auto-update (`electron-updater` from GitHub Releases needs a public repo and published
  releases), app name/branding (PLAN Phase 3).

## 8. Phases

| Phase | Scope | Done when |
|---|---|---|
| **0. Spike + docs** (½ session; **done 2026-11-13**) | Run cli + git-core + daemon vitest under Electron's Node (`ELECTRON_RUN_AS_NODE=1`); serve web assets from inside an asar; PLAN §2 + DECISIONS entry; WS5/contracts requests filed | Suites green under Node 24.22 (or gaps listed); decision logged |
| **A0. CLI hooks** (WS5 + lead, small) | `--ready-fd`, `--exit-with-stdin`, reusable bundle step, `ServeReadySchema` | CLI tests cover started/attached ready lines and stdin-EOF shutdown on all OSes in CI |
| **A. Shell MVP** (1–2 sessions) | `apps/desktop` scaffold, backend supervisor (spawn, ready line, attach/start, restart, shutdown), window loads `authUrl`, the §5 security baseline, single instance (a second launch focuses the window), window-state persistence, menus, shell-env PATH, git-missing screen, logs | `pnpm --filter @octopus-diff/desktop start` opens the app with the user's projects; with `octopus-diff serve` already running it attaches and quitting leaves that daemon up; otherwise `octopus-diff status` sees the app's daemon and quitting stops it; killing Electron leaves no orphan daemon; unit tests for the supervisor, nav policy, IPC validation |
| **B. Packaging** (1 session) | Shared CLI bundle in the app, electron-builder config, fuses, asarUnpack, icons, CI matrix, Playwright Electron smoke in `e2e/` | The AppImage runs on a clean Linux VM and the dmg on macOS (unsigned, with the right-click → Open workaround); smoke test green; the read-only proof harness passes against the packaged app |
| **C. Native integration + CLI shim** (1 session, WS3 + WS6) | Native folder dialog, drag-to-add, reveal/open/open-in-editor with the path check, macOS title bar, unreviewed badge, external links; install the `octopus-diff` command (§3.2) | Every bridge method is covered by tests; the shim works from deb, dmg, NSIS and AppImage installs and never overwrites an npm install; the browser build is unchanged (existing e2e green) |
| **D. Windows + WSL** (1–2 sessions) | Windows app with a WSL-distro backend (§6); distro picker in Settings | From Windows, the app shows repos inside WSL with live updates |
| **E. Release** (needs the user) | Signing, notarization, auto-update, name, first public release | The user signs off |

Acceptance additions for PLAN §8 (desktop): (D1) a fresh install opens to the main view without a terminal;
(D2) the app and the CLI never run two daemons on one state dir; (D3) the security baseline in §5 is asserted by
tests; (D4) the read-only proof passes with the app; (D5) idle CPU of app + daemon is single-digit % on the
30-repo fixture; (D6) the installed `octopus-diff` command talks to the app's daemon.

## 9. Risks

- **Electron's Node lags the dev machine's Node 26.** Mitigation: Phase 0 ran the suites under 24.22; CI
  already runs `check` on Node 24 (and 26) and `package` on Node 24, so new code can't depend on Node 26 APIs unnoticed.
- **Version skew between an npm CLI and the app's CLI** on one state dir (shared SQLite). Mitigation: attach shows a
  notice when versions differ; store migrations stay forward-compatible or refuse clearly.
- **Size and memory** (~100 MB installer, one Chromium per window). Acceptable for a desktop tool; one window only.
- **macOS PATH / git discovery** is the most common "works in terminal, empty in app" bug. Shell-env resolution and
  a visible git-missing screen.
- **Unsigned builds** trigger Gatekeeper/SmartScreen warnings until Phase E.
- **Host features absorbing ours** (PLAN §3) don't change: the shell adds convenience, the moat stays the cross-repo view and
  review loop.

## 10. Phase 0 results and roadmap decisions (2026-11-13)

Phase 0 (#16) is done. The evidence is in `docs/reports/desktop-phase0.md`; the decisions are DECISIONS #466-#475.

**Roadmap decisions (2026-11-11, #24), accepted as written:**

- **`child_process` + `ELECTRON_RUN_AS_NODE`, not `utilityProcess`.** `utilityProcess` forces stdin to `ignore`, which
  breaks the `--exit-with-stdin` lifeline of #17, and it cannot serve CLI attach or the WSL backend of Phase D.
- **HTTP + SSE stays the transport.** A request costs single-digit milliseconds against 0.4-1.9 s of git; a second
  transport would mean building and testing every data path twice.
- **The spawn helper (#45) lands before #19**, so its entry file is bundled and handled by the packaging from the
  start. See "Asar" below for what that means (it does not have to be unpacked to run).
- Desktop is mostly native integration (dialogs, reveal, badge), not a performance lever; the ordered performance list
  is independent of this track and can run in parallel (milestone M7).

**Asar (answers for #19).** Tested with `@electron/asar` on the packed CLI bundle (`dist/index.js`, `dist/git-helper.js`,
`dist/web`, `node_modules/@parcel/watcher*`) under Electron 45.3.2 with `ELECTRON_RUN_AS_NODE=1`, with nothing unpacked,
with `**/*.node` + `git-helper.js` unpacked, and with the §5 fuses flipped on a copy of the binary:

| What | In `app.asar` with nothing unpacked | Verdict |
|---|---|---|
| `serve`: `GET /` and a hashed `/assets/*.js` / `.css` | 200, same content type and size as the unpacked tree | works |
| `doctor` (web UI, git helper, Node check) | ok | works |
| Diff through the API; review state in `node:sqlite` (the DB lives in the state dir, outside the asar) | works | works |
| Git spawn helper: `process.execPath <app.asar>/dist/git-helper.js` | runs; Electron's `fs` patch also applies in a `RUN_AS_NODE` child | works, unpacking not required |
| `@parcel/watcher` in the watch host (`process.execPath -e`, entry resolved inside the asar) | native mode, live SSE events | works, but Electron **extracts the `.node` file to a temp file** on every load |
| Fuses: `RunAsNode` on, `EnableNodeOptionsEnvironmentVariable` / `EnableNodeCliInspectArguments` off, `OnlyLoadAppFromAsar` on | all of the above unchanged | works |

Recommendation for #19: `asarUnpack` the native addon packages (`node_modules/@parcel/watcher*/**`, which
electron-builder normally does for packages with `.node` files; verify it in #19: no temp-file extraction, and no failure on a `noexec` temp dir) and
`dist/git-helper.js`. The helper does not need it to run, but it costs nothing and gives it a real file next to the
unpacked binaries. Even when unpacked, the path the supervisor and the runner use stays the asar path
(`<app>/app.asar/dist/git-helper.js`); Electron redirects it to `app.asar.unpacked`. A plain system `node` cannot read an asar, so any
future code that runs a bundled file with something other than Electron must use the `.unpacked` path. Do **not**
unpack the whole CLI directory: it is not needed. `EnableEmbeddedAsarIntegrityValidation` could not be tested here
(macOS and Windows only): do that in #19's CI matrix.

**Environment contract for the app (#17, #18, #19, the CLI shim).** Under Electron `process.execPath` is the Electron
binary, which starts the full app unless `ELECTRON_RUN_AS_NODE=1` is set. `git-core`'s helper client sets it itself
(`process.versions.electron`); the daemon's **watch host inherits `process.env`**, so the CLI process must have it set.
The supervisor (#18) and the launcher written by the shim (§3.2) must therefore export it, and any new code that spawns
`process.execPath` must set it. The daemon must never run inside Electron's main process.
