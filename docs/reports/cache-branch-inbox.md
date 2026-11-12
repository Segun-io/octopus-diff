# cache-branch-inbox report

Roadmap #27 "Perf: cache the branch-scope inbox and files, dedupe in-flight requests" (milestone M1, part of #24).
Branch `perf/cache-branch-inbox`. DECISIONS #166–#170.

## Shipped

- **Branch-scope file lists are cached** (`apps/daemon/src/core.ts`, `#gitFiles`). Key:
  `(worktree, scope, stateHash, base)`, with `base` = `<ref>=<oid>` of what the scope diffs against (its `base`,
  else the project's default branch). `isCacheableScope` no longer excludes `branch`. A branch scope whose base
  cannot be read is not cached (as before).
- **`GitCore.readBranchBase`** (additive, `contracts:` commit; `packages/git-core/src/branch-base.ts`): the base's
  commit read from loose refs / `packed-refs` without spawning git, falling back to `for-each-ref` for symbolic
  refs and reftable repositories, so it always agrees with `planScope`.
- **The exposed `stateHash` also covers the default branch's commit** (`withBase`), so a default-branch move
  announces `worktree.changed` and "equal hash = nothing to refetch" stays true for branch scopes. The inbox and
  `/files` additionally read the base on every call, so a move is never served from cache even before the
  watcher notices.
- **Single-flight** in the daemon: file lists (existing, key now includes the base) and identical overlapping
  inbox requests (new, key = hash of everything the run reads; in-flight only, no result cache).
- **Web**: after `worktree.changed` the inbox patch fetches the list through the `files` query
  (`filesForPatch`, `apps/web/src/api/cache.ts`) instead of a side request, so the invalidation refetch of the open
  file pane and the patch are one request.
- Measurement script `e2e/bench/inbox-cache.ts` (spawn-traced built daemon, 30 × 3 layout, optional browser
  phase). Untracked by the `bench` package script; run from `e2e/`:
  `pnpm exec tsx bench/inbox-cache.ts [--no-ui] [--out file.json]`.

## Verification

Measured at the bench layout (30 repos × 3 worktrees = 90, all dirty), this machine (12-core WSL2, Node 26,
git 2.53), built daemon, `e2e/bench/inbox-cache.ts`:

| | before | after | issue target |
|---|---|---|---|
| `inbox?scope=branch&working=1`, repeat | 640–696 ms, **540 spawns** | **11–20 ms, 0 spawns** | 0 spawns, < 60 ms |
| first (cold) call | 648 ms, 540 spawns | 699–764 ms, 540 spawns | — (cold unchanged) |
| after one edit | 668 ms, 540 spawns | 22 ms, 6 spawns (that worktree) | — |
| after one commit | 663 ms, 540 spawns | 21–25 ms, 6 spawns | — |
| after the default branch moved | 697 ms, 541 spawns | 34–35 ms, 18 spawns (that project's 3 worktrees) | — |
| `files?scope=branch&working=1` requests per edit (UI) | 2 | 1 | no duplicate |
| warm reload (UI, `data-ready`) | 857 ms (script), 864 ms (issue) | 142 ms (script), **140 ms** (`bench.ts`, `--idle-seconds 5`) | < 150 ms |

The first `scope=working` inbox is cold too (270 spawns, ~370 ms); every later one is cached (existing behaviour).
Cold first paint and startup are #10's.

Commands and results (from the repo root):

- `pnpm check` → exit 0: lint (biome + `credits:check`), typecheck, build, tests: contracts 83, forge 94 (4
  skipped), git-core 183, fixtures 48, web 242, daemon 206, e2e unit 5, cli 139, scripts 34, all passing.
- New tests: `packages/git-core/test/branch-base.test.ts` (7: loose, packed, loose-over-packed, name order,
  symbolic fallback, null cases, linked worktree; spawn-counted through a wrapper binary);
  `apps/daemon/test/branch-cache.real-git.test.ts` (7: repeat = 0 spawns and < 60 ms; edit invalidates exactly one
  worktree; commit; default-branch move with the watcher off; default-branch move announces
  `worktree.changed`; forced refresh; single-flight, 6 concurrent requests = 3 listings); `apps/web/test/cache.test.ts`
  (+2: one `files` request per edit). Mutation-checked: without the `base` in the key the default-branch test
  fails; with branch scopes uncacheable four tests fail; with the old patch path the web test sees 2 requests.
- `pnpm test:e2e` → **90 passed (3.6 m)**, including the read-only proof (12 control repos, 5340 lock polls, 0
  violations) and `03-scopes` "branch scope against the default branch" (git oracle). The run then hung at the
  daemon shutdown after the last test (docs/BLOCKERS.md Open 2): its log stopped growing for 240 s and the run
  was killed; all tests had already reported.

## Decisions

DECISIONS #166 (key and numbers), #167 (`readBranchBase`), #168 (`stateHash` covers the default branch), #169
(inbox single-flight, no result cache), #170 (web). PLAN §5.3/§5.6 got one sentence each.

## Contract changes

Additive, in a separate `contracts:` commit: optional `GitCore.readBranchBase?(project, options?)` and the
`BranchBase` type. No existing field changed. (The `stateHash` comment in `domain.ts` was left alone; its
meaning is "any change that alters what a client shows", which the default branch's commit now is.)

## Dependencies

None added or removed (`pnpm credits` not needed; `pnpm lint` ran `credits:check` green).

## Known gaps

- The cold branch-scope inbox (first load after a daemon start) still costs 540 spawns / ~700 ms at 30 × 3;
  prewarming the lists after the summaries is #10's territory.
- The finished inbox is not cached, only overlapping identical requests share a run. A repeat is 11–20 ms at
  30 × 3, so not needed for the 60 ms budget; a result cache would need review-policy and project-row invalidation.
- Reftable repositories and symbolic base refs fall back to a git spawn per call (correct, not 0 spawns).
- The web test's mock backend does not model branch scopes (empty lists), so it asserts the request count and
  state hash, not the entry contents; the daemon tests cover contents against real git.
- Warm reload is 140–142 ms against a 150 ms target: it passes with little margin on this machine.

## Notes for integration

- **#30** (integration base including the remote default ref) changes what `planScope` diffs against: update
  `readBranchBase` and `DEFAULT_BASE_SCOPE` / `#branchBase` in `core.ts` together, or the key is no longer exact.
- **#28** (compression/ETag in `app.ts`) is independent; this branch does not touch `app.ts`. The summary's
  `stateHash` now changes on a default-branch move, which an ETag on `/api/projects` will pick up for free.
- **#26** owns the bench: `e2e/bench/inbox-cache.ts` is a standalone script and can be folded into it.
- **#12**: forced refresh drops the per-worktree file lists (and re-reads the base); forge caches are untouched.
