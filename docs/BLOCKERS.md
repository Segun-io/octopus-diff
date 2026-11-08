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

(none)

### WS2 — daemon

(none)

### WS3 — web

(none)

### WS4 — fixtures, e2e, perf

1. **2026-11-08 · WS4 · e2e, bench and screenshots can't run end to end on the WS4 branch.**
   `@octopus-diff/daemon`, `@octopus-diff/git-core` and the web UI are Phase 0 placeholders here.
   *Impact:* `pnpm test:e2e` fails fast in global setup with one message naming the placeholder daemon
   and UI (by design); the bench and screenshot scripts fail the same way. *Workaround:* none needed;
   they are written against the contracts and run once the lead merges WS1–WS3 and runs `pnpm build`.
2. **2026-11-08 · WS4 · `pnpm install` exits 1 on this checkout** with `ERR_PNPM_IGNORED_BUILDS`
   (`esbuild@0.28.2`, pulled in by tsx/vite). Everything still installs and links, and `pnpm run`
   continues after a warning, but CI and scripts that check the exit code will fail. *Needs the lead*
   (root config is not WS4's): add `esbuild: false` to `allowBuilds` in `pnpm-workspace.yaml` (its
   postinstall only verifies the platform binary that the optional dependency already provides).

### WS5 — CLI, packaging, docs, CI

(none)

### Phase 2 — integration (lead)

(none)

## Resolved

(none yet)
