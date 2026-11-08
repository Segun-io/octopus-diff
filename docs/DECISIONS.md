# Decisions log

Newest last. Format: date · who · decision · reason. Contract changes are marked **[contracts]**.

## Phase 0 (lead, 2026-11-08)

1. **Toolchain verified:** Node 26.13.0, pnpm 12.16.1 (pinned via `packageManager`), git 2.53.0.
   `engines.node` is `>=24` per PLAN §2.
2. **Lint/format: Biome 2.6** (one tool for both, mature, fast). PLAN §5.1 allowed oxlint+oxfmt or Biome.
   Markdown and the tool-managed `pnpm-workspace.yaml` are excluded from Biome so prose and pnpm's own
   rewrites don't fight the formatter.
3. **TypeScript 7.0 (native compiler)**, the current `latest`. It typechecks and emits the whole repo
   fine. Reversible: if a stream hits a TS 7 gap, pin `typescript@6` at the root and log it here.
4. **Workspace resolution via a custom export condition** `@octopus-diff/source` → `src/*.ts`, used by
   typecheck, vitest and Vite; `tsconfig.build.json` clears it so `tsc` builds against dependencies'
   `dist/`. Reason: no prebuild needed for typecheck/tests in parallel worktrees, while the built CLI
   still runs on plain Node from `dist/`. Vitest needs the condition in both `resolve` and
   `ssr.resolve` (the Node test environment uses Vite's SSR resolver).
5. **Packages:** `@octopus-diff/{contracts,git-core,daemon,web,fixtures,e2e}` and the CLI package
   `octopus-diff` (so `npx octopus-diff` works later). All are `private: true` until Phase 3 (publishing
   needs the user).
6. **LICENSE** copyright holder is "octopus-diff contributors" (no name was given; avoids guessing).
7. **Default port 7428**, host `127.0.0.1` (`DEFAULT_PORT` / `DEFAULT_HOST` in contracts).
8. **[contracts] IDs** are the first 16 lowercase hex chars of SHA-256 over the realpath (common git dir
   for projects, worktree root for worktrees, scan-root dir for scan roots). git-core computes
   project/worktree ids; the daemon computes scan-root ids the same way.
9. **[contracts] List responses are wrapped in objects** (`{ projects }`, `{ files }`, `{ entries }`,
   `{ commits }`, `{ scanRoots }`) instead of bare arrays as drafted in PLAN §5.4, so fields can be added
   without breaking clients.
10. **[contracts] Additions to the §5.3 data model:**
    - `Project`: `bare`, `defaultBranchOverride` (effective `defaultBranch` = override ?? detected),
      `scanRootId`. git-core returns `GitProjectInfo` (no app state, has `detectedDefaultBranch`).
    - `Worktree`: `bare`; `headSha` is nullable (unborn branch).
    - `WorktreeSummary`: `projectId`, `headSha`, `detached`, `changedFiles`, `inProgress`
      (merge/rebase/…), and `aheadBehindRef`. **`ahead`/`behind` are nullable**: measured against the
      upstream if there is one, else against the project's default branch (agent worktree branches rarely
      have an upstream), else null. Local refs only, never fetched.
    - `ChangedFile`: `rawPath` (base64 of raw bytes, only for non-UTF-8 paths), `oldMode`/`newMode` (to
      show symlinks 120000 and submodules 160000). `GitChangedFile` = `ChangedFile` without `reviewed`.
    - `FileDiff`: per-file `patch` plus `tooLarge` (omitted above the soft limit; `full=true` overrides),
      `truncated` (cut at the hard cap), `byteLength`.
11. **[contracts] Diff options** on `GET /api/worktrees/:id/diff`: `ignoreWhitespace` (git `-w`, for the
    hide-whitespace toggle), `context` (`-U<n>`, for expanding collapsed regions), `full`. Invariant:
    `patchHash` is always computed from the canonical patch (whitespace-sensitive, default context), so
    review marks don't depend on view options.
12. **[contracts] Extra routes:** `PATCH /api/projects/:id` (default-branch override; app state only),
    `POST /api/scan-roots/:id/rescan`, `POST /api/worktrees/:id/refresh` (manual refresh),
    `PUT /api/focus` (tells the daemon which worktree is focused for the 30 s vs 5 min poll cadence of
    PLAN §5.6). None of these write to repositories.
13. **[contracts] Review request** uses `scopeKind` (the §5.7 key is `(projectId, scopeKind, path,
    patchHash)`) rather than a full scope; `rawPath` replaces `path` in the key when present.
14. **[contracts] Extra SSE events:** `hello` (on connect), `project.updated`, `review.changed` (keeps
    several tabs in sync). Events are named SSE events (`event:` = `type`) with JSON `data` that includes
    `type`; the daemon sends a `: ping` comment every ≤ 15 s. `formatSseEvent` / `SseParser` in contracts
    are the shared codec. Unknown event types are ignored by clients (forward compatible).
15. **[contracts] Ref and path validation in the contract layer:** `RefNameSchema` rejects leading `-`,
    revision syntax and anything `git check-ref-format` rejects; `RepoPathSchema` rejects absolute
    paths, `.`/`..` segments and NUL. This blocks option injection and traversal before git-core, which
    still uses `--end-of-options`/`--` and literal pathspecs.
16. **Auth design for WS2** (PLAN §5.4): per-install token in `<stateDir>/token` (0600). Accepted as
    `Authorization: Bearer`, as the `octopus_diff_token` cookie (HttpOnly, SameSite=Strict), or once as
    `?token=` on a page load, after which the daemon sets the cookie and redirects to strip it. `Host` must
    be a loopback name/address (plus `allowedHosts`) and `Origin`, when present, must match the daemon's
    own origin. `/api/health` is the only unauthenticated route.
17. **`StartDaemon` / `DaemonHandle`** (in contracts) are the seam between the CLI (WS5) and the daemon
    (WS2); `GitCore` / `CreateGitCore` are the seam between the daemon and git-core (WS1). Placeholders
    in `packages/git-core` and `apps/daemon` implement the shapes so dependents compile from day one;
    the git-core placeholder exports `GIT_CORE_IMPLEMENTED = false` and rejects with `not_implemented`.
18. **pnpm build scripts:** `@parcel/watcher`'s install script is denied (`allowBuilds: false`): it only
    compiles from source when `npm_config_build_from_source=true`; the prebuilt
    `@parcel/watcher-linux-x64-glibc` binary is used. Verified the module loads.
19. **Chromium system libraries without sudo:** Playwright's Chromium needs libnss3, libnspr4 and
    libasound2, which are not installed and can't be (no sudo). I downloaded the signed Ubuntu packages
    with `apt-get download` (no root) and extracted them to `~/.cache/octopus-diff-dev/chromium-libs/`;
    `e2e/playwright.config.ts` adds that directory to `LD_LIBRARY_PATH` when it exists. Treated as part of
    package installation; fully reversible (delete the directory). Proper fix in `docs/BLOCKERS.md`.
    The Chromium binaries themselves were installed once with `playwright install chromium` so all
    worktrees share `~/.cache/ms-playwright`.
20. **Lockfile conflicts** between parallel streams are expected; the lead resolves them at merge time by
    taking the merged `package.json` files and re-running `pnpm install`.
21. **Pre-installed dependencies** to reduce lockfile churn across streams: daemon (`hono`,
    `@hono/node-server`, `@parcel/watcher`), web (`react`, `react-dom`, `@tanstack/react-query`,
    `@pierre/diffs`, `@pierre/trees@1.0.0-beta.6`, `vite`, `@vitejs/plugin-react`, `tailwindcss`,
    `@tailwindcss/vite`, `jsdom`, Testing Library), e2e (`@playwright/test`), root (`typescript`,
    `@biomejs/biome`, `vitest`, `@types/node`, `tsx`). `@pierre/trees` pulls `@pierre/theming@1.0.0`, whose
    peer `@pierre/theme@^1.1.0` is unmet (2.0.0 installed via `@pierre/diffs`); harmless so far, WS3 to
    watch.
22. **[contracts] `TEST_IDS`** (`packages/contracts/src/test-ids.ts`): stable `data-testid` values and
    data attributes shared by the web UI (WS3) and Playwright (WS4), so both can be built in parallel
    without guessing each other's selectors. The UI also gets a minimal add-project / add-scan-root form
    (needed for the empty state); PLAN §4.2 does not list one, but a first-run user would otherwise have
    no way in except the CLI.
23. **Per-stream sections** below (and in `BLOCKERS.md`): each stream writes only under its own heading,
    so five branches appending to the same file merge without conflicts.

## WS1 — git-core

(none yet)

## WS2 — daemon

(none yet)

## WS3 — web

(none yet)

## WS4 — fixtures, e2e, perf

All 2026-11-08 · WS4.

1. **Fixture roles.** Every generated repo has a role: `control` (never modified after generation;
   the read-only proof snapshots it), `mutable` (the `live` project: e2e specs and the agent simulator
   edit it), `bench`, and `source` (origins, submodule source, bare seed; never registered). Reason:
   the proof needs repos nothing is allowed to touch, while live-update/review tests need repos that
   change.
2. **Expectations come from a read-only git oracle** (`tools/fixtures/src/oracle.ts`) run at generation
   time under the isolated config, plus what the generator did (special-case paths, markers). Unit tests
   cross-check the two. Reason: hand-computing numstat for CRLF/minified/submodule cases is error-prone,
   and git itself is the ground truth git-core must match.
3. **Finding for WS1: porcelain `git diff` writes `.git/index` even with `--no-optional-locks`.** On
   git 2.53, `git diff`, `git diff HEAD` and `git diff -- <path>` (anything comparing against the working
   tree) call `refresh_index_quietly()`, take `index.lock` and rewrite the index whenever an entry is
   stat-dirty, regardless of `--no-optional-locks` / `GIT_OPTIONAL_LOCKS=0`. `git status` honors the flag;
   plumbing `diff-files` / `diff-index` / `diff-tree` never write. So git-core must use the plumbing
   commands (all on the §5.5 allowlist) for `working` / `unstaged` scopes. Caveat: plumbing `--raw` lists
   stat-dirty but content-identical files as modified (null blob sha); `--numstat` / `-p` omit them, and so
   does `git status`. The oracle drops raw entries with no numstat line. A unit test
   (`readonly-proof.test.ts`) pins this git behavior, and every control worktree gets **stat-dirty bait**
   (one tracked file with an old mtime and unchanged content) so the e2e proof catches any index refresh.
4. **Read-only proof is strict:** any filesystem event inside a control repo's git dir is a violation, not
   just `*.lock` files (read-only git produces none). Detection = snapshot diff (size, mtime ns, inode,
   mode, ctime of every file under the common dir, incl. `worktrees/*` and `modules/*`, plus each linked
   worktree's `.git` file, plus `git status --porcelain=v2` per worktree) + one non-recursive `fs.watch`
   per directory (except `objects/`, which is still in the snapshot) + a 20 ms poll for `*.lock`.
5. **Copy detection:** the oracle runs without `-C`, so a staged copy is `added` there; e2e accepts
   `copied` from git-core for such a file. **`unstaged` scope:** whether untracked files appear is
   git-core's choice; e2e requires the tracked set to match exactly and tolerates extra untracked entries.
6. **Counts semantics** asserted by e2e = porcelain v2 `XY`: `staged` = entries with X ≠ `.`, `unstaged` =
   Y ≠ `.` (an `MM` file counts in both), `untracked` = `?`, `conflicted` = `u` entries only.
   `changedFiles` = distinct paths in the working scope. Ahead/behind is **not asserted for detached
   worktrees** (the contract leaves it open); `aheadBehindRef` is matched as a ref-name suffix.
   Expected default branch of the unborn `empty` repo is `null` (no branch ref exists yet).
7. **e2e daemon per test, in-process** (`startDaemon` in the Playwright worker; fresh state/config dir
   under the fixture root, port 0, random token, `webRoot = apps/web/dist`, `git.env` = the isolated git
   vars). Specs run serially in one worker because they share the mutable project. `restart()` reuses the
   port when free and passes no startup `projects` / `scanRoots`, so persistence after restart is proven
   from the daemon's store.
8. **Commit scope is covered at the API level only.** `TEST_IDS` has no commit-picker id, and adding one
   now would not reach WS3 in time; the UI specs cover working / staged / unstaged / branch via
   `scope-select` (native `<select>` or a listbox with `option` roles).
9. **Live-update budget = 1500 ms** (PLAN §8.5), overridable with `OCTOPUS_E2E_LIVE_BUDGET_MS` for slow CI.
   Within the budget the file item's counts must change and the open diff must show the new text *or*
   the `diff-updated-banner`; then the new text must be reachable (clicking the banner if needed).
10. **Auth status codes:** a rejected foreign `Origin` may be 401/403/421, a foreign `Host` also 400; a
    missing/wrong token must be exactly 401 with `error.code = unauthorized`. The token-on-page-load flow
    must redirect, set an `HttpOnly; SameSite=Strict` cookie and strip the token from `Location`.
11. **Bench and screenshot scripts live in `e2e/`** (they need Playwright and the daemon);
    `pnpm --filter @octopus-diff/fixtures bench|screenshots` are aliases. Reason: a `fixtures → daemon`
    dependency would create a cycle if the daemon's tests use the fixtures package. The bench runs the
    daemon as a child process (`e2e/bench/daemon-child.mjs`, plain JS on the built `dist/`) so
    `/proc/<pid>/stat` measures only the daemon; idle CPU includes reaped git children (`cutime`/`cstime`)
    and is measured with the UI open on the inbox.
12. **Preflight:** e2e global setup checks the package builds, sniffs the web bundle for TEST_IDS hooks
    (`data-ready`, `worktree-item`; skip with `OCTOPUS_E2E_SKIP_UI_CHECK=1`), and smoke-starts the daemon
    and registers one fixture; all problems are reported together in one message.
13. **Screenshots use `prefers-color-scheme` emulation** for light/dark (assumes the UI follows the system
    theme by default in a fresh browser profile).
14. **Fixture determinism:** fixed commit clock (2026-01-01 + 1 min per commit), seeded content, and a
    relative submodule URL (an absolute temp path in `.gitmodules` changed every sha). Same seed → same
    shas (unit-tested).

## WS5 — CLI, packaging, docs, CI

(none yet)

## Phase 2 — integration (lead)

(none yet)
