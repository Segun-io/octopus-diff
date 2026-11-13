# paged-files report (roadmap #42, step 26)

## Shipped

- **Measured first** (new `large-paged` layout: 40k tracked files, a linked `many-changed` worktree where a format
  run rewrote 36k of them; `pnpm --filter @octopus-diff/e2e bench:paged`). On main the first `GET /files` of that
  worktree took **12.2 s cold (13.3 s of CPU)** and answered **9.9 MB** raw / 1.0 MB gzip; the inbox was **10.4 MB**;
  the browser had not painted a file row of it after 5 minutes.
- **Two quadratic loops in git-core** (found with CPU profiles, DECISIONS #349): `trackedRows` looked up each path's raw
  entry by scanning the whole run (21 s of CPU), and the patch splitter re-searched every stdout chunk for each marker
  on each patch (1.8 s). Both are now linear; the cold list is **2.0-2.1 s** (git itself and `lstat` signatures).
  Runner internals untouched.
- **Contracts** (`packages/contracts/src/paging.ts`, one `contracts:` commit, DECISIONS #348): the paging order
  (`compareFileOrder`: own and mixed files, then the default branch's, each by path), `pageFileList`, `fileListKey`,
  `fileListCounts`, `fuzzyMatch` (moved from the web palette) and the limits. `GET /files` takes `limit`, `cursor`,
  `after`/`afterRawPath`, `unreviewed`, `origin`, `q`; answers `total`, `offset`, `position`, `nextCursor`,
  `truncated`, `restarted`, `counts`. `GET /api/inbox` takes `filesLimit`; rows carry `filesTotal`,
  `filesNextCursor`, `fileCounts`. The cursor is opaque and bound to the list's state; a cursor for another state
  answers with the first page and `restarted: true`.
- **Daemon** (`apps/daemon/src/core.ts` `listFiles`, `#pageable`, `#buildInbox`): pages are slices of the list the daemon
  already caches per state (sorted and keyed once per list, never a git run per page). Without `limit`, an old client
  gets the first 2000 files with `truncated`. No page carries more than 900 KB of rows. Inbox rows carry their first
  page (200 by default), and each inbox response is capped at 4000 files and 900 KB in row order. Bulk review, `patchHash`
  and the stale checks are unchanged: they already use the daemon's whole list (DECISIONS #350, #351, #356).
- **Web** (`apps/web/src/api/files.ts`, new; `state/model.tsx`, `state/commands.ts`, `components/FileList.tsx`,
  `CommandPalette.tsx`, `ScopeSelect.tsx`, `lib/bulk.ts`, `lib/model.ts`, `api/cache.ts`, `App.tsx`; the mock pages with
  the same helper):
  - The files query keeps the loaded prefix in one `FilesResponse` (500 per page), so every consumer keeps working.
    A refresh asks for the loaded length in one request, so the selection and scroll position stay (#352).
  - A partly loaded list has a footer ("500 of 36,150 files loaded", Load more). The next page loads near the end of
    the list, or when `j` reaches the end. The counts decide whether more rows would show, so a collapsed "from main"
    group of 36k files is not loaded (#353).
  - **`n`** walks the loaded files; where a list or inbox row is cut and its counts say more unreviewed files are
    beyond, it asks the daemon for the next one (`after` + `unreviewed` + `origin`) and loads the list through it (#354).
  - **Palette file search**: neither "search" nor a palette file jump existed. The palette now asks
    `GET /files?q=` for the open worktree and jumps to the file, loading the list through it. The same lookup keeps a
    selection that a refresh pushed past the loaded rows (#355).
  - **Bulk review**: a worktree whose list is not all loaded is sent without `paths` and counted from `counts`, except
    when the view hides files the request would change (#356).
  - Counts on screen come from `counts`; the sidebar's still come from the summary.
- **Bench** (`e2e/bench/paged-files.ts`, `bench:paged`; the `large-paged` layout and `manyChanged` in
  `tools/fixtures/src/large.ts`; `docs/bench/results-paged.{json,md}`; bench README "Paged file lists").

## Verification

All on this machine (12-core WSL2, Node 26, git 2.53), from the repository root, on the branch head.

- `pnpm lint`: exit 0 (4 warnings and 1 info in files this branch does not touch; credits up to date).
- `pnpm typecheck`: exit 0. `pnpm build`: exit 0.
- `pnpm test`: exit 0 (about 1.5 min): contracts 118, forge 101 + 5 skipped, fixtures 58, web 468, git-core 441 + 1
  skipped, daemon 417 + 4 skipped, e2e unit 8, cli 139, scripts 34.
- git-core and daemon run again: same counts (git-core 441 + 1 skipped three times; daemon 416/417 + 4 skipped three
  times; the watcher-review-fixes F1 flake did not show). Folding mode (`OCTOPUS_DIFF_TEST_FOLDS_CASE=1`): git-core
  426 + 16 skipped, daemon 415 + 6 skipped (414 + 6 before the last daemon test).
- `pnpm test:e2e -- --workers=1`: **106 passed (3.2 min)**, run twice (3.3 and 3.2 min); read-only proof 12 control
  repos, 4806 / 4946 lock polls, **0 violations**. The new spec `20-paged-files` passed 4/4 each time.
- `pnpm --filter @octopus-diff/web perf:smoke`: exit 0, no failed check (a refresh fetches 1 request, `/api/inbox`).
- CI-only steps: CLI smoke (`--version` 0.0.0, `doctor` 0 problems, 1 warning); `pack:tarball`, `npm install` of the
  tarball in an empty directory, `--version` and `doctor` (0 problems, 1 warning). macOS: not run here.
- **Default bench** (`pnpm --filter @octopus-diff/e2e bench`, 30 × 3 with the UI; written to /tmp, not committed):
  every budget passes. Cold paint 147 ms, warm reload 61 ms, startup spawns 4.5 per worktree, idle CPU 0.28 %,
  edit → SSE p95 22 ms, → UI p95 31 ms, burst diff p95 57 ms, **traffic per edit 1452 bytes** (budget 100 KB),
  0 `/api/projects` requests per edit.
- **36k role** (`bench:paged`, committed `docs/bench/results-paged.*`):

  | many-changed worktree (36 150 changed files) | main (before) | now |
  |---|---|---|
  | `GET /files`, first (cold) list | 12 205 ms, 13.3 s CPU | 2 049 ms, 3.0 s CPU (git; the two loop fixes) |
  | `GET /files` warm | 80 ms, 9.9 MB (1.0 MB gzip) | page of 500: 4-8 ms, 137.5 KiB (14.8 KiB gzip) |
  | Largest response of any page | 9.9 MB | 137.6 KiB (73 pages of 500 = the list, 0 duplicates, 270-300 ms in all) |
  | Old client (no `limit`) | 9.9 MB, every file | 2000 files, `truncated`, 549 KiB (57.8 KiB gzip) |
  | `GET /api/inbox` | 10.4 MB (1.09 MB gzip), 165 ms | 215 KiB (27.6 KiB gzip), 81 ms; 800 of 37 901 files |
  | App opened on the worktree → first file row | no row after 300 s | **180 ms** (reload 118 ms) |
  | From another worktree (click) → first row | n/a | **119 ms** |
  | One edit in the open worktree, browser traffic | n/a | **23.2 KiB** in 3 requests (page 15.7 KiB, inbox row 7.3 KiB) |

  The 180 ms is with a fresh browser profile but a daemon that had already listed the worktree (the `/files` phase
  runs first). A first open on a fresh daemon also waits for the cold list (2.0 s, git).
- New tests:
  - `packages/contracts/test/paging.test.ts` (11): order and counts; **property**: 200 random lists in pages of random
    sizes are the list exactly once; 200 more with refreshes between pages (files appear, go, change group, or only a
    patch moves) restart and then page the new list exactly (more than 50 restarts asserted); unreviewed views
    restart on marks only; the byte bound (UTF-8) and one file at least; `after` (present, gone, filtered, position);
    `q` ranking; the schemas (an old query parses exactly as before).
  - `apps/daemon/test/paged-files.real-git.test.ts` (7, real git): random page sizes with edits between pages
    (each page of one state; completions and restarts asserted); a cursor of an older state restarts when only a
    patch moved; every page, a `n` lookup, a search and an inbox row from one list (counting git-core); an old client
    with 2100 files (`truncated`, the cursor pages on) and bulk review marking all 2100; responses under 1 MB with
    800-character paths (pages, unpaged, inbox); `after` + `unreviewed`, `q`, `origin`; inbox pages, counts, cursors
    (also for `onlyUnreviewed`).
  - `apps/web/test/paged-files.test.tsx` (7, mock): first page and Load more; `n` past the loaded page; `n` into
    another worktree past its inbox row (one list request through the file, no ask where the counts say nothing is
    left); the palette search and jump; Shift+R without `paths`; the loaded count and selection across a refresh; a
    selection pushed past the loaded rows by a new file. `mock.test.ts`: the inbox's response budget.
  - `e2e/tests/20-paged-files.spec.ts` (4, real daemon, 1200 files): pages and the 1 MB bound; `n` past 520
    reviewed files and the diff pane; the palette jump; bulk review of all 1200 with 500 loaded.
  - `packages/git-core/test/parsers.test.ts` (+1): a long run of patches in every chunking.
    `tools/fixtures/test/large.test.ts`: the new role.
- **Mutation checks** (each applied, the tests run, then reverted). **Killed:** cursor offset ignored (5 daemon
  tests); the state left out of the list key (killed once the "only a patch moved" test was added; the random
  fuzz alone missed it); inbox response budget off; byte bound off; a git list per page; a restart keeping the
  old offset; `after` of a gone file from the top; reviewed bits not in an unreviewed view's fingerprint; base files
  not last; `n` never asking; `n` asking where counts say nothing is left; wanted rows ignored by the query; bulk
  plan ignoring partial lists; the palette not searching; the selection-repair lookup off; the splitter never
  refreshing a passed marker index. **Survived, and removed:** the refetch also taking the cached length, a second
  layer under "wanted"; it was removed, and the one layer left is killed. **Not covered by a test:** `currentFile`
  saying "unknown" for a file a partly loaded list lacks (it only spares a diff refetch); `review.changed`
  adjusting `counts`; the tree layout's Load more bar.

## Decisions

DECISIONS #348-#357 (new section "Paged file lists and inbox"): the contracts and the cursor (#348); the measurement
and the git-core loop fixes (#349); pages from the cached list, old clients, the byte bound (#350); inbox first pages
and the response budget, no per-worktree streaming (#351); one `FilesResponse` per list in the web, refetch length,
deltas (#352); load more, collapsed groups and the eye (#353); `n` across pages (#354); the palette file search,
which did not exist before, and the selection lookup (#355); bulk review (#356); the bench, the fixture role, and the
edit → SSE gap left to #40 (#357). PLAN §5.4 (route sketch) and §5.6 (a paragraph) mention paging.

## Contract changes

One `contracts:` commit (c5d03e9), additive only: `paging.ts` (helpers and constants, re-exported); `FileListCounts`;
`FilesQuery` paging parameters (`page` present only when one is given); `FilesResponse.total` / `offset` / `position` /
`nextCursor` / `truncated` / `restarted` / `counts`; `FileCursorSchema`; `InboxQuery.filesLimit`;
`InboxEntry.filesTotal` / `filesNextCursor` / `fileCounts`; `FilesParams` and `InboxParams.filesLimit` on the API
client. Nothing renamed or removed; older clients' schemas strip the new fields. **Behaviour change for old clients:** a list
above 2000 files is cut to 2000 (`truncated`) and an inbox row above 200 files to its first page. That is the issue's
"sane hard cap"; every list up to 2000 (and every inbox row up to 200) comes back exactly as before, apart from the
order, now `compareFileOrder` (path order with the default branch's files last).

## Dependencies

None added or removed (`pnpm credits:check`: up to date).

## Known gaps

- **Edit → SSE in the 36k worktree is 3.6-4.1 s** (#357): git-core does not keep lists above
  `listLimits.maxLateSignatures` (20k) for incremental updates, so every edit lists and signs the 36k files again
  (about 2 s per scope). That is #40's trade-off to revisit; paging only makes what the browser receives small.
- **The first open of a worktree whose list was never computed** still waits for it (2.0 s for 36k, git).
- **Deep scrolling costs per edit**: a refresh asks for everything that was loaded (2000 rows about 60 KiB gzip; the
  whole 36k list about 1 MB over 18 requests). The 100 KB budget holds for the first pages, not for a list scrolled
  to its end.
- **Tree layout**: no `order=tree` paging; a partly loaded tree shows the loaded prefix in tree order (folders fill in
  as pages come) and has a Load more bar instead of loading on scroll.
- **Inbox budget in row order**: with many huge worktrees, the last rows of a response get no files (counts and a
  cursor only); `n` and bulk then ask the daemon or use the counts, so behaviour is right, just with more requests.
- `review.changed` from another client for a file that is not loaded leaves `counts` stale until the next refetch.
- The PR Files tab (`request/Files.tsx`) links only files of the loaded prefix.
- The default bench's results were not committed (they were written to /tmp; other sessions rewrite those files). The
  `bench --layout large-paged` full run (summary-by-role table for the new worktree) was not run.
- The macOS CI was not run here. The new tests wait on real conditions (state hashes, watcher mode, requests in
  flight) and the long paths stay under macOS's 1024-character `PATH_MAX`.

## Notes for integration

- Merge order: the `contracts:` commit (c5d03e9) first. The DECISIONS numbers #348-#357 may need renumbering if
  another branch took them.
- The two git-core fixes (0a6a735, e532150) are independent of paging and can be cherry-picked on their own. They do
  not touch `packages/git-core/src/runner` (#45's session).
- The web asks for 500 files a page (`filesPaging.pageSize`) and leaves the inbox at the daemon's default (200 per
  row); tests shrink both. `FILE_LIST_MORE_TEST_ID` (`file-list-more`) and `file-tree-more` are local test ids, not
  in `TEST_IDS`, to keep the contracts commit to one.
- `bench:paged` takes about 2 minutes (40k-file fixture); `--profile <dir>` writes a daemon CPU profile.

## PR #97 review follow-up (Greptile: two P1, two P2)

All four were in the web paging code. Every fix has failing-first tests in `apps/web/test/paged-review.test.tsx`
(10 tests, mock backend, driven through the app's own controls: the palette, keys, Load more, Retry, Tree view; the
shared harness `test/paged-harness.tsx` can hold and fail requests). DECISIONS #358-#361.

- **P1, a removed selection stayed selected** (#358, `App.tsx` `useSelectionRepair`): the lookup is tracked to its end.
  Nothing repairs while it runs; afterwards a missing file is handed to its neighbour, and a file that loaded waits for
  its rows.
- **P1, `n` jumped backward in the tree layout** (#359, `lib/model.ts`, `state/model.tsx`, `state/commands.ts`): the
  daemon is asked after the paging boundary (the last loaded file in its order), not after the last displayed row.
  `j` at the end, Load more and the lookups were checked and use the cursor or the file itself.
- **P2, failed pages retried forever** (#360, `App.tsx` `useMoreFiles`, `components/FileList.tsx` `MoreStatus`): no
  automatic load while a page is failing; delayed retries of 1, 3 and 10 s, then a Retry button with an alert. A test
  with every page failing makes exactly 4 requests.
- **P2, old navigations overrode new ones** (#361, `state/commands.ts`): a navigation token for the palette jump, for
  `j` at the end and for `n`. A failed load selects nothing.

Mutation checks: see #358-#361. Killed: 12 mutants (the two "found" guards of #358 counted once, removed together). Survived: three single layers whose twin catches the same case
(each "found" guard of #358; the sequence bump in `k`/`J`, also caught by the snapshot), and one equivalent mutant
(stepping after a failed page at the list's end selects nothing either way).

## PR #97 review, second round (Greptile: one P1)

- **P1, a scope switch left the selection stuck** (DECISIONS #362, `App.tsx` `useSelectionRepair`): the lookup
  record is keyed by worktree, scope, state and selection. A `found` record re-checks that this worktree's and scope's
  cached list holds the file. The hand-over place starts over in another scope. The test (failing first) selects through a
  lookup in the working scope, then switches to a partly loaded unstaged scope without the file with the scope control;
  the selection goes to its first file.
- **Every other key of the paging code was checked** (#363). The table says what each key had, what it lacked, and
  what was done:

  | Key | Had | Lacked | Done |
  |---|---|---|---|
  | Selection lookup record | selection, state | worktree (in the selection), **scope** | key + re-check of the cached list (#362) |
  | Cursor / list key (daemon, mock) | state, scope, files | **worktree** | added; daemon test with two worktrees of one state |
  | Navigation token snapshot | view, scope, selection | **layout, eye, from-main view, sidebar filters** | added; test with the Tree view button |
  | Palette file-search query key | worktree, scope, text | **state** | added; test: a removed file's result goes |
  | Load-more failure record | cursor (now covers the rest) | explicit worktree, scope, state | added (no case to test) |
  | `ensureFiles` single-flight, wanted counts | files query key (worktree, scope) | nothing (a count, not data) | unchanged |
  | Appended pages | the cursor they continued from | nothing | unchanged |
  | Paging boundary | the open files query / the inbox row of the inbox scope | nothing (never the tree order) | unchanged |
  | Inbox row cursors | the `/files` list key | nothing | unchanged (now with the worktree too) |
  | `unreviewed` view fingerprint | marks | nothing | unchanged; the web never caches an unreviewed-filtered list |
  | Daemon `#ordered` memo, `currentFile` | listed array; event worktree and diff scope | nothing | unchanged |

- **Found on the way** (#364): `j` at the end of the loaded rows stepped through the previous render's rows and often did
  not step at all. The step now waits for the render with the new rows. A test that failed first and a killed mutation
  cover it.

Tests added: `apps/web/test/paged-review.test.tsx` +4 (scope switch, `j` steps into the next page, layout switch drops
a pending step, palette results follow the state), `apps/daemon/test/paged-cursor-keys.test.ts` (1). Mutations killed:
the scope switch with both of its layers removed (each alone survives: one covers the other), the place not reset per
scope, the daemon key without the worktree, the snapshot without the layout, the stale step, the palette key without the
state.
