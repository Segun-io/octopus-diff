# ux-web report (UX round 1)

Branch `ux/web`, 21 commits on top of `ae48cb6` (`lead/ux-foundation`). Everything lives in
`apps/web/**` plus `docs/design/**` and this report. No edits to contracts, daemon, cli, git-core, e2e,
tools, DECISIONS/PLAN/BLOCKERS/COORDINATION. Three `wire:` commits touch the reserved files
(`apps/web/src/api/hooks.ts` one line; `apps/web/src/api/cache.ts` two small additive blocks); `main.tsx`
gained one import (`virtual:octopus-themes.css`) in the theming commit and nothing about credentials.

## Shipped

**P0**

1. **Identity** (`docs/design/IDENTITY.md`, `docs/design/assets/{mark,wordmark}.svg`,
   `apps/web/src/components/Mark.tsx`). Three directions rendered and compared at 16/32/64/512 px (gutter
   octopus, eight-arm ring, marker + lines); chosen: a round mantle with five unequal arms and slit eyes
   (a quiet `- -`), one colour, cut-outs instead of a second colour. Brand hue **ink violet**
   (`#5b47d6` light / `#9d90ff` dark) replacing the generic blue; system font stacks only; spacing,
   radius, elevation, motion, focus ring and density tokens defined in `styles.css`.
2. **Favicons and app icons** (`apps/web/public/`): adaptive `favicon.svg` (prefers-color-scheme),
   `favicon.ico` (16/32/48, PNG-in-ICO), `apple-touch-icon.png`, `icon-{192,512}.png`,
   `icon-maskable-{192,512}.png`, `site.webmanifest`, two `theme-color` metas (updated on theme switch).
   Generated reproducibly by `pnpm --filter @octopus-diff/web icons` (`scripts/icons.ts`, headless
   Chromium); outputs committed; contact sheet `docs/design/assets/contact-sheet.png` inspected (the
   first version had a CSS class collision that rendered both rows in the dark violet; fixed, re-inspected).
   `document.title` shows `(12) octopus-diff` (pref `titleCount`, default on). **P2 bonus:** the SVG
   favicon gets an amber dot while unreviewed changes exist (`lib/favicon.ts`, data: URL, CSP-safe).
3. **Theming, prepared** (`docs/design/THEMING.md`, `apps/web/src/theme/`): token names in one place
   (`tokens.ts`), themes as data (`themes/octopus-dark.ts`, `octopus-light.ts`, `octopus-contrast.ts`),
   registry + preference model `{ mode, light, dark }` with safe fallbacks (`registry.ts`), a Vite plugin
   that generates `virtual:octopus-themes.css` from the registry (`css.ts`, `vite-plugin.ts`),
   `applyTheme` (data-theme, `.dark`, color-scheme, theme-color), per-theme shiki theme for the diff
   viewer, and `public/theme-init.js` (external, pre-paint, CSP-safe). Prefs v2 with migration of the v1
   string theme (`state/prefs.ts`). Tests: every theme defines every token, ids unique, **AA contrast
   computed from token values** for every text/background pair in every theme (4.5:1 text, 3:1 UI),
   fallback, migration, generated CSS. Adding a theme is one file plus one line in `themes/index.ts`.
4. **Settings** (`,` / sidebar gear / palette; `components/settings/`, `settings/registry.ts`): six
   sections. General (default scope, auto-advance, review-off display dim/hide/show, title count,
   confirm-before-bulk, list/tree); Review (daemon default switch with the inheritance sentence, overrides
   table with Inherit; "shared by the daemon" / "saved on this device" labels); Appearance (mode, theme
   picker with one light and one dark slot, density, diff layout, whitespace, show reviewed); Folders
   (scan roots: rescan/remove with confirm, depth, counts; projects: source folder, default-branch
   override, remove; add forms); Keyboard (generated from the command registry); About (daemon
   version, API version, git, watcher mode + warnings, uptime, settings API availability). Settings,
   palette and Overview are lazy chunks. New API hooks live in `api/settings.ts` and `api/bulk.ts`.
5. **Mark all as verified** (`lib/bulk.ts` pure planner, `state/bulk.ts`, `MarkAllButton.tsx`,
   `BulkReviewToast.tsx`): file-list header button (`markAllButton` with `data-target`/`data-count`;
   worktree: "Mark N visible as verified" through `paths` after the filters and "show reviewed"; Inbox:
   one `all` request when nothing is filtered, otherwise one request per visible worktree with `paths`),
   sidebar context menus (worktree / project / folder, also "mark all unreviewed"), Overview buttons,
   palette, `Shift+R`. Sends `expectedStateHashes` from the cached summaries. Toast with Undo (button and
   Ctrl/Cmd+Z while visible), says what was skipped ("2 skipped: review off", "1 changed meanwhile").
   Optional confirm dialog when more than one worktree is touched. `review.bulk` and `settings.changed`
   handled in `cache.ts` (wire commits).
6. **Review policy UI**: `reviewPolicyChip` (on/off + source) opening `reviewPolicyMenu` with
   `reviewPolicyItem`s for worktree / branch / project / folder × On / Off / Inherit, the deciding level
   marked; `reviewOffBadge` in the sidebar (with `data-source`); the same On/Off/Inherit in sidebar
   context menus and in the Overview; Settings → Review lists every override. Disabled worktrees: no
   review toggle, no unreviewed badges or counts, `n` skips them, bulk skips them, the Inbox dims or hides
   them (pref). **F2 fixed**: `r` keys the mutation on the diff on screen (the diff query's `patchHash`
   and `reviewed`), falling back to the list entry only while the diff is loading.
7. **Mock parity** (`apps/web/mock/`): `/api/settings` GET/PATCH, `/api/review-policy`,
   `/api/review/bulk`, `/api/review/undo`, plus `PATCH /api/projects/:id` and
   `POST /api/scan-roots/:id/rescan` (needed by Settings → Folders); `review` attached to projects and
   inbox entries via the contract resolver; `onlyUnreviewed` omits disabled worktrees; no-op PATCH/PUT
   keeps the revision and emits nothing; overrides ordered folder, project, branch, worktree, key; stale
   checked before files, `skippedDisabled` only for worktrees that had files; undo TTL/limit; override
   cleanup on project / scan-root removal. Demo dataset now has a scan root (`~/code`), two overrides and
   a Trojan Source file.

**P1**

8. **Sidebar hierarchy** `Inbox → Folders → Projects → Worktrees` with an "Added directly" group;
   collapsible (persisted in prefs); folder and project rows aggregate repos / dirty / unreviewed and have
   the same context menu (right-click or the `⋯` button); worktree rows show main vs linked, a **source
   chip** inferred from the path (`t3`, `claude`, `codex`, `conductor`, `cursor`; presentation only),
   branch, ahead/behind, counts, review-off badge, and an **activity pulse** for ~10 s after
   `summary.updatedAt` (no reserved-file edits: derived from the projects response with a 2 s tick while
   anything is recent).
9. **View registry** (`views/registry.ts`): `ViewDefinition { id, label, icon, appliesTo(selection) }`;
   `View` is now `inbox | folder | project | worktree`; `Changes` for Inbox/worktrees, **Overview** for
   folders/projects (stats, members table, bulk buttons, policy control, rescan). No tabs are shown
   because exactly one view applies today.
10. **Command palette** (Ctrl/Cmd+K, `commandPalette*`): fuzzy (`lib/fuzzy.ts`), lists Inbox / folders /
    projects / worktrees, every non-hidden registry command, Settings sections, themes, mark all;
    keyboard-only usable (combobox + listbox roles).
11. **First-run and empty states** with the mark; "Watch a folder" is the first form, "add one
    repository" second; loading skeleton instead of a sentence; density-aware rows; consistent focus ring
    (`--od-focus`); `prefers-reduced-motion` disables every animation.

**Extra scope from the lead** (after P1): **F9** (the "changed on disk" tracking is keyed by file +
scope and ignores placeholder data), **F10** (in the tree layout `j`/`k`/`n` follow the tree's order:
folders first, dot-items first, case-insensitive; `compareTreeOrder`), **SEC-05** (bidi controls,
zero-width and invisible characters in file names and patches are rendered as `⟨U+202E⟩` escapes, the
file row gets a ⚠ with `data-suspicious`, and the diff pane shows a banner listing the code points;
`lib/unicode.ts`). Also `docs/design/FOLDERS.md` (vision, views, shell impact, daemon prerequisites and
security model; design only).

Design review screenshots (three themes, 1440×900 and 960×700, Inbox, worktree, folder overview,
palette, settings) are in `docs/design/assets/screens/`; `scripts/shots.ts` regenerates them against
`preview:mock`.

## Verification

Run on 2026-11-08 at the repo root (Node 26.13.0, pnpm 12.16.1), on the final commit:

| Command | Result |
|---|---|
| `pnpm check` (lint + typecheck + build + test, every package) | exit 0. Biome: no errors. Tests: contracts 71, git-core 98, **web 75** (9 files; was 37), daemon 84, cli 108, fixtures 48, all passed. |
| `pnpm test:e2e` (suite `01`–`08` against the daemon in this worktree, which has **no** settings/bulk routes) | **36 passed (1.2 min)**; read-only proof: 12 control repos, 1655 lock polls, 0 violations. |
| `pnpm --filter @octopus-diff/web test` | 75 passed: mock routes incl. settings/policy/bulk/undo semantics, theme AA contrast + registry + migration, prefs v1→v2, settings screen, theme picker, older-daemon degradation, bulk (worktree with paths, Inbox `all`, Ctrl+Z, confirm, filters), policy chip/menu/badges/`n` skipping, F2, folder tier/collapse/source chips, Overview routing, palette, context menus, F9, F10, SEC-05, favicon dot, fuzzy, planBulk, unicode. |
| `scripts/csp-check.ts` against the production build | no CSP violations; 4 highlight workers from `/assets/worker-*.js`; 12 highlighted spans; console errors: none (external `theme-init.js` and the data: favicon are within the same CSP). |
| `scripts/browser-check.ts` against the production build | all steps pass; live edit of the open file reflected after 120 ms with the banner, selection kept, diff `scrollTop` 120 → 120; "console errors/warnings: none". |

Web perf (`pnpm --filter @octopus-diff/web perf`, production build, large dataset 30 × 200 files,
1440×900), before (docs/reports/web.md) → now:

| Measure | Before | Now |
|---|---|---|
| FCP / app ready | 68 ms / 348 ms; 0 long tasks | 64–68 ms / 359 ms; 0 long tasks |
| `j` × 200 (keydown → second frame) | p50 33.3 / p95 34.0 ms; 1 long task 87 ms | p50 33.3 / p95 34.0–34.4 ms; 0–1 long task (82 ms, first diff chunk) |
| Scroll the whole inbox list (261 frames) | p50 16.7 / p95 17.0 / max 19.1 ms; 0 > 50 ms; 49 rows mounted | p50 16.7 / p95 16.9–17.5 / max 19.1–20.9 ms; 0 > 50 ms; 48 rows |
| `J` through 30 worktrees | p50 34 / p95 37 ms | p50 34 / p95 36 ms; 0 long tasks |
| Live refresh in the Inbox ×10 | p50 362 / p95 366 ms | p50 363–364 / p95 369–372 ms; 0 long tasks |
| Page errors | 0 | 0 |

Within the previous budget (two runs; the variation is run-to-run noise).

Bundle (production): initial JS = `index` 302 KB (92.6 KB gz) + shared `settings` chunk 160 KB
(46.4 KB gz, modulepreloaded: contracts/zod, react-query, shared by index and the lazy chunks) + runtime
9 KB = **~471 KB raw / ~142 KB gz** (before: 416 KB / 125 KB gz, one chunk); CSS 27 KB (6.5 KB gz, was
19 / 5). The +17 KB gz is the new always-present UI (folder sidebar, context menus, toast, chip, bulk
planner, theme data, command registry). Lazy: `SettingsDialog` 17.8 KB (5.5 gz), `CommandPalette` 5.5 KB
(2.4 gz), `Overview` 9.4 KB (2.5 gz), diff renderer 335 KB (86 gz), tree view 244 KB (70 gz) unchanged.

Not run: ux-daemon's new e2e specs 09/10 (they live on `ux/daemon`; the lead extends them after the
merge). The UI was developed and tested against the mock, which mirrors the daemon report's shapes and
the lead's parity notes (a)–(f); it has not been exercised against the real `ux/daemon` build.

## Decisions

All 2026-11-08, ux-web.

1. **Mark: mantle + five arms + slit eyes, not "arms as diff lines".** The literal concept read as a
   ghost/skull at favicon size; the chosen glyph is the only one that read as an octopus at 16 px. The
   diff story stays in the unequal arms and the `- -` eyes. (IDENTITY.md §1)
2. **Brand hue ink violet** (`#5b47d6` / `#9d90ff`): furthest from add/del/mod/danger, keeps its blue
   component for red-green colour-blind users, and has an octopus story (ink). Replaces `#3d63dd`.
3. **`faint` text is also AA** (≥ 4.5:1 on every surface) rather than treating it as decorative:
   paths and hints are read, not decoration. The test enforces it for every theme.
4. **Themes compile to CSS at build time via a Vite plugin** (virtual module) instead of runtime
   `style.setProperty`: the declarations are in the main stylesheet before the first paint, so the
   pre-paint script only has to set `data-theme`. Runtime application still sets `.dark` for Tailwind.
5. **Theme preference keeps one light and one dark slot**; the picker fills a slot and switches mode;
   `t`/toggle flips mode only. Unknown ids and kind mismatches fall back to the brand theme of the slot.
6. **Prefs v2 in the same storage key** (`octopus-diff:prefs`, `version: 2`), migrating v1 in place;
   `theme-init.js` understands both shapes so no flash during migration.
7. **Inbox "mark all" respects filters by sending per-worktree `paths` requests** when any sidebar
   filter or "show reviewed" is active, and one `all` request otherwise. Several undo tokens are then
   undone together. The alternative (always `all`) would mark files the user had filtered away.
8. **Confirm-before-bulk defaults on and only triggers for more than one worktree**; undo is always
   available, so the dialog exists for the Inbox-wide case only.
9. **Review-off worktrees in the Inbox are dimmed by default** (pref `dim | hide | show`): still
   visible (diff first), visibly out of the loop.
10. **F2 fix reads the diff query cache** keyed exactly like the pane's query (file, scope, whitespace,
    context, full) so `r` marks the patch on screen; the list entry is only the fallback while loading.
11. **Activity pulse derives from `summary.updatedAt`** (projects response) with a 2 s tick, instead of
    recording `worktree.changed` events in `hooks.ts` (reserved). Presentation only.
12. **Source chip is path-pattern only** (`.t3/worktrees`, `.claude/worktrees`, `.codex`, `conductor`,
    `.cursor/worktrees`); no agent integration, no config.
13. **The sidebar gear is the only `settingsOpenButton`** (moved out of the toolbar): one element per
    test id; the toolbar keeps theme/help.
14. **Overview replaces the three-pane layout for folder/project selections** (two panes: sidebar +
    overview); the file list and diff pane are not rendered there. Selecting a worktree row returns to
    `Changes`.
15. **Mock `rescan` and `updateProject` added** so Settings → Folders is fully exercisable; both exist
    in the contract already.
16. **SEC-05: escapes are applied to the patch text passed to the renderer** (`⟨U+XXXX⟩`), not only in a
    banner: the deception must be impossible to miss in the code itself. `patchHash` is untouched (it is
    the daemon's). File names are escaped in the list and the pane header; `data-suspicious` marks rows.
17. **F10 implemented as a pure comparator** (`compareTreeOrder`) applied to the worktree's file order
    when the layout is `tree`, instead of passing a comparator into `@pierre/trees`: the list, `j`/`k`,
    `n` and the tree then agree by construction.
18. **No new dependencies.** ICO writing, contrast maths, fuzzy matching and the context menu are
    small hand-written modules.

## Contract requests

None required. Two small suggestions for the lead (not blocking; the UI works without them):

1. `TEST_IDS`: consider adding `diffUnicodeWarning: 'diff-unicode-warning'` (used as a literal
   `data-testid` today for SEC-05) and `contextMenu: 'context-menu'` so Playwright can target them
   through the contract.
2. `WorktreeSummary` already carries `updatedAt`, which the activity pulse uses. If the daemon ever
   stops bumping it on every state change, a dedicated `lastChangedAt` would be needed.

## Known gaps

- **Not tested against the real `ux/daemon` build**; parity is by the report's shapes and the lead's
  notes. The merged tree's e2e (09/10 + UI assertions) is the real proof.
- **Keyboard rebinding** (P2) not done: Settings → Keyboard is read-only ("rebinding is a later round").
- **Initial JS grew ~17 KB gz** (see Verification). If the lead wants it back under 125 KB gz, the next
  candidates are the sidebar context-menu/toast code (lazy on first use) and the Tailwind utilities for
  the Overview (already lazy as JS, not as CSS).
- **Vite dev server may show one unstyled frame** (CSS arrives via JS modules); production is
  flash-free (`theme-init.js` + CSS in `<head>`). Verified by eye in screenshots, not by an automated
  first-frame test.
- **Activity pulse depends on `summary.updatedAt` semantics** (see contract request 2) and on the 2 s
  tick; it is not exercised by a unit test beyond `isRecentlyActive`.
- **Tree view rows** still carry no `TEST_IDS` (shadow DOM); F10 is tested through the store's
  selection order, not through tree rows.
- **Middle-ellipsis** exists as a helper and CSS class (`od-path`) and is applied to paths in the
  Overview and sidebar titles; file-list rows still use the earlier dir/base truncation.
- Bidi detection covers the SEC-05 list plus zero-width/joiner/BOM/soft hyphen; confusable Unicode
  look-alikes (homoglyphs) are out of scope.
- `pnpm install` still prints the pre-existing `Ignored build scripts: esbuild` notice.

## Notes for integration

- **Merge hot spots** (all `wire:` commits, additive): `apps/web/src/api/hooks.ts` (`useResolvedTheme`
  reads `s.theme.mode`), `apps/web/src/api/cache.ts` (`EventEffects.settings`, `review.bulk` and
  `settings.changed` cases, `worktreeIdsOfProjects`, `['settings']` invalidation in `flushEffects`).
  `main.tsx`: one added import line (`virtual:octopus-themes.css`), nothing else; auth v2's token
  bootstrap can be added around it.
- **`useResolvedTheme` is still exported and used** (Toolbar, FileTreeView, commands); the richer
  `useTheme()` (`src/theme/useTheme.ts`) returns the full definition. If auth v2 rewrites `hooks.ts`,
  keep both exports.
- **Vite config** gained `octopusThemesPlugin()`; `src/vite-env.d.ts` declares the virtual module.
  Tests import nothing virtual.
- **Daemon static serving**: `public/` now ships `theme-init.js`, `favicon.svg`, `favicon.ico`, PNG
  icons and `site.webmanifest` at `/`; all are plain files (serve `.webmanifest` as
  `application/manifest+json` if the static server has a type map; `.js` as `text/javascript`). The CSP
  in DECISIONS WS3 #14 is unchanged and verified.
- **Settings API detection**: the UI treats 404/405 on `GET /api/settings` as "unsupported" and hides
  policy/bulk controls; everything else keeps working (proved by e2e 01–08 on the old daemon).
- **Events**: `settings.changed` with a revision ≤ the cached one is ignored (lead note (c)); `review.bulk`
  invalidates the inbox plus files/diffs/commits of the listed projects' worktrees.
- **Bulk requests from the UI**: `scope` is the current scope (commit scope is mapped to `working`);
  `expectedStateHashes` always sent when known; `paths` only with `worktree` targets.
- **Demo mock changes** (for anyone with e2e/mock expectations): a scan root `~/code` with three
  projects, two overrides (project `legacy-tool` off, branch `web-dashboard · agent/codex-123` off),
  `web-dashboard main` has two extra files (`src/lib/access.ts` Trojan Source content,
  `src/lib/a‮evil.txt`): Inbox total 30 files.
- **Scripts**: `pnpm --filter @octopus-diff/web icons` (regenerate icons + contact sheet) and
  `… shots` (design screenshots; `STATES`, `ONLY`, `OUT`, `BASE_URL` env). Both need the Chromium
  library path from AGENTS.md (handled in the scripts).
- **Reports**: design docs in `docs/design/` (IDENTITY, THEMING, FOLDERS) are the source for the
  DECISIONS entries above.
