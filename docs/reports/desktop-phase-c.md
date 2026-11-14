# desktop phase C report (native integration, roadmap #20)

## Shipped

The optional `window.octopusDesktop` bridge (docs/DESKTOP.md §3.4) and the web UI hooks that use it. The browser build
has no bridge and behaves as before (the existing e2e suite is unchanged and green).

- **Contracts** (`packages/contracts/src/desktop.ts`, an additive `contracts:` commit): `DesktopBridge`, the optional
  `Window.octopusDesktop` declaration, refusal reasons, and `DESKTOP_EDITORS` / `DESKTOP_EDITOR_LABELS` /
  `DESKTOP_COMMANDS` (#530).
- **Preload** (`apps/desktop/src/preload.ts` → `dist/preload.cjs`, 3.9 KB, sandboxed, `contextBridge` only) exposing
  `bridge.ts`: `version`, `platform`, `pickFolder`, `revealPath`, `openPath`, `openInEditor`, `setBadge`,
  `getPathForFile`, `copyText`, `onCommand`. The actions that act on the OS need a user gesture (#536).
- **Main process** (`ipc.ts`, wired by `bridge-main.ts`): every handler checks the sender (our window, main frame, the
  UI's origin, nothing while a screen shows) and validates its arguments with zod; refusals are values, logged with the
  reason only (#533). The path check (`path-guard.ts`) resolves the worktree through `GET /api/projects`, joins plain
  segments, `realpath`s root and target and refuses anything outside, symlinks included (#534). `openPath` never runs
  a program (`open-safety.ts`, #535). Editor URLs (`editor-url.ts`) are built in main and pass an allowlist (#537).
  Badge (`badge.ts`, #538), menu commands to the page with phase A's scripts as fallback (`page-commands.ts`, #539),
  clipboard (#540).
- **Window**: macOS `hiddenInset` title bar with the traffic lights in a 32 px drag strip the web draws; our screens get
  the strip too (#541). Windows/Linux unchanged.
- **Web** (`apps/web/src/lib/desktop.ts`, `components/desktopMenu.ts`): feature detection; Reveal / Open / Open in
  editor in the sidebar, Overview, file list, tree and diff header menus (#543); **Browse…** in the add form and a
  folder dropped on the window both open the add flow at that folder (#542); `data-desktop-platform` on `<html>`; the
  badge follows the unreviewed count (the title-count setting); menu commands through `onCommand`; an **Editor**
  setting (desktop only); `copyText` tries the bridge first, and `RequestView` copies through `copyAndReport` (#507).

## Verification

This WSL2 machine (Linux x64, Node 26, pnpm 12.16.1, Electron 45.3.2 installed from the local download cache, Chromium
libraries linked next to the binary for this machine only, DESKTOP §2; WSLg `DISPLAY=:0`). Final code:

| Command | Result |
|---|---|
| `pnpm check` (lint + credits check + typecheck + build + test) | **pass**, 1 min 49 s. Lint: 4 warnings + 1 info, all pre-existing (`apps/daemon/test/file-origins.real-git.test.ts`, `apps/web/test/cache.test.ts`); credits up to date (156 shipped, 19 dev tools). Tests: contracts 141 (was 138), forge 101 (+5 skipped), fixtures 59, **web 538 (was 512)**, git-core 556 (+1 skipped), daemon 610 (+4 skipped), e2e package 8, cli 174, **desktop 172 (+1 skipped; was 107)**, scripts 34 |
| `pnpm test:e2e --workers=1` | **110 passed** (3.2 min), the same suite as before; read-only proof 12 control repos, 0 violations |
| `pnpm --filter @octopus-diff/desktop run mutation-check` | **87 killed, 0 survived** (29 new bridge mutants; the unchanged tests pass first, a run without results counts as BROKEN and fails). The first run had 4 survivors: two real test gaps (the editor allowlist gate inside `ipc.ts`, a `missing` worktree whose path still exists) got tests; two equivalent mutants were dropped (#544) |
| `smoke-app.mjs` (the real app, unpackaged, WSLg) | all 5 scenarios pass, including the new bridge checks: shape and members, `data-desktop-platform`, the gesture gate, symlink / path-through-symlink / executable / `..` / bad editor / unknown id / missing file refusals, log lines with the reason and without paths or token. `--screenshot` also captured the macOS strip forced on Linux: 32 px strip, UI below it, nothing clipped |
| `run package -- --arch x64 --dir` + `check-fuses` | ok (7 s); fuses ok |
| `test:e2e:desktop` vs `release/linux-unpacked` (WSLg) | **4 passed** (8.5 s; the tamper test returns early on Linux by design, #529), with the new bridge block (packaged preload: shape, refusals) and the read-only proof |
| web spot mutations (by hand: removing each hook from FileList, Sidebar, DiffPane, Overview, App's badge / commands / platform hooks, the version check, the bridge copy, Browse…) | each made `apps/web/test/desktop.test.tsx` fail (10 of 10) |

## Decisions

DECISIONS #530-#545 (this session's range; nothing outside #530-#559 used). The main ones: the preload is ESM source
bundled to CJS (#531); refusals are values and logs carry reasons only (#533); the path check's exact rules (#534);
`openPath` refuses programs, beyond the plan (#535); the preload's user-gesture gate (#536); the editor is a web pref,
default VS Code (#537); the badge follows the existing title-count setting (#538); menu hooks keep phase A's scripts as
the fallback for older web builds (#539); the macOS drag region is a single top strip, nothing else (#541); Browse… and
drops lead to the existing add form instead of adding directly (#542).

## Contract changes

`packages/contracts/src/desktop.ts` (new, additive; commit `contracts: DesktopBridge type and the optional
window.octopusDesktop declaration`, #530). `installCli` / `cliStatus` are left to #21.

## Dependencies

None added or removed. `pnpm credits:check` passes (run inside `pnpm lint`). The Electron binary was installed
locally from `~/.cache/electron` for the smokes; nothing in the repository changed for that.

## Known gaps

- **Not verified on macOS or Windows** (no machine): the hidden inset title bar, the traffic lights' position and the
  strip under a real macOS window, the dock badge, Finder reveal, the `.app` refusal on a real bundle; the Windows
  taskbar overlay (and its BGRA byte order), Explorer reveal, NTFS path rules, editor URLs with drive letters. The CI
  `desktop` job runs the packaged spec (with its new bridge block and, on macOS, the strip height) there; it is the
  first real test.
- **Not driven anywhere**: a successful reveal / open / open-in-editor with a real editor installed (automated runs only
  exercise refusals: a success acts on the desktop; one smoke run here did reveal a file inside the worktree by a test
  mistake, now fixed, with no visible problem); real drag-and-drop from a file manager (`getPathForFile` and the drop
  handler are unit and jsdom tested); clicking the native menu items (routing is unit tested); the Linux launcher
  badge (Unity-style launchers only; none here).
- The tree layout's context menu (`FileTreeView`, rendered by `@pierre/trees`) gets the desktop items but has no web
  test (its menu does not render in jsdom); the same helper is tested through the other four menus.
- The menus pass no line to "Open in editor" yet (the bridge accepts `line`); a "go to this line" action in the diff is
  a follow-up.
- A Windows worktree on a UNC path cannot be opened in an editor (#534).

## Notes for integration

- **#21 (CLI shim) touches the same files.** Add `installCli` / `cliStatus` to `ipc-channels.ts`, `bridge.ts` and the
  contracts interface, and their handlers in a separate module merged into `createBridgeHandlers` (#532). The main.ts
  edits here are small and local: the preload path and platform in `windowOptions`, the `installBridge` call at the
  top of `main()`, `pageCommand()` for Settings/Refresh/Undo, and `screenUrl(…, { titleBarInset })` + `clearBadge()`
  in `showScreen`. The menu template (`menu.ts`) was not changed.
- The packaged spec's bridge block uses a new `userGesture` option of `PageSession.evaluate` (`cdp-pipe.ts`).
- `smoke-app.mjs` needs `DISPLAY=:0` on WSL and the Chromium libraries next to the Electron binary (DESKTOP §2).
