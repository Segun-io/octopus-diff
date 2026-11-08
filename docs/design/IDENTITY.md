# octopus-diff identity

> UX round 1, stream ux-web, 2026-11-08; revised by the two unslop passes the same day (DECISIONS "UX round 2"
> and "UX round 2, second pass"). Source files: `docs/design/assets/mark.svg`,
> `docs/design/assets/wordmark.svg`, `apps/web/public/favicon.svg`, `apps/web/src/components/Mark.tsx`,
> token values in `apps/web/src/theme/themes/*.ts`, non-colour tokens in `apps/web/src/styles.css`.

octopus-diff is a calm, precise instrument for supervising many agents' work. Nothing in the UI should ask
for attention it has not earned: the diff is the picture, everything else is the frame. The identity has to
work at 16 px in a browser tab next to twenty other tabs, in one colour, in light and dark, and it must
never be confused with the semantic colours of a diff (added, deleted, modified, warning, danger).

## 1. Directions explored

Rendered at 256/64/32/16 px on dark and compared side by side (`/tmp` contact sheets; the final one is
`docs/design/assets/contact-sheet.png`).

| | Direction | Idea | Verdict |
|---|---|---|---|
| A | **Gutter octopus** | A dome head over rows of rounded bars of different lengths: arms as diff lines, left/right columns as a split view. | Strongest concept on paper. In practice the flat-bottomed dome reads as a *ghost* (Pac-Man) at every size, and the bars read as a skull's teeth at 16 px. Rejected. |
| B | **Eight-arm ring** | Eight short strokes radiating from a disc: "eight arms, one view", the `o` of octopus. | Clean and geometric, but indistinguishable from a loading spinner or a sun icon. Carries no octopus and no diff. Rejected. |
| C | **Marker + lines** | Head placed left like a gutter marker, diff lines to the right, faint lines above as "other worktrees". | Too many elements; muddy at 32 px, noise at 16 px. Rejected. |
| D/E | **Mantle with five arms** (chosen) | A round mantle (not a dome) with five curved arms of unequal length hanging below; eyes cut out as two short horizontal slits. | Reads as an octopus at 16 px unaided (the only candidate that did). The slit eyes make it calm and focused rather than cute, and they are a quiet `- -`: the first thing a diff shows. One colour, cut-outs instead of a second colour, so it works on any background and as a mask icon. |

Why not the literal "arms as diff lines" concept? It is the stronger *story* but the weaker *glyph*: at
favicon size the bars lose their meaning and the head loses its species. The chosen mark keeps the story in
the arms' unequal lengths (five arms, no two alike, like the lines of a hunk) and in the eyes.

## 2. The mark

- Geometry on a 32-unit grid: mantle `M16 3 C22 3 26 7.5 26 13.5 C26 16.5 24.5 18.5 22.5 19.5 L9.5 19.5 C7.5 18.5 6 16.5 6 13.5 C6 7.5 10 3 16 3 Z`; five arms as 2.6-unit round-capped strokes; eyes as two `4.4 × 1.8` rounded slits cut out with a mask.
- One colour only, always, and that colour is ink. Default fills: `#1a1d26` on light, `#e4e7ee` on dark (the `fg` tokens; the favicon switches with `prefers-color-scheme`). In the UI the mark uses `currentColor` and is coloured with the `accent` token, which is ink in the brand themes.
- Clear space: 1/8 of the mark's width on every side. Minimum size 12 px (the eyes vanish below 14 px, which is fine: the silhouette carries it).
- Never add a second colour, a gradient, a face, more arms or a shadow. Never rotate it.
- App icon (maskable): the mark at 62 % of the canvas, centred, on a solid `canvas`-coloured square (`#0b0d14`); the maskable variant keeps the mark inside the 80 % safe zone.

## 3. The wordmark

`octopus-diff`, always lower case, always hyphenated (it is a command). Set in the system sans at semibold
with tight tracking, and `-diff` in the monospace stack at regular weight and the `muted` colour: the name of
a product and the name of a CLI in one word. The mark sits left at the x-height-plus-ascender height with a
gap of half the mark's width. `Wordmark` in `Mark.tsx` is the only implementation; `assets/wordmark.svg`
mirrors it with system font stacks (CSP forbids remote fonts, so there is no custom face anywhere).

## 4. Colour

### Ink, not a hue

**The frame is achromatic.** In the brand themes the `accent` token is ink: the `fg` colour itself (`#1a1d26` on
light, `#e4e7ee` on dark). Every hue on screen then means something: green added, red deleted, amber modified or
in progress, red danger, and the syntax colours inside the diff. Nothing in the frame competes with the picture.

This replaced the first identity's violet (`#5b47d6` / `#9d90ff`, same day, 2026-11-08; see DECISIONS "UX round 2").
Violet had a story (ink, distance from the semantic hues), but it is also the default hue of nearly every generated
dashboard and chat product of the last two years, and it made the tool read as produced from a template rather than
for a job. Ink is harder to mistake and truer to the name: a black octopus on paper, a white one on black, a stamp.
It also keeps what violet was chosen for: maximal distance from every semantic hue for every kind of colour vision,
and AA contrast on every surface without a per-theme search.

| Role | Light | Dark | Contrast |
|---|---|---|---|
| Brand / `accent` | `#1a1d26` | `#e4e7ee` | ≥ 12:1 on every surface |
| `focus` ring | `#1a1d26` | `#f0f2f7` | ≥ 3:1 on every surface (in fact ≥ 12:1) |
| `accentSoft` (active choice background) | `#dfe2ea` | `#282d39` | text tokens ≥ 4.5:1 on it |
| `selected` (row / item selection) | `#e3e6ed` | `#242936` | text tokens ≥ 4.5:1 on it |

Selection and hover are two steps of one neutral ramp (hover the lighter). A pressed or chosen control (a toggle, a
policy choice, the active theme card) is `accentSoft` with a `lineStrong` border: never an ink outline, so a selection
is never louder than the diff. The unreviewed count is a filled ink pill with inverted text: the only filled shape and
the only pill in the frame, so it needs no hue to be found. Primary buttons are the other ink fill, one per dialog. Third-party themes may carry a hue in `accent` (the test only requires contrast); the two brand themes are ink by
decision, and `test/theme.test.ts` checks that they stay achromatic.

Colour is never the only signal: added/deleted lines keep their `+`/`−`, statuses keep their letter, review
state keeps the check mark, review-off keeps its badge text, focus keeps its ring.

### Full palette (both brand themes; the high-contrast theme is in `octopus-contrast.ts`)

| Token | Octopus Light | Octopus Dark | Used for |
|---|---|---|---|
| `canvas` | `#f4f5f9` | `#0b0d14` | page background, diff background |
| `surface` | `#ffffff` | `#10131b` | panes (sidebar, file list, toolbar) |
| `raised` | `#eceef4` | `#171b25` | headers, chips, kbd, badges |
| `overlay` | `#ffffff` | `#1d222e` | dialogs, menus, palette |
| `line` | `#d8dbe4` | `#262b38` | hairlines |
| `lineStrong` | `#b9bec9` | `#363c4c` | borders of controls, focused inputs |
| `fg` | `#1a1d26` | `#e4e7ee` | primary text |
| `muted` | `#555c6c` | `#a4abba` | secondary text |
| `faint` | `#5d6576` | `#8e96a6` | tertiary text (paths, hints); still ≥ 4.6:1 |
| `accent` / `accentFg` | `#1a1d26` / `#ffffff` | `#e4e7ee` / `#0b0d14` | brand, primary buttons, unreviewed badge (ink: see above) |
| `add` / `addSoft` | `#136b2f` / `#e3f5e8` | `#5ccb7f` / `#12301d` | additions, reviewed |
| `del` / `delSoft` | `#b91f25` / `#fbe5e5` | `#ff8a80` / `#3a1b1b` | deletions |
| `mod` | `#7d5200` | `#e0ae52` | modified, in-progress operations |
| `warn` | `#7d5200` | `#e0ae52` | warnings |
| `danger` | `#b91f25` | `#ff8a80` | errors, conflicts |

Every text token on every surface token (including `selected`, `hover`, `accentSoft`, `addSoft`, `delSoft`
where that text appears) meets WCAG AA 4.5:1; `accent`/`focus` against every surface meets 3:1 (in fact
≥ 5:1). This is enforced by `apps/web/test/theme.test.ts`, which computes the ratios from the token values of
every registered theme, so a new theme cannot ship below AA.

## 5. Typography

System stacks only (CSP: no remote fonts, nothing to download, nothing to flash):

- Sans: `ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif`. One scale: 11 px captions, chips, labels and table heads; 12 px controls and dense text; 13 px body (13.5 comfortable); 14 px dialog titles; 20 px figures. Nothing under 11 px.
- Mono: `ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace`. Paths, branches, hashes, counts, keys and the diff itself (12 px / 19 px line height). Mono is for git's own material, never a costume for a label. Numbers use `tabular-nums` wherever they line up.
- Weight is the hierarchy, not size: 600 for the thing you are looking at (file name, project), 500 for the first part of a pair, 400 for everything else. No 700. No italics except detached HEAD.
- **No tracked capitals, anywhere.** Section labels (`.od-label`), table heads (`.od-th`), the palette's kind column and the "where it lives" chip are the body face at 11 px, sentence case, untracked; weight and colour carry them. The upper-case eyebrow was the loudest thing in the frame after the diff and said nothing the heading did not.
- **No eyebrow.** A heading stands alone; a kind word above it ("Project", "Folder") is cut, and the facts go below it.
- Never transform user data. Project, branch, folder and file names keep their case and their font.
- **Facts are set apart by space, never by punctuation.** `30 files` and `5 worktrees` are two spans with a gap, not `30 files · 5 worktrees`; a sentence uses a comma. A worktree's two-part name (project, then branch) is set as two spans, the project one weight heavier, the branch in `muted` (`WorktreeName` in `bits.tsx`, `parts` in the palette and the overrides table). The one place a middle dot survives is plain text that cannot carry weight (a `title`, an `aria-label`, a search string), joining exactly two name parts and nothing else.

## 6. Spacing, radius, elevation, motion, focus, density

Shared by all themes; defined once in `apps/web/src/styles.css` as `--od-*` custom properties.

- **Spacing**: a 4 px scale (`--od-space-1` 4 px … `--od-space-6` 24 px). Rows are 26 px (compact) / 30 px (comfortable); group headers 30 px.
- **Radius**: `--od-radius-sm` 4 px (chips, kbd, rows), `--od-radius-md` 6 px (buttons, inputs, menus), `--od-radius-lg` 10 px (dialogs, the palette). Nothing is a pill except the unreviewed count badge (`.od-pill`).
- **Controls**: one recipe each, defined once in `styles.css` under `@layer components` so a utility on the element still wins. `.od-btn` (24 px, `line` border, `surface` fill, `muted` text; hover `hover`/`fg`; `:active` `selected`; `aria-pressed`/`aria-checked` = `accentSoft` + `lineStrong`; disabled `faint` text, default cursor), with `od-btn-primary` (ink fill, explicit disabled fill and ink, never opacity alone), `od-btn-ghost` (no border) and `od-btn-danger`. `.od-input` (24 px, `canvas` fill, `line` border; the focus ring is the global outline, never a border change). `.od-chip` (16 px, `raised` fill, no border, 11 px) for `main`, a worktree source, an in-progress operation, `review off`, and "where a setting lives". Rows in Overview tables are reachable by keyboard: the first cell is a real button; the row only adds a pointer convenience.
- **Elevation**: three levels. 0 = flat with a hairline (panes); 1 = `raised` background plus hairline (headers, chips); 2 = `overlay` background, `lineStrong` border and `--od-shadow-2` (`0 8px 24px rgb(0 0 0 / 0.35)` dark, `0 8px 24px rgb(20 23 38 / 0.14)` light) for dialogs, menus and the palette. No other shadows.
- **Motion**: `--od-motion-fast` 120 ms and `--od-motion` 180 ms, `ease-out`. Used for fade/slide-in of menus, toasts and dialogs and for the activity pulse. Everything is wrapped in `@media (prefers-reduced-motion: no-preference)`, and a global `prefers-reduced-motion: reduce` rule also switches off Tailwind's transition utilities: with reduced motion there is no animation at all, only state changes.
- **Focus ring**: 2 px solid `focus`, 1 px offset, on `:focus-visible` only, instant. Inside dark surfaces the ring colour is lighter than the accent so it keeps 3:1 against `selected`. Text selection is `accentSoft`; the caret is `fg`.
- **Icons**: one stroke set on a 16-unit grid, 1.5 px stroke, round caps, `currentColor`, drawn in `components/bits.tsx` (close, more, sun, moon, warning, check) plus `Mark`. Never a font glyph for a control (☾ ✕ ⋯ ⚠ render as emoji or in a different weight depending on the platform). Arrows inside data (`↑2 ↓1`, `old → new`) are text in the mono face.
- **State is a word, not a dot.** No status dots: a dirty worktree is `fg` and shows its counts, a clean one is `muted` and says `clean`; a folder says `5 dirty`; the connection says `Live`, `Offline` or `Refreshing…`; the review chip says `Review off`. Colour-only dots broke the product's own rule that colour is never the only signal. The one dot left is the activity pulse (`.od-pulse`): a live state, shown for ten seconds after a worktree changes, with a static dot under reduced motion.
- **No boxes for numbers.** Summary figures are set as a definition list (number over label, hairlines above and below), never as a grid of tiles.
- **Density**: `data-density="compact" | "comfortable"` on the root (a per-device preference). It changes only `--od-row` (26 / 30 px), `--od-pad-x` (8 / 10 px) and the base font size (13 / 13.5 px). Compact is the default: the product is for people who have thirty worktrees open.

## 7. Voice

Short, declarative, lower case product name, no exclamation marks, no mascots talking. Typographic apostrophes
(`daemon’s`), `…` for an ellipsis, no em dashes in the interface (a full stop or a colon instead), arrows only as
data (`a → b`, `Settings → Review` as a path). Empty states say
what to do next ("Watch a folder", "Add a repository"), toasts say what happened and offer undo, errors say
what to run. The mark may appear in empty states and About; it never animates except the first-run
"nothing here yet" state, where the arms may settle once.
