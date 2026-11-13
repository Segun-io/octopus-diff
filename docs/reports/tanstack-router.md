# tanstack-router report

Roadmap step 33, issue #50 (tracker #24), optional / lowest priority. Branch `t3/8efa0e47`, on `main` at `529f0e4`.
DECISIONS #459-#464. Nothing pushed, no PR.

## Shipped

The selected worktree, file and scope (and the tab, and the project/folder Overviews) round-trip through the address bar
with `@tanstack/react-router`. It did not fight the hash-token flow, so the feature was built (the stop condition did not apply).

- `apps/web/src/router.tsx`: one route `/`, code-defined, query parameters as plain strings (own `parseSearch` /
  `stringifySearch` / `validateSearch`). `App` creates the router (history overridable) and renders `AppShell` as its component.
- `apps/web/src/state/urlState.ts`: pure URL <-> state mapping (`stateOfSearch`, `searchOf`, `historyMode`); lenient, never throws.
- `apps/web/src/state/useUrlSync.ts`: store -> URL (push when the user moves to another worktree/tab/file, replace for the
  landing, the first file, scope changes and stale entries) and URL -> store (Back/Forward/edited URL via `commands.openView`).
- `App` starts the store from the URL when it names a view, so reload restores it and a copied URL opens the same
  worktree/file/scope; with no view in the URL the landing flow and the `lastWorktree` preference run unchanged.
- URL shape: `/?worktree=<id>[&tab=request][&file=<path>[&raw=<rawPath>]][&scope=<kind>[&base=][&sha=][&working=1]]`,
  `/?project=<id>`, `/?folder=<id>`.
- Token: `api/token.ts` is untouched and runs first; the router never reads the hash, only ever navigates with `search`
  (which drops a fragment), and keeps only its ten known keys (DECISIONS #460).

## Verification

Linux (WSL2), Node 26, run from the worktree.

- `pnpm lint`: pass (4 existing `useOptionalChain` warnings in `apps/web/test/cache.test.ts`, not from this work; `credits:check` up to date).
- `pnpm typecheck`: pass, every package.
- `pnpm build`: pass.
- `pnpm test`: all packages green: web 511 tests (38 files; new: `url-state.test.ts` 9, `url-state-app.test.tsx` 6), contracts 135,
  forge 101, fixtures 58, git-core 556, daemon 610, e2e unit 8, cli 141. No real-watcher daemon flake this run.
- `pnpm test:e2e --workers=1`: 110 passed (3.0 min), including the 4 new tests in `e2e/tests/21-url-state.spec.ts`
  (reload restore of worktree + file + scope, Back/Forward, deep link to a file with the token checked in requests / address /
  `history.state`, stale/invalid link falls back to landing). A first full run had 3 failures in `08-auth.spec.ts`
  (see Decisions); after the fix 08 + 21 were re-run, then the full suite again: 110 / 110.
- `pnpm --filter @octopus-diff/web run perf:smoke`: exit 0, 6/6 checks, both here and on a clean `main` worktree.
  Same dataset, one run each: FCP 96 vs 92 ms, ready 907 vs 904 ms, review data complete 1233 vs 1215 ms, J per press p50/p95
  33.3/34.7 vs 33.3/35.1 ms, worktree switch p50/p95 31/48 vs 30/32 ms (n = 7, so the p95 is one sample), no frames over 50 ms.
  No regression beyond run-to-run noise.
- **Bundle (web `vite build`, main chunk `index-*.js`):** 413.63 kB (128.78 kB gzip) on `main` -> 492.30 kB (155.79 kB gzip):
  **+78.7 kB raw, +27.0 kB gzip.** CSS unchanged (38.36 kB). Lazy chunks unchanged.

## Decisions

All in DECISIONS #459-#464. In short: query parameters on `/` (no daemon SPA-fallback change, not the hash); the token never reaches the router;
URL beats `lastWorktree` only when it names a view; stale ids fall back through the landing flow; history entries pushed
for moves and replaced for the landing, scope changes and dead entries; `Unlicense` (isbot, a router dependency) added to
`allowedRuntimeLicenses`.

One change outside the new files: the three address-bar assertions in `e2e/tests/08-auth.spec.ts` compared the whole URL to
`<daemon>/` after sign-in. The token handling they test is unchanged, but the app now writes `?worktree=…` into the URL, so they
assert origin + path `/`, empty hash, no token in the URL or query instead (`expectNoTokenInAddress`).
`apps/web/test/setup.ts` resets the jsdom URL after every test.

## Contract changes

None.

## Dependencies

`@tanstack/react-router` ^1.170.46 added to `apps/web` only. `pnpm credits` was run; `CREDITS.md`,
`apps/web/src/generated/credits.json`, `scripts/credits/acknowledgements.json` (Unlicense allowed) are in the same commit
as the dependency (`d4c9470`).

## Known gaps

- Bundle cost above (+27 kB gzip on first paint) for a feature with no performance value; the router is not lazy.
- Automatic selection changes that are not the landing (repair after a file disappears, auto-advance) add history entries; at this layer they look like clicks.
- A `commit` scope with a sha that does not exist in the worktree is applied as given (only its shape is validated); a link to a
  vanished commit shows the same error as selecting it any other way.
- `pnpm approve` reports "agent skills awaiting approval: @tanstack/react-router" on install; it is pnpm's note about skills shipped in the package and was not acted on.
- No e2e for the Overview (`?project=`/`?folder=`) URLs; they are covered by unit and jsdom tests only.

## Notes for integration

- `views/registry.ts` is unchanged: the URL carries the same `View` path the registry already selects on.
- The daemon serves `/` for any query, so deep links need no daemon change. Other paths are not routes: they render the app as well (`defaultNotFoundComponent`).
- To drop the feature: remove `router.tsx`, `useUrlSync.ts`, `urlState.ts`, the `RouterProvider` in `App`, the dependency (then `pnpm credits`), and restore the exact-URL checks in `08-auth.spec.ts`.
