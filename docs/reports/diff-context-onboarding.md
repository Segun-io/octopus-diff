# diff-context-onboarding report

Branch `fix/diff-context-and-onboarding`, from `main` at `90c7cff`. Decisions: `docs/DECISIONS.md` #154–#161
("Diff context errors, first-run Continue and add feedback"). Web and e2e only: no contract, daemon or git-core
change.

## Shipped

### A. Diff viewer: "More context" / "Expand all" errors

- **"deletionLine and additionLine are null, something is wrong"** (root cause, #154): while a new context or
  whitespace view loads, the diff query shows the previous view's patch as placeholder data, but the highlight
  cache key was built from the options *asked for*. The old patch was highlighted and cached by the worker pool
  under the new key, and the real patch then rendered with the shorter patch's highlighted lines. Fix:
  `useDiffQuery` (`apps/web/src/api/queries.ts`) returns `DiffQueryData` = the response plus `view`
  (`diffViewKey(params)`) and `params`; `DiffPane` keys the renderer with `patchHash:view:patch.length`.
- **"Could not load this diff … expected number to be less than or equal to 1000000"** (#155): the real limit is
  `DIFF_CONTEXT_MAX = 1_000_000` (contracts, and git-core's own check). "Expand all" set exactly that and "More
  context" / `e` added 20 to it. Now `state/diffContext.ts` has `FULL_CONTEXT` (= `DIFF_CONTEXT_MAX`),
  `clampContext`, `nextContext` (never above the maximum) and `patchShowsWholeFile` (is every line already shown?).
- **Controls** (`components/diff/DiffPane.tsx`, `state/commands.ts`, #156): "More context" is disabled while the
  previous view is still on screen (`aria-busy`) and once the whole file is shown ("The whole file is already
  shown"); "Expand all" becomes "Collapse" when everything is shown, and is disabled when the default context
  already shows everything. The `e` key follows the same rules and says so in a notice. "Expand all" / "Collapse"
  set absolute values, so rapid clicks settle on the last one. The whitespace toggle and "Load anyway" (`full`)
  go through the same keyed path; split/unified only changes render options.

### B. First run: a way to continue, and the app appears without a reload

- **Root cause of "nothing changes until I reload"** (#158): watching a folder returns at once and scans in the
  background; the UI learnt the outcome only from server events. With a working event stream the switch happened
  (checked by hand through the daemon and through the Vite dev proxy), but with the stream down or late the
  first-run screen stayed until a reload: reproduced in e2e by aborting `/api/events`. The second half of the
  report: the main action was a small "Watch Enter" chip inside the text box, and a click on a folder only opens
  it, so picking a folder changed nothing visible.
- **Fix:** `components/AddJobStatus.tsx` `useAddJobWatcher` (mounted once in the shell) polls the scan roots every
  second while a folder is being scanned, refetches the projects as soon as the folder has some (the app replaces
  the first-run screen at the first repository) and marks the scan done when `lastScannedAt` moves.
- **Continue button** (`components/AddProjectForm.tsx`, #157): the form ends with a selection line ("~/code has 3
  repositories directly inside.") and a primary button, "Continue" on the first run ("Watch this folder" / "Add
  this repository" / "Open it" elsewhere), disabled until the text points at something valid (a missing or
  unreadable folder included, `FolderBrowser.tsx` `canSubmit`). The other action is a ghost button next to it.
  The first-run text box is focused, and the intro says "then press Continue".

### C. Add / watch feedback

- `state/addJob.ts` (#159): one add job in the UI store (`addJob`), pure `describeAddJob` / `folderJobOutcome`.
  States: working (spinner, "Looking for repositories in ~/code…", "120 folders checked, 2 repositories found so
  far."), success ("Watching ~/code: 3 repositories found" with the first five names, or "Added app", "3 worktrees,
  all shown in the sidebar."), empty ("No repositories found in ~/code", "Looked 3 levels deep. The folder stays
  watched…", buttons "Choose another folder" and "Stop watching"), error ("Could not add …" + the daemon's
  message). Next step buttons: "Open <name>" / "Show folder".
- Shown as a panel in the add form (first run, Add dialog, Settings → Folders) and as a toast (`AddJobToast`) once
  no add form is on screen, so it survives the first-run screen going away and the dialog or palette closing.
  Success toasts hide after 10 s. The palette's old "Watching … Scanning…" notice is replaced by the toast.
- `SpinnerIcon` in `components/bits.tsx`; the notice container got `data-testid="notice"`.

### Tests

- Unit: `apps/web/test/diff-context.test.ts` (7: clamping, 60 000 steps stay valid at the API boundary,
  `patchShowsWholeFile` on multi-hunk / head-only / whole / added / deleted / binary / typechange patches,
  `diffViewKey`), `apps/web/test/add-job.test.ts` (8: scan outcome, re-watch, errors per folder, every summary).
- e2e: `e2e/tests/17-diff-context.spec.ts` (2: rapid More context / Expand all / whitespace with delayed diff
  responses, no console error, every requested context ≤ 1 000 000; More context stops at the whole file, `e`
  sends no request, Collapse goes back). `e2e/tests/18-onboarding.spec.ts` (5: first run Continue → app appears
  without a reload + success toast + Show folder; empty folder → panel, Stop watching, then a single repository;
  the app appears with `/api/events` aborted; Add dialog watch shows "2 repositories found" + names; an error
  for a path that is not a repository, cleared by typing).
- Checked that the tests catch the bugs: with the old cache key (built from the requested options) the first
  `17-diff-context` test fails with 98 "deletionLine and additionLine are null" errors; with the scan watcher
  disabled, the "event stream down" test fails (the first-run screen stays).

### Review round (PR #7) and merge with `main` (#161)

- Merged `main` (toolbar hierarchy, PR #2): the diff header keeps `main`'s layout with this PR's More context /
  Expand all rules; DECISIONS renumbered #112–#118 → #154–#160.
- Greptile P1 "old results finish new scans": `scannedSince` requires a `lastScannedAt` strictly later than
  the one the watch request returned.
- Greptile P1 "closing progress stops fetching": `UiState.scanFollows` tracks running scans apart from the
  job's message; `useAddJobWatcher` polls while any is open, so dismissing or replacing the toast keeps
  fetching.
- Greptile P2 "partial diffs look complete": the `e` / More context command skips the whole-file test for a
  truncated patch.
- New unit tests in `apps/web/test/add-job.test.ts` (`scannedSince`, `scanFollowDone`, an older cached
  timestamp). No e2e for dismissing a running toast: the fixture scans finish in well under a second.

## Verification

Run on this branch, 2026-11-09:

- `pnpm lint`: pass (Biome: 402 files, no fixes; credits up to date).
- `pnpm typecheck`: pass (every package).
- `pnpm build`: pass.
- `pnpm test`: run 1 failed 1 test in `apps/daemon/test/status-flow.real-git.test.ts` ("a file reviewed
  uncommitted stays reviewed after the agent commits it"), which passed 3/3 when run alone; run 2 failed the known
  git-core `readonly.test.ts` 5 s timeout (DECISIONS #111); run 3 passed everything: contracts 83, forge 94 (+4
  skipped), git-core 170, fixtures 48, web 224, daemon 187, e2e unit 5, cli 139. This branch changes neither
  package; both are load-dependent flakes when every package runs in parallel.
- `pnpm test:e2e` (full suite): first run 89 passed, 1 failed: `18-onboarding` "adding a path that is not a
  repository" clicked "Add as one repository" while the folder listing was still loading, when Add is still the
  main action, so it watched instead (a test race: the buttons swap actions once the path's kind is known). The
  spec now waits for the main button's `data-action` before every folder click; `17-diff-context` +
  `18-onboarding` then passed 3/3 in a row, and the full suite rerun passed: **90 passed (3.5 min)**, read-only
  proof 12 control repos, 5127 lock polls, 0 violations.
- After the merge with `main` and the review fixes: `pnpm lint`, `pnpm typecheck`, `pnpm build` pass;
  `pnpm test` passes (web 239, daemon 199, git-core 176, cli 139, forge 94 + 4 skipped, contracts 83, fixtures
  48, e2e unit 5). `pnpm test:e2e`: first run 88 passed, 2 failed (`16-copy` "the selection clears when another
  file opens" and "a text selection in the code copies only the code"; both passed in a 9/9 rerun of
  `16-copy` alone, load-dependent, not code this PR touches), second full run **90 passed (3.5 min)**.
- Targeted while developing: `17-diff-context` + `18-onboarding` + `01-projects` + `12-ui-review-policy`, all
  passing.

## Decisions

DECISIONS #154–#161: the cache key is the fetched view; context clamped and stopped at the whole file; no stacked
context requests; a "Continue" main button; scan polling during an add job as the fallback for the event stream;
one add job shown in the form or as a toast; the stale-listing gap; the PR #7 review fixes and merge (#161).

## Contract changes

None. `FULL_CONTEXT` reuses `DIFF_CONTEXT_MAX`; new test ids are web-local strings (`diff-more-context`,
`diff-expand-all`, `add-job-status`, `add-job-toast`, `add-job-action`, `add-selection`, `notice`).

## Dependencies

None added or removed (`pnpm credits:check` passes).

## Known gaps

- The diff context fix keys the highlight cache by view; @pierre/diffs itself still throws when it gets a cached
  highlight that does not match the patch. Any future caller that sets `cacheKey` must key it by the patch it
  renders.
- "Whole file shown" is inferred from the patch (one hunk from line 1, short trailing context). When exactly
  `context` lines follow the last change, one more "More context" click is needed before the button disables.
- Scan errors reach the job only through `scan.progress` events (the scan roots API has no error field), so with
  the event stream down a failed scan keeps the spinner ("Big folders can take a while"); the folder still shows
  up once a later scan works.
- Folder listings can be stale for their short cache life (#160): a folder created while its parent is listed is
  "No folder named …" until the listing refetches.
- The user's own setup could not be observed: with a healthy event stream, the app already switched after
  "Watch" in every setup tried here (built daemon, Vite dev proxy). The fix covers both the missing main button
  and the event-only dependency.
- README screenshots were not regenerated (the first-run screen is not in them).
- While the folder listing loads, the path's kind is unknown and the main button is "Add"; it becomes "Watch" /
  "Continue" a moment later. A very fast click can hit the other action (seen only in e2e).

## Notes for integration

- Web + e2e only; no lockfile or contract change. Sidebar, Inbox and the global fetching / stale-time setup are
  untouched: the scan polling is a local `useQuery` with `refetchInterval` that runs only while an add job scans.
- `DiffQueryData` adds `view` and `params` to cached diff data; `api/cache.ts` spreads cached data when it patches
  review state, so they survive. Anyone writing diff data into the cache by hand must keep them.
- e2e `18-onboarding` starts its own empty daemons (like `01-projects`); `17-diff-context` edits `src/stable.ts`
  of the mutable `live` fixture and restores it.
