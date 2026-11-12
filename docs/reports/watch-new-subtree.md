# watch-new-subtree report

Issue #36 "Bug: no watch event when a large new subtree is created" (roadmap step 17). Branch
`fix/watch-new-subtree`, apps/daemon only (source, tests) plus `docs/`.

## Shipped

- **Root cause (reproduced, high confidence).** `@parcel/watcher`'s inotify backend (Linux) answers
  `IN_CREATE` of a directory with `watchDir(path)` for that one directory only
  (`InotifyBackend::handleSubscription` in `node_modules/.pnpm/@parcel+watcher@2.6.0/.../src/linux`); it
  never crawls the new directory. A subdirectory that already exists by then (`mkdir -p vendor/pkg/deep`,
  `cp -r`, `tar x`, `mv` of a tree, `git branch a/b/c`, a fetch creating `refs/remotes/origin/a/b`) is
  never watched. The stream is `create vendor` and nothing else, for the life of the subscription: later
  writes, and later edits of existing files, inside `vendor/pkg/deep` are silent. `git status` lists no
  empty directory, so the one event refreshes to an unchanged `stateHash`, `worktree.changed` is not
  emitted, and nothing else happens until the fallback poll (30 s focused / 5 min otherwise).
  - Raw watcher, 300 ms after subscribing: `mkdir -p vendor-x/pkg/deep` + 100 / 5000 / 30000 files: exactly
    one event (`create vendor-x`), zero file events. `mkdir` one at a time with waits: every directory and
    file reported. `mkdir -p`, wait 1 s, write: only `create A`; a later edit in `A/pkg/deep/f0` is silent.
    Same hole in the git dir (`mkdir -p refs/heads/feat/x` gives `create refs/heads/feat` only).
  - Unsubscribe, then subscribe the same root again: the nested directory is watched. Subscribing a second
    time while the first subscription is alive does **not** help (the second reuses the first one's cached
    directory tree), so the order matters; `#subscribeWorktree` already releases first.
  - Daemon level (real git, writer in a separate process, fallback polls set to one hour): before the fix
    `vendor-x/pkg/deep` with 2000 files, written 500 ms after the directories, gave **no
    `worktree.changed` within 20 s** (the issue's symptom); written at once, the file list stayed at the
    first refresh's partial count for 30 s.
- **Not the cause.** The ignore list: `vendor*` is not a build name, and `dist`, `build`, `out`, `target`
  and `node_modules` behave identically (the build rules only drop events of directories git ignores).
  Not the watch host or its batching, not the EINTR area (reproduced in-process), not the fallback poll
  (it works, it is just 30 s to 5 min away).
- **Overflow is ignored natively, confirmed.** `InotifyBackend::handleEvents` does `continue` on
  `IN_Q_OVERFLOW`: no event, no error. 30000 files written into a watched directory arrive as 28943 events
  (default `fs.inotify.max_queued_events` 16384). The tail of a burst is still delivered, so a refresh
  happens, but a lost directory creation is a lost watch.
- **Fix (`apps/daemon/src/watch-subtree.ts`, wired in `watcher.ts`).** `NewSubtreeWatch` collects the
  `create` events of the worktree and of the git dir. When the burst is quiet (debounce, at most
  `maxWaitMs`) one pass `readdir`s the created paths (read-only; at most 4096 paths, 64 at a time) for a
  subdirectory that is not ignored by design and did not report its own creation (this pass or the previous
  one): it was not watched. Then the tree is re-subscribed (the existing `#subscribeWorktree` /
  `#subscribeProject`) and the worktree marked dirty afterwards (`fs`, `git` for the git dir).
  `ResubscribeGate` allows one re-subscribe per `max(2 s, 10 x last duration)`, coalesces requests, and
  runs one more after a running one. A pass that saw at least half of `fs.inotify.max_queued_events`
  creations (8192 by default) re-subscribes without looking (silent overflow); more than 4096 distinct
  created paths do too. Default on for Linux (`watchNewSubtrees`), off on macOS and Windows (recursive OS
  events). Options `watchNewSubtrees`, `newSubtreeGapMs`, `onSubtreeCheck` are for tests.
- 30000 files, real daemon + real git, writer 500 ms behind the directories (opt-in test): first
  `worktree.changed` after 623 ms, every one of the 30000 files listed after 15 s (the writer alone takes
  about 12 s).
- Read-only guarantee: watching only reads (`readdir`, no writes, no git); untouched.

## Verification

Linux (WSL2, Node 26), from the repo root.

| Command | Result |
|---|---|
| `pnpm --filter @octopus-diff/daemon exec vitest run test/watch-new-subtree.test.ts` | 16 passed (6.6 s) |
| same, with `#subtreeWatch` returning null (the fix off) | 12 of 16 fail (the 4 that pass are the pure-function and `watchNewSubtrees: false` tests) |
| `... test/watch.real-git.test.ts -t "issue #36"` | 5 passed; fix off: 3 fail (no `worktree.changed` in 20 s twice, stale list once); the two race-dependent cases (`build/...`, a later edit) pass either way |
| `OCTOPUS_DIFF_WATCH_30K=1 ... -t "30000 files"` | passed, first event 623 ms, all listed 15057 ms |
| `pnpm --filter @octopus-diff/e2e bench --no-ui --idle-seconds 5` | startup spawns 4.6 per worktree (budget <= 8) PASS, idle CPU 0.00 % PASS, edit -> SSE p95 43 ms PASS (the generated `docs/bench` files were reverted, not committed) |
| `pnpm check` | exit 0: lint, typecheck, build, tests: contracts 99, forge 101 (+5 skipped), git-core 276, fixtures 54, web 284, daemon 305 (+2 skipped), e2e 5, cli 139, scripts 34 |
| the seven watcher files (`watch-core`, `watch-host`, `watch.real-git`, `watcher-backend-errors`, `watcher-review-fixes`, `watcher`, `watch-new-subtree`; 73 tests + 1 skipped each) x 20, one run after another | **19 / 20 passed** |
| "heals on the fallback poll" alone x 30 | baseline `4c9e780`: 1 failure; this branch: 0 |

The one loop failure (run 7) is `watcher-review-fixes` > F1 "heals on the fallback poll when the folder comes
back without a relist": inotify did not report the deletion of the worktree root within 5 s, so
`status().mode` never became `mixed`. It is the pre-existing flake `macos-watcher-flake.md` already lists
("watch it"), it fails on the untouched base commit too (1 of 30 alone), and nothing of this change is on its
path (no `create` under a live subscription). The known Linux spawn-count flake (file-origins, #71) did not
show up. Earlier in the session one `pnpm check` run failed `tools/fixtures` "passes when only read-only git
commands run" (5 s timeout while all packages ran in parallel); it passes alone and in the final
`pnpm check`.

## Decisions

DECISIONS **#212** (one entry, new section "Watcher: new directories"). The parallel `feat/daemon-activity`
branch also uses #212 and up: renumber one of them at merge.

## Contract changes

None.

## Dependencies

None added or removed (`pnpm credits` not needed; `pnpm lint` runs `credits:check`, green).

## Known gaps

- The test for "directories reported one by one do not re-subscribe" and the ignored-subdirectory test end
  with a short negative wait (400 ms): nothing in the stream says "nothing happened". They wait first for
  the pass that inspected the creation (`onSubtreeCheck`), so the wait only covers a re-subscribe that
  would follow at once. A parcel delivery split by more than the debounce could in theory add a spurious
  re-subscribe; not seen in 20 + 5 loops.
- The directory check treats directories matched by a user ignore entry that is a glob or a path as
  watchable (costs one extra re-subscribe, never a missed edit), and a `dist`-like directory whose nested
  `.gitignore` is not read yet the same way.
- Events written into a new tree between `mkdir` and the re-subscribe are not seen by the stream; the
  refresh that follows the re-subscribe covers them. A burst whose directories keep appearing in an
  unwatched way re-subscribes at most once per gap (2 s or 10 crawl durations), so the view can lag by that
  much during such a burst.
- macOS FSEvents and Windows were not run here; the check is off there by design.
- The `create`/`modify` counts of a burst are post-coalescing (parcel merges create + update), so the
  overflow threshold errs on the low side of what the kernel queued; it is half of the limit on purpose.

## Notes for integration

- Merge conflicts: `docs/DECISIONS.md` (#212 vs `feat/daemon-activity`), nothing else expected; the
  changed existing test is `apps/daemon/test/watcher.test.ts` ("ignores node_modules, ..."), which now
  creates its nested ignored directories before subscribing (otherwise the new re-subscribe's refresh lands
  inside its quiet window).
- PR #69 (`fix/macos-watcher-flake`) edits `watcher-review-fixes.test.ts`; this branch does not touch that
  file.
- A maintainer who wants to see the cause again: `node` script in the issue's shape: subscribe a temp dir with
  `@parcel/watcher`, `fs.mkdirSync('a/b/c', {recursive: true})`, print the events (one).
