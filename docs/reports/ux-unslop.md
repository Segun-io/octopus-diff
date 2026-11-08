# ux-unslop report (UX round 2, lead)

2026-11-08. Branch `ux/unslop` on top of `main` at `28fddc8`. Brief from the user: "unslop the design and identity
when applicable". Decisions #23–#28 in `docs/DECISIONS.md`; the rules are now part of `docs/design/IDENTITY.md`.

## Shipped

What read as "generated from a template" and what replaced it. No behaviour, route or contract changed.

| Tell | Before | After |
|---|---|---|
| Brand hue | Violet accent (`#5b47d6` / `#9d90ff`): pills, selection, focus, mark, favicon, app icons | **Ink.** `accent`, `focus`, `accentSoft`, `selected` are neutral in both brand themes; the mark and every icon are black on paper / white on black; the diff is the only source of colour (IDENTITY.md §4) |
| Font glyphs as controls | ☾ ☀ (theme), ✕ (close), ⋯ (more), ⚠ (warning), ● (dirty / checked) | Six stroke icons in `components/bits.tsx` (16-grid, 1.5 px, `currentColor`) and a CSS `Dot`; arrows in data stay text |
| Transformed user data | Project names upper-cased and tracked in the sidebar; folder label and branch names upper-cased in Overview and menu headings | Names keep their case; the heading style is for section labels only (IDENTITY.md §5) |
| Dashboard tiles | Overview stats as a grid of bordered cards with a big number | A definition list between two hairlines: number over label, +/− in their semantic colours |
| Elevation drift | `Dialog` with `shadow-2xl`, the notice with `shadow-lg` | Both use `.od-overlay` like every other floating surface |
| Copy | "Inbox zero: …", tooltips naming `@pierre/trees` and `src/theme/themes/` | "No dirty worktrees in this scope."; implementation details removed; theme descriptions describe the ink |

Files: `apps/web/src/theme/themes/*.ts`, `components/{bits,Toolbar,Dialog,BulkReviewToast,Sidebar,FileList,ContextMenu,
Overview}.tsx`, `components/diff/DiffPane.tsx`, `components/settings/SettingsDialog.tsx`, `App.tsx`, `lib/favicon.ts`,
`scripts/{icons,shots}.ts`, `test/theme.test.ts`; `public/` icons regenerated; `docs/design/{IDENTITY.md,assets/*}`;
`docs/screenshots/*` regenerated from the fixtures.

Kept on purpose: the mark (one colour, reads at 16 px), the wordmark (`-diff` in mono), system font stacks, the 4 px
scale and the three radii, the amber favicon dot (semantic: unreviewed changes exist), `↑2 ↓1` and `a → b` as text.

## Verification (this worktree, Node 26.13.0)

| Command | Result |
|---|---|
| `pnpm lint:fix` then `pnpm check` | lint `Checked 306 files … No fixes applied`; typecheck and build every package; tests contracts 71, git-core 126, web 96 (+1: brand themes stay achromatic), fixtures 48, daemon 147, e2e (vitest) 5, cli 139; all passed |
| `pnpm test:e2e` | **68 passed (2.2 m)**; `read-only proof: 12 control repos, 3190 lock polls, 0 violation(s)` |
| `pnpm --filter @octopus-diff/web icons` | favicon.ico, apple-touch-icon, 192/512 and maskable icons, contact sheet regenerated |
| `pnpm --filter @octopus-diff/e2e screenshots` | 8 README screenshots regenerated |
| `pnpm --filter @octopus-diff/web shots` (mock server, Overview / Settings / menus, both themes, two sizes) | inspected; found and fixed the two remaining upper-cased names (Overview folder label, menu heading branch name) |

Contrast: every text/background pair still meets AA; `accent`/`focus` are ≥ 12:1 on every surface (was ≥ 5:1).

## Decisions

#23 ink instead of violet · #24 no font glyphs as controls · #25 no case transform on names · #26 figures as a definition
list · #27 one overlay elevation · #28 copy. All in `docs/DECISIONS.md` under "UX round 2".

## Contract changes

None.

## Known gaps

- The dark theme's neutrals keep their blue cast (canvas `#0b0d14`); the achromatic test allows a channel spread of 24 for
  that reason. A truly neutral "ink on black" would also need a matching shiki theme; not done.
- `docs/reports/ux-web.md` and `ux-round-1.md` still describe the violet; they are historical and were left as written.
- Not re-measured: the UI perf gate (no layout or DOM-size change in this pass; the icon SVGs are inline and tiny).

## Notes for integration

Pure `apps/web` + `docs` change; fast-forwards onto `main`. Existing v2 preferences need no migration (theme ids unchanged).
Anyone who runs `pnpm --filter @octopus-diff/web icons` again gets byte-identical output (deterministic headless Chromium).
