# web-activity report

Roadmap #39 "web: Activity strip and deleted chip (live view)" (step 20 of #24). Web only; the daemon side (#38) is
merged. DECISIONS **#229-#232** (other open branches may use these numbers).

## Shipped

- **Activity strip** (`apps/web/src/components/diff/ActivityStrip.tsx`, rendered at the bottom of `DiffPane` for an
  open worktree; none in the Inbox). Collapsed by default (`activityOpen` pref, persisted): one bar with a count, the
  newest entry and the watch note. Open: a fixed-height list, newest first. Rows: added / edited / reverted file (with
  `+a −d`, `×N` for a coalesced entry, `from main` tag for `origin: base`), **deleted** (red `bg-del-soft`, `−N lines`,
  **View content** from `getBlob`, "content unavailable" for untracked / `oid: null`, "no longer available" on 404,
  binary / too-large placeholders, SEC-05 escaping), `commit` (short sha + subject), `head` (checkout / merge / reset /
  rebase… label), `bulk` ("60 files changed", kinds breakdown, a button listing the <= 20 sampled paths + "… and N
  more"). A click on a file row selects it when it is still in the file list (`data-present`), otherwise the row is
  dimmed and not a button. `watch.mode !== native` shows a `polling every N s` chip (`watchNote`). **Follow latest
  change** chip (`followLatest`, transient, off by default) selects the newest changed file that is in the list, once
  per update; turning it off forgets, turning it on selects again.
- **Refresh** (`src/api/activity.ts`, `src/lib/activity.ts`, `src/api/cache.ts`): one React Query per worktree,
  incremental (`getActivity(id, { after, run })`, `run` sent back), merged by entry `id`; `dropped` / foreign `run` /
  nothing held replaces the list; ring cap 200. `worktree.changed` with `activitySeq` adds the worktree to the new
  `effects.activity` (before the stateHash short-circuit) and `flushEffects` invalidates `['activity', id]`; only the
  observed query (the strip on screen) refetches. No polling; the 10 s timer only re-renders "12s". The diff, files
  and review queries are untouched, so the selection and scroll position are preserved as before; the strip has a
  fixed height so new rows never resize the diff.
- **"N deleted" chip** (`DeletedChip` in `WorktreeChips.tsx`, inside `RowChips`: sidebar rows and the context bar):
  from `summary.counts.deleted`; shown while > 0, hidden at 0 or absent (older daemon). State-based by construction.
- **Mock** (`mock/activity.ts` new; `mock/backend.ts`, `mock/router.ts`): `MockActivity` (rings, one sequence, `run`,
  coalescing, blob allow-list, `setWatch`, `restart`), routes `GET /api/worktrees/:id/activity` and `/blob/:oid`
  (validated with the contract schemas, 400 / 404 like the daemon), `counts.deleted` in every summary,
  `worktree.changed.activitySeq`, `MockBackend.mutate` actions `delete` (content kept for the blob route),
  `delete-untracked`, `commit` next to `edit | add | revert`; control endpoints `POST /api/__mock/mutate?action=...` and
  `POST /api/__mock/activity?worktreeId=&mode=polling&pollMs=5000` / `?restart=1`. The seeded random stream of the
  existing actions is unchanged.
- `apps/web/scripts/shots.ts`: new `activity` state (agent edits, deletes, polling note, content open).

## Verification

Machine: WSL2, Node 26, from the repo root. All results are real.

- `pnpm lint`: exit 0 (one pre-existing biome `info` in `apps/daemon/test/file-origins.real-git.test.ts`; `credits:check` up to date).
- `pnpm typecheck`: all packages pass.
- `pnpm --filter @octopus-diff/web test`: **26 files, 355 tests pass** (326 before; `test/activity.test.tsx` adds 29: merge
  / dropped / run / ring cap, words, chip x3, mock routes, strip x12 in the app against the mock agent).
- `pnpm build`: passes (web, cli).
- **Mutation checks** (each applied alone to `src/`, `test/activity.test.tsx` run, reverted): `dropped` not replacing (1
  fails), foreign run merged (1), coalesced entry not replaced by id (2), `run` not sent back (1), no `after` cursor
  (1), SSE does not invalidate the feed (11), newest-first order broken (4), follow on by default (3), follow never
  selects (1), row click does not select (1), deleted row not red (1), no line count (1), no View content (2),
  untracked shows the button (1), polling note hidden (2), strip also in the Inbox (2), strip open by default (1,
  after adding the default test), chip shown at 0 (2), chip never state (3), bulk paths always open (1), blob 404
  message removed (1). One mutation survived and was resolved by removing dead code: adding `deletedCount > 0` to the
  sidebar row's "has a chip" test changed nothing, because a deletion is a changed file so the meta line is never empty
  (the Sidebar change was reverted).
- **Screenshots** (`pnpm build`, `WEB_PORT=4199 pnpm preview:mock`, `BASE_URL=... STATES=activity,inbox pnpm shots`; 4
  themes x 1440 / 960): feat/auth shows a red `2 deleted` chip on its sidebar row and in the context bar; the strip
  under the diff lists `Edited ×8`, `Deleted notes/todo.md · content unavailable`, `Added`, and a red
  `Deleted src/auth/session.ts −63 lines` row with its last content in a monospace block; `polling every 5 s`
  (amber chip) and `Follow latest change` sit in the bar. At 960 px wide the path of a deleted row truncates hard (the
  count and button do not shrink); the sidebar row's meta line truncates a little earlier with the extra chip.

## Decisions

#229 strip placement, open worktree only, defaults; #230 incremental query and SSE wiring; #231 deleted rows and
blob states; #232 the chip and the mock.

## Contract changes

None.

## Dependencies

None added or removed (`pnpm credits:check` passes inside `pnpm lint`; the lockfile is unchanged).

## Known gaps

- **No e2e added** (`e2e/` is WS4's). The e2e to add: start the e2e daemon on a scratch repo, open its worktree, open
  the strip (`activity-toggle`), have an "agent" delete a tracked file with `rm`, wait for a `deleted` row
  (`activity-row[data-kind=deleted]`) within the refresh window, click `activity-view-content` and assert the
  committed content; assert the sidebar chip (`deleted-chip`, "1 deleted"), then `git commit -a` and assert the chip
  and nothing else disappear; assert the diff pane's `data-path` and scroll position did not change across the
  refresh. The component tests cover each piece against the mock daemon, not against the real one.
- The scroll position of the diff is not asserted in jsdom (no layout, the renderer is stubbed): the guarantee comes
  from the strip not touching the diff queries, and from its fixed height; the selection is asserted.
- Follow latest does nothing when the newest changed file is not in the current scope's list (it does not jump to an
  older one).
- `activityOpen` is a persisted pref but has no Settings control (the strip's own button is the control).
- The strip is not shown in the Inbox (it mixes worktrees); the selected file's worktree there has no feed view.
- A pre-existing problem on `main`: `docs/DECISIONS.md` has leftover merge-marker lines (`||||||| 2661c42`, `||||||| ed407f8`)
  before and at the end of the file; not touched here.

## Notes for integration

- `EventEffects` has a new field `activity` (a `Set`); `emptyEffects()` fills it. Tests that build effects by hand must too.
- Prefs gain `activityOpen` (default false; `normalizePrefs` fills it, no version bump). `UiState` gains `followLatest`.
- A `pnpm install --frozen-lockfile` from the root is needed in a fresh worktree before `pnpm lint` / `typecheck`.

## PR #80 review (Greptile)

- The collapsed bar escapes its text (`escapeSuspicious`), like the rows.
- Follow latest remembers `(run, seq)`, not `seq`: a restarted daemon counts from 1 again and its first change was skipped.
- The mock folds like the daemon (`coalesceTarget`): an edit, a delete and a second edit stay three rows; a commit, HEAD move or bulk entry ends the search; a different file in between does not.
- The mock serves a deletion's content only while a feed entry holds its oid, and drops saved content when an entry leaves the ring.
- `shots.ts`: the `activity` state is in `MUTATING_STATES` (runs after every other shot, seeds its changes once, puts the watch mode back to native at the end), so no other shot starts from its changes.
