# Project Overview lists and the default-branch marker (design)

> Lead, 2026-11-09, branch `ux/toolbar-hierarchy` (on top of PR #2). Brief from the user:
>
> - Add a design highlight to the default branch when listing worktrees.
> - In the repo (project) Overview: limit the worktree listing to 15 and paginate; limit the open pull requests to
>   15 (keep the "more on GitHub" link); list the local branches that have no worktree; find out whether tab
>   navigation would be better; use TanStack Table if and only if it makes the code easier to maintain.
>
> Decisions #127–#133 in `docs/DECISIONS.md`.

## 1. What was there

The project Overview was one long page: header, Local and Forge facts, the figures row, the worktree table (every
worktree, recency order), then "Open pull requests" (the newest 20 the forge returned) and a `N more on github.com ↗`
link. Nothing listed branches; the Local facts only counted them (`7 branches · 4 tags · 4 worktrees`). The
worktree whose branch is the project's default branch looked like any other row; the main checkout carried a faint
`main` word, so the default row read `main main`.

## 2. The default-branch marker

The default branch is the baseline: every `↑a ↓b`, "merged" and review range is measured against it. It now carries
an **outlined ink chip, `default`** (`.od-chip-default`: transparent fill, `lineStrong` inset ring, `fg` text, 500
weight), right after the branch name:

- **Sidebar rows**: inline on the name line, so it costs no extra line (the meta line below is unchanged).
- **Context bar**: before the other chips.
- **Overview worktree table**: after the name; the row also gets `data-default="true"`.

Why a chip and not a colour or an icon: the frame is achromatic (IDENTITY §3), so a hue is off the table; an icon
would need a legend. The other chips are filled grey *facts* (`t3`, `claude`, `rebase`); the outline makes this one
read as a *label* and keeps it from looking like a worktree source. It shows only when a worktree has the default
branch checked out (`worktree.branch === project.defaultBranch`), never on detached heads.

The faint `main` word in the Overview's first cell is gone: the **Source** column now says `main checkout` for the
main worktree (it said `–`), so the default row reads `main [default] · main checkout` instead of `main main`.

## 3. Tabs: yes

**Question asked:** would tab navigation be better than the long page?

With branches added, the page would stack three lists of up to 15 rows each under ~330 px of facts and figures;
the open requests are two lines a row, so the last list started about three screens down, and each pager would sit
far from the others. The three lists answer different questions (what is checked out, what is lying around, what is
under review on the forge), and nobody reads them together. So the lists now sit behind a **segmented tab list**
under the figures row:

```
Worktrees 4 | Branches 18 | Pull requests 27
```

- The **counts** keep the summary that the long page gave by scrolling: you see that 18 branches have no worktree
  without opening the tab.
- **Facts and figures stay above** the tabs: they are the summary of the project, not a list.
- **Worktrees** is the default tab (the Overview's main job). The chosen tab is component state: it survives moving
  between projects (compare the same list across repositories), not a reload. The page of each list starts over
  per project.
- **Pull requests** (or **Merge requests**) appears only when the forge returned repository data; **Branches** is
  hidden only when a daemon answered without a branch list (older daemons).
- **Keyboard** (the other reading of "tab navigation"): the tab list follows the WAI-ARIA tabs pattern, one Tab
  stop for the list (roving `tabIndex`), `←`/`→` move and select, `Home`/`End` jump, each tab `aria-controls` its
  `tabpanel`. Paging also bounds the Tab order inside a list to 15 row buttons. The Request view's
  `Summary | Timeline | Files` used `role="tab"` without the keyboard model; it now uses the same component
  (`components/Tabs.tsx`, `SegmentedTabs`).

Not done: the tab in the URL or the view state (no deep links exist yet for any Overview state) and a palette
command per tab. Both are small if wanted.

## 4. Pagination

- `components/Pager.tsx`: `usePage(items, 15)` slices an already-loaded list; `<Pager>` shows `16–30 of 42` and
  previous / next ghost icon buttons, and renders nothing for a single page. The page **clamps** when the list
  shrinks (live updates must not throw you back to page 1 on every poll).
- **Worktrees**: 15 a page, the **default-branch worktree first**, then recency (DECISIONS #125). Pinning it first
  keeps the baseline on page 1, where the highlight is useful; the sidebar keeps pure recency.
- **Pull requests**: the newest **15** of what the forge returned (the daemon asks for 20), **no pager**: the forge
  is where the rest lives, so the link stays: `12 more on github.com ↗` (`/pulls`, or `/-/merge_requests`). With
  none open, the tab says so and links to the full list.
- **Branches**: 15 a page.

## 5. Branches without a worktree

Data: `GitRepositoryInfo.branches` (contracts, additive, optional): every local branch, newest commit first, capped at
`MAX_LISTED_BRANCHES` (500; `localBranches` keeps the full count and the tab says "only the 500 newest of N are
read"). git-core fills it from the **same `for-each-ref`** it already ran for the counts (new atoms:
`upstream:track,nobracket` and `contents:subject`) plus **one** `for-each-ref --merged=<default-oid> refs/heads/`.
No new process per branch, nothing fetched. The web removes the branches some worktree has checked out.

Each row: the branch (mono, with a copy button on hover / focus), the last commit (short sha and subject), when it
moved, the upstream (`origin ↑2 ↓0`; the remote alone when the upstream has the branch's own name, the full name
otherwise; `gone` in `warn` when the upstream was deleted and pruned; `local only` without one) and a state column:
`merged` (reachable from the default branch: a clean-up candidate), `default` (the default branch itself, when no
worktree has it checked out) and the open request whose head is that branch in this repository (`#300 ↗`, from the
forge data already loaded, no extra query). Rows do not navigate: there is nothing to open without a worktree, and
octopus-diff never creates one (read-only).

## 6. TanStack Table: no

Weighed objectively against what these tables need today:

| Need | Plain JSX + `usePage` | TanStack Table v8 |
|---|---|---|
| Pagination | `usePage`: 10 lines, one hook shared by both paged lists | `getPaginationRowModel` + state wiring per table |
| Sorting, filtering, column visibility, resizing, grouping | not needed (fixed orders: default first, recency, newest) | its real strength, unused |
| Cells | JSX in place, read top to bottom | the same JSX moved into `columnHelper.accessor(..., { cell })` definitions, rendered back through `flexRender` |
| Dependencies | none | `@tanstack/react-table` (+ `table-core`), a credits entry |
| Tests and e2e | unchanged selectors | unchanged |

Four small tables (folder repositories, project worktrees, branches, open requests), each with fixed columns and a
fixed order. TanStack Table is headless: it would not remove a single cell renderer, it would add column definitions
around them and a dependency, to replace a `slice`. **Revisit** when a table needs user sorting, column choice or
filtering (for example sortable worktree columns), or when the tables start to share behaviour beyond paging; then
the column-definition indirection pays for itself.

## 7. Files

- `packages/contracts`: `GitBranchInfoSchema`, `GitRepositoryInfo.branches?`, `MAX_LISTED_BRANCHES`; test ids
  `overviewTab`, `overviewBranchRow`, `pager`, `defaultBranchChip`.
- `packages/git-core/src/repository.ts`: branch list, `parseUpstreamTrack`; test in `test/repository.test.ts`.
- `apps/web`: `components/Tabs.tsx` and `components/Pager.tsx` (new), `Overview.tsx` (`ProjectOverview` tabs,
  `WorktreeTable`), `RepositoryInfo.tsx` (`LocalBranches`, `OpenRequests` capped), `WorktreeChips.tsx`
  (`DefaultBranchChip`), `Sidebar.tsx`, `ContextBar.tsx`, `request/RequestView.tsx` (shared tabs), `lib/model.ts`
  (`isDefaultBranch`, `defaultBranchFirst`, `branchesWithoutWorktree`), `styles.css` (`.od-chip-default`),
  `bits.tsx` (chevrons), mock (branches for every demo project; 16 extra open requests on octopus-api so the cap
  shows), `scripts/shots.ts` (`project-branches`, `project-requests`).
- `e2e/tests/14-ui-forge-details.spec.ts`: opens the Pull requests tab before clicking a request.
