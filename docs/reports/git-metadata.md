# git-metadata report

Roadmap #29 "Perf: per-project git metadata instead of per-worktree" (milestone M1, step 05 of #24).
Branch `perf/git-metadata`. DECISIONS #188–#194 (stacked after #10's #180–#187).

## Shipped

All in `packages/git-core` (no daemon, web or contract change; the bench budget marker in `e2e/bench/bench.ts`).

- **One base lookup** (`resolveRefName`, `src/discovery.ts`): the ref files first (`src/ref-files.ts`: loose refs,
  `packed-refs`, moved out of `branch-base.ts`), `for-each-ref` when they cannot tell (symbolic refs, reftable,
  per-worktree namespaces, odd files). The branch scope, the summary's ahead/behind base, review ranges and
  `readBranchBase` (#27, unchanged contract and cache identity) all use it, so #30 has one place to change.
  Default-branch detection (`origin/HEAD` symref, `main`/`master`/`trunk`) and HEAD (`resolveHead`, the review
  range's branch) read files the same way.
- **Ahead/behind per project** (`src/commits.ts`): on git >= 2.41 one
  `for-each-ref --format=%(objectname)%00%(ahead-behind:<base>)` over the branches checked out in the project's
  worktrees (recorded by `listWorktrees`), single-flight per (common dir, base); `rev-list --count` for detached
  heads and older git (`features.forEachRefAheadBehind` in `src/version.ts`).
- **Commit facts memoized by (common dir, ids)** (`src/commits.ts`, `GitContext.memo`): merge-base, is-ancestor,
  commit verification of a full id, commit parents, review-range `rev-list`. Positive answers only.
- **Config scan reuse** (`GitContext.configScan`, `src/context.ts`): the filter-driver neutralization and
  `core.attributesFile` read is reused only while the stat signatures of every config file git reads are unchanged
  (system, global, `<commonDir>/config`, the worktree's `config.worktree`), none changed in the last 2 s, no
  `include.*`/`includeIf.*` key exists in any scope, and for at most 60 s. Single-flight across a project's
  worktrees; a read that found includes is never shared or kept.
- **Worktree repository info from `git worktree list`** (`GitContext.seedWorktreeRepo`): no `rev-parse` per
  worktree, only for own-user worktrees whose `.git` → git dir → `commondir` lead back to the project (else git's
  discovery as before). `resolveProject` seeds its own result and the project-level repo. `repo()` is
  single-flight.
- Bench: the startup-spawns-per-worktree budget is **enforced** (removed from `TRACKED`; README updated).

## Verification

Machine: 12-core WSL2, Node 26.13, git 2.53.0. Note: another session ran its own benches on the same machine
during some of my runs, which affects timings (not spawn counts).

Startup spawns at 30 × 3 (90 worktrees), `pnpm --filter @octopus-diff/e2e bench --no-ui --idle-seconds 5`
(before = `main` at `eaacb9f`, after = this branch; same script, startup window = daemon spawn → all summaries):

| Subcommand | Before | After |
|---|---|---|
| `rev-parse` | 340 | 60 |
| `for-each-ref` | 210 | 30 |
| `config` | 187 | 47 |
| `status` | 180 | 180 |
| `diff` | 180 | 180 |
| `check-attr` | 90 | 90 |
| `symbolic-ref` | 90 | 0 |
| `rev-list` | 60 | 0 |
| `merge-base` | 60 | 0 |
| `worktree` | 30 | 30 |
| `--version` | 1 | 1 |
| **Total** | **1428** (15.9 / worktree, 7.4 s git time) | **618** (6.9 / worktree, 4.2 s) |

What remains per project: 1 `rev-parse` (discovery in `resolveProject`), 1 `worktree list`, 1 `for-each-ref`
(ahead/behind for all its worktrees), 1 filter-scan `config`, 1 `rev-parse --verify` of the review base, and the
forge's remote-config `config` (17 of 30 inside the window). Per worktree: `status`, `diff --numstat`,
`check-attr` for the summary, plus a second `status` + `diff` from the daemon's startup review-file listing
(`#computeReview`), which is #10's "compute each summary once" (its acceptance: `status` 180 → 90). With #10 the
count is about **618 − 180 ≈ 440, under the 450 target**; this branch alone is at 6.9/worktree (budget ≤ 8).

Full bench, `pnpm --filter @octopus-diff/e2e bench` (30 × 3, with the UI; output committed in
`docs/bench/results.{json,md}`), before = `docs/bench/results.md` on `main`, after = this branch, exit 0:

| Metric | Before | After |
|---|---|---|
| Startup git spawns (per worktree) | 1428 (15.9), 7246 ms git | **626 (7.0)**, 4253 ms git, budget PASS (now enforced) |
| Daemon: listening / all summaries | 729 / 1972 ms | 788 / 1241 ms |
| Cold first paint | 1382 ms | 874 ms |
| Git spawns during cold paint | 840 | 363 |
| Warm reload (median of 3) / spawns per reload | 852 ms / 547–554 | 127 ms / 3–11 |
| Edit → SSE p50 / p95 | 29 / 40 ms | 15 / 31 ms |
| Git spawns per edit | 21–31 | 9–49 (one outlier; typically 9–18) |
| Idle CPU average | 0.32 % | 0.23 % |

The warm-reload change also includes #27/#28 merged before this branch (the committed "before" file predates
them); its budget stays `TRACKED` for #10 as instructed. An earlier run while another session was benchmarking
on the same machine showed an edit→SSE p95 of 216 ms (one edit; its git work was 9 ms); the clean run above is
31 ms. Per edit, the remaining git work is `status` + `diff` pairs (the summary and the UI's file lists): no
`rev-parse`, `for-each-ref`, `symbolic-ref`, `merge-base` or `config` once caches are warm.

Large layout, `pnpm --filter @octopus-diff/e2e bench --layout large-ci --no-ui --idle-seconds 5` (one ~20k-file
repo, 3 worktrees), exit 0: startup **50 → 21 spawns (16.7 → 7.0 per worktree, PASS)**; spawns per edit
main 20–23 → 6–8, stale-index 16–19 → 7–10, untracked-heavy 26–33 → 7–10; edit → SSE p50 main 3340 → 476 ms,
untracked-heavy 3527 → 668 ms, stale-index 5317 → 5442 ms (bound by `git status` re-hashing every file; #40/#43).
A large-ci run *with* the UI (killed by my own 15-min `timeout` wrapper during edit 15/15, so no result file)
showed cold paint 8917 ms (before 8937), warm reload ~118 ms (before 4854), edit → SSE main ~115 ms, stale-index
5.2–6.5 s, untracked-heavy ~680 ms. Not rerun to completion (it takes over 20 min); not committed.

Tests:
- `pnpm check` (lint incl. `credits:check`, typecheck, build, unit tests): exit 0. contracts 83, forge 94 (+4
  skipped), git-core 200 (18 files; new `test/git-metadata.test.ts`, 12 tests), fixtures 53, web 245, daemon
  218 (+1 skipped), e2e unit 5, cli 139, scripts 34. All pass; the hostile-config and read-only tests unchanged.
- Mutation check: making the config scan ignore the stat signatures and the include rule fails 3 new tests and
  the existing hostile-config "re-reads config on every operation (includes ...)" test.
- `pnpm test:e2e`: **91 passed** (2.9 min), read-only proof **12 control repos, 4318 lock polls, 0 violations**;
  no shutdown hang this time; 16-copy.spec.ts:226 passed too. The log has `git-core has been disposed` request
  errors between specs (daemon shutdown while the page still polls), which the specs do not count as failures.
- One flake of my own, fixed: the new test's spawn-logging wrapper interleaved concurrent writes (commit
  `git-core: metadata tests log one file per git process`); 3/3 runs and the final `pnpm check` green.

## Decisions

DECISIONS #188 (overview, numbers), #189 (one base lookup from ref files; known differences for hand-made
non-commit branch tips and broken refs), #190 (batched `%(ahead-behind:)` over checked-out branches only), #191
(config scan reuse conditions and the security argument), #192 (worktree repo info from `worktree list`, ownership
check, not on Windows), #193 (commit facts memo; replace-refs caveat; missing object in a branch merge base is now
`not_found`), #194 (bench budget enforced).

## Contract changes

None. `GitVersion.features` is `Record<string, boolean>`; the new `forEachRefAheadBehind` flag needs no schema
change. The `GitCore` interface is unchanged.

## Dependencies

None added or removed (`pnpm credits` not needed; `pnpm credits:check` runs in `pnpm lint`).

## Known gaps

- Under 450 at startup needs #10 (the second `status`/`diff` per worktree is the daemon's review-file pass).
- The remote-config `config` read (forge integration, per project) is not cached; it is per project already.
- The review base's `rev-parse --verify` (1 per project at startup) could be skipped when the base is a commit
  git-core itself produced (merge-base output); left out to keep the check exact.
- Ownership-based fallback (another user's worktree) is not covered by a test (needs a second uid); the code
  path is the pre-existing `rev-parse` discovery.
- `refs/replace/` changes are not seen by the commit-facts memo until restart (DECISIONS #193).

## Notes for integration

- Merges cleanly with the daemon only through the unchanged `GitCore` interface; no daemon file was edited.
- #30 (integration base incl. the remote default ref) should change `resolveRefName` / `resolveDefaultBranch`
  only: `readBranchBase`, the scope and the summary already share it.
- The `startupSpawns` budget is enforced on every layout; if #10 changes the startup window, re-run the bench.

## Combined with #10 (stacked, measured after the rebase)

`pnpm --filter @octopus-diff/e2e bench` on this branch stacked on `perf/startup-once` (#10), 30 x 3, exit 0, `docs/bench/results.*` regenerated: startup git spawns **415 for 90 worktrees (4.6 per worktree, budget <= 8 PASS)**, which meets the "under 450" target that the branch alone (626) did not; all summaries ready 862 ms (target ~1.0 s), cold paint 152 ms, warm reload 71 ms, edit -> SSE p95 20 ms, idle CPU 0.23 %. `pnpm check` exit 0 on the stack (git-core 200, daemon 222, web 248 tests).
