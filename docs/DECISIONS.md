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

(none yet)

## WS4 — fixtures, e2e, perf

(none yet)

## WS5 — CLI, packaging, docs, CI

(none yet)

## Phase 2 — integration (lead)

1. **2026-11-08 · `esbuild` build script denied** (`allowBuilds: esbuild: false`). `tsx` (root dev dep)
   pulls `esbuild`, whose postinstall only validates/optimizes the binary; the prebuilt
   `@esbuild/linux-x64` package is used. Without the entry, pnpm 12 exits 1 on `pnpm install` even though
   the install completes (reported by WS5). Verified: `pnpm install` exits 0 and `tsx` runs.
