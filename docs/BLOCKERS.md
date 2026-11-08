# Blockers

Things that are truly blocked or need the user. Format: date · who · blocker · impact · workaround.
Resolved items move to the bottom with the resolution.

## Open

1. **2026-11-08 · lead · Chromium system libraries need root to install.**
   Playwright's Chromium needs `libnss3`, `libnspr4` and `libasound2t64`; there is no passwordless sudo.
   *Impact:* none right now. *Workaround in place:* the libraries were extracted user-locally to
   `~/.cache/octopus-diff-dev/chromium-libs/` and `e2e/playwright.config.ts` adds them to
   `LD_LIBRARY_PATH` (see DECISIONS #19). *Proper fix (user):*
   `sudo apt install libnss3 libnspr4 libasound2t64` (or `sudo pnpm --filter @octopus-diff/e2e exec
   playwright install-deps chromium`), then delete `~/.cache/octopus-diff-dev/`.

### WS1 — git-core

1. **2026-11-08 · WS1 · `pnpm install` exits non-zero on a fresh worktree** with
   `ERR_PNPM_IGNORED_BUILDS: Ignored build scripts: esbuild@0.28.2` (pnpm 12 denies dependency
   build scripts by default; only `@parcel/watcher` is listed in `allowBuilds`). *Impact:* none
   for WS1 (all packages install; esbuild works through its prebuilt `@esbuild/linux-x64`
   binary), but CI's `pnpm install` step would fail. *Fix (lead/WS5, root config):* add
   `esbuild: false` (or `true`) under `allowBuilds` in `pnpm-workspace.yaml`. Not changed by WS1
   (root config is out of scope).

### WS2 — daemon

(none)

### WS3 — web

(none)

### WS4 — fixtures, e2e, perf

(none)

### WS5 — CLI, packaging, docs, CI

(none)

### Phase 2 — integration (lead)

(none)

## Resolved

(none yet)
