# daemon-file-origins report (GitHub #33, roadmap step 12)

Branch `feat/daemon-file-origins`, from `main` at `cf85c2b` (PR #64 merged). Session of 2026-11-11/12. DECISIONS
**#201-#204**. Builds on #198-#200 (file-origins), #180-#187 (startup once), #166-#170 (branch cache) and #196.

## Shipped

- **Origins on the lists** (`apps/daemon/src/core.ts`: `#labelFiles`, `#labeledFiles`, `originBaseOf`,
  `applyOrigins`). `ChangedFile.origin` / `originVia` (only for `base` / `mixed`; absent = own) on `GET .../files`,
  `GET /api/inbox` and the bulk-review source, for:
  - **To review** (`review`): `O` = the review base (bookmark).
  - **All on branch** (`branch`, default base, with or without `includeWorking`): `O` = HEAD. The list starts at `N`,
    so only "same as main" (cherry-picks, squash-landed work) and in-progress files can be base. A file both sides
    changed is `mixed` in To review and own here: All on branch is the "only this branch's changes" view.
  - **Uncommitted** (`working`): the in-progress rule only.
  - Not `staged` / `unstaged` / `commit` / a branch scope with an explicit base (DECISIONS #201 says why).
- **Exact cache, 0 spawns on repeat.** Labels are cached per listed array (a `WeakMap`: `#gitFiles` hands out the same
  array while (stateHash, base, attributes) holds), keyed also by `O`, the default branch's name and both of its
  commits (local + `origin/<d>`, read fresh from the ref files on each call), so a fetch relabels on the next
  request even before the watcher reacts. Single-flight; failures are not cached and fall back to "all own". No
  git-core call at all when a list has no committed file and no operation is in progress.
- **Bounded, off first paint.** Every `readFileOrigins` goes through a 2-slot `Limiter` (`apps/daemon/src/limit.ts`).
  Nothing calls it at startup: review states are computed on demand (#183), and lists label only when asked for.
- **Review summary** (`#computeReview`): `baseFiles`, `unreviewedOwnFiles` (not reviewed, not base; mixed counts as
  own) and `integrationRef` (e.g. `origin/main`). `unreviewedFiles` keeps its meaning. The summary, `/files` and
  `/inbox` use the same cached labels, so they agree (asserted in every scenario).
- **`newCommits` without default-branch commits.** A merge or rebase of `main` no longer adds main's commits to the
  branch's count: `N` and its ancestors inside the range (`defaultBranchCommits` in `review-state.ts`, walked in
  memory over the range's parent links, no git process) are left out. Their paths stay "uncovered", so the files
  they touched are not taken as reviewed.
- **`#recordReviewed`** (Review all, `PUT /api/review/bookmark`) does not record those commits, so the `main`
  worktree no longer inherits them. The whole-range patch-id row becomes `N..HEAD` when such commits exist.
- **Bulk review** (`review-controls.ts`, `ownWork` in `bulk-review.ts`) never marks or unmarks base files, for every
  target and even when `paths` names them. "Review all" still moves the bookmark, so the noise leaves To review.
- **git-core (one line, `packages/git-core/src/file-origins.ts`):** `O === HEAD` gives `M0 = N` without a
  `merge-base` (N is an ancestor of HEAD). No new read, subcommand or option; the allowlist is untouched.
- Docs: DECISIONS #201-#204, `docs/STATUS-FLOW.md` §2.4a, `docs/PLAN.md` §5.7.

## Verification

Machine: 12-core WSL2 (Ryzen 7 7800X3D), Node 26.13, git 2.53.0.

- **`pnpm check`: exit 0** (40 s wall). lint incl. `credits:check`, typecheck, build, tests: contracts 93, forge 101
  (+5 skipped), git-core **254** (+1: `O = HEAD`), fixtures 53, web 254, daemon **283** (+1 skipped; +19 new),
  e2e unit 5, cli 139, scripts 34.
- **New daemon tests.** `apps/daemon/test/file-origins.real-git.test.ts` (12 tests, scratch repos with isolated
  config, a bare `origin` and clones for the remote cases, no network):
  - merge main in: `newCommits` 1 → 1, `unreviewedOwnFiles` 1 → 1, the two main files `base:merge`, not in All on
    branch;
  - a file both sides changed: `mixed:merge` in To review, own in All on branch; the file count is unchanged (the
    merge commit adds one commit, see Known gaps);
  - rebase onto main (bookmark still reachable): main's file `base:rebase`, count unchanged;
  - Review all marks own + mixed only (`changed: 2`), moves the bookmark, the list is empty afterwards, undo
    restores it; **the `main` worktree keeps `newCommits: 1`** (before this change it showed 0);
  - bulk with `paths` naming a base file marks only the own one; bulk by project moves both bookmarks;
  - `PUT` bookmark records 3 rows (own commit, merge commit, `N..HEAD` patch-id), main keeps its 2 commits;
  - merge in progress with a conflict: `base:in-progress` in To review, Uncommitted and All on branch;
  - cherry-pick of a newer main commit: `base:same-as-base` in To review and All on branch;
  - a fetch that moves `origin/main` relabels (same fix landed upstream → `same-as-base`), with the watcher on and
    with it **off** (only the key's fresh refs can tell); merging `origin/main` with a stale local `main` labels
    `origin/main`;
  - costs: **0 `readFileOrigins` calls after startup** and `GET /api/projects`; a repeat of `/files` + `/inbox` in
    three scopes and `/api/projects` = **0 spawns, 0 calls**; a fetch fan-out over 5 worktrees runs **at most 2 at
    once**; during a merge in progress a repeat is still 0 spawns (git-core alone would run `diff --cached` again).
  - Every scenario checks that `/files`, `/inbox` and the review summary agree.
  `apps/daemon/test/file-origins-units.test.ts` (7): the default-branch commit walk, `ownWork`, the limiter.
  `status-flow.real-git.test.ts` updated for the two new fields.
- **Mutation checks** (each reverted): keeping default-branch commits in `newCommits` fails 6 tests; recording them
  fails 2; marking base files in bulk fails 2; dropping the default-branch refs from the origins key fails the
  watcher-off test; disabling the origins cache fails 2 (the spawn assertions); a 100-slot limiter fails the fan-out
  test; removing the git-core shortcut fails its test (2 `merge-base` instead of ≤ 1).
- **Bench**, `pnpm --filter @octopus-diff/e2e bench --out <dir>` (30 × 3 = 90 worktrees; before = `main` at `cf85c2b`,
  after = this branch at `071e5c5`; both exit 0, all budgets PASS; written to `/tmp`, `docs/bench/` untouched):

  | Metric | Before | After |
  |---|---|---|
  | Startup git spawns (per worktree; budget ≤ 8) | 414 (4.6) | 416 (4.6) |
  | of which by subcommand | `config` 53 | `config` 55 (the timing-dependent filter-driver scan); all others equal, no `diff-tree` / `merge-base` |
  | Daemon listening / all summaries | 720 / 883 ms | 719 / 882 ms |
  | First paint cold / warm median (budget 3000 / 300 ms) | 159 / 89 ms | 164 / 97 ms |
  | UI spawns cold paint / warm reloads | 36 / 23, 4, 0 | 36 / 24, 0, 6 |
  | Edit → SSE p95 / → UI p95 | 21 / 49 ms | 21 / 40 ms |
  | Idle CPU average | 0.28 % | 0.25 % |
  | Inbox first / warm: working | 319 / 11 ms | 321 / 12 ms |
  | Inbox first / warm: To review (computes 90 review states) | 333 / 9 ms | **405** / 11 ms |
  | Inbox first / warm: All on branch | 35 / 29 ms | 31 / 26 ms |

  Startup and cold paint are unchanged (within noise). The first To review inbox is 72 ms slower: it now also labels
  every review state (90 `readFileOrigins` through the 2-slot limiter); repeats are not slower. The bench fixtures
  have no merge noise, so this measures the overhead only (#35 adds a fetch-moves-`origin/main` bench).
- **`pnpm test:e2e`**: **91 passed** (2.6 min), exit 0. Read-only proof: **12 control repos, 3779 lock polls,
  0 violations**. The daemon now calls `readFileOrigins` on the e2e paths (To review, All on branch, bulk review), so
  the proof covers the new reads too. No shutdown hang (BLOCKERS Open 2 did not trigger); 16-copy.spec.ts:226
  passed. The log has the usual `git-core has been disposed` request errors between specs (7 lines).

## Decisions

- #201 scopes and `O` per scope (HEAD for All on branch), the cache key, the "no committed file, no operation → no
  call" shortcut, the 2-slot limiter, nothing at startup, no origin on `FileDiff`.
- #202 the counts; `integrationRef` absent when there was nothing to label; `newCommits` leaves out default-branch
  commits (walked in memory from `N` instead of the issue's "+1 `rev-list`", with the exactness argument), their
  paths stay uncovered.
- #203 `#recordReviewed` leaves them out, the `N..HEAD` range patch-id; the default-branch worktree and a detached
  HEAD record as before; the merge-commit gap.
- #204 bulk review never marks or unmarks base files (even by `paths`); the inbox keeps them (wrapped by #34).

## Contract changes

None. The fields this fills (`ChangedFile.origin` / `originVia`, `WorktreeReview.baseFiles` /
`unreviewedOwnFiles` / `integrationRef`) were added by #31 and are optional, so older clients still parse (the
test client validates every response with the contract schemas; `packages/contracts/test/file-origins.test.ts`
covers older shapes). `newCommits` keeps its shape; what it counts narrows (#202).

## Dependencies

None added or removed (`pnpm credits:check` passes inside `pnpm lint`).

## Known gaps

- **A merge commit of `main` that merged a file both sides changed counts as one new commit** (`describeCommits`'
  `--cc --name-only` cannot tell an automatic merge of both sides from a hand resolution). The file count is
  unchanged. Fixing it needs the combined patch's hunks (a costlier read).
- `cherry-pick` via is still never emitted (#198): the picked commit itself also counts in `newCommits` (its sha is
  not on the default branch).
- `OP_HEAD`'s id is not in the cache key (an aborted merge restarted onto another commit with an identical index);
  the next index change refreshes it.
- Criss-cross histories: `N` is one of several merge bases, for counts as for labels (#200).
- The inbox keeps an entry whose only unreviewed files are base under `onlyUnreviewed` (by design, #204); the web
  shows it as a collapsed group (#34).
- The review summary itself still refreshes on the summary's `stateHash` (the watcher), as before; `/files` and
  `/inbox` relabel on the next request even without it.

## Notes for integration

- #34 (web): prefer `review.unreviewedOwnFiles` over `unreviewedFiles` when present; `baseFiles` and
  `integrationRef` label the group ("From origin/main"). `origin` is absent for own files. The mixed-file toggle is
  the same file in the All on branch scope (`branch` + `includeWorking`), where it is own. Bulk "Review N shown"
  already skips base files server-side.
- #35 (e2e/bench): the daemon side is ready for the merge-noise spec; the 90-worktree "fetch moves `origin/main`"
  bench should show at most 2 concurrent origin computations and about 3 spawns per worktree that has commits.
- No migration, no new route, no new event.
