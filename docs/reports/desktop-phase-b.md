# desktop-phase-b report

Roadmap #19 (desktop phase B: packaging, part of #15), stream WS6. Branch `t3/481db03f`, 2026-11-13. Not pushed, no PR.
DECISIONS #508-#521.

## Shipped

- **Packaging** (`apps/desktop/scripts/package.mjs`, `apps/desktop/electron-builder.yml`):
  `pnpm --filter @octopus-diff/desktop run package [-- --arch x64,arm64] [--platform linux|mac|win] [--dir]` builds
  UNSIGNED installers into `apps/desktop/release/` (gitignored): Linux AppImage + deb, macOS dmg + zip, Windows NSIS,
  x64 and arm64. The app is staged per platform/arch in `.stage/` (gitignored) with a generated `package.json` whose
  only dependency is the lockfile's `@parcel/watcher`, installed with `npm --os --cpu [--libc]` so each build carries
  only its target's prebuilt (cross-arch builds work), then electron-builder runs there (#511).
- **Layout** (#508, #512): `resources/app.asar` = `package.json`, `dist/main.js`, `dist/cli/` (`index.js`,
  `git-helper.js`, `web/`; the same `bundle.mjs` output as the npm tarball, version embedded) and `node_modules/`
  (`@parcel/watcher`, its platform package, detect-libc, is-glob, is-extglob, picomatch). `app.asar.unpacked` holds
  exactly `node_modules/@parcel/watcher*` and `dist/cli/git-helper.js`. No source maps, no watcher C++ sources, no
  node-addon-api; `app.asar` is 20 MB. `scripts/build.mjs` builds a CommonJS preload once `src/preload.cts` exists
  (phase C).
- **Fuses** (#513): `RunAsNode` on; `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments`,
  `GrantFileProtocolExtraPrivileges` off; `EnableCookieEncryption`, `OnlyLoadAppFromAsar`,
  `EnableEmbeddedAsarIntegrityValidation` on, via electron-builder's `electronFuses`; macOS re-signed ad-hoc after the
  flip (`resetAdHocDarwinSignature`). `scripts/check-fuses.mjs <app>` (`run check-fuses`) asserts the wire and the
  embedded asar integrity data (Info.plist / Windows resource).
- **Packaged builds refuse dev switches** (#509): `parseDesktopArgs(argv, cwd, { isPackaged })` refuses `--dev`,
  `--backend source`, `--renderer-url`, `--remote-debugging-port`/`-address`, `--inspect*`, `--debug*` (any argv
  element, `-x`/`--x`, and `/x` case-insensitively on Windows), plus `app.commandLine.hasSwitch` in `main.ts`; exit 2.
  `--renderer-url` is loopback-only everywhere. `--remote-debugging-pipe` stays allowed.
- **Icons** (#515): `apps/web/scripts/icons.ts` (one additive section) writes `apps/desktop/resources/icon.png` (1024),
  `icon.icns`, `icon.ico`; the web icons regenerate byte-identical.
- **Packaged-app smoke** (`e2e/desktop/`, `e2e/playwright.desktop.config.ts`,
  `pnpm --filter @octopus-diff/e2e test:e2e:desktop`; app from `apps/desktop/release/<platform>-unpacked` or
  `OCTOPUS_DESKTOP_APP`): drives the window over `--remote-debugging-pipe` with a small CDP client (#510). Four tests:
  refused switches (exit 2, no DevTools/inspector line, nothing started); the main flow (temp state/config/app-data
  dirs and isolated git config; `status` and `add`/`add --scan` through the app's bundled CLI run as
  `ELECTRON_RUN_AS_NODE=1 <app> app.asar/dist/cli/index.js`; the window lists the added projects; `watcher.mode:
  native`; a `git-helper.js` child of the daemon with the asar path in its argv (POSIX; Windows has no helper by design);
  token gone from the URL, no Node globals, `window.open` denied, cross-origin navigation blocked and logged,
  notification and geolocation denied; every read path through the daemon with an agent simulator running; **the
  read-only proof** over the control repos (#519); quit by closing the window (SIGTERM on macOS) stops the daemon and
  removes `daemon.json`; the token is never in `daemon.log`); killing the app leaves no daemon; the asar tamper test
  (macOS/Windows must refuse to run; Linux recorded).
- **CI** (`.github/workflows/ci.yml`, new `desktop` job only; #518): ubuntu / macos (arm64) / windows (x64), Node 24:
  package x64 + arm64, `check-fuses` both arches, `codesign --verify --deep --strict` (macOS), install like a user
  (deb via apt with the default AppArmor userns restriction, then the extracted AppImage; the app copied from the
  dmg; the NSIS installer `/S /D=`), run `test:e2e:desktop` against each install, phase A's unpackaged smokes on Linux
  (fails if the Electron binary is missing), upload installers as workflow artifacts (7 days, not published),
  Playwright report on failure. Electron/electron-builder download caches in this job only.
- **Credits** (#517): `@octopus-diff/desktop` shipped; new `shippedRuntimes` option credits Electron (MIT) as shipped
  with a Chromium (BSD-3-Clause + components) and Node.js (MIT) note, without its downloader dependencies.
- **Docs**: DECISIONS #508-#521, `docs/DESKTOP.md` (status, §4 layout, §7 bundling/packaging/CI, §8, §10),
  `apps/desktop/README.md`.

## Verification

This WSL2 machine (Linux x64, Node 26.13.0, pnpm 12.16.1; Electron 45.3.2 = Node 24.22.2), Chromium libraries linked
next to the Electron binaries for this machine only (DESKTOP §2; the e2e helper does it outside CI). Final code:

| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | ok, 0 s (no Electron download) |
| `pnpm lint` | pass: Biome 627 files, 4 warnings + 1 info, all pre-existing (`apps/daemon/test/file-origins.real-git.test.ts`, `apps/web/test/cache.test.ts`); `credits:check` up to date (156 shipped, 19 dev tools) |
| `pnpm typecheck` | pass, all packages |
| `pnpm build` | pass |
| `pnpm test` | pass, 109 s: contracts 138, forge 101 (+5 skipped), fixtures 58, web 512, git-core 556 (+1 skipped), daemon 610 (+4 skipped), e2e package 8, cli 174, **desktop 107 (+1 skipped; was 85)**, scripts 34 |
| `pnpm test:e2e --workers=1` | **110 passed** (3.2 min), existing specs unchanged; read-only proof 12 control repos, 0 violations |
| `pnpm --filter @octopus-diff/desktop run mutation-check` | **58 killed, 0 survived** (12 new args mutants), 25 s |
| `run package -- --arch x64,arm64` (Linux) | ok, 37 s: 4 installers (sizes below) |
| `check-fuses` | ok on `linux-unpacked` and `linux-arm64-unpacked`; ok on a `win-unpacked` cross-built on Linux (fuses + integrity resource; NSIS itself needs wine here, not installed); fails as expected on a stock Electron binary |
| `test:e2e:desktop` vs `release/linux-unpacked` (WSLg) | **4 passed**, 9 s; read-only proof 12 repos, 0 violations; quit → app and daemon gone ~50 ms |
| `test:e2e:desktop` vs the AppImage extracted (`--appimage-extract`) | **4 passed**, 9 s |
| AppImage `--appimage-extract-and-run`, by hand (temp dirs) | the window's daemon started, `watcher.mode: native`, git 2.53 supported, helper and watch host under the daemon; SIGTERM to Electron stopped daemon then app (see Known gaps for the runtime) |
| Packaged binary, by hand | `--dev` / `--remote-debugging-port=9333` / `--inspect=0` → exit 2, no "DevTools listening" line; the watch host maps `watcher.node` from `app.asar.unpacked` (`/proc/<pid>/maps`); helper argv `…/app.asar/dist/cli/git-helper.js` |
| `smoke-backend.mjs` (unpackaged) | all scenarios pass, 4 s |
| `smoke-app.mjs` (unpackaged, WSLg) | 31 checks; 1 flake in 5 runs before #521, then 6 of 6 green |
| actionlint (npm `actionlint@2.0.6`, the wasm build, via a script in /tmp) | 0 problems (and it catches an injected matrix typo); shellcheck not available, so `run:` bodies are not shell-linted |

Installer sizes (Linux, this machine; the "~100 MB" estimate holds for the deb, the AppImage is larger):

| File | Bytes | MiB |
|---|---|---|
| `octopus-diff-0.0.0-linux-x86_64.AppImage` | 129 967 589 | 124 |
| `octopus-diff-0.0.0-linux-amd64.deb` | 104 257 860 | 99 |
| `octopus-diff-0.0.0-linux-arm64.AppImage` | 131 231 374 | 125 |
| `octopus-diff-0.0.0-linux-arm64.deb` | 98 892 980 | 94 |
| unpacked app (x64 / arm64) | | 294 / 298 |

**Verified only on Linux x64 here.** Not run: macOS (dmg, zip, ad-hoc signature, integrity enforcement), Windows
(NSIS build and install, integrity enforcement, `window.close()` quit, the CDP pipe on Windows, refusal exit codes),
any arm64 binary (built, fuses checked, `watcher.node` is aarch64; never executed). The CI `desktop` job is written
for them and is their first real test.

## Decisions

DECISIONS #508-#521. Notable: the bundle stays at `app.asar/dist/cli/` (#508); all of argv is checked in Chromium's
spellings, `--remote-debugging-pipe` stays allowed (#509); **Playwright's `_electron.launch` cannot drive the
packaged app** (it needs `--inspect=0 --remote-debugging-port=0`, which the fuse and #509 forbid), so the smoke uses
the DevTools pipe under Playwright Test (#510); a staged app per arch instead of packaging the pnpm package (#511);
macOS ad-hoc signature from the fuse step, `identity: null`, no hardened runtime (#513); the Linux binary is
`octopus-diff-desktop` so the deb never shadows the CLI's `octopus-diff` (#514); `shippedRuntimes` in the credits
(#517); the deb is tested under Ubuntu's AppArmor restriction, the AppImage with userns allowed, never `--no-sandbox`
(#518).

## Contract changes

None.

## Dependencies

`apps/desktop` devDependencies: `electron-builder` ^26.18.0, `@electron/fuses` ^1.8.0. `pnpm-workspace.yaml`:
`allowBuilds: electron-winstaller: false` (#516). `pnpm credits` run in the same commit; `credits:check` passes. No
license outside `allowedRuntimeLicenses`.

## Known gaps

- **macOS, Windows and arm64 unverified here** (above). Expect iteration on the first CI run, most likely in: the
  macOS ad-hoc signature + `codesign --verify --strict`, the NSIS silent install (`/S /D=` with the assisted
  installer), the CDP pipe and stderr of a GUI binary on Windows, and the tamper test's expectations (exit without
  running `main.js`).
- **Integrity on Linux**: Electron does not validate the asar there; the fuse is set but has no effect (recorded by
  the tamper test, not asserted).
- **AppImage sandbox**: electron-builder's AppImage `.desktop` entry runs `AppRun --no-sandbox`, and `AppRun` adds it
  when user namespaces are unavailable (Ubuntu 24.04 desktops without the deb's AppArmor profile). Launched otherwise
  the sandbox is on. Not changed (#520).
- **AppImage `--appimage-extract-and-run`**: SIGTERM to the runtime does not reach Electron; the app and its daemon keep
  running until the window is closed or Electron is signalled, and the extraction dir stays in /tmp (#520).
- **The packaged smoke is one spec, not the full 110-test suite** against the app; the full UI suite still runs
  against the browser build. The read-only proof against the app is the spec's own fixture set (12 repos).
- **The watcher's JS dependencies** in the app are resolved by npm at package time within their ranges, not pinned by
  `pnpm-lock.yaml` (#511).
- **No clean Linux VM run** (issue #19's "done when"): the AppImage was run extracted and with
  `--appimage-extract-and-run` on this WSL machine (with the user-local Chromium libraries) and CI runs it on a stock
  Ubuntu runner; the dmg's right-click → Open flow (Gatekeeper quarantine) cannot be automated in CI.
- Not shell-linted (no shellcheck). Signing, notarization, auto-update and naming stay phase E (#23).

## Notes for integration

- New CI job `desktop` (3 runners, ~45 min timeout); existing jobs unchanged and still never download Electron. The
  job uploads `desktop-linux`/`desktop-mac`/`desktop-win` artifacts (about 450 MB for Linux's four installers).
- `pnpm check` needs neither Electron nor a display. Packaging locally: `pnpm build`, then
  `pnpm --filter @octopus-diff/desktop run package` (first run downloads Electron zips and electron-builder tools into
  `~/.cache/electron` and `~/.cache/electron-builder`). The packaged smoke: `pnpm --filter @octopus-diff/e2e
  test:e2e:desktop` (WSL: `DISPLAY=:0`).
- For phase C (#20/#21): put the preload at `src/preload.cts` (built automatically to `dist/preload.cjs`); the CLI shim
  must run `<app executable> <resources>/app.asar/dist/cli/index.js` with `ELECTRON_RUN_AS_NODE=1` (that is what the
  smoke's `cli()` does); on Linux it must not collide with the deb's `/usr/bin/octopus-diff-desktop`.
- Phase E: `appId`, the deb maintainer and the artifact names are placeholders (#514).
