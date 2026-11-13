# file-explorer-foundation report (roadmap #9, step 27, M5)

## Shipped

- **git-core: a lazy per-directory listing** (`packages/git-core/src/tree.ts`; `GitCore.listTree`, `countTreeFiles`).
  - **How it reads.** `listTree(worktree, { ref, path, rawPath })` resolves the commit and its root tree, then walks
    tree objects one component at a time. Each tree is read with `ls-tree -z -l <tree oid>` and the next component is
    looked up by its raw bytes.
    - The ref is `HEAD` (from the HEAD file), a full id (memoized), or a branch or tag (from the ref files, else
      `rev-parse --verify --end-of-options`).
    - No path, pathspec or ref ever reaches git's command line.
    - A symlink or a submodule ends the walk: it is never entered.
    - The working tree is never read.
  - **What it returns.** Entries `{name, rawName?, path, rawPath?, kind: file|dir|symlink|submodule, mode, oid,
    size}` in git's tree order, plus `{commit, tree, kind}` of the path.
  - **Cache.** Listings are cached by `(common dir, tree oid)` in a 64 MiB LRU (single-flight, cancellable), shared by
    every worktree, branch and commit holding the same directory.
  - **`countTreeFiles`.** One `ls-tree -r -z` of a tree, memoized. It tells whether a directory's tracked files are
    all deleted.
- **Allowlist.** `ls-tree` was added, but only with `-z`, `-l`/`--long`, `-r` and **exactly one full object id**. Paths,
  refs, `--` / `--end-of-options` and every other option are refused, and there is no stdin (DECISIONS #396).
- **Contracts** (one `contracts:` commit, DECISIONS #395; `packages/contracts/src/tree.ts`):
  - the route `GET /api/worktrees/:worktreeId/tree?path=&rawPath=&ref=&limit=&cursor=`, with `ApiClient.getTree`;
  - the schemas: `TreeQuerySchema`, `TreeResponseSchema`, `TreeEntrySchema`;
  - the tree order (`compareTreeNames`) and paging (`pageTreeEntries`, `treeListingKey`): state-bound opaque cursors
    `t1.<16 hex>.<offset>`, at most 5000 entries and 900 KB per page;
  - `worktree.changed.dirs` (`{ all, dirs[] }`, at most 100 directories and 8000 characters).
- **Daemon** (`apps/daemon/src/tree.ts`, `core.ts` `listTree`, route `getTree`):
  - **Working view** (no `ref`): HEAD's listing (the summary's `headSha`) overlaid with the cached `working` list of the
    same state. Warm, a listing spawns no git process.
  - **Tree view** (`ref`): the commit's tree only.
  - **Overlay rules** (DECISIONS #398):
    - statuses come from the working list; a rename's source is listed as `deleted` with `renamedTo`;
    - new files and directories are listed, a new directory as `untracked` or `added`;
    - a HEAD directory whose tracked files are all deleted is `deleted`;
    - a directory's `changes` counts the changed paths below it;
    - directories omitted above the untracked cap (#43) carry `untrackedOmitted`;
    - ignored files are not shown; a sparse checkout is documented, not refused.
  - **Conflicts.** The working list leaves out a conflict whose content equals HEAD, so conflicts come from the
    summary snapshot (#399).
  - **Directory deltas** on `worktree.changed` come from consecutive summary snapshots, with no git process (#400).
  - **Signals.** Request cancellation (#44/#81) runs through the interactive lane.
- **Web data layer** (`apps/web/src/api/tree.ts`, plus a few lines in `api/cache.ts`; no pane, DECISIONS #402):
  - `useTree(worktreeId, dir, { ref, enabled })`, `treeKeys`, `fetchTreeDir`, `loadMoreTree` (loaded-prefix paging as
    in #42);
  - `collectTreeDirs` / `flushTreeDirs`, wired into `collectEventEffects` / `flushEffects`: exactly the named open
    directories refetch, and `all` (or no `dirs`) refetches the worktree's whole working view.
- **Benches**:
  - `pnpm --filter @octopus-diff/e2e bench:tree` (`e2e/bench/tree.ts`; results in `docs/bench/results-tree.{json,md}`);
  - `pnpm --filter @octopus-diff/web perf:tree` (`apps/web/scripts/tree-perf.ts` and the dev-only page
    `scripts/tree-perf/`; results in `docs/bench/results-tree-render.json`);
  - both are described in the bench README.

## Verification

All runs are on this machine (12-core WSL2, Node 26, git 2.53), from the repository root, on the branch head unless
noted. Another session's git-core tests (worktree `t3-ddbc7073`) were running on the machine during part of this, so
timings are noisy upward.

- `pnpm lint`: exit 0. It reports 4 warnings and 1 info, all in files this branch does not touch. Credits are up to
  date (no dependency change).
- `pnpm typecheck`: exit 0. `pnpm build`: exit 0.
- `pnpm test`: exit 0 in 1 min 37 s. Counts by package:

  | Package | Passed | Skipped |
  |---|---|---|
  | contracts | 130 | 0 |
  | forge | 101 | 5 |
  | fixtures | 58 | 0 |
  | web | 487 | 0 |
  | git-core | 503 | 1 |
  | daemon | 441 | 4 |
  | e2e unit | 8 | 0 |
  | cli | 141 | 0 |
  | scripts | 34 | 0 |

- git-core and daemon, run twice more: the same counts each time. git-core: 503 passed, 1 skipped (49-50 s). Daemon:
  441 passed, 4 skipped (26 s).
- Folding mode (`OCTOPUS_DIFF_TEST_FOLDS_CASE=1`): git-core 488 passed, 16 skipped; daemon 439 passed, 6 skipped.
- `pnpm test:e2e -- --workers=1`: **106 passed (3.5 min)**. The read-only proof covered 12 control repos and 4561 lock
  polls, with **0 violations**. The `git-core has been disposed` lines in the log are the usual fixture-teardown noise
  that earlier reports also mention.
- `pnpm --filter @octopus-diff/web perf:smoke`: exit 0, no failed check.
- CI-only steps from `.github/workflows/ci.yml`:
  - CLI smoke: `--version` and `doctor` run, with 0 problems.
  - `pack:tarball` (9.5 MB, 1070 files), installed into an empty directory: `--version` runs, the doctor's `git-helper`
    check is `ok`, and `smoke-tarball.mjs` passes all three checks (diff through the daemon, helper present, nothing
    left after SIGKILL).
- **Default bench** (`pnpm --filter @octopus-diff/e2e bench --out /tmp/bench-default`, not committed): exit 0, all 9
  budgets PASS:

  | Budget | Measured |
  |---|---|
  | Cold first paint | 190 ms |
  | Warm reload | 76 ms |
  | Startup spawns per worktree | 4.6 |
  | Idle CPU | 0.17 % |
  | Write → SSE p95 | 22 ms |
  | Diff during a burst p95 | 63 ms |
  | Traffic per edit | 1449 B |
  | `/api/projects` per edit | 0 |
  | Write → sidebar p95 | 30 ms |
- **New tests:**
  - **contracts** `tree.test.ts` (8): tree order, and a paging property test (200 rounds of random page sizes that add
    up exactly once). Also: restart on another listing, byte bounds, schema refusals (traversal, NUL, option-like refs,
    revision syntax) and the event cap.
  - **git-core** `tree.test.ts` (16):
    - every listing is compared with the fixture's own `git ls-tree -z -l`, including a randomized differential over
      every directory of 6 random trees;
    - symlinks (inside, to `/`, `../..`) and submodules are never entered, also as a middle component;
    - traversal and malformed paths are refused before any spawn;
    - refs: HEAD, branches, annotated tags, full and short ids; unknown and option-like refs;
    - only `ls-tree -z -l <40 hex>` lines are ever spawned;
    - an unborn HEAD; the working tree is never read;
    - the cache: a repeat and a linked worktree spawn nothing;
    - names that are not UTF-8 and case-colliding names, both built with `git mktree` so the tests run on APFS;
    - also: `countTreeFiles`, the LRU bound, the parser. `runner.test.ts` covers the allowlist, and
      `readonly.test.ts` now lists every directory of HEAD.
  - **daemon** `tree.real-git.test.ts` (10) and `tree-units.test.ts` (11):
    - **Differential against `git status --porcelain=v1 -z -uall` / `--ignored` and `git ls-tree -r`.** The whole
      working view is walked through the route in pages of 2, 7 and 1000. It is checked for: modified, staged, both;
      deleted (a whole directory and part of one); a staged rename; untracked nested directories; staged additions in a
      new directory; mixed new directories; ignored files and directories; a tracked file matching an ignore rule;
      symlinks (to a directory, retargeted, untracked, to `/`); a type change, a mode change; a submodule whose commit
      moved; Unicode and space names; a non-UTF-8 name (Linux); a case-only twin (non-folding file systems); a merge
      conflict (`UU`, `AA`, `UD`); a sparse checkout.
    - **Paging property.** 12 rounds of random page sizes, with edits and refreshes mid-paging: the pages always equal
      the final listing, and restarts happened.
    - **Security.** 14 malformed queries answer 400; option-like names are listed as plain names; symlinked directories
      (in and out) answer 400 / 404 in both views; the tree view does not move when the working copy is deleted.
    - **Warm path.** A warm listing spawns 0 git processes.
    - **Deltas.** A new file names its 4 ancestor directories; re-editing a modified file names none; a commit sends
      `all`.
    - **Abort.** An aborted request spawns nothing.
  - **web** `tree.test.tsx` (5): cursor following and restarts; `useTree` enabled and disabled; `loadMoreTree` and a
    refresh that keeps the loaded count; batch accumulation; only the named open working-view directories refetch, and
    tree views are untouched.
- **Mutation checks:** 15 mutants, **15 killed** (script applied and reverted each one; the working tree is clean
  after). Each mutant was killed by its targeted test:
  - git-core: the allowlist accepts any argument; the walk enters non-directories; no `..` check; the kind is reported
    for a middle component.
  - daemon: no rename-source record; deleted directory without the count; no pairing signature; a HEAD move ignored;
    no snapshot conflicts; a non-directory served in the working view; omitted directories left out.
  - contracts: the cursor fingerprint ignored; the listing key without the overlay. The second one survives the daemon
    test (the daemon's key also holds the `stateHash`) but the contracts test kills it.
  - web: only the last event of a batch is kept; trees are not refreshed by events.
  - One mutant is equivalent and was not counted: the git-core cache key without the common dir. An object id names
    the same content everywhere; the common dir is kept for isolation, #397.
- **Acceptance numbers** (100k `large` layout, `docs/bench/results-tree.md`):

  | Check | Target | Measured |
  |---|---|---|
  | Directory listing, warm | < 20 ms | p50 0.8-0.9 ms, p95 0.9-1.3 ms, 0.3-0.7 ms daemon CPU per request |
  | Directory listing, cold (first listing of the directory) | - | 1.6 ms (root), 8.0 ms (2 new trees), 14.4 ms (6 new trees); 0.8-0.9 ms in the other worktrees (trees shared) |
  | 100k-path tree render | < 300 ms | 133 ms to paint, all 100k paths open (p95 134); 67 ms with prepared input; lazy root 33 ms |
  | Scroll | p95 < 20 ms | frame p95 17.2 ms (60 Hz, full 100k) and 17.2 ms (lazy), 0 long tasks |
  | Allowlist | unchanged, or only justified flags | `ls-tree` added with 4 flags and one object id (#396) |

  - The **first** request of a worktree costs 200-580 ms. That is the worktree's `working` list (status plus diff of
    the 300k-line rewrite in `main`), the same list `GET /files` builds; any later directory reuses it.
  - Web render bench raw numbers (5 runs each):

    | Scenario | Paint p50 / p95 |
    |---|---|
    | All closed | 133 / 150 ms |
    | All open | 133 / 133 ms |
    | Prepared | 67 / 68 ms |
    | 300 statuses | 133 / 135 ms |

    48 rows are mounted after scrolling 3.1 M px of rows. In the lazy scenario, 200 directories were opened one by one:
    each open took 33 ms including two frame waits, and 0.2 ms (p95 0.4) of script.

## Decisions

All are in `docs/DECISIONS.md` (the next free number was 395):

- **#395** Additive contracts. Without `ref` the route answers the working view; with `ref`, including `ref=HEAD`, the
  committed tree.
- **#396** The walk over tree objects, and the strict `ls-tree` allowlist entry.
- **#397** git-core's cache by (common dir, tree oid), 64 MiB LRU; the daemon's composed pages by state.
- **#398** The working-view rules: ignored files not shown; sparse checkout documented; case compared as bytes; nested
  repositories.
- **#399** Conflicts from the snapshot.
- **#400** Directory deltas from snapshots, with caps and `all`.
- **#401** Route errors.
- **#402** The web data layer and its staleness rules.
- **#403** `@pierre/trees` holds 100k paths, but the explorer stays lazy (transport and overlay, not render, are the
  cost).
- **#404** No `cat-file --batch` (numbers below).

## Contract changes

All additive, in commit `contracts: GET /tree …`:

- `packages/contracts/src/tree.ts` (new; exported from the index);
- `ROUTES.getTree`, `ApiClient.getTree`, `TreeParams`;
- `WorktreeChangedEventSchema.dirs` (optional);
- `GitCore.listTree?`, `GitCore.countTreeFiles?`, with `TreeListOptions`, `GitTreeEntry`, `GitTreeListing`;
- `paging.ts` now exports `Hash64` (no behaviour change).

Nothing was renamed or removed.

## Dependencies

None added or removed. `@pierre/trees` (already a dependency) is benchmarked as it is. `pnpm credits:check`: up to
date.

## Profile: where the time goes (100k layout)

| Stage | Cost | Note |
|---|---|---|
| git: one tree | ~2.4 ms per `ls-tree` (through the spawn helper) | 7 ms for the root cold, including the commit → tree `rev-parse`; then cached forever (immutable) |
| git: the whole tree | `ls-tree -r` of the root: 46 ms, 100,002 files | 5.3 MB as a JSON path list |
| git: the overlay | the worktree's `working` list: 200-580 ms once per state | shared with `GET /files`; #40-#43 made it incremental |
| parse | `ls-tree` parse about 0.6 µs per entry | a 50k-entry flat directory: 31 ms, ad hoc |
| compose | overlay merge about 0.5 µs per entry; listing key 0.3 µs | 50k entries: 25 ms and 17 ms, once per state and directory, then cached |
| transport | 0.8-4.7 KB per directory; a warm loopback round trip 0.8-0.9 ms, of which daemon CPU 0.3-0.7 ms | a 5000-entry page: 760 KB, 1.2 ms to stringify |
| render | the root painted in 33 ms (lazy); 0.2 ms of script per opened directory; all 100k: 133 ms (67 ms prepared) | scroll stays on 60 Hz frames |

Walking every directory through the route takes 4980 requests, 19.7 MB and 17 s. That is fine for an explorer, which
opens what the user opens, and wrong for "all files": a search over all files belongs in the daemon (like
`GET /files?q=`).

**`cat-file --batch`: not built.** The explorer reads no blob content. A cold listing is one `ls-tree` per new tree
(about 2.4 ms); warm there is none. A long-lived batch process would save about 2 ms per cold object read. It would
cost stdin allowlisting for `cat-file` and a second supervised process next to the spawn helper. Revisit with a file
preview, if reads dominate there.

## Recommendation for local file data with Electron (short)

- **Keep one owner.** The daemon (DaemonCore plus git-core) stays the only code that runs git and holds caches. In
  Electron it should run in a utility process (or the main process), never the renderer. Several windows then share
  one tree cache and one set of summaries.
- **Transport.** Keep the HTTP + SSE contract: the browser and LAN clients need it. A warm directory costs about
  0.9 ms round trip, of which 0.3-0.7 ms is daemon work, so IPC could save at most about 0.3-0.5 ms per request. That
  is not decisive.
  - If profiling of the real app shows otherwise, add an `ApiClient` over a `MessagePort` that carries the same
    contracts objects (structured clone, no JSON). It is a drop-in, because every consumer uses `ApiClient`.
- **What to cache where:**
  - immutable data (tree listings, commit → tree, file counts, later blob content by oid) in the daemon, by
    `(common dir, oid)`, bounded;
  - working-copy data (status, overlay) per worktree in the daemon, keyed by `stateHash`;
  - in the renderer, only the open directories (React Query, refreshed by `worktree.changed.dirs`).
- **Never ship whole-repository lists to the renderer.** Page or search on the daemon side. Blob content can use the
  oid as a cache key (or HTTP ETag) forever.

## Known gaps

- **No explorer pane.** The issue did not ask for one; the data layer and the measured lazy design are ready for it.
- **The web mock** (`apps/web/mock`) does not serve `GET /tree`. Nothing in the UI calls it yet.
- **What the working view does not show:**
  - ignored files;
  - the contents of omitted untracked directories, and single omitted untracked files outside them (no list holds
    them, #43);
  - a sparse checkout's out-of-cone paths are not flagged;
  - an untracked nested repository appears as a file-like entry.
- **When `dirs` is absent or `all`:**
  - `dirs` is absent on a worktree's first summary and after an error (clients refresh all open directories then);
  - it is `all` when the snapshot was cut at 2000 changed entries.
  - `dirs` is a superset: a named directory may come back unchanged.
- **The first `/tree` of a worktree** waits for its working list (200-580 ms on the 100k layout), like `GET /files`.
- **Linux-only tests.** On APFS the daemon's non-UTF-8 differential case is skipped (the file system refuses such
  names). git-core covers those names with `git mktree` on every platform.

## Notes for integration

- Commits on this branch, in order: `contracts:`, `git-core:`, `daemon:`, `web:`, `bench:`, a lint fix, then the
  docs. They rebase independently of the Effect foundation session. The daemon changes are additive inside
  `core.ts`: a `treeBasis` field, the `#announce` parameter `dirs`, the `listTree` method and the `#treeListings` LRU.
  They do not touch runtime wiring, the watch host or helper supervision.
- DECISIONS #395-#404 may need renumbering if #395+ is taken meanwhile.
- `bench:tree` needs `pnpm build` and takes about 1.5 min. `perf:tree` builds its own page and takes about 1 min.
  Neither runs in CI.
