# ux-toolbar report (chrome hierarchy: context bar and pane headers)

2026-11-09. Branch `ux/toolbar-hierarchy` on `main` at `90c7cff`, worktree `~/.t3/worktrees/octopus-diff/ux-toolbar`.
Brief from the user: the controls above the file list and the diff are "too dense, there is little context and
hierarchy into which belongs to which"; rearrange them, taking the Request (PR) tab into account; plan in a worktree,
open a PR. Design record: `docs/TOOLBAR.md`. Decisions #116–#122.

## Shipped

The one toolbar that spanned both panes is replaced by three tiers, one row each; a control sits over what it changes.

| Tier | Where | Holds |
|---|---|---|
| **Context bar** (`components/ContextBar.tsx`) | above both panes, the same on the Changes and Request tabs | where you are: `Inbox  5 worktrees  30 files`, or `octopus-api  feat/auth` with its chips (`main`, source, in-progress) and `↑4 ↓0`; the `Changes \| PR #100` switch; the forge link as state words (`open  changes requested ↗`, Changes tab only); `Review on` (ghost) / `Review off` (raised); at the right `Live`, theme, `?` |
| **File pane header** (`components/FilePaneHeader.tsx`, `ScopeSelect.tsx`) | over the list | the scope select with counts (the commit picker and its copy button on a second row); show reviewed (eye), tree view (worktree only) as ghost icon toggles; `✓ Review 17` |
| **Diff header** (`components/diff/DiffPane.tsx`) | over the diff, always rendered | status, path, copy, status word, `+a −d` (the worktree name only in the Inbox); at the right `[unified \| split]` as a segmented icon pair, whitespace (pilcrow), a hairline, `More context` / `Expand all` (ghost text), `⋯`, a hairline, `✓ Reviewed` |

Removed as redundant: the `17 files  17 unreviewed` line, the worktree name in the diff header outside the Inbox, the
`Show` label, `PR #100` repeated in the link. New recipes in `styles.css`: pressed ghost toggles keep the soft fill,
`.od-btn-icon`, `.od-sep`. Five stroke icons in `bits.tsx` (rows, columns, pilcrow, eye, tree). `RowChips` moved to
`WorktreeChips.tsx` and is shared by the sidebar and the bar. `Toolbar.tsx` is gone; `ALL_ON_BRANCH` lives in
`lib/scopeLabels.ts`. `scripts/shots.ts` gained a `commit-scope` state.

Every test id and attribute the suites read is unchanged (`scope-select` + `data-scope`, `diff-mode-toggle` +
`data-mode`, `whitespace-toggle` / `show-reviewed-toggle` + `aria-pressed`, `worktree-tabs` / `worktree-tab`,
`change-request-badge` with href / target / rel / `data-number`, `review-policy-chip`, `mark-all-button`,
`review-toggle`, `refresh-indicator`, `theme-toggle`, the `Tree view` accessible name). New plain test ids:
`context-bar`, `context-bar-worktree`, `tree-view-toggle`, `diff-header-worktree`, `data-mode-option` on the two
layout buttons.

## Verification (this worktree, Node 26)

| Command | Result |
|---|---|
| `pnpm check` | **exit 0**: lint `Checked 399 files … No fixes applied`, credits up to date; typecheck and build every package; tests web **210** (+1), daemon 187, cli 139, fixtures, git-core, contracts, forge, e2e-vitest 5; all passed |
| `pnpm test:e2e`, first run | 82 passed, **1 failed**: `04-live-updates` "sidebar counts follow external edits in the inbox view" asserted a row of the virtualized Inbox list with `toBeVisible`; the 6 px taller file pane header left that row outside the mounted window (deterministic, reproduced alone). Fixed with the suite's own `allFileItems()` helper (#122); the spec then passes 5/5 |
| `pnpm test:e2e`, runs 2, 3 and 4 | **hung** after 82, 64 and 50 passed tests (zero failures), each time at a daemon shutdown: the `@parcel/watcher` `EINTR` deadlock recorded in `docs/BLOCKERS.md` (Open, 2); killed after 12 to 23 minutes. Not the UI: one hang followed an API-only test, and the page closes before the daemon fixture does |
| `pnpm test:e2e` on an untouched `main` checkout (control, same machine) | run 1: 82 passed, 1 failed (`11-ui-bulk-review` "stale: … skipped", `stateHash … did not change`: a timing failure unrelated to this branch); run 2: 82 passed, 1 failed (`16-copy` "select two lines → Copy bar", the bar not visible in time: another timing failure). Neither control run hung; 1 of 4 branch runs completed. The branch does not touch the daemon or its dependencies |
| `pnpm --filter @octopus-diff/web shots` (mock, `inbox`, `worktree`, `request`, `commit-scope`, `policy-menu`; both brand themes, 1440 and 960) | inspected: the bar fits one line at 960; the diff header wraps its controls under the path at 960; the commit picker takes its own row |
| `pnpm --filter @octopus-diff/e2e screenshots`, `copy-screenshots.ts` | README screenshots regenerated from the fixtures (inbox, diff split / unified, folder picker, palette, help, copy selection; light and dark) |

## Decisions

#116 three tiers · #117 one bar for both tabs, the forge link says the state · #118 ghost icon toggles, segmented
layout pair, bordered primary verb · #119 what was dropped · #120 the diff header is always rendered · #121 what was
left alone · #122 files, including the three e2e edits. All in `docs/DECISIONS.md` under "Chrome hierarchy".

## Contract changes

None.

## Dependencies

None added or removed; `pnpm credits:check` passes unchanged.

## Known gaps

- The e2e suite hangs at a daemon shutdown in most runs on this machine (`@parcel/watcher` 2.6.0 does not retry
  `EINTR`, then deadlocks on destruction): `docs/BLOCKERS.md` (Open, 2) has the trace and two fixes. Every spec that
  ran passed; the one failure the branch caused is fixed (#122). Until the watcher is patched, run spec files alone or
  rerun.
- `docs/screenshots/forges-dark.png`, `forges-light.png` and `forges-settings-dark.png` still show the old toolbar.
  They were taken against a real `gh` session and throwaway repositories (`docs/reports/forges.md`), which an
  autonomous session must not use; the user can retake them with the same recipe.
- The Overview (folder, project) has no bar, as before, so `Live`, the theme toggle and `?` are absent there; the
  shortcuts (`t`, `?`) still work. A follow-up if it is missed.
- At 960 px the diff header wraps its controls under the file identity when a patch is open; accepted.
- The scope select stays a native `<select>` (T3's dropdown menu would need a custom listbox and new test helpers).

## Notes for integration

Pure `apps/web` + `docs` + three e2e lines (`support/app.ts` `setDiffMode` learns the segmented pair; `16-copy`
`setMode` delegates to it; `04-live-updates` scans the virtualized list). Fast-forwards onto `main` at `90c7cff`. No
preference migration: `diffMode`, `ignoreWhitespace`, `showReviewed`, `fileListLayout` keep their keys. The LAN daemon
(`octopus-diff-lan`) needs a rebuild and restart to show the new chrome.
