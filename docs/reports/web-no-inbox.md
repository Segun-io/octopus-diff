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
- `pnpm --filter @octopus-diff/web test`: **30 files, 423 tests pass** (before this work: 30 files / 416 tests).
- `pnpm build`: pass.
- `pnpm test:e2e` (full, `workers: 1`): first run 101 passed, 1 failed (`15-ui-status-flow` "a commit keeps the work out
  of the shelf", a real race, below); after the fix, final run **102 passed, 0 failed** (3.2 min).
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
