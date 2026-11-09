# status-flow report

Lead session, branch `feat/status-flow` from `main` at `984f2ad`, 2026-11-09. Design: `docs/STATUS-FLOW.md`
(agreed with the user). Decisions: `docs/DECISIONS.md` "Status flow v2" #81–#100. The git-core primitives were
delegated to a child session on `status-flow/git-core` and cherry-picked (#97).

## Shipped

**Step 1 — stages, vocabulary, no pulse (web).**
- `apps/web/src/lib/model.ts`: `stageOf()` / `placeOf()` (`blocked | review | reviewed | inPR | merged | closed |
  off`), `rowState()` on top; rows carry `data-stage`, `data-unreviewed`, `data-commits`. The sidebar's status
  comes from a fixed source (`summary.review`, else a fixed `working` inbox), never from the toolbar scope
  (`state/model.tsx` `SIDEBAR_STATUS_SCOPE`).
- One verb: "Reviewed" / "Review all (⇧R)" / "Mark all reviewed"; no UI string contains "verif".
- Settle → "Hide until it changes" / "Show again" / "Keep under its project" (same per-device mechanics).
- The activity pulse is gone (`.od-pulse`, keyframes, `isRecentlyActive`, `useClock`, the indent it needed).
- Toolbar scope is a filter with counts: `To review (n) · All on branch (n) · Uncommitted (n) · Staged · Unstaged ·
  Commit…`.
- `pnpm dev:mock` import cycle fixed (`state/diffContext.ts`).

**Step 2 — bookmarks.**
- Contracts (`87e3889`): scope `review { base? }`, `branch.includeWorking`, `WorktreeSummary.review`,
  `PUT /api/review/bookmark`, event `review.bookmark`, bulk `advanceBookmarks`, optional
  `GitCore.readReviewRange / describeCommits / rangePatchId`.
- git-core (`667286c`, `15253d9`): the review scope (working tree vs a base commit), All on branch, the review
  range, commit details (patch-id + touched paths, `--cc` for merges), range patch-id; `patch-id --stable`
  allowlisted; stdin only for `check-attr --stdin` and `patch-id`.
- Daemon (`dd18bad`): migration v3 (`bookmarks`, `reviewed_commits`), `review-state.ts`, review state per worktree
  in `core.ts` (cached per state hash + review version, computed before `worktree.changed`), `scope=review`
  resolution in files / diff / inbox / bulk, `moveBookmark` + undo, `ReviewControls.setBookmark`, bulk
  `advanceBookmarks`.
- Web (`75cebce`): To review is the default scope (falls back to Uncommitted on older daemons), rows say
  `N commits ·`, Review all in To review moves the bookmark (undo restores it), All on branch includes the working
  tree, hover card "Reviewed: up to abc1234 · history rewritten"; the mock backend has an opt-in `statusFlow` mode.

**Step 3 — no double review (`68df919`).** Marks keyed by `(project, path, patchHash)` whatever the scope kind (no
migration; old rows readable). A bookmark move to HEAD records each commit's id and patch-id plus the range's
patch-id. In a range, commits reviewed by id or patch-id, clean merges and empty commits bring nothing; files only
they touched show as reviewed. Fast-forward, merge commit, squash, rebase and reset all skip reviewed content;
conflict resolutions still show.

**Step 4 — forge stages (`473330e`).** In PR (open, non-draft, nothing new; `#42 · checks ✓`
/ `changes requested`) under its project; Merged / Closed for this HEAD with nothing uncommitted to the shelf;
merged with uncommitted work stays out (`merged · 2 files`); drafts are Reviewed; forges off → never applies.

## Verification

All from the worktree root, on Node 26 / pnpm 12 / git 2.53.

| When | Command | Result |
|---|---|---|
| step 1 (`88c701a`) | `pnpm check` | green: contracts 81, forge 94 (+4 skipped), git-core 144, fixtures 48, web 173, daemon 173, e2e unit 5, cli 139 |
| step 1 | `pnpm test:e2e` (playwright, full) | 70 passed, 3 failed (two in the new spec: locator/console guard; one in spec 12: the pill's title helper). Fixed, then specs 12 + 15 re-run: 7/7 passed |
| step 2 (`75cebce`) | `pnpm check` | green: contracts 83, git-core 170, web 174, daemon 180, … |
| step 2 | `pnpm test:e2e` (full) | 68 passed, 6 failed: scope/title specs written against the old meaning (title = uncommitted count, All on branch = committed only) and a worktree lookup in the new spec. Specs updated (#94); the six specs re-run: 26 passed, 1 failed (`n` in spec 12 needs To review), fixed, spec 12: 4/4 |
| step 3 (`68df919`, step-4 files set aside) | `pnpm check` | green after updating two fake-git-core tests that asserted per-scope-kind keys: daemon 187, web 174 |
| step 4 (`473330e`) | `pnpm check` | green: contracts 83, forge 94 (+4 skipped), git-core 170, fixtures 48, web 175, daemon 187, e2e unit 5, cli 139 |
| final | `pnpm test:e2e` (full, 15 specs) | **74 passed, 0 failed (2.9 min)** |
| final | `pnpm --filter @octopus-diff/e2e screenshots` | regenerated inbox, diff split/unified, folder picker, palette browse, help (light + dark) |

New tests: `apps/web/test/model.test.ts` "stages" (every row of the §2.2 table incl. forge stages, hide/show,
wording, no scope input), `ux.test.tsx` "switching the toolbar scope never moves a sidebar row" and "status flow:
To review is the default …"; `apps/daemon/test/status-flow.real-git.test.ts` (11 tests: bookmark init on main and
branches, commit-then-already-reviewed, Review all + undo + PUT validation, history rewritten + restart, marks
across scopes, fast-forward, merge commit, squash, rebase, reset, conflict resolution); `review-units.test.ts`
(store v3, keys, coverage); git-core `test/review.test.ts` (23 tests) and the read-only proof extended to the new
reads; contracts schema tests; e2e `15-ui-status-flow.spec.ts` (acceptance 1, 2, 3 ff + squash, 5, 6). The
read-only proof (git-core `readonly.test.ts` and the e2e global teardown) passes.

## Decisions

DECISIONS #81–#100. The main ones: sidebar fallback source is a fixed `working` inbox, not branch + working (#81);
Reviewed with no PR sits in the shelf, the plan's default (#82); the review scope is one combined patch per file,
so committing a reviewed file keeps its mark and there are no section headers (#89); To review means unreviewed
files, commits count through their files (#92); Review all sends no `paths` in To review (#93); default scope
`review`, e2e helper seeds `working` (#94); marks are scope-independent without a migration (#95); reviewed commits
and the range patch-id (#96); forge stage order (#98); PLAN updated (#100).

## Contract changes

One `contracts:` commit (`87e3889`), additive only, DECISIONS #88: `DiffScope` kind `review`, `branch.includeWorking`,
`scope`/`base`/`working` query fields, `scopeKey` forms, `WorktreeReviewSchema` + `WorktreeSummary.review?`,
`SetBookmarkRequest/Response` + route `setBookmark` + client method, `ReviewBookmarkEvent`,
`BulkReviewRequest.advanceBookmarks?`, `BulkReviewResponse.bookmarks?`, optional `GitCore` methods and their types.
Nothing renamed or removed; `ReviewRequest.scopeKind` keeps its meaning as "where the mark was made".

## Dependencies

None added or removed; `pnpm credits:check` passes inside `pnpm lint`.

## Known gaps

- No e2e for In PR / Merged (spec 14's fake `gh` serves open requests only); unit-tested in `model.test.ts`.
- No "commits / uncommitted" section headers in To review (#89).
- No automatic bookmark advance when a whole range is already reviewed; a PUT to a non-HEAD commit records no
  commits (#96, #99).
- A range over 500 commits counts every file (coverage unknown).
- In the review scope with an older base, an untracked file at a path that differs from the base is listed once,
  as the tracked change (git-core, #97).
- `03-scopes` "the scope selector switches the file list" was flaky on `main` before this round (#70).

## Notes for integration

- Fast-forwards onto `main` (no `main` movement since `984f2ad` at the time of writing; see the end of this file).
- The state database migrates to v3 on first start; older daemons refuse a v3 database (as for v2).
- The web works against older daemons: no `summary.review` → fixed working inbox, To review disabled.
- e2e: `AppPage.open` seeds `defaultScope: 'working'`; specs that need To review pass prefs explicitly.
