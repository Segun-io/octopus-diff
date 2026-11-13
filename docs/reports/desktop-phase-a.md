# desktop-phase-a report

Roadmap #18 (desktop phase A: the shell MVP, part of #15), new stream WS6. Branch `t3/96eeccb9`, 2026-11-13. Not
pushed, no PR. DECISIONS #486-#504.

## Shipped

`apps/desktop` (`@octopus-diff/desktop`, private), README in `apps/desktop/README.md`.

- **Backend supervisor** (`src/backend.ts`, `BackendSupervisor`; spawn, clock and health probe injected). Spawns
  `process.execPath` with `ELECTRON_RUN_AS_NODE=1` and `<cli> serve --ready-fd 3 --exit-with-stdin --no-open
  [--state-dir …]`; stdin and fd 3 are pipes, stdout/stderr are the `daemon.log` descriptor (#490). Reads fd 3,
  validates the line with `ServeReadySchema` (`parseReadyLine`; the reason never quotes the line), never logs `authUrl`.
  `started`: owned; unexpected exit → restart with backoff 0.5/1/2/4/8 s, `failed` after 5 in a row, a 60 s run resets
  the count, 30 s ready timeout. `attached`: not owned; the attach run's exit 0 is expected; `/api/health` polled every
  5 s, 2 misses → `serve` again. `stop()`: close stdin, 8 s, SIGTERM, 3 s, SIGKILL; an attached daemon is left alone.
  Version skew flagged (`versionMismatch`).
- **Window and security baseline** (`src/policy.ts`, wired in `src/main.ts`): `contextIsolation`, `sandbox`,
  `webSecurity` on; `nodeIntegration` (all variants), `webviewTag` off; no preload; `devTools` only with `--dev`.
  `will-frame-navigate`/`will-navigate`/`will-redirect` allow only the UI origin (`navigationPolicy`);
  `setWindowOpenHandler` denies and sends only http(s) to `shell.openExternal` (`windowOpenPolicy`);
  `will-attach-webview` prevented; permission request/check/device handlers deny everything.
- **Screens** (`src/screens.ts`): starting, restarting, failed (with the log path, "Try again", "Show the log"), git
  missing (install commands per platform). Static `data:` pages with a `default-src 'none'` CSP.
- **git check**: the daemon's `/api/health` `git.supported` after each ready line (#493); no git spawn from Electron.
- **Single-instance lock** (a second launch focuses the window and exits), **window-state persistence**
  (`src/window-state.ts`: validated, clamped to the displays), **menus** (`src/menu.ts`: App/File/Edit/View/Window/Help;
  Add Folder `Cmd/Ctrl+O` → native dialog → `POST /api/projects`, offering a scan root for a non-repository; Settings
  `Cmd/Ctrl+,`; Refresh `Cmd/Ctrl+R` = the web's refresh button, not a page reload; Undo that keeps the web's
  Cmd/Ctrl+Z; DevTools and Reload Page only with `--dev`; never a bare-key accelerator).
- **Login-shell PATH** (`src/shell-env.ts`): `$SHELL -ilc` with markers and `${PATH}`, 5 s timeout, macOS/Linux.
- **Logs**: `app.getPath('logs')/daemon.log` (daemon output + `[desktop …]` supervisor lines; no token).
- **Build/dev**: `scripts/build.mjs` (esbuild `dist/main.js`; `dist/cli/` from `apps/cli/scripts/bundle.mjs`, reused);
  `start` = `electron .`; `dev` = `scripts/dev.mjs` (CLI from sources via the tsx import hook under Electron's Node,
  restart on rebuild, `--renderer-url` for Vite).
- **Verification scripts**: `smoke:backend`, `smoke:app`, `mutation-check` (below).

## Verification

All on this WSL2 machine (Linux, Node 26.13.0; Electron 45.3.2 = Node 24.22.2), Chromium libraries symlinked next to
the Electron binary (DESKTOP §2). Commands from the repo root, final code:

| Command | Result |
|---|---|
| `pnpm install` | ok (lockfile up to date after the dependency commit) |
| `pnpm lint` | pass: Biome 619 files, 4 warnings + 1 info, all pre-existing in `apps/web` (none in `apps/desktop`); `credits:check` up to date (155 shipped packages, 18 dev tools) |
| `pnpm typecheck` | pass, all 9 packages |
| `pnpm build` | pass (desktop adds `dist/main.js` and `dist/cli/`) |
| `pnpm test` | pass: contracts 138, forge 101 (+5 skipped), fixtures 58, web 512, git-core 556 (+1 skipped), daemon 610 (+4 skipped), e2e package 8, cli 174, **desktop 85** (6 files, ~0.3 s), scripts 34 |
| `pnpm test:e2e --workers=1` | 110 passed (3.0 min), read-only proof 0 violations (web and daemon unchanged) |
| `node apps/desktop/scripts/smoke-backend.mjs` | all 6 scenarios pass (27 checks), 3 runs in a row green earlier, ~3.6 s |
| `DISPLAY=:0 node apps/desktop/scripts/smoke-app.mjs` | all 5 scenarios pass (31 checks), ~14 s, real window under WSLg |
| `node apps/desktop/scripts/mutation-check.mjs` | 43 mutations, 43 killed, ~16 s (`src/` restored after each) |

What the smokes show, against the real built CLI and the real Electron binary:

- **Supervisor** (`smoke-backend`, Electron as Node, no display): `started` (the ready line's pid is the child;
  `octopus-diff status` sees it at the same URL; the registered fixture project is served; stdin EOF stops it in
  ~16 ms, no signal needed, `daemon.json` removed, its 3 helper processes gone ~50 ms later); `attached` (pid of a
  running `serve`; stopping the app leaves it up and answering); the attached daemon killed → `serve` runs again and
  starts one that the app owns; a SIGKILLed daemon → `restarting → starting → ready` with a new pid; **the supervising
  parent SIGKILLed → the daemon exits ~50 ms later, gracefully** (`daemon.json` removed, shutdown lines in the log) and
  the next launch starts a fresh one; PATH without git → health `git.supported: false`.
- **The app** (`smoke-app`, `dist/main.js` in Electron with a window, inspected over CDP): the window loads the daemon
  origin and the web UI lists the project that `octopus-diff add` registered with the app's daemon (so the CLI talks to
  the app's daemon); the token fragment is gone from the URL; no `require`/`process`/`module`, no bridge;
  `window.open` denied; navigation to another origin blocked and logged by origin only; notification request and
  geolocation check denied; the menu's Settings script opens the web Settings dialog and the Refresh script finds the
  refresh button; a second launch exits 0 without touching the first one's log and the first keeps running; SIGTERM
  quits the app and stops its daemon (`daemon.json` removed); the window state is saved; `daemon.log` has no token;
  **SIGKILL of Electron → the daemon exits ~100 ms later, gracefully**; with `serve` already running the app attaches
  and quitting leaves `serve` up (status still sees it); PATH without git → the git-missing screen (no script on it);
  `--port 1` → 5 failures → the error screen with the log path, and its "Try again" starts the backend again.
- **Manual**: `pnpm --filter @octopus-diff/desktop dev` with temp dirs (CLI from sources under Electron's Node through the
  tsx hook; PATH from the zsh login shell; touching `src/main.ts` restarted Electron and replaced the daemon; SIGTERM to
  `dev.mjs` stopped everything, no process left). `start`'s command (`electron .` through Electron's `cli.js`) with temp
  dirs: up, then SIGTERM → daemon stopped, nothing left. A screenshot of the window showing the fixture project's
  diff was taken during the app smoke (`--screenshot`).

Bugs the verification found and fixed on the way: `$PATH__MARKER` in the shell script (real `/bin/sh` test); `exit`
arriving before fd 3's data (unit test); the EPIPE shutdown abort (#490, smoke); screen buttons that emitted no event
on a `data:` page, then `will-frame-navigate` deciding first (#491, #492, smoke); a second instance opening/rotating
the first one's log before exiting (code review; smoke check added); a quit during the login-shell lookup still
starting a backend (code review).

## Decisions

DECISIONS #486-#504. The notable ones: no preload/IPC in phase A (#486); Electron 45 has no install script, so no
`allowBuilds` entry and no CI change were needed (#487); the daemon writes `daemon.log` through its descriptor instead
of pipes, a deviation from DESKTOP §3.1's stdio tuple found by the smoke test (#490); one handler for
`will-frame-navigate` and `will-navigate` (#491); screen buttons are `octopus-diff-desktop:` links because fragment
links on `data:` pages emit no event (#492); git missing comes from `/api/health` (#493); the menu drives the web UI's
existing shortcut and refresh button (#495); userData is `octopus-diff-desktop`, apart from the CLI's config dir (#497);
native frame on every platform until the web has a drag region (#498).

## Contract changes

None.

## Dependencies

`apps/desktop`: `electron` 45.3.2 (dev, pinned), `esbuild` ^0.28.2 (dev), `@parcel/watcher` ^2.6.0 and `zod` ^4.6.7
(runtime, already in the lockfile), workspace `@octopus-diff/contracts`, and devDependencies on `octopus-diff` and
`@octopus-diff/web` for build order. `pnpm credits` was run in the same commit (`electron` listed as a development tool;
`credits:check` passes). Not in `shippedWorkspaces` until #19 (#488). `pnpm-workspace.yaml`: pnpm added
`minimumReleaseAgeExclude: [electron@45.3.2]` itself; no `allowBuilds` change (#487). No CI change (#487).

## Known gaps

- **macOS and Windows not run** (no machine): menus, `Cmd` accelerators, Dock reopen, a real GUI launch's PATH,
  Windows shutdown (stdin EOF is the portable path; the signal fallbacks were only exercised on Linux).
- **Menu clicks not driven**: Add Folder's native dialog and Undo were verified through unit tests and the daemon API,
  Settings and Refresh by running the menu's exact scripts on the real web UI over CDP; no automated menu click.
- **The user's real state dir was never used** (every run had temp state/config/app-data dirs): "opens with the
  user's projects" was verified with a fixture project added through `octopus-diff add` to the app's daemon, which is
  the same code path.
- **Version notice** unit-tested only (no daemon of another version here).
- **The smoke scripts are not in CI** (no Electron binary there); #19's Electron job should run them (#501, #502).
- **CLI EPIPE during shutdown** (WS5): worked around here (#490), still reachable for other parents of `serve`.
- Menu actions use synthetic key events / a button click until the web has hooks (WS3, #20; #495).
- `--remote-debugging-port` is not refused yet (packaged builds, #19; #502).

## Notes for integration

- New workspace package; the root `pnpm build` builds it after `cli` and `web` (about 1 s more: esbuild + the CLI
  bundle). `pnpm check` needs neither the Electron binary nor a display.
- To run the app: `pnpm build`, then `pnpm --filter @octopus-diff/desktop start` (the first run downloads the Electron
  binary). On this WSL machine: the Chromium libs symlink (README) and `DISPLAY=:0`.
- Requests for other streams: WS5, ignore EPIPE on stdout/stderr during the `--exit-with-stdin` shutdown (#490); WS3,
  explicit hooks for the menu's Settings/Refresh/Undo (#495), and the header drag region before macOS `hiddenInset` (#498).
- #19 inherits: shippedWorkspaces + Electron/Chromium credits (#488), refuse remote debugging in packaged builds, the
  smoke scripts in the Electron CI job (#502).
