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

All 2026-11-08, WS1. Details and rationale also in `docs/reports/git-core.md`.

1. **Minimum git 2.31.0.** Below it every method except `version()` rejects with
   `git_unsupported` (`version().features.supported` is false). 2.31 gives everything git-core
   needs without fallbacks: `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` (used for filter neutralization,
   see 3), `rev-parse --path-format=absolute`, `config --show-scope` (2.26), `--no-relative`
   (2.28). `worktree list -z` (2.36) is feature-detected. Only git 2.53.0 was available for
   testing. WS5: please put "git >= 2.31" in the README.
2. **Allowlist detail for `config`:** read forms `--get`, `--get-all` and `--get-regexp` (with
   `--null`, `--show-scope`, scope and type flags; no `--file`/`--blob`). PLAN §5.5 said
   `config --get`; `--get-regexp` is needed to enumerate filter drivers (3). Still read-only.
   `symbolic-ref` is allowed only with one ref argument (read form); `worktree` only as `list`.
   Options that write or execute (`--output`, `--ext-diff`, `--textconv`, `--filters`,
   `--show-signature`, `--exec`, `--upload-pack`, `--color*`) are rejected before `--`.
3. **Repo-local filter drivers are neutralized.** `filter.<d>.clean/smudge/process` run programs
   whenever git reads worktree files (status, diff), and committed `.gitattributes` decide where
   they apply. Once per GitCore operation that runs `status`/`diff`, git-core reads `git config
   --show-scope --get-regexp ^filter\.`; a driver key whose effective value comes from
   `local`/`worktree` scope is reset to the system/global value if one exists (so git-lfs keeps
   working), else emptied with `filter.<d>.required=false`. Passed via `GIT_CONFIG_COUNT`
   because driver names may contain `=` (which breaks `-c`). Not cached across operations:
   included files and `includeIf "onbranch:"` can change what applies (a 60 s cache was found
   exploitable in review). Consequence of trusting global drivers: git-lfs's clean filter may
   write objects into `.git/lfs/objects` when status/diff re-read a modified LFS file, as plain
   `git status` would; strict mode (neutralize every driver) would make LFS/git-crypt files show
   as modified whenever their stat data changes.
4. **`diff.autoRefreshIndex=false` is pinned.** Found by the read-only proof test: porcelain
   `git diff` with stat-dirty files calls `refresh_index_quietly()`, which takes `index.lock`
   and rewrites the index *even with* `--no-optional-locks` / `GIT_OPTIONAL_LOCKS=0`. With it
   off, stat-only files show up as raw `M` entries without numstat or patch; git-core drops them.
5. **Copy detection only in scopes that don't read the worktree** (staged, branch, commit).
   With autoRefreshIndex off, stat-dirty unchanged files count as "modified" and would become
   copy sources, so working/unstaged results would depend on stat state, not content. Working
   and unstaged use rename detection only (a copy shows as `added` there).
6. **Submodules: `--ignore-submodules=dirty` everywhere.** A submodule is reported only when its
   checked-out commit differs from the recorded gitlink (patch: `Subproject commit` lines).
   Uncommitted changes *inside* a submodule are not reported (cheap, and the parent diff
   could not show them anyway; add the submodule as its own project to see them).
7. **patchHash** = first 40 hex of SHA-256 over the canonical per-file chunk exactly as git prints
   it with pinned options (`--full-index`, `a/`/`b/` prefixes, `-U3`, Myers, indent heuristic,
   no inter-hunk context, `core.quotePath=false`, `--submodule=short`). Full object ids make it
   independent of abbreviation length. A typechange hashes both chunks. Unmerged paths hash the
   `diff --cc` chunk (unstaged) or the `* Unmerged path` chunk (staged). Untracked files hash
   (mode, raw path, SHA-256 of content), not git's text; beyond `maxUntrackedFiles` or the read
   limit, (mode, path, stat signature).
8. **stateHash** = 32 hex of SHA-256 over the raw `status --porcelain=v2 --branch` output (HEAD,
   branch, upstream, ahead/behind, HEAD/index object ids per entry), the numstat output, the
   ahead/behind ref and its object id, the in-progress operation, and the lstat signature (size,
   mtime ns, ctime ns, inode, mode) of every file with worktree changes and every untracked
   file. Touching a clean file does not change it; re-modifying a modified file does.
9. **Untracked diffs** use `git diff --no-index /dev/null <path>` (exact git output, honors
   attributes); paths that are not valid UTF-8 cannot be passed as argv, so their new-file patch
   is synthesized in Node (identical to git's for plain files; ignores `.gitattributes`). Nested
   repositories (`dir/` in status) are listed as untracked with `newMode: 160000` and an empty
   patch.
10. **Default branch detection:** `refs/remotes/origin/HEAD` → `<b>` when a local branch `<b>`
    exists, else `origin/<b>`; then local `main`, `master`, `trunk`; else null.
11. **ahead/behind:** the upstream when `status` reports `branch.ab` (upstream configured and
    present); otherwise (no upstream, or upstream gone) the default branch via `rev-list
    --left-right --count`, unless it is the current branch. Detached HEAD is compared with the
    default branch.
12. **getFileDiff sizes:** `tooLarge`/`truncated` apply to the returned patch (which may be the
    `-w`/`-U<n>` view); `byteLength` is the canonical patch size. Binary files return `patch: ''`
    (as the contract says). `truncated` cuts at a line boundary at `maxOutputBytes`.
13. **Branch scope** = committed changes only (`merge-base(HEAD, base)` tree vs HEAD tree).
    Unborn HEAD → `[]`; missing base → `not_found`; no base given or detected →
    `invalid_argument`; unrelated histories → `not_found`. **Commit scope** diffs merge commits
    against their first parent; root commits against the empty tree. Not cached: tree diffs
    still read the worktree's `.gitattributes` (binary, diff drivers), which differ per worktree.
14. **Environment:** `GIT_*` variables from the daemon's own environment are dropped except
    `GIT_CONFIG_GLOBAL/SYSTEM/NOSYSTEM` and `GIT_EXEC_PATH` (a daemon started from a git hook would
    otherwise inherit `GIT_DIR`). Redirecting/executing variables (`GIT_DIR`, `GIT_EXTERNAL_DIFF`,
    `GIT_TRACE*`, `GIT_SSH*`, ...) are removed even from `GitCoreOptions.env`. Added:
    `GIT_LITERAL_PATHSPECS=1`, `GIT_NO_LAZY_FETCH=1`, `GIT_ALLOW_PROTOCOL=none` (no transport at
    all, so a partial clone on git < 2.44 fails instead of fetching), `GIT_ADVICE=0`.
15. **Process control:** on POSIX git runs in its own process group and timeouts/dispose kill
    the group, settling immediately (a grandchild holding the pipe cannot hang a request).
16. **scan** reports every directory containing `.git` (dir or file: linked worktrees and
    submodules too; the daemon dedupes by project id) plus bare git dirs (HEAD + objects/ +
    refs/), descends into repositories (never into `.git`), follows symlinked directories with
    realpath de-duplication (no loops), caps at 100 000 directories. No git processes.
17. **Bare repositories:** the bare worktree entry gets a summary with HEAD/branch and zero
    counts; working/staged/unstaged return `[]`; branch and commit scopes work.
18. **Worktree locator paths** may also be a subdirectory: git-core resolves the toplevel with
    `rev-parse --show-prefix` (one call, cached 30 s per path).
19. **`core.bigFileThreshold` is pinned to `max(maxOutputBytes, 1 MiB)`** (64 MiB by default):
    git diffs larger files as binary (header with full object ids + "Binary files differ"), so
    no single file's patch can exceed about twice that while it is streamed and hashed.
    Streaming runs (patch hashing) do not apply `maxOutputBytes` to the *total* output: a big
    refactor may legitimately produce hundreds of MiB across files; they are bounded by
    `timeoutMs`, and retained text is capped per file. Untracked files above the threshold are
    listed as binary too, and untracked contents are hashed by streaming (O(1 MiB) memory).
20. **The git executable is resolved to an absolute path** using only absolute `PATH` entries
    (Windows: `.exe`/`.com`). Spawning a bare `git` lets the OS resolve relative `PATH` entries
    against the child's working directory (the repository), so a planted `./git` could run.
21. **Split-index repositories are a documented exception to "no writes":** git bumps the mtime
    of `.git/sharedindex.<sha>` on every index read (`freshen_shared_index`), and nothing on
    the command line turns that off. Content, `index`, refs and locks stay untouched; a test pins
    exactly this boundary.
22. **An independent review** of `src/` (fresh agent, code only) found 11 issues, 10 confirmed;
    all fixed with regression tests (decisions 3, 13, 19, 20 changed as a result; also:
    getFileDiff falls back to the whole scope when a narrowed pathspec changes rename pairing,
    touched-but-unchanged binary files are stat-only, `scan` rejects when `onProgress` throws,
    commit dates are clamped to 4-digit years, unmerged paths containing newlines, rename
    sources get `staged`, untracked symlinks are synthesized).

## WS2 — daemon

All 2026-11-08 · WS2. No contract changes were needed.

1. **Every route except `/api/health` requires the token, including static UI files** (DECISIONS
   #16 taken literally; the UI build has no secrets, but one rule is easier to audit). An
   unauthenticated HTML page load gets a small 401 page explaining how to sign in; everything
   else gets a JSON `ApiErrorBody` 401 with `WWW-Authenticate: Bearer`. `?token=` is honored only
   on non-API `GET`/`HEAD` page loads (never on `/api/*`, so tokens don't end up in API URLs);
   a valid one sets the cookie and 302-redirects to the same path and query minus `token`
   (leading slashes collapsed so the redirect can never point to another host).
2. **Auth cookie:** `octopus_diff_token`, `HttpOnly; SameSite=Strict; Path=/; Max-Age=34560000`
   (400 days, the browser maximum; a session cookie would force re-login after every browser
   restart). No `Secure` flag: the daemon speaks plain HTTP on loopback. Cookies are not
   port-scoped, so two daemons on the same host name with different state dirs overwrite each
   other's cookie (re-open the tokenized URL).
3. **Token format:** generated tokens are 32 random bytes, base64url (43 chars). Explicit tokens
   must be 16–512 chars of `[A-Za-z0-9._~-]` (cookie- and header-safe). Comparison hashes both
   sides with SHA-256 and uses `timingSafeEqual`. An invalid `<stateDir>/token` is replaced;
   loose permissions on the token (0600) or the state dir (0700) are tightened with a warning.
4. **Host policy (DNS rebinding):** accepted are loopback names/addresses (`localhost`,
   127.0.0.0/8, `::1`, IPv4-mapped loopback) **with the bound port**; the bound address itself
   (non-loopback binds); for wildcard binds (`0.0.0.0`/`::`) the IP literals of local interfaces
   (IP literals cannot be rebound); and `allowedHosts` entries, where `name` matches any port
   (reverse proxies) and `name:port` only that port. Host values with userinfo, paths, etc. are
   rejected. **Origin**, when present, must be exactly `http://<Host>` (or `https://<Host>` for a
   TLS-terminating proxy); `Origin: null` is rejected. Additionally `Sec-Fetch-Site: cross-site`
   is rejected on `/api/*`. No CORS headers are ever sent (preflights fail with 403).
5. **Security headers** on every response: `X-Content-Type-Options: nosniff`,
   `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy` and
   `Cross-Origin-Resource-Policy: same-origin`; `Cache-Control: no-store` on the API. CSP for the
   UI: `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'
   'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self';
   worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self';
   frame-ancestors 'none'` (wasm for Shiki/oniguruma, inline styles for React/highlighting,
   blob workers for the highlighter pool). API responses get `default-src 'none'`. Inline
   `<script>` in `index.html` is **not** allowed (WS3: keep scripts in files).
6. **Error mapping:** `GitCoreError` → (`code`, status): `not_a_repository` → 422,
   `not_found` → 404, `invalid_argument` → `bad_request` 400, `timeout` → 504,
   `output_too_large` → `too_large` 413, `git_failed`/`git_not_found`/`git_unsupported` →
   `git_error` 500, `command_not_allowed` → `internal` 500, `aborted`/`disposed` → `internal`
   503, `not_implemented` → `internal` 501. `details` carries `gitCode`, `exitCode` and the first
   2 KB of stderr. Validation failures are `bad_request` 400 with `details.issues`; a non-JSON
   `Content-Type` on a body route is 415; bodies are capped at 1 MiB (413). Malformed ids in
   path params are 400, unknown ids 404. A path that does not exist is `not_found` 404.
7. **Success statuses:** `POST /api/projects` and `POST /api/scan-roots` return 201 when created
   and 200 when the call was a no-op; `POST /api/scan-roots/:id/rescan` returns 202 (scan runs
   in the background). Everything else returns 200.
8. **SSE:** event ids are `<bootId>.<seq>` (bootId random per daemon start), so a
   `Last-Event-ID` from a previous run is never confused with the current one. The last 1000
   events are buffered for replay. `hello` is always sent first and carries no id (clients
   should refetch on every `hello`). Heartbeat `: ping` every 15 s. A client whose queue exceeds
   2000 frames is disconnected (it reconnects with `Last-Event-ID`).
9. **`worktree.changed` semantics:** emitted on the first computed summary of a worktree and on
   every later `stateHash` change. When a summary fails or a worktree/project goes missing,
   the event carries a synthetic hash (`error:<code>` / `missing`) so clients refetch and show
   the error. Expect a burst of these right after startup (WS3: coalesce refetches).
10. **List endpoints wait (bounded) for first summaries:** `GET /api/projects`, `GET /api/inbox`,
    `POST /api/projects` and `PATCH /api/projects/:id` wait up to 2.5 s for not-yet-computed
    summaries, then return `summary: null` for the rest (a `worktree.changed` follows).
    Startup registrations from `StartDaemonOptions.projects` do not wait.
11. **Storage (`node:sqlite`):** `<stateDir>/octopus-diff.db`, WAL, migrations via
    `PRAGMA user_version` (a newer schema is refused). Tables: `projects` (incl.
    `default_branch_override`, `scan_root_id`, `added_at`, and `worktrees_json`, the last known
    worktrees so the registry is usable before git answers and vanished paths can be reported),
    `scan_roots`, `scan_exclusions`, and `reviewed(project_id, scope_kind, path, raw, patch_hash,
    reviewed_at, last_seen_at)`. `path` holds `rawPath ?? path` and `raw` tells them apart (a
    UTF-8 path can never collide with a base64 raw path). `last_seen_at` is refreshed (at most
    daily) whenever a mark matches a listed file; GC runs at startup and every 24 h and deletes
    marks unseen for 30 days and marks of unregistered projects. Removing a project deletes its
    marks immediately.
12. **`node:sqlite` ExperimentalWarning:** Node 26 (dev machine) prints none; Node 22–24 print one
    on first load. The store loads `node:sqlite` lazily while a scoped `process.emitWarning`
    filter drops only `ExperimentalWarning`s that mention SQLite; all other warnings pass.
13. **Directories:** XDG layout on every platform (`$XDG_STATE_HOME`/`$XDG_CONFIG_HOME` when
    absolute, else `~/.local/state` / `~/.config`), plus `octopus-diff`. The state dir is created
    0700. The daemon reports `configDir` but never creates or writes it (the config file belongs
    to the CLI, WS5).
14. **Registry rules:** adding is idempotent; adding a project explicitly that a scan root had
    discovered detaches it from the scan root (`scanRootId: null`). **Removing a scan root also
    removes the projects it discovered** (explicit projects stay). Removing a scan-discovered
    project records a per-scan-root exclusion so rescans don't bring it back; adding it
    explicitly clears the exclusion. Rescans only add projects. Stored scan roots are rescanned
    in the background at startup. Re-adding an existing scan root updates its depth and rescans.
    The scan uses git-core's own ignores (`watch.ignore` is not applied to scanning).
15. **Startup reconciliation:** stored projects are served immediately from the cached worktree
    list and re-resolved in the background. A project whose common dir vanished (or now resolves
    to a different id) is **kept and reported**: its worktrees get `missing: true`,
    `summary: null`, `error.code = not_found`, and `project.updated` is emitted; it is retried
    every 60 s and restored automatically when it comes back.
16. **Bare entries** (bare repos, or the bare "main" of a bare+worktrees setup) get no summary
    (`summary: null`, `error: null`) and never appear in the inbox.
17. **Caching:** file lists are cached per (worktree, scope) and keyed by the summary's
    `stateHash` for `working`/`staged`/`unstaged` (the contract says it changes whenever any
    file's patch changes), by sha for `commit`; `branch` is never cached (its base can move
    without the worktree changing). Summaries are single-flight per worktree with one coalesced
    follow-up run. Review flags are attached at response time, so marking never invalidates a
    cache. The inbox prefilters with summary counts (`working`: changedFiles; `staged`:
    staged+conflicted; `unstaged`: unstaged+untracked+conflicted) and queries every worktree
    for `branch`/`commit`; per-worktree failures are skipped.
18. **Watcher layout:** one `@parcel/watcher` subscription per worktree root (ignoring `.git`,
    `node_modules`, common build/cache dirs at any depth, `watch.ignore`, and nested worktree
    roots known at subscribe time) and one per project on the common git dir (ignoring
    `objects`, `logs`, `hooks`, `lfs`, `modules`, `rr-cache`, `info`, `fsmonitor--daemon`,
    `worktrees/*/logs`; `*.lock` events are dropped). Git-dir events are routed with
    `GitCore.getWatchTargets`: a linked worktree's own git dir → that worktree; `refs/`,
    `packed-refs` → every worktree; other matching `gitPaths` → their worktree; top-level files
    and `rebase-*`/`sequencer` → the main worktree; `worktrees/<name>` creation/removal (or
    `gitdir`/`locked` changes) → re-list worktrees. Working-tree events inside a nested worktree
    root are attributed to the deepest root (Claude Code's `.claude/worktrees/*`). Changes to
    files inside ignored build dirs are picked up by polling only.
19. **Watcher timing:** debounce 200 ms (clamped to 150–300 per PLAN §5.6) with a 1 s max wait
    during continuous bursts. Poll cadence: natively watched worktrees 30 s focused / 5 min
    others; degraded worktrees (native watching failed, or on `/mnt/*` under WSL where Windows-
    side edits produce no inotify events) 5 s focused / 30 s others. Focusing a worktree
    refreshes it immediately. Worktree lists are re-read every 60 s and on git-dir changes.
    `watch.enabled: false` and `forcePolling` both poll with the degraded cadence and report
    mode `disabled` / `polling`.
20. **Watcher degradation:** inotify `ENOSPC` (watch limit), `EMFILE` (instances), permission and
    missing-path failures switch the affected worktrees to polling, log one warning per kind
    (with paths), and surface path-free warnings (with the current sysctl value and the fix) in
    `/api/health` (`watcher.mode` = `native` | `mixed` | `polling` | `disabled`). `/api/health`
    is unauthenticated, so its warnings never contain paths.
21. **`startDaemon`** returns a `Daemon` (a superset of `DaemonHandle`: also `app`, `core`, `hub`,
    `store`, `logger`) and accepts `internal` knobs for tests/benchmarks (heartbeat, relist and
    wait intervals, an injectable watcher `subscribe`, a clock). It refuses non-loopback hosts
    without `allowNonLoopback`, rejects invalid ports, and turns `EADDRINUSE` into a clear
    message. For wildcard binds the reported `url` uses `127.0.0.1`.
22. **`close()`** stops the core (watchers, timers, scans), ends SSE streams, closes the server
    (idle connections at once, the rest after a 200 ms grace), disposes git-core **only if the
    daemon created it** (an injected `gitCore` belongs to the caller), then closes SQLite.
    Idempotent.
23. **HTTP adapter:** `@hono/node-server`'s `getRequestListener` with
    `overrideGlobalObjects: false`, so embedding the daemon in the CLI does not replace the
    process-wide `Request`/`Response`. Because node-server's `bodyLimit` middleware needs those
    overrides, the daemon reads JSON bodies itself with the 1 MiB cap.
24. **Logging:** JSON lines on stderr (`{"time","level","msg",...}`), or the injected `Logger`;
    both are filtered by `logLevel` and redacted (the token value anywhere, and any field whose
    name looks like token/authorization/cookie/password/secret). Requests are logged at `debug`
    with the path only (never the query string). The auth URL is never logged.
25. **`PUT /api/focus`** accepts unknown worktree ids (a UI can race a removal); they are ignored.
26. **`webRoot`** without an `index.html` (e.g. web not built) logs a warning and serves the API
    only, instead of failing startup. Static paths are decoded per segment; `.`/`..`/NUL/
    backslash segments are refused; realpaths must stay inside the webRoot realpath (no symlink
    escape). Missing paths without an extension (or requests accepting HTML) fall back to
    `index.html`; missing `/assets/*` or files with an extension are 404. Hashed `/assets/*` are
    cached `private, max-age=31536000, immutable`; everything else `no-cache`.

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

1. **2026-11-08 · `esbuild` build script denied** (`allowBuilds: esbuild: false`). `tsx` (root dev dep)
   pulls `esbuild`, whose postinstall only validates/optimizes the binary; the prebuilt
   `@esbuild/linux-x64` package is used. Without the entry, pnpm 12 exits 1 on `pnpm install` even though
   the install completes (reported by WS5). Verified: `pnpm install` exits 0 and `tsx` runs.
2. **2026-11-08 · Merge order and seams.** Merged `ws/git-core`, `ws/daemon`, `ws/web`,
   `ws/fixtures-e2e`, `ws/cli` with `--no-ff`, no textual conflicts (ownership held; the lockfile
   auto-merged and `pnpm install` confirmed it). Seam fixes: the CLI's `doctor` now imports
   `MIN_GIT_VERSION` from git-core (2.31; it had a provisional 2.25 copy) and README/CONTRIBUTING say
   git ≥ 2.31; CI and CONTRIBUTING no longer need `--config.strict-dep-builds=false`; `pnpm check` and CI
   build **before** testing so the CLI's built-bin integration test runs instead of skipping; the e2e
   inbox spec collects rows by scrolling the virtualized file list (`AppPage.allFileItems`) instead of
   expecting every row in the DOM at once (UI behavior was correct).
3. **2026-11-08 · git `diff` rewrites the index despite `--no-optional-locks`** (found by WS4,
   reproduced by the lead on git 2.53 with a touched-but-unchanged file; `status`, `diff-files`,
   `diff-index` don't). WS1 independently caught it with its proof test and pins
   `diff.autoRefreshIndex=false` and filters stat-only entries; the e2e proof (control fixtures contain
   touched-but-unchanged files) passes with 0 violations.
4. **2026-11-08 · LAN exposure on the dev machine, at the user's request.** A long-running instance
   (`serve --host 0.0.0.0 --allow-non-loopback --allowed-host odino`, default state dir, this repo
   registered) listens on port 7428. WSL uses mirrored networking with the Hyper-V firewall, whose
   default inbound action is Block, so the lead added (via an elevated PowerShell the user approved
   through UAC) the Hyper-V rule `octopus-diff-7428`: inbound TCP 7428 from private ranges
   (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`; first limited to `10.0.60.0/24`, which missed devices
   on other VLANs).
   Revert: `Remove-NetFirewallHyperVRule -Name octopus-diff-7428` (elevated). The token is still
   required; traffic is plain HTTP on the LAN. Found while doing it: the CLI prints a `127.0.0.1` URL
   for wildcard binds; it should list the LAN addresses (follow-up).
   Diagnosis with `pktmon`: no packet from another LAN device reached the NIC during the user's test
   (blocked upstream of this PC, or the device was on another network); the only SYNs came from
   Windows itself to its own LAN IP, which mirrored mode does not loop into WSL unless
   `hostAddressLoopback=true` is set in `.wslconfig` (needs `wsl --shutdown`; not done). Windows
   `localhost` resolves to `::1`, which mirrored mode does not forward into WSL, so `127.0.0.1` is the
   reliable local URL. The instance now binds `::` (dual-stack). Follow-ups for the CLI: print the
   loopback **and** LAN URLs for wildcard binds, and consider binding `::` for `--host 0.0.0.0`.
5. **2026-11-08 · [contracts] Auth v2: no ambient browser credentials** (security review SEC-01,
   SEC-02, SEC-11, SEC-12). Cookies are scoped to the host, not the port, so the 400-day cookie that
   held the permanent token was sent to every server on `127.0.0.1` (confirmed in Chromium).
   New model, pinned in `packages/contracts/src/common.ts`:
   - Every API request (including SSE, via the contract client's fetch-based `subscribe`) carries
     `Authorization: Bearer <token>`. The web app keeps the token in `localStorage['octopus-diff.token']`
     (origin-scoped, port included). `localStorage` rather than `sessionStorage` so new tabs work;
     the CSP and the XSS review make script access acceptable.
   - The printed URL is `<url>/#token=<token>`; the fragment never reaches servers, logs or `Referer`.
     A page load with `?token=` (old URLs) redirects to `/#token=`.
   - Static UI assets are served without auth (`Host` checks still apply); this reverses WS2's
     "static files need the token" decision, which existed only because of the cookie.
   - The daemon stops setting and accepting the cookie and expires a stale one if a browser sends it.
   - `GET /api/health?challenge=<hex>` returns `proof = HMAC-SHA256(token, "octopus-diff-health:v1:" +
     challenge)`; the CLI verifies the proof before sending the token or printing/opening the URL.
   Contract changes are additive (`AUTH_FRAGMENT_PARAM`, `TOKEN_STORAGE_KEY`, `HEALTH_CHALLENGE_PARAM`,
   `healthProofMessage`, `HealthQuerySchema`, optional `HealthResponse.proof`, `client.health({challenge})`);
   `AUTH_COOKIE_NAME` stays exported (deprecated).
6. **2026-11-08 · Coordination with the UX round 1 orchestrator** (a second lead thread the user
   started; see `docs/COORDINATION.md` on `lead/ux-foundation`). That thread now owns the root checkout
   (`/home/santosa/angelsantosa/octopus-diff`, branch `lead/ux-foundation`); the Phase 2 lead works in
   its own worktree (`~/.t3/worktrees/octopus-diff/lead-phase2`, branch `lead/phase2`) and moves `main`
   only by fast-forward (`git fetch . lead/phase2:main`, which git refuses while `main` is checked out
   elsewhere). Done for that plan: **step 1, `review/perf` is merged to `main` (`945c4ec`)**, all
   prototypes P1–P8 accepted (P3 leading-edge refresh and P8 UI CSP on worker scripts reviewed and
   accepted; their proposals are below). Ownership of the review findings, matching COORDINATION.md:
   - Phase 2 lead, on branches from `945c4ec`: `fix/git-core` (F3 stateHash, F4, F7, F8, SEC-06,
     SEC-07 worktree validation, SEC-08), `fix/daemon-watch` (F1, F3 watching, F5, F6, SEC-07 watch
     cap), `fix/auth-v2` (SEC-01/02/10/11/12 end to end: daemon auth, web token bootstrap and SSE,
     CLI incl. SEC-03/04/09, e2e auth specs, README security model).
   - UX round (web UI it is rewriting): F2 (claimed by ux-web), F9 (false "updated" banner on scope
     switch: key `seen` by file + scope), F10 (tree view order), SEC-05 (warn on bidi control chars in
     diffs and file names). The auth-v2 web change is limited to token bootstrap, the API client's
     token and the SSE subscription (`main.tsx`, `api/hooks.ts`).
7. **2026-11-08 · Auth v2 implementation choices** (`fix/auth-v2`, details in
   `docs/reports/fix-auth-v2.md`): auth is router-matched `/api` middleware, health registered before
   it, so routes added later are protected by construction; paths with escaped unreserved characters
   (`/%61pi`) get 400 (SEC-10); a wrong `?token=` gets 401, a right one redirects to `/#token=`; the
   legacy cookie is expired on any response; a token file readable by others or owned by another uid
   is replaced atomically (SEC-11); the web client stops the event stream on 401 instead of retrying;
   `--open` uses a 0600 launcher file (deleted after 60 s) and, on WSL, PowerShell reading the URL from
   stdin (`wslview` dropped), with openers resolved to absolute paths and run with a sanitized `PATH`
   (SEC-03/04); CLI output escapes control and bidi characters as `\uXXXX` (SEC-09); `serve` refuses
   when the recorded daemon fails the proof; `token --rotate` needs a daemon restart; LAN URLs are
   printed for wildcard binds (IPv4 for `0.0.0.0`, IPv4+IPv6 for `::`, no link-local).
8. **2026-11-08 · git-core fix choices** (`fix/git-core`, details in `docs/reports/fix-git-core.md`):
   `--git-dir`/`--work-tree` pinned after discovery, `core.worktree` honored only when its target links
   back (absorbed submodules), else the main entry is reported bare (SEC-06); linked worktrees must link
   both ways or are `prunable` + `missing`, duplicates dropped (SEC-07); scan follows symlinks only
   within the root's realpath (SEC-08); the submodule HEAD is read from disk into the `stateHash`
   (git 2.53's raw line for a modified gitlink has a null oid, so "hash `--raw`" did not work) and
   submodule git dirs join `gitPaths` (F3); untracked `patchHash` = hash of the canonical new-file
   patch, identical after `git add -N` / `git add` unless adding converts content (F4);
   `maxUntrackedFiles` is all-or-nothing per snapshot; `check-attr` allowlisted and cached, skipped
   when no attributes file exists (F8; cold summary +~100 ms only in repos with attributes); unreadable
   files degrade per file (F7); `stateHash` version bumped (all hashes change once after upgrade;
   review marks on untracked files show unreviewed once); metadata reads use `O_NONBLOCK` and require
   regular files.
9. **2026-11-08 · Proposal, not implemented: port-bound health proof** (residual SEC-02 relay: a
   squatter could forward the CLI's challenge to the real daemon on another port and replay its
   proof). Bind the proof to the port, e.g. message `octopus-diff-health:v2:<port>:<challenge>` as a new
   optional `proofV2` field, the CLI checking it when `apiVersion` allows. Needs a contract change;
   deferred to Phase 3.
10. **2026-11-08 · Daemon watcher fix choices** (`fix/daemon-watch`, details in
    `docs/reports/fix-daemon-watch.md`): only the build-output names `dist`, `build`, `out`, `target`,
    `coverage` follow git's ignore rules (approximated daemon-side from rules naming them, erring towards
    watching; nested `.gitignore` rules filter events; a tracked file seen in any file list un-ignores its
    build dir) (F5); worktree root identity is `dev:ino` and the git dir is re-read from the `.git` entry
    when a path may have been recycled, stale targets falling back to "route every git-dir event" (F1);
    nested repositories of another project refresh their enclosing worktree, and a worktree root equal to
    its common dir is watched like a bare entry (F3); `info/` is watched and refreshes every worktree
    (F6); the SEC-07 limits above. Cost: startup +~27 ms to listening at 30×3 (measured A/B). The SEC-07
    health test raced the main worktree's subscription under load and was fixed at merge (product
    behavior correct).
11. **2026-11-08 · Review findings status.** Fixed: F1, F3, F4, F5, F6, F7, F8, F11, SEC-01, SEC-02,
    SEC-03, SEC-04, SEC-06, SEC-07, SEC-08, SEC-09, SEC-10, SEC-11, SEC-12. Handed to the UX round (web UI
    it is rewriting): F2, F9, F10, SEC-05. Residual: the SEC-02 relay (proposal #9).

## Phase 2 — performance review (`review/perf`, proposals for the lead)

Prototype commits on `review/perf`; nothing here is merged until the lead decides. Evidence and
numbers: `docs/reports/review-perf.md`.

1. **2026-11-08 · Leading-edge refresh (deviates from PLAN §5.6 "debounce 150–300 ms").** The
   200 ms trailing debounce was 93 % of write → `worktree.changed` latency. Proposal: a worktree
   with no pending refresh and none fired in the last `debounceMs` refreshes on its first event;
   later events in that window use the existing trailing debounce and 1 s max wait, so bursts still
   coalesce (at most one extra summary per burst). `DaemonCore` turns it on by default
   (`internal.leadingEdge: false` restores the old behavior); `WatcherService` defaults to off.
   Trade-off: a refresh can observe the first half of a multi-step write (e.g. a commit) and the UI
   shows that intermediate state for ~200 ms until the trailing refresh. Measured: SSE p50
   216 → 13 ms.
2. **2026-11-08 · Timer jitter.** Relist (60 s) and fallback-poll (30 s / 5 min) timers get ±25 %
   jitter; `pollIntervalFor()` still reports the nominal value. All timers were armed at startup and
   fired in the same second (worst idle second 108 % CPU at t = 300 s with 30 × 3).
3. **2026-11-08 · The web client patches the inbox per worktree.** For batches of
   `worktree.changed` events touching ≤ 8 worktrees, the UI rebuilds those inbox entries from
   `GET /worktrees/:id/files` + the projects list instead of refetching `/api/inbox`; anything else
   (added/removed/updated projects or worktrees, scans, reconnects, failures, stateHash mismatch)
   still refetches the whole inbox. This duplicates `DaemonCore.inbox()`'s entry rules on the
   client; a contract-level delta (summary in `worktree.changed`, or `/inbox?worktreeIds=`) would
   be more robust and is recommended instead if the lead prefers.
4. **2026-11-08 · Scripts are served with the UI CSP** (seam bug, WS2/WS3). The daemon sent the API
   policy (`default-src 'none'`) on every non-HTML response; a dedicated worker runs under its own
   script's CSP, so the highlight workers could not import their Shiki chunk, the pool failed, and
   all highlighting ran on the main thread (1.8 s long task for a 10 000-line diff). JS assets now
   get `UI_CSP`. Flagged for the security review.

## UX round 1 — identity, theming-ready, review controls (lead)

All 2026-11-08 · lead. Brief, ownership and merge plan: `docs/COORDINATION.md`.

1. **Two parallel streams split by layer, not by feature.** `ux-web` owns all of `apps/web` (one owner keeps the visual
   language coherent: tokens, themes, shell, settings, review UI), `ux-daemon` owns the daemon side. The seam is the
   contracts commit `642a116` (`contracts:`), frozen for the round; the pure resolver in the contracts is the single
   implementation of the policy precedence so daemon and web mock cannot drift.
2. **[contracts] Review policy is an inheritance chain with one default** — worktree > branch > project > folder (scan
   root) > default. "Review ON by default for new repos/worktrees/branches" *is* the default level: new things have no
   override, so they inherit it. Rejected: per-kind "defaults for new items" stamped at discovery (hidden state, surprising
   when the global default changes, needs a "first seen" notion). Branch overrides are keyed by (project, branch name) so
   they survive agents deleting and recreating worktrees for the same branch. Disabled worktrees stay listed and diffable
   (diff first) but leave `onlyUnreviewed`, `n`, badges and bulk actions.
3. **[contracts] Bulk review is resolved on the server** with an optional `expectedStateHashes` guard and a single-use,
   in-memory undo token. Rejected: the client sending every `patchHash` (6000 files = megabytes, and the F2 class of
   bug: marking a patch the user has not seen). Undo is cheap because marks are app state, not repository state.
   `onlyUnreviewed` now also omits review-disabled worktrees (a refinement; identical while nothing is disabled).
4. **Settings split.** Shared and behavioural (review default + overrides) live in the daemon (SQLite migration v2, SSE
   `settings.changed` with a persisted revision). Per-device presentation (theme, density, layout, display prefs) stays in
   the browser's versioned `localStorage` prefs. The Settings screen labels each. Rejected for now: syncing UI prefs through
   the daemon (no account model; revisit with the desktop shell).
5. **Themes are prepared, not built.** Token names from one source, themes as data with a diff-viewer theme mapping, a
   registry, `data-theme` + the existing `.dark` class, prefs `{ mode, light, dark }`, an external pre-paint script (the CSP
   forbids inline scripts), an AA contrast unit test over every registered theme. Ship two brand themes plus at most one.
6. **"Read-only capabilities for a whole folder" is prepared as IA only.** A Folder tier (scan roots) and a per-node view
   registry in the web shell; `docs/design/FOLDERS.md` records the vision and the daemon security prerequisites (registered
   roots only, realpath containment, caps, no writes). No daemon endpoints now; this does not change the read-only guarantee
   in PLAN §1/§5.5.
7. **Coordination with in-flight work.** `review/perf` is still running (touches `api/cache.ts`, `api/hooks.ts`,
   `daemon/{app,core,daemon,watcher}.ts`): the streams may touch those files only with minimal `wire:` commits. Auth v2
   implementation, F1/F3–F8 and the SEC items stay unassigned and reserved; F2 (review toggle keyed on the displayed diff) is
   claimed by `ux-web` because it rewrites that path. Decisions of the streams go into their reports and are folded into this
   file at integration, to avoid append conflicts between branches.

### UX round 1 — daemon stream (`ux/daemon`, folded in by the lead)

All 2026-11-08 · ux-daemon, accepted by the lead after re-running `pnpm check` (exit 0) and `pnpm test:e2e`
(48 passed, read-only proof 0 violations) on the merge with `main`. Full text: `docs/reports/ux-daemon.md`.

8. **Storage.** `settings` is a key/value table of JSON documents (`app`, `revision`), merged with the defaults on
   read (a corrupt document falls back to defaults, never blocks startup); `review_overrides` is keyed by the contracts'
   `reviewTargetKey` and carries owner columns (project/scan root ids) only so one statement can clean up on removal.
   Migration v2. Precedence is never re-implemented: the daemon calls the contracts' resolver over a cached key map.
9. **Revision and events.** The revision moves only on a real change (same-value PATCH/PUT, removing a missing override: no
   bump, no event). `settings.changed` goes to everyone including the caller. `review.bulk` is sent only when `changed > 0`
   (after undo, `restored > 0`). Contract comments updated to say so (comment-only change).
10. **Bulk semantics.** Stale is checked twice (when the target resolves and again after file lists arrive), so a worktree that
    changes mid-call is `stale` and nothing in it is marked. `skippedDisabled` lists only disabled worktrees that had changes in
    the scope; bare/missing/prunable/no-summary worktrees are ignored silently. `changed` counts mark rows per project. Bulk
    waits (bounded 2.5 s) for first summaries like the list endpoints. One SQLite transaction; reuses the inbox's cached
    per-worktree file lists, never one git process per file.
11. **Undo.** Single-use random token, memory only, TTL and size cap from the contracts. Marks the call created are removed only
    if still carrying the call's timestamp; marks it removed are restored only if no mark exists now; restored marks get fresh
    timestamps. Cleanup of overrides on project/scan-root removal runs in the settings layer (it owns the revision bump).
12. **Routes are optional dependencies of `createApp`**: without them the five routes 404 like an older daemon, which is how
    degradation is tested. Measured (30 repos x 3 worktrees, 360 changed files): `GET /api/projects` 2.4 -> 2.6 ms, `GET
    /api/inbox` warm 4.0 -> 4.2 ms, bulk `all` cold 493 ms / warm 2.7 ms; 18,090 changed files: bulk cold 1486 ms (equal to
    the inbox's own cold aggregation), warm 51 ms.

### UX round 1 — web stream (`ux/web`, folded in by the lead)

All 2026-11-08 · ux-web, accepted by the lead after merging with `main` and the daemon stream (`pnpm check` exit 0, web 77
tests; full e2e 48 passed). Full text: `docs/reports/ux-web.md`, design docs in `docs/design/` (IDENTITY, THEMING, FOLDERS).

13. **Identity.** Mark = round mantle, five unequal arms, slit eyes (the literal "arms as diff lines" read as a skull at 16 px;
    three directions were rendered and compared). Brand hue **ink violet** (`#5b47d6` light / `#9d90ff` dark) replaces the generic
    blue: furthest from the add/delete/modified/danger hues and keeps a blue component for red-green colour-blind users.
    `faint` text is held to AA too (paths and hints are read, not decoration); an AA contrast unit test over every registered
    theme enforces it. System font stacks only (CSP). No new dependencies (ICO writer, contrast maths, fuzzy matching and the
    context menu are small hand-written modules).
14. **Themes are data.** Compiled at build time by a Vite plugin into the main stylesheet (so the external `public/theme-init.js`
    only sets `data-theme` before first paint; the CSP forbids inline scripts); `.dark` is kept for Tailwind. Prefs v2 in the same
    `octopus-diff:prefs` key with in-place v1 migration; one light slot and one dark slot (`{ mode, light, dark }`); unknown ids and
    kind mismatches fall back to the brand theme of the slot. Shipped: Octopus Dark, Octopus Light, Octopus Contrast.
15. **Review UI choices.** Inbox "mark all" sends per-worktree `paths` requests when any sidebar filter or "show reviewed" is
    active (and several undo tokens are undone together), otherwise one `all` request; confirm-before-bulk defaults on but only
    triggers for more than one worktree (undo always exists); review-off worktrees are dimmed in the Inbox by default
    (`dim | hide | show`). **F2** is fixed by marking the patch on screen (the diff query cache, keyed like the pane's query), with
    the list entry only as the loading fallback.
16. **Shell.** Overview replaces the three-pane layout for folder/project selections; sidebar hierarchy Inbox > Folders > Projects >
    Worktrees with "Added directly"; source chip from path patterns only (no agent integration); the activity pulse derives from
    `summary.updatedAt` plus a 2 s tick (presentation only; needs the daemon to keep bumping `updatedAt` on every state change);
    the sidebar gear is the only `settingsOpenButton`. View registry with `Changes` and `Overview` implemented; Files/History are
    documented extension points in `docs/design/FOLDERS.md`, not UI.
17. **Security/QoL findings handled here.** SEC-05: bidi/invisible characters are escaped as `⟨U+XXXX⟩` in the patch text handed to
    the renderer (not only a banner), file names are escaped, `data-suspicious` marks rows (`patchHash` untouched). F10: pure
    comparator (`compareTreeOrder`) so list, `j`/`k`, `n` and the tree agree. F9: seen/changed tracking keyed by file + scope.
    Added `TEST_IDS.diffUnicodeWarning` to the contracts (additive).
18. **Seam bug found at integration (lead).** `main`'s perf `patchInbox` rebuilt inbox entries without the new `review` field, which
    would have turned review back on for a review-disabled worktree after any live update (an absent field means "enabled").
    Fixed in `api/cache.ts` (carry `review` over from the refetched projects list) with a regression test. Lesson recorded in
    COORDINATION: code that rebuilds API objects by hand must be reviewed whenever a contract gains a field.

### UX round 1 — UI-level e2e (`ux/e2e`, folded in by the lead)

All 2026-11-08 · ux-e2e (continued daemon session), accepted by the lead after merging with `main` (auth v2, git-core and
watcher fixes): `pnpm check` exit 0, `pnpm test:e2e` 68 passed, read-only proof 0 violations. Full text: `docs/reports/ux-e2e.md`.

19. **Overlays close on Escape through one shared `useEscapeToClose` hook** (document-level capture listener while open).
    Found by the first UI run against the real daemon: Escape did nothing in Settings, the policy menu, the bulk confirm and
    the add-project dialog once the focused control was disabled or removed.
20. **zod runs jitless in the browser** (`z.config({ jitless: true })`, configured before the contracts evaluate, with zod
    and its config pinned into one Rollup chunk) because zod's JIT probe tripped the CSP (`script-src 'self'`, no `eval`) on
    every page load. Interim mechanism; the clean home is the contracts package (follow-up below).
21. **Migrated v1 prefs are written back as v2 on load** (they were only migrated in memory).
22. **Warm-reload regression accepted for this round and tracked.** Warm reload first paint 67 ms -> ~178 ms (two runs);
    cold first paint (1018 -> ~950 ms), idle CPU, refresh write->UI (296 -> ~30 ms, from the perf review) and daemon RSS are
    flat or better; initial JS ~145 KB gz (125 KB before). Attributed with a CPU profile to forced synchronous layout in
    `FileList.tsx`'s viewport `useLayoutEffect` on the larger sidebar DOM (folder tier, chips, badges) plus React commit
    work. Candidate fixes: measure the list viewport from the ResizeObserver callback, memoize sidebar rows, render row
    details lazily. Not applied: perf-sensitive virtualized-list code is not patched without its own measurement pass.
    Follow-ups for the contracts: move the jitless call into `packages/contracts` (removes the web's direct zod dependency
    and the chunk pin); add test ids for the sidebar context menu, the bulk confirm dialog, the add-project dialog and the
    Overview bulk/policy buttons.

## UX round 2 — unslop pass on identity and chrome (lead)

All 2026-11-08 · lead, branch `ux/unslop`, on top of `main` at `28fddc8`. Scope: `apps/web`, `docs/design`, brand assets.
Nothing behavioural changed; no contract change. Report: `docs/reports/ux-unslop.md`.

23. **The brand accent is ink, not violet.** `accent`/`focus`/`accentSoft`/`selected` of the two brand themes are now neutral
    (`#1a1d26` on paper, `#e4e7ee` on black; see IDENTITY.md §4). Reason: violet is the default hue of generated UIs and made
    the product look templated; an achromatic frame also keeps the product's own rule ("the diff is the picture, everything
    else is the frame") and is distance-maximal from every semantic hue for every kind of colour vision. The theme test now
    asserts the brand themes stay achromatic; third-party themes may still use a hue. Favicon, mark, wordmark, app icons,
    the favicon-dot data URI and the contact sheet were regenerated. The dark theme's `color-scheme`, canvas and
    `theme-color` are unchanged, so nothing flashes for existing users; a stored v2 preference needs no migration.
24. **No font glyphs as controls.** ☾ ☀ ✕ ⋯ ⚠ and the ● bullet were replaced by a six-icon stroke set in `bits.tsx` (one
    weight, `currentColor`) and a CSS `Dot`. Reason: glyphs render as colour emoji on Windows and at a different weight per
    platform; they are the most visible "assembled, not designed" tell. Arrows inside data (`↑2 ↓1`, `a → b`) stay text.
25. **Project names are no longer upper-cased in the sidebar.** They were set in the tracked upper-case heading style, which
    transforms user data (`iOS` became `IOS`) and made the tree read as three levels of labels. Projects are now base size,
    semibold, normal case; worktrees regular; folders mono (they are paths). Rule added to IDENTITY.md §5.
26. **Overview figures are a definition list, not stat tiles.** The bordered "big number in a card" grid is the dashboard
    cliché; the figures now sit on one line between two hairlines (number over label), with +/− in their semantic colours.
27. **One elevation for overlays.** `Dialog` and the bottom notice used their own border/shadow (`shadow-2xl`, `shadow-lg`);
    both now use `.od-overlay`, so every floating surface has the same background, border and shadow as IDENTITY.md §6 says.
28. **Copy.** "Inbox zero" (cute) → "No dirty worktrees in this scope."; the tree-view tooltip and the Appearance text no
    longer name implementation details (`@pierre/trees`, `src/theme/themes/`); the empty state reads plainly. Theme
    descriptions describe the ink. Everything else kept its voice (IDENTITY.md §7).

## UX round 2, second pass — unslop with the design skills (lead)

All 2026-11-08 · lead, branch `ux/unslop-2`, on top of `main` at `279e80a`. Scope: `apps/web`, `docs/design`. Audited with
the Vercel Web Interface Guidelines, the frontend-design skill and `hallmark audit apps/web` (app scope); nothing
behavioural, no route, contract or `data-testid` changed. Report: `docs/reports/ux-unslop-2.md`. IDENTITY.md §4–§7 updated.

29. **No tracked upper-case labels anywhere.** `.od-heading` (11 px, 600, upper case, 0.04 em) is gone; `.od-label` is the
    same size and weight in sentence case, untracked. Table heads (`.od-th`), the palette's kind column (`Go to`,
    `Command`…), the Settings "Saved on this device" chip and the context-menu headings follow. Reason: Hallmark's gate 67
    and the frontend-design calibration both name the tracked-caps label as the first template tell, and IDENTITY.md
    already said weight is the hierarchy; the caps strip was the loudest element after the diff and the first pass had to
    special-case names inside it (#25). This changes a rule the first pass kept (§5 "for section headings only").
30. **No eyebrow in Overview.** "PROJECT · ~/code" and "FOLDER" above the `h1` are cut (Hallmark 54). The name is the heading;
    the facts (path, base branch, depth, last scan) sit under it as spaced spans. The sidebar selection already says what
    kind of node it is.
31. **Facts are set apart by space, not middle dots; names are pairs set in weight.** Every `A · B` string in rendered UI
    was split: file-pane header, group headers, Overview meta, Settings Folders, palette hints (commas inside a sentence),
    the review chip (`Review on (the default)`), the Settings footer hint, theme cards. The worktree identity
    `project · branch` became a `WorktreeName` pair (project 500, branch `muted`) in the diff header, the palette (`parts`)
    and the overrides table (`describeTarget().parts`). Decision on the Hallmark conflict: the ban holds for facts and for
    three-part strings; **one** middle dot may still join exactly two name parts in plain text that cannot carry weight
    (`title`, `aria-label`, the palette's search string, `policyLabel` → now parentheses). Hallmark's own legal clause
    allows one dot in a byline; its script fires from two. Logged as a rule in IDENTITY.md §5.
32. **State is a word, not a dot.** Removed: the worktree dirty/clean dot, the folder/project `●5` count, the Overview
    `●1` cell, the toolbar connection dot and the review-chip dot; `Dot` left `bits.tsx`. Replacements: dirty worktrees in
    `fg`, clean ones in `muted` with the word `clean`; folders and projects say `5 dirty`; Overview splits "Changes" into
    `With changes`/`Files` and `Lines`; the connection is the word `Live`/`Offline`/`Refreshing…`; the chip says
    `Review off` with the stronger fill it already had. Reason: Hallmark 63 bans decorative status dots, and these were
    colour-only, which IDENTITY.md §4 forbids ("colour is never the only signal"). Kept, deliberately: the activity pulse,
    now a 6 px ink dot with the expanding ring, positioned in the row's padding, shown only in the ten seconds after a
    worktree changed (a live state, which Hallmark allows), static under reduced motion. Side effect: the worktree rows
    lost the dot's indent and sat left of their project; they now indent 28 px under the project name.
33. **One control recipe each, in `@layer components`.** `.od-btn` (+ `-primary`, `-ghost`, `-danger`), `.od-input`,
    `.od-chip`, `.od-pill`, `.od-th`, `.od-label` replace ~20 ad-hoc Tailwind class strings across Toolbar, DiffPane,
    Overview, Settings, forms, toasts and dialogs. Buttons are 24 px with a 6 px radius (`rounded`, 4 px, is gone from
    controls); pressed/checked = `accentSoft` + `lineStrong` instead of the ink border of #23 (an ink outline on a toggle
    was the loudest thing in the toolbar); `:active` exists; disabled primary buttons set fill, ink and cursor, not opacity
    alone (Hallmark 39a). The layer keeps Tailwind utilities winning for the semantic states (`bg-add` on the reviewed
    toggle, `bg-raised` on the review-off chip). Control height stays at the dense 24 px on purpose: PLAN density, the
    Hallmark app range (32–40) is for pages people read, not a list of thirty worktrees; logged, not waived.
34. **Type floor 11 px; chips are one recipe.** Every `text-[10px]`/`text-[10.5px]` (chips, sidebar meta row, table heads,
    palette kind, Settings footer, theme cards, "decides") is now 11 px (Hallmark 75; Vercel legibility). The three chip
    styles (bordered `main`, raised mono source, raised warn in-progress) and the bordered `review off` badge are one
    `.od-chip` (raised, no border); the Inbox count is plain tabular text, not a second pill.
35. **Mono stays for git's material: waived Hallmark 64 on the record.** The sidebar meta row (`↑1 ↓3 S1 M2 +15 −1`),
    paths, branches, hashes and the `base main` button stay mono; `clean`/`error` words in Overview cells moved to the body
    face. Reason: in this tool mono is the material, not a costume, and the figures line up only in mono. Recorded in the
    CSS stamp.
36. **Overlays keep hairline plus shadow (Hallmark F24, answered).** The dark themes lose a shadow against near-black; the
    `lineStrong` hairline is the edge there, and one recipe serves both themes.
37. **Hallmark check stamp in `styles.css`.** Three comment lines at the top of the stylesheet (checked date, inferred genre,
    the fixed gates, the waiver, the dismissal, the answer). Reason: the audit was asked for by name and its gate 20 reads
    the stamp; it is a comment and costs nothing. `rgb()` literals left `:root.dark`: the dark shadow now changes only
    `--od-shadow-alpha`.
38. **Accessibility fixes from the Vercel audit** (file:line in the report): Overview rows get a real button in the first
    cell (keyboard reachable; the row click stays as a pointer convenience); a global `prefers-reduced-motion: reduce` rule
    also stops Tailwind's `transition-*`/`animate-pulse`; `overscroll-behavior: contain` on scroll areas and overlays;
    `::selection` and `caret-color` themed; the filter input's shortcut moved from the placeholder into a `kbd` hint and
    `aria-keyshortcuts`; `name`/`inputmode` on the add-project fields; typographic apostrophes; em dashes in copy and
    tooltips replaced; `1 files` → `1 file`. One web unit test selector changed with the markup (`td` → `td button`); no e2e
    test changed.
39. **Not changed, on purpose.** The wordmark's `-diff` in mono (a wordmark is Hallmark's own exception to 38iii); the
    sidebar's porcelain shorthand (`S1 M2 ?1 !1`: a product vocabulary question, not a design one); "verified" in bulk
    actions versus "reviewed" on the file toggle (the e2e suite pins both; unifying is a WS4 + contracts conversation);
    the dark theme's blue cast; the mark, the palette and the icons (no asset regenerated).

## Folder picker (lead, 2026-11-08)

1. **Add by browsing, not only by typing.** A browser cannot hand a local path to a web page (a file input gives no
   path), so the daemon lists folders itself: new route `GET /api/fs/dirs?path=` (`ROUTES.listDirs`,
   `DirsQuerySchema`, `DirsResponseSchema`, `ApiClient.listDirs`; additive, in its own `contracts:` commit). It returns
   subfolder names of one folder (default: home; `~` expanded, relative paths against the daemon's cwd), the folder's
   realpath, parent, home, separator and starting places (home, the daemon's cwd, root). Capped at
   `DIRS_ENTRIES_MAX` = 2000 with `truncated`.
2. **Read-only, no git.** `apps/daemon/src/fs-browse.ts` uses `readdir` and `lstat` only. Each entry is classified by
   its entries (`repo`: a `.git` directory or a bare layout `HEAD` + `objects/` + `refs/`; `gitfile`: a `.git` file,
   i.e. a linked worktree or a submodule; else `dir`), so no repository config is ever read and no git process runs
   (PLAN §5.5 still holds). File names are never returned. Errors map to `not_found` / `bad_request` (not a folder) /
   `forbidden` (EACCES/EPERM).
3. **Threat model unchanged.** The route sits behind the bearer token like every other route. Listing folder names
   anywhere the daemon user can read is no new exposure, since a token holder can already `POST /api/projects` with
   any path and read the diffs. Noted in the README security section.
4. **Interaction modeled on T3 Code's command-palette browse mode** (pingdotgg/t3code, MIT; ideas reused, one small
   helper adapted with attribution in `apps/web/src/lib/folderPath.ts`): the location text *is* the browser (the part
   up to the last separator is listed, the last segment filters by prefix); hidden folders appear only once the typed
   name starts with `.` (no toggle); `Tab` completes shell-style (one match enters it, several extend to the common
   prefix); a `..` row goes up; `Enter` opens the highlighted row, otherwise it submits, and `Ctrl/Cmd+Enter` always
   submits, with the live shortcut shown on the primary button; Enter/Tab are ignored during IME composition; the next
   listing is fetched before the view switches (a generation counter drops stale navigations, typing wins), and
   listings are kept only 5 s so a reopened picker is fresh. Not taken from T3: creating missing folders (we never
   write) and the desktop app's native folder dialog (browser-only for now; a desktop shell could add it).
5. **octopus-diff specifics on top.** Rows mark repositories and worktrees, `added` / `watched` badges come from the
   projects and scan-roots queries, repository rows have an inline Add, and the status line says what the path is
   ("has 3 repositories directly inside", "is a git repository, already added", "No folder named …"). The primary
   button follows the target: Add repository for a repo or worktree, Watch folder for a plain folder. The add and watch
   buttons are disabled once the listing shows the typed name does not exist; while the listing loads they stay
   enabled and send the raw text (the daemon validates it).
6. **One location field replaces the two path fields.** `AddProjectForm` keeps its name and both submit test ids;
   new test ids `folderPicker`, `folderPickerInput`, `folderPickerEntry`, `folderPickerEntryAdd`, `folderPickerUp`.
   `addProjectPathInput` / `addScanRootPathInput` remain in `TEST_IDS` (contracts are never renamed or removed) but are
   no longer rendered; the e2e specs 01 and 12 and the web tests use `folderPickerInput`. `Dialog` now focuses a
   `[data-autofocus="true"]` element first, so the add dialog opens with the cursor in the location field. The mock
   backend serves the route from a virtual tree (`apps/web/mock/fs.ts`). README screenshots gain `folder-picker-*`.
7. **Deferred.** A configurable start folder (T3 has `addProjectBaseDirectory`; ours starts at `~/`); Windows drive
   letters as places; a preview of what a watch at depth N would find before committing to it.


## UX round 3 — the sidebar as an activity list (lead)

All 2026-11-08 · lead, branch `ux/sidebar-activity`, on top of `main` at `4c3cde3`. Scope: `apps/web`, `docs/`. Brief from the
user: explore a new way of showing the sidebar elements and project grouping, learn from T3 Chat's thread list and T3 Code's
"settled" status, and simplify review status without losing its core. Report: `docs/reports/ux-sidebar.md`.

40. **The sidebar is an activity list, not a tree.** Order, top to bottom: Inbox; **To review**, a block of two-line cards
    (worktrees that want attention); **Settled**, a collapsible tail of one-line rows (clean, verified, review off,
    missing, failed); **Projects**, a compact index of folders and projects (one row each, click opens the Overview,
    right-click or `⋯` opens the same menu as before). The Inbox → Folders → Projects → Worktrees tree of UX round 1 is
    gone. Reason: the tree becomes a long, permanently expanded list as soon as a few agents run, and it sorts by where a
    worktree lives rather than by whether it needs you. Learned from T3 Code's Sidebar V2 (PR #4026/#4068, MIT; ideas only,
    no code): one flat list; active work as cards and finished work as slim rows; "density is earned by settling";
    "blocked work never settles"; "activity never reorders rows, only settling moves them"; project identity as chrome
    on the row rather than as a container. Not adopted from it: creation-time or recency sorting and timestamps (our
    `summary.updatedAt` is when the summary was computed, not when the worktree changed, so a recency tail would lie;
    rows stay in project and worktree order), a project-scope chip strip (thirty repositories do not fit a chip row; the
    text filter already scopes by project name), and tail paging (we have tens of worktrees, not hundreds of threads, and
    every row must stay in the DOM for the acceptance tests). From T3 Chat's thread list: one list with hover-revealed
    actions and pinned items; its grouping by day was not adopted for the same timestamp reason.
41. **Settling is the review loop itself; no new state is stored.** A worktree is a card when it is *blocked* (a conflict
    or an in-progress merge/rebase/cherry-pick/…) or has unreviewed files in the current scope; it is settled otherwise.
    "Mark all as verified" is therefore the manual settle, `r` on the last file settles too, and a new patch (the
    patch-hash key no longer matching) brings the worktree back as a card automatically, which is exactly T3 Code's
    "new activity un-settles". The model is `rowState()` and `settledWord()` in `lib/model.ts`; `buildSidebar` returns
    `cards` and `settled`. Blocked rows come first in the card block and never settle, even with zero unreviewed files.
    Review-off worktrees are settled by definition (the user opted them out) and keep the `review off` badge the e2e
    suite reads (`TEST_IDS.reviewOffBadge`, `data-source`).
42. **Pinning (per device).** A worktree can be pinned from its menu; pinned worktrees are always cards, at the top, with a
    `pinned` chip, whatever their state. Stored in the `pinned` pref (`localStorage`, additive to prefs v2; no version
    bump, `normalizePrefs` tolerates its absence). The one thing taken from T3 Chat's sidebar besides the single list.
43. **Review status, simplified.** Gone from the sidebar: the folder and project `N dirty` words, the per-worktree
    `S1 M2 ?1 !1` porcelain shorthand (the open question of #39 is now decided: a card says `N files`, `+a −d`, `↑x ↓y`
    only when either is non-zero, and `N conflicts` in the danger colour; staged/unstaged/untracked remain as `data-*`
    attributes and in the file list's status letters), the `main`/source/in-progress chips on settled rows (they stay on
    cards, on the facts line, and in the Overview). A card carries exactly one number, the unreviewed pill; a settled row
    carries exactly one word. Folder and project index rows carry the worktree count and the pill. The toolbar chip reads
    `Review on` / `Review off`; where it comes from moved into its `title` and the first line of its menu
    (`Review is off here, decided by this branch.`). `data-enabled`/`data-source` and the menu's `data-target`/`data-state`
    are unchanged. What stays as the core: patch-hash keyed marks, the policy chain worktree > branch > project > folder >
    default, bulk mark with undo, `n`, `onlyUnreviewed`, the file-level toggle.
44. **Keyboard and collapse.** `J`/`K` walk the cards first, then the settled tail (DOM order = `sidebar.order`). The tail
    collapses with a chevron (pref `collapsed` gets the id `settled`, next to folder ids) and reopens by itself when the
    selected worktree is in it (a palette jump, `J`/`K`, `n` into a review-off worktree). Folders in the Projects index
    collapse as before; project rows have no children, so no chevron. Cards and settled rows are one `<ul>` keyed by
    worktree id, with the section headers as presentation items: a worktree that settles or wakes up moves inside the
    list instead of remounting (found by the e2e scopes test, which clicks a row while the inbox for a new scope lands).
45. **Tests.** `ux.test.tsx`: the folder-tier test now asserts the Projects index (projects under their folder, collapse
    hides project rows) and a new test covers the partition, settling by marks, pinning and the collapsed tail reopening;
    `app.test.tsx`: the `J`/`K` expectation follows the new order (docs-site, then `feat/auth`, both blocked). No e2e
    test changed: every `data-testid` and `data-*` attribute of worktree, project and folder rows is kept, plus new
    `data-state` (`blocked` | `attention` | `settled`) and `data-pinned` on worktree rows.
46. **Not done, on purpose.** No daemon change: a true "last changed" timestamp per worktree would let the settled tail sort
    by recency and show `2 h ago`; proposed for the daemon (`WorktreeSummary.changedAt`, additive) in the report, not
    built here. No project-scope filter beyond the text filter. No paging of the tail. "verified" vs "reviewed" wording
    still pinned by the e2e suite (#39).

## Folder picker, round 2: T3 Code parity (lead, 2026-11-08)

Brief from the user: "mimic everything you can from /home/santosa/contrib/t3code in folder selection when applicable".
Studied the local checkout at `eb97d82` (MIT): `apps/web/src/components/CommandPalette{,.logic,AddProject,Content}.tsx`,
`packages/client-runtime/src/state/{filesystem,projects}.ts`, `packages/shared/src/path.ts`,
`apps/server/src/workspace/WorkspaceEntries.ts`, `apps/desktop/src/wsl/wslPathParsing.ts`. Web only; no contract change.

1. **The command palette browses.** As in T3 Code, palette text that is a path (`/`, `~/`, `./`, `../`, a Windows drive or
   share) turns the palette into the folder browser: same rows, same keys, the action button inside the text box, and
   Enter adds (or watches, or opens) the path. A new palette entry **Add repositories…** (T3: "Add project") loads the
   start folder and puts it in the palette text. The browser logic moved out of `AddProjectForm` into
   `components/FolderBrowser.tsx` (`useFolderBrowser`, `FolderRows`, `FolderSubmitButton`, `FolderKeyHints`), shared by the
   dialog, Settings → Folders, the empty screen and the palette.
2. **Load before showing.** The sidebar button and the palette entry prefetch the start folder's listing and only then
   open (T3's `startAddProjectBrowse`), so the picker never opens on "Loading folders…".
3. **Text-based navigation.** Entering a folder appends its name to what was typed (`appendBrowsePathSegment`: `~/co` →
   `~/code/`, `./` stays relative) instead of rewriting the text to the folder's real path; `..` and the places still use
   the listing's paths. The `..` row is shown whenever the listing has a parent, also while filtering (T3's
   `canBrowseUp`). In a `/…` path only `/` separates (`\` is a legal file name character on Unix), as in T3's
   `hasTrailingPathSeparator`. Tab completion gained T3's guard that every visible entry shares the completed prefix.
4. **Paste like T3.** `resolvePastedPath` (adapted with attribution in `lib/folderPath.ts`, T3's test cases ported): a
   full path pasted into the box replaces the text even after the prefilled `~/`, and a path copied for a shell from
   Finder, Explorer or a terminal (`'/a b'`, `/a\'s\ b`, `"C:\a b"`) is unquoted. Also from T3 (its desktop picker's
   `wslUncPathToLinuxPath`): on a Unix daemon a pasted `\\wsl.localhost\<distro>\…` or `\\wsl$\…` path becomes the Linux
   path, which is what a Windows browser talking to a WSL daemon (this machine) copies from Explorer. A Windows path
   typed for a Unix daemon disables the actions with a hint (`/mnt/c/…`), as T3 refuses Windows paths off Windows. The
   Settings field for the start folder normalizes pastes the same way (T3's `normalizeDraft={resolvePastedPath}`).
5. **Relative paths start from the repository in view** (T3: the active project): `./` and `../` resolve against the
   viewed worktree (or the project's main worktree) on the client before listing. With nothing in view the daemon still
   resolves them against its own folder (the "Daemon folder" place), rather than T3's "Relative paths require an active
   project" error, since we have a meaningful fallback.
6. **Open, don't re-add.** T3 opens a project whose folder is added again. In the dialog and the palette the primary
   action becomes **Open** when the path is an added repository or worktree (it opens that worktree, or the project), and
   adding a repository closes the picker and opens the new project. Settings → Folders and the empty screen keep their
   inline messages (you may add several there). Watching keeps the dialog open for the scan progress; from the palette
   it closes and shows a notice.
7. **T3's layout details.** The primary action sits inside the text box at its end with its live shortcut (T3's
   `CommandPaletteSubmitButton`; it carries the add or watch test id of the action it runs, and the other action stays
   below the list with its own id, so both ids always exist unless the primary is Open); a folder-plus icon starts the
   text box; the list has a "Folders" label (T3: "Directories"); `..` uses a corner-up icon and rows lose the chevron;
   "Loading folders…"; the footer reads `↑↓ Navigate`, `Enter Select` (only while a row is highlighted), `Tab Complete`,
   the modifier shortcut, `Esc Close`. Clicking a row, a place or an inline Add keeps focus in the text box (T3 cancels
   mousedown), so you can click and keep typing.
8. **Start folder** (T3: `addProjectBaseDirectory`, deferred in round 1): pref `folderStart`, saved on this device
   (prefs v2, additive, no version bump; `normalizePrefs` tolerates its absence), set in Settings → Folders → "Start
   browsing in", empty means `~/`.
9. **Not adopted.** T3's server returns an empty listing for an unreadable folder; we keep the explicit "permission
   denied" (more useful). "Create & Add" for a missing folder (octopus-diff never writes), the native folder dialog and
   "Open in Finder" (no desktop shell), clone and new-project flows, environment choice (one daemon), row virtualization
   (the listing is capped at 2000).
10. **Tests.** `folderPath.test.ts`: separators, append, browse queries, relative resolution, start text, Windows on Unix,
    T3's paste cases, WSL paths. `app.test.tsx`: focus stays in the box on click, paste replaces and unquotes (and a WSL
    path converts), the dialog opens an added repository and opens a newly added one, the start folder setting, `../`
    in the palette from the viewed repository, and the palette's "Add repositories…" → browse → Tab → Enter flow. e2e
    unchanged; `e2e/scripts/screenshots.ts` adds `palette-browse-*`.
11. **Cleanup.** Removed two stray `|||||||` diff3 marker lines left in this file by earlier merges (no content changed).
## UX round 4 — folders back, an explicit settle, a closed shelf (lead)

All 2026-11-08 · lead, branch `ux/sidebar-folders`, on top of `main` at `1325cc3`. Scope: `apps/web`, `e2e/support`
(one helper), `docs/`. Brief from the user after round 3: the hierarchy is off, the add-repository and filter controls
look off, worktrees cannot be settled and the settled ones still show; follow the proven UI in T3 Code
(`~/contrib/t3code`, its current sidebar with project folders and a Settled shelf) where it applies.

47. **The hierarchy is back: folder → project → open worktrees, and one Settled shelf.** T3 Code's current sidebar
    ("boring" mode, `SidebarProjectFolderHeader`, `groupSidebarThreadsByProject`) keeps project folders and lists each
    project's *active* threads under it; settled threads go to one shelf at the bottom. Round 3's flat card list lost
    the project grouping the user wanted and repeated the project name on every card. Now: Inbox; **Pinned**; every
    folder (scan root) as a collapsible header with its projects; every project as a collapsible header (chevron, repo
    glyph, name) with its open worktrees as one-line rows that say only the branch; **Settled** at the bottom. The
    **Projects** index of round 3 is gone: the folders *are* the index again (a click on a folder or project header
    still opens its Overview; `⋯` and right-click keep the same menus). A closed folder or project shows what it hides
    (a faint worktree count and the unreviewed pill); an open project whose worktrees all settled says `settled`
    instead of listing nothing. Two-line cards are gone with the facts line: files, `+a −d`, ahead/behind moved to the
    row's tooltip and stay in the Overview. The e2e selectors are unchanged (`li[data-folder-id] button[title]`,
    `projectItem` with `data-project-*` containing a titled button, `worktreeItem` with every `data-*` attribute).
48. **Settle is an explicit action, held by the state hash.** Round 3 had no settle verb: a worktree settled only when
    its files were all verified, so an agent's half-done branch could not be put away. T3 Code has Settle / Un-settle
    on hover and in the thread menu, and a settled thread un-settles on new activity. Ours: a check at the right of a
    row on hover or focus (`Settle worktree`), an undo arrow on settled rows (`Un-settle worktree`), the same two items
    in the row menu. A manual settle or un-settle is stored per device as `{ worktreeId, state, stateHash }` in the
    new `settle` pref and holds only while `WorktreeSummary.stateHash` is unchanged (the daemon's hash of HEAD, branch,
    ahead/behind and every patch): the next change to the worktree drops it and the automatic rule applies again, which
    is exactly "new activity un-settles" without a daemon change or a timestamp. `rowState()` now returns `blocked |
    attention | active | settled` plus `settledBy: auto | user`; `active` is a row the user un-settled that would
    otherwise be settled (it stays under its project with its word, e.g. `clean`). Blocked work still never settles,
    not even by hand: no check on a blocked row, a disabled `Settle (blocked)` in its menu. The automatic rule is
    unchanged (#41): verified, clean, review off, missing and failed worktrees settle on their own.
49. **The Settled shelf is closed by default and shows the selected row while closed.** T3 Code's shelves default to
    closed; a shelf open by default is what "settled ones still show" meant. The `settledOpen` pref (default `false`)
    replaces the `settled` id in `collapsed`; filters open the shelf and every folder, so a hit never hides. While
    closed, the shelf lists only the selected worktree (T3 Code's `routeThreadOnly`), so `J`/`K`, `n` and palette jumps
    into a settled worktree always have a row and the shelf no longer pops open on its own (#44 is superseded).
    `J`/`K` order is DOM order: pinned, then folders (project by project, open rows), then the shelf in folder order.
50. **Chrome follows T3 Code.** The add action is an icon button in the header next to Settings (`+`, titled "Watch a
    folder or add a repository", same `addProjectButton` test id; the full-width footer button is gone). The two
    filter toggles are chips under the filter field (`ToggleButton variant="chip"`, `.od-chip` filled softly while
    pressed) instead of two 24 px buttons that read as actions. The empty screen and Settings → Folders still add.
51. **Tests.** `ux.test.tsx`: the round-3 partition test is replaced by one that asserts the folder rows, the closed
    shelf and its count, opening the shelf (folder order, one word each, the review-off badge), the selected row in a
    closed shelf, settling by hand and expiry through `backend.mutate` (a new file changes the hash), un-settling a
    clean worktree, the blocked rule (no check, disabled menu item), settling by marks, pinning, collapsing a project.
    Test harnesses start with `settledOpen: true` because many tests read settled rows. `app.test.tsx`: `J`/`K` follow
    the folder order (docs-site, then octopus-api's main checkout). e2e: no spec changed; `AppPage.open` seeds
    `{ settledOpen: true }` into a fresh profile (tests that store prefs themselves keep theirs), and the README
    screenshot script opens with real defaults. This is the one edit outside `apps/web` and `docs/`, in a WS4 helper,
    because the specs' row-visibility assertions are right and only the default changed.
52. **Not done, on purpose.** No per-project Settled shelf (T3 Code has one global shelf). No drag to settle or
    reorder. No auto-settle after N days (needs the daemon's change timestamp, #46). No project favicons (T3 Code
    reads a favicon per project; we draw one repo glyph). No "Working" shelf: the activity pulse already marks a
    worktree an agent is writing to, and rows do not reorder.
53. **Rows are cards with T3 Code's anatomy, plus a hover card.** The user's screenshot of a settled row
    (`octopu… feat/fol… t3 clean ↶ ⋯`) against T3 Code's card (project line, title line, meta line, a popup with the
    details) made the one-line row untenable: at 260 px, project, branch, chips, word and two hover buttons fought for
    one line and everything truncated. Now every worktree is a card: under a project, the branch (500) with the
    status slot at its right, then a meta line in mono 11 px (`main` / source / in-progress chips, `N files`,
    `+a −d`, `↑x ↓y`), omitted when empty (T3's `metaLineEmpty`); pinned and settled rows, which sit outside their
    project, start with a project line (repo glyph, name, the status slot). Hover or focus swaps the status slot for
    the actions (`✓ Settle` / `↶ Un-settle` and `⋯`), as T3 swaps the time for "Settle", so nothing is pushed off the
    row. After 450 ms of mouse hover a fixed-positioned card to the right of the row (`role="tooltip"`, `.od-overlay`)
    lists branch, state, project, path, source, checkout, operation, changes, sync vs the ahead/behind ref, review
    policy, the manual settle and any error (T3's `SidebarThreadTooltip`); it never takes pointer events and goes on
    pointer-down, so it cannot get in the way of a click. The native `title` on rows is gone (the card replaced it;
    folder and project headers keep theirs for the e2e suite). The facts that round 4 had moved to the tooltip are
    visible again on the meta line.


## Credits for open-source software (lead, 2026-11-08)

Branch `docs/credits`, on top of `main` at `1a07fd9`. Brief from the user: a section that credits all open-source
software we use, and every agent must know to update it whenever a package is added. (Numbered #54–#56: UX round 4's
row cards took #53 on `main` in parallel. #54–#56 are superseded by #57–#59 below.)

54. **`CREDITS.md` at the repository root, linked from the README's new "Credits" section.** Tables of direct
    dependencies (shipped vs development tools: package, users, license, project URL), a prose list of the
    transitive packages the shipped ones pull in (shiki, the unified utilities, preact, the `@parcel/watcher`
    binaries…), git as an external program (GPL-2.0, run, not bundled), the code adapted from T3 Code (MIT,
    Copyright (c) 2026 T3 Tools Inc.: `DiffWorkerPool.tsx`, `folderPath.ts`, the ported `folderPath.test.ts` cases)
    and the projects from PLAN §3 that inspired ideas only. It is a shared file, like `docs/`: every stream may edit it.
55. **Enforced, not just documented.** `scripts/check-credits.mjs` (run by `pnpm lint`, so by `pnpm check`; also
    `pnpm credits`) reads every workspace `package.json` and fails on a direct dependency without a table row, a row
    for a package that is no longer a dependency, or a row whose license differs from the installed package's
    `license` field. Transitive packages are not checked (the list would churn with every lockfile update); the
    rule asks for a review of that list when a shipped dependency changes. AGENTS.md § Dependencies, rule 2, the
    layout table, the stream report template and CONTRIBUTING.md now say so.
56. **The CLI tarball ships `CREDITS.md`** next to `LICENSE` (`apps/cli/scripts/pack.mjs`). Not done: a generated
    `THIRD_PARTY_LICENSES` with the full license texts of the code bundled into the web UI, which MIT / Apache-2.0
    ask for when redistributing. Do it before the first npm publish (e.g. from the Vite build's module list).
60. **No `⋯` buttons; right-click is the menu.** (2026-11-09, user request; numbered after the credits entries #54–#59, written in parallel.) The hover-revealed `⋯` on cards, project
    headers and folder headers is gone; the context menu opens on right-click anywhere on the row or header (the
    chevron included), and from the keyboard with the menu key or `Shift+F10`, which browsers deliver as the same
    `contextmenu` event (`useContextMenu` already anchors a keyboard-opened menu to the element). The one visible
    action left on a card is the hover `Settle` / `Un-settle`. Rows gain the 20 px the `⋯` reserved. The web tests
    open menus with `fireEvent.contextMenu`; the e2e helper already right-clicked. Also here: `AppPage.selectWorktree` no
    longer calls `scrollIntoViewIfNeeded` before clicking; the click scrolls and retries by itself when the row remounts
    (a card that settles or wakes while the inbox for a new scope lands moves between its project and the shelf, which
    the folder hierarchy makes a remount again; the scopes spec hit that race once).


## Credits in the app (lead, 2026-11-09)

Branch `web/credits`, on top of `main` at `3617d3c`. Brief from the user: the credits belong in the application
(Settings or About); `CREDITS.md` alone is not the right place, or only alongside the app.

57. **Settings → About → "Open-source software".** About already shows the versions, and About is where apps keep
    their licenses, so a new Settings section was not needed. Below the versions: code adapted from other projects
    (T3 Code, with the files and its license), the programs it runs (git), a filter, then "Shipped with
    octopus-diff" (71 packages, direct and pulled in: version, license, author, link, `used by` or `via`, the license
    text and any NOTICE in a `<details>`) and "Development tools" (16, direct only, no texts), and the inspiration
    list. `Credits.tsx` is lazy-loaded inside the (already lazy) Settings chunk, so the ~200 KB of JSON costs nothing
    until About opens.
58. **Generated, not hand-written (supersedes #54/#55).** `scripts/credits/generate.mjs` (`pnpm credits`) reads the
    workspace `package.json` files, follows the shipped workspaces' `dependencies` through `node_modules` (pnpm real
    paths, Node's lookup), reads each package's license/NOTICE files, and merges the hand-written
    `scripts/credits/acknowledgements.json` (shipped workspaces, allowed runtime licenses, notes, programs, adapted
    code, inspiration). It writes `apps/web/src/generated/credits.json` (excluded from Biome) and `CREDITS.md`; both
    are committed so typecheck, tests and the Vite dev server need no generation step. `pnpm lint` runs
    `pnpm credits:check`, which regenerates in memory and fails when either file differs. A version bump therefore
    needs `pnpm credits` too, deliberately: license texts change with versions. Optional dependencies are skipped
    (`@parcel/watcher`'s per-platform binaries are one note) so the output is identical on Linux, macOS and Windows.
    Shipped packages with a license outside `allowedRuntimeLicenses` fail generation. The hand-maintained transitive
    list of #54 and `scripts/check-credits.mjs` are gone.
59. **License texts ship with the code.** The web bundle now carries every shipped package's license and NOTICE text,
    which covers the redistribution gap noted in #56 for the web UI; the CLI tarball still ships `CREDITS.md`. One
    shipped package publishes no license file in its tarball (`lru_map`, MIT); the app says so next to its license.

## Forges: pull and merge requests via gh / glab (lead, 2026-11-09)

The user asked to "check how gh cli and gitlab can be implemented (again use t3 code as base), it should auto
discover them correctly and get valid information about PRs/MRs", then to build it. Full design: `docs/FORGES.md`.

61. **PLAN change: read-only forge status is in scope.** §1 listed "PR hosting or forge features" and "auth against
    remotes" as non-goals and §4.4 had "PR/CI status via `gh` (read-only)" in the backlog. Showing a worktree's
    PR/MR is now built; everything that writes to a forge (create, merge, approve, comment, checkout) stays a
    non-goal, and octopus-diff still holds no credential: it uses the logins `gh`/`glab` already have.
62. **On by default, with a switch and per-host overrides.** `AppSettings.forges { enabled: true, hosts }`
    (daemon-side, additive). Default on because nothing is contacted unless a CLI is installed **and** signed in
    to the remote's host, and only for non-default branches checked out in worktrees. `hosts` maps a hostname to
    `github`, `gitlab` or `none`: per host rather than per project, because a host is one forge for every project.
63. **CLIs, not tokens; GraphQL through the CLIs.** T3 Code reads `gh auth token` and calls GitHub's API itself
    (with an app sign-in and a rate-limit manager). We only run `gh api graphql` / `glab api graphql`: no token
    ever enters octopus-diff, and one aliased query per repository asks about every worktree branch at once
    (1 GitHub rate-limit point measured), instead of `gh pr list` per branch or a 100-PR list per repository.
64. **The forge runner is a second read-only runner** (`packages/forge/src/cli.ts`): argv only, an exact allowlist
    in which the GraphQL query must equal a built-in query for the given variable count, neutral cwd (the state
    dir, never a repository), hardened env. **Token scoping**: `gh` sends `GH_ENTERPRISE_TOKEN` to any
    non-github.com host and `glab` sends `GITLAB_TOKEN` to any host, so env tokens are dropped unless they belong
    to the queried host, and only hosts the CLI reports as signed in are queried. A crafted remote cannot
    collect a token.
65. **Discovery order** (T3 Code's rules, adapted): setting override, then hostname (`github.com`, `*.ghe.com`,
    a `github`/`gitlab` label, `gitlab.com`), then the CLI's logins for that exact host (self-managed GitLab or
    GHES on a neutral name). ssh aliases resolve through literal `Host`/`HostName` pairs in `~/.ssh/config`.
    Base repository in `gh`'s order: `gh-resolved` mark, `upstream`, `github`/`gitlab`, `origin`, others.
66. **Matching rejects strangers' forks.** Head branch from `branch.<b>.merge` when pushing to the tracked remote;
    push repository from `pushRemote` > `remote.pushDefault` > `branch.remote` > `origin`; a request matches only
    from that repository (or same-repo when unknown). Measured on `cli/cli`: `headRefName: main` returns five
    fork PRs, none of which may match. The default branch is never looked up.
67. **git-core gets `readRemoteConfig`** (optional on the `GitCore` interface so test doubles need not change): one
    `git config --null --get-regexp` with `insteadOf`/`pushInsteadOf` applied; no new subcommand. Written by the
    lead in this session (WS1 path) because it is the only git access the feature needs.
68. **Text, not `--json`, for auth status.** `gh auth status --json` needs gh ≥ 2.81; the dev machine (Ubuntu) has
    2.46. Both CLIs' text forms are parsed (T3 Code's glab parser, MIT, adapted with attribution). glab < 1.79
    rejects `--all`: retried without it. GitLab queries fall back to a basic field set on "field doesn't exist".
69. **UI colour stays within the identity.** T3 Code's glyph shapes (open, draft, merged, closed), but only open
    (`add`) and the CI dot (add / danger / warn) are coloured; merged is not violet and closed is not red
    (IDENTITY.md §4: hues belong to the diff). No new theme token.
70. **Test and tooling edits outside the usual owners.** `e2e/support/env.ts`: the web-UI preflight looked for
    `data-ready` and `worktree-item` in the same chunk; Rollup moved `TEST_IDS` into a shared chunk, so it now
    checks across chunks. e2e 09/13 expect the `forges` settings default and the seventh settings section.
    `03-scopes` "the scope selector switches the file list" is flaky on `main` too (1 of 4 runs on an untouched
    `main` build, "element is not attached to the DOM"): not caused by this change, left for its owner.


## Forge details: the Request tab and repository information (session, 2026-11-09)

Brief: `/home/santosa/.claude/plans/you-are-planning-the-cosmic-abelson.md` (PR/MR detail as a `Request` tab, a richer
hover card, repository information on the Overviews). Design: `docs/FORGES.md`. Report: `docs/reports/forge-details.md`.

71. **[contracts] Request detail, conversation and repository information, all additive.** `ChangeRequest` gains
    optional scalars (`createdAt`, `additions`, `deletions`, `changedFiles`, `mergeState`). New schemas:
    `ForgeActor`, `ChangeRequestLabel`, `ChangeRequestReviewer`, `ChangeRequestCheck`, `ChangeRequestCommit`,
    `ChangeRequestFile`, `ChangeRequestDetail`, `ChangeRequestConversation` (+ comment, review entry, thread),
    their `*Response`s, `ForgeRepositoryInfo`, `RepositoryForgeResponse`; `ForgeSettings.images?`;
    `GitRepositoryInfo` (domain.ts) and optional `GitCore.readRepositoryInfo(project, { defaultBranch })`;
    six routes (`getChangeRequest`, `getChangeRequestConversation`, `refreshChangeRequest`, `getRepositoryForge`,
    `refreshRepositoryForge`, `listRepositories`) with client methods; test ids for the new surfaces.
    Deviation from the brief: the detail's per-check list is **`checkList`**, not `checks`, because `ChangeRequest`
    already has `checks` (the CI summary object) and the detail extends `ChangeRequest`; renaming would have broken
    the existing field. `readRepositoryInfo` takes the project's effective default branch (it has the override) and
    detects it only when absent.
72. **Batch query: scalars only, a GitHub `basic` variant, and the cost on every GitHub query.** The per-branch batch
    gains `createdAt additions deletions changedFiles mergeStateStatus` (GitLab: `createdAt` and, in the full
    variant, `diffStatsSummary`), never connections (labels, reviewers), so the hover card and the Overview
    column cost nothing extra. Measured live: still 1 point. `mergeStateStatus` is missing on old GitHub
    Enterprise, so the GitHub batch now has a `basic` variant with the same "unknown field → retry basic" rule as
    GitLab. Every GitHub query now asks for `rateLimit { cost remaining }`; `ForgeClient({ onCost })` reports it
    (the opt-in live test asserts `cost <= 1`). The Overview's chip moved from the worktree cell to a new
    **Pull request** column (chip, title, review word); the worktree cell otherwise is unchanged.
73. **The forge allowlist is a registry of query kinds, and GitHub PR numbers are inlined.** `cli.ts`
    `QUERY_REGISTRY` has four kinds (`batch`, `repository`, `detail`, `conversation`); each knows its fixed
    variable names and rebuilds every query string it allows, and the caller's query must equal one byte for byte.
    `gh api graphql --raw-field number=1` fails for `$number: Int!` and `-F` stays banned (it reads files), so
    the GitHub detail and conversation builders take a validated safe integer and inline it; the registry
    extracts it with a regex, rebuilds the query and compares. GitLab's `iid` is a `String!`, so it stays a
    `--raw-field` (digits only). Every other rule is unchanged (`--raw-field` only, `--hostname` first, value
    limits, neutral cwd, host-scoped tokens, signed-in hosts only). Measured: each new GitHub query costs 1 point.
74. **The UI's CSP allows images from signed-in forge hosts (user's choice), with a switch.** `UI_CSP` became
    `uiCsp(imageHosts)`: `img-src 'self' data: blob:` plus `https://<host>` per pattern, where the patterns come
    from `forgeImageHosts(settings, clis)`: for each host a CLI is signed in to and that passes `ForgeHostSchema`
    (and is not overridden to `none`), GitHub.com adds `github.com` and `*.githubusercontent.com`, GitHub
    Enterprise `H` adds `H` and `*.H`, GitLab `H` adds `H` and `secure.gravatar.com`. The builder drops any
    entry that is not a plain host pattern, so nothing can inject a directive. `forges.images: false` or forges
    off gives exactly the old policy; API responses keep `API_CSP`. The policy is computed per page load, so a
    newly signed-in host applies after a reload. The UI renders an `<img>` only for https URLs on
    `imageHosts` (sent with every detail/conversation response), with `referrerPolicy="no-referrer"`,
    `loading="lazy"`, `decoding="async"` and a fixed max size; anything else, or a failed load (private-repo
    attachments need cookies), becomes a plain `image: <alt> ↗` link. Avatars fall back to initials.
75. **Repository information: two routes, two sources.** `GET /api/repositories?projectIds=a,b` (max 200) returns
    local git facts only (`GitCore.readRepositoryInfo`: one `for-each-ref`, `log -1`, `rev-list --left-right
    --count`, the remote config read; no allowlist change), cached 30 s and dropped on any event naming the
    project. `GET /api/forges/projects/:projectId/repository` returns the forge facts (one query, cached 10 min,
    "Refresh" forces it at most every 15 s) with open requests joined to local worktrees by the daemon. Remote
    URLs lose their userinfo for http(s)/git URLs (a token is often the user name) and their password for ssh.
76. **The folder Overview runs no forge query.** It shows `/api/repositories` facts plus what the 2-minute batch
    already knows (forge `host/path`, open requests among the worktrees, how many need attention: failing CI,
    changes requested or conflicts). Only the project Overview asks the forge, once per project, lazily.
    Asserted in the daemon test (forge call count unchanged) and the web test (no `/api/forges/projects/` call).
77. **Markdown: react-markdown + remark-gfm (MIT), no raw HTML.** `skipHtml`, no rehype-raw, no
    `dangerouslySetInnerHTML`; HTML comments (bot markers) are stripped first (T3's `visibleBody`), so
    `<details>` templates render flattened. Links: `https:`, `mailto:` and `#fragment` only, relative ones
    resolved against the forge repository, `target=_blank rel="noopener noreferrer"`; anything else renders as
    text. Task-list boxes are disabled. `#123` (GitHub, GitLab issues) and `!123` (GitLab MRs) autolink through
    a small remark plugin. The chunk is lazy (Request tab only). The dependency pulls the unified/micromark
    family (shipped packages 71 → 142, all MIT/ISC-compatible; the credits license gate passed).
78. **The Request tab is a registry view; live refresh is bounded.** `ViewId` gains `request`, `Selection` gains
    `hasRequest`, the worktree `View` gains `tab`; `activeView(view, { hasRequest })` picks the chosen tab when it
    applies and falls back to Changes. `actions.setView` carries the tab to the next worktree. The Toolbar shows
    a `Changes | PR #12` segmented control only for worktrees with a matched request (the forge link badge and
    its test id stay); the Request layout is the Overview's two columns with the Toolbar on top. Inside:
    `Summary | Timeline | Files`. The detail query key holds the batch entry's `updatedAt`, `headSha` and
    checks state (no new SSE event). Checks refresh every 45 s only while a check is running, the tab is
    shown, the browser tab is in the foreground (react-query pauses intervals in the background) and the user
    gave input in the last 20 minutes (risk 3 in the brief: caps the cost at about 80 points per hour per open
    tab while CI runs, and to zero for a forgotten tab). The daemon caches detail/conversation 60 s (10 min for
    merged/closed), dedupes in-flight fetches, spaces forced refreshes 15 s and keeps stale data on errors.
    Routes are keyed by worktree id, so the browser cannot make the daemon query an arbitrary request.
79. **GitLab gets the same UI from GraphQL only; missing data hides.** Detail: description, labels, assignees,
    reviewers with `mergeRequestInteraction.reviewState` (full variant), approvers, commits (newest 100, shown
    oldest first), `diffStats` (change kind unknown: `changed`, shown as `·`), and pipeline jobs grouped by stage
    as checks (`MANUAL` is neutral). Conversation: discussions; diff notes become threads, other notes become
    comments, system notes are dropped, and there are no review objects. GitLab cannot be verified with a
    signed-in `glab` here (none on this machine): field names were checked against gitlab.com's public GraphQL
    with the recorded fixtures; the `basic` variants (older self-managed versions) are untested live.
80. **Request tab and Overview implementation notes.** The Files tab marks `changed here` from the worktree's
    own changed files in the current scope; clicking such a row switches to Changes with that file selected
    (no patch from the forge). The Conversation shows 10 items per page ("Show N older"), filters for bots and
    for resolved/dismissed items (both shown by default), and collapses resolved threads and dismissed reviews
    to one line. Phases C and D landed in one web commit because the Summary embeds the Conversation; the
    daemon routes for both landed with Phase B's daemon commit.


## Status flow v2: review stages and "reviewed up to" bookmarks (lead, 2026-11-09)

Lead session on branch `feat/status-flow` (from `main` at `984f2ad`). Design: `docs/STATUS-FLOW.md` (agreed with the
user). Report: `docs/reports/status-flow.md`. Steps 1 → 4 of the plan's build order, each committed with a green
`pnpm check`.

81. **Step 1: the sidebar's status has its own fixed source.** `state/model.tsx` builds the sidebar from
    `summary.review` (step 2) and, for daemons without it, from a second inbox query pinned to the `working` scope
    (`SIDEBAR_STATUS_SCOPE`); the toolbar's inbox still feeds the Inbox view and `n`. While the toolbar shows
    Uncommitted both are one query. The plan said "`branch` + working until step 2 lands": not done, because the
    branch inbox is not cacheable in the daemon (it recomputes every worktree's branch diff on every request) and
    step 2 replaces the fallback within the same round; until then commits are invisible to the sidebar, as before.
82. **Stages and places.** `lib/model.ts` gets `stageOf()` (`blocked | review | reviewed | inPR | merged | closed |
    off`) and `placeOf()`; `RowState` (`data-state`, read by the e2e suite) keeps its four values and now derives
    from the stage: blocked and To review under the project, In PR `active` under the project, the rest in the
    shelf. Rows carry `data-stage`, `data-unreviewed` and `data-commits`. The plan's open question (does
    Reviewed with no PR stay under its project?) is decided as its default, **shelf**: density stays earned, a row
    you finish still shows while selected (the closed shelf lists the selected row, #49), and it is the smallest
    change. The shelf header keeps its name ("Settled") and its test labels.
83. **One verb, "Reviewed".** "Mark N visible as verified" / "Verify N" became "Review N shown" / "Review all N"
    (⇧R), the menus "Mark all reviewed" / "Mark all unreviewed", the confirm dialog "Mark N files reviewed?", the
    toast "N files marked reviewed", a quiet row says `reviewed` (dirty) or `clean`. The command id
    `markAllVerified` is internal and kept. No UI string contains "verif" (e2e acceptance 6).
84. **Settle is "Hide until it changes".** Same mechanics as round 4 (#48: per device, held by `stateHash`, blocked
    rows never hide), new words: the hover action is `Hide` (aria-label "Hide until it changes", an eye glyph), on
    a hidden row `Show` ("Show again"), on a row the shelf holds by itself "Keep under its project". The hover card
    says "Hidden: until it changes".
85. **The pulse is gone** (`.od-pulse`, `@keyframes od-pulse`, `isRecentlyActive`, `ACTIVITY_WINDOW_MS`,
    `useClock`, `data-active`). Rows outside a project lose the 24 px indent that only made room for it; rows
    under a project keep theirs, which aligns the branch with the project name.
86. **The toolbar scope is a filter with counts.** The select keeps its test id, values and `data-scope` (the e2e
    helper picks options by value) and reads "Show: All on branch (12) · Uncommitted (3) · Staged (1) · Unstaged
    (2) · Commit…". Counts come from the open worktree's summary; "All on branch" lists the branch scope's files
    for the open worktree only (one request, cached by react-query). Settings → General's default scope uses the
    same words.
87. **`pnpm dev:mock` import cycle fixed.** `commands.ts` re-exports `SHORTCUTS` from `commandRegistry.ts`, which
    imported the value `CONTEXT_STEP` back from `commands.ts`; Vite's unbundled ESM evaluated the registry first.
    The two constants moved to a leaf module `state/diffContext.ts` (re-exported from `commands.ts`).
88. **[contracts] Step 2/3 surface, all additive** (`87e3889`): `DiffScope` gets kind `review` `{ base?: sha }` and
    `branch.includeWorking`; `WorktreeSummary.review` (`WorktreeReviewSchema`: `bookmark`, `base`, `newCommits`,
    `unreviewedFiles`, `historyRewritten`); `PUT /api/review/bookmark` (`SetBookmarkRequest/Response`, client
    `setBookmark`), event `review.bookmark`, `BulkReviewRequest.advanceBookmarks` and `BulkReviewResponse.bookmarks`;
    optional `GitCore.readReviewRange`, `describeCommits`, `rangePatchId`. Query strings: `scope=review&base=<sha>`,
    `scope=branch&working=1`. `scopeKey`: `review[:sha]`, `branch[:base]:~w` (`~` cannot occur in a ref name). Written
    on a side branch so the git-core work could run in parallel, cherry-picked after step 1.
89. **The plan's choice: kind `review` = the working tree against the bookmark, one patch per file**, not a `range`
    kind plus the working scope in two sections. `git diff <bookmark>` (plus untracked files) is exactly the working
    scope with another base, so git-core reuses the status-based code path; and a file's patch in it does not change
    when the agent commits it (same blobs, same text), so a mark made before the commit still matches after it
    (§2.4's "commit then already reviewed" falls out of the key). The cost: no "commits" / "uncommitted" section
    headers in the file list (a file changed in both shows one combined patch). Logged as a deviation from §2.3's
    sections; the toolbar count and the row's `N commits` carry the split.
90. **Bookmarks.** Table `bookmarks(project_id, key, sha)` (migration v3), key `branch:<name>`, or `worktree:<id>` when
    detached or without a branch. First sight: git-core's `initial` (HEAD on the default branch and when detached,
    else the merge-base with the default branch, else HEAD), stored on first computation. `historyRewritten` = a
    stored bookmark that is not an ancestor of HEAD; the range then starts at the merge-base with the default branch
    (the merge-base with the old bookmark on the default branch itself). The bookmark is not moved by a rewrite: only
    Review all / PUT move it.
91. **Review state lives in the daemon, cached per (stateHash, review version, default branch).** `#reviewOf` runs
    after each summary (before `worktree.changed` is announced, so clients refetch a ready state) and on demand;
    every review write (mark, bulk, undo, bookmark) bumps a per-project version. `readReviewRange` is cached per
    (HEAD, bookmark) while the bookmark is reachable, so a steady worktree costs no extra git process; a clean
    worktree whose base is HEAD lists no files at all. `stateHash` stays a hash of git state only (Hide until it
    changes, #84, depends on that). `listProjects` waits (bounded, like summaries) for review states; on failure the
    last state is kept.
92. **To review = unreviewed files only.** The row is To review while `unreviewedFiles > 0`; `newCommits` (unreviewed
    commits that bring changes) is shown next to it (`2 commits · 3`) but does not hold a row on its own: once every
    file of the review diff is reviewed (by hand or through reviewed commits) nothing is left, even if the bookmark
    did not move. Otherwise a branch whose files were all marked one by one would stay To review with nothing to
    review.
93. **Review all in To review moves the bookmark.** The web sends the bulk call without `paths` and with
    `advanceBookmarks` (in To review the only hidden files are reviewed ones, so the worktree is what the user sees);
    the daemon moves each marked worktree's bookmark to the HEAD of the state that passed the `expectedStateHashes`
    check, and the undo entry carries the bookmark moves (`BookmarkMove`), restored only if the bookmark did not move
    again. `PUT /api/review/bookmark` takes a full commit id that is HEAD or an ancestor of it; its undo token goes
    through `POST /api/review/undo`. Older daemons ignore `advanceBookmarks` (zod strips it).
94. **Web defaults.** Default scope `review` (pref `defaultScope`, Settings → General "To review"); on a daemon without
    `summary.review` the option is disabled and the scope falls back to Uncommitted. A stored `defaultScope` keeps
    its value (no prefs migration). "All on branch" is `branch` + `includeWorking`. The sidebar refetches projects on
    `review.changed`, `review.bulk` and `review.bookmark` (counts live in summaries). The mock backend has an opt-in
    `statusFlow` mode for the web tests. The e2e `AppPage.open` seeds `defaultScope: 'working'` (the scope specs
    compare against the working scope); the status-flow spec opens with To review.
95. **Step 3: marks no longer depend on the scope kind.** No migration: `listReviewMarks` reads every row of a project
    (grouped by raw, path, patch hash), unreviewing deletes the mark in every kind, touches ignore the kind;
    `scope_kind` stays as "where the mark was made" and old rows keep working. The web patches every cached scope on
    `review.changed`.
96. **Step 3: reviewed commits** (`reviewed_commits(project_id, sha, patch_id)`). A bookmark move to HEAD records every
    commit of the review range by id and `git patch-id --stable`, plus a `<base>..<head>` row with the whole range's
    patch-id (a squash merge of the range has it). A moved-to commit other than HEAD records nothing (rare; PUT
    only). In a range, a commit is reviewed when its id is recorded, or (non-merge) its patch-id is; a commit with no
    paths (clean merge: `--cc` lists only paths that differ from every parent; empty commit) brings nothing. The
    paths of the remaining commits are "uncovered"; a file of the review diff with no uncommitted change and no
    uncovered path (or rename source) is reviewed. A truncated range (> 500 commits) covers nothing. Undo removes the
    rows the move added.
97. **git-core (delegated in this session, branch `status-flow/git-core`, cherry-picked):** `patch-id` allowlisted with
    `--stable` only; **stdin is explicit**: the runner rejects `input` for anything but `check-attr --stdin` and
    `patch-id` (before, any command could get stdin); `patchid.stable=true` / `patchid.verbatim=false` pinned so repo
    config cannot change patch-ids; `describeCommits` caches per (common dir, sha) and batches 200 commits per
    process; `rangePatchId` resolves both ends with `rev-parse`. The read-only proof covers the new reads. Known
    gap: in the review scope with an older base, an untracked file at a path that differs from the base is listed
    once, as the tracked change (the same de-duplication as `working`).
98. **Step 4: forge stages, web only, from the existing `WorktreeForge` data** (`buildSidebar` takes the forge index).
    A request is *finished for this HEAD* when it is merged or closed and its `headSha` is HEAD, or the forge says
    `sync: same`; a newer local commit means the work moved on and the request no longer decides the stage. Order:
    blocked; finished with nothing uncommitted → **Merged / Closed** (shelf, word `merged` / `closed`, even with
    unreviewed commits: they show on the target branch); unreviewed files → To review; finished with uncommitted
    work left → stays under its project, `merged · 2 files`; an open non-draft request → **In PR** (under its
    project, `#42 · checks ✓` / `checks ✗` / `checks …` / `#42 · changes requested` in the warn colour); a draft →
    Reviewed. Forges off or no data: those stages never apply. Review-off worktrees still reach Merged/closed (the
    word is more useful than `review off` there).
99. **Not done, on purpose.** No e2e for In PR / Merged: the fake `gh` of spec 14 serves recorded open requests only;
    the stage table is covered by unit tests (`model.test.ts`). No automatic bookmark advance when every commit of a
    range is already reviewed (ranges stay short in practice; the review state is cached). No "commits" /
    "uncommitted" section headers in To review (#89). A bookmark moved by PUT to a commit other than HEAD records no
    reviewed commits (#96).
100. **PLAN change: status flow v2.** PLAN §4.1 (scopes: To review default, All on branch, Uncommitted; marks keyed
     without the scope kind; review bookmarks; stages), §4.2 (sidebar and toolbar wording), §4.3 (differentiator 2
     includes bookmarks), §5.7 (the v3 tables, the review state and the new read-only git commands) and §8 (items
     12–18 from `docs/STATUS-FLOW.md` §5) now describe what this round built. `docs/STATUS-FLOW.md` stays as the
     design record.

## Copy tools: branch, path, file and code selection (lead, 2026-11-09)

Plan: `docs/COPY-TOOLS.md` (written against `6c53f1a`; built on `1561c3c`, after status flow v2). Web only: no daemon
request, git call or contract change.

101. **Step 1: foundation.** `lib/copy.ts` `copyText` (async Clipboard API, then a hidden `<textarea>` +
     `execCommand('copy')`; never throws, resolves to whether it copied). `lib/copyFormat.ts` (pure): file / branch /
     sha texts, `fenceFor`, `inlineCode`, `languageForPath`, `selectedDiffLines`, `buildSelectionCopy` (§5 format).
     Every copied text goes through `escapeSuspicious`, so invisible / bidirectional characters are copied as the
     visible `⟨U+…⟩`. Feedback is a new `CopyToastHost` + `useCopyFeedback` + `CopyButton`
     (`components/CopyButton.tsx`), not the bulk toast: that one carries undo and bulk test ids, and generalising it
     would change its behaviour. The copy toast sits above the button that copied (T3's anchored "Copied!") or
     bottom-centre for menu and palette copies; failures say "Failed to copy: the clipboard is not available here".
     Adapted T3 Code code is credited in `scripts/credits/acknowledgements.json`.
102. **Differences from the plan, after the status-flow merge.** (a) Scope words: the plan's `working tree` /
     `branch vs <base>` predate the new scopes; the header uses the toolbar's words lower-cased (`to review`,
     `uncommitted`, `staged`, `unstaged`, `branch vs \`main\``, `all on branch vs \`main\``, `commit \`a1b2c3d\``).
     The toolbar's `SCOPE_LABELS` moved to `lib/scopeLabels.ts` so both share one table. (b) A rename's Markdown
     header names the old path: `` `new.ts` (renamed from `old.ts`) L3 ``. (c) A selection of only deleted lines is
     labelled `old L10–12` (no `→ new`), with a `+N,0` hunk side. (d) In split mode a range that stays in one
     column keeps only that column's lines; in unified mode (or across columns) the range is the rows between the
     two ends in diff order (T3's behaviour). (e) No `contracts:` change: the new elements use plain `data-testid`s
     (`copy-toast`, `copy-selection-bar`, …), as plan §7 allows.
103. **Step 2: names and paths, where they landed in the merged UI.** A "Copy" group (separator, then Copy branch
     name / Copy worktree path / Copy commit id (`a1b2c3d`)) closes the sidebar worktree menu, below the review and
     policy items; the same group is in the Overview's worktree rows (right-click, after "Open changes") and on the
     Inbox file list's group headers. File rows (list and tree) get a right-click menu: Copy path / Copy old path
     (renames) / Copy file name / Copy absolute path (a tree directory row offers its path and absolute path). The
     diff header gets T3's copy-path icon button next to the path, and a ⋯ button (also the header's right-click)
     with every file item plus the worktree group. The toolbar's commit select gets a copy button for the selected
     commit id. Palette: Copy branch name / worktree path / file path / file name / absolute file path, in a new
     "Copy" command group. Shared item builders: `components/copyMenu.ts` (`COPY_TEST_IDS`).
104. **Plan items changed or dropped.** (a) The sidebar hover card's `Path` line has no copy button: the card is
     `pointer-events: none` and closes when the pointer leaves the row, so nothing in it can be clicked; the row menu
     has "Copy worktree path". (b) "Copy commit id" copies the full 40-character id (unambiguous in any repository,
     accepted everywhere git takes a commit); the label shows the short one. (c) The diff header's branch label stays
     text: its copy actions are in the ⋯ menu next to it, rather than a second control on the label. (d) Palette
     copy commands are *hidden* without an open worktree / selected file (the palette has no greyed-out rows); run by
     a stale palette they show a notice ("No file selected."). (e) Copy toasts anchor at the menu's position (a
     menu item has gone by the time the copy resolves) or above the button that copied.
105. **ContextMenu changes.** `MenuItem.title` (the disabled "Copy branch name" says "Detached HEAD"). The menu's
     mount effect now depends on the position's x / y and reads `onClose` through a ref, so callers may pass an inline
     `onClose` (the tree's `renderContextMenu` does) without the menu re-focusing its first item on every render. The
     file list renders its menu outside the `listbox`, so the menu's arrow keys do not move the file selection.
106. **Spike (plan §4 step 3.2), Chromium via Playwright on the `live` fixture, `@pierre/diffs` 1.6.4.** (a) Line
     selection starts only on a line number (`requireNumberColumn`) or the gutter button. `start` / `end` are the
     line numbers of the side pressed and released; `side` / `endSide` are `deletions` for a deleted row and
     `additions` for added and context rows, the same in split and unified (`endSide` is omitted when equal). A drag
     from deleted line 29 to added line 3 gives `{start: 29, side: deletions, end: 3, endSide: additions}`, i.e.
     5 rows in diff order; `selectedDiffLines` resolves that correctly. In split mode the library highlights the
     whole row band across both columns, but a range pressed and released in one column keeps that column's lines
     (#102 d). (b) A native text drag on the code plus Ctrl+C copies **only the code text**, no line numbers and no
     `+` / `-` markers, in both modes (the gutter and markers are not selectable text), and keeps the visible
     `⟨U+…⟩` escapes, so no `copy` interception is needed. (c) Gotchas: a selection inside the shadow root shows on
     `document.getSelection()` with `isCollapsed: true` but `type: 'Range'` and a non-empty `toString()`, so "has a
     text selection" is tested with `type` + `toString()`; and a gutter drag does not clear an earlier text
     selection. Rule: the last gesture wins (a line selection removes the text selection; a later text drag keeps
     its native Ctrl+C). The library refuses `onGutterUtilityClick` together with `renderGutterUtility` ("Use only
     one gutter utility API"), so the gutter button is the library's default one (T3 does the same).
107. **Step 3: code selection.** `DiffRenderer` turns on `enableLineSelection` + `enableGutterUtility` when it gets
     `copyMeta` (the raw `<pre>` fallback and the placeholders have no selection), holds `{ file index, range }` and
     passes it back as `selectedLines`; per-file options are memoised and call through a ref, because new callbacks
     would make the library re-render every diff. A new `cacheKey` (patch hash + whitespace + context) drops the
     selection; another file remounts `DiffBody`. The Copy bar (`CopySelectionBar.tsx`: `N lines`, Copy, Copy as
     Markdown, close) appears below-right of where the pointer was released, inside the diff area; on scroll it
     docks to the bottom-right corner. It never takes focus (`mousedown` prevented, buttons `tabIndex=-1`); Esc or
     the close button clears. Ctrl/⌘ C with a line selection and no text selection copies the plain code (outside
     inputs). `copyMeta` comes from the diff pane (selected row, project, scope, default branch).
108. **Gutter button stays the library's "+".** T3 uses the same default button (its comment affordance). A copy
     glyph through `renderGutterUtility` was tried and dropped inside the spike's time box: the library rejects it
     next to `onGutterUtilityClick`, and on its own the custom element did not appear on hover with `FileDiff`
     1.6.4 in a `Virtualizer`. Pressing the "+" (or any line number) and dragging selects lines; the title of the
     bar's buttons and the help dialog say what it is for. Follow-up if it confuses: swap the glyph once the library
     renders custom gutter utilities in this setup.
109. **Step 4 (polish), partly.** Done: "Copy file diff (patch)" in the diff header's `⋯` menu (the escaped patch,
     as shown); a `Ctrl/⌘ C` row in the help dialog and Settings → Keyboard (registry entry `copySelection`,
     group "Copy", hidden from the palette, handled by the renderer); README feature line and
     `docs/screenshots/copy-selection-{light,dark}.png`, written by a new `e2e/support/copy-screenshots.ts` (the
     shared `e2e/scripts/screenshots.ts` is untouched, so the other README screenshots were not regenerated and do
     not show the new header buttons yet). Not done: the Settings → copy toggles (Markdown header without the
     worktree path, absolute vs relative path in Markdown); the §5 format is fixed until someone asks.
110. **PLAN change: copy tools.** PLAN §4.2 gains a "Copy" paragraph and §8 items 19–23 (from `docs/COPY-TOOLS.md`
     §8). `docs/COPY-TOOLS.md` stays as the design record; #101–#109 record where the build differs from it.
111. **Flaky check, not from this round: git-core `test/readonly.test.ts` "never writes to any repository".** It takes
     ~2.4 s alone but 5.7–5.8 s when `pnpm test` runs every package in parallel, over vitest's default 5 s timeout.
     Measured on 2026-11-09: `main` (`1561c3c`, a temporary worktree) failed 1 of 3 `pnpm test` runs, this branch 1
     of 3; `pnpm check` on this branch failed 5 of 9 runs, always this one test. git-core is WS1's; proposal for its
     owner: give that test an explicit timeout (e.g. 30 s). Not changed here (AGENTS: edit only owned paths).

## Sidebar: "Hidden" shelf and the filter dropdown (lead, 2026-11-09)

112. **The sidebar filter is a dropdown with a search field, not a free-text box.** The user asked for it: a text
     box hides what you can filter by and matches substrings you have to guess. `SidebarFilter.tsx`: a trigger
     (funnel, a summary such as `alpha, dirty` or `All worktrees`, `/` hint, `×` to clear) opens a listbox under it
     with a search field (combobox, `aria-activedescendant`, as the command palette) over three groups: **Status**
     (Only dirty, Only unreviewed: the two chips moved in here), **Projects** and **Worktrees** (every row of
     `sidebar.byId`, so options stay listed while the filters hide their rows). Multi-select; arrows move, `Enter`
     or a click ticks, Escape clears the search then closes, an outside click or Tab away closes. Search is the
     palette's `fuzzyMatch`, best match first inside each group. Semantics: picked projects and worktrees are one
     union (a row shows when its project or the row is picked; none picked = all), the status options narrow it.
     `SidebarFilters` loses `text` and gains `projects` / `worktrees` (ids; transient state `filterProjects`,
     `filterWorktrees`, `filterOpen`, not persisted, like the old text). `/` (`focusFilter`) opens the dropdown,
     or focuses its search when open. Path substring matching is gone; T3 Code's pickers (branch, project) are
     the model.
113. **Contracts (test ids, additive plus one re-pointing).** New: `sidebarFilterSearch`, `sidebarFilterOption`
     (`data-kind`, `data-project-id` / `data-worktree-id`, `aria-selected`), `sidebarFilterClear`.
     `sidebarFilter` now sits on the dropdown's trigger and `onlyDirtyToggle` / `onlyUnreviewedToggle` on its
     status options (`aria-selected` instead of `aria-pressed`): the old elements no longer exist, and keeping the
     names keeps their meaning ("the sidebar filter", "the only-dirty control"). e2e gains `openFilter`,
     `closeFilter`, `setFilterOption`, `filterProject`, `clearFilters`; specs 01, 05, 06, 11 use them.
114. **"Settled" is now "Hidden" everywhere the user reads it.** #84 renamed the action (Hide / Show, "Hide until
     it changes") but the shelf header still said **Settled** and a project with nothing open said `settled`, so
     one concept had two names. The shelf is now **Hidden** (aria "Expand hidden" / "Collapse hidden") and the
     project word `hidden`. The shelf also holds rows that went there on their own (reviewed, clean, merged, review
     off, missing); "hidden" still fits, since the shelf is closed by default and each row keeps its reason word.
     Internal names (`state: 'settled'`, `settledOpen`, `settle` pref, `setSettle`) are unchanged, so stored prefs
     and the e2e `data-state` values keep working.
115. **Screenshots.** `e2e/scripts/screenshots.ts` adds `sidebar-filter-{light,dark}.png` (dropdown open, Only
     dirty and `alpha` ticked); every README screenshot was regenerated since the sidebar header changed.

## Dev hot reload: `pnpm dev` (session, 2026-11-09)

User request: one command for hot-reload development that stays reachable from the LAN host `odino`, without touching
the production LAN server (`octopus-diff-lan` unit, :7428). Report: `docs/reports/dev-hot-reload.md`.

116. **`pnpm dev` = `node scripts/dev.mjs`, a plain-Node supervisor of two children** (argv arrays, no shell, no new
     dependency): Vite from `apps/web` (HMR) and `tsx watch --conditions=@octopus-diff/source apps/cli/src/index.ts
     serve …` (the daemon from sources). Vite proxies `/api`, SSE included, to the daemon. Reason: the web app already
     had Vite with the source condition; the daemon had no watch mode, and tsx is already a root dev tool. tsx watch
     follows every imported file outside `node_modules`, workspace sources included (it resolves the `node_modules`
     symlinks to `packages/*/src`): edits to git-core, contracts and daemon files each restarted it in testing, so no
     `--include` globs are needed. Each child gets its own process group; SIGINT/SIGTERM/SIGHUP send one SIGTERM to
     each child (a second SIGTERM makes `serve` skip its clean shutdown, so the group is not signalled), SIGKILL to the
     groups after 8 s; if either child exits on its own the other is stopped and `pnpm dev` exits 1.
117. **Ports: daemon 7429, web 5173, 7428 rejected** with a message naming the production unit. The web port is
     strict in dev (the banner prints it, so Vite must not drift); both ports are checked before spawning so a taken
     port fails clearly instead of crash-looping under tsx watch.
118. **LAN by default, `--loopback` to opt out.** The daemon runs `--host :: --allow-non-loopback`; Vite listens on `::`
     (dual-stack like the daemon, rather than `0.0.0.0` which is IPv4 only). The daemon's Host check requires its own
     port unless the name is an `--allowed-host` entry, and the browser sends the Vite port, so the dev daemon gets
     `--allowed-host` for `localhost`, `127.0.0.1`, `odino`, `odino.local`, extra `--allowed-host` names and (LAN mode)
     this machine's non-internal IPv4 addresses, so `http://<lan ip>:5173/` works too. Vite's `server.allowedHosts` gets
     the same names (it allows localhost and IP literals itself). Only the existing mechanism is used; the Host/Origin/
     token checks are unchanged (an unknown Host gets 403 from Vite, a foreign Origin 403 from the daemon, no token 401).
119. **Separate state dir for the dev daemon: `$XDG_STATE_HOME/octopus-diff-dev` (`~/.local/state/octopus-diff-dev`),
     passed as `--state-dir`.** Reason: `serve` allows one daemon per state dir; sharing the production one, the dev
     daemon would print the production daemon's URL and exit. A `--state-dir` flag rather than `XDG_STATE_HOME` in the
     child env keeps the rest of the environment untouched; it sits beside the real state dir rather than in
     `~/.cache` so the dev token and review store survive cache cleanups. The config dir stays shared. A second
     `pnpm dev` on the same state dir is detected ("already running") and exits 1.
120. **The token URL is rewritten to the Vite port in a `[dev]` banner**, from the daemon's own `Open:` line (stdout
     only, nothing written to disk); the daemon's banner and its "built web UI not found" warning are hidden because
     they repeat on every restart and point at the daemon port. On a restart with the same token a one-line notice is
     printed instead. If no token is found, the banner points at `<state dir>/token`.
121. **`apps/web/vite.config.ts` reads `OCTOPUS_DIFF_WEB_HOST`, `OCTOPUS_DIFF_WEB_PORT` and
     `OCTOPUS_DIFF_ALLOWED_HOSTS`**; unset, the config is what it was (Vite's default host `localhost`, port 5173 with
     `strictPort: false`, default allowed hosts). `mock/dev.ts` passes its own host and port inline and is unaffected.
122. **Tests for `scripts/`:** the pure logic lives in `scripts/lib/dev-options.mjs`, tested by
     `scripts/test/dev-options.test.mjs` through `scripts/vitest.config.mjs`. Root `pnpm test` now runs
     `pnpm -r run test && pnpm run test:scripts` (the root is not a workspace package, so `pnpm -r` skips it). Plain
     `.mjs` keeps it out of `tsc` (no root tsconfig) like `scripts/credits`.
123. **The web client needed no change for daemon restarts.** A restart closes the SSE stream cleanly; the contract
     client retries after 1 s (backoff to 10 s while the proxy answers 502), and the `hello` on reconnect triggers a
     full refresh (`collectEventEffects` with `reconnect`). Verified in headless Chromium through `http://odino:5183`:
     status stayed `Live`, `/api/events` and every query refetched after each restart.
