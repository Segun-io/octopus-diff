# desktop-phase0 report

Roadmap #16 (phase 0 of the desktop app, #15). Branch `t3/211e3d26`, 2026-11-13. Not pushed, no PR.

## Shipped

- **`docs/DESKTOP.md`**: the plan from issue #15 (copied faithfully), status "accepted 2026-11-13", Electron 45.3.2 / Node
  24.22.2 verified, §2 rewritten with the phase 0 results, the phase 0 row marked done, new §10 (roadmap decisions of
  2026-11-11, the asar answers for #19, the `ELECTRON_RUN_AS_NODE` environment contract).
- **`docs/PLAN.md`**: §2 Delivery row (Electron desktop app in scope, same model as T3 Code), header status line,
  §4.4 (desktop shell removed from the backlog), §6 Phase 3 (the desktop app no longer waits for the user; only phase E does).
- **`docs/DECISIONS.md`** #466-#475, heading "Desktop phase 0: Electron's Node (session, 2026-11-13; roadmap #16)".
- **One test-only fix** in `packages/git-core/test/helper.test.ts` (`RawHelper` sets `ELECTRON_RUN_AS_NODE=1` under Electron).
- **CI**: no change (Node 24 is already covered, DECISIONS #472).

## Verification

Setup (outside the repo, nothing added to any `package.json`): `npm install --prefix ~/.cache/octopus-diff-dev/electron electron@45 @electron/asar @electron/fuses`
→ Electron 45.3.2, `process.version` v24.22.2 under `ELECTRON_RUN_AS_NODE=1`. The extracted Chromium libraries were symlinked
into the electron directory (Electron's RPATH is `$ORIGIN`; `LD_LIBRARY_PATH` is lost by the git helper's empty
environment, DECISIONS #466; the watch host inherits `process.env`).

**Vitest under Electron's Node** (`cd <pkg> && ELECTRON_RUN_AS_NODE=1 electron <repo>/node_modules/vitest/vitest.mjs run`, no
`LD_LIBRARY_PATH`) against Node 26.13.0 (`node …/vitest.mjs run`), after the test fix:

| Suite | Electron (Node 24.22.2) | Node 26.13.0 |
|---|---|---|
| `apps/cli` | 11 files, 141 passed, 1.25 s | 141 passed, 1.47 s |
| `packages/forge` | 5 files + 1 skipped; 101 passed, 5 skipped, 1.1 s | the same, 0.9 s |
| `apps/daemon` | 59 files; 610 passed, 4 skipped, 26.4 s | the same, 26.2 s |
| `packages/git-core` | 38 files; 556 passed, 1 skipped, 58.1 s | the same, 53.5 s |

Failures found along the way, with causes (none left):

1. First run, `LD_LIBRARY_PATH` only: 30 failures in git-core (`helper.test.ts`, `supervisor.test.ts`), 2 in cli
   (`doctor.test.ts` "the real probe runs git --version through a helper process", `integration.test.ts` "serve with the real
   daemon …"). Cause: the helper starts `process.execPath` with an empty env, so `libnspr4.so` was not found
   (`error while loading shared libraries`); the runner then fell back to direct spawns / "failed to start". WSL machine setup,
   not code. Fixed by placing the libraries next to the binary.
2. Second run: 10 failures in `git-core/test/helper.test.ts` > "helper protocol: strict, never a shell" (frame never reached
   within 20 s, etc.). Cause: `RawHelper` spawned `process.execPath` with `env: {}`; under Electron that launches the app,
   not Node. Fixed in the test (3 lines); 43/43 in that file, then the full suite above.

`pnpm lint` (Biome: 4 warnings + 1 info, all in untouched files, none new; `credits:check` up to date), `pnpm --filter
@octopus-diff/git-core typecheck` and `… test` (556 passed, 1 skipped) after the edit. A full `pnpm typecheck` / `pnpm test` was not
re-run: only one git-core test file changed.

**Asar** (throwaway probe in `/tmp`, not committed; `pnpm build`, `pnpm --filter octopus-diff run pack:tarball` for the
staging tree, `npm install --omit=dev` for `@parcel/watcher`, `asar pack`): see DECISIONS #468-#470 and DESKTOP §10.
`serve` from `app.asar` with nothing unpacked: `/` 200, hashed JS (492 369 bytes) and CSS 200, diff, git helper, watch
host `watcher.mode: native`, live SSE after an edit, no helper left after SIGKILL. Same with `**/*.node` and `git-helper.js`
unpacked, and with the fuses flipped (`RunAsNode` on; `EnableNodeOptionsEnvironmentVariable`, `EnableNodeCliInspectArguments`
off; `OnlyLoadAppFromAsar` on). `doctor` from the asar: all ok. `node:sqlite` works.

**Bench** (one-off, not committed): DECISIONS #471.

| | Node 26.13.0 | Electron 45.3.2 (Node 24.22.2) |
|---|---|---|
| Direct spawn, main-thread busy per git process (0 / 100 MiB heap) | 1.11 / 1.14 ms | 1.69 / 1.54 ms |
| Through the helper (1 / 2 helpers) | 0.24 / 0.27 ms | 0.22 / 0.24 ms |
| 640 × status, wall, direct / 2 helpers | 708 / 519 ms | 1084 / 603 ms |
| Daemon startup, listening / all summaries (30 × 3) | 644 / 757 ms | 578 / 745 ms |
| Write → SSE p50 / p95 | 15 / 28 ms | 16 / 26 ms |
| Daemon RSS end (bench) | 173 MiB | 186 MiB |
| Empty process RSS | 42.5 MiB | 102.9 MiB |
| Serving daemon / helper / watch host: RSS | 94 / 55 / 54 MiB | 143 / 112 / 112 MiB |
| the same, private (Pss_Anon) | 39 / 12 / 11 MiB | 39 / 19 / 18 MiB |

## Decisions

All in DECISIONS #466-#475; the notable ones: the asar needs no `asarUnpack` of the CLI directory (#468); unpack
`@parcel/watcher*` and `git-helper.js` anyway (#469, a correction of the roadmap's "must be unpacked"); no CI change (#472);
`ELECTRON_RUN_AS_NODE` environment contract (#474).

## Contract changes

None.

## Dependencies

None added to the repo (Electron, `@electron/asar`, `@electron/fuses` live in `~/.cache/octopus-diff-dev/electron`).
`pnpm credits` was not needed (no `package.json` or lockfile change; `credits:check` passes).

## Known gaps

- `EnableEmbeddedAsarIntegrityValidation` could not be tested (macOS/Windows only).
- Only Linux x64 was run; macOS and Windows behaviour of Electron-as-Node, `@parcel/watcher` and the helper (not used on Windows)
  is for #19's CI matrix.
- The probe ran the CLI from an asar built from the tarball staging tree, not from an electron-builder package; what
  electron-builder unpacks by default is unchecked.
- The bench figures are from one run each on a busy WSL machine (other sessions share it); read them as ratios, not budgets.
- `docs/bench/results.*` were not regenerated, as instructed. Nothing was filed on GitHub (out of bounds).

## Notes for integration

- Merge order: the docs commits are independent of the one test commit.
- For #17: the CLI needs no change to run under Electron's Node. For #18: the supervisor must set `ELECTRON_RUN_AS_NODE=1`
  (the watch host inherits it); do not run the daemon in the main process. For #19: `asarUnpack` `node_modules/@parcel/watcher*/**` and
  `dist/git-helper.js`, test the integrity fuse on macOS/Windows, assert `watcher.mode: native` and a helper child in the Electron
  e2e smoke, plan for about +50 MiB PSS (Electron-as-Node helpers and watch host).
- On this WSL machine, link the Chromium libraries into the Electron directory instead of using `LD_LIBRARY_PATH`.
