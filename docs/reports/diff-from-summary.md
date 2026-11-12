# diff-from-summary report (roadmap #41, step 24)

## Shipped

- **`getFileDiff` from the summary state** (`packages/git-core/src/diff.ts`, `diffFromSummary`). The summary track git-core
  keeps per worktree (#285) answers the identification that used to need a whole-repository `git status` and `git diff --raw`.
  A tracked file is now **one** `git diff <base> --raw --numstat -z -p -U3 -- <path>` (the same argv the whole route's narrowed
  patch run already used: pins, `--no-ext-diff --no-textconv`, literal pathspec after `--`), an untracked file **no** git process
  (its inspection; `check-attr` once per file where an attributes source exists). With view options (`ignoreWhitespace`,
  `contextLines` other than 3) a tracked file is two (canonical for the hash, then the view). Images add their `cat-file`s as before.
- **One description path.** Both routes end in `describeTracked` / `describeUntracked` (extracted from `getFileDiff`), so identity,
  patch text, `patchHash`, `images`, `byteLength` cannot differ by construction; the tests prove it.
- **When the state vouches** (DECISIONS #331): `incremental` on; no case-folding filesystem; a track exists and is the state the caller holds
  (`DiffOptions.summaryState`, new use of the existing field, `contracts:` doc comment only; the daemon passes `entry.gitStateHash`);
  `trackBlocker` empty (no conflicts, submodules, gitlinks, nested repositories, sparse checkout, unreadable files); valid UTF-8 path;
  stamp and HEAD as the state saw them; then the file's own record: a modification (`M.`, `.M`, `MM`), a deletion while no path is added
  anywhere (no rename partner), an untracked file that is not also a tracked entry nor a rename source; against another base than HEAD
  only a modification or untracked file the commits since the base left alone (`diff-tree`, memoized with the lists'). The lstat
  signature (the inspection's `statSig` when untracked) must equal the state's before the read and after it; for an untracked file the
  ignore rules recorded by the summary (every ancestor `.gitignore`, absent ones included, and `core.excludesFile`) must be unchanged
  (DECISIONS #334, PR #93 review). The checks (stamp, HEAD, signature) run
  **beside** the one `git diff`, in one round of file system calls, and the file's signature is read once more after it (DECISIONS #332);
  doing them one after the other made a diff opened during a 60-edit burst cost 74-79 ms at p95 instead of 33 ms, because under load each
  round waits in the 4-thread pool behind the summaries' stats. Anything else, and a failed `git diff`, falls back to the old whole
  route with a reason (`fileDiffRoutes.reasons`, process-wide counters for tests and diagnostics).
- **Daemon** (`apps/daemon/src/core.ts`): `getDiff` passes `summaryState: entry.gitStateHash` (when incremental). No other daemon change:
  no result cache (there is nothing to poison; see Known gaps).
- **Bench** (`packages/git-core/test/bench/diff-open.bench.ts`, documented in `docs/bench/README.md`): wall time and spawns of `getFileDiff`
  per worktree role and file kind on the large layouts; `OCTOPUS_DIFF_BENCH_OLD=1` reads diffs with a core that has no summary route
  (the "before" column; the summaries and lists still come from the default core, because a full list of the stale-index worktree takes 95 s).

## Verification

All from the repository root on this machine (12-core WSL2, Node 26, git 2.53; another agent's tests ran concurrently, so absolute
times carry some noise).

- `pnpm lint`: exit 0 (biome: 4 warnings and 1 info, all in files this task does not touch: `apps/web/test/cache.test.ts`,
  `apps/daemon/test/file-origins.real-git.test.ts`; credits up to date). `pnpm typecheck`: exit 0. `pnpm build`: exit 0.
- `pnpm test`: exit 0. contracts 107, forge 101 (5 skipped), fixtures 58, web 446, **git-core 389 (1 skipped)**, **daemon 391 (4 skipped)**,
  e2e unit 7, cli 139, scripts 34. git-core and daemon were run twice more on the final code with the same counts (the known
  watcher-review-fixes F1 flake did not show). One run failed `incremental.test.ts` "an untracked file: one status" (the speculative numstat
  of a new path started after the summary had settled, under the load of the whole suite running at once; it passes alone and is
  unrelated to this change): that test now waits for the process to start, like the other load-flake fixes (`6b16055`).
- `OCTOPUS_DIFF_TEST_FOLDS_CASE=1`: git-core 375 passed + 15 skipped; daemon 389 passed + 6 skipped. The new golden tests run in this mode
  and assert `case-insensitive` plus byte equality; the races suite is skipped there.
- `pnpm test:e2e` (1 worker): **102 passed (3.2 min)**, read-only proof 12 control repos, 4720 lock polls, 0 violations (the subcommand
  allowlist is unchanged). `perf:smoke`: exit 0. CLI smoke (`--version`, `doctor`): 0 problems, 1 warning. `.github/workflows/ci.yml` also has the
  macOS job (`pnpm -r --workspace-concurrency=1 run test`: not run; emulated with `OCTOPUS_DIFF_TEST_FOLDS_CASE=1` above) and the tarball
  package job (`pack:tarball` + `npm install` of the tarball in an empty directory): not run here, no package or dependency changed.
- Default bench (`pnpm --filter @octopus-diff/e2e bench --out /tmp/...`, 30 x 3, written outside the repo so the committed results stay as
  they are): every budget passes: cold paint 156 ms, warm reload 78 ms, startup spawns 4.5 per worktree, idle CPU 0.33 %, edit -> SSE p95
  22 ms, **diff during a 60-edit burst p95 33 ms** (quiet p50 5-6 ms; 74-79 ms with the first version of the checks, 27 ms with no re-check at all).
- New tests (git-core): `diff-from-summary.test.ts` (golden/differential, 30: modified, staged only, staged + unstaged, deleted, staged
  deletion, mode change, symlink, binary, whitespace only, CRLF, no final newline, very large, spaces and Unicode, non-UTF-8 names, image,
  untracked of every kind, rename, copy-like addition, type change, intent-to-add, conflicts, submodule, embedded repository, nested repository,
  rename source, deletion beside a staged addition, review/branch scopes and older bases, no state, kill switch, stale signature, index, HEAD,
  config and `summaryState` moved, unreadable file; each compares the whole `GitFileDiff` or the same error with a reference core that has no
  summary route, and asserts the route taken and, where it matters, the git argv and process count), `diff-from-summary-races.test.ts` (10:
  edit after git read, edit before git read, restore to HEAD while read, `git add` while read, a summary replacing the state while the patch
  run is held, a file becoming unreadable while git reads, an aborted call stops without starting the fallback and the next call is right, a call
  aborted before it started never reaches git, a failure leaves the state usable), `diff-from-summary-fuzz.test.ts` (fuzz in the style of
  `incremental-fuzz.test.ts`: 3 seeds x 60 steps by default, shared operations in `helpers/fuzz-ops.ts`; after each step the state is brought up
  to date, left behind, or fed fewer paths than were touched, then every changed file of a random scope (working, review against the first commit
  and against HEAD, branch + working) and random other paths are asked under random view options of the fast core and the reference core,
  byte for byte; the summary route answers about a quarter to two fifths of them: seeds 0xd1ff01-3: 109/401, 70/372, 199/445).
  Sweep: 11 extra seeds x 100 steps (11 22 33 44 55 66 77 88 99 1234 5678) pass; the fuzz found the rename-source case on its first run
  (DECISIONS #331), now a golden test. Daemon: `diff-from-summary.real-git.test.ts` (3: one `diff` for a tracked file, none for an untracked
  one, same bytes and the list's `patchHash`; opened right after an edit, before the summary has seen it; `incremental: false` runs `diff,
  status, diff`).
- Mutation checks (each makes a test fail unless noted): track blocker, stamp, HEAD, both signature checks, rename partner, rename source,
  `.gitignore` check, committed-since-base, base-deletion rule, tracked-and-untracked, kill switch, `summaryState`, untracked `statSig`,
  content-read clause, git-failure fallback, added files vouched, renames vouched: all killed; case probe killed with
  `OCTOPUS_DIFF_TEST_FOLDS_CASE=1`. **Survivors, by design** (DECISIONS #333 d): the predicted-status check, the one-raw-entry check and the
  stat-only check are defense in depth behind the signature checks; reaching them needs a file whose size, mtime, ctime and inode all
  stayed the same.
- Bench, `packages/git-core/test/bench/diff-open.bench.ts`, 15 rounds, summary state held, median (first call in brackets):

  | 100k files, `getFileDiff` working scope | before: ms, git processes | after: ms, git processes |
  |---|---|---|
  | main, a modified file | 393 (398), 3 | **16 (24), 1** |
  | main, an untracked file | 378 (373), 2 | **2 (2), 0** |
  | main, the 300k-line rewrite | 683, 3 | 288 (301), 1 (git's own diff of 300k lines) |
  | stale-index, a modified file | 825 (832), 3 | **16 (17), 1** |
  | stale-index, an untracked file | 823, 2 | **2 (2), 0** |
  | untracked-heavy (30.7k untracked), a modified file | 389 (399), 3 | **15 (17), 1** |
  | untracked-heavy, an untracked file | 395 (403), 2 | **19 (35), 0** (the first call runs `check-attr` once) |

  20k files (`large-ci`): modified 101 / 169 / 162 ms before, 6 / 6 / 6 ms after; untracked 96 / 164 / 202 ms before, 2 / 1 / 5 ms after.
  **Acceptance: at most 1 git process and under 40 ms is met for every ordinary file** (tracked 15-16 ms, untracked 2-19 ms, first calls
  17-35 ms). It cannot be met for a patch whose own `git diff` takes longer: the 300k-line rewrite costs git 288 ms (1 process, 42 % of
  before). The 137-154 ms in the issue were measured on another machine and layout; here the same call cost 346-832 ms before.
  The "before" column is a core with no summary route (`OCTOPUS_DIFF_BENCH_OLD=1`); a first, unloaded run gave 346 / 804 / 354 ms.

## Decisions

DECISIONS #330-#333: the route and its scopes (#330); when the state vouches, and the rename-source case the fuzz found (#331); races and
consistency with the list and the review marks (#332); the `.gitignore` window and `Stamp.at`, the untracked content-read regime, defense in
depth and mutation results (#333). PLAN §5.6 has a bullet.

## Contract changes

One `contracts:` commit (579a1f1), documentation only: `ScopeOptions.summaryState` is now also read by `getFileDiff`. No field, type or route
changed.

## Dependencies

None added or removed (`pnpm credits:check`: up to date).

## Known gaps

- **Not cached.** The route makes a diff cheap (1 process, under 40 ms), it does not store results: a reload still re-reads the open file.
  A result cache keyed by `(worktree, scope, path, options, stateHash)` is not safe for a fully staged file (its content is not in the state
  hash) and was left out.
- **Added, renamed, copied, type-changed, intent-to-add and conflicted files, submodules, nested repositories and sparse checkouts** take the
  whole route (3 processes). Opening an added file is the likeliest of these in practice; a deleted file elsewhere can pair with it as a rename,
  and nothing in the state says whether one does. A review-scope file that only commits changed (clean worktree, committed since the base) also
  takes the whole route.
- **A file that moved since the summary** takes the whole route until the summary catches up (about 100 ms after the event in the daemon).
- **Windows (a different filesystem model), macOS and other case-folding filesystems** never take the route (#288); not measured on macOS.
- **Ignore rules** (#334): an ignore file written, created or deleted after the summary, or a sibling entry created or deleted in a directory of
  an untracked file, sends that file the whole way until the next summary; the summary's `.gitignore` records within 30 ms of its stamp are never believed. An untracked file's content is read or not by the state's untracked count, as the lists' hashes are
  (#333 b).
- **A 300k-line patch** still costs git's own diff (288 ms).

## Notes for integration

- Rebase onto `main` and renumber DECISIONS #330-#333 if other work landed. The `contracts:` commit is separate and comment-only.
- `apps/web` is untouched. `GET /diff`'s response shape is unchanged. The web's refetch-on-`patchHash` logic (#51) compares the diff's hash
  with the list's: both come from the same bytes.
- The read-only allowlist and every flag are unchanged: the route issues the `diff` the whole route's narrowed run already issued, and no
  new subcommand. `Stamp` gained an internal `at` field (not part of `stampChange`, not exported from the package index).
- `incremental: false` / `OCTOPUS_DIFF_INCREMENTAL=0` restores the old three processes (a test asserts it, and that no stamp is read).

## PR #93 review: ignore rules (P1)

- **Bug (Greptile):** `ignoreFileMoved` read a deleted `.gitignore` as unchanged, so after a summary listed `dir/keep.log` (root `*.log`,
  `dir/.gitignore` = `!keep.log`) deleting `dir/.gitignore` made the file ignored, and the summary route still returned its diff where the
  whole route says `not_found`. Reproduced first (three new tests failed).
- **Fix** (DECISIONS #334, #335; `packages/git-core/src/ignore-sources.ts`): the track records the state of the `.gitignore` of every directory
  above an untracked file (signature, `absent`, or `unstable` within 30 ms of the stamp) and of `core.excludesFile`; the route compares them all
  and refuses on any appearance, change or removal. Incremental refreshes keep the record (no laundering of a lost event). `ConfigScan` gained
  `excludesFiles` (additive). Tracked files: ignore rules never apply to them, a test pins it. Attributes: never taken from the state, nothing to record.
- **Cost:** diff-open on the 100k layout unchanged (modified 16-19 ms, untracked 2 ms, 20 ms in the 30.7k-untracked worktree; 1 / 0 spawns);
  recording 323 directories for 30k untracked files 27-37 ms inside a full summary of about 1.9 s; an incremental summary 0.4 ms.
- **Tests:** 5 new golden cases (the repro; appearing, changed and deleted `.gitignore`; `core.excludesFile` and `info/exclude`; an incremental
  refresh that must not launder; tracked files), fuzz ops for ignore files and the excludes file. Mutations: see #335.
- **Verification (this follow-up, final code):** `pnpm lint`, `typecheck`, `build` exit 0; `pnpm test` exit 0 (git-core 394 + 1 skipped, daemon 391 + 4
  skipped, the rest as above); git-core and daemon run once more with the same counts; with `OCTOPUS_DIFF_TEST_FOLDS_CASE=1` git-core 380 + 15
  skipped, daemon 389 + 6 skipped; `pnpm test:e2e` (1 worker) 102 passed (3.2 min), read-only proof 12 repos, 4692 lock polls, 0 violations;
  `perf:smoke` exit 0; fuzz seeds 11, 424242, 90210, 5150 at 100 steps pass.

## PR #93 review, round 3

- **Symlinked ignore sources** (#336): `core.excludesFile` is signed by its link and its target; a symlinked `.gitignore` is never believed
  (git skips it with a warning; checked); `info/exclude` and the global default were already safe (the stamp uses `stat`).
- **Partial refresh laundering** (#337): an `unstable` directory is re-recorded only when the refresh's pathspecs cover it; the excludes record only
  by a full refresh. Tests: the reviewer's scenario with a lost event, the same for the excludes file, the symlink cases (all failing first), fuzz
  ops for silent ignore-file writes and deletions.
- **CI flake** (#338): `watch-paths.test.ts` probes until subscribed and waits per expected path; 20 + 20 loaded runs pass.
- **Verification (round 3, final code):** lint, typecheck, build exit 0; `pnpm test` exit 0 (git-core 398 + 1 skipped, daemon 391 + 4 skipped; both
  run twice more with the same counts); folding mode git-core 384 + 15 skipped, daemon 389 + 6 skipped; `pnpm test:e2e` 102 passed (3.6 min),
  read-only proof 12 repos, 4968 lock polls, 0 violations; `perf:smoke` exit 0; diff-open 100k: modified 15-16 ms / 1 spawn, untracked 2 ms
  (21 ms in the 30.7k-untracked worktree) / 0 spawns, 300k-line rewrite 299 ms; fuzz seeds 11, 424242, 90210 at 100 steps pass.

## Merge with main (PR #91, untracked-heavy)

Conflicts: DECISIONS (kept #305-#327, then #330-#339), PLAN §5.6 (both paragraphs), `incremental-fuzz.test.ts` (ported into the
`helpers/fuzz-ops.ts` structure: `useUniverse`, plan path shapes, caps 1 and 2, directory-count invariants; titles and thresholds identical to
main's). Semantic checks (DECISIONS #339): omitted untracked files take the whole route (test + mutation), `unsettled` signatures refuse,
capped seeds added to the diff fuzz.

Verification after the merge: lint, typecheck, build exit 0; `pnpm test` exit 0 (git-core 429 + 1 skipped, daemon 398 + 4 skipped, web 455, e2e unit 8; git-core and
daemon run twice more with the same counts); folding mode git-core 414 + 16 skipped, daemon 396 + 6 skipped; `pnpm test:e2e` 102 passed (3.5 min), read-only proof
12 repos, 4894 lock polls, 0 violations; `perf:smoke` exit 0; `incremental-fuzz` (9 tests, as on main) and seeds 777 and 4242 at 150 steps (caps 1 and 2) pass.
Diff-open, 100k layout after the merge (the untracked-heavy worktree now lists 700 files under the cap): modified 15 ms / 1 spawn in all three worktrees; a listed
untracked file 2 ms (20 ms in the untracked-heavy worktree) / 0 spawns; a file the cap omitted 271 ms / 2 spawns (the whole route, unchanged from before this work:
`diff --raw` and `status`; the summary has nothing to serve it from); the 300k-line rewrite 278 ms.
