# WS2 — daemon report

Branch `ws/daemon` (from `db5274c`). Owner paths: `apps/daemon/**`, `docs/`. **No contract changes.**

## Shipped

`@octopus-diff/daemon` exports `startDaemon` (satisfies the `StartDaemon` contract) plus test and
tooling exports (`createApp`, `DaemonCore`, `EventHub`, `Store`, `WatcherService`, `hashId`,
`createLogger`, security helpers). Source map of `apps/daemon/src/`:

| File | What |
|---|---|
| `daemon.ts` | `startDaemon`: option validation (loopback-only unless `allowNonLoopback`, port), XDG dirs, 0700 state dir, token, SQLite, git-core, core, HTTP server (`node:http` + `@hono/node-server` listener), `close()` |
| `app.ts` | Hono app: security headers, Host/Origin/fetch-metadata checks, token auth (Bearer, cookie, `?token=` bootstrap + redirect), every route in `ROUTES` validated with the contract schemas, SSE route, static UI, JSON errors |
| `core.ts` | Registry (add/remove/PATCH, idempotent, linked-worktree paths resolve to their project), scan roots (background scans, `scan.progress`, rescan, removal, exclusions), startup reconciliation (vanished repos reported as missing and retried), worktree relist (`worktree.added/removed`), single-flight summaries, `worktree.changed` only on `stateHash` change, file-list cache, inbox, diffs, commits, review marks, focus, GC |
| `watcher.ts` | `@parcel/watcher` per worktree root + per common git dir, event routing via `GitCore.getWatchTargets`, 200 ms debounce (1 s max wait), polling fallback (30 s focused / 5 min; degraded 5 s / 30 s), inotify-limit detection and warnings, nested-worktree attribution |
| `events.ts` | SSE hub: `hello` first, ids `<bootId>.<seq>`, 1000-event replay buffer for `Last-Event-ID`, 15 s `: ping`, slow-consumer cut-off, in-process listeners |
| `store.ts` | `node:sqlite` store with versioned migrations: projects, scan roots, scan exclusions, `reviewed(project_id, scope_kind, path, raw, patch_hash, reviewed_at, last_seen_at)`; GC; scoped suppression of Node 22–24's SQLite ExperimentalWarning |
| `security.ts`, `token.ts`, `static.ts`, `logger.ts`, `errors.ts`, `paths.ts`, `ids.ts`, `coalesce.ts` | Host/Origin policy and CSP; token file (0600) and constant-time compare; traversal/symlink-safe static serving with SPA fallback; redacting JSON-lines logger; `GitCoreError` → `ApiErrorBody` mapping; XDG/`~` handling; scan-root ids; single-flight helper |

Behavior details and every judgment call are in `docs/DECISIONS.md` → "WS2 — daemon" (#1–#26).

## Verification

All commands at the repo root on `ws/daemon`, Node 26.13.0, 2026-11-08:

| Command | Result |
|---|---|
| `pnpm lint` | pass — `Checked 82 files … No fixes applied.` |
| `pnpm typecheck` | pass — all 7 packages `Done` |
| `pnpm test` | pass — daemon: **82 passed, 2 skipped (84)** in 9 files (8 passed, 1 skipped), ~4.1 s; other packages unchanged (contracts 57, fixtures 1, git-core 1, web 1, cli 1) |
| `pnpm build` | pass — contracts → git-core → daemon → cli, web (Vite) all `Done` |

Daemon tests by file: `auth` 14, `routes` 17, `registry` 11, `watcher` 10, `units` 16, `static` 7,
`events` 6, `live` 1, `integration.real-git` 2 (**skipped**: `describe.skipIf(!GIT_CORE_IMPLEMENTED)`,
the git-core placeholder exports `false`). The full daemon suite was run 5× in a row with no
flakes.

What the tests cover (all against a contract-valid in-memory `FakeGitCore` in
`apps/daemon/test/fake-git-core.ts`, real temp dirs under `os.tmpdir()`, real HTTP on
`127.0.0.1:0`, and the contracts' own `createApiClient` / `SseParser`):

- **Auth:** missing/wrong token → 401 (also wrong cookie, and `?token=` on the API); bearer and
  cookie accepted; `?token=` page load → 302 to the same URL without it + `HttpOnly;
  SameSite=Strict; Path=/` cookie; wrong `?token=` → 401 without cookie; foreign `Host`
  (incl. on `/api/health`, wrong port, rebinding names, userinfo) → 403; foreign/`null`
  `Origin` → 403 (incl. SSE and preflight); `Sec-Fetch-Site: cross-site` → 403; security
  headers present, no CORS headers; the token never appears in logs.
- **Routes:** every route in `ROUTES`, with responses parsed by the contract response schemas;
  validation errors (paths with `..`, absolute paths, bad ref names, `scope=commit` without sha,
  bad ids, bad limits, non-JSON, wrong content type → 415, body > 1 MiB → 413); `GitCoreError`
  mapping; review marks (mark, scope-kind isolation, `rawPath` keying, invalidation when the
  patch hash changes, unmark); inbox (dirty-only, `onlyUnreviewed`, `branch` scope); summary
  single-flight under 10 concurrent refreshes; file-list cache keyed by `stateHash`; focus.
- **Registry:** scan roots (background scan + `scan.progress` scanning/done/error, depth,
  idempotent re-add with deeper depth, rescan, exclusion of user-removed projects, removal
  removes discovered projects only), `~` expansion, linked-worktree and `.git` paths resolve to
  the project, **restart persistence** (projects, override, scan roots, review marks, token file),
  vanished repos reported as missing and restored when they come back, worktrees added/removed
  detected, startup `projects`/`scanRoots` options, **GC** (removed projects, 30-day unseen marks
  with an injected clock).
- **Watcher** (real `@parcel/watcher`, real temp dirs): debounce + burst coalescing, ignores
  (`node_modules`, `objects/`, `*.lock`, extra names), git-dir routing (linked index → that
  worktree only, main index → main only, refs → all, new `worktrees/<name>` → relist), nested
  worktree attribution, simulated inotify `ENOSPC` → `mixed` mode with a path-free warning and
  5 s polling, all-fail → `polling`, `forcePolling` / `enabled: false` never subscribe, focus
  cadence, unwatch + close release every subscription.
- **Done-when (fake git-core):** `test/live.test.ts` — start daemon, register two fs-backed
  repos (one with a linked worktree), edit a file from outside → SSE `worktree.changed` arrives
  in **< 1 s** (asserted; measured 151–152 ms in 5 runs with the 150 ms debounce the tests use;
  the default debounce is 200 ms), review,
  restart on the same state dir → registry and the review mark survive; editing again → event +
  unreviewed.
- **SSE:** hello first, ids, replay after `Last-Event-ID` (same boot only), heartbeats, clean end
  on close, auth required.
- **Static:** index + CSP, asset types/caching, SPA fallback vs asset 404, traversal (`..%2f`,
  `%2e%2e`, NUL, backslash) and symlink escapes (file and directory) never leak, auth required.

Additional checks (not committed):

- **Real-git dry run of the skipped integration test:** I temporarily ran
  `integration.real-git.test.ts` with `vi.mock('@octopus-diff/git-core')` pointing at a ~150-line
  scratch git-backed `GitCore` (temp fixtures only, isolated git config, `--no-optional-locks`),
  to validate the test itself and the watcher routing against real `.git` layouts. Both tests
  passed 5/5 runs (edit in a linked worktree → `worktree.changed` < 1.5 s, re-edit unreviews,
  untracked file, `git worktree add` → `worktree.added`, restart keeps marks, `.git/index` mtime
  and HEAD unchanged by daemon reads; scan root discovery). The scratch files were deleted; the
  real test will run against WS1's implementation after the merge.
- **Built output on plain Node:** a script imported `apps/daemon/dist/index.js`, started it with
  `webRoot: apps/web/dist` and the placeholder git-core: `/api/health` ok (git `supported:false`
  as expected with the placeholder), `authUrl` → 302 + cookie, `/` served the UI, token file
  0600, state dir 0700, token absent from logs, process exited cleanly after `close()`.

## Decisions

See `docs/DECISIONS.md` → "WS2 — daemon" (#1–#26). The most consequential ones:

- Every route except `/api/health` needs the token, **static files included**; unauthenticated
  page loads get a sign-in hint page (#1). Cookie lifetime 400 days, no `Secure` (#2).
- `GitCoreError` → HTTP mapping, e.g. `not_a_repository` 422, `timeout` 504, `git_failed` 500 (#6);
  creates return 201/200, rescan 202 (#7).
- `worktree.changed` fires on the first summary and every `stateHash` change; failures use
  synthetic hashes `error:<code>` / `missing` (#9). List endpoints wait ≤ 2.5 s for first
  summaries (#10).
- Removing a scan root removes the projects it discovered; removing a scan-discovered project is
  remembered so rescans don't re-add it (#14). Vanished repos stay registered, reported missing,
  retried every 60 s (#15).
- Watcher routing, ignores, cadences and degradation (#18–#20).

## Contract changes

None.

## Known gaps

- **Real git-core not exercised in committed tests.** `test/integration.real-git.test.ts` (2 tests)
  is skipped until WS1 lands; it was validated against a scratch implementation only (above).
  Its assumptions about git-core: `resolveProject` accepts a linked-worktree path; worktree ids
  are `hashId(realpath(root))` and project ids `hashId(realpath(commonDir))`; a modified tracked
  file has status `modified`, a new file `untracked`; `patchHash` is identical across
  `listChangedFiles`, `getFileDiff`, and `getFileDiff` with `ignoreWhitespace`/`contextLines`;
  `detectedDefaultBranch` is `main` for a repo initialised with `init.defaultBranch=main`.
- **Changes inside ignored directories** (`dist`, `build`, `target`, `node_modules`, … at any
  depth) are only noticed by polling (30 s focused / 5 min). Tracked files there are rare but
  possible.
- **Nested worktrees** created after the outer worktree was subscribed are still walked by the
  outer subscription (events are attributed correctly; only extra inotify watches are spent).
- **Watch-root subscription cost** on huge trees is whatever `@parcel/watcher` needs to walk the
  tree once; there is no per-worktree watch budget yet — exhaustion degrades to polling.
- **No guard against two daemons on one state dir** (SQLite WAL + 5 s busy timeout keep the data
  safe; they would fight over the port first in the normal case).
- **`/api/health` warnings** intentionally omit paths; details are in the daemon log.
- **Injected `gitCore` is not disposed** by `close()` (caller owns it); the default one is.
- **Auth cookie is not port-scoped** (browser limitation), see DECISIONS WS2 #2.
- The UI CSP may need adjustment once WS3's real highlighter/worker setup exists (DECISIONS WS2 #5).

## Notes for integration

**Swapping in the real git-core:** nothing to change in the daemon. `startDaemon` calls
`createGitCore({ ...options.git, logger })` from `@octopus-diff/git-core` whenever
`options.gitCore` is not given. After merging WS1 (with `GIT_CORE_IMPLEMENTED = true`), run
`pnpm --filter @octopus-diff/daemon test`: the 2 tests in
`apps/daemon/test/integration.real-git.test.ts` un-skip automatically and must pass (they create
temp repos with an isolated git config and call `git worktree add` for fixture setup only). The
watcher relies on `getWatchTargets` returning the worktree's own `gitDir` (for linked worktrees
`<common>/worktrees/<name>`) and the realpath `commonDir`; `gitPaths` may include
`<commonDir>/worktrees` (it is treated as the relist trigger, not as per-worktree state).

**For WS5 (CLI):**

- `import { startDaemon } from '@octopus-diff/daemon'`; pass `host`, `port`, `allowNonLoopback`,
  `allowedHosts`, `stateDir`/`configDir` (or let XDG defaults apply), `webRoot` (absolute path to
  the built `apps/web/dist`; without `index.html` the daemon serves the API only and warns),
  `projects`, `scanRoots`, `watch`, `git`, `version` (your package version, shown in
  `/api/health` and `hello`), `logLevel` / `logger`.
- Print **`handle.authUrl`** (the only place the token appears); the daemon never logs it.
- `startDaemon` rejects with clear messages for non-loopback hosts without `allowNonLoopback`, an
  invalid port, and `EADDRINUSE` (`port N on HOST is already in use (is another octopus-diff
  running?)`). Startup `projects`/`scanRoots` failures are logged, not thrown.
- Call `handle.close()` on SIGINT/SIGTERM; it resolves once watchers, SSE, the server, git and
  SQLite are closed.
- `GET /api/health` is unauthenticated (still Host-checked): use it to detect a running daemon
  for `add`/`doctor`. Other CLI calls need `Authorization: Bearer <token>`, with the token read
  from `<stateDir>/token`.
- `watch.debounceMs` is clamped to 150–300. Watcher warnings mention `octopus-diff doctor`; the
  daemon reads `/proc/sys/fs/inotify/max_user_watches` / `max_user_instances` for its messages.
- Logs are JSON lines on stderr by default.

**For WS3 (web):** re-fetch everything on each `hello` (sent on every (re)connect); expect a burst
of `worktree.changed` right after daemon start and coalesce refetches; a `worktree.changed`
`stateHash` may be synthetic (`error:<code>`, `missing`); `summary: null` with `error: null`
means "not computed yet" (or a bare entry); keep all scripts in files (CSP forbids inline
scripts; inline styles, `blob:` workers and wasm are allowed).

**For WS4 (e2e/perf):** open `authUrl` in the browser to get the cookie. `startDaemon` accepts
`internal` knobs (`heartbeatMs`, `relistMs`, `maxWaitMs`, `initialSummaryWaitMs`,
`pollDegradedFocusedMs`, a watcher `subscribe` override, `now`), and the returned handle exposes
`hub.on(listener)` to observe events in-process.
