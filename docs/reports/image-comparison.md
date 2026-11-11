# Image comparison report

## Shipped
PNG, JPEG, GIF, WebP and BMP previews in the diff pane, with before/after,
overlay opacity and difference blend modes. New and deleted images show the
available side. Dimensions and file sizes appear in the side-by-side view.
`packages/git-core/src/images.ts` reads blobs identified by the scope's raw diff
and bounded working files; `apps/web/src/components/diff/ImageDiff.tsx` renders
embedded raster data. Unsupported binaries keep their existing placeholder.

## Verification
- `pnpm lint`: passed, including credits check.
- `pnpm typecheck`: passed across all packages.
- `pnpm build`: passed; Vite retains its existing large-chunk warning.
- `pnpm -r --workspace-concurrency=1 run test` plus `pnpm test:scripts`:
  1,025 passed, 6 skipped, run sequentially to avoid macOS contention. Run outside the
  sandbox because macOS fixture creation and local servers require it.
- New targeted tests: 5 git-core and 3 web tests passed.
- `pnpm test:e2e --grep documentation`: initially blocked by missing Playwright
  Chromium. Repeated using a temporary Playwright config pointing to installed
  Google Chrome: 1 passed (40.9 s), read-only proof over 12 control repositories,
  219 lock polls, zero violations. The full browser suite was not run.

Validation was repeated during PR preparation using Node 26 and the pinned
pnpm 12.16.1 after a successful frozen lockfile installation. The first PR
validation run hit the existing 5 s timeout in the fixtures read-only harness
while Chrome was also running. A complete sequential rerun without the browser
load passed: 1,025 tests passed and 6 skipped.

## Decisions
Logged in docs/DECISIONS.md: additive previews on the existing selected-file diff
response, raster signatures, 10 MiB per side, no additional endpoint or dependency.

## Contract changes
Optional `GitFileDiff.images` with nullable before/after raster previews and an
optional warning. Existing fields and meanings remain unchanged.

## Dependencies
No new dependencies. PR preparation restored the pnpm 12 lockfile format and
resolved compatible development tooling updates; see docs/DECISIONS.md. Both
generated credit outputs were regenerated with `pnpm credits`.

## Known gaps
SVG and other unsupported binaries retain the placeholder. Images above 10 MiB
show a warning. Difference mode uses browser difference compositing, aligns the
images at the top left and is a visual comparison rather than a numeric pixel score.

## Notes for integration
Daemon already spreads the git-core response, and its CSP permits data images.
The installed CLI must be rebuilt, repackaged and restarted; reload the app after
restarting. Pre-existing working tree edits were preserved.

## CI regression follow-up (2026-11-11)

The full Linux browser run exposed an outdated assertion in `03-scopes.spec.ts`:
`assets/logo.png` was still expected to show the binary placeholder. Update the
assertion to require the comparison controls and both decoded image versions.
The kitchen-sink PNG fixture contained only a PNG signature and random bytes;
replace its prefix with a complete 1 × 1 PNG while retaining deterministic
padding for binary changes.

Follow-up validation:
- `pnpm lint` and `pnpm typecheck`: passed.
- `pnpm --filter @octopus-diff/fixtures build`: passed.
- `pnpm --filter @octopus-diff/fixtures test`: 47 passed, 1 skipped (31.84 s).
- Playwright `03-scopes.spec.ts 15-images.spec.ts`, using the installed Chrome
  configuration: 8 passed (33.4 s). The previously failing test passed; read-only
  proof: 12 control repositories, 842 lock polls, zero violations.
- The full browser suite was not repeated locally for this follow-up; CI will
  run it again after the commit is pushed.
