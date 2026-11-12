# web-sidebar-rows report

Roadmap #14 "Sidebar: redesign item layout, states and statuses" (step 16 of #24, milestone M3). `apps/web` only
(plus `docs/`). DECISIONS **#249-#256** (other open branches may use these numbers; the lead renumbers).

## Shipped

- **Two-line row** (`components/SidebarRow.tsx`, still one memoised `WorktreeItem`). Line 1: state indicator, branch
  (truncates, full name in `title`), `default` chip, status slot. Line 2: repository (glyph under the indicator, truncates
  at 72% of the line, full name in `title`), ahead / behind (only the non-zero side: `↑4`, not `↑4 ↓0`), files, the
  "N deleted" chip, the request chip, and the age of the last change at the far end. Line 2 wraps (the age never does),
  so a crowded row grows a third line instead of clipping a fact; the virtual list measures it (no height on the row).
- **Statuses rethought** (`rowIndicator`, `countLabel` in `lib/model.ts`): one kind per look (`missing`, `error`,
  `loading`, `conflicts`, `operation`, `merged`, `closed`, `reviewOff`, `review`, `changed`, `request`, `reviewed`,
  `clean`), each with a sentence. `data-indicator` on the row. "clean" is never a word; a reviewed worktree has a
  tick, a clean one a faint dot; both are marks, not text. The unreviewed pill is the **own** count (never merge
  noise), clamped at `99+` with the exact number in its tooltip (`1000 unreviewed`).
- **Indicator shapes** (colour is never the only signal): filled dot (unreviewed own files), ring (changes, review
  not computed), triangle (blocked: danger for conflicts, warn for a rebase / merge), cross in a circle (missing /
  error), request glyphs (open / merged / closed), dashed ring (review off), tick (reviewed), dots (loading), faint dot
  (clean).
- **Actions by state:** idle nothing extra; hover or keyboard focus inside the row fades the Hide / Show again button
  in over the end of line 2 (gradient in the row's own background, so the age and chips stay readable and nothing
  shifts); selected is a filled row; the context menu keeps `Hide until it changes` / `Show again`; blocked rows have
  no action. The action is a sibling of the row button, first in the tab order after it.
- **Recent change:** `RowAge` (`shortAge` in `lib/time.ts`, shared 30 s clock `lib/ticker.ts`): `now`, `7m`, `3h`, `2d`,
  `5w`, `8mo`, `2y`; inside two minutes it is accent-coloured with a static dot (`data-recent`). Nothing animates (PLAN
  §4.2 "no activity pulse"). The age is a leaf: the clock re-renders ages, never rows.
- **Accessible name** = the button's own content (no `aria-label`): branch, repository, facts with words (`2 ahead, 1
  behind`), and an `sr-only` status sentence (`row-status-text`: `9 unreviewed files to review`, `request merged`,
  `review off`, ...). The visual status slot, the age and the glyphs are `aria-hidden`.
- **Variants gallery:** `MOCK_DATASET=gallery` (22 worktrees covering every look, see DECISIONS #256) and
  `scripts/shots.ts` states `sidebar-gallery`, `sidebar-gallery-narrow` (200 px), `sidebar-gallery-states` (selected,
  focused, hovered) and `sidebar-gallery-hidden`, each a screenshot of the sidebar alone. How to run:
  `MOCK_DATASET=gallery MOCK_INTERVAL_MS=0 WEB_PORT=5391 pnpm --filter @octopus-diff/web dev:mock`, then
  `BASE_URL=http://127.0.0.1:5391 STATES=sidebar-gallery,sidebar-gallery-narrow pnpm --filter @octopus-diff/web shots`.
- **Chips:** `RowChips` gained `compact` (the sidebar's line 2 leaves out the source chip and the operation chip: the
  hover card and the context bar still show them; the status slot says the operation). The context bar is unchanged.
- **Docs:** DECISIONS #249-#256, PLAN §4.2 sidebar paragraph.

### What I saw (shots: `octopus-dark` and `octopus-light`, sidebar at 260 px and 200 px, gallery dataset)

Before (the #13 card, three lines): repo above the branch, then a chip line `t3  #184 ● 5 files +14 −8 ↑3 ↓0`. It was
tall (about 67 px per row), the facts clipped at the right edge (`+4736 −135` cut off, `↑4` truncated), the source chip
`t3` appeared on every worktree and carried no information there, `↑1 ↓0` repeated zeros, and 1000 files showed `997`
(a mock quirk, fixed) or a four-digit pill. The statuses were words only at the top right, so nothing separated
"reviewed", "clean" and "idle" visually (there was nothing).

First redesign: indicator + branch + pill on line 1, repo + facts + age on line 2 (about 49 px per row). It read
well at 260 px at once. Problems found in the pictures and fixed:

1. Every age said `4d`: the mock's clock is a fixed day; the gallery now computes ages from the real clock.
2. The age wrapped alone onto a third line (`fix/conflicts`): it is now its own non-wrapping column.
3. `↑1 ↓0` zeros: only the non-zero side is shown.
4. The repo truncated to `octopus-…` at 200 px with room to spare: 58% -> 72% of the line.
5. `changes requested` at 200 px squeezed the branch to `feat…`: a container query shows `changes` at narrow widths.
6. A conflict row said both the pill `5` and `5 files`: files are shown only when there is no pill.
7. A first Profiler-based render test was wrong (see Verification); fixed with a spy.

Final: at 260 px all 22 gallery rows are exactly two lines (about 49 px each, in both themes); at 200 px three rows wrap to a third line (long repository
plus ahead / behind plus files, or `main` with `default`), which reads fine and is the designed degradation. The tick
for reviewed and the dashed ring for review off are quiet enough to sit in a list of 20 rows without drawing the eye
away from the filled dots and the pills (the one filled shape of the frame). The conflicts triangle and the error cross
stand out without being loud, in both themes; in the light theme the warn triangle (rebase) and the red cross are
distinguishable by shape alone. Hover and focus: the action overlays the age cleanly; the focus ring on it is visible
in both themes.

Why this design: T3 Code's thread row is indicator + title + hover action with a secondary line; it is the proven
shape here too. I kept the pill and the conflict word at the right of line 1 (the thing to act on) and moved the
quiet facts to line 2, where the repository is the one label that has to stay. The age is new: with the flat list
ordered by activity, "how long ago" is what explains the order. I dropped `+a −d` and the source chip from the row (hover
card and context bar keep them) because on a 200-260 px column they cost more than they tell.

## Verification

Run from the repo root (Node 26):

- `pnpm lint`: **pass** (Biome 495 files; `credits: up to date`, no dependency change).
- `pnpm typecheck`: **pass** (all packages including `e2e`).
- `pnpm --filter @octopus-diff/web test`: **28 files, 394 tests pass** (before: 27 / 372): the new
  `test/sidebar-rows.test.tsx` (19 tests) plus the one `ux.test.tsx` assertion changed.
- `pnpm build`: **pass**.
- `pnpm test:e2e` (full, `workers: 1`): **99 passed, 0 failed** (3.0 min; read-only proof: 0 violations). The first run
  failed 1 spec (`12-ui-review-policy`: the helper `unreviewedBadge` selects `[title$=" unreviewed"]` and I had changed
  the pill tooltip to `N unreviewed file(s)`); I restored the tooltip format instead of editing the spec. No e2e spec
  or support file was changed.

### Tests (`test/sidebar-rows.test.tsx`, all mutation-checked)

Model: every status kind with its sentence (gallery fixture), loading and "changed" and that every kind is reachable,
blocked / missing / error priority, **merge noise never counted** (17 base files of 20 -> 3), `countLabel` clamp (0, 1,
9, 99, 100, 1000), `shortAge` boundaries. DOM: the two-line structure (branch only on line 1, repository only on
line 2, the sr-only sentence third, no row height), truncation (`truncate` class + full-name `title`, long branch and
long repository), the pill for 0 / 1 / 9 / 99 / 1000 (`99+`, tooltip `1000 unreviewed`, `data-unreviewed` 1000), no
"clean" / "reviewed" word, conflicts / rebase / merged / closed / review off / missing / error / changes requested
words, the "N deleted" chip on line 2 and `↑12 ↓134`, recent `now` vs `Nm`, accessible names (branch, repository,
status, every svg `aria-hidden`), keyboard reach of the Hide action (tab order, Enter hides, row moves to Hidden),
Show again on a hidden row, no action on a blocked row, selection, and memoisation (a row does not re-render when
another changes, counted with a spy on `rowIndicator`, which runs once per render: a React Profiler cannot be used, it
fires whenever its own element is re-created, which is what a parent render does).

Mutations applied, each failing the named tests, then reverted: remove `memo` (memo test), drop the `99+` clamp (2),
drop the `title` on the repo (1) and on the branch (1), action visible on hover only (keyboard test), a word for clean
rows (crashes 12), remove the sr-only sentence (2), `data-recent` always false (1), conflicts never `conflicts` (5),
reviewed collapsed into clean (3), `unreviewedFiles` instead of the own count (the merge-noise test).

## Decisions (also in docs/DECISIONS.md #249-#256)

Two lines and wrapping (#249), `rowIndicator` kinds and "clean is never a word" (#250), the clamp (#251), shapes
(#252), accessible name (#253), actions by state (#254), `now` without a pulse (#255), the gallery dataset and shots
(#256).

## Contract changes

None.

## Dependencies

None added or removed (`pnpm credits` not needed; `pnpm lint` confirms the credits are up to date).

## Known gaps

- Tab walks only the mounted rows (a window), unchanged from #13; the Hide action of every mounted row is a tab stop
  (two per row). A roving focus for the list is a follow-up.
- No touch affordance: a device without hover has the context menu (long press) but no visible Hide button.
- Ages are measured against the browser's clock, the row sort against `activityAt`: a skewed client clock shows odd
  ages. Not worse than the existing `relativeTime` uses.
- The `request` kind says nothing at the right of line 1 except `changes requested` / `changes`; the chip on line 2 and
  the glyph carry the rest. A review of whether an open request deserves a word is open.
- The gallery's 1000-file worktree makes the mock's `/api/projects` slower (about 40 ms): fine for a design aid.
- Screenshots are not committed (they are generated; see the commands above).

## Notes for integration

- `RowChips` gained an optional `compact` prop; `RepoIcon` in `SidebarRow.tsx` takes `size` (default 12, was 13). The
  new test ids are `row-branch`, `row-age`, `row-status-text`; `data-indicator` is new on the row. Nothing was renamed.
- `unreviewedBadge` (e2e) selects `[title$=" unreviewed"]`; the pill tooltip keeps that format.
- The hover card now headlines the indicator sentence (`no changes`, `reviewed`) instead of the old words.
- `SettledWord` / `settledWord` stay in `lib/model.ts` (tests use it) but the row no longer reads them.
- DECISIONS numbers 249-256 may collide with other open branches; the lead renumbers.
