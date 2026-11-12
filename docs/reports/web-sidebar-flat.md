# web-sidebar-flat report

Roadmap #13 "Sidebar: remove Inbox and show a flat list of active work ordered by last activity" (step 15 of #24,
milestone M3). `apps/web` only (plus `docs/` and the credits files). DECISIONS **#233-#240** (other open branches may
use these numbers; the lead renumbers).

## Shipped

- **One flat list** (`components/Sidebar.tsx`, `SidebarList.tsx`, `SidebarRow.tsx`): every worktree that passes the
  filters, across all folders and projects, **pinned first, then newest `activityAt` first** (rows without one last;
  ties by project name, main checkout, branch). No Inbox entry, no folder or project headers, no Pinned / To review
  split. Model: `lib/model.ts` (`compareRows`, `SidebarModel.flat | hidden | folderOptions`, `WorktreeRow.hidden`,
  `hideToggle` replacing `settleToggle`, `folderIdOf`, `SidebarFilters.folders`).
- **Hidden** is a secondary, closed-by-default section at the end holding only what the user hid by hand ("Hide
  until it changes" / "Show again", still pinned to the state hash). Reviewed, clean, merged, closed, review-off,
  missing and failed worktrees stay in the list as normal rows. A closed section still shows the selected worktree;
  filters open it; a pinned row is never hidden. Words say "Hidden", not "Settled".
- **No special state for rows that need no review:** the status slot shows only conflicts, `N commits ·` + the
  unreviewed pill, an open request, `review off`, `merged`, `closed`, `missing`, `error`, `…`. `reviewed` / `clean` are
  gone from rows. The pill and `data-unreviewed` are `unreviewedOwnFiles ?? unreviewedFiles` (never merge noise); the
  "N deleted" chip and the other `RowChips` are untouched.
- **Repo label on every row** (glyph + name above the branch, `data-testid="row-repo"`, `data-project-name` on the
  row), since rows no longer sit under a project. Layout is the old Pinned/Hidden card; #14 redesigns it.
- **Virtualised** with `@tanstack/react-virtual` 3.14.26 (MIT, added to `apps/web` only; `pnpm credits` run, both
  generated files in the same commit as the dependency): measured row heights (estimate 58 px), overscan 6, stable
  keys, `top`-positioned rows (not `transform`: it would trap the hover card's `position: fixed`), the selected row
  always mounted (`rangeExtractor`), `scrollToIndex` when the selection changes (J/K, palette, click).
- **Filter picker** gets a **Folders** group (`filterFolders`), so "the selected folders" is a searchable pick, not
  free text. A folder's or project's Overview opens from the row's context menu (`Overview of <project>`, `Overview of
  folder <label>`) and the palette.
- **Mock / scripts:** `scripts/shots.ts` (`folder` and `project` states open the Overviews from a row menu; new
  `sidebar-hidden` and `sidebar-filter` states), `scripts/perf.ts` (waits on the list's `data-total`, since a virtual
  list never mounts all 30 rows; prints `listed` in its page-state message), `scripts/browser-check.ts` (no
  `inbox-item`). The mock needed no change (its `large` dataset already staggers `activityAt`).
- **Docs:** DECISIONS #233-#240, PLAN §4.2 sidebar paragraph rewritten, banner in `docs/STATUS-FLOW.md` (placement
  superseded; stages unchanged).

### What I saw (shots, Chromium, `octopus-dark`, 1440 and 960 wide, demo dataset)

The sidebar reads as one column of three-line cards: repo (glyph + name, muted) with the status at the right, the
branch below, then chips and facts. `web-dashboard main`, `octopus-api main`, `agent/codex-123`, `feat/auth` (1
conflict, pill 20), `fix/cache`, the detached ones, `infra trunk`, `legacy-tool master`/`old-experiment` follow in
activity order, projects interleaved; `trunk` and the reviewed rows carry no word. `legacy-tool` rows keep `review
off` plus `error` / `missing` (informative). Hiding `fix/cache` moves it under a `v Hidden 1` header at the end (opened
in the shot). The filter dropdown shows Status / **Folders** (`~/code 7`, `Added directly 3`) / Projects / Worktrees.
The `folder` shot (960) shows the `~/code` Overview opened from a row's menu, sidebar intact. Search placeholder was
clipped at 260 px, so it is now "Search by name". I did not look at a 330-worktree page in a real browser (the mock
server has no size knob in env); the jsdom perf test and `pnpm perf` (30 worktrees) cover it, see below.

## Verification

Run from the repo root on this machine (Node 26):

- `pnpm lint`: **pass** (Biome 484 files, `credits: up to date (144 shipped packages, 16 dev tools)`).
- `pnpm typecheck`: **pass** (all packages including `e2e`).
- `pnpm --filter @octopus-diff/web test`: **27 files, 372 tests pass** (before this work 26 files / 359 tests).
- `pnpm build`: **pass**.
- `PERF_SMOKE=1 pnpm --filter @octopus-diff/web perf` (preview of the build, 30 worktrees x 200 files): all checks
  ok, 0 page errors (`virtualised list ... 46 / 46` is the file list; the sidebar's own check is `data-total`).
- `pnpm test:e2e`: 82 passed, 16 failed (expected, see "e2e" below).

### How the virtual list is tested in jsdom

jsdom has no layout, so `@tanstack/virtual-core` would see a 0 px viewport. `apps/web/test/layout.ts` (installed by
`test/setup.ts`, reset after each test) overrides, the way the library's own tests stub elements, the getters it
reads: `clientHeight` / `clientWidth` / `scrollHeight` / `scrollTop` / `scrollTo` for the element with
`data-testid="sidebar-scroll"` and `offsetHeight` for `li[data-index]` inside `sidebar-list`. Default viewport 6000 px
(about 100 rows) so the old small-fixture tests see every row unchanged; `setSidebarLayout({ viewport, row })` before
`render` narrows it, `scrollSidebarTo(el, top)` scrolls like a browser (sets `scrollTop`, fires `scroll`).

### New and changed tests (all mutation-checked: each mutation below was applied, the named tests failed, then reverted)

`test/sidebar-flat.test.tsx` (13 tests): ordering newest first (reverse the comparator: fails; nulls first: fails 2),
pinned first (drop the pin term: fails), hidden by hand only / pinned beats hidden (flat = all rows, hidden includes
pinned: fail), own-only counts (`unreviewedFiles` instead of own: fails), folder filter (ignore folders: fails 2),
window of mounted rows + scrolling moves it (overscan 600: fails 3; `top: 0`: fails), selected row mounted when
scrolled away (drop `rangeExtractor`: fails), scroll-into-view on J (drop `scrollToIndex`: fails), repo label on every
row (branch instead of project: fails), Hidden header + rows (never add the header: fails), picker folders group,
**perf with 330 worktrees** (30 projects x 11, the mock's `large` dataset with a custom shape): <= 13 + overscan + 1
mounted rows and < 1500 DOM nodes under the scroller (60 per row at most), before and after selecting a row and
opening the filter. For comparison the old sidebar mounted ~7k nodes for 90 worktrees (#24).
`test/ux.test.tsx`: the folder-tier and shelf tests are replaced by "flat list newest first, each with its repo", the
Hidden test (hide / show again / expires with the hash / selected stays visible while closed / blocked cannot be
hidden / reviewed stays in the list with no word / pin), the Overview-from-menu test and a per-worktree policy menu
test (mutation: restoring the `reviewed` / `clean` words fails 2; `hideToggle` returning `'active'` fails the Hidden
test and the model test). `test/model.test.ts` (`hideToggle`), `app.test.tsx`, `events-auth.test.tsx`,
`merge-noise.test.tsx`, `repository-info.test.tsx` (no Inbox entry; they use `store`, `g i` or `data-dirty` rows
instead; the J/K test walks the DOM order).

## e2e (`pnpm test:e2e`)

Run in two parts (the suite has `workers: 1` and each broken spec waits out its 90 s timeout, so the full run exceeds
the 900 s I allowed it; `tests/12`-`19` were run separately with `playwright test tests/12 ... tests/19`):
**82 passed, 16 failed** of 98. Every failure is a spec that looks for an element that no longer exists or for the
old placement, none is a runtime error of the app:

- `01-projects` (add by path / scan root; sidebar shows every worktree...), `18-onboarding` (2): `app.projectItem(name)`.
- `02-inbox-diff` (UI inbox lists every dirty worktree; selecting a file shows its patch), `04-live-updates` (sidebar
  counts follow external edits in the inbox view), `06-keyboard` (`/`, `g i`, `?`), `07-readonly` (`app.selectInbox()`,
  3 min timeout), `11-ui-bulk-review` (3: inbox with filter / inbox-wide / project via context menu), `19-merge-noise`
  (`:252`): `app.inbox` / `selectInbox()` click `inbox-item`.
- `14-ui-forge-details` (2): `projectNameButton(name)` = `project-item ... button[title]`.
- `15-ui-status-flow` (`:70`, "Hide until it changes"): expects `data-section="settled"`, now `hidden`.

All other specs pass.

What needs updating in `e2e/` (not edited here, it is another stream's; no test id was renamed, the elements are gone):

- `e2e/support/app.ts`: `get inbox()` (`TEST_IDS.inboxItem`, no element now), `projectItem(name)`
  (`TEST_IDS.projectItem`, no element now). `e2e/support/ui.ts`: `projectNameButton`, `folderNameButton`
  (`li[data-folder-id]`, gone: open Overviews from a row's context menu `Overview of ...` or the palette instead).
- `tests/01-projects.spec.ts` (lines 24, 59, 153: `app.projectItem(...)`), `tests/18-onboarding.spec.ts` (57, 72, 135:
  `projectItem`, `app.inbox`): assert on a worktree row with `data-project-name` instead (new attribute) or on the
  filter picker's project option.
- `tests/02-inbox-diff.spec.ts:43` (`app.inbox` `data-count`): count `[data-testid=worktree-item][data-dirty=true]`
  rows (the sidebar list is virtual, so a big fixture mounts only a window: use `sidebar-list[data-total]` for totals).
- `tests/06-keyboard.spec.ts:91` (`app.inbox` `aria-current` after `K`): the Inbox view has no sidebar element; check
  the context bar or `[data-testid=file-group]`.
- `tests/15-ui-status-flow.spec.ts` (20, 89, 93): `li[data-section]` is now `flat | hidden | hidden-header` (was
  `folder | settled | pinned`) and reviewed worktrees are not in a shelf: "Hide until it changes" moves the row to
  `data-section="hidden"` once the Hidden section is expanded (`Expand hidden`), and the un-hide happens in `flat`.
- `e2e/bench/bench.ts:600` and `e2e/bench/profile.ts:489` click `inboxItem`; use `page.keyboard.press('g'); press('i')`.
- Any e2e that finds a worktree row far down a long list must scroll or use the filter: only a window is mounted.
  (`worktreeItem(id)` of `app.ts` can use `scrollIntoViewIfNeeded` only for a mounted row; select by id through the
  store/palette or filter first.)

## Decisions (also in docs/DECISIONS.md #233-#240)

Flat list order and Hidden semantics (#233, #235); the Inbox *view* stays, only the sidebar entry goes (#234, with the
follow-up to remove the view); no word for rows that need no review (#236); repo label on every row (#237); virtual
list design (#238); Folders group in the picker (#239); jsdom layout shim (#240).

## Contract changes

None. (`TEST_IDS.inboxItem` and `TEST_IDS.projectItem` stay in `packages/contracts` but nothing in the web renders
them; the lead may want to mark them deprecated when e2e is updated.)

## Dependencies

Added `@tanstack/react-virtual` 3.14.26 (MIT) to `apps/web` (pulls `@tanstack/virtual-core`). `pnpm credits` was run;
`CREDITS.md` and `apps/web/src/generated/credits.json` are in the same commit as the dependency.

## Known gaps

- The Inbox view and `g i` remain (see #234). With no sidebar entry the way back is `g i`, the palette, or `K` from
  the first worktree.
- Tab walks only the mounted rows (a long list is a window); `J`/`K`, the palette and the filter reach everything.
- Folder- and project-level actions (bulk review, review policy, rescan, remove) no longer have sidebar header menus;
  they live in the Overviews and Settings -> Folders. Worktree-level policy and bulk stay in the row menu.
- "Reviewed", "clean" and the layout of the row (branch + repo second line, status variants) are #14.
- A real-browser run at 330 worktrees was not done (see above); jsdom bound plus `pnpm perf` at 30.
- `e2e/` needs the updates listed above; they were not made here.

## Notes for integration

- `ui.tsx` gained `filterFolders` (transient, not persisted); `prefs.ts` is unchanged (`collapsed` is now unused by the
  sidebar but still normalised, harmless; `settledOpen` keeps its name for the Hidden section).
- `WorktreeRow.hidden` and `SidebarModel.flat | hidden | folderOptions` are new; `SidebarModel.pinned` and `.settled`
  and `ProjectGroup.active` were removed (only the sidebar used them).
- Another branch that touches `Sidebar.tsx` will conflict heavily: the row code moved to `SidebarRow.tsx`.
- DECISIONS numbers 233-240 may collide with other open branches.
