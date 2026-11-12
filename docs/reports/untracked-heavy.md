# untracked-heavy report (roadmap #43, step 25)

## Shipped

- **Measured first** (100k layout, `mono-untracked-heavy`, 30 400 untracked files, git-core directly, on main after
  #40): full summary **1894 ms cold, 1816-1834 ms warm**; `git status` 370 ms and numstat 310 ms of that, the rest
  Node (a CPU profile: about 690 ms of `lstat` of 30k files per summary, then hashing and inspection). Incremental
  edits were already 65-116 ms. Working list **30 701 rows, 7.59 MB JSON** (`/files` 7.73 MiB, the inbox 8.09 MiB).
- **A cap on untracked files** (`packages/git-core/src/untracked-plan.ts`, `GitCoreOptions.maxListedUntracked`,
  default `UNTRACKED_LISTED_DEFAULT` = 2000). Above it an omission plan, a pure function of the set of untracked
  paths, picks what is left out: whole directories first (the deepest one that alone holds the excess, biggest
  first), then a cut in path order. Omitted files are counted (`counts.untracked`, `changedFiles` stay exact), never
  lstat'ed or read, never listed, never in `additions`. In the bench worktree `scratch/many` (30 000) is omitted and
  `scratch/gen` (400, the "real" new files) stays listed.
- **Summary** (`summary.ts`): `WorktreeSummary.untrackedOmitted` (`count`, `limit`, the ten biggest omitted
  directories, each with a copyable `ignoreLine`); the state hash keeps every untracked status line (appear and
  disappear move it) but no signature of an omitted file; the snapshot gets `untrackedOmitted` / `omittedPlan`,
  `total` counts them, `contentHash` covers their paths. Incremental summaries reuse the plan while the set of paths
  is unchanged; the journal and every cached list follow a plan change (lists are seeded again).
- **Lists** (`diff.ts`): every scope that lists untracked files (working, review, branch with `includeWorking`)
  returns the listed ones only, whether it follows the summary state or runs its own status; rows and patches of the
  listed files are byte-identical to an uncapped core (test). `getFileDiff` of an omitted path still works.
- **Numstat alongside the status** in full summaries: at the last state's HEAD when the kept state had tracked
  changes, or on a first summary when the index is at least 4 MiB (HEAD from the ref files); the status header
  confirms the HEAD, a mismatch reruns it. This is what took full summaries under 600 ms (git alone was 680 ms in
  sequence). Never with `incremental: false`.
- **Daemon** (`core.ts`, `review-controls.ts`, `activity.ts`, `bulk-review.ts`): `FilesResponse.untrackedOmitted`
  (the summary's, scopes that list untracked files only); `BulkReviewResponse.untrackedOmitted` (files a
  whole-worktree call could not mark); the activity feed compares coarsely when the omitted set changed (no false
  "deleted" entries) and makes no entry for omitted files, while listed files are compared per file again.
- **Web** (`apps/web/src/components/UntrackedOmittedNotice.tsx`, one render line in `App.tsx`): a one-line note under
  the file pane header: "30,000 untracked files not listed (more than 2,000) in scratch/many/ (30,000). Probably
  build output or dependencies: add this line to .gitignore:" plus the lines with copy buttons.
- **Bench** (`e2e/bench/summary-roles.ts`, a table in `results-large.md`): cold, warm and incremental summaries per
  worktree role through git-core once the daemon is stopped, and the working list's size.

## Verification

All on this machine (12-core WSL2, Node 26, git 2.53), from the repository root, on the branch head.

- `pnpm lint`: exit 0 (4 warnings and 1 info in files this branch does not touch; credits up to date).
- `pnpm typecheck`: exit 0. `pnpm build`: exit 0.
- `pnpm test`: exit 0 (1 min 26 s): contracts 107, forge 101 + 5 skipped, fixtures 58, web 449, git-core 364 + 1
  skipped, daemon 391 + 4 skipped, e2e unit 7, cli 139, scripts 34.
- git-core again: 364 + 1 skipped; daemon again: 391 + 4 skipped (the watcher-review-fixes F1 flake did not show);
  git-core with `OCTOPUS_DIFF_TEST_FOLDS_CASE=1`: 359 passed + 6 skipped.
- `pnpm test:e2e -- --workers=1`: **102 passed (3.2 min)**; read-only proof: 12 control repos, 4688 lock polls,
  **0 violations**. The subcommand allowlist is unchanged (no new git call: numstat is the same `diff --numstat`).
- CI-only steps: `pnpm --filter @octopus-diff/web perf:smoke` exit 0; CLI smoke (`--version`, `doctor`: 0 problems,
  1 warning); package job (`pack:tarball`, `npm install` of the tarball in an empty directory, `--version`, `doctor`:
  0 problems, 1 warning).
- **Acceptance, `bench --layout large`** (committed `docs/bench/results-large.*`):

  | Untracked-heavy worktree (30 400 untracked) | Before (main) | Now |
  |---|---|---|
  | Full summary, cold (new git-core, as at startup) | 1894 ms | **523 ms** |
  | Full summary, warm (kept state) | 1816-1834 ms | **479-492 ms** |
  | Incremental summary, one-file edit | 65-116 ms | 60-64 ms |
  | Edit → SSE through the daemon (p50 / p95) | 103 / 111 ms | 76 / 82 ms |
  | `GET /files` working | 7.73 MiB (30 701 rows) | **182.7 KiB** (701 rows; 21.8 KiB gzipped) |
  | `GET /api/inbox` (three worktrees) | 8.09 MiB | 546.6 KiB |

  Same run: main worktree full summary 447 ms cold / 342-380 ms warm; stale-index 2.5-2.9 s (git re-hashes every
  file there: not this issue). Later edits: 3 git processes to SSE (budget ≤ 3, PASS), edit → SSE p95 77 ms;
  startup spawns 4.7 per worktree (PASS); idle CPU 3.83 % (was 8.50 %); worst traffic per edit 46 KB (was 852 KB).
- Default bench `pnpm --filter @octopus-diff/e2e bench` (30 × 3, UI; committed `docs/bench/results.*`): exit 0,
  every budget passes: cold paint 145 ms, warm reload 61 ms, startup spawns 4.5 per worktree, idle CPU 0.37 %,
  edit → SSE p95 24 ms, → UI p95 40 ms, burst diff p95 37 ms, traffic per edit 1420 bytes, 0 projects requests per
  edit (nothing there is above the cap: the run checks that nothing regressed).
- New tests:
  - `packages/git-core/test/untracked-heavy.test.ts` (15): the plan (deepest sufficient directory, top-level
    fallback, the cut, never more than the cap, order independence, absorbed inner directories, ignore lines and
    escaping); a capped worktree's counts, `changedFiles`, `additions`, `untrackedOmitted`, snapshot fields, three
    scopes from the summary state and from their own status, `getFileDiff` of an omitted file; nothing changes
    below the cap (same state hash and content hash as a core without the option); the state hash and content hash
    move when an omitted file appears or goes, not when it is rewritten; incremental == full across a plan change;
    staged deletion + untracked counted once; listed rows and patches byte-identical to an uncapped core;
    numstat side by side (a git wrapper logging starts and ends): only with a kept state with tracked changes, a
    rerun when HEAD moved, the cold rule above the index size, never with the kill switch.
  - `packages/git-core/test/incremental-fuzz.test.ts`: three new seeds with `maxListedUntracked` 1, 1 and 2 (120
    steps each, about 5 s): summaries (snapshot included) and every list equal a full core's with the same cap after
    every step; asserts the capped mode is hit (44-60 compared steps) and incremental while capped (13-17 steps).
    `FUZZ_SEED` also drives them; 12 more seeds × 2 caps passed (two of them below the coverage thresholds, which
    are tuned for the fixed seeds; equality held at every step).
  - `apps/daemon/test/untracked-heavy.real-git.test.ts` (3): rows, `/files` (per scope), inbox, bulk review (`paths`
    naming an omitted file, mark all, staged scope), the review state; the activity feed when a directory crosses
    the cap, a new omitted file, a listed edit, and the directory leaving.
  - `apps/web/test/untracked-omitted.test.tsx` (3): the notice's text, deduplicated ignore lines, nothing without an
    omission, the field through the client schema.
- Mutation checks (git-core tests + fuzz, daemon test): **killed**: inspect every untracked file anyway; full list not
  filtered; speculative numstat used without the HEAD check; omitted files not in `changedFiles`; omitted paths not
  in `contentHash`; plan always reused; list update not filtered; seed not filtered; coarse activity on a plan change
  removed; `/files` field removed or sent for every scope; bulk count removed or counted with `paths`.
  **Survived, as designed**: the journal's plan check alone and the cached list's plan check alone (either layer
  suffices; removing both is killed by the fuzz). The plan id in the state hash survived (derivable from the hashed
  lines) and was removed.

## Decisions

DECISIONS #305-#314: the contracts (#305); what a summary says and what is lost (#306); the omission plan and the
default cap (#307); lists, a field instead of a placeholder row, plan changes (#308); review and bulk review (#309);
snapshot, activity feed, event deltas, and `truncated` (#310); numstat side by side (#311); untracked cache and
fsmonitor left alone (#312); the web notice and ignore lines (#313); the CLI config key not added (#314). PLAN §5.6
has a paragraph.

## Contract changes

Two `contracts:` commits, additive only. 1727c06: `GitCoreOptions.maxListedUntracked`, `UNTRACKED_LISTED_DEFAULT`,
`UNTRACKED_OMITTED_DIRS_MAX`, `UntrackedOmissionSchema` / `UntrackedOmittedDirectorySchema`,
`WorktreeSummary.untrackedOmitted?`, `FilesResponse.untrackedOmitted?`, `SummarySnapshot.untrackedOmitted?` and
`omittedPlan?`, `BulkReviewResponse.untrackedOmitted?`. 38df2b0: a doc comment on `SummarySnapshot.truncated`
(its meaning below the cap is unchanged, #310). Everything is absent when nothing is omitted.

## Dependencies

None added or removed (`pnpm credits:check`: up to date).

## Known gaps

- **What is lost above the cap** (#306): an omitted file rewritten in place gives no new state hash, no event and
  no activity; omitted files do not move `activityAt`. Their line counts are unknown (they were 0 above 2000 before).
- **Omitted files cannot be reviewed** (#309): a worktree whose listed files are reviewed reads as reviewed. The
  notice and `counts.untracked` keep them visible; the fix is a `.gitignore` line.
- **First summary below 4 MiB of index**: status and numstat still run in sequence (cheap there). The speculative
  numstat costs one wasted process when a worktree that had tracked changes is clean after all, or for a clean
  worktree with a big index at startup.
- **Plan flips**: one more file can move a whole directory between listed and omitted; lists are then seeded again
  (one diff limited to the status paths) and the activity feed records one coarse entry.
- **Not shown on the worktree row or context bar**: only the files pane has the notice (the row and context bar
  belong to another session; the summary carries the field).
- **No detection of git's untracked cache** (#312), and **no CLI config key** (#314).
- **No Playwright spec for the notice**: the web unit test and the daemon test cover it; the e2e suite ran
  unchanged.
- The `--no-ui` 100k edit A/B files (`results-large-edits*`) and `results-large-ci.*` were not regenerated.

## Notes for integration

- Merge order: the `contracts:` commits first (they are separate). DECISIONS numbers #305-#314 may need renumbering
  (another session works on #41).
- #42 (paged files) can add its cursor next to `FilesResponse.untrackedOmitted`; the omitted files are never part of
  any page.
- apps/cli: add `maxListedUntracked: z.number().int().min(1).optional()` to `GitConfigSchema` if users should set it
  in `config.json` (#314).
- Web: the row and context bar can show `summary.untrackedOmitted` too; `UntrackedOmittedNotice` takes the omission
  as a prop.

## PR #91 review follow-up

No P1; five P2 and two P3, all fixed (DECISIONS #315-#322; #307, #309, #310, #311, #313 amended). Tests were
written from the repros first and failed before each fix.

- **P2-1, fake "deleted" activity** (#319, `apps/daemon/src/activity.ts`): `git add` of a file inside an omitted
  directory then `git reset` (or `git rm --cached`) made the feed say "deleted gen/f3.txt". While either snapshot
  has omitted files, a never-committed index addition that leaves the snapshot is one coarse `bulk` entry, never
  "deleted"; without omitted files nothing changed. Tests: the real-git repro for both commands
  (`untracked-heavy.real-git.test.ts`), three `diffSnapshots` unit tests.
- **P2-2, the plan could hide source** (#315, #316, `untracked-plan.ts`): dependency, cache and build-output
  directories (outermost of a path, biggest first) are omitted before anything by size. New contract field
  `UntrackedOmittedDirectory.generated`; the notice says "dependencies or build output" only for those. The
  capped fuzz gets generated names at several depths, an ordinary `src/build` folder and a bidi name.
- **P2-3, ignore lines broader than the directory** (#317): broadened lines (`name/` anywhere,
  `/<path to a build-output component>/`) only when they cover no listed untracked file and no tracked file (one
  `git ls-files -z` per index write, memoized, only when a line could be broadened); otherwise the exact
  `/<dir>/`. Tested with `git check-ignore --no-index` on three real repositories.
- **P2-4, Trojan Source in the notice** (#318): `ignoreLine` is null for names with control, bidi, zero-width or
  other format characters; the web escapes every path and line with `escapeSuspicious` and offers no copy
  button without a safe line. Tests in git-core (unit and a real directory named with U+202E) and web.
- **P2-5, a "reviewed" row hiding omitted files** (#320): the stage logic and `data-stage` are unchanged; a
  reviewed row with omitted files gets its own indicator (`notListed`: tick with a dot, warn colour, label
  "reviewed, N untracked files not listed"), every row and the context bar show `+N not listed`
  (`NotListedMarker.tsx`; title and screen-reader sentence explain), and the bulk toast says "N untracked files
  are not listed and cannot be marked". The existing sidebar and e2e specs passed unchanged.
- **P3-1, two numstats per commit** (#321): the speculative numstat guesses HEAD from the ref files, so a commit
  with changes left costs one numstat, side by side. A commit during the status still reruns it (tested with a
  wrapper holding the status).
- **P3-2, notice text** (#322): each line next to its directory, "and N more" for the rest, and a cut-only
  omission says what happened without a line.

Mutation checks, all **killed**: no generated-first step; broadening without the listed or tracked check (both
forms); the unsafe-character check reduced to C0 controls; the old-HEAD guess; no HEAD check; the `ls-files` scan
without directory names; the activity fix off or without its coarse entry; the notice without escaping, with copy
for suspicious lines, with "build output" on every directory, without the cut-only wording; the toast part; the
merge of `untrackedOmitted`; the `notListed` indicator; the screen-reader text; the row marker. Not covered by a
test: the marker on the context bar (same component as the row's).

Verification (this machine, branch head):

- `pnpm lint`, `pnpm typecheck`, `pnpm build`: exit 0 (lint: the same 4 warnings and 1 info in untouched files).
- `pnpm test`: exit 0. contracts 107, forge 101 + 5 skipped, fixtures 58, web 455, git-core 369 + 1 skipped,
  daemon 395 + 4 skipped, e2e unit 7, cli 139, scripts 34. git-core and daemon again: same counts. git-core with
  `OCTOPUS_DIFF_TEST_FOLDS_CASE=1`: 364 passed + 6 skipped. The commit-race test passed 5 runs out of 5.
- Capped fuzz with the plan shapes: 12 sweep seeds × caps 1 and 2 (`FUZZ_SEED`), 24 runs, all pass (equality at
  every step, coverage thresholds met too); the three fixed capped seeds pass in the suite.
- `pnpm test:e2e -- --workers=1`: 102 passed (3.1 min); read-only proof 12 control repos, 4602 lock polls,
  0 violations. `perf:smoke`: exit 0.
- `bench --layout large` (committed): untracked-heavy full summary **338 ms cold, 299-317 ms warm**, edits 55-57 ms,
  working list 701 rows / 170.9 KiB (`GET /files` 182.8 KiB), inbox 546.6 KiB; main 524 / 414-422 ms; stale-index
  2.4-2.5 s (git re-hashes every file). Later edits: 3 git processes to SSE (PASS), edit → SSE p95 78 ms; startup
  spawns 4.7 per worktree (PASS); idle CPU 2.68 %. The untracked-heavy role's edit → SSE max was 268 ms on one
  edit (75 ms p50), not traced. The faster summaries compared with the first run (523 / 479-492 ms) are within
  this machine's run-to-run spread; nothing in this round should have made them faster.
- Default bench (30 × 3, UI, committed): every budget passes: cold paint 142 ms, warm 67 ms, startup spawns 4.5,
  idle CPU 0.33 %, edit → SSE p95 22 ms, → UI 33 ms, burst diff p95 45 ms, traffic per edit 1421 bytes, 0 projects
  requests per edit.

Known gaps added: a folder named `build`, `out`, `dist`, `target` or `coverage` that holds real source is omitted
whole when the worktree is above the cap (#316); the `ls-files` scan for broadened lines costs one process per
index write in capped worktrees with such directories (#317); the context bar's marker has no test of its own.

## Greptile review (PR #91)

- **P1, edits vanished from the totals** (DECISIONS #323, #324; #311, #321 amended): numstat alongside the status is
  no snapshot. Paths the kept state signs are signed before numstat starts; once both are done, every signed path is
  trusted only if its signature did not move or its ctime predates the summary's start by 2 s (never a gitlink).
  Unproven paths get a numstat limited to them and the rename candidates, after the status (the whole numstat where
  limited runs are not equivalent: conflicts, submodules, sparse checkouts; the fuzz found the conflict case on the
  first try). The kept state stores a sentinel for any path whose signature moved after those reads, so the next
  incremental refresh diffs it again. Tests (failing first, a git wrapper that holds numstat or the status): an edit
  after the early numstat read and before the status, then an incremental refresh of another file; an edit during a
  numstat after the status with its event lost; a submodule commit during the status with the margin off; 8 rounds
  of edits while summaries run. Mutations killed: trusting the early result; trusting every known path; trusting
  every ctime; no sentinel; limited reruns where they are not equivalent; gitlinks trusted by ctime.
- **P2, directory counts above the total** (#325): omitted paths counted as tracked changes leave the directory
  counts too. The capped fuzz checks after every step that the counts never add up to more than the total and that
  each equals the untracked rows an uncapped list has under the directory. Mutations killed: no dedupe; empty
  directories still reported.
- **What the fix costs**: measured on the 100k layout's untracked-heavy worktree, a full summary with nothing edited
  in the last 2 s 416-446 ms, with a file edited just before 423-430 ms (one numstat limited to it, about 10 ms;
  afterwards that path is trusted by its signature). A daemon's **first** summaries of worktrees whose files were
  written seconds before rerun a numstat limited to their changed paths: in the large bench (fixture generated just
  before) startup took 6 `diff` processes for 3 worktrees instead of 3, 5.7 spawns per worktree instead of 4.7
  (budget ≤ 8, PASS). Serial status then a limited numstat of all 300 changed paths would have cost about 200 ms on
  every full summary, so the overlap stays.

Verification (this machine, branch head):

- `pnpm lint`, `pnpm typecheck`, `pnpm build`: exit 0 (lint: 4 warnings and 1 info, in untouched files).
- `pnpm test`: exit 0. contracts 107, forge 101 + 5 skipped, fixtures 58, web 455, git-core 373 + 1 skipped,
  daemon 395 + 4 skipped, e2e unit 7, cli 139, scripts 34. git-core and daemon again: same counts. git-core with
  `OCTOPUS_DIFF_TEST_FOLDS_CASE=1`: 368 passed + 6 skipped. The race and side-by-side tests: 3 more runs, all pass.
- Capped fuzz (plan shapes and the new count invariants): 12 sweep seeds × caps 1 and 2, 24 runs, all pass; the
  four main seeds pass again after the conflict fix.
- `pnpm test:e2e -- --workers=1`: 102 passed (3.7 min); read-only proof 12 control repos, 5064 lock polls,
  0 violations. `perf:smoke`: exit 0.
- `bench --layout large` (committed): untracked-heavy full summary **424 ms cold, 404-423 ms warm** (< 600 ms),
  edits 55-59 ms, `GET /files` 182.8 KiB, inbox 546.6 KiB; main 383 / 273-282 ms; stale-index 2.5 s. Later edits:
  3 git processes to SSE (PASS), edit → SSE p95 78 ms (untracked-heavy 77 / 81 ms); startup spawns 5.7 per worktree
  (PASS, see the cost above); idle CPU 3.37 %. Three runs of this bench on this branch gave 523/479-492,
  338/299-317 and 424/404-423 ms for the untracked-heavy worktree: the spread between runs is larger than what the
  check adds.
- Default bench (30 × 3, UI, committed): every budget passes: cold paint 143 ms, warm 64 ms, startup spawns 4.5,
  idle CPU 0.27 %, edit → SSE p95 25 ms, → UI 41 ms, burst diff p95 38 ms, traffic per edit 1421 bytes, 0 projects
  requests per edit.

## Greptile, second pass (PR #91)

- **A broad line hid a listed nested repository** (DECISIONS #326): listed nested repositories now reach the
  ignore-line check as directory entries (`a/node_modules/`), and tracked gitlinks count as directories
  (`ls-files -z --stage`). Tests: real-git `check-ignore` for the repro (failing first: `a/node_modules/` was
  ignored), a tracked `vendor/node_modules` repository, names with spaces and `[`/`#`; a unit table. Mutations
  killed: the `/` dropped for directory entries; gitlinks read as files.
- **The bench's summary table ignored `--no-incremental`** (#327): `summaryRoles(…, incremental)` creates its core
  with the run's setting and reports each edit's refresh mode. Unit test (`e2e/support/summary-roles.test.ts`):
  `incremental` true gives incremental edits, false gives full ones (folding-aware); the mutation dropping the
  setting is killed. Not re-run as a large `--no-incremental` bench (its stale-index edits take about two minutes
  each, #40's A/B); the unit test is the check.

## Follow-up: list and notice from one state (branch `fix/files-omission-snapshot`)

Greptile's last, non-blocking comment on PR #91: `GET /files` took `stateHash` and `untrackedOmitted` from the
summary before the review scope's resolution and the list from the summary after it, so a refresh in between
(crossing the untracked cap, either way) mixed two states. The list, its labels, inbox rows and bulk review now come
from the one summary the list was built for, with one retry when it moved meanwhile (DECISIONS #339). Seven
real-git tests with a gate on git-core calls, all failing on the previous code; mutations killed except two
redundant layers named there.

Second Greptile pass on that branch (PR #95): a refresh could overtake the retry as well, and git-core then listed the
worktree as it is now while the daemon labelled the list with the summary it had asked for. git-core now reports the
state it listed (`listChangedFilesWithState`, a `contracts:` commit); the daemon labels and caches only by that
state, tries up to three times, and otherwise labels the list with git-core's own omission and a `stateHash` no
summary has, leaves the inbox row out, and reports bulk review stale (DECISIONS #340, #341). Five new real-git
tests, crossing the cap twice and three times.

Third pass on PR #95: the inbox no longer leaves out a row it could not list (a first load whose events came before
the answer would never have asked again); it sends the row marked `listing: 'overtaken'` with its latest summary and
no files, and the web asks for it again with a bounded backoff (DECISIONS #342, #343). The macOS-only numstat test
failure got `ageFiles()` and diagnostic messages (#344); its symptom (`numstats: 0`) did not reproduce here.
