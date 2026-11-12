# daemon-activity report

Roadmap #38 "daemon: activity ring and /activity route (live view)" (step 19 of #24). Branch `feat/daemon-activity`
(from `main` at `4c9e780`). DECISIONS **#218-#224** (#218 is the contracts entry; other open branches may also use
these numbers; renumbered from #212-#218 when other branches took #212-#217). The web side (Activity strip, "N deleted" chip) is #39.

## Shipped

- **Contracts (separate `contracts:` commit `27e5767`, DECISIONS #218).** New `packages/contracts/src/activity.ts`:
  `ActivityEntrySchema` (flat: `id`, `seq`, `kind`, `at`, `updatedAt`, `count` + per-kind optional fields: `path`,
  `rawPath`, `oldPath`, `xy`, `added`, `deleted`, `oid`, `untracked`, `origin`, `originVia`, `sha`, `subject`, `op`,
  `from`, `to`, `branch`, `fromBranch`, `inProgress`, `paths`, `pathCount`, `kinds`, `truncated`), kinds `added |
  modified | deleted | restored | commit | head | bulk`, `ActivityHeadOpSchema`, `ActivityResponseSchema` (`{
  worktreeId, entries, seq, dropped, live, watch: { mode, pollMs } }`), `ActivityQuerySchema` (`after`),
  `BlobQuerySchema` / `BlobResponseSchema`, constants (ring 200, global 20000, coalesce 10 s, bulk threshold 50, 20
  listed paths, blob cap 1 MiB). Routes `getActivity` `GET /api/worktrees/:worktreeId/activity?after=<seq>` and
  `getBlob` `GET /api/worktrees/:worktreeId/blob/:oid?maxBytes=`; client methods `getActivity`, `getBlob`; optional
  `activitySeq` on `worktree.changed` (no new event); optional `ChangeCounts.deleted`.
- **`apps/daemon/src/activity.ts`.** Pure: `snapshotState`, `classifyHead`, `diffSnapshots`, `countDeleted`.
  `ActivityStore`: per-worktree rings with one daemon-wide sequence, coalescing, bulk folding, caps (200 per worktree,
  20000 overall, 4 MiB estimated), `dropped`, the blob allow-list, `resetBaseline`, `forget`. Memory only.
- **Core wiring (`apps/daemon/src/core.ts`).** `#computeSummary` asks `getSummary(..., { snapshot: true })`, strips
  the snapshot before the summary is stored (never in an API body), sets `counts.deleted`, runs `#recordActivity`
  (after the review state when that is wanted, before `#announce`), and `#announce` adds `activitySeq`. HEAD moves on
  the same branch read `listCommits(limit 32)` once to tell commit / merge / reset apart. Rings are forgotten with
  their worktree or project; a missing or replaced worktree gets a new baseline. `activity()`, `readBlob()`,
  `activityStats()`. `ReviewComputed.origins` keeps the non-own labels the review state already computed, to label
  entries (no new origin reads).
- **Routes (`apps/daemon/src/app.ts`)** behind the token, with the existing Host/Origin/CSP/no-store middleware.
- **`WatcherService.liveness(id)`** (`apps/daemon/src/watcher.ts`): `native | polling | disabled` and the current poll
  interval, for "polling every N s".

## Verification

Machine: 12-core WSL2 (Ryzen 7 7800X3D), Node 26.13, git 2.53.0. All results are real.

- `pnpm check`: **exit 0** (1 min 18 s). lint (incl. `credits:check`; one pre-existing biome `info` in
  `apps/daemon/test/file-origins.real-git.test.ts`, not touched), typecheck, build, tests: contracts **104** (+6, new
  `test/activity.test.ts`), forge 101 (+5 skipped), git-core 276, fixtures 54, web 284, daemon **323** (+1 skipped;
  +39: `test/activity.test.ts` 34, `test/activity.real-git.test.ts` 5), e2e unit 5, cli 139, scripts 34.
- **Unit tests (`apps/daemon/test/activity.test.ts`, 34):** edit (`modified`, latest +/-), clean file changed, new
  untracked / staged / renamed (`added`, `oldPath`), deletion in the worktree / `git rm` / edited-then-deleted (oid =
  index blob, else HEAD blob), untracked deletion (`oid: null, untracked`), staged-new file vanishing (staged blob),
  restore and re-create, a rename's source not restored, index-only change ignored, `rawPath` keys,
  `countDeleted`; commit (paths attributed, not restored), two commits in one refresh, first commit on an unborn
  branch, checkout, `reset --hard` while dirty (a `reset`, never a commit), `reset --soft`, pull (behind drops) and
  merge commit, in-progress ops, `moved`, `needsCommits`; bulk fold (60 -> one entry, 20 sample paths; 50 stays
  per-file), truncated -> coarse bulk, origin labels (and a bulk of base files); baseline, coalescing (sliding 10 s,
  id stable, new seq, `after` returns the update, apart after 10 s), no coalescing across kinds / commits / HEAD
  changes, rebase run folded first-to-last, ring cap 200 + `dropped` boundaries + `after` from an earlier run, global
  cap (globally oldest first) + `forget`, blob allow-list (entries, current snapshot, other worktree, after eviction),
  `resetBaseline`. **Memory** (`--expose-gc`, heap delta): 90 x 200 entries = 3.7 MB (asserted < 4.5 MiB, estimate <=
  4 MiB, all 18000 kept); 1000-character paths: byte cap evicts, heap < 5 MiB; 100 paths sliced from 100 KB strings
  retain < 1 MiB.
- **Real-git integration (`apps/daemon/test/activity.real-git.test.ts`, 5, run 4x green):** an "agent" in a watched
  repository edits, deletes a tracked file (blob served with its committed content; `counts.deleted` 1; raw
  `/api/projects`, `/api/inbox`, `/files` and `/refresh` bodies carry no snapshot fields), creates and deletes an
  untracked file (`untracked`, no oid), commits (one `commit` entry with subject and both paths, nothing restored,
  `counts.deleted` back to 0, blob still served), checks out a branch, dirties and `reset --hard HEAD~1` (a `reset`
  with the discarded path; still exactly one commit entry); `worktree.changed` carries `activitySeq`. Blob route: 6
  invalid ids -> 400, the HEAD commit / its tree / an unchanged blob -> 404 "recent activity", another worktree's
  oid -> 404, **zero `readBlob` calls for all of them**, `maxBytes` 2 MiB / 0 -> 400, `maxBytes=5` -> `too_large`,
  401 without token on both routes, unknown worktree 404, bad `after` 400, `no-store` + API CSP. **Spawn proof:** two
  identical repositories driven by manual refreshes (watching off), one with the snapshot option stripped by a
  git-core proxy: equal spawn totals after startup, an edit, a delete and a new file; the commit step costs exactly
  one more process, a `log`. **No persistence:** after the agent run no file under the state dir contains the deleted
  file's name, the untracked file's name or the secret content; a restarted daemon starts empty (`dropped` for an old
  `after`), `counts.deleted` still 1 (state-based). Forced polling reports `watch.mode: polling` with `pollMs`.
- **Mutation checks** (each reverted): allow-list off fails 1 test; HEAD-move attribution off fails 7; a
  non-descendant move counted as a commit fails 3; coalescing window x1000 fails 1; leaking the snapshot into the
  summary fails 1 (it passed before the raw-body check was added, so the check was strengthened).
- **`pnpm test:e2e`: 91 passed (4.4 min), exit 0.** Read-only proof: **12 control repos, 7023 lock polls, 0
  violations**; no shutdown hang (BLOCKERS Open 2 did not trigger; a monitor watched for a stalled log); 16-copy:226
  passed. The log has 4 `git-core has been disposed` error lines from `/files` requests at daemon shutdown; `main`
  (`4c9e780`, throwaway worktree) prints the same 4 lines in the same run (91 passed, 4.1 min), so they predate this
  branch.
- **Bench** `pnpm --filter @octopus-diff/e2e bench --no-ui --idle-seconds 5` (30 x 3 = 90 worktrees), before = `main`
  at `4c9e780` in a throwaway worktree, after = this branch, run back to back with `--out` to temp dirs (no
  `docs/bench/results.*` change). Both exit 0. Startup spawns **407 -> 420 = 4.5 -> 4.7 per worktree, budget <= 8
  PASS**. By subcommand both: `status` 90, `diff` 90, `check-attr` 90, `rev-parse` 30, `worktree` 30, `for-each-ref`
  30, `--version` 1; only `config` 46 -> 59 (the config scan's timing; the earlier no-ui "before" run on this
  machine today gave 418, and #37's report saw 58 -> 53 the same way). Listening / all summaries 1770 / 2189 ms ->
  1883 / 2399 ms (this machine was slower today than in earlier reports for both sides); edit -> SSE p50 / p95 29 / 38
  -> 31 / 56 ms; spawns per edit 5-42 both; idle CPU 0 %. **With the UI** (`--idle-seconds 5`, same pairing): cold
  paint **317 -> 247 ms**, warm reload 173 -> 182 ms, startup spawns 417 -> 421 (4.6 -> 4.7), listening / summaries
  1803 / 2356 -> 1621 / 2036 ms, edit -> SSE p50 / p95 32 / 84 -> 33 / 50 ms: unchanged within noise.

## Decisions

#218 contracts; #219 snapshot in every refresh, stripped, `counts.deleted`, baseline, `activitySeq`, origin labels from
the review state; #220 memory-only compact ring and its caps (measured 3.7 MB for 90 x 200); #221 diff rules,
attribution, bulk, coalescing; #222 HEAD classification with one `git log` per same-branch move; #223 blob route and
its allow-list; #224 watch liveness in the response.

## Contract changes

All additive, in commit `27e5767` (DECISIONS #218): a new module, two new routes, two client methods, two optional
fields on existing schemas (`WorktreeChangedEvent.activitySeq`, `ChangeCounts.deleted`). Nothing renamed or removed;
older payloads parse (tested in `packages/contracts/test/activity.test.ts`).

## Dependencies

None added or removed (`pnpm credits:check` passes inside `pnpm lint`).

## Known gaps

- **Granularity is the refresh** (<= 1 s with native watching, the poll interval otherwise): a file created and deleted
  inside one refresh never shows; two edits inside one refresh are one entry. Polled worktrees (`watch.mode` `polling`
  or `disabled`) get a coarse feed: one diff per poll.
- **Content of deleted files:** a tracked file's `oid` is its last staged or committed version; unstaged edits made
  before the delete were only on disk and are gone. Untracked files were never in git: `oid: null, untracked: true`
  ("content unavailable", #25 decision 8). A submodule gitlink's oid is a commit of the submodule, so the blob route
  answers 404 for it. A blob pruned by `git gc` answers 404 "content gone".
- **HEAD classification is a heuristic** on summary facts plus one `git log`: an amend shows as `reset`, a pull without
  a tracking ref shows as commits, more than 10 new commits in one refresh as `merge`, a failed read as `moved`. No
  reflog parsing (git internals stay in git-core).
- **Index-only changes** (`git add`, `git restore --staged`) are not entries; `git stash` shows as `restored`.
- **Truncated snapshots** (more than 2000 changed paths) give one `bulk` entry with `truncated: true` per changing
  refresh, no per-file detail; `counts.deleted` then counts the first 2000 entries only (tracked ones come first).
- **Origins** label entries only when the worktree's review state exists for that exact state (project opened, or the
  worktree changed after startup); otherwise entries have no `origin`.
- The e2e read-only proof does not call the new routes (e2e is WS4's, see Notes); it does now run every daemon summary
  with the snapshot option.
- The previous snapshot per worktree is kept in memory for the next diff (state, bounded by the snapshot cap of 2000
  entries); it is not part of the 4 MiB ring budget.

## Notes for integration

- #39 (web): fetch `getActivity(id, { after })` for the open worktree only, when `worktree.changed.activitySeq` moved
  past what you hold; replace entries by `id` (a coalesced entry comes back with a new `seq`); on `dropped: true`
  refetch from 0 and replace. `live: false` means no baseline yet. Show "view content" for `deleted` entries with an
  `oid` (`getBlob`), "content unavailable" for `untracked` or `oid: null`, and handle 404 from the blob route (entry
  fell off the ring, or pruned). `watch.mode !== 'native'` -> "polling every `pollMs / 1000` s". The sidebar chip
  reads `summary.counts.deleted` (absent = older daemon).
- WS4 may add a step to the e2e read-only proof that calls `/activity` and `/blob/:oid` for a deleted fixture file.
- `pnpm-lock.yaml`: unchanged.

## PR review round 1 (Greptile on #77)

- **Large worktrees hid edits** (valid). With more than 2000 changed paths the snapshot is truncated, and an edit to a path beyond the cap changes neither `total` nor any retained entry, so no coarse `bulk` entry was recorded although the state hash moved. `SnapshotState` carries the summary's `stateHash`, and a truncated snapshot whose hash changed gives the coarse entry (an untruncated one does not use it: its entries say what changed; a state without a hash behaves as before).
- **Old cursors hid new activity** (valid). Restart detection compared `after` with the daemon-wide counter, so a client holding `after=100` across a restart, with other worktrees having advanced the counter past 100, got no entries and `dropped: false`. A cursor beyond the worktree's own newest `seq` is now stale too, and the response carries `run` (this daemon's start time) which a client can send back (`?run=`): a different one is `dropped` whatever the counters say (additive contract commit). Test: the scenario of the report; a foreign `run`; an unknown worktree.
- **A removed worktree came back with its old baseline** (valid). `#recordActivity` wrote its snapshot after awaiting `listCommits` without checking that the worktree was still there, so `forget` could be undone and a re-added worktree compared against the old state. It now returns, after the await, when the project no longer has that worktree entry or its baseline was reset (the snapshot compared against is no longer the stored one). Test through a real daemon with `listCommits` held: a HEAD move waits for the log, the worktree is removed and re-added on a branch at another HEAD, and the new ring records nothing (it recorded a false move before). Each fix fails its test when switched off.
