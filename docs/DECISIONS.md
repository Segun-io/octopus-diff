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

All 2026-11-08 · WS3.

1. **File list: own virtualized list by default; `@pierre/trees` as an optional "Tree view".** The
   flat list (`apps/web/src/components/FileList.tsx`) carries every `TEST_IDS` attribute, groups the
   Inbox by project → worktree (`file-group` containers always rendered, rows windowed), and backs
   `j`/`k`. `@pierre/trees` renders rows inside a shadow root (our `data-testid`/data attributes can't be
   put on its rows), has no notion of multi-repo groups, and is a beta, so it is isolated in
   `FileTreeView.tsx`, lazy-loaded, and only offered for a single worktree (toolbar "Tree view", persisted).
   Swappable/removable without touching anything else. PLAN §4.2 asked for trees; §9 allowed this fallback.
2. **Inbox is always fetched with `onlyUnreviewed=false`**; "show reviewed" and "only unreviewed" filter
   client-side, so toggles are instant and `n` keeps the position of reviewed files.
3. **Scope is global UI state.** `commit` is only offered while a worktree is selected (picker fed by
   `/api/worktrees/:id/commits`, defaults to HEAD); going to the Inbox resets `commit` to `working`.
   While in `commit` scope the inbox/sidebar badges use `working`, and `n` stays inside the commit's files.
   `branch` uses each project's default branch (no base picker in the MVP).
4. **Sidebar filters (text / only dirty / only unreviewed) also filter the Inbox groups**; `n` ignores
   them ("anywhere") and, if its target is hidden by a filter, opens that worktree. The text filter matches
   project name, branch and worktree path.
5. **Selection preservation rules:** keep the selected file while it exists (even if hidden by "show
   reviewed" or a sidebar filter); if it disappears (reverted), select the visible file at the same index;
   on a view change, select the first file. `j`/`k` step from the selection's position even when it is
   hidden. Moving to another worktree view keeps the selection when the file is in that view.
6. **Collapsed regions expand through the API's `context` param** ("More context" / `e` = +20 lines,
   "Expand all" = `context=1000000`), not @pierre/diffs' in-place expansion, which needs full file
   contents the API does not return. @pierre/diffs still shows "N unmodified lines" separators.
7. **Extra shortcuts** beyond PLAN §4.2: `w` whitespace, `h` show/hide reviewed, `e` more context, `t`
   theme, `Space`/`Shift+Space` and `d`/`u` scroll the diff (keyboard-only scrolling), `Esc` closes/clears.
   All are listed in the `?` dialog and never fire while typing in an input/select/textarea.
8. **Live updates:** native same-origin `EventSource` (cookie auth, `withCredentials`), a listener per
   `SERVER_EVENT_TYPES` name; events are batched for 60 ms; `worktree.changed` whose `stateHash` equals
   the cached summary's is ignored; a second `hello` (reconnect) invalidates everything;
   `review.changed` patches caches without refetching. Falls back to the contract client's fetch-based
   `subscribe` when `EventSource` is missing.
9. **Review toggle** sends the list entry's `patchHash` (what the user sees) with an optimistic update of
   every cached inbox/files/diff entry for that `(projectId, scopeKind, path, patchHash)`, rolled back on
   error; queries that were already in flight are re-invalidated after success.
10. **Truncated patches** (`truncated: true`) are cut mid-hunk by the daemon; the UI rewrites the last
    hunk header to the lines actually present before parsing (`repairTruncatedPatch`), avoiding parser
    errors.
11. **Highlighting stays off the main thread:** one shared `WorkerPoolManager` (pool size = cores/2,
    clamped 2–4, idle-terminated after 30 s), adapted from T3 Code's MIT `DiffWorkerPoolProvider.tsx` with
    attribution. `mainThreadMaxCharacters` is left unset, so every highlight runs in a worker. The diff
    renderer and the tree view are lazy chunks; the first paint loads ~125 KB gz of JS.
12. **Preferences** (split/unified, whitespace, show reviewed, theme, list/tree) persist in localStorage
    key `octopus-diff:prefs`. Theme defaults to `system` (`prefers-color-scheme`); the toggle sets an
    explicit light/dark. "Show reviewed" defaults to on.
13. **Mock server instead of MSW:** `apps/web/mock/` is a deterministic in-memory backend + fetch-style
    router (inputs validated with the contract schemas) + a 127.0.0.1 Node server with SSE and a change
    simulator; tests use the same router as a custom `fetch`. It is never imported from `src/`, so it
    cannot reach the production bundle. Mock-only route: `POST /api/__mock/mutate`. Added devDependencies
    to `@octopus-diff/web`: `diff` (BSD-3, patch generation) and `@playwright/test` (same version as
    `e2e/`, for the browser/perf scripts in `apps/web/scripts/`).
14. **CSP the daemon can send** (verified in Chromium against the production build, no violations):
    `default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline';
    img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none';
    frame-ancestors 'none'`. `style-src 'unsafe-inline'` is required (React style attributes and
    @pierre/diffs' injected styles); without it Chromium blocks them.

## WS4 — fixtures, e2e, perf

(none yet)

## WS5 — CLI, packaging, docs, CI

(none yet)

## Phase 2 — integration (lead)

(none yet)
