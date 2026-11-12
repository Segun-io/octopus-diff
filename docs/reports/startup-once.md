# startup-once report (GitHub #10, roadmap step 04)

Branch `perf/startup-once`, from `main` at `eaacb9f`. Session of 2026-11-11.

## Shipped

- **Each summary once at startup** (`apps/daemon/src/core.ts`). The duplicate was not a second `getSummary`: a probe
  with a counting git-core showed 90 `getSummary` calls for 90 worktrees. It was the status-flow review state,
  computed right after every summary and before announcing it. Its To review file list (`listChangedFiles`) runs
  `status` + `diff` a second time, and its review range adds `rev-parse` / `symbolic-ref` / `merge-base` / `rev-list`.
  The review state is now computed only when it is wanted (`#reviewWanted`): the project was opened, the worktree
  already has one, or the worktree changed after its first summary. `listProjects` waits only for those.
- **Default state (#25 decision 2): no inherited review state.** At startup, worktrees with changes are listed under
  their project as plain changes (new web stage `changed`: counts, no to-review pill, not in the title or favicon
  count). Clean ones sit in the shelf. Opening a project (`PUT /api/focus` with one of its worktrees, or with
  `projectId` from its Overview) computes its review states in the background, and `review.ready` (batched) makes
  the sidebar refetch. It is a fixed default with no setting. First-sight bookmarks of default-branch and detached
  worktrees are seeded from the first summary's HEAD (`#seedBookmark`, no git process), so an agent's commits made
  before the project is opened still count as new.
- **First paint from `/api/projects`** (`apps/web/src/App.tsx`, `state/model.tsx`, `lib/model.ts`). `data-ready` no
  longer waits for the inbox. The sidebar no longer fetches the Uncommitted inbox as its fallback status source. To
  review is always offered: the old-daemon check in `ScopeSelect` would have reset it on every cold start.
- **Inbox filled in project batches** (`apps/web/src/api/queries.ts`: `inboxQueryOptions`, `inboxBatches`,
  `isPartialInbox`). The first load of a scope asks `/api/inbox?projectIds=` in about 12 batches, one at a time,
  through TanStack's `experimental_streamedQuery`. Each batch shows as it lands. Refetches are one request.
  Bulk "all" in the Inbox waits until every batch is in.
- **Bench:** the warm-reload budget is no longer `TRACKED` (`e2e/bench/bench.ts`, `docs/bench/README.md`). The
  startup-spawns budget was left alone (#29). `docs/bench/results*.md` now hold the runs from this branch.

## Verification

All runs were on the dev machine (WSL2, Ryzen 7 7800X3D, Node 26.13, git 2.53). "Before" is `main` at `eaacb9f`,
measured in this session with the same bench. Commands:
`pnpm --filter @octopus-diff/e2e bench --out <dir>` and
`pnpm --filter @octopus-diff/e2e bench --layout large-ci --out <dir>`. Both runs passed (exit 0).

| 30 × 3 (90 worktrees) | Before | After | Issue target |
|---|---|---|---|
| `status` / `diff` spawns at startup | 180 / 180 | **90 / 90** | about 90 |
| All startup git spawns (per worktree) | 1431 (15.9) | 740 (8.2) | budget ≤ 8 is #29's |
| Daemon listening / all summaries | 725 / 1971 ms | 782 / **1236 ms** (1207 ms in a first run) | ~1.0 s |
| Cold UI paint (`data-ready`) | 1394 ms | **142 ms** (153 ms first run) | < 1.0 s |
| Warm reload, median of 3 | 132 ms | 86 ms | < 300 ms, now enforced |
| Git spawns during cold paint | 847 | 42 | |
| Idle CPU avg / worst 1 s | 0.35 % / 4 % | 0.23 % / 2 % | |
| Edit → SSE p95 / → UI p95 | 29 / 51 ms | 31 / 50 ms | |

| large-ci (one 20k-file monorepo, 3 worktrees) | Before | After | Issue target |
|---|---|---|---|
| `status` / `diff` spawns at startup | 6 / 6 | 3 / 3 | |
| Daemon all summaries | 4948 ms | 881 ms | |
| Cold UI paint | 8416 ms | **122 ms** | < 2 s |
| Warm reload | 133 ms | 40 ms | |
| Idle CPU avg (report only) | 0.92 % | 10.19 % (see Known gaps) | |

**Inbox fill after paint.** The bench does not measure this, so I used a temporary Playwright probe: cold page, then
time to the first file row and to every file group of the default All on branch inbox. Before this branch the fill
was part of the paint (`data-ready` waited for it), so it equals the cold paint above.

| | Paint | First inbox file | Whole inbox |
|---|---|---|---|
| 30 × 3, batches one at a time (shipped) | 146–147 ms | 256–258 ms | 1319–1329 ms |
| 30 × 3, two in flight | 146–152 ms | 363–372 ms | 1312–1320 ms |
| 30 × 3, four in flight (first try) | 161 ms | 973 ms | 1410 ms |
| large-ci (one project = one request) | 121 ms | 6130 ms | 6314 ms |

Checks:

- `pnpm check`: exit 0 in 36 s. Lint, credits check, typecheck and build passed. Tests: contracts 83, forge 94 (+4
  skipped), git-core 188, fixtures 53, web 247, daemon 221 (+1 skipped), e2e unit 5, cli 139, scripts 34. No
  failures.
- `pnpm test:e2e`, first run: 88 passed, 3 failed, 2.9 min, no shutdown hang. All three failures read review state
  right after load, which #10 changes on purpose:
  - `11-ui-bulk-review.spec.ts:90`: the title count before and after an inbox-wide bulk review.
  - `13-ui-settings-themes.spec.ts:161`: expected a title count > 0 straight after load.
  - `15-ui-status-flow.spec.ts:51`: the auto-selected file's project opened after the snapshot, so its rows changed
    stage.

  Each now asks for the To review inbox first, which computes every review state (commit `2a0305a`; `e2e/` is
  WS4's, so this is the smallest change that keeps the tests' intent). Second full run: **91 passed** in 2.9 min
  (2:56 wall), exit 0. The known flaky drag-selection test passed in both runs.
- After the e2e edits: `pnpm lint` exit 0 (credits up to date) and `pnpm typecheck` exit 0.
- New tests:
  - `apps/daemon/test/startup-once.real-git.test.ts`: one `getSummary` per worktree, no `listChangedFiles` or
    `readReviewRange` at startup; opening by worktree or by `projectId` sends `review.ready` and only that project
    gets review states; a commit on `main` after startup counts as one new commit.
  - `routes.test.ts`: `projectIds` filter and its 400.
  - `apps/web/test/inbox-stream.test.ts`: batching, partial then complete data, a refetch is one request.
  - `model.test.ts`: the `changed` stage and the "only unreviewed" filter.
  - contracts: the `review.ready` sample, `projectIds` parsing.

## Decisions

DECISIONS #180–#187. The numbers start at #180 because the #29 session uses #172+; renumber at merge if needed.

- #182: the root cause and the "wanted" rule.
- #183: the default state, what counts as opening a project, the kept exceptions (worktrees that change after
  startup, the To review inbox), and the bookmark seeding.
- #184: paint from projects only, the dropped Uncommitted inbox fallback, To review always offered, the mock's
  non-status-flow review counts.
- #185: inbox batches, one at a time, with the measurements.
- #186: warm-reload budget enforced.
- #187: no background precompute, and why.

## Contract changes

Both additive, each in its own `contracts:` commit:

- `90fb058`: SSE event `review.ready { projectId }`, and optional `FocusRequest.projectId` (nullable). The doc
  comment on `WorktreeSummary.review` now says it is also absent until computed (DECISIONS #180).
- `0ce02ab`: optional `projectIds` on `GET /api/inbox` (comma-separated, at most `INBOX_PROJECTS_MAX` = 200), plus
  `InboxParams.projectIds` in the client (DECISIONS #181).

## Dependencies

None added or removed. No lockfile change, so `pnpm credits` was not needed (the credits check passes in
`pnpm lint`).

## Known gaps

- **All summaries at 1.24 s, not ~1.0 s.** The duplicated `status`/`diff` is gone and the time fell by 37 %. What
  remains at startup is per-worktree metadata: `rev-parse` 162, `for-each-ref` 120, `config` 97, `check-attr` 90.
  That is #29's per-project work in `packages/git-core`, which this branch does not touch.
- **large-ci idle CPU 10 % (was 0.9 %).** This is the inbox fill moving out of the paint, not new steady work. The
  first ~5 one-second samples of the idle window run at 100–160 % while the big repo's All on branch inbox is still
  being computed (it took ~6 s after paint). After that every sample is 0 %. Before this branch the same work sat
  inside the 8.4 s cold paint. Large layouts are report-only for this budget.
- **One-project inboxes do not stream.** Batches are per project, so the big monorepo's inbox is still one request
  (~6 s after paint). Streaming per worktree would need a streaming response; that was left out (DECISIONS #185).
- **Review states are per daemon session.** Restarting the daemon goes back to plain changes until a project is
  opened again. Opened projects are not persisted, by design (#183).
- **Picking a file in the Inbox opens that file's project** (focus follows the selected file), so after first paint
  the auto-selected file's project computes its review states. Other projects do not.
- **Old-daemon support removed in the web.** The web no longer checks for daemons without status flow v2; it ships
  with its own daemon.
- **No background precompute** (DECISIONS #187).

## Notes for integration

- `e2e/tests/11-ui-bulk-review.spec.ts`, `13-ui-settings-themes.spec.ts` and `15-ui-status-flow.spec.ts` gained one
  line each (`daemon.client.inbox({ scope: { kind: 'review' } })` before opening the UI); WS4 may prefer a fixture
  helper for it.

- Merge after or with #29; expect only DECISIONS numbering conflicts. No git-core change, and the `GitCore` interface
  is untouched.
- Re-run the bench after merging both: the startup-spawns budget (≤ 8 per worktree, still `TRACKED`) is at 8.2 here;
  #29 should bring it under and then remove its `TRACKED` entry.
- `docs/bench/results.md`, `results.json`, `results-large-ci.md` and `results-large-ci.json` were regenerated on this
  branch; regenerate them after the merge.
- The web's `experimental_streamedQuery` is marked experimental in TanStack Query 5.107. It is used in one place
  (`inboxQueryOptions`) and could be swapped for a manual `setQueryData` loop if the API changes.

## PR review round 1 (Greptile on #57)

Both findings were valid.

- **Unseen files get reviewed (web).** "Partial inbox" was a flag on the response object (a `WeakSet`). A review mark or an event patch writes the cache with a new object, and React Query's structural sharing does not keep the identity of what is written, so the copy counted as complete while batches were still missing and bulk "all" could mark files in projects not shown yet. The flag now lives by query key (`isPartialInbox(scope)`), is set while a streamed inbox has batches to come, and is cleared just before the last batch is written (so the render that shows the complete data already sees it clear) or when the stream ends or fails. Regression test: `inbox-stream.test.ts` "a review mark made while batches are still landing keeps the inbox partial" (it failed with an identity-based fix too, which is how the structural-sharing cause showed up).
- **New commits disappear when the repository has no default branch (daemon).** `#seedBookmark` skipped attached branches when no default branch was detected, so a commit made before the project was opened became the first bookmark and counted as zero new commits. `readReviewRange` itself starts at HEAD in that case (no default ref), so the seed now does too. Regression test: `startup-once.real-git.test.ts` "a commit made after startup counts as new in a repository with no default branch" (a repo whose only branch is `develop`; fails without the change). Known edge: if a default branch is detected only after registration (a `main` appears later), a feature branch seeded at HEAD keeps that start.
