# web-no-inbox report

Roadmap #83 "Remove the Inbox view (follow-up of #13)" (part of #24). `apps/web` plus the `e2e/` specs and bench
scripts that used the Inbox (explicitly allowed for this task) and `docs/`. No change to `packages/*` or
`apps/daemon`: the daemon's `/api/inbox` route and the contracts are as they were. DECISIONS **#272-#278** (other
open branches may use these numbers; the lead renumbers).

## Shipped

- **No Inbox view.** `View` has `none | folder | project | worktree`; no landing list, no `g i`, no palette "Inbox",
  no context bar `data-view=inbox` / `data-count`, no Inbox group headers in the file list, no worktree name in the
  diff header, no `reviewOffDisplay` setting (it only decided how the Inbox showed review-off worktrees).
- **The landing view is a worktree** (`useLanding` in `App.tsx`): the worktree open last (`prefs.lastWorktree`, new)
  if it is still a row of the sidebar list, else the **top row** (pinned first, then latest activity). It also lands
  again when the open worktree is removed. No row (filters hide everything): an empty state, `data-testid="no-worktree"`,
  with **Clear filters** and **Add repositories…** (the folder picker dialog). No project at all: the unchanged
  onboarding screen. See #272, #273 (there was *no* restore before: `view` was memory-only and the URL has no state;
  the preference is the smallest version of it).
- **Bulk review stays reachable:** `Shift+R` and the button above the list act on the open worktree; folder and
  project Overviews and row menus are unchanged; the Inbox's "everything" became two palette commands, **Review all
  worktrees in the list** / **Mark all worktrees in the list unreviewed**, which respect the sidebar filters (unfiltered:
  one `all` request, as the Inbox did), the eye and the chip, confirm across worktrees, undo, and show their count in
  the palette item (`30 files to mark reviewed`). Unreviewed total: tab title and favicon (unchanged), rows' pills.
- **Keyboard:** `g i` unbound and `g` no longer swallowed (no chord code left); `J`/`K` walk the list with no Inbox stop
  above the first row, from an Overview either key opens the first row; `n` from an Overview opens the target's worktree.
- **Dropped (decided, #274):** the cross-worktree "to review" files list as a view (its facts are on the rows, in the
  title, in the worktree's own list and behind `n`), the group header counts, the Inbox's separate error banner.
- **Kept data:** the web still fetches the daemon's inbox rows (`useInboxQuery`, batches and `worktreeIds=` deltas):
  `n`, the every-worktree plan, `expectedStateHashes` and the "from main" refs use them. The refresh indicator and the
  delta fetch (#271) are unchanged.
- **Dead code removed:** `goInbox`, `inboxUnfiltered`, `view: 'inbox'` in `planBulk` (now `allUnfiltered`), `FileList`'s
  `grouped` / `GroupHeader` / `disabled` / `dimDisabled` / group menu, `WorktreeName`, the `inbox` query in the model,
  `ReviewOffDisplay`, the Inbox mock/shots state (`shots.ts` state `inbox` -> `landing`).
- **Docs:** DECISIONS #272-#278, PLAN §1/§4.2/§4.3, FOLDERS.md, TOOLBAR.md, README, `docs/bench/README.md`,
  `docs/bench/web-perf.json` regenerated (new script shape; keys `fileGroupsAtLoad`, `reviewDataCompleteAt`, `liveRefresh`).

## Verification

Run from the repo root on this machine (Node 26):

- `pnpm lint`: pass (credits up to date; no dependency changed, `pnpm credits` not needed). One `info` from the daemon
  test file `apps/daemon/test/file-origins.real-git.test.ts` (another session's, not touched).
- `pnpm typecheck`: pass (all packages incl. `e2e`).
- `pnpm --filter @octopus-diff/web test`: **30 files, 446 tests pass (after the PR #86 follow-ups; 423 before them)** (before this work: 30 files / 416 tests).
- `pnpm build`: pass.
- `pnpm test:e2e` (full, `workers: 1`): first run 101 passed, 1 failed (`15-ui-status-flow` "a commit keeps the work out
  of the shelf", a real race, below); after the fix, final run **102 passed, 0 failed** (3.2 min; re-run after the PR #86 follow-up: 102 passed).
- `pnpm --filter @octopus-diff/web perf:smoke`: all checks ok, 0 page errors (landing list 5200 px, 1 file group, `J` 7 of 7,
  one `/api/inbox` request per refresh and never `/api/projects`). Full `perf` run also ok; baseline rewritten.
- CI-only steps (`.github/workflows/ci.yml`): `pnpm test:scripts` 34 passed; the CLI smoke (`node apps/cli/dist/index.js
  --version` -> `0.0.0`, `doctor` -> 0 problems, 1 warning); the package job (`pack:tarball`) and the other packages'
  vitest suites are untouched by this change and were not re-run.

### Mutation checks (each applied, the named tests failed, then reverted)

Landing picks the last row instead of the first: 22 tests fail (all the landing ones and everything that assumes
the first row). Landing ignores `lastWorktree`: the restore test fails. No re-landing for a missing worktree: its test
fails. Not persisting `lastWorktree`: 2 fail. Empty state not rendered: its test fails. `g` swallowed again: the
keyboard test fails. A palette "Inbox" item: the no-Inbox test fails. Every-worktree plan never one `all` request:
the palette bulk test fails. Every-worktree plan ignoring the sidebar filters: the filtered test fails.
`stepWorktree` from nothing going to the last row: the model test fails.

### New and changed unit tests

New: `app.test.tsx` (lands on the top row; last worktree restored; unknown last worktree; disappearing worktree;
empty state + both buttons; no Inbox anywhere; `n` and `J` from an Overview), `ux.test.tsx` (palette bulk with the
`all` request, confirm, undo, the unreviewed twin; with a sidebar filter; `Shift+R` for one worktree),
`lib.test.ts` (`activeView('none')`), `model.test.ts` (`stepWorktree`), `prefs.test.ts` (`lastWorktree` round trip).
Rewritten, same intent: the J/K keyboard test (K stops at the first row, `g i` does nothing), the r/n test (opens a
worktree), the scope test (commit scope resets when an Overview opens), the Activity tests (the strip is the landing
worktree's, an Overview has none), the loading-states "file list names the local work" test (now the open worktree's
files), the policy-chip test, the context-bar test, `sidebar-flat` window tests (the landing row is the selection),
`request.test` markdown lookup (`findAll`: description and conversation both render it). Removed with the header:
"expanding the group does not change the file count in the Inbox group header" (the invariant lives on in "Review N
shown" tests) and the group-header assertion of the scope-counts test.

## e2e specs changed (every one that used `selectInbox()` or the Inbox UI; none weakened)

- `support/app.ts`: `selectInbox()` removed; `expectLanded()` (context bar is a worktree's, the list's top row is
  current), `openPaletteCommand`, `everyWorktreeCount(reviewed)` (reads the palette's count), `runEveryWorktree(reviewed)`.
- `02-inbox-diff`: "UI inbox lists every dirty worktree and no clean one" -> "the UI lists every worktree, lands on the
  first and shows each one's own files" (every registered worktree has its item with the manifest's facts; selecting
  each lists exactly its working-scope files, a clean one none); new "there is no Inbox" (no entry, `g i` does
  nothing, no palette item); the diff test selects the worktree instead of `selectInbox()`.
- `04-live-updates`: "sidebar counts follow external edits in the inbox view" -> "... while another worktree is open"
  (counts follow with `alpha` open; opening the agent's worktree then lists the new file).
- `06-keyboard`: "g i opens the inbox" -> "`g i` is unbound" (the open worktree stays current, context bar `worktree`).
- `07-readonly`: the UI part opens the landing worktree and walks four rows with `J`, opening two files in each.
- `11-ui-bulk-review`: "inbox with a sidebar filter" -> "every worktree of the list with a sidebar filter" (palette command;
  count equals the daemon's; with the filter every request is per worktree with `paths`, never `all`; Ctrl+Z); "inbox-wide
  with Shift+R" -> "every worktree of the list: one all request, confirm dialog, title count, Ctrl+Z undo" (asserts the
  request body is one `all`, Escape sends nothing); new "Shift+R marks the open worktree only"; the stale test selects
  another worktree first, runs the palette command and waits for the palette count where it waited for the button.
- `15-ui-status-flow` (`reviewAll` helper): waits for the refresh indicator to be idle before clicking. Cause, found by
  repeating the test 8x (2 failures, toast "Nothing to mark · 1 changed meanwhile"): the app now lands on the top row,
  which in this test is the freshly created `feature` worktree, so its file list was already open from before the
  commit and `Review all` sent the old state hash; the daemon correctly skipped it. 12 of 12 repeats pass after.
- `19-merge-noise`: "the Inbox's Review all N" -> the palette's count (15).
- `18-onboarding`: comment only ("Show folder leaves the worktree the app landed on").
- `scripts/screenshots.ts`, `bench/bench.ts`, `bench/profile.ts`: no `g i`; the first screenshot is `landing`.
- Unchanged and still passing: `01`, `03`, `05`, `08`-`10`, `12`-`14`, `16`, `17` (API only or not Inbox-aware).

## Decisions

#272-#278 in `docs/DECISIONS.md`.

## Contract changes

None.

## Dependencies

None (`pnpm credits` not needed; `pnpm lint` confirms the credits are current).

## Known gaps

- The persisted `lastWorktree` is per browser, not in the URL: a link does not open a worktree (it never did).
- `TEST_IDS.inboxItem` stays in `packages/contracts` (not mine); nothing in the web uses it. The mock/daemon `inbox`
  route and `InboxEntry` types keep their names (they are the review-data API).
- The palette's "every worktree" commands are not in the sidebar chrome; they are palette-only like "Mark all unreviewed".
- `--od-row-header` in `styles.css` is unused now (the file list has no group headers); left, harmless.
- `Review all` on the open worktree during the moment between an event and its file-list refresh is skipped as "changed
  meanwhile" (as designed, #271); landing on the worktree makes it likelier than before, see the `15` fix.

## Notes for integration

Rebase onto main may touch `docs/DECISIONS.md` numbering (#272+) and `apps/web/src/App.tsx`, `state/commands.ts`,
`state/model.tsx`, `components/FileList.tsx`. `docs/bench/web-perf.json` was regenerated on this machine.

## Review follow-up (PR #86, two P1 comments)

1. *Stale pane when the list is empty* (#279): the pane now follows the sidebar's list (`viewListed`); both cases
   (filters leave no row, including `onlyUnreviewed` with nothing unreviewed; the open worktree removed with every
   other row filtered out) and the "open worktree filtered out, other rows listed" case show `no-worktree`
   (`data-reason` `empty` | `hidden`), the view is kept, keys do not act on the hidden worktree. Tests drive the real
   filter dropdown (`/`, status toggles, worktree options), the product's own bulk command and `backend.removeProject`.
2. *Bulk marks with mismatched states* (#280): `inboxStateHashes` for the every-worktree plan. Tests hold
   `/api/inbox`, edit the open worktree so its file query is newer than the review data, run the palette command and
   assert the request carries the review data row's hash and the toast says "changed meanwhile" (unfiltered `all`, and
   filtered per-worktree with paths: nothing marked).
Mutation checks: pane ignoring `viewListed` (4 fail), no `hidden` reason (1), keys acting on the hidden worktree
(`shown` plan, `r`, `j`: 1 each), hashes from the file query again (2), `viewListed` from `byId` (3).

## Review follow-up 2 (PR #86, `n` into a filtered-out worktree)

#281: `n` could select a file of a worktree the filters hide while the pane (#279) then showed the empty state. One
predicate now (`listedIds`); `n`/auto-advance only target listed worktrees (wrap in the list, notice when nothing else),
explicit picks of a hidden worktree (palette, Overview) clear the filters. Table-driven tests over every entry point;
mutation checks: `n` unfiltered (3 fail: the reported bug), no reveal on explicit picks (2), notice (1), `J`/`K` from the
full order (1), landing ignoring the list (1).

## Review follow-up 3 (PR #86 P2, re-picking the open hidden worktree)

The filter-clearing moved from an `App` effect (compared the open id with a ref, so re-picking the open worktree did
nothing) into `actions.setView` (DECISIONS #281 amendment; `UiState.listed`). New test through the palette: open A,
filter to B, pick A again: filters cleared, A shown, notice. An Overview row for the open worktree is not a separate path
(an Overview replaces the open view, so that is the ordinary id-changing case, covered). Mutation checks: no clearing (3
fail), `listed` never synced (3), no notice (2), clearing only when the id changes (1, the reported bug).

## Review follow-up 4 (PR #86 P2, the landing cleared the filters)

The filter-clearing is now `Commands.openView`, used only by explicit picks; `actions.setView` is plain again and the
lagging `UiState.listed` copy is gone (DECISIONS #281, amendment revised). New test through the real UI (only dirty +
two picked worktrees, remove the open worktree so nothing is listed, edit the clean one): the landing opens it, the
filters stay as set, no "Filters cleared" notice. The `n`, auto-advance and `J`/`K` cases now also assert the filters are
untouched. Mutation checks: no clearing in `openView` (3 fail), the landing clearing filters (1, the reported bug),
`J` and `K` each clearing (1 each), `n` clearing (2), no notice (2).

## Review follow-up 5 (CI: `15-ui-status-flow` "a commit keeps the work out of the shelf")

Root cause (DECISIONS #282): an event whose `stateHash` the cached projects list already held skipped the refetch of the
open worktree's file list, which then stayed on the pre-commit state while the row was current; "Review all" sent that
list's hash and the daemon reported "changed meanwhile". Fixed in `api/cache.ts` (`fileListBehind`) and, for the short
refetch window, in the app (`listBehind`: the button is pending, `Shift+R` says the list is refreshing). The spec helper
waits for `data-pending` to go instead of the refresh indicator.

Stress, `pnpm exec playwright test tests/15-ui-status-flow.spec.ts -g "a commit keeps" --repeat-each 20 --workers 1`
(12 cores; load = four `yes > /dev/null` processes, killed by PID):

| | no load | 4 busy processes |
|---|---|---|
| before (c333feb, idle-indicator wait) | 18/20 and 17/20 | 14/20 |
| after, app fix only (old spec wait) | 20/20 | 20/20 |
| after, app fix + `data-pending` wait | 20/20 and 20/20 | 20/20 and 20/20 |

Tests: `cache.test.ts` (an event whose hash the projects list holds still refetches a list that is behind; and refetches
nothing when the list is current), `app.test.tsx` "Review all waits for the open worktree list to catch up with its row"
(the file list held while the worktree changes: button pending, click and `Shift+R` send nothing and say why, then it
sends the fresh list's hash). Mutation checks: no `fileListBehind` (1 fail), `listBehind` false (1), `markAll` unguarded
(1), button not disabled while pending (1).

## Review follow-up 6 (independent review of follow-up 5: one P2, three P3)

- **P2, a first list request in flight** (`cache.ts`): `fileListBehind` now counts an observed list with a request in
  flight; and because react-query only cancels a refetch over existing data, `invalidateFileLists` cancels a first request
  (no data yet) before invalidating, so its older answer cannot land. The app **self-heals**: a list behind its row with
  nothing in flight is refetched once per (row hash, list hash) pair (`useBuildAppModel`).
- **P3, a failed refetch** (`model.listState`): `refreshing` while a request is in flight, `failed` when the refetch for
  this pair ended with the list still behind; the button's title and the notice then say "Could not refresh this worktree's
  file list", a click or `Shift+R` retries. Never "refreshing" when nothing is.
- **P3, the dead commit-scope exemption** (`cache.ts`, `model.tsx`): removed (`listFiles` returns the summary hash in every
  scope); only observed lists count, so an unobserved list no longer sends every same-hash event down the delta path.
  DECISIONS #282 rewritten.
- **P3, the sidebar's "Mark all reviewed / unreviewed"** (`commands.markAllFor`): same guard as the button and `Shift+R`
  (one helper, `commands.listBehind`) when the request includes the open worktree.
Tests (all failing first): `cache.test.ts` (first request in flight, unobserved list), `app.test.tsx` (self-heal; no
loop; failed state, retry and recovery; sidebar menu waits). Mutation checks: fetching not counted (1), no cancel of the
first request (1), unobserved lists counted (1), no self-heal (3), no `failed` state (2), `markAllFor` unguarded (1),
self-heal without the once-per-pair guard (1, with 30 ms latency so a request is visibly in flight).
