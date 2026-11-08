# fix-daemon-watch report

Branch `fix/daemon-watch`, from `main` at `6f44f53`. Scope: the watching / refresh layer of
`apps/daemon` for review-code **F1, F3 (watching part), F5, F6** and review-security **SEC-07
(daemon part)**. No contract changes; no changes to `app.ts`, `daemon.ts`, `security.ts`,
`token.ts`, `static.ts`.

## Shipped

Every finding was first reproduced: each regression test below fails on `6f44f53` (run against
the old `watcher.ts` / `core.ts`) and passes on this branch.

### F1: worktree removed and re-added at the same path

**Change.**
- `watcher.ts`: a `delete` event for a watched root (worktree root or project git dir) now
  tears the dead subscription down, marks it non-native with a `missing` failure (so
  `/api/health` says `Some watched paths do not exist; N worktree(s) fall back to polling…`
  and the worktree is polled at the degraded rate), and asks for a relist.
- `setProject` heals: an existing worktree / project whose subscription is gone because the
  folder vanished is re-subscribed once the folder exists again; one whose root `dev:ino`
  (`stat`) differs from the subscribed one is re-subscribed. Both trigger a catch-up refresh.
  A new `targets.gitDir` behind an unchanged folder only triggers a refresh (the folder's
  subscription does not depend on it; routing uses the new targets). The fallback poll retries
  the heal, so it also works without a relist.
- Subscribe / unsubscribe work is serialized per worktree and per project (`#enqueue`), and
  a re-subscribe always unsubscribes first: `@parcel/watcher` shares native watchers per
  (dir, ignore set) process-wide, so subscribing again while the dead one is registered would
  re-attach to it.
- `core.ts` `#watchTargets`: when a worktree may have been recycled, the daemon reads its
  `.git` entry (`watch-identity.ts` `gitDirOf`: one `O_NOFOLLOW|O_NONBLOCK` open, type checked
  on the descriptor, at most 4 KiB read, no git process). If it points at another git dir, the
  targets are re-fetched. If git-core still answers with the old git dir (its 5-min repository
  cache), the worktree gets `targets: null`, which routes every git-dir event of the project to
  it (correct, slightly over-inclusive) until the two agree. "May have been recycled" means:
  the watcher reported its folder deleted or replaced (new `WatcherServiceOptions` callback
  `onWorktreeReplaced`), it reappeared after being reported missing, or a new entry has an id
  that was removed less than 5 min ago. Reading `.git` on every sync instead cost ~70 ms of
  startup at 30 × 3 (see Verification).

**Tests.**
- `test/watch.real-git.test.ts` "F1: …": the reviewer's exact repro with real git
  (`git worktree remove --force wt && git worktree add -b b2 wt`, then an edit): health returns
  to `native` with no warnings and the edit produces `worktree.changed`.
- `test/watcher-review-fixes.test.ts` "F1: …" (5 tests): degraded health after the root is
  deleted (plus the `onWorktreeReplaced` callback) and re-subscribe on the next sync;
  replacement without a delete event (root `rename` with root events filtered out) detected by
  inode; a new admin dir behind the same folder (refresh and routing, no re-subscribe); heal
  from the fallback poll alone; a deleted and re-created git dir (re-clone).
- `test/watch-core.test.ts` "re-fetches watch targets …": the worktree folder is deleted and
  re-created with a `.git` pointing at `worktrees/wt1` while the fake git-core keeps answering
  with the old git dir; index writes in the new admin dir still refresh the worktree; once
  git-core agrees, targets are cached again and no longer re-fetched on each relist.

**Residual risk.** Between the deletion and the heal (normally < 1 s: the relist triggered by the
deletion or by `worktrees/<name>` events) changes are picked up by the catch-up refresh, not
lost. If git-core's cache keeps the old git dir, in-progress detection in summaries may be stale
for up to 5 min (git-core, see "What I need from git-core").

### F3 (watching part): submodules

**Change.**
- `GIT_DIR_IGNORES` no longer ignores `modules`; instead
  `{modules,worktrees/*/modules}/**/{objects,logs,hooks,lfs,rr-cache,fsmonitor--daemon}` is
  ignored, so submodule git dirs (`HEAD`, `refs`, `packed-refs`, `index`) are watched for the
  main worktree (`<common>/modules/<name>`) and per linked worktree
  (`<common>/worktrees/<wt>/modules/<name>`, which this also makes cheaper: their `objects` used
  to be crawled).
- Routing: `<common>/modules/**` belongs to the main worktree (linked worktrees' submodule git
  dirs are already inside their own git dir).
- A nested registered project no longer steals its superproject's refresh: events attributed to
  a worktree (file events and git-dir events) also mark dirty every watched worktree of **another
  project** whose root contains it (`#markOwnersDirty`). Nested worktrees of the same project
  keep the old behavior (git status treats them as untracked directories).
- git reports a submodule registered as its own project with its **git dir** as the main
  worktree path (`<super>/.git/modules/<name>`, verified with git 2.53). Such an entry (root ==
  common dir) is watched like a bare entry (git-dir subscription only), instead of being refused
  by the SEC-07 rule with a misleading warning.

**Tests.**
- real git: "F3: a commit inside a submodule refreshes the superproject (no refresh loop)": a
  commit inside an absorbed submodule produces the superproject's `worktree.changed`, and then no
  further `getSummary` calls for 1.5 s (our own `git status` does not write the submodule index
  and re-trigger itself).
- real git: "F3: a submodule registered as its own project …": both projects registered; an edit
  inside the submodule refreshes the superproject (counted `getSummary` calls; no event is
  expected because git-core's status uses `--ignore-submodules=dirty` by design), a commit inside
  it produces the superproject's `worktree.changed`, and health stays `native` without warnings.
- watcher: `modules/<name>/refs` → main only, `worktrees/wt/modules/<name>/HEAD` → linked only,
  submodule `objects/` writes → nothing; a nested registered project refreshes the enclosing
  worktree for both file and git-dir events.

**Residual risk.** Non-absorbed submodules (`<sub>/.git` is a directory inside the worktree) that
are *not* registered as their own project: their HEAD moves are invisible (`**/.git` is ignored
in working trees) until the fallback poll; see the git-core request below. A submodule whose
name ends in a heavy-dir name (`objects`, `logs`, `hooks`, …) is ignored by the glob. The
nested-project rule also refreshes the outer worktree for unrelated nested repos (one extra
`getSummary` per burst; `stateHash` prevents spurious events).

### F5: default build-directory ignores hid tracked files

**Change** (`watch-ignores.ts`, used by `watcher.ts`).
- The default names are split: `DEFAULT_WORKTREE_IGNORES` (dependency, cache and tool dirs:
  `.git`, `node_modules`, `bower_components`, `.next`, `.nuxt`, `.svelte-kit`, `.turbo`,
  `.cache`, `.parcel-cache`, `.vite`, `.gradle`, `__pycache__`, `.venv`, `venv`, `.tox`,
  `.mypy_cache`, `.pytest_cache`, `.terraform`, `.direnv`) stay ignored at any depth;
  `BUILD_OUTPUT_DIRS` (`dist`, `build`, `out`, `target`, `coverage`) are skipped **only where
  git ignores them**.
- "Git ignores it" is approximated without git: rules in `<root>/.gitignore` and
  `<common>/info/exclude` that name a build directory directly (`dist`, `dist/`, `**/dist` → any
  depth; `/dist`, `dist/**`, `dist/*`, `app/build` → that directory) become `@parcel/watcher`
  ignores. Any negation line mentioning the name cancels them (it may re-include tracked files).
  Anything else leaves the directory watched: the failure mode is extra inotify watches, never a
  hidden edit. Ignore files are read with the same bounded, no-follow reader (≤ 256 KiB).
- Build directories that are only ignored by a **nested** `.gitignore` (e.g. Android modules'
  `app/.gitignore: /build`) are watched, and their events are dropped by a cheap filter that
  reads the ancestors' `.gitignore` files lazily (cached per worktree, cleared on any
  `.gitignore` event), so builds there cause no refresh churn.
- A change to the root `.gitignore` or to `info/exclude` re-reads the rules (debounced) and
  re-subscribes the worktree if the ignore set changed.
- "Consult the file list you already have": every file list git-core returns for a worktree
  (`DaemonCore.#gitFiles`, any scope) passes its tracked paths to
  `WatcherService.noteTrackedPaths`; a build directory that holds tracked files is then watched
  even if `.gitignore` ignores it (force-added `dist/`), from the first time such a file shows up
  in a list (≤ 5 min poll, focus or manual refresh), for the lifetime of the watch.

**Tests.**
- real git: "F5: …": tracked `dist/index.js` and `tools/build/run.sh` (the reviewer's repro)
  each produce `worktree.changed`.
- watcher (6 tests): tracked `dist/` and `tools/build/` live without a `.gitignore`; with
  `dist/`, `/build` in `.gitignore`, `target/` in `info/exclude` and `/out` in `app/.gitignore`:
  `dist/`, `packages/a/dist/`, `build/`, `target/`, `app/out/` are quiet while `tools/build/`,
  `lib/out/` and `src/` are live; a negation keeps `dist/` live; editing `.gitignore` and
  `info/exclude` re-subscribes with the new rules; `noteTrackedPaths` makes a force-added `dist/`
  live while another ignored `pkg/dist/` stays filtered; the rule parser on a table of patterns.

**Residual risk.** Force-added files in a git-ignored build directory are live only after the
first file list shows one of them changed, and that knowledge is in memory (lost on restart).
Build directories ignored only by nested `.gitignore` files or by global excludes
(`core.excludesFile`, not read) cost inotify watches; users can add the name to `watch.ignore`
(which always ignores). The `.cache`-style names remain ignored even if tracked.

### F6: `.git/info/exclude` not watched

**Change.** `info` is no longer in `GIT_DIR_IGNORES` (one more inotify watch per repository), and
any change under `<common>/info/` (exclude, attributes, sparse-checkout) refreshes every worktree
of the project. `info/exclude` also re-evaluates the F5 build-directory rules.

**Tests.** real git "F6: …" (untracked `junk.log`, then `info/exclude` → `worktree.changed` and
`/files` is empty); watcher "F6: …" (`info/exclude` and `info/attributes` refresh both
worktrees with reason `git`).

**Residual risk.** Files outside the repository that git also reads (`core.excludesFile`,
`core.attributesFile`) are not watched; their changes show up on the next poll or refresh.

### SEC-07 (daemon part): one project must not make the daemon watch huge or unrelated trees

**Change** (`watch-guard.ts`, used by `watcher.ts`; the prunable skip is in `core.ts`).
- Never subscribed recursively: the filesystem root, the user's home directory or any parent
  of it, a fixed list of top-level system directories (`/usr`, `/etc`, `/var`, `/tmp`,
  `/home`, `/Users`, `/Volumes`, …, exact matches only, so repositories inside them are fine),
  `os.tmpdir()`, a WSL drive root (`/mnt/c`), and a worktree root that **contains the
  repository's git dir** unless it is the main worktree right next to it (`<root>/.git`). The
  same guard applies to a project's git dir subscription.
- At most **64** natively watched worktrees per project (`MAX_WATCHED_WORKTREES_PER_PROJECT`,
  `WatcherServiceOptions.maxWorktreesPerProject`): the main worktree first, then the ones
  already watched (a new worktree never evicts a watched one), then git's order. When a watched
  one goes away, the next is promoted.
- Refused and capped worktrees stay registered and are polled at the normal idle / focused rates
  (5 min / 30 s), not the degraded 30 s / 5 s rates, so a forged record does not turn into
  frequent `git status` runs either.
- `core.ts` never watches `prunable` worktree records (git's own verdict for a record whose
  folder has no `.git` leading back; this is what a forged record looks like today).
- `/api/health` (through `WatcherService.status()`, no paths) reports, e.g.
  `Not watching 3 worktree folder(s) that are too broad to watch (filesystem root: 1, home
  directory or a parent of it: 1, folder containing the repository's git dir: 1); they are only
  polled every 300s (30s when selected). Check \`git worktree list\` in the affected project for
  stale or forged worktree records.`,
  `N worktree(s) are beyond the limit of 64 watched worktrees per project; …` and
  `Not watching the git dir of N project(s) because it is too broad to watch …`. The mode becomes
  `mixed` / `polling`. The daemon log has the paths (one warning per worktree).

**Tests.**
- real git "SEC-07: …": a forged `.git/worktrees/evil` record pointing at a temp directory with
  20 subdirectories; `worktree list` reports it, the daemon never subscribes to it.
- `watch-core.test.ts`: prunable records are not watched; a record at `/` is never subscribed and
  `/api/health` shows the refusal warning with mode `mixed`.
- watcher: `/`, a (fake) home directory and a folder containing the git dir are refused with one
  path-free warning and idle-rate polling; the cap (2 in the test) with promotion; a too-broad
  git dir; the classifier on a table of paths.

**Residual risk.** A forged record pointing at another of the user's real repositories (it has a
`.git`, so git does not mark it prunable) is still watched until git-core flags such records
(parallel session); the guard still refuses `/`, `$HOME` and the other broad roots. Refused
worktrees are still summarized at the idle rate (`git status` fails fast on a forged `/`; a
legitimate "bare dotfiles repo with `$HOME` as work tree" costs one `git status` of `$HOME` per
5 min). The cap is per project; there is no global watch budget.

## Verification

Machine: AMD Ryzen 7 7800X3D (12 logical cores in WSL2), Node 26.13.0, git 2.53.0, pnpm 12.16.1.
Other sessions were running on the same machine.

| Command | Result |
|---|---|
| `pnpm install && pnpm check` on `6f44f53` (baseline) | pass; daemon 86 tests |
| `pnpm check` on this branch (final code, run twice) | pass: lint, typecheck, build; tests contracts 58, git-core 98, web 38, fixtures 48, daemon 113, e2e-unit 5, cli 108 |
| `pnpm --filter @octopus-diff/daemon test` | 113 passed (86 + 27 new: 18 `watcher-review-fixes`, 3 `watch-core`, 6 `watch.real-git`), ~22 s (was ~6 s: the new watcher tests wait for real file events) |
| New tests against the old `watcher.ts` / `core.ts` | all behavioral regression tests fail (9/9 watcher F1/F3/F5/F6, 2/2 core, 6/6 real git) |
| `pnpm test:e2e` (final code) | **36 passed** (1.1 min); read-only proof: 12 control repos, 1532 lock polls, **0 violations** |

Flakiness: the daemon suite ran 16 times in full. With the first version of the tests, 1 of 8
runs failed (a 2 s wait in the F1 watcher test while other sessions loaded the machine; the
same test passed 12/12 in isolation, and parcel's inotify backend always reports the root
deletion, checked in its source). The positive waits of the new tests were raised to 5 s (they
return as soon as the condition holds); since then 8 consecutive full runs are green.

### Bench (PLAN §8.10, 30 repos × 3 worktrees, `e2e/bench/bench.ts --out /tmp/…`, 3 runs each)

Other sessions were running, so the full bench was repeated 3 times per build, and startup
(the only metric that moved) was also measured **interleaved**: old and new `apps/daemon/dist`
swapped before each run of `bench.ts --idle-seconds 5 --iterations 3 --no-ui`, 5 runs each.

| Metric | before (`6f44f53`) | after (final) | target |
|---|---|---|---|
| First paint, cold | 956 / 959 / 979 ms | 1047 / 1045 / 877 ms | < 3000 ms |
| First paint, warm reload | 69 / 68 / 65 ms | 77 / 84 / 200 ms | — |
| Idle CPU avg / worst 1 s (60 s) | 0.28 / 0.33 / 0.30 % — 4 / 2 / 3 % | 0.38 / 0.35 / 0.42 % — 3 / 4 / 3 % | single-digit % |
| Write → SSE p50 / p95 | 12/13, 12/15, 12/14 ms | 13/16, 13/13, 14/15 ms | < 1000 ms |
| Write → UI p50 / p95 | 29/31, 29/31, 29/32 ms | 29/39, 29/31, 30/33 ms | < 1000 ms |
| Startup listening / all summaries (full bench) | 612/1029, 598/1028, 599/1028 ms | 688/1207, 700/1188, 670/1150 ms | — |
| RSS end of idle | 126 / 127 / 127 MiB | 133 / 132 / 136 MiB | — |
| **Interleaved startup A/B**, listening (median, range) | 635 ms (609–656) | 662 ms (649–677) | — |
| **Interleaved startup A/B**, all summaries (median, range) | 1080 ms (1042–1100) | 1128 ms (1117–1150) | — |

Reading: refresh latency, first paint and idle CPU are unchanged within noise (idle CPU is read
from 100 Hz ticks: the 0.07 % difference is ~4 ticks in 60 s, and there is no new periodic work
except one `stat` per worktree per 60 s relist). Startup is **~27 ms (4 %) slower to listening
and ~48 ms (4 %) slower to all summaries** at 30 × 3: the per-subscription root `stat` (F1) and
`.gitignore` / `info/exclude` reads (F5), which a patched build without them showed to be
~20–30 ms of it. The first version of the fix cost +70 / +110 ms (it read every worktree's
`.git` on each watcher sync); commit `c50cad7` removed that. RSS is +6–9 MiB in these runs
(an intermediate build measured 133 / 126 / 135 MiB); not investigated further. Raw outputs:
`/tmp/odw-bench/{before,after,final}*/results.md` and `/tmp/odw-ab/*.log` (not committed;
`docs/bench/` was not regenerated).

## Decisions

1. **Build-output vs always-ignored names (F5).** Only `dist`, `build`, `out`, `target`,
   `coverage` depend on git's ignore rules; dependency / cache / tool directories stay ignored
   (watching them would be costly and tracked content there is rare). Reason: these five are the
   names the review found tracked in practice.
2. **Git's ignore rules are approximated daemon-side (F5)**, from rules that name a build
   directory directly, with negations cancelling. No GitCore method was added (none fits; a
   contract change was out of scope). Reason: cheap (two small reads per subscription), and every
   misjudgement errs towards watching.
3. **Nested `.gitignore` rules filter events instead of pruning the watch (F5).** Reason: finding
   nested build directories at subscribe time would mean a second crawl of every worktree.
4. **File lists un-ignore build directories (F5)**, for any scope, per worktree, in memory.
5. **Root identity is `dev:ino`; the git dir is read from the `.git` entry (F1)**, with plain,
   bounded fs reads, and only when the worktree may have been recycled. Reason: catches
   recycled paths without a git spawn and without waiting for git-core's 5-min cache, and stays
   off the startup path.
6. **Stale targets fall back to `null` (route every git-dir event) rather than to the cached
   git dir (F1).** Reason: over-refreshing is safe, missing commits is not.
7. **Nested repositories of another project refresh their enclosing worktree (F3)**, without
   checking that the path is a gitlink. Reason: no cheap gitlink check exists daemon-side; the
   cost is one extra summary per burst and `stateHash` suppresses spurious events.
8. **A worktree root equal to its common dir is watched like a bare entry (F3).**
9. **SEC-07 limits:** refused roots as listed above; cap 64 per project; refused / capped
   worktrees polled at normal (not degraded) rates; prunable records not watched. Health
   warnings carry counts and reasons, never paths.
10. **No new `internal` knobs in `daemon.ts`** (to stay off files other sessions edit): the cap
    and guard directories are `WatcherServiceOptions` (`maxWorktreesPerProject`, `guardDirs`)
    and are tested at that level.

Requested doc changes (for the lead; I did not edit PLAN / DECISIONS / BLOCKERS):
- PLAN §5.6: "ignore `.git`, `node_modules`, and common build dirs by default" → "…; build-output
  dirs (dist, build, out, target, coverage) only where `.gitignore` / `info/exclude` ignore them";
  add "submodule git dirs and `info/` are watched" and the SEC-07 limits (refused roots, 64
  worktrees per project, prunable records skipped).
- DECISIONS: decisions 1–10 above, and close review findings F1, F5, F6, SEC-07 (daemon part) and
  F3 (watching part).
- README / CLI `doctor` (WS5): mention that the build-dir default now depends on `.gitignore`, and
  that `watch.ignore: ["build"]` restores the old behavior for big untracked build trees.

## Contract changes

None. `WatchTargets` is used as is.

## What I need from git-core

1. **Repository cache vs recycled worktrees.** `GitContext.repo()` caches git dir / common dir
   per path for 5 min. After `git worktree remove` + `add` at the same path git may pick a new
   admin dir (`worktrees/<name>1`); git-core then returns the old `gitDir` from
   `getWatchTargets` and checks in-progress operations in the old dir in `getSummary`. Please
   invalidate the entry when the `.git` entry of the path changes (e.g. key it by its `lstat`
   signature, or re-read the `.git` file, which is one small read). The daemon copes (null
   targets) but cannot fix summaries.
2. **Submodule registered as its own project.** `worktree list` in a submodule's git dir reports
   the git dir (`<super>/.git/modules/<name>`) as the main worktree, so the project's worktree id
   and path are the git dir. `git rev-parse --show-toplevel` run there returns the checkout
   (`<super>/<name>`, from `core.worktree`); please report that as the main worktree path. Until
   then file edits inside such a submodule refresh the superproject but not the submodule's own
   project (its git-dir events still do).
3. **Optional: non-absorbed submodules.** For a submodule whose `.git` is a directory inside the
   worktree, adding its `HEAD`, `refs` and `packed-refs` to `WatchTargets.gitPaths` (or a new
   optional field) would let the daemon watch them; the daemon would then subscribe to git paths
   outside the common dir (today all are assumed inside it). Absorbed submodules (what
   `git submodule add/update` creates) need nothing.
4. **Forged records.** The daemon skips `prunable` records. If git-core flags forged records some
   other way (a new field), the daemon should skip that too; please tell the lead.
5. The `stateHash` change for submodule commits (parallel session) needs nothing more from the
   daemon: the superproject is refreshed on every submodule `HEAD` / ref move.

## Known gaps

- Non-absorbed, unregistered submodules (above); force-added build output only after the first
  listed change; nested- or globally-ignored build dirs cost watches; no global watch budget.
- Health warnings for refused / capped worktrees are aggregated; the paths are only in the log.

## Notes for integration

Files edited (all under `apps/daemon`):

- `src/watcher.ts` (largest change): imports; `DEFAULT_WORKTREE_IGNORES` (build names moved to
  `BUILD_OUTPUT_DIRS`; still exported from `index.ts`, no other package uses it);
  `GIT_DIR_IGNORES`; `WatcherServiceOptions` (+`maxWorktreesPerProject`, `guardDirs`,
  `onWorktreeReplaced`); the state
  types; and most of the `WatcherService` class body (`setProject`, `status`, worktree and
  project subscriptions, event handlers, git routing, polling). Public API unchanged except the
  new `noteTrackedPaths`; `buildWorktreeIgnores`, `compactIgnores`, `WATCH_DEFAULTS`,
  `TIMER_JITTER` are unchanged. A `wire:` edit from the UX round that passes settings-driven
  ignores should go through `WatcherServiceOptions.ignore` (always-ignored entries, merged per
  worktree in `#subscribeWorktree`).
- `src/core.ts`: one import (`gitDirOf`); `WorktreeEntry.checkGitDir` and the
  `RECYCLE_WINDOW_MS` constant after the interface; the `#recentlyRemoved` field; the
  `onWorktreeReplaced` line in the watcher options of the constructor; three small additions in
  `#applyWorktrees` (flag on missing → present, flag for recently removed ids, remember removed
  ids); in `#syncWatcher` the per-worktree loop (prunable skip, `#watchTargets`); new private
  methods `#rememberRemoved`, `#onWorktreeReplaced`, `#watchTargets` right after `#syncWatcher`;
  `checkGitDir: false` in `#newWorktreeEntry`; 8 lines at the top of the `.then` in `#gitFiles`
  (`noteTrackedPaths`).
- New: `src/watch-guard.ts`, `src/watch-identity.ts`, `src/watch-ignores.ts`.
- Tests: new `test/watcher-review-fixes.test.ts`, `test/watch-core.test.ts`,
  `test/watch.real-git.test.ts`; `test/fake-git-core.ts` gains an optional `prunable` flag
  (+3 lines).

Not touched: `app.ts`, `daemon.ts`, `security.ts`, `token.ts`, `static.ts`, contracts, other
packages.
