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

(none)

### WS5 — CLI, packaging, docs, CI

1. **2026-11-08 · WS5 · `pnpm install` exits 1: "Ignored build scripts: esbuild@0.28.2".**
   pnpm 12 fails the install when a dependency's build script is neither allowed nor denied.
   esbuild (via tsx / vite) is not listed in `allowBuilds`. Already the case on the base commit
   `db5274c`. *Impact:* the install itself completes and everything works, but the exit code breaks
   scripted installs and CI. *Workaround in place:* CI runs
   `pnpm install --frozen-lockfile --config.strict-dep-builds=false`; CONTRIBUTING documents it.
   *Proper fix (lead, root file):* add `esbuild: false` under `allowBuilds` in `pnpm-workspace.yaml`
   (its platform binary comes from `@esbuild/<platform>` optional dependencies; the postinstall only
   validates it). Then the CI flag can be dropped.

### Phase 2 — integration (lead)

(none)

## Resolved

(none yet)
