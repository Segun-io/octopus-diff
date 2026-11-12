# live-snapshot-blob report

Roadmap #37 "git-core: summary snapshot and blob read (live feed)" (step 18 of #24, the first code step of the live
view). Branch `feat/live-snapshot-blob` (from `main` at `62e98ae`). DECISIONS **#209-#211** (#209 is the contracts
entry; other sessions may also have used #209, renumber at merge). Not wired into the daemon (#38) or web (#39).

## Shipped

- **Contracts (separate `contracts:` commit `c2a78e6`, DECISIONS #209).** New `packages/contracts/src/live.ts`:
  `GitObjectIdSchema` (full 40/64 lowercase hex, not the null id), `SummarySnapshot(Entry)Schema`,
  `BlobReadOptionsSchema`, `BlobReadSchema`, constants (`SNAPSHOT_MAX_ENTRIES_DEFAULT` 2000 / `_LIMIT` 20000,
  `BLOB_MAX_BYTES_DEFAULT` 1 MiB / `_LIMIT` 16 MiB). `GitCore.getSummary(worktree, options?: SummaryOptions)` returns
  `SummaryResult = WorktreeSummary & { snapshot?: SummarySnapshot }`; optional `GitCore.readBlob?`.
  `WorktreeSummarySchema` is unchanged (the snapshot cannot reach an API payload by accident).
- **Snapshot (`packages/git-core/src/snapshot.ts`, wired in `summary.ts`).** `getSummary(wt, { snapshot: true | {
  maxEntries } })` also returns `{ entries, total, truncated }`; an entry is `{ path, rawPath?, oldPath?,
  oldRawPath?, xy, hH, hI, sig, added, deleted }` built from the status entries, numstat map, lstat signatures and
  untracked inspection the summary already has. No new process, no new stat. Default path: no `snapshot` key, same
  `stateHash`. Tracked entries first, untracked after, cut at the cap (only the first `cap` are built).
- **Blob read (`packages/git-core/src/blob.ts`, wired in `core.ts`).** `readBlob(wt, { oid, maxBytes? })`:
  schema check (no process for a bad id), `cat-file -t` must say `blob`, `cat-file blob` with the runner's output
  cap = `maxBytes`, `cat-file -s` only when the cap trips (-> `too_large` with the size). Binary (NUL in the first
  8000 bytes) is flagged with no bytes; text is UTF-8 decoded. Errors: bad id / not a blob / bad cap =
  `invalid_argument`, unknown object = `not_found`.
- **No allowlist change.** `cat-file`, `-t`, `-s` and `blob` were already allowed; stdin stays forbidden (no
  `--batch`), `--filters` / `--textconv` stay forbidden. Justification in DECISIONS #211.

## Verification

Machine: 12-core WSL2, Node 26, git 2.53.0. All real results.

- `pnpm check`: **exit 0**. lint (incl. `credits:check`), typecheck, build, tests: contracts **98**, forge 101 (+5
  skipped), git-core **274** (21 files; new `test/live-snapshot.test.ts`, 20 tests), fixtures **54**, web 284,
  daemon 284 (+1 skipped), e2e unit 5, cli 139, scripts 34. (`biome check` prints one pre-existing `info` in
  `apps/daemon/test/file-origins.real-git.test.ts`; not touched.)
- **Snapshot tests** (scratch repos, isolated config): `.M` (counts 1/1), `.D` (`hH` = `hI` = HEAD blob, sig
  `missing`), `D.` (`hI` null), `R.` with `oldPath`, `A.` (`hH` null), `MM` (HEAD and index differ), binary (null
  counts), untracked (`??`, no oids, line count), nested untracked; stable signature, changed by an mtime edit; clean
  worktree and bare repo give an empty snapshot; non-UTF-8 name keeps `rawPath`; invalid caps rejected; **spawn
  counting** (wrapper logging every git process): the subcommand list with `snapshot: true` and with
  `{ maxEntries: 3 }` equals the plain call's, the plain result has no `snapshot` key and equals the snapshot
  result minus `snapshot`/`updatedAt`/`activityAt` (clamped to now); truncation (cap 3 of 9, exact cap 9 not truncated,
  tracked first); **30001 changed paths (30000 untracked + 1 tracked) -> 2000 entries, `truncated`, the tracked change
  first** (1.6 s).
- **Blob tests:** deleted tracked file read by the status oid before a commit, staged-deleted (`D.`, via `hH`), after the
  commit, and after `reset --hard` away from it; a staged-then-unstaged file (unreferenced loose object) still
  readable; exact argv (`cat-file -t <oid>` then `cat-file blob <oid>`, nothing else); 16 invalid ids (abbrev, `HEAD`,
  `HEAD:path`, uppercase, 39/41 digits, null id, `--batch`, newline, non-strings) and bad caps rejected with **zero
  spawns**; tree / commit / annotated tag refused after exactly one `cat-file -t`; unknown 40- and 64-digit ids and the
  hash of an untracked file = `not_found`; oversize (5000 B vs cap 1000: `too_large`, size 5000, 3 spawns;
  exactly-at-cap ok); default cap 1 MiB (1 MiB text, 1 MiB + 1 `too_large`); binary flagged without bytes, NUL after
  byte 8000 is text; empty blob; invalid UTF-8 replaced; filter / textconv / `core.fsmonitor` marker scripts never
  run; `disposed` after dispose.
- **Mutation checks** (each reverted): skipping the blob type check fails 1 test; ignoring the cap fails 2; swapping
  `hH`/`hI` fails 3; always `truncated: false` fails 2.
- **Read-only proof.** `packages/git-core/test/readonly.test.ts` now takes a snapshot of every worktree
  (incl. conflict, unborn, submodule, unreadable file) and reads every `hH`/`hI` through `readBlob`, plus a tree
  oid (refused); no lock file, no git-dir change, `git status` unchanged: pass. `tools/fixtures` harness test
  "passes for the blob read of the live feed" runs the exact argv (`--no-optional-locks cat-file -t/blob/-s`) in every
  fixture worktree under the proof: 0 violations. `runner.test.ts` allowlist test lists the three argv forms.
- **`pnpm test:e2e`: 91 passed (3.3 min), exit 0.** Read-only proof: **12 control repos, 5306 lock polls, 0
  violations.** No shutdown hang (BLOCKERS Open 2 did not trigger; log never stalled); 16-copy.spec.ts:226 passed.
  The e2e proof drives the daemon, which does not call the snapshot or `readBlob` yet; the new reads are covered by
  git-core's `readonly.test.ts` and the fixtures harness test above.
- **Bench**, `pnpm --filter @octopus-diff/e2e bench --no-ui --idle-seconds 5` (30 x 3 = 90 worktrees). Before =
  `main` at `62e98ae` in a throwaway worktree (built, then removed); after = the final branch. Startup spawns
  **419 -> 414 = 4.7 -> 4.6 per worktree, budget <= 8 PASS**, exit 0 both; listening / all summaries 739 / 921 ms
  -> 743 / 909 ms (noise). By subcommand: `status` 90, `diff` 90, `check-attr` 90, `rev-parse` 30, `worktree` 30,
  `for-each-ref` 30, `--version` 1 both; `config` 58 -> 53 (config-scan timing, not this change). Expected: the
  daemon does not ask for a snapshot. `docs/bench/results.*` were restored after the runs.

## Decisions

#209 contracts; #210 the snapshot is a reshaping (shape, caps, null oids, unmerged, counts, the `hI` limit);
#211 `readBlob` (2 processes, 3 for oversize; no allowlist change; error mapping).

## Contract changes

All additive (commit `c2a78e6`, DECISIONS #209); the return type of `getSummary` widens to an intersection that
existing `WorktreeSummary` values satisfy, `readBlob` is optional, `WorktreeSummarySchema` is untouched.

## Dependencies

None added or removed (`pnpm credits:check` passes inside `pnpm lint`).

## Known gaps

- **Deleted-file content is the index/HEAD blob, not the agent's last edit.** `hI` of a `.D` file is what was last
  staged or committed. Unstaged edits made before the delete were only on disk and are gone; untracked deleted files
  have no content (accepted decision 8 of #25). #38/#39 should word "content unavailable" for these.
- A file created and deleted inside one refresh is invisible (as #38 documents); a gitlink's `hH`/`hI` is a commit id
  of the submodule, which `readBlob` reports `not_found` (not in the superproject's objects).
- Unmerged paths give `hH` = stage 2 and `hI` null; the daemon should treat them as modified.
- A blob over the cap costs up to one cap of data read before git is killed (1 MiB default).
- The e2e read-only proof does not exercise `readBlob` (no daemon route yet; #38 should add one).

## Notes for integration (#38 daemon, #39 web)

- Ask for the snapshot only on the refresh that feeds the activity ring: `core.getSummary(wt, { snapshot: true })`;
  diff `entries` by `path` (`rawPath` for non-UTF-8 names), compare `sig` for "edited again" (opaque, equality only),
  use `added`/`deleted` for the +/- of an entry, `xy` for added/modified/deleted (`.D`, `D.`, `AD`...).
- A deleted entry's blob: `hI ?? hH` of the **previous** snapshot's entry (for `.D` both are set, for `D.` only `hH`).
  Keep the oid, never the content; serve it through `readBlob` with the route's own cap, mapping `not_found` to
  "content gone (pruned)" and `invalid_argument` to 400.
- `truncated: true` means the feed is coarse for that worktree: emit a `bulk` entry instead of per-file ones.
- `GitObjectIdSchema` is the schema for the `/blob/:oid` route parameter (lowercase it first if the client may not).

## PR review round 1 (Greptile on #70)

- **A path could appear twice** (valid). After `git rm --cached f` with the file still on disk, status lists `f` as a staged deletion and as untracked, and `buildSnapshot` appended both with conflicting `xy`, counting both in `total`: a caller keying entries by path lost the deletion when the untracked entry overwrote it. The tracked entry now wins (it carries the blob oids, so the removed content stays readable) and the untracked copy is neither listed nor counted. The cap counts the path once. Test: one entry `D.` with `hH` set and `hI` null, `total: 1`, unique paths (it listed two entries before).
- **Malformed `snapshot` options slipped through** (valid; AGENTS.md requires a contract schema for every boundary input). `snapshotCap` read `maxEntries` without checking the shape: `snapshot: null` crashed into `git_failed`, `snapshot: 5` silently enabled a snapshot. A new additive `SummarySnapshotOptionSchema` (`boolean | { maxEntries?: int 1..20000 }`, strict) in `contracts` (its own `contracts:` commit, `51e3d1e`) now parses the option first; anything else is `invalid_argument`. Tests: schema accept/reject cases in contracts; `null`, `5`, `'yes'`, `[]`, an unknown key and a string cap are rejected in git-core (they were not, before).
