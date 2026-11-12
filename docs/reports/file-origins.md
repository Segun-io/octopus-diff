# file-origins report

Roadmap #31 "contracts: file origin fields" and #32 "git-core: readFileOrigins (own vs mixed vs base)" (steps 10
and 11 of #24, milestone M2 "Merge noise out of the box"). Branch `feat/file-origins` (from `main` at `64c1bb9`).
DECISIONS **#198-#200** (#197 is the forge-fetching branch's; renumber at merge if they collide). Not wired into
the daemon or web: #33/#34 do that.

## Shipped

- **Contracts (#31, commit `ea70ead`, separate `contracts:` commit).** `FileOriginSchema` (`own|mixed|base`),
  `FileOriginViaSchema` (`merge|rebase|cherry-pick|update|same-as-base|in-progress`), `FILE_ORIGINS`,
  `FILE_ORIGIN_VIAS`; `ChangedFile.origin?` / `originVia?` (absent = own); `WorktreeReview.baseFiles?`,
  `unreviewedOwnFiles?`, `integrationRef?`; optional `GitCore.readFileOrigins(worktree, FileOriginsOptions)`
  with `FileOriginsOptions = ScopeOptions & { base: string | null; files?: FileOriginInput[] }`,
  `FileOriginInput = Pick<GitChangedFile, path|rawPath|oldPath|status|staged|unstaged>`, returning
  `FileOrigins = { integrationRef: string | null; n: string | null; tip: string | null; origins: Map<pathKey,
  { origin; via: FileOriginVia | null }> }` (`pathKey` = `rawPath ?? path`, the daemon's `pathKey`).
- **git-core (#32, `packages/git-core/src/file-origins.ts`, wired in `core.ts`).** The issue's five rules,
  per listed file, with `U` = local default + `origin/<d>`, `N` (`integrationBase`, #30), `TIP`
  (`resolveTip`, #30, now used), `M0 = merge-base O N`. Name-only `diff-tree -r -z --name-only --no-renames
  --no-commit-id --end-of-options A B --` between commits only, memoized in `GitContext.memo` by
  (common dir, history stamp, ids), full ids only. During a merge / cherry-pick of a default-branch commit one
  index-only `diff --cached -z --name-only --no-renames --end-of-options OP_HEAD --`. `via` per worktree:
  `update` (HEAD = N), `merge` (a merge commit in `O..HEAD`, read from the review range's memoized `rev-list`),
  else `rebase`; `same-as-base` for rule 3; `in-progress` for rule 1. Without `files`, git-core lists
  `base..HEAD` + `git status` itself (same answer, tested). `review.ts` now exports `headRef`,
  `isDefaultBranch`, `rangeCommits` (shared, unchanged).
- No new git subcommand or option family: `diff-tree` and `diff` were already allowlisted; the runner adds
  `--no-ext-diff --no-textconv` as for every diff.
- Docs: DECISIONS #198-#200, `docs/STATUS-FLOW.md` §2.4a.

## Verification

Machine: 12-core WSL2, Node 26, git 2.53.0.

- `pnpm check`: **exit 0** (41 s wall). lint incl. `credits:check`, typecheck, build, tests: contracts **91**
  (new `test/file-origins.test.ts`), forge 94 (+4 skipped), git-core **252** (20 files; new
  `test/file-origins.test.ts`, 33 tests; `readonly.test.ts` extended), fixtures 53, web 249, daemon 231 (+1
  skipped), e2e unit 5, cli 139, scripts 34.
- **Scenario fixtures** (scratch repos in `mkdtemp`, isolated config, bare `origin` + two clones, no network):
  merge main in clean; fetch + merge `origin/main` with stale local main; mixed (clean merge, both sides);
  conflict resolved by hand (mixed) and as theirs (base); cherry-pick from main (`same-as-base`, the later main
  commit not listed); own work squash-landed on main (`same-as-base`) then main merged back (base merge);
  rebase onto `origin/main` with stale local main (base / mixed `rebase`); rebase with up-to-date main (no
  noise, the range starts at N); fast-forward (`update`); renames (own rename own, main rename base, own rename
  of a file main changed mixed via the old path); own change reverted after the bookmark (own); merge of a
  sibling branch (own); uncommitted edits on base files (own); non-UTF-8 path keyed by `rawPath`; in-progress
  merge of main with a conflict (base / mixed `in-progress`, conflict own, then merge after commit);
  in-progress cherry-pick of a main commit; in-progress merge of a sibling (own); revert in progress (own);
  default-branch worktree after a pull (own, decision 4); detached HEAD (own); unborn branch (own, `n` null);
  no default branch (own, `integrationRef` null); no remote (local `main` is `U`); no shared history (own);
  invalid inputs (`invalid_argument`); configured `defaultBranch`; with vs without `files` (equal).
- **Spawn counts** (asserted; `readReviewRange` called first, as `#computeReview` does): first call 5
  (`merge-base` x3, `diff-tree` x2); nothing moved **0**; a new own commit **2**; merging main again 5; a fetch
  moving `origin/main` 3; merge in progress +1 `diff` per call (plus the existing config scan, which is never
  reused while config files are < 2 s old). Asserted: `<= 5`, `0` steady, only `diff-tree`/`merge-base`/
  `rev-list` outside an operation, `['diff']` during one.
- **Mutation checks** (each reverted): dropping rule 3 fails 2 tests; the issue-literal rule 2 (no `M0..N`
  check) fails 1; dropping the `OP_HEAD`-in-`U` gate fails 1; dropping the default-branch / detached rule
  fails 2.
- **Read-only proof (git-core)**: `readonly.test.ts` now calls `readFileOrigins` with and without `files` for
  every worktree and two bookmarks, on a new repo with `main` merged and a second merge of `main` stopped on a
  conflict; it asserts `base:in-progress` and `base:merge` were produced. No lock file, no git-dir change: pass.
- **Bench**, `pnpm --filter @octopus-diff/e2e bench --no-ui --idle-seconds 5` (30 x 3 = 90 worktrees; before =
  this branch at `ea70ead`, contracts only, runtime identical to `main`; after = the final branch): startup
  spawns **414 → 412 (4.6 / worktree both), budget <= 8 PASS**, exit 0 both; listening / all summaries 750 / 919
  ms → 777 / 951 ms (noise). By subcommand the same (`status` 90, `diff` 90, `check-attr` 90, `config` 53 → 51,
  `rev-parse` 30, `worktree` 30, `for-each-ref` 30, `--version` 1). Expected: nothing calls `readFileOrigins`
  yet. `docs/bench/results.*` were restored after the runs.
- **`pnpm test:e2e`**: **91 passed** (2.6 min), exit 0. Read-only proof: **12 control repos, 3752 lock polls, 0
  violations**. No shutdown hang (BLOCKERS Open 2 did not trigger); 16-copy.spec.ts:226 passed. The log has the
  usual `git-core has been disposed` request errors between specs. The e2e proof drives the daemon, which does
  not call `readFileOrigins` yet; the new reads are covered by git-core's `readonly.test.ts`.

## Decisions

- #198 contracts; the `files` input (rule 1 needs the listing's `git status` flags; re-reading status would be
  a whole-worktree scan outside the budget) and `cherry-pick` reserved (git-core emits `same-as-base`).
- #199 the algorithm and four conservative refinements: rule 2 also requires `p` in `M0..N` (own reverted work
  stays own); the default-branch worktree and a detached HEAD are all own; an in-progress operation counts only
  when `OP_HEAD` is default-branch history, and a revert in progress is own (the issue's rule would always say
  mixed); no remote still uses the local default branch (the task said "no default branch or no remote ->
  everything own"; I read that as "nothing to compare against": with a local `main` and no remote a merge of
  `main` is still noise, consistent with #196. Say so if no-remote should be all own).
- #200 edge cases documented, not solved: stale remote-tracking refs, `cherry-pick --no-commit`, `checkout main
  -- file`, criss-cross merge bases, conflict resolved as ours = mixed, rename pairing with identical content,
  fetch invalidation fan-out.

## Contract changes

All additive and optional (commit `ea70ead`, DECISIONS #198); older daemons and clients parse unchanged
(`packages/contracts/test/file-origins.test.ts`).

## Dependencies

None added or removed (`pnpm credits:check` passes inside `pnpm lint`).

## Known gaps

- Not wired: the daemon (#33) attaches origins and counts, the web (#34) groups them.
- `cherry-pick` via never emitted; patch-id detection would cost a `log`/`patch-id` pass.
- The in-progress `diff --cached` is not cached (the index changes); +1 spawn per call during an operation.
- A fetch that moves `origin/main` makes every worktree of the project recompute (about 3 spawns each, 5 if `N`
  moved): #33 should run it with `mapLimit`, off first paint.
- Only `origin` is paired with the local default branch (as #196).

## Notes for integration (#33)

- Call per review key: `readReviewRange` first (its `rev-list` memo serves `via`), then
  `listChangedFiles({kind:'review', base: range.base})`, then
  `readFileOrigins(locator, { base: range.base, defaultBranch, files })`; copy `origin`/`via` onto the
  files only when `origin !== 'own'` (`originVia = via`). The same call works for `branch + includeWorking` and
  `working` lists (pass their files; the working scope only hits rule 1).
- `integrationRef` is the label; `n` is the base for the mixed-file toggle (#34: the file in the branch scope).
- `baseFiles` = files with `origin === 'base'`; `unreviewedOwnFiles` = not reviewed and not base.
