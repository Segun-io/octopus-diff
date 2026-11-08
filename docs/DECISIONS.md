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

(none yet)

## WS5 — CLI, packaging, docs, CI

All 2026-11-08 · WS5.

1. **Argument parsing with `node:util` `parseArgs`** (no dependency), `strict: true`,
   `allowNegative: true` for `--no-open` / `--no-watch`. Numbers are validated by hand (`--port`
   0–65535, `--depth` 0–`SCAN_DEPTH_MAX`).
2. **No command, or a leading option, means `serve`**, so `npx octopus-diff` and
   `octopus-diff --port 9000` just start (PLAN §5.1 lists `npx octopus-diff` as the entry point).
3. **Exit codes:** 0 ok, 1 runtime failure (daemon not running, port in use, a doctor check failed),
   2 bad command line or invalid config file.
4. **Extra commands beyond PLAN §6:** `status` (is a daemon running, health, re-print the tokenized
   URL, `--open`) and `config` (`--path`, `--schema` prints the JSON Schema). Both are read-only and
   small; `status` answers "what was the URL again?" without restarting.
5. **Config file** `$XDG_CONFIG_HOME/octopus-diff/config.json`: zod `strictObject` (unknown keys are
   errors, so typos don't silently do nothing; reversible by switching to a warning), relative paths
   resolve against the file's directory, `~` is expanded, `$schema` is allowed. Keys: `host`, `port`,
   `allowNonLoopback`, `allowedHosts`, `open`, `projects`, `scanRoots` (string or `{path, depth}`),
   `scanDepth`, `watch` (mirrors `WatchOptions`), `git` (a subset of `GitCoreOptions`), `logLevel`,
   `stateDir`, `webRoot`. **Merge:** scalar flags win; list flags (`--scan`, project paths,
   `--allowed-host`) are *added* to the config lists (registration is idempotent and additive anyway).
6. **The CLI always passes explicit `stateDir` and `configDir`** to `startDaemon`, computed with the
   same XDG rules the daemon defaults to (relative `XDG_*` values are ignored, per the spec), so
   `add` / `status` / `doctor` know where the token is. Precedence for the state dir:
   `--state-dir` > config `stateDir` > `$XDG_STATE_HOME/octopus-diff`.
7. **Runtime file `<stateDir>/daemon.json`** (pid, url, host, port, version, startedAt), written by
   `serve` after the daemon starts (atomic rename, mode 0600, no secrets) and removed on shutdown if it
   still has our pid. `add` / `status` / `doctor` use it to find a daemon on a non-default port
   (`--port 0`). Stale files are ignored (`kill(pid, 0)` plus `/api/health`). Lookup order for clients:
   `--url` > runtime file (unless `--host`/`--port` are given) > host/port from flags/config.
8. **One daemon per state dir:** if `serve` finds a live daemon for the same state dir, it prints that
   daemon's tokenized URL (opening it with `--open`) and exits 0 instead of starting a second one that
   would share the SQLite store and token.
9. **`add` without a running daemon fails** (exit 1) with "no octopus-diff daemon is running at …;
   start one with `octopus-diff serve`". No offline fallback: the registry lives in the daemon's
   store, and writing to `config.json` instead would create a second source of truth. Paths are
   resolved to absolute paths in the CLI (the daemon's cwd is unrelated) and checked to be
   directories before they are sent. The token is read from `<stateDir>/token` (DECISIONS #16).
10. **Non-loopback hosts are refused in the CLI too** (exit 2) unless `--allow-non-loopback` /
    `allowNonLoopback`, before the daemon is started (defense in depth; the daemon also checks).
11. **Web assets:** the CLI build (`tsc && node scripts/copy-web-assets.mjs`) copies `apps/web/dist`
    into `apps/cli/dist/web`; `@octopus-diff/web` is a devDependency of the CLI so `pnpm -r build`
    builds the web app first. At runtime: `--web-root` / config `webRoot` (must contain
    `index.html`, else exit 2) > `apps/web/dist` **only if** `../web/package.json` is
    `@octopus-diff/web` (workspace; picks up a web-only rebuild) > `<cli>/dist/web`. If nothing is
    found, `serve` warns and runs API-only (`webRoot: null`) rather than refusing.
12. **Opening the browser:** macOS `open`; Windows `rundll32 url.dll,FileProtocolHandler`; Linux
    `xdg-open`; WSL `wslview` → `powershell.exe -EncodedCommand` (`Start-Process '<url>'`, base64
    UTF-16LE, so no Windows quoting applies) → `xdg-open`. Only `http(s)` URLs made of URL-safe
    characters are opened; spawned detached with an argv array, never a shell. Failure to open is a
    warning, not an error. Tests inject the opener and never open a browser.
13. **`doctor`:** checks Node (≥ 24), git, platform/WSL, inotify (Linux), config file, state dir and
    token permissions, port, web assets. Exit 1 only on `fail`; warnings don't fail. **Minimum git
    `MIN_GIT_VERSION = 2.25.0` (provisional)**: the first release after `--end-of-options` (2.24),
    shipped by Ubuntu 20.04; WS1 owns the real minimum, keep `apps/cli/src/commands/doctor.ts` and
    README in sync with it. doctor runs only `git --version` (execFile, argv array, cwd = OS temp dir),
    not through git-core: it never touches a repository and git-core is still a placeholder.
    inotify: warn below `max_user_watches` 524 288 / `max_user_instances` 512, with a sysctl fix that
    never lowers a value and a WSL note; token file with group/other bits → fail (`chmod 600`); state
    dir with group/other bits → warn.
14. **Shutdown:** SIGINT/SIGTERM/SIGHUP handlers are registered *before* `startDaemon`, then
    `handle.close()` with a 10 s timeout (timeout or error → exit 1); a second signal exits 130
    immediately. The bin sets `process.exitCode` and arms an unref'd 2 s `process.exit` fallback in
    case a stray handle keeps the loop alive (so stdout still flushes normally).
15. **Logger:** the CLI passes a logfmt-style stderr `Logger` (filtered by `--log-level`) plus
    `logLevel` to the daemon.
16. **Self-contained tarball (stretch):** `pnpm --filter octopus-diff run pack:tarball` bundles the CLI
    with esbuild (new devDependency, already in the tree via tsx/vite), resolving workspace packages
    from sources through the `@octopus-diff/source` condition; only the native `@parcel/watcher` stays
    a real dependency. Copies the web build to `dist/web`, writes a minimal `package.json`, and runs
    `npm pack` (local file only) into `apps/cli/.pack/` (ignored by `apps/cli/.gitignore`). Not part of
    `pnpm build`. Never published; `private: true` stays on the workspace package.
17. **CI** (`.github/workflows/ci.yml`, never pushed): jobs `check` (Node 24 and 26: install, lint,
    typecheck, test, build, CLI `--version` + `doctor` smoke), `e2e` (Node 26,
    `playwright install --with-deps chromium`, report uploaded on failure) and `package` (tarball
    installed into an empty dir and run). Action majors current on 2026-11-08: `actions/checkout@v7`,
    `actions/setup-node@v7`, `pnpm/action-setup@v6`, `actions/upload-artifact@v7`. Installs use
    `--frozen-lockfile --config.strict-dep-builds=false` because of the esbuild build-script issue in
    BLOCKERS (WS5 #1). Validated locally with `@action-validator/cli` and actionlint 2.0.6 (wasm build
    from npm): no issues.
18. **Tests against the real daemon skip themselves** (`ctx.skip()`) while `startDaemon` throws the
    placeholder error, so they start running automatically once WS2 is merged; no manual un-skip.
    Everything else uses an injected fake `startDaemon`, fake fetch, or a tiny `node:http` stub
    daemon on an ephemeral loopback port.

## Phase 2 — integration (lead)

(none yet)
