# incremental-summary report (roadmap #40, step 23)

## Shipped

- **Incremental summaries in git-core** (`packages/git-core/src/incremental.ts`, `summary.ts`). `getSummary` with
  `SummaryOptions.changedPaths` (the watcher's paths) keeps each worktree's last state (`SummaryTrack`: status
  entries, numstat lines, lstat signatures, untracked inspections) and runs `git status … -- <region>` and
  `git diff --numstat <HEAD> -- <region>` (side by side) for a region of the hinted paths, every rename candidate and
  every changed file whose signature moved without an event. The result is merged by path and goes through the same
  `finish` step as a full refresh: same counts, `changedFiles`, additions/deletions, `activityAt`, snapshot and state
  hash. Spawn-free guards first (`Stamp`: index, ignore, config, attribute, sparse-checkout and `.gitmodules`
  files), and the limited status's own `--branch` header must equal the last one (HEAD, branch, upstream,
  ahead/behind). Refused hints refresh in full and say why (`SummaryResult.refresh.reason`), see DECISIONS #287-#289.
- **State hash: same meaning, one narrow change.** Both modes hash a canonical rebuild of the status text in git's
  own order (changed by path, unmerged by path, untracked by path; the fuzz asserts it equals git's raw output)
  and the numstat lines of paths git status reports. Main hashed the raw numstat output, which also has a
  `-\t-\t<file>` line for a stat-dirty but unchanged binary file: **a worktree with a real tracked change and a
  touched, unchanged binary gets a new state hash once on upgrade**; every other worktree keeps its hash
  (DECISIONS #286).
- **File lists follow the summary** (`packages/git-core/src/diff.ts` `listFromSummary`). With
  `ScopeOptions.summaryState` (the held summary state), a list of a worktree-reading scope (working, review,
  branch + working) is either updated from the journal of changed keys (one `diff -p` limited to them plus the
  list's rename candidates) or seeded with one diff limited to the summary's status paths plus the base's
  `diff-tree` paths; flags and untracked rows come from the summary's status and inspections (DECISIONS #290).
- **Daemon** (`apps/daemon/src/watcher.ts`, `core.ts`, `daemon.ts`). The watcher keeps native event paths per
  worktree through the debounce and passes them on, null after anything else (poll, focus, git-dir events,
  re-subscribes, too many paths). The core turns them into `changedPaths`, gives a failed refresh's paths back as a
  full refresh, passes `summaryState` to lists, and reconciles with a full refresh 30 s after the first incremental
  one (DECISIONS #291, #292). Merge-noise labels of an uncommitted-only list skip the per-file work (#294).
- **Kill switch / A/B:** `OCTOPUS_DIFF_INCREMENTAL=0`, `git.incremental: false` or `internal.incremental: false`
  (#293); bench `--no-incremental`. It restores the full git calls only: the state hash keeps the canonical
  rebuild, and the merge-noise shortcut for uncommitted-only lists (#294) still applies.
- **Bench** (`e2e/bench/bench.ts`): `--no-incremental`, a "Git spawns to SSE" column (write → `worktree.changed`),
  the edit windows in `--keep-trace`, and two budgets on later edits of a worktree: spawns to SSE ≤ 3 (enforced) and
  edit → SSE p95 < 120 ms (report only, the 100k-file target). `docs/bench/README.md` documents them.

## Verification

All from the repository root on this machine (12-core WSL2, Node 26, git 2.53).

- `pnpm lint`: exit 0 (biome, 1 info in an existing file; credits up to date).
- `pnpm typecheck`: exit 0.
- `pnpm build`: exit 0.
- `pnpm test`: exit 0. contracts 107, forge 101 (5 skipped), fixtures 58, web 416, git-core 323, daemon 386
  (3 skipped), e2e unit 7, cli 139, scripts 34.
- `pnpm test:e2e`: exit 0, **100 passed (3.1 min)**, including `07-readonly` and the read-only proof (12 control repos,
  4532 lock polls, 0 violations). The subcommand allowlist is unchanged.
- CI-only steps run locally: `pnpm --filter @octopus-diff/web perf:smoke` exit 0; CLI smoke (`--version`, `doctor`:
  0 problems, 1 warning); package job (`pack:tarball`, `npm install` of the tarball in an empty directory, its
  `--version` and `doctor`: 0 problems).
- New tests:
  - `packages/git-core/test/incremental-fuzz.test.ts`: four seeds × 120 steps plus a `core.ignorecase=true` seed
    (600 steps, about 20 s). Operations: writes (text, binary), deletes, renames, chmod, touch, symlinks,
    `mkdir`/`rm -rf` of directories, `.gitignore` and `info/exclude` edits, `git add`, `add -N`, `reset`,
    `rm --cached`, `mv`, `commit`, `checkout -f`, `symbolic-ref HEAD`, `stash push/pop` (conflicts included), over
    paths with spaces, Unicode, a newline, case variants and nesting. After every step the incremental summary
    (hint = exactly the paths the step touched) equals a full one field for field (snapshot included), and the
    working, review and branch + working lists, and a review list against a random commit (seeded), equal full lists.
    Every tenth step: the canonical status rebuild equals git's raw output. Seeds print on failure
    (`FUZZ_SEED`, `FUZZ_STEPS`, `FUZZ_VERBOSE`, `FUZZ_DUMP`). 16 more seeds × 250 steps also pass.
  - `packages/git-core/test/incremental.test.ts` (20): spawns per edit (status + numstat limited to the path; an
    untracked file's edit: status only; a list update: one diff limited to the path; the kill switch), every refusal
    reason that can be set up on Linux (no state, index, HEAD without an index write, upstream move, ignore and
    attribute files, `info/exclude`, directories, sparse checkout, nested repository, submodule, invalid paths), a
    lost event (stale incremental result, repaired by a full refresh, incremental again after), a missed edit of an
    already-changed file repaired from its signature, a deleted directory, a staged rename edited on one side, and
    `keysInRegion` against `Region.has`.
  - `apps/daemon/test/incremental.real-git.test.ts` (3, real daemon, real watcher, a git wrapper logging argv):
    an edit costs ≤ 3 git processes, each `-- a.txt`, and the event's counts equal a full summary's; a watcher that
    drops one file's events is repaired by the reconciliation with no new event; `incremental: false` runs every
    status unlimited. `watch-paths.test.ts` (3): paths reach `onWorktreeDirty` relative and `/`-separated; focus,
    git-dir events and path-less callers give null; more than 256 paths give null. `incremental-core.test.ts` (1,
    fake git-core): paths become `changedPaths`, focus does not, a failed refresh makes the next one full.
  - Mutation checks (each killed by the tests above unless noted): no rename candidates, region without
    prefix matching, no status-header check, index stamp ignored, no missed-signature repair, list without rename
    candidates, journal ignoring signatures, no canonical sort, directories not refused, ignore files allowed,
    conflicts not refused, list reusing rows inside the region, seed without the committed paths, seed without the
    status paths, list stamp unchecked, hint never passed, reconciliation never armed, watcher dropping paths,
    paths kept for git events, no `summaryState`, a failed refresh keeping no hint. Survivor: the journal reset on a
    HEAD move alone (redundant with the list's HEAD check; removing both is killed).
- Bench (edit → SSE per worktree role):
  | Run (this machine) | main | stale-index | untracked-heavy | git spawns to SSE |
  |---|---|---|---|---|
  | 100k files, UI open (`bench --layout large`, committed `results-large.*`) | 63-71 ms | 62-67 ms | 100-111 ms | 3 |
  | 100k files, `--no-ui`, later edits (`results-large-edits.*`) | 55-62 ms | 58-63 ms | 94-105 ms | 3 |
  | 100k files, `--no-ui`, first edit of each worktree (first review state) | 525 ms | 247 ms | 305 ms | 3-4 |
  | 100k files, `--no-ui --no-incremental` (`results-large-edits-full.*`) | 1138-1244 ms | 111.9-122.8 **s** | 3.6-3.8 s | 4-7 |
  | 20k files, UI open (`--layout large-ci`, committed) | 25-29 ms | 25-29 ms | 34-42 ms | 3 |
  | 20k files before this branch (committed `results-large-ci.md` on main) | 481 ms p50 | 5512 ms p50 | 700 ms p50 | 22-38 per edit |

  The 100k layout builds in about 10 s here, so it was measured directly (the 183 s caveat in the bench README was
  the old cold paint: 169 ms now, 45 ms warm). New budgets: spawns to SSE on later edits **3 (≤ 3, PASS)** on
  large and large-ci; edit → SSE p95 on later edits **109 ms** (100k, UI) and **34 ms** (20k), report only.
  `pnpm --filter @octopus-diff/e2e bench` (30 × 3, UI): every budget passes (cold paint 139 ms, warm 72 ms, edit →
  SSE p95 19 ms, burst diff p95 34 ms, 0 projects requests per edit, idle CPU 0.40 %); committed. Idle CPU on the
  100k layout reads 8.5 % (report only; 0.05 % in the old run, whose 183 s paint kept the idle window after all
  startup work): the idle window now starts while startup work and the focused worktree's 30 s fallback poll (a
  full refresh of 100k files) run; not traced, so this explanation is unverified. On large-ci it went down,
  10.19 % → 2.18 %.
  Per-spawn costs at 100k files (trace): pathspec-limited `status` 20-25 ms, `diff --numstat` 14-17 ms,
  `diff -p` 14-17 ms; full `status` 150-470 ms, full numstat up to 970 ms with a stale index, full `diff -p` of
  the stale worktree about 5 s on 20k files and over 100 s on 100k.

## Decisions

DECISIONS #283-#295: the two `contracts:` commits (#283, #284); the incremental summary (#285); the state hash
(#286); refusals, and renames and deleted directories not forcing a full refresh (a deviation from the brief, #287);
case-folding filesystems (#288); conflicts (#289); file lists (#290); watcher paths (#291); reconciliation (#292);
kill switch (#293); origins of uncommitted-only lists (#294); spawns per edit (#295). PLAN §5.6 has a paragraph.

## Contract changes

Two separate `contracts:` commits, additive only: `SummaryOptions.changedPaths`, `SummaryResult.refresh`
(`SummaryRefresh`), `GitCoreOptions.incremental` (78b7068); `ScopeOptions.summaryState` (77915a8).

## Dependencies

None added or removed (`pnpm credits:check`: up to date).

## Known gaps

- **First review state.** The first edit of a worktree in a daemon session computes its first review state, whose
  list needs every changed file's patch (seeded, limited to the changed paths: 247 ms on the stale-index worktree,
  305 ms with 30k untracked files, 525 ms with a 300k-line rewrite). The event waits for it (#265). Later edits:
  see the table in Verification. Announcing before the first review state would remove it; not done (web behaviour of #51).
- **macOS, Windows and case-folding mounts refresh in full** (#288). A fold-aware region is the follow-up.
- **Conflicts, submodules, nested repositories and sparse checkouts refresh in full** (#287, #289).
- **Hashing 30k untracked records costs ~15 ms per refresh** (SHA-256 over ~3.6 MB). Section digests would remove
  it at the price of one changed state hash per worktree on upgrade (#286, proposal).
- **A new file costs two processes** (status and a speculative numstat), since the last state cannot tell a new
  file from a clean tracked one; an edit of an untracked file costs one.
- **Config scan TTL.** One `git config` every 60 s at most (#29) can land on an edit: 4 processes then.
- **Custom `core.excludesFile` / `core.attributesFile` or config includes** are not in the stamp; their edits wait for
  the reconciliation (30 s).

## Notes for integration

- Merge order does not matter; the `contracts:` commits are separate. DECISIONS numbers #283-#295 may need renumbering.
- `apps/web` is untouched. The event and row shapes are unchanged; `SummaryResult.refresh` is stripped like
  `snapshot` and never reaches a payload.
- The read-only allowlist is unchanged: `status` and `diff` take `--`-separated literal pathspecs as before, and
  `diff-tree -r -z --name-only --no-renames --no-commit-id --end-of-options <a> <b> --` is the call file origins
  already make.
- This branch regenerated `docs/bench/results.*`, `results-large-ci.*`, `results-large.*` and added
  `results-large-edits*.{md,json}`; re-run them after rebasing if other perf work lands first.

## PR #89 review follow-up

- **P1, phantom rows in cached lists** (DECISIONS #297). A list read from the files while an event was pending
  could keep a row for a file that is clean in the summary state for ever. Now: an incremental summary journals its
  whole region (the watcher's paths), a full summary is "blind" and lists then re-diff the paths they read whose file
  moved since (lstat signatures taken before reading; full lists are seeded again), rows the state does not explain
  are re-checked on every use, and a full summary drops lists it does not explain. Tests (failing first):
  `packages/git-core/test/incremental-review.test.ts` (both repros, lost revert/delete events, a short-lived untracked
  file, the same state asked again, the drop, a committed file read mid-edit by a seeded or a full list then changed
  back before an incremental or a full summary). The fuzz asks for lists between a step's operations and restores files
  to HEAD's content; its sweep found the chmod-undone-by-stash case the first version of this fix missed. Mutations
  killed: hint region not journaled, full summaries not blind, moved files ignored, full lists kept after a blind
  summary, re-check keys not re-diffed, the early return ignoring them, nothing counted unexplained, untracked rows
  always explained, the drop removed.
- **P2, embedded repositories** (#298). Gitlinks in the index (parsed, memoized by the index's stat) and hinted
  paths below a `.git` refresh in full. Tests: a commit inside an embedded repository then an edit elsewhere
  (`changedFiles` 2, as a full refresh), a hinted path inside it, a hinted path inside an ignored nested
  repository. Mutations killed: gitlink scan removed, ancestor check removed.
- **P3a, Refresh** (#296, #299): full, and `forgetState` drops git-core's state and lists. Tests:
  `apps/daemon/test/incremental-core.test.ts` (a refresh queued behind a slow one with watcher paths pending:
  `changedPaths` absent, `forgetState` true; failing first), `incremental.real-git.test.ts` (Refresh repairs a
  lost event, reconciliation off), `incremental-review.test.ts` (`forgetState` in git-core). Mutations killed:
  the hint kept, `forgetState` not passed, `forgetState` ignored by git-core.
- **P3b/P3c**: the state-hash and kill-switch wording above and in DECISIONS #286, #293.
- Verification of the follow-up (head after the merge of main): `pnpm lint`, `pnpm typecheck`, `pnpm build`: exit 0.
  `pnpm test`: exit 0 (contracts 107, forge 101 + 5 skipped, fixtures 58, web 416, git-core 338, daemon 388 +
  3 skipped, e2e unit 7, cli 139, scripts 34); git-core and daemon suites passed three times in all (the known
  watcher-review-fixes F1 flake did not show). Fuzz: 16 extra seeds × 250 steps pass (three of them failed on the
  first version of the P1 fix: the chmod/stash case). `pnpm test:e2e` (1 worker): 100 passed (3.1 min), read-only
  proof 12 control repos, 4515 lock polls, 0 violations. Bench 30 × 3 (UI): every budget passes (cold paint 137 ms,
  warm 78 ms, edit → SSE p95 20 ms, burst diff p95 40 ms, idle CPU 0.35 %). 100k files, `--no-ui`, 15 edits: later
  edits main 53-59 ms, stale-index 55-62 ms, untracked-heavy 96-115 ms (p95 115 ms), 3 git processes to SSE; first
  edits 550 / 253 / 313 ms (the first review state, as before).

## macOS CI follow-up (PR #89)

macOS folds case, so it gets full refreshes only (#288), but the new tests assumed the incremental path (DECISIONS
#300). Tests now ask the implementation's probe: incremental-only tests are skipped there with a reason, refusals the
probe preempts expect `case-insensitive`, list tests keep running, folding-only tests assert the fallback in git-core
and through the daemon, and the fuzz asserts per-step equality and zero incremental refreshes, at 40 steps per seed
on darwin. `OCTOPUS_DIFF_TEST_FOLDS_CASE=1` emulates folding on Linux. Runs here, both modes:

- git-core: normal 338 passed + 1 skipped (29 s); folding 334 passed + 5 skipped (23 s). Fuzz in folding mode:
  5.3-5.8 s per seed at 120 steps, 2.1-2.2 s at 40 (the whole file 8.7 s). Not measured on macOS itself.
- daemon: normal 388 passed + 4 skipped; folding 386 passed + 6 skipped (25.5 s each).
- Mutation: the implementation's case check removed while the tests see folding: 12 git-core tests and the daemon's
  folding test fail.
- Folding mode first failed two list tests (repro B's intermediate step, the full-summary drop). Both checked
  incremental mechanics: with every summary full, the stale list is dropped and the list of s3 is seeded from s3, where
  the reverted file is clean. Every final list still equals a full one; no list bug on macOS.
