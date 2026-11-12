# integration-base report

Roadmap #30 "git-core: integration base that includes the remote default ref" (step 09 of #24, first step of
the merge-noise work). Branch `feat/integration-base` (from `main` at `cecd2cc`). DECISIONS **#196** (next free
number on `main`; another session uses #195 on a parallel branch: renumber at merge if they collide).

## Shipped

- `packages/git-core/src/integration-base.ts`: `U` = local default branch + `refs/remotes/origin/<d>`;
  `integrationBase` = `N = merge-base HEAD <local> <remote>`; `resolveTip` = `TIP` (newer of the two refs, the
  remote when diverged; internal, not used by a scope yet: #32 needs it); `remoteTrackingOf`.
- `planScope` (`scope.ts`): the `branch` scope and `branch` + `includeWorking` ("All on branch") diff against `N`
  when the base is the default branch. An explicit scope `base` is taken as given.
- `readBranchBase` (`branch-base.ts`) also reports the remote-tracking ref (files only, no spawn); the daemon's
  branch-scope file cache key (`#branchBase`, also the summary's `stateHash`) is `ref=oid+remoteRef=remoteOid`.
- `commits.ts`: `mergeBaseOfTips` (memoized like the other commit facts).
- Oids come from the ref files (`resolveRefName`, #189); the per-project `for-each-ref` is only the fallback.
  No new git subcommand: allowlist, read-only proof harness and `tools/fixtures` unchanged.
- Spawn cost: `N` is one memoized `merge-base` per (HEAD, local, remote), replacing the old two-ref
  `merge-base`; none when HEAD is one of the two refs (the default branch's own worktree) or the refs are equal.
- Docs: `docs/PLAN.md` §4.2 and `docs/STATUS-FLOW.md` say "integration base".

## Verification

Machine: 12-core WSL2, Node 26.13, git 2.53.0.

- `pnpm check`: exit 0. lint incl. `credits:check` (up to date), typecheck, build, tests: contracts 83, forge 94
  (+4 skipped), git-core **219** (19 files; new `integration-base.test.ts`, 17 tests), fixtures 53, web 248,
  daemon **224** (+1 skipped; 2 new in `branch-cache.real-git.test.ts`), e2e unit 5, cli 139, scripts 34.
- New git-core tests (scratch repos in `mkdtemp` dirs, isolated config, bare repo as `origin`, `clone`/`push`/
  `fetch` between local dirs): the stale-main fixture excludes `origin/main`-only files from the `branch` scope
  and from `branch+working`; configured `defaultBranch` (`main`, and `origin/main`); explicit `base` as given;
  `readBranchBase` with `remote` (loose, packed, symbolic remote ref via git) following a fetch; no remote; no
  tracking ref; the default branch's own worktree; feature that never merged `origin/main`; local main ahead;
  diverged main/origin; a remote ref with a missing object (falls back to the local base); spawn counts (1
  `merge-base` across three listings, 0 for the default branch's worktree); `N` and `TIP` (remote ahead, local
  ahead, diverged, equal).
- Daemon tests: "a move of the remote-tracking ref invalidates too" (cache hit while nothing moved; after
  `update-ref refs/remotes/origin/main` the list is recomputed and loses `f.txt`) and the stale-main inbox test.
- Mutation checks: making `planScope` ignore the remote fails 5 git-core tests; reverting the daemon key to
  `ref=oid` fails the daemon invalidation test.
- Bench, `pnpm --filter @octopus-diff/e2e bench --no-ui --idle-seconds 5` (30 × 3 = 90 worktrees; before = `main`
  at `cecd2cc` built in a scratch worktree, after = this branch): startup spawns **415 (4.6 / worktree) → 413
  (4.6 / worktree)**, budget ≤ 8 PASS, exit 0 both times. By subcommand after: `status` 90, `diff` 90,
  `check-attr` 90, `config` 52, `rev-parse` 30, `worktree` 30, `for-each-ref` 30, `--version` 1; no `merge-base`.
  The bench repos have no remote, so this window does not exercise the new pairing; its cost is the swap of one
  `merge-base` for another, see Decisions. The committed `docs/bench/results.*` were not updated (they are the
  full-run files from #29; I restored them after my runs).
- `pnpm test:e2e`: **91 passed** (2.7 min), exit 0. Read-only proof: **12 control repos, 3869 lock polls, 0
  violations**. No shutdown hang this run (BLOCKERS Open 2 did not trigger); 16-copy.spec.ts:226 passed. The log
  has the usual `git-core has been disposed` request errors between specs (same as #29's report).
- The hostile-config and `readonly` git-core tests are part of the 219 and pass unchanged.
- Not run: the full-UI bench (`pnpm --filter @octopus-diff/e2e bench` without `--no-ui`) and the large layouts;
  the `--no-ui` run above is the startup-spawn budget check the task named, and nothing in the UI paths changed.

## Decisions

DECISIONS #196: `N`/`TIP` definitions, cost, what stays unchanged (no remote or tracking ref, explicit scope
`base`, remote/tag default names, a missing remote object), the additive contract field and why it was
unavoidable, and the limits below. One judgement call to flag: a configured `defaultBranch` override that names a
local branch (`main`, `develop`) **is** paired with `origin/<name>` (the bug is identical with an override); say
so if you want overrides left strictly alone.

## Contract changes

`BranchBase.remote?: { name; ref; oid }`, additive and optional, separate commit `contracts: BranchBase.remote…`
(`10350bd`). Why: HEAD is not an input of `readBranchBase`, so the cache identity cannot be `N` itself; it must
carry both default-branch refs, and the old `ref`/`oid` pair holds one. Only the daemon's key uses it. #31's
origin fields do not touch `BranchBase`.

## Dependencies

None added or removed.

## Known gaps

- The daemon never fetches: a stale remote-tracking ref leaves `N` old (the documented limit).
- Only `origin` is paired (as default detection only looks at `origin/HEAD`); fork workflows on `upstream` keep
  the old behaviour.
- Not changed: the summary's ahead/behind base (still local default branch: the stale-main fixture shows `ahead 3`
  because `origin/main`'s commit counts), the review range's merge base (`review.ts` `mergeBaseWithDefault`) and
  `readRepositoryInfo`. They are #32/#31's territory; switching them is one call to `integrationBase`.
- `TIP` has no consumer yet (unit-tested only).
- A squash merge of the default branch into the feature is not "absorbed" by ancestry; criss-cross merge bases
  give git's single best base.
- New cost in remote-bearing projects: none per se (one `merge-base` replaces one), but a `fetch` that moves
  `origin/main` now changes the base identity, so every worktree's branch-scope list and `stateHash` recompute
  once (like a local default-branch move already did).

## Notes for integration

- Touches `apps/daemon/src/core.ts` (the key, 5 lines) because the cache key must follow the base; the daemon
  stream should know. `docs/bench/results.*` untouched.
- DECISIONS #196 vs the parallel session's #195: independent paragraphs, append order only.
- For #32: `integrationBase(ctx, repo, head, base, remote)` and `resolveTip(...)` in
  `packages/git-core/src/integration-base.ts`; `remoteTrackingOf` finds the remote ref.
