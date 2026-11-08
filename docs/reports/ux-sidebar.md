# ux-sidebar report (UX round 3, lead)

2026-11-08. Branch `ux/sidebar-activity` on top of `main` at `4c3cde3`. Brief from the user: explore a new way of
showing the sidebar elements and project grouping, learn from T3 Chat's thread list and T3 Code's "settled" status,
and simplify review status without losing its core. Decisions #40–#46 in `docs/DECISIONS.md` ("UX round 3"); the
visual rules are in `docs/design/IDENTITY.md` §6; PLAN §4.2 item 1 and the README describe the result.

## What was learned

T3 Code's Sidebar V2 (`pingdotgg/t3code` PR #4026 and #4068, MIT; ideas only, no code copied) replaced a project-grouped
thread tree with one flat list: active threads as two-line cards, finished ones as slim rows under a "Settled" label,
"density is earned by settling", "blocked work never settles", "activity never reorders rows, only settling moves them",
project identity as chrome on the row rather than a container, a project filter instead of a tree, hover-only
settle/unsettle with a keyboard fallback. T3 Chat's thread list: one list, pinned items, hover-revealed actions,
grouped by day.

What maps onto octopus-diff: the worktree is the thread, and the review loop is already a settle mechanism. A worktree
with unreviewed files wants attention; one whose files are all verified is settled; the next patch un-settles it by
construction (patch-hash keyed marks). So the sidebar did not need a new stored state, only a partition. What does not
map: recency. `WorktreeSummary.updatedAt` is when the summary was computed (the poll), not when the worktree changed, so
neither T3 Chat's day groups nor T3 Code's creation-time order would be honest here; rows keep a static project and
worktree order, which T3 Code itself arrived at ("activity never reorders rows").

## Shipped

| Before (UX round 1) | After |
|---|---|
| Inbox → Folders → Projects → Worktrees tree, every level expanded, every worktree a two-line row | Inbox → **To review** (cards) → **Settled** (one-line rows, collapsible) → **Projects** (an index of folders and projects) |
| Folder and project rows: `3 dirty` plus a pill; worktree rows: `main` `t3` `rebase` `review off` chips plus a pill plus `↑2 ↓1 S1 M2 ?1 +23 −12` | A card: name pair and one pill; facts line with chips, `1 conflict`, `3 files`, `+23 −12`, `↑2 ↓1` (only when non-zero). A settled row: name pair and one word (`clean`, `verified`, `review off`, `missing`, `error`). Index rows: worktree count and the pill |
| Toolbar chip `Review on (the default)` | `Review on` / `Review off`; the source is in the title and the first line of the menu |
| No pinning | Pin / Unpin in the worktree menu; pinned worktrees are cards at the top with a `pinned` chip (per-device pref) |
| `J`/`K` in tree order | `J`/`K` walk cards, then the tail; selecting a settled worktree reopens a collapsed tail |

Files: `apps/web/src/components/Sidebar.tsx` (rewritten), `lib/model.ts` (`RowState`, `rowState`, `settledWord`,
`buildSidebar` → `cards`/`settled`, `pinned`), `state/prefs.ts` (`pinned`), `state/ui.tsx` (`togglePinned`),
`state/model.tsx`, `components/ReviewPolicyChip.tsx`, tests `test/ux.test.tsx`, `test/app.test.tsx`; docs as above.

Kept: every `data-testid` and `data-*` attribute the e2e suite reads on worktree, project and folder rows (new:
`data-state`, `data-pinned`); the filter and both toggles; the context menus (plus Pin and "Overview of <project>" on
worktrees); the Overview, palette and bulk/policy flows unchanged.

## Verification

Filled in from real runs on this worktree (Node 26.13.0, WSL2); see the end of this file.

## Decisions

#40 activity list, what was adopted and not from T3 Code and T3 Chat · #41 settling is the review loop, blocked never
settles · #42 pinning · #43 review status simplified (porcelain shorthand replaced; chip wording) · #44 keyboard and
collapse · #45 tests · #46 not done on purpose. All in `docs/DECISIONS.md`.

## Contract changes

None.

## Known gaps

- **No real "last changed" time.** The daemon could add `WorktreeSummary.changedAt` (additive: the time the `stateHash`
  last changed, kept across polls). With it the settled tail could sort by recency and rows could say `2 h ago`, and
  T3 Chat's day groups would become honest. Proposed for the daemon stream, not built.
- Settled rows that are both review-off and missing/failed show a badge and a word, so a long project name truncates
  in a 260 px sidebar. The title carries the path.
- Worktrees with no summary yet appear in the tail with `…` until the inbox arrives, then jump to the cards (same
  first-paint behaviour as the old pills).
- Not covered by UI tests: the Pin command from the palette (there is none; pinning is menu-only), the tail's
  auto-reopen from `n`.
