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
| `pnpm --filter @octopus-diff/desktop mutation-check` | Mutates the security policy and supervisor rules; the unit tests must catch each mutation |

The smoke scripts skip (exit 0) without the Electron binary or a build.

**The Electron binary.** Electron 45 has no install script: `pnpm install` does not download it. The first `start`
or `dev` downloads it (about 100 MB, cached in `~/.cache/electron`), or run
`pnpm --filter @octopus-diff/desktop exec install-electron`. Nothing in `pnpm check` needs it.

**This WSL machine** also needs the extracted Chromium libraries next to the binary (`docs/DESKTOP.md` §2):
`d=$(readlink -f apps/desktop/node_modules/electron)/dist; for f in ~/.cache/octopus-diff-dev/chromium-libs/usr/lib/x86_64-linux-gnu/*; do [ -e "$d/$(basename "$f")" ] || ln -s "$f" "$d/"; done`.
A window opens under WSLg with `DISPLAY=:0`.

## Options

After `--` (see `src/args.ts`): `--state-dir <dir>`, `--config-dir <dir>`, `--port <n>` (passed to `serve`),
`--app-data-dir <dir>` (Electron's userData: window state, logs, Chromium profile, single-instance lock; default
`<appData>/octopus-diff-desktop`), `--dev`, `--backend bundle|source`, `--renderer-url <url>`.

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
| `src/page-actions.ts` | Menu actions that drive the web UI (Settings, Refresh, Undo) |
| `src/screens.ts` | Starting / error / git-missing screens (static `data:` pages) |
| `src/shell-env.ts` | Login-shell PATH (macOS/Linux) |
| `src/window-state.ts` | Saved window bounds, validated and clamped to the displays |
| `src/daemon-api.ts` | Health (liveness, git check) and Add Folder through the daemon API |
| `src/log-file.ts` | `daemon.log` (the daemon writes to it directly) |

No preload and no IPC yet: the `window.octopusDesktop` bridge is phase C (#20).
