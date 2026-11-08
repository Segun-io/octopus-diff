# ux-unslop-2 report (UX round 2, second pass, lead)

2026-11-08. Branch `ux/unslop-2` on top of `main` at `279e80a` (the first unslop pass). Brief: a second pass with the
three design skills installed for the session. Decisions #29–#39 in `docs/DECISIONS.md` ("UX round 2, second pass");
the rules now live in `docs/design/IDENTITY.md` §4–§7.

How the three skills were used:

- **Vercel Web Interface Guidelines** (`web-design-guidelines`): audited `apps/web/src`; the real findings and their
  fixes are listed below as `file:line`.
- **frontend-design**: the look was judged against its calibration list (tracked caps eyebrows, middle-dot meta strings,
  mono as a data costume, the SaaS card kit) and a compact plan was written first: palette unchanged; one type scale
  (11/12/13/14/20); facts set apart by space and weight, never punctuation; state as a word, not a dot; one control
  recipe each.
- **Hallmark** (`hallmark audit apps/web`, app scope, `sloplint --scope app`): before, 9 FAIL / 7 REFLEX / 6 WARN;
  after, **0 FAIL**, 2 REFLEX (both gate 64, mono: waived on the record), 3 WARN (two 49 "long clickable label" on
  two-line rows: dismissed; F24 hairline-plus-shadow: answered). Where its floor contradicted the shipped identity,
  each case was decided and logged (#29 caps labels: dropped; #31 middle dots: dropped for facts, one dot allowed in
  plain-text names; #32 status dots: dropped except the live pulse).

## Shipped

| Tell | Before | After |
|---|---|---|
| Tracked upper-case labels | `.od-heading` (caps, 0.04 em) on section labels, menu headings; 10 px caps table heads in Overview and Settings → Review; `GO TO` column in the palette; `SAVED ON THIS DEVICE` chip | `.od-label` and `.od-th`: 11 px, sentence case, untracked, weight and colour carry them (`styles.css:141`, `:289`; `Overview.tsx:233`, `:310`; `ReviewSection.tsx:76`; `CommandPalette.tsx:216`; `controls.tsx:101`; `ContextMenu.tsx:101`) |
| Eyebrow over the Overview heading | `PROJECT · ~/code`, `FOLDER` above the `h1` | Cut; the facts sit under the name as spaced spans (`Overview.tsx:186`, `:284`) |
| Middle-dot meta strings | `30 files · 5 worktrees`, `2 unreviewed · 2 files`, `depth 3 · scanned …`, `Review on · the default`, `dark · in slot`, `, opens · Esc closes`, `3 repos · 6 dirty`, `project · branch` in the diff header, palette and overrides table | Spans with a gap, or a comma inside a sentence; the worktree identity is a `WorktreeName` pair (project 500, branch muted; `bits.tsx:177`, `DiffPane.tsx:161`, `CommandPalette.tsx` `parts`, `policy.ts:45` `parts`). One dot survives only in plain text (`title`, `aria-label`, search strings) joining two name parts |
| Decorative status dots | Worktree dirty/clean dot, `●5` dirty counts on folders and projects and in Overview, the connection dot, the review-chip dot | Words: dirty rows in `fg`, clean rows muted with `clean`; `5 dirty`; Overview columns `With changes`/`Files` + `Lines`; `Live`/`Offline`/`Refreshing…`; `Review off`. `Dot` removed from `bits.tsx`. The activity pulse stays as the one live dot (`Sidebar.tsx:100`, `styles.css:301`) |
| Control soup | ~20 ad-hoc class strings: `rounded` (4 px) and `rounded-md` (6 px) buttons side by side, pressed toggles with an ink border, three chip styles, two pills, 10 px / 10.5 px text | `.od-btn` (+ primary / ghost / danger), `.od-input`, `.od-chip`, `.od-pill` in `@layer components` (`styles.css:169`–`:285`); pressed = `accentSoft` + `lineStrong`; `:active`; explicit disabled channels; nothing under 11 px |
| Placeholders as dashed cards | Binary / too-large / submodule notes in a dashed, bordered box | Plain text blocks on the canvas (`DiffPane.tsx:37`) |
| Copy | Straight apostrophes, em dashes in tooltips and scan messages, `1 files` | `’`, full stops, `1 file` |

Files: `apps/web/src/styles.css`, `components/{bits,Sidebar,Toolbar,FileList,Overview,CommandPalette,ContextMenu,
ReviewPolicyChip,Dialog,BulkReviewToast,MarkAllButton,AddProjectForm}.tsx`, `components/diff/DiffPane.tsx`,
`components/settings/{SettingsDialog,controls,FoldersSection,ReviewSection}.tsx`, `lib/policy.ts`, `App.tsx`,
`test/ux.test.tsx` (one selector), `docs/design/IDENTITY.md`, `docs/DECISIONS.md`, `docs/screenshots/*`.

Kept on purpose (#39): the mark, wordmark, palette, icons and all brand assets (nothing regenerated: colours unchanged);
the dense 24 px controls; mono for git's material; the sidebar's porcelain shorthand; "verified" vs "reviewed" wording
(pinned by the e2e suite).

## Vercel Web Interface Guidelines findings (fixed)

- `components/Overview.tsx:138` — table rows were `<tr onClick>` with no keyboard path; the first cell is now a real
  button (`RowLink`), the row click stays as a pointer convenience.
- `styles.css:339` — Tailwind `transition-*` and `animate-pulse` ignored `prefers-reduced-motion`; a global reduce rule
  now stops every transition and animation (the pulse already had its gate). `animate-pulse` on the connection dot is
  gone with the dot.
- `styles.css:105`, `:97` — no themed `::selection` / `caret-color`; added from the tokens.
- `styles.css:118`, `:137` — scroll areas and overlays lacked `overscroll-behavior: contain`.
- `components/Sidebar.tsx:396` — the filter's shortcut lived in the placeholder (`Filter worktrees  ( / )`); it is now a
  `kbd` hint inside the field plus `aria-keyshortcuts`, and the input has a `name` and `autocomplete="off"`.
- `components/AddProjectForm.tsx:72`, `:86` — inputs without `name`; the depth field without `inputmode`.
- `components/Toolbar.tsx:180`, `components/AddProjectForm.tsx:147` — em dashes in a tooltip and a status line.
- `components/settings/SettingsDialog.tsx:381`, `settings/ReviewSection.tsx:66`, `diff/DiffPane.tsx:375` — straight
  apostrophes in prose.
- `components/CommandPalette.tsx:186` — the palette input had `outline-none` with no focus replacement; its bottom
  hairline now strengthens on focus (it is the only focusable element and auto-focused).
- `components/FileList.tsx:254` — `1 files`.
- `styles.css:272`, `components/Sidebar.tsx:461` — counts without `tabular-nums` (pill, Inbox count, stats).
- `styles.css:218` — primary button disabled by opacity alone (also Hallmark 39a): explicit fill, ink and cursor.

Checked and already fine: icon buttons carry `aria-label`; selects and switches are labelled; dialogs trap focus, close
on Escape and restore focus; live regions on toasts and notices; lists are virtualized; `color-scheme` and
`theme-color` follow the theme; dates and numbers go through `Intl`; the native selects set background and colour.

## Verification (this worktree, Node 26.13.0)

| Command | Result |
|---|---|
| `pnpm lint` | `Checked 306 files … No fixes applied.` (0 errors, 0 warnings) |
| `pnpm check` | **exit 0**: lint; typecheck and build every package; tests contracts 71, git-core 126, web 96, fixtures 48, daemon 147, e2e (vitest) 5, cli 139; all passed |
| `pnpm test:e2e` | **68 passed (2.2 m)**; `read-only proof: 12 control repos, 3193 lock polls, 0 violation(s)` |
| `node …/hallmark/scripts/sloplint.mjs apps/web/src --scope app` | before: 9 FAIL, 7 REFLEX, 6 WARN · after: **0 FAIL**, 2 REFLEX (64, waived), 3 WARN (49 ×2 dismissed, F24 answered) |
| `pnpm --filter @octopus-diff/web shots` (mock server, 11 states × 3 themes × 2 sizes, `/tmp/shots-after*`) | inspected inbox, worktree, folder, project, settings (appearance, review), palette, context menu, policy menu, help in both brand themes and the contrast theme; found and fixed the lost worktree indent, the chip wording and the plural |
| `pnpm --filter @octopus-diff/e2e screenshots` (after `pnpm build`) | 8 README screenshots regenerated from the fixtures (`docs/screenshots/*`) |

Contrast: token values unchanged, so `test/theme.test.ts` (AA for every pair, achromatic brand accent) passes as before.
Pressed controls moved from an ink border to `accentSoft` + `lineStrong`; both are already in the tested pairs.

## Decisions

#29 no tracked caps · #30 no eyebrow · #31 facts by space, names as pairs, one-dot rule for plain text · #32 state is a
word, not a dot (pulse kept) · #33 one control recipe each · #34 11 px floor, one chip · #35 mono waived on the record ·
#36 overlays keep hairline + shadow · #37 Hallmark check stamp · #38 accessibility fixes · #39 not changed, on purpose.
All in `docs/DECISIONS.md` under "UX round 2, second pass".

## Contract changes

None.

## Known gaps

- Hallmark's app range wants 32–40 px controls with a 44 px hit target; the product stays at 24 px by the density
  decision in PLAN. Logged (#33), not hidden.
- The sidebar meta row (`↑1 ↓3 S1 M2 +15 −1`) is still a shorthand only the `title` explains; a legend or a long form is
  a product decision, not taken here.
- `docs/reports/ux-unslop.md` describes `Dot`, `.od-heading` and the ink-border toggle as shipped; it is historical and
  left as written.
- Not re-measured: the UI perf gate (no layout or DOM-size change; the components layer adds a few hundred bytes of CSS).

## Notes for integration

Pure `apps/web` + `docs` change; fast-forwards onto `main`. No theme token, preference, route, contract or
`data-testid` changed, so nothing migrates. The one test touched is the web unit test's Overview row selector (`td` →
`td button`), which follows the keyboard-reachable row. Anyone adding a control should use `.od-btn` / `.od-input` /
`.od-chip` and put semantic colour on top with a utility (the recipes live in `@layer components`, so utilities win).
