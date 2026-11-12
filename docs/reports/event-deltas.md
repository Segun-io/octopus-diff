# event-deltas report (roadmap #51, step 22)

## Shipped

- **Contract** (`contracts:` commit, DECISIONS #257). `worktree.changed` gains optional `worktree`, `summary`,
  `error`, `review`: the worktree's row of `GET /api/projects`, exactly as the daemon now has it. It also gains
  `paths` (`WorktreeChangedPaths`: `scope`, `files: {path, rawPath?, patchHash}[]`, `total`, `truncated`). The list
  is bounded to `WORKTREE_CHANGED_PATHS_MAX` = 200 files and `WORKTREE_CHANGED_PATHS_MAX_CHARS` = 24 000 characters.
  Above either cap `files` is empty with `truncated: true`, so the event for a worktree with 2000+ changed paths stays
  about 1.5 KB. `GET /api/inbox` gains `worktreeIds` (validated `IdSchema` ids, at most `INBOX_WORKTREES_MAX` = 200,
  unknown ids ignored), and `ApiClient.inbox({ worktreeIds })` passes it. Nothing was renamed or removed. Older
  clients' schemas strip the new fields.
- **Daemon** (`apps/daemon/src/core.ts`, `events.ts`, `app.ts`).
  - `#announce` adds `#row(project, entry)` to the event. `#row` is the same helper `/api/projects` uses (`#item`).
  - `paths` comes from `#cachedPaths`, which reads only what is already known and spawns no git process:
    - an empty `working` list when the summary counts no changed file;
    - else the `working` list from `#filesCache` for this `stateHash` and attributes stamp;
    - else the review state's list, which is computed before the announcement for every worktree that changed;
    - else no `paths`.
  - The full event is schema-checked before it is sent. If the check fails, the slim event goes out instead.
  - `EventHub.emit(event, replay)` keeps the slim form in the `Last-Event-ID` replay buffer (#259).
  - `inbox(scope, onlyUnreviewed, projectIds, worktreeIds)` (#260).
- **Web** (`apps/web/src/api/deltas.ts` (new), `cache.ts`, `queries.ts`; plus `state/model.tsx`, see #266).
  - **Projects list.** `applyRow` puts the event's row into the cached projects list, so there is no `/api/projects`
    refetch. Stale rows (older `summary.updatedAt`) are dropped. A worktree the cached list does not have falls back to
    a projects refetch. `keepNewerRows`, inside `projectsQueryOptions`, stops a projects answer that was in flight from
    putting an older row back (#261).
  - **Inbox.** The client-side inbox reconstruction (`patchInbox`) is gone. Inbox queries on screen ask
    `/api/inbox?worktreeIds=` for the changed rows, after any full inbox fetch already in flight. Inbox queries off
    screen are only marked stale (#262).
  - **Open worktree.** The open worktree's file lists are refetched. A diff is refetched only when its own `patchHash`
    moved:
    - decided at once from `paths` when the event's list is for the diff's scope;
    - otherwise decided from the refetched list or inbox row.
  - **Commits.** Refetched only when HEAD or the branch moved (#263).
  - **Older daemons.** An event without the row gets the old invalidation: the projects list and the whole inbox are
    refetched.
  - **Unchanged.** Selection, scroll and the reconnect resync (a full invalidation after the second `hello`).
  - **Bulk review** now expects the state hash of the list it acts on (the open file list, then the inbox row, then
    the sidebar), so the faster sidebar cannot defeat the stale check (#266).
- **Daemon, `review.ready`.** A first review state computed for an announcement rides on that `worktree.changed`
  instead of a `review.ready`, which made every client refetch projects on a worktree's first edit (#265).
- **Mock** (`apps/web/mock`). The mock emits the row and the `working` paths with the same caps. `legacyEvents: true`
  gives the old event form. Its inbox also takes `worktreeIds`.
- **Bench** (`e2e/bench/bench.ts`, `docs/bench/README.md`, DECISIONS #264). The bench records the browser's `/api/*`
  traffic per edit and adds two budgets: `editTraffic` (worst edit under 100 KB) and `editProjects` (no
  `/api/projects` request per edit). It also fixes a breakage already on main: since the sidebar became virtualised
  (#13), the refresh loop timed out on rows that were not mounted. The loop now uses a tall viewport, and the paint
  phases keep 1440 × 900.

## Verification

All runs are on the dev machine (WSL2, Node 26), from the repository root, on the final head unless noted.

- **`pnpm lint`**: pass. Biome reported one existing info in `apps/daemon/test/file-origins.real-git.test.ts`;
  `credits:check` reported "up to date".
- **`pnpm typecheck`**: pass (0 errors).
- **`pnpm build`**: pass.
- **`pnpm test`**: pass in 48 s.

  | Package | Tests |
  |---|---|
  | contracts | 107 |
  | forge | 101 (+5 skipped) |
  | fixtures | 58 |
  | git-core | 297 |
  | web | 386 |
  | daemon | 378 (+3 skipped) |
  | e2e unit | 7 |
  | cli | 139 |
  | scripts | 34 |

- **`pnpm test:e2e --workers 1`**:
  - First full run: 99 passed, 1 failed (`11-ui-bulk-review` "stale"). That was a real bug the deltas introduced,
    fixed in `910459b` (DECISIONS #266). After the fix, `11`, `10` and `04` passed 17/17.
  - Final full run, 3.1 min: 99 passed, 1 failed (`16-copy` "select two lines → Copy bar …": the copy bar did not
    appear after a drag). It passed in the first full run and 27/27 with `--repeat-each 3` in isolation. I take it
    for a timing flake unrelated to events, but it is not proven.
  - Read-only proof: 0 violations in every run (12 control repos).
  - `04-live-updates`: 6/6, including the new "an edit costs no /api/projects refetch, no refetch of the open diff
    and under 100 KB".
- **Bench** (`pnpm --filter @octopus-diff/e2e bench --out /tmp/…`, small 30 × 3, 15 edits, Inbox view): every budget
  passes.

  | Metric | With deltas | Control: deltas off in the web build |
  |---|---|---|
  | Traffic per edit | 1.4 KiB median / 1.4 KiB worst | 34.9-36.9 KB |
  | Requests per edit | one `GET /api/inbox?worktreeIds=` | `/api/projects` + the full `/api/inbox` (once also a `/diff`) |
  | `/api/projects` requests | 0 | 1 per edit (`editProjects` FAIL, as it should) |

  Other bench numbers with deltas: write → SSE p95 22 ms, write → UI p95 37 ms, burst diff p95 30 ms, startup 4.5
  spawns per worktree, idle CPU 0.35 %. The first bench run with the new budgets measured a `/api/projects` refetch
  on 12 of 15 edits (11.5 KB), caused by `review.ready`. That was fixed in `16a849b` (DECISIONS #265). The results
  were not committed to `docs/bench/` (other sessions rewrite those files); the JSON is in `/tmp/od-bench-after`.
- **No new git processes.** `apps/daemon/test/event-deltas.real-git.test.ts` counts spawns through a wrapper script.
  Three edits cost 7 / 6 / 7 processes, the same lists as main measured with the same test (3 runs each, identical).
- **Mutation checks** (each new test fails when its behaviour is removed):

  | Behaviour removed | Test that fails |
  |---|---|
  | An extra `working` listing in `#cachedPaths` | spawn count |
  | Slim replay | replay test |
  | `worktreeIds` filter | inbox test |
  | Row on the event | row test |
  | `review.ready` hold-back | row test |
  | `isDeltaEvent` (web) | 4 cache tests, the app test, e2e `04` (it saw `/api/projects`, the full inbox, `/diff`) |
  | `keepNewerRows` | in-flight projects test |
  | Stale-row check | out-of-order test |
  | Unknown-worktree fallback | removed-meanwhile test |
  | Waiting for the full inbox fetch | inbox-race test |
  | Keeping unchanged diffs | open-worktree and All-on-branch tests |

## Decisions

DECISIONS #257-#266 (new section "Event deltas: the worktree's row and changed paths in `worktree.changed`") and
#267-#271 (the PR #85 review follow-up, below). PLAN §5.4 (route sketch) and §5.6 mention the delta.

## Contract changes

Additive only, in commit `contracts: worktree.changed carries the worktree row and changed paths; inbox worktreeIds
(#51)`:

- `WorktreeChangedEventSchema`: `worktree?`, `summary?`, `error?`, `review?`, `paths?`
- new schemas and constants: `ChangedPathSchema`, `WorktreeChangedPathsSchema`, `WORKTREE_CHANGED_PATHS_MAX`,
  `WORKTREE_CHANGED_PATHS_MAX_CHARS`
- `InboxQuerySchema.worktreeIds?`, `INBOX_WORKTREES_MAX`, `InboxParams.worktreeIds?`

A second additive commit for the review follow-up: `contracts: rev on worktree rows and worktree.changed orders rows
without relying on a summary (#51 review)`, which adds `WorktreeListItem.rev?` and `WorktreeChangedEvent.rev?`.

## Dependencies

None added or removed (`pnpm credits` not needed; `pnpm lint` runs `credits:check`).

## Known gaps

- **The file list is still refetched when the event's paths equal it.** The event cannot tell a touch (a new mtime
  with the same content) from a move of the default branch. A default-branch move relabels merge-noise `origin`
  without changing any `patchHash`, so skipping the refetch could leave stale labels on screen. Follow-up: add
  `origin` per path to `paths` (#263).
- **`paths.scope` is `review` in practice.** The daemon only reports a list it already holds, and the `working` list
  is rarely cached at announce time. So the immediate diff decision applies to the To review view. Other views
  decide after the file-list refetch, which is still one request and no diff request.
- **Older daemons cost more.** They now get a full inbox refetch per edit, where they used to get the removed
  client-side patch. The data on screen is the same.
- **The immediate path is not covered by a test.** The cases where the event's paths alone decide a diff (To review
  scope) are covered by the shared logic but not by a dedicated request-count test. The mock reports `working` paths.
- **`review.changed` still refetches `/api/projects`.** That is per review mark, not per edit, and is out of scope
  here.

## Notes for integration

- This report was empty after the merge of main (`a7493de`). It was restored from `b6b1dcc`, its DECISIONS
  references were shifted to the renumbered #257-#266, and the follow-up was added.
- `state/model.tsx` (#266) is outside `api/`: it is the minimum needed to keep the bulk stale check working with
  deltas. It does not touch the sidebar components another session is restyling.
- `16-copy` failed once in the final full e2e run and passed 27/27 in isolation. Watch it in CI.
- The bench fix (tall viewport for the refresh loop) is needed on main too. The bench there times out in the refresh
  loop since #13.
- The web feature-detects deltas per event, so web and daemon can land in either order.

## Review follow-up (PR #85)

### Shipped

- **Old answers no longer undo errors or recoveries (review P1).**
  - Rows carry `rev` (DECISIONS #267, #268): the order in which the daemon observed the row's state, whatever
    changed, summary null included. `#row` stamps it lazily. It moves only when the row's state moved since the last
    read, so the projects ETag still matches an unchanged list.
  - The web orders rows by `rev` in `applyRow` and `keepNewerRows` (`newerRow`). `summary.updatedAt` is now only the
    fallback for rows without `rev`. An equal `rev` lets the projects answer win.
  - A reconnect forgets the remembered rows (#269).
  - The mock stamps `rev` too, and announces errors and recoveries (`setWorktreeError`).
- **A late first review state is no longer lost (review P1).**
  - A delta event whose `stateHash` equals the cached one is applied when it brings a later row (`bringsNews`: a
    higher `rev`, or without `rev` a review state the cached row lacks). Only the row is applied; no list is
    refetched (#270).
  - The daemon keeps the held first `review.ready` when a projects answer built the row while that review state was
    pending (`servedEarly`).
- **CI's `perf:smoke` passes again.** The refresh indicator is `useIsFetching()`. The delta inbox fetch bypassed
  React Query, so a live edit seen from the Inbox (now one small request) never showed "Refreshing…", and
  `perf:smoke` timed out on it.
  - The delta fetch now goes through `queryClient.fetchQuery` under its own key (`['inbox-delta', …]`, gc 0), so the
    indicator shows it like any refresh (#271).
  - `apps/web/scripts/perf.ts` had a request check that described the old behaviour (projects + files, ≥ 2 requests).
    It now checks that each refresh fetches the changed inbox rows and no `/api/projects`, and still prints the
    requests per refresh. It judges no timing, as before.

### Verification (follow-up head)

Commands run from the repository root on this machine; final results.

- **Static checks.** `pnpm lint` passes (credits up to date). `pnpm typecheck` passes. `pnpm build` passes.
- **`pnpm test`**: pass in 47 s.

  | Package | Tests |
  |---|---|
  | contracts | 107 |
  | forge | 101 (+5 skipped) |
  | fixtures | 58 |
  | git-core | 297 |
  | web | 416 |
  | daemon | 379 (+3 skipped) |
  | e2e unit | 7 |
  | cli | 139 |
  | scripts | 34 |

- **Failing-first.** Before the web fix, the new unit tests in `apps/web/test/deltas.test.ts` failed 4 of 8, and the
  mock integration test for an error or recovery with a held projects answer failed.
- **Mutation checks.**
  - Web: ordering without `rev`, `bringsNews` returning false, no `forgetRows`, `rowOnly` refreshing the lists, and
    `rev` left off the applied row. Each fails at least one test.
  - Daemon (`event-deltas.real-git.test.ts`, "a first review state slower than the projects wait"): without
    `servedEarly`, a `rev` that never moves, and a `rev` that moves on every read. Each fails.
  - Indicator: a direct `api.inbox` call fails the two indicator tests.
- **`perf:smoke`**, after `pnpm --filter @octopus-diff/web build`: pass. All checks ok, requests per refresh 1 / 1 /
  1 (`/api/inbox`). On a build without #271 it fails with the CI error ("refresh indicator stuck in idle").
- **Bench** (small 30 × 3, on the `rev` changes before #271): every budget passes. Browser traffic per edit is 1.4 KiB
  worst, 0 `/api/projects` requests per edit, write → SSE p95 20 ms, burst diff p95 34 ms.
- **`pnpm test:e2e --workers 1`** (final build): 100 passed in 3.0 min. That includes `04-live-updates`,
  `10-bulk-review`, `11-ui-bulk-review` and `02-inbox-diff`. The read-only proof had 0 violations (12 control repos).
- **Other CI steps run locally.**
  - CLI smoke (`--version`, `doctor` with temp dirs): 0 problems, 1 warning (this machine's inotify limit).
  - Package job (`pack:tarball`, `npm install` of the tarball in an empty directory, `--version`, `doctor`): pass.
  - The macOS job's command (`pnpm -r --workspace-concurrency=1 run test && pnpm run test:scripts`), on Linux: pass.
  - Not run: the Node 24 matrix leg (only Node 26 is installed here) and the macOS runner itself.
