# fixtures-e2e report (WS4: fixtures, e2e, perf)

Branch `ws/fixtures-e2e`, based on `db5274c`. Owned paths only: `tools/fixtures/**`, `e2e/**`, `docs/`
(plus `pnpm-lock.yaml` from adding one workspace dependency). No contract changes.

## Shipped

### `@octopus-diff/fixtures` (`tools/fixtures/src`)

- **Generator** `generateFixtures(options)` → `FixtureSet { root, manifest, env, manifestPath,
  describeWorktree(name), cleanup() }` (`generator.ts`, `scenarios.ts`, `builder.ts`). Builds everything
  under `mkdtemp(os.tmpdir()/octopus-diff-…)` in about 0.9 s, deterministic per seed (same seed, same
  commit shas). `cleanup()` / `removeFixtureRoot()` refuse anything that is not a direct child of the temp dir.
  - `alpha`: local bare `origin`, `origin/HEAD`, main **ahead 2 / behind 1**, two linked worktrees
    (`feature/login` ahead 2 / behind 1 vs `main`, `agent/refactor` ahead 1 / behind 0), staged + unstaged work.
  - Scan root `scan/` (depth 3): `beta` (depth 1, plus a **detached** linked worktree), `gamma` (depth 3,
    default branch **`master`**), `epsilon` (clean), and things that must be skipped: a repo in
    `node_modules/`, a repo at depth 5, a plain dir, and two **symlink loops** (`→ .`, `→ ..`).
  - `kitchen-sink`: untracked, staged+unstaged on one file (`MM`), staged rename, staged copy, unstaged
    and staged delete, added, binary PNG, **4 MiB** staged SQL, 256 KiB **one-line minified** JS, **CRLF**,
    **non-UTF-8 filename** (`latin1/caf\xe9.txt`), unicode filename, modified **symlink**, **submodule** with
    a new commit, **typechange** (file → symlink), whitespace-only edit, stat-dirty bait.
  - `conflict` (mid-merge, `UU` + a staged add), `root-only` (single root commit + edit), `empty`
    (unborn HEAD, staged + untracked), `bare-project.git` (bare, two linked worktrees), and the mutable
    `live` project (+ `live-agent` worktree) that tests and the simulator edit.
  - Optional bench layout: N repos × M worktrees (default 30 × 3), each worktree dirty.
  - The **manifest** (`manifest.ts`, written to `<root>/manifest.json`) has per project/worktree: contract
    ids (sha256 of realpath, 16 hex chars), branch, detached, head sha, upstream, ahead/behind (+ ref), counts,
    changedFiles, inProgress, raw porcelain-v2 entries, expected files per scope (working / staged /
    unstaged / branch) with status, oldPath, rawPath, binary, modes and line counts, recent commits (with file
    lists for selected commits), special case → path + UI marker text, and scan-root expectations.
- **Git oracle** (`oracle.ts`): read-only (`--no-optional-locks`, `GIT_OPTIONAL_LOCKS=0`) parsers for
  `status --porcelain=v2 -z`, `--raw -z`, `--numstat -z`, `worktree list --porcelain -z`; per-scope expected
  files via **plumbing only** (see Decisions #3).
- **Isolated git** (`git.ts`): a private `GIT_CONFIG_GLOBAL` with `autocrlf=false`, `pager=cat`, empty
  global excludes/attributes files, `gc.auto=0`, `protocol.file.allow=always`, plus `GIT_CONFIG_NOSYSTEM`,
  `GIT_ATTR_NOSYSTEM`; inherited `GIT_*` variables are stripped; argv arrays only.
- **Agent simulator** (`simulator.ts`): `startAgentSimulator({ targets, env, seed, durationMs, maxActions,
  min/maxIntervalMs, weights, onAction, signal })` → `{ actions, done, stop() }`, plus `performAction()` for
  single steps. Actions: edit, append, add, rename, delete, stage, commit. Refuses any target outside the OS
  temp dir or without `.git`.
- **Read-only proof harness** (`readonly-proof.ts`): `startReadOnlyProof({ env, targets })` → `finish()` →
  `ProofReport`; `assertReadOnly()` throws `ReadOnlyViolationError` listing each violation;
  `proofTargetsFromManifest()` selects control + source repos.
- **Perf helpers** (`perf.ts`): `/proc/<pid>/stat` parsing, `sampleProcessCpu()`, `summarize()` (p50/p90/p95).
- **CLI** `octopus-diff-fixtures` (`dist/cli.js`; dev: `pnpm --filter @octopus-diff/fixtures fixtures`):
  `generate [--seed] [--bench --repos N --worktrees M] [--json]`, `simulate --manifest … [--worktrees
  live,live-agent] [--duration S]` (refuses control repos), `cleanup <root>`.

### `e2e/` (Playwright, one command: `pnpm test:e2e`)

- `support/global-setup.ts`: preflight (builds present, web bundle not the placeholder), fixture generation,
  **read-only proof over all control repos for the whole run**, daemon smoke test (start + register one
  fixture). All problems are reported together in one `E2ePreflightError`. The returned teardown writes
  `e2e/test-results/readonly-proof.json`, keeps the fixtures if the proof failed, and **fails the run** on
  any violation.
- `support/daemon.ts`: `TestDaemon` wraps `startDaemon` (in-process, fresh state/config dir per test,
  port 0, explicit token, `webRoot = apps/web/dist`, isolated `git.env`), with `restart()` and
  `waitForProjects()`.
- `support/app.ts`: page object built only on `TEST_IDS` (one place to adapt if the UI renders differently).
- `support/test.ts`: fixtures `manifest`, `gitEnv`, `daemon`, `app`, `edits` (restores the mutable files).

| Spec | PLAN §8 item | What it asserts |
|---|---|---|
| `01-projects.spec.ts` (4 tests) | 2 | UI add by path (alpha + 2 linked worktrees) and by scan root on an empty daemon; linked-worktree path resolves to the same project; node_modules / too-deep / symlink loops skipped; API project, worktree and summary fields (ids, branch, head, ahead/behind, counts, inProgress) for every fixture; sidebar `data-*` for every worktree; text and only-dirty filters |
| `02-inbox-diff.spec.ts` (4) | 3 | API and UI inbox = exactly the dirty worktrees with their files; selected file shows the real patch lines in unified and split; `data-patch-hash` matches |
| `03-scopes.spec.ts` (7) | 4 | Every worktree × working/staged/unstaged/branch scope and root/HEAD commits against the git oracle (file set, status, oldPath, rawPath, binary, modes, line counts, `patchHash` equal between list and diff, patch line counts); too-large + `full`, whitespace/context options keep `patchHash`, non-UTF-8 `rawPath`, 404 for unchanged paths; UI scope selector; UI binary / too-large + load-anyway / rename / delete / untracked / minified / CRLF / non-UTF-8 / unicode / symlink / submodule / typechange / hide-whitespace / conflict / unborn |
| `04-live-updates.spec.ts` (5) | 5 | write → SSE `worktree.changed` ≤ 1.5 s; open file edited externally: counts + diff (or updated banner) within budget, selection kept, no reload/navigation; other files added/deleted without disturbing the open diff; sidebar counts in inbox; UI converges after an agent-simulator burst |
| `05-review.spec.ts` (3) | 6 | mark (button) → hidden with show-reviewed off and from `onlyUnreviewed` inbox → edit → unreviewed again → mark (`r`) → daemon restart → still reviewed (API and UI); restoring old content re-matches the old mark; only-unreviewed sidebar filter; marks are per scope kind |
| `06-keyboard.spec.ts` (5) | 7 | `j`/`k`, `J`/`K`, `s`, `r`, `/`, `g i`, `?` (+ Escape); `n` visits exactly the unreviewed files across three projects and never lands on a reviewed one |
| `07-readonly.spec.ts` (1) | 8 | own fixture set + own proof: every read endpoint, scope and diff variant, rescan, SSE and the UI, while the simulator edits the mutable repo → zero control-repo writes. The global teardown proof covers the entire run |
| `08-auth.spec.ts` (7) | 9 | raw `node:http`: no/wrong token → 401 on API, POST/PUT and SSE; foreign `Origin` (incl. `null`) and foreign `Host` rejected even with a token; loopback hosts and own origin accepted; `?token=` → redirect, HttpOnly SameSite=Strict cookie, token stripped; bad cookie rejected; cookie + foreign Origin rejected |

Total: **36 tests in 8 files** (`playwright test --list`).

### Bench and screenshots

- `e2e/bench/bench.ts` (`pnpm --filter @octopus-diff/fixtures bench`, alias of the e2e `bench` script):
  generates 30 × 3, runs the daemon as a **child process** (`e2e/bench/daemon-child.mjs`), measures startup,
  first paint cold/warm until `data-ready="true"`, idle CPU over 60 s with the UI open (`/proc`, incl. git
  children), and refresh latency (append to a tracked file → SSE `worktree.changed`, and → the sidebar item's
  `data-additions` changes, measured in-page with rAF polling), 15 iterations. Writes `docs/bench/results.json`
  and `docs/bench/results.md` with PASS/FAIL against PLAN §8.10 targets. Flags: `--repos --worktrees
  --idle-seconds --iterations --out --no-ui --seed`.
- `e2e/scripts/screenshots.ts` (`pnpm --filter @octopus-diff/fixtures screenshots`): inbox, diff split,
  diff unified (and help if present), light and dark, into `docs/screenshots/*-{light,dark}.png`.

## Verification

Run on this branch (Node 26.13.0, git 2.53.0, WSL2):

- `pnpm lint` → exit 0, `Checked 91 files … No fixes applied.`
- `pnpm typecheck` → exit 0, all 7 packages `Done`.
- `pnpm test` → exit 0. contracts 57, git-core 1, daemon 1, web 1, cli 1, **fixtures 48** (4 files, ~8 s),
  **e2e 5** (helper unit tests): **114 passed, 0 failed**.
- `pnpm build` → exit 0, all packages `Done`.
- `pnpm exec playwright test --list` (in `e2e/`) → `Total: 36 tests in 8 files`.
- `pnpm test:e2e` → **fails fast, as expected on this branch**, in global setup (about 2 s wall clock, exit 1) with:
  `octopus-diff e2e cannot run: @octopus-diff/daemon is still the Phase 0 placeholder (startDaemon threw
  "daemon is a placeholder until WS2 lands") … ...and: apps/web/dist looks like the Phase 0 placeholder UI`.
  Fixtures are cleaned up. None of the 36 specs has run against a real daemon/UI yet.
- `pnpm --filter @octopus-diff/fixtures bench -- --repos 2 --worktrees 2 --idle-seconds 1 --iterations 1`
  → fails clearly (`daemon failed to start: daemon is a placeholder … (merge WS2 and run pnpm build)`), cleans up.
- `pnpm --filter @octopus-diff/fixtures screenshots` → fails clearly on the placeholder UI.
- Fixtures CLI: `generate` (13 repos, 16 worktree entries, 864 ms), `simulate` (4 actions, 0 errors),
  refusal to simulate in a control repo, `cleanup`, and refusal to delete `/home`: all checked by hand.

## Decisions

Logged in `docs/DECISIONS.md` under "WS4". The main ones:
- Repo roles (control / mutable / bench / source); expectations come from a read-only git oracle.
- **Porcelain `git diff` rewrites `.git/index` even with `--no-optional-locks`** (git 2.53); only plumbing
  is safe for working-tree scopes. Stat-dirty bait in every control worktree makes the proof catch it.
- Strict proof (any event in a control git dir is a violation); copy↔added equivalence; untracked files
  optional in `unstaged`; counts = porcelain v2 XY semantics; no ahead/behind assertion for detached HEAD.
- Daemon per test, in-process, serial; restart drops startup registration to prove persistence.
- Commit scope checked through the API only; live budget 1500 ms (`OCTOPUS_E2E_LIVE_BUDGET_MS`).
- Bench/screenshots in `e2e/` (avoids a fixtures→daemon dependency cycle), with aliases in fixtures.

## Contract changes

None.

## Known gaps

- **The e2e specs, bench and screenshot script have never run against a real daemon or UI** (placeholders
  on this branch). Expect a round of selector and timing adjustments at integration, mostly in
  `e2e/support/app.ts`. Specific assumptions about WS3's UI that may need adapting:
  - every changed file has a rendered `file-item` (if `@pierre/trees` collapses directories or virtualizes
    long lists, `openFile` has to expand / scroll first);
  - `scope-select` is a native `<select>` or a listbox whose options are named after the scope kind;
  - the add-project / add-scan-root inputs are visible in the empty state, or after clicking
    `add-project-button`;
  - `show-reviewed-toggle` off hides reviewed files from the file list; `only-unreviewed-toggle` hides
    worktrees whose files are all reviewed;
  - the diff text is reachable from the light DOM or an *open* shadow root (Playwright pierces open ones);
  - Escape closes the help dialog and leaves the filter input;
  - the theme follows `prefers-color-scheme` (screenshots only).
- Assumptions about WS1/WS2 that the specs encode (from contracts/DECISIONS, but unverified): 404 for
  `getDiff` of an unchanged path; `tooLarge` for the 4 MiB file at the default 1 MiB soft limit;
  `byteLength` set when too large; short commit shas accepted; `scanRootId` set only for scan-found
  projects; `lastScannedAt` set after a scan; counts semantics as in Decisions #6.
- The subcommand allowlist (§8.8) is not exercised by e2e; it is WS1's unit tests' job.
- CLI-based registration (`octopus-diff add`) is not covered by e2e (WS5's command semantics weren't
  available); UI and API registration are.
- The bench has no results yet (`docs/bench/` is created on the first run); same for `docs/screenshots/`.
- macOS/Windows: the proof and simulator are POSIX-oriented (symlinks, non-UTF-8 names); `sampleProcessCpu`
  reports `supported: false` off Linux.

## Notes for integration

1. **WS1 must not use porcelain `git diff` for `working` / `unstaged`** (see DECISIONS WS4 #3): it takes
   `index.lock` and rewrites the index on stat-dirty entries despite `--no-optional-locks`. Use `diff-files`
   / `diff-index` (and filter raw entries that have no numstat / patch, or take the file list from
   `git status`). The e2e proof will fail loudly otherwise. Every control fixture has stat-dirty bait.
2. Merge after WS1–WS3, then run from the repo root:
   ```sh
   pnpm install && pnpm build
   pnpm test:e2e                                    # 36 specs + read-only proof in global teardown
   pnpm --filter @octopus-diff/fixtures bench       # ~2 min; writes docs/bench/results.{json,md}
   pnpm --filter @octopus-diff/fixtures screenshots # writes docs/screenshots/*.png
   ```
   Useful env: `OCTOPUS_E2E_KEEP_FIXTURES=1` (keep the temp repos), `OCTOPUS_E2E_DAEMON_LOG=debug`,
   `OCTOPUS_E2E_LIVE_BUDGET_MS=3000` (slow CI), `OCTOPUS_E2E_SEED=<n>`, `OCTOPUS_E2E_SKIP_UI_CHECK=1`.
   Failure artifacts: `e2e/playwright-report/`, traces in `e2e/test-results/`, proof report in
   `e2e/test-results/readonly-proof.json`.
3. `e2e/package.json` gained `@octopus-diff/daemon: workspace:*` (devDependency) and `bench` / `screenshots`
   scripts; `tools/fixtures/package.json` gained a `bin`, and `fixtures` / `bench` / `screenshots` scripts.
   The lockfile change is just that one importer entry.
4. Root config I didn't touch but recommend: add `esbuild: false` to `allowBuilds` in
   `pnpm-workspace.yaml` (`pnpm install` exits 1 with `ERR_PNPM_IGNORED_BUILDS` today; BLOCKERS WS4 #2).
   Optionally add root scripts `"bench": "pnpm --filter @octopus-diff/fixtures bench"` and
   `"screenshots": "pnpm --filter @octopus-diff/fixtures screenshots"`. CI (WS5) should run
   `pnpm build` before `pnpm test:e2e`.
5. Other streams can reuse the fixtures in their own tests: `generateFixtures()` + `manifest` +
   `set.env.vars` (pass as `GitCoreOptions.env`), and `startReadOnlyProof()` around any git-core test.
