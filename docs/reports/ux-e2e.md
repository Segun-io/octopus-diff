# ux-e2e report — UI-level e2e on the merged tree (UX round 1)

Branch `ux/e2e` (from `12f039c`, lead/ux-foundation = main + ux/daemon + ux/web). First time the new UI
ran against the real daemon in a browser. Owner paths touched: new files under `e2e/tests/` and
`e2e/support/`, minimal seam fixes in `apps/web/**` (each its own `fix(web):` commit), this report.
Not touched: contracts, daemon, cli, git-core, `main.tsx`, `hooks.ts`, the reserved daemon files, docs
other than this file.

## Shipped

Three Playwright specs (13 tests) against the built UI (`apps/web/dist`) and an in-process daemon per
test, plus two helpers:

| File | What |
|---|---|
| `e2e/support/ui.ts` | `UiPage` page object for the round-1 controls (`markAllButton`, toast + undo, `reviewPolicyChip`/menu/items, `reviewOffBadge`, settings dialog/sections/default switch, theme picker, context menus, confirm dialog), the extended `test` with a **console/CSP guard** fixture (auto): records console errors/warnings, page errors and `securitypolicyviolation` events (with source location) and fails the test unless a pattern was explicitly allowed; `FIRST_RENDER_PROBE` (init script that records `data-theme`/`.dark` the moment React mounts). |
| `e2e/support/repos.ts` | Throw-away git repositories/worktrees created during a test under the fixture root with the manifest's isolated git env (for "review on by default for new things"). |
| `e2e/tests/11-ui-bulk-review.spec.ts` (5) | Worktree "Mark N visible as verified" honouring "show reviewed" (only visible files marked; undo from the toast); Inbox with a sidebar text filter → per-worktree `paths` requests, confirm dialog, Ctrl+Z; Inbox-wide via `Shift+R` with the confirm dialog (Escape cancels), `document.title` `(N) octopus-diff` ↔ `octopus-diff`, Ctrl+Z restores; project via the sidebar context menu, folder via its Overview button, "Mark all as unreviewed"; **stale**: the inbox/projects refetches are held with `page.route`, the live worktree is edited, the click sends the old `expectedStateHashes` → toast says "1 changed meanwhile", the daemon shows that worktree unmarked and the others marked. Every DOM assertion is paired with `reviewed` flags from the API. |
| `e2e/tests/12-ui-review-policy.spec.ts` (4) | Chip → worktree off: badge with `data-source`, review toggle replaced by "review off", unreviewed badge gone, title count excludes it, `onlyUnreviewed` omits it, `n` never lands in it; **stays off after a live update** in that worktree (the 12f039c class); Inherit restores. Precedence through the chip with `data-source` at every step (worktree > branch > project > folder > default; detached worktree has the branch items disabled; the default flipped in Settings). **On by default end to end**: a repo created with git and added through the sidebar form is `default`/on; pinned on via the chip; default flipped off in Settings → an existing non-overridden repo and a brand-new repo + linked worktree (git init / worktree add during the test, registered over the API) are off from `default`, the pinned one stays on; default back on follows immediately. Restart: overrides, default and revision persist and the UI reflects them (chip, settings switch, overrides table); a **second tab** follows Inherit and the default switch live through `settings.changed`. |
| `e2e/tests/13-ui-settings-themes.spec.ts` (4) | `,` opens Settings, six sections in order, ArrowDown cycles with focus, Esc closes; Review lists overrides and Inherit removes one (API agrees). Themes: `prefers-color-scheme` emulation drives system mode, picker sets `data-theme` + `.dark` + both `theme-color` metas, survives reload, `t` toggles; **no theme flash** (first-render probe equals the final theme, also after reload and with pre-seeded v1 prefs); **prefs v1 → v2** (string theme, `diffMode`, `showReviewed` honoured; storage rewritten as `version: 2`). Assets: `/favicon.svg`, `/favicon.ico`, `/apple-touch-icon.png`, `/icon-192.png`, `/icon-512.png`, maskable PNGs, `/site.webmanifest` (`application/manifest+json`, valid JSON with ≥ 2 icons that all resolve), `/theme-init.js` (`text/javascript`); `<link rel=icon>` ×2, apple-touch-icon, manifest, `theme-color` ×2; title count reacts to `r`; favicon gets the dot while unreviewed changes exist and the `titleCount` pref turns both off. |

## Verification

Final tree `9b83b5c`, Node v26.13.0, git 2.53.0, WSL2, 2026-11-08:

| Command | Result |
|---|---|
| `pnpm check` | **exit 0**. lint `Checked 290 files … No fixes applied.`; typecheck and build every package `Done`; tests: contracts 71, git-core 98, **web 84** (was 75), daemon 109, cli 108, fixtures 48, e2e (vitest) 5, all passed |
| `pnpm test:e2e` (specs 01–13) | **61 passed (2.2m)**; `read-only proof: 12 control repos, 3161 lock polls, 0 violation(s)` |
| New specs 11–13, three runs in a row | `13 passed (39.5s)`, `13 passed (39.7s)`, `13 passed (39.4s)`; no retries configured (`retries: 0`) |
| Console/CSP guard | zero console errors, zero warnings and zero CSP violations in every test of 11–13. One test (restart + second tab) allows `Failed to load resource` / `net::ERR_` / event-stream messages while the daemon is down; nothing else is allowed anywhere. |

The first run of the new specs against the merged tree failed 13/13; the failures are the defects below.

### Perf / regression gate (UX-8)

`pnpm --filter @octopus-diff/e2e bench` (30 repos × 3 worktrees, built daemon as a child process, UI in
Chromium), run twice in isolation on this tree, versus the baseline `docs/bench/results.json` (from `main`):

| Metric | baseline (main) | ux/e2e run 1 | ux/e2e run 2 | Δ |
|---|---|---|---|---|
| First paint, cold (`data-ready`) | 1018 ms | 974 ms | 929 ms | −4 % / −9 % |
| First contentful paint (cold) | 76 ms | 132 ms | — | +56 ms |
| **First paint, warm reload** | **67 ms** | **180 ms** | **177 ms** | **+165 %, flagged** |
| Idle CPU, daemon + git, avg 60 s | 0.38 % | 0.42 % | 0.42 % | +0.04 pt (noise) |
| Idle CPU, worst 1 s interval | 14.99 % | 4.00 % | 4.00 % | better |
| Refresh write → SSE p50 / p95 | 216 / 218 ms | 12 / 14 ms | 12 / 16 ms | better (perf review on `main`) |
| Refresh write → UI p50 / p95 | 296 / 298 ms | 29 / 40 ms | 29 / 34 ms | better |
| Daemon startup listening / all summaries | 1044 / 1103 ms | 645 / 1101 ms | 751 / 1261 ms | within noise |
| Daemon RSS after idle | 142 MiB | 129 MiB | 126 MiB | better |

Only the **warm reload** regressed by more than 20 % (+110 ms absolute; the cold target of 3 s passes with
a wide margin). I attributed it with a probe (not committed): on a warm reload every asset is served from
the browser cache (0 ms) and all API responses (`/api/projects` 82 KB, `/api/inbox` 189 KB, `/api/scan-roots`,
`/api/settings`) are complete by ~40 ms; `data-ready` arrives at ~105–140 ms. A CDP CPU profile of one warm
reload (125 ms sampled): ~59 ms renderer work outside JS (style/layout), ~35 ms in the app bundle, ~9 ms zod
parsing, ~6 ms react-query/contracts chunk, ~4 ms GC. The single hottest app frame (13.8 ms self time) is
`FileList.tsx` `update()` in the viewport `useLayoutEffect`, which reads `scrollTop`/`clientHeight` right after
commit and forces a synchronous layout of the whole page; that cost scales with the DOM the new sidebar adds
(90 worktree rows with folder tier, source chips, badges). The remaining JS is React commit work for the
larger tree. Candidate fixes (not applied; they touch perf-review and ux-web code, not a seam): measure the
list viewport from the ResizeObserver callback instead of synchronously in the layout effect, memoize
sidebar rows, render row details lazily. The web perf script against the mock (ux-web report) showed no
app-ready regression, so the delta is specific to the real payload sizes + sidebar DOM.

**Bundle (production, `pnpm build`)**: initial JS = `index` 304.67 KB (94.30 KB gz) + `zod` 93.81 KB (26.48 gz)
+ `settings` (shared: react-query, contracts) 66.26 KB (21.04 gz) + `jsx-runtime` 8.29 KB (3.15 gz) +
runtime 0.72 KB (0.42 gz) = **~474 KB raw / ~145.4 KB gz** (ux-web measured ~142 KB gz; main 125 KB gz).
The +0.7 KB gz over ux-web is the extra chunk boundary from pinning zod into its own chunk (defect 2);
CSS 27.01 KB (6.59 gz) unchanged.

## Defects found and fixed

All found by the new specs on the first run; each has a regression test.

1. **Escape stopped closing overlays once focus left them** (`fix(web)` `31ff991`, `98710ef`). Settings,
   the review-policy menu, the bulk confirm dialog and the generic `Dialog` (add project) handled Escape only
   on their own element. Clicking "Inherit" removes the focused row; the default switch, the On/Off/Inherit
   buttons and the add-project submit are `disabled` while the mutation runs; focus falls back to `<body>`,
   and the global shortcut handler defers to open dialogs, so Escape was dead (tests 7, 9, 10 and 8 of the
   first run). Fix: `src/lib/useEscape.ts` (`useEscapeToClose`, a capture-phase document listener while the
   overlay is open) used by all four. Tests: `apps/web/test/ux.test.tsx` "Escape closes overlays even when
   focus left them" (settings after Inherit, add-project dialog, policy menu).
2. **A `script-src` CSP violation on every page load** (`fix(web)` `55cefcd`, `a53c6c5`). zod v4 probes
   `Function('')` once (when the first object schema is built) to decide whether it may JIT-compile parsers;
   under `script-src 'self' 'wasm-unsafe-eval'` the probe throws (caught by zod, so nothing broke) but the
   browser reports a violation. ux-web's `csp-check` only watched console errors, which Chromium does not
   emit for this. Fix: `z.config({ jitless: true })` in `src/zod-config.ts`, imported first by `App.tsx`.
   The first attempt (`api/queries.ts`) ran too late: the contracts evaluate before any app module. Because
   Rollup only preserves module order within a chunk and the contracts live in a shared chunk that evaluates
   before `index`, `vite.config.ts` pins zod + the config into one `zod` chunk, which every chunk using zod
   (the contracts' included) evaluates first. zod became a direct dependency of `@octopus-diff/web` (already
   installed, same version 4.6.7, MIT; `pnpm add`, lockfile updated by pnpm, no hand edit). Tests:
   `apps/web/test/csp.test.ts` (imports the app, asserts `z.config().jitless` and zod's `allowsEval === false`);
   the e2e guard asserts zero violations in the real browser.
3. **Prefs v1 → v2 migration was never written back** (`fix(web)` `b8f80cf`). `loadPrefs` migrated in memory
   but storage kept the v1 document until the next pref change (test 12 of the first run). Fix:
   `storedPrefsAreCurrent()` + write-back in `createUiStore`; a current v2 document is left alone. Tests:
   `prefs.test.ts`, new `ui-store.test.ts`.

Verified, not changed: the 12f039c class (effective policy lost when the inbox is patched after a live
update) is covered by spec 12's live-update step and passes; the add-project dialog staying open after a
successful add ("Added fresh-a.") is by design (add several), the spec dismisses it with Escape (which is
defect 1).

## Known gaps

- **Warm reload +110 ms** (above). Flagged, attributed, not fixed: the fix belongs in `FileList`/sidebar
  rendering (perf-review and ux-web code), not a seam.
- **The zod chunk pin is a build-config workaround.** The right place for `z.config({ jitless: true })` is
  the contracts package itself (it owns zod and builds the schemas); see "Contract requests". Until then, any
  future module that imports zod outside the pinned chunk is still safe (the config runs when the zod chunk
  evaluates, which is always before any importer).
- The e2e preflight `webUiProblem()` (`e2e/support/env.ts`, not changed) requires `data-ready` and
  `worktree-item` in **one** bundle file. My first chunking attempt (a `contracts` chunk) moved the contracts'
  `TEST_IDS` out of `index` and the preflight refused to run; the final `zod`-only chunk keeps them together.
  A chunking change that splits them again will trip it (fix: check across all bundles).
- The console guard whitelists connection errors only in the restart test; the allowance pattern is
  printed in the test annotation. Nothing was needed elsewhere.
- Not covered by UI tests: the Overview's policy buttons, the `⋯` keyboard path to context menus (the
  specs right-click), the command palette's "mark all" and theme items, `reviewOffDisplay` dim/hide/show,
  auto-advance, confirm-before-bulk turned off.
- Bench numbers are from one machine (WSL2, Ryzen 7 7800X3D); two runs, no statistical treatment beyond
  the bench's own p50/p95.

## Notes for integration

- Run: `pnpm build && pnpm test:e2e`, or only the UI round-1 specs:
  `cd e2e && pnpm exec playwright test tests/11-ui-bulk-review.spec.ts tests/12-ui-review-policy.spec.ts tests/13-ui-settings-themes.spec.ts`.
  Bench with options: `cd e2e && pnpm exec tsx bench/bench.ts --out <dir>` (the `pnpm … bench -- --out`
  form passes the `--` through to `parseArgs`, which rejects it).
- New specs use the same `daemon` fixture (fresh daemon and state dir per test, all fixture projects
  registered) and `edits` (restores mutable-fixture files). Spec 12 creates repositories under
  `<fixture root>/ux-e2e-new-<timestamp>/`, removed with the fixture root at teardown.
- `support/ui.ts` exports `test`/`expect`; use `guard.allow(/pattern/)` for expected noise and
  `guard.watch(page2)` for extra tabs; `FIRST_RENDER_PROBE` goes into `page.addInitScript` before `goto`.
- **Contract request** (for the lead, additive): call `z.config({ jitless: true })` in
  `packages/contracts/src/index.ts` (or a dedicated module imported first). The contracts own zod and build the
  schemas; doing it there removes the web's direct zod dependency and the `manualChunks` pin, and protects any
  other browser consumer under the same CSP. Also worth adding to `TEST_IDS`: the sidebar context menu
  (`role=menu` named "Actions" today), the bulk confirm dialog (`role=alertdialog`), the add-project dialog
  root, and the Overview bulk/policy buttons.
- Fold into `docs/DECISIONS.md`: (1) overlays close on Escape via a document-level capture listener while
  open; (2) zod runs jitless in the browser (CSP), configured before the contracts evaluate, with the chunk
  pin as the interim mechanism; (3) migrated prefs are written back on load; (4) the warm-reload regression is
  accepted for this round and tracked.
