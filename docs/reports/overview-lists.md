# overview-lists report

Lead, 2026-11-09, on branch `ux/toolbar-hierarchy` (PR #2), after rebasing the local commits onto
`origin/ux/toolbar-hierarchy` (`c198638`, a review commit pushed from another session). Design record:
`docs/OVERVIEW-LISTS.md`; DECISIONS #127–#133.

## Shipped

- **`default` chip** (`DefaultBranchChip`, `.od-chip-default`) on the worktree that has the project's default branch
  checked out: sidebar rows (inline after the name), the context bar and the Overview worktree table. The Overview's
  Source column says `main checkout` for the main worktree (the old faint `main` word is gone).
- **Project Overview tabs** `Worktrees N | Branches N | Pull requests N` under the facts and figures
  (`Overview.tsx` `ProjectOverview`), built on the new `components/Tabs.tsx` `SegmentedTabs` (WAI-ARIA keyboard
  model: roving tab stop, ←/→, Home/End, `aria-controls` → `tabpanel`). The Request view's
  `Summary | Timeline | Files` uses the same component.
- **Pagination**, 15 rows (`components/Pager.tsx`: `usePage`, `Pager`): worktrees (default-branch worktree first,
  then recency) and branches. Open requests show the newest 15 and `N more on <host> ↗`, no pager.
- **Branches without a worktree** (`RepositoryInfo.tsx` `LocalBranches`): branch with copy button, last commit,
  updated, upstream (`origin ↑a ↓b`, `gone`, `local only`), state (`merged`, `default`, the open request on that
  branch). Data: `GitRepositoryInfo.branches` from git-core `readRepositoryInfo` (same `for-each-ref` plus one
  `for-each-ref --merged`).
- **TanStack Table evaluated, not adopted** (DECISIONS #132; `docs/OVERVIEW-LISTS.md` §6).

## Verification

| Command | Result |
|---|---|
| `pnpm check` | lint (Biome + `credits:check`), typecheck and build passed; tests stopped at git-core: `readonly.test.ts > never writes to any repository` timed out at 5000 ms (174/175). That's the known load-dependent timeout (fix in PR #3); the test doesn't call `readRepositoryInfo`. |
| `pnpm --filter @octopus-diff/git-core test` (alone) | 15 files, 175 passed |
| per-package `test`: daemon / web / cli / fixtures / e2e-unit | 187 / 217 / 139 / 48 / 5 passed, 0 failed |
| `pnpm test:e2e` | 83 passed, 0 failed (3.7 min), including `14-ui-forge-details` through the new Pull requests tab |
| `pnpm --filter @octopus-diff/web shots` (mock; project, project-branches, project-requests, folder, request, request-conversation, hover-card, worktree; both brand themes, 1440 and 960) | inspected; at 960 the Branches table first squeezed the subject to one letter, fixed by showing only the remote when the upstream mirrors the branch name |

## Decisions

DECISIONS #127–#133: the chip (#127), tabs (#128), `SegmentedTabs` (#129), pagination and the 15-request cap (#130),
the branch list (#131), no TanStack Table (#132), mock and tests (#133).

## Contract changes

Additive, commit `contracts: GitRepositoryInfo.branches …`: `GitBranchInfoSchema`, optional
`GitRepositoryInfo.branches`, `MAX_LISTED_BRANCHES` (500); test ids `overviewTab`, `overviewBranchRow`, `pager`,
`defaultBranchChip`.

## Dependencies

None added or removed (TanStack Table rejected), so `pnpm credits` was not needed; `credits:check` passed.

## Known gaps

- The chosen Overview tab isn't in the view state or URL, and there's no palette command per tab.
- The branch list is capped at 500 (newest); the tab says so when the cap applies.
- `docs/screenshots/forges-*.png` come from a live-forge run and still show the old toolbar (gap carried over from the
  ux-toolbar report). The fixture-based README screenshots (`pnpm --filter @octopus-diff/e2e screenshots`) were not
  regenerated in this round; only the sidebar's new `default` chip would differ.
- `git-core` `readonly.test.ts` can still time out under the full parallel run until PR #3 lands.

## Notes for integration

- Daemon unchanged: it passes `info` through, and older git-cores simply omit `branches` (the Branches tab hides).
- e2e `14-ui-forge-details` now clicks the Pull requests tab before an open request; any new spec that clicks
  `repo-open-request` must do the same.
