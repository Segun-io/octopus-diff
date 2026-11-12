# remote-spawns report

GitHub #74 "With a remote, warm reload spawns 68-71 git processes and startup config spawns double". Branch
`fix/remote-spawns` from `main` at `152f90e`. DECISIONS #225-#228 (main already has #212; `feat/daemon-activity` and
`fix/watch-new-subtree` also use #212 and up: renumber at merge).

## Root cause

Traced with the spawn trace (now with full argv) on the `--after-fetch` layout, by subcommand, argv and cwd:

1. **The 68-71 "warm reload" spawns were not the reload.** The three `warmReload` windows start right after the cold
   paint. With To review as the default, the cold paint asks for every review state and label: about 12 processes
   per linked worktree the first time (`rev-list` range, the review list's `status` + `diff`, `merge-base`,
   `log -p` + `patch-id`, the three-way `merge-base`, `diff-tree`), at most 2 label calls at once (#201). That work
   finishes 1.9-5 s after the paint, so the reload windows counted whatever of it was still running. The plain and
   `--to-review` runs have less of it (no labels), hence 0-27. There was **no repeated call with the same argv**
   outside the open worktree. The integration-base key (#196), the origin labels (#201) and the review state (#202)
   all hit: once the daemon is quiet, a reload costs **3 processes in every layout, before and after this change**
   (the open file's diff: `diff --raw`, `status`, `diff -p`; diffs are not cached by design, roadmap #41).
2. **What was really remote-related and wasteful: `readRemoteConfig` was never cached.** The forge service reads
   it per project on startup, on every focus refresh, every poll round (every 2 min while someone looks), every
   `gitChanged` (twice when a push is detected) and every forced refresh; `readRepositoryInfo` reads it too. Each
   call was one `git config` per project. In the first 10 s after startup that was 45 remote-config reads for 30
   projects (startup + the first focus during the reloads), 54-80 over a whole bench run, and 25 in the live fetch.
3. **Startup `config` 53 → 111 (merge-noise run).** I could not reproduce 111 here: every run on this (busier) machine
   had 30 scans plus 13-25 forge reads inside the startup window, with or without a remote (the forge service also
   reads remote config when there is no remote: exit code 1). Part of the window count is just timing: the forge's
   30 startup reads land right at the end of "all summaries", so a faster machine counts more of them. The other
   part fits the racy window: a config file younger than 2 s was never shared between operations, so each
   worktree's summary read its own scan (111 − 53 = 58 = 2 extra per project for 29 of 30 projects). That
   explanation is likely, not proven: `git fetch` does not write `.git/config` (checked), so it needs `remote add`
   within 2 s of startup. Both causes are fixed (below); the racy part is covered by tests that fail without the fix.

## Shipped

- **git-core: remote config through the config cache** (`packages/git-core/src/remotes.ts`,
  `GitContext.cachedConfigRead` in `context.ts`). It follows the config scan's rules (#191): same stat signature of
  every config file git reads, none younger than 2 s, no `include.*` / `includeIf.*` key (the read's regexp now also
  asks for those keys; `REMOTE_CONFIG_REGEX` is unchanged), age limit 10 min (#226). Each caller gets a copy.
- **git-core: racy config reads are joined when their process started after the operation asked** (#227). A new
  internal `onSpawn` runner option records when the git process starts. An operation that finds a read with the same
  key whose process started after it asked (or that still waits for a slot) takes that answer, even inside the 2 s
  window. This is safe because git reads the files after its process starts. A racy read is still never *reused*
  by a later operation.
- **Bench** (`e2e/bench/`): `settledReload1-3` (start after 1 s without a git process, end when the daemon is quiet
  again) with a Numbers row "Warm reload once the daemon is quiet: git spawns (per worktree, worst of 3; reported,
  not judged)"; `argv` in every trace line; `--keep-trace <dir>`. Fixed a bench bug (#228): the quiet wait counted
  the long-lived watch host (`node`) as a running child, so it could only end at its timeout. It now counts only
  git processes. `docs/bench/README.md` has a "Spawns per reload" section. `docs/bench/results-after-fetch.*`
  were regenerated with this branch.
- **Tests**
  - `packages/git-core/test/git-metadata.test.ts` (+3): the remote config is read once while nothing changes (also
    for concurrent callers) and again right after `remote set-url`, every time while racy, once more after the
    window; `include.path` disables reuse; three worktrees summarized together right after `remote add` read
    config once.
  - `apps/daemon/test/remote-spawns.real-git.test.ts` (new, 2 tests). Layout: bare `origin`, two linked worktrees
    that committed their own file and merged `origin/main`, stale local `main`, one dirty worktree. The forge client
    is fake, and the forge poll and hot poll run every 300 ms. Assertions: a real startup (second daemon on the
    registered project, config older than 2 s) reads config exactly `{ scan: 1, remote: 1 }`. Two warm reloads
    (focus, projects, forges, three inboxes, three lists per worktree, repositories) cost `[]`. Hiding and showing
    the tab costs exactly `['status app-feature']`, and switching the focused worktree exactly one `status` per
    newly focused worktree. A forced forge refresh, `gitChanged` and 1 s of polls cost `[]`. A config write is read
    again. A startup right after `remote add` costs 1 scan for the project. Every count is taken after
    `quietSpawns` (no git start for 600 ms).

## Verification

Machine: 12-core WSL2, Node 26.13, git 2.53, shared with other sessions (timings noisy, spawn counts reliable).

- **Mutation checks** (each reverted): join disabled → the git-core racy test (3 reads) and the daemon racy-startup
  test (`expected 3 to be 1`) fail; racy reads cached → two git-core tests fail; `include*` ignored → the include
  test fails; remote read not cached → the git-core cache test fails, and the daemon test fails because the 300 ms
  forge poll never lets git go quiet. The git-core racy test passed 12/12 in a loop; the daemon file (both tests) 4/4.
- `pnpm check`: **exit 0**. contracts 99, forge 101 (+5 skipped), fixtures 58, git-core **279** (was 276), web 284,
  daemon **286 (+1 skipped)** (was 284), e2e unit 5, cli 139, scripts 34; lint (incl. `credits:check`), typecheck,
  build green.
- `pnpm test:e2e`: **99 passed (3.0 min), exit 0**, no flaky or failed test (16-copy.spec.ts:226 passed this time). Read-only
  proof: **12 control repos, 4276 lock polls, 0 violations**. No shutdown hang (BLOCKERS Open 2 did not trigger); the
  log has the usual `git-core has been disposed` request errors between specs.
- **Bench, before/after on the same machine, back to back** (`pnpm --filter @octopus-diff/e2e bench [--to-review |
  --after-fetch] --keep-trace …`). "Before" = this branch's bench commit `5471c34` on top of main, with no git-core
  change, built in a temporary worktree (removed afterwards); "after" = this branch. All six runs exit 0 with every
  budget PASS.

  | Metric | plain before / after | `--to-review` before / after | `--after-fetch` before / after |
  |---|---|---|---|
  | Startup spawns (per worktree) | 412 (4.6) / 409 (4.5) | 406 (4.5) / 404 (4.5) | 416 (4.6) / 408 (4.5) |
  | of which `config`: scan + remote | 30 + 21 / 30 + 18 | 30 + 15 / 30 + 13 | 30 + 25 / 30 + 17 |
  | Remote-config reads, first 10 s after start | 45 / **30** | 45 / **30** | 45 / **30** |
  | Remote-config reads, whole run | 56 / **30** | 54 / **30** | 80 / **30** |
  | Warm reloads right after the cold paint (spawns) | 12, 11, 25 / 9, 14, 20 | 10, 16, 3 / 13, 15, 23 | 55, 15, 49 / 53, 17, 57 |
  | Settled reloads (spawns) | 3, 3, 3 / 3, 3, 3 | 3, 3, 3 / 3, 3, 3 | 3, 3, 3 / 3, 3, 3 |
  | Live fetch spawns (`config`) | | | 592 (25) / **565 (0)** |
  | Cold paint / warm median | 292 / 192 ms; 285 / 182 ms | 269 / 181; 282 / 184 ms | 267 / 180; 292 / 210 ms |
  | Labels known / live relabel | | | 4322 / 1714 ms; 4050 / 1071 ms |

  The startup-window remote count still varies (13-25) because the forge's 30 startup reads land at the window's
  edge. Each is the first read of its project, which is needed. Startup-config doubling did not occur in any run
  (see Root cause 3).

## Decisions

- #225: the warm-reload figure was the cold paint's work. The settled-reload figure is reported, not judged: it is a
  stable 3 (the open file's diff), not 0, until #41 caches diffs.
- #226: `readRemoteConfig` cached under the config-scan rules, 10 min age limit, copies per caller.
- #227: config reads joined when their process started after the operation asked, also when racy.
- #228: the bench counts only git children as running; argv in the trace; `--keep-trace`.

## Contract changes

None. `GitRunOptions.onSpawn` and `GitContext.cachedConfigRead` are git-core internals.

## Dependencies

None added or removed (`pnpm credits` not needed; `credits:check` passes in `pnpm check`).

## Known gaps

- Startup `config` 111 from the merge-noise run was not reproduced on this machine; the explanation is likely but
  not proven (Root cause 3). The racy part is fixed and tested.
- Startup still reads config twice per project: one scan (`--show-scope`, filter drivers / attributes file) and one
  remote read. Both could come from one `git config --get-regexp` with a combined pattern. I did not combine them:
  the scan runs per worktree and the remote read per project, so their keys differ.
- A reload still costs the open file's diff (3 processes, #41). Focusing a worktree re-checks it with one `status`,
  which is deliberate (`watcher.setFocus`, catches missed watcher events). The settled-reload figure is therefore
  not judged.
- The 10 min age limit means a change to a trusted config file that git-core does not stat (a packager's system
  gitconfig) can take up to 10 min to reach the forge view. Repository and global files are always in the
  signature.
- Timings in `docs/bench/results-after-fetch.*` come from a busy machine (cold paint 292 ms vs 145 ms in the
  previous file). Regenerate on a quiet machine before quoting timings; spawn counts are reliable.

## Notes for integration

- DECISIONS numbers #225-#228 (renumbered from #213-#216 when other branches took #213-#224); may still collide with `fix/watch-new-subtree`: renumber whichever
  lands second (this report and the bench README's section reference them only by number in DECISIONS).
- `e2e/bench/spawn-trace.mjs`'s active-file change affects every bench that waits for quiet: edit loops and the
  live-fetch wait now end when git is quiet instead of at their timeouts, so bench runs are shorter.
- Rebuild (`pnpm build`) before the bench and e2e: git-core changed.
