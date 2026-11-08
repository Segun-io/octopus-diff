# fix-auth-v2 report

Branch `fix/auth-v2`, from `main` at `6f44f53`. Date: 2026-11-08. Implements auth v2 as decided in
`docs/DECISIONS.md` "Phase 2 — integration (lead)" entry 5. It also fixes security review findings
SEC-01, 02, 03, 04, 09, 10, 11 and 12 across the daemon, web, CLI, e2e and README. The read-only
guarantee and git access are untouched.

## Shipped

**Daemon** (`apps/daemon/src/app.ts`, `token.ts`, `security.ts`, `daemon.ts`)
- Every API route except `GET /api/health` needs `Authorization: Bearer <token>`. This includes
  `/api/events` and unknown `/api/*` paths. The comparison is constant-time (`tokensEqual`).
- The auth middleware and the `Sec-Fetch-Site: cross-site` rule are registered as Hono middleware on
  `/api` and `/api/*`. The router matches them on the same decoded path as the routes.
- Health is registered before the auth middleware, so its handler answers first. Any route
  registered after the middleware is protected.
- The daemon neither sets nor accepts the v1 cookie. A request that carries `octopus_diff_token`
  gets `Set-Cookie: octopus_diff_token=; Max-Age=0; Path=/; Expires=…1970…; HttpOnly;
  SameSite=Strict` on any response (API, health, static).
- Static UI files are public; `Host`/`Origin` checks still run on every request.
- A page load with a valid `?token=` gets `302` to the same path and remaining query, plus
  `#token=<token>`. No cookie is set. A wrong `?token=` gets the 401 sign-in page. `?token=` on an
  API path is never honored.
- `GET /api/health?challenge=<hex>` adds `proof = hex(HMAC-SHA256(token, healthProofMessage(challenge)))`
  (`healthProof()` in `token.ts`). A malformed challenge gets 400 (`HealthQuerySchema`).
- SEC-10: a path containing a percent-encoded unreserved character (`%41`–`%5A`, `%61`–`%7A`,
  `%30`–`%39`, `%2D`, `%2E`, `%5F`, `%7E`) gets 400 before routing. All path decisions use
  `c.req.path`, the path Hono routes on.
- SEC-11: in these cases the token file is **replaced** with a new token:
  - the file is readable or writable by group or others (`mode & 077`);
  - the file is owned by another uid.

  The new token goes into a new 0600 file renamed over the old one, so the inode changes. The
  daemon logs a warning saying old URLs and tabs stop working. An invalid token file is also
  replaced atomically.
- `DaemonHandle.authUrl` is `<url>/#token=<token>`.

**Web** (`apps/web/src/main.tsx`, `src/api/token.ts` (new), `src/api/queries.ts`, `src/api/hooks.ts`, one string in `App.tsx`, `mock/*`)
- Startup (`installTokenBootstrap()` in `main.tsx`):
  - moves `#token=` into `localStorage['octopus-diff.token']` and strips it with
    `history.replaceState`;
  - keeps other fragment parameters, and strips invalid values without storing them;
  - if a `#token=` is pasted into an open tab (fragment-only navigation), stores it, strips it,
    and reloads only if the token changed;
  - falls back to an in-memory token for this tab if `localStorage` is blocked.
- `createBrowserApiClient()` creates the contract client with that token and `credentials: 'omit'`,
  so no cookies are sent or stored.
- `useServerEvents` uses the contract client's fetch-based `subscribe` by default; EventSource is
  gone from production. Event handling, batching, reconnect backoff and `hello`-based reconnect
  detection are unchanged. A 401 on the stream sets `connection: 'offline'` and closes the
  subscription, since retrying with the same token can't succeed. The optional `factory` argument
  remains only as a test seam, so `App.tsx` props and `app.test.tsx` are unchanged.
- With no token, or on a 401, the existing "Not authorized" banner shows. Its text now points to the
  `#token=` URL printed by `octopus-diff serve` (and `octopus-diff status`).
- The mock router and server accept the bearer token only. `dev:mock` prints a hint when
  `MOCK_TOKEN` is set.

**CLI** (`apps/cli/**`)
- SEC-02/12: `verifyDaemon()` calls `health({ challenge })` with 32 random bytes and checks `proof`
  in constant time against `<stateDir>/token`. The token itself is never sent.
  - `status`, `add` (via `connectToDaemon`), `serve`'s already-running path (`findRunningDaemon`),
    `token --rotate` and `doctor`'s port check use it.
  - A daemon that can't prove the token gets no token, and no `#token=` URL is printed or opened
    for it.
  - `serve` then exits 1 instead of starting a second daemon on the same state dir (see
    Decisions).
  - `isProcessAlive` returns false on `EPERM`, which means another user's pid.
- SEC-03 (`which.ts`, new): `resolveExecutable()` uses only absolute `PATH` entries; it never uses
  the cwd or empty/relative entries.
  - Windows: case-insensitive `Path`, quotes stripped, tries `.exe`/`.com`.
  - Commands with a separator must be absolute.
  - Openers resolve through `resolveOpener()`, which prefers `%SystemRoot%\System32\rundll32.exe`
    on Windows and falls back to `/usr/bin/open` on macOS.
  - `doctor`'s `git --version` goes through `createRunProgram()`, which resolves first and fails
    with `ENOENT` if nothing is found.
  - Openers run with `cwd` = the 0700 state dir and a `PATH` reduced to absolute entries
    (`withSafePath`), so helpers that `xdg-open` itself starts can't come from a repository.
- SEC-04 (`open-browser.ts`): the tokenized URL is never on a command line.
  - Openers get `<stateDir>/open-<16 hex>.html`, created with `O_EXCL` and mode 0600. The page uses
    a meta refresh to the URL and has a link as fallback.
  - The file is deleted 60 s later (unref'd timer). Launchers older than 60 s are swept on every
    `--open` (this covers `status --open`, which exits before its timer fires).
  - On WSL, `powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command -`
    gets `Start-Process '<url>'` on **stdin**. The Windows browser can't read a Linux-home file
    without path translation. It falls back to `xdg-open <launcher>`.
  - `wslview` is no longer used: it needs the URL in argv, and its handling of Linux file paths
    can't be verified here.
- SEC-09 (`terminal.ts`, new; `logger.ts`):
  - `run()` wraps stdout and stderr in `safeOutput()`, which escapes the following as `\uXXXX`:
    C0 controls except tab and newline (CR included), DEL, C1, U+061C, U+200B–U+200F,
    U+2028–U+202E, U+2066–U+2069 and U+FEFF. JSON output stays valid and equivalent.
  - The logger prints a value raw only if it is printable ASCII without `"`/`=`. Anything else is
    JSON-quoted, with C1/bidi characters escaped too.
  - Repository-derived values in `add`, `status`, the banner and `token` go through `oneLine()`,
    which also escapes `\n`, `\r` and `\t`, so names can't fake extra lines.
- SEC-11: new command `octopus-diff token [--rotate]`.
  - Without `--rotate` it shows the token file path and mode, never the token.
  - `--rotate` writes a new 0600 token (atomic rename). If a verified daemon is running, it says
    that daemon keeps the old token until restarted. `doctor`'s fix for a loose token file is now
    `octopus-diff token --rotate, then restart the daemon`.
- URLs (`urls.ts`, new): `serve`, `status` and the already-running message print the `#token=`
  URL. For a wildcard bind they also print one `LAN:` URL per non-internal interface address:
  - IPv4 only for `0.0.0.0`; IPv4 and IPv6 for `::`;
  - IPv6 link-local addresses are skipped (browsers reject zone ids);
  - a note that LAN traffic is plain HTTP;
  - `status --json` gets a `lanUrls` field.
- Help texts updated for `serve`, `status` and the new `token` command.

**e2e** (`e2e/tests/08-auth.spec.ts` rewritten, `e2e/support/app.ts` comment): 14 tests, 8 over raw
HTTP and 6 in Chromium (listed under Verification).

**Docs**: README usage (the `#token=` URL, LAN URLs, `token --rotate`, the `open-*.html` file) and
the security model (bearer only, why no cookies, the health proof, the launcher, rotation, escaped
terminal output). CONTRIBUTING only mentions "the token" generically, so it is unchanged.

## Per finding

| Finding | Change | Tests | Residual risk |
|---|---|---|---|
| **SEC-01** cookie sent to every port | No cookie at all. Token in `localStorage` (origin-scoped) and sent as a bearer header; SSE over fetch. `?token=` redirects to a fragment; a stale cookie is expired. | daemon `auth.test.ts` (v1 cookie ignored even with the right token, expired on API/health/static, no `Set-Cookie` otherwise). web `token.test.ts`, `events-auth.test.tsx` (bearer on every request including SSE, `credentials: 'omit'`). e2e: browser has no cookies after `authUrl`/`?token=`; a planted cookie is expired by the first load; HTTP-level cookie tests. | Any script running in the UI's origin can read `localStorage` (accepted in DECISIONS #5; CSP has no `unsafe-inline` scripts). Other tabs that are already open keep their old token until reloaded. |
| **SEC-02** CLI sends the token to a squatter | Health challenge-response before any token use. `isProcessAlive`: `EPERM` means not ours. Unverified daemon: no token, no URL, `serve` refuses. | CLI `add-status.test.ts` (three squatter variants: no proof, wrong token, fake proof; fresh challenge per run; EPERM via a stubbed `process.kill`). `serve.test.ts` (verified already-running daemon; unverified one gets exit 1, no URL, no second daemon). `doctor.test.ts` (warn, no auth header). Manual run against a real squatter: it saw only `GET /api/health?challenge=…`, and the token appeared 0 times. | **Relay**: a squatter could forward our challenge to the real daemon on another port and replay its proof. This needs the real daemon running elsewhere while the CLI targets the squatter's port (normally `daemon.json` points at the real one). Fixing it needs a contract change (see "Requested doc changes"). |
| **SEC-03** bare-name spawns | Absolute resolution through absolute `PATH` entries only; `%SystemRoot%` rundll32; openers run from the state dir with a safe `PATH`. | CLI `open-browser.test.ts`: `PATH` filtering, relative commands refused, Windows rules, real spawn with a planted `./xdg-open` and `PATH=':.:relative/bin'` (never runs), opener `PATH` sanitized. | Windows and macOS were not run (logic is unit-tested with `path.win32`). |
| **SEC-04** token on the opener's argv | 0600 launcher file in the state dir, deleted after 60 s (stale ones swept); WSL uses PowerShell stdin. | CLI unit tests (no URL or token in any opener's args; launcher mode, content and deletion; stdin script). e2e runs the **built CLI** `status --open` with fake openers on a `PATH` containing only them: argv has no token, the launcher is 0600, and **Chromium follows `file://…/open-*.html` to the daemon and signs in**; the WSL path is checked through recorded stdin. | Whether the Windows browser keeps the `#token=` fragment through `Start-Process` was not verifiable without opening a real browser. The old `?token=` used the same path. If the CLI exits right after `status --open`, the launcher (same secret and permissions as `<stateDir>/token`) stays until the next `--open`. On macOS/Linux, if `.html` is associated with an editor rather than a browser, the editor opens the launcher. |
| **SEC-09** terminal escapes | Output filter on every CLI write, hardened logger, `oneLine()` for repo values. | CLI tests: logger with the review's OSC/CSI payload, C1, RLO; `terminalSafe`/`oneLine`; JSON stays valid; `status` with a hostile warning and project name; an error path through `run()`. | Characters outside the listed ranges (e.g. other invisible formatting characters) pass through. They don't drive the terminal. |
| **SEC-10** router vs middleware paths | Reject escaped unreserved characters; API rules are router-matched `/api` middleware; `c.req.path` everywhere. | daemon `auth.test.ts` (8 encoded paths with and without auth, `?token=` and cross-site; `//api/projects`, `/API/projects` and `/api%2Fprojects` never return API data; `/./api`, `/x/../api` and `/api//projects` get API rules). Unit test of `hasEncodedUnreserved`/`isApiPath`. e2e. | None known. |
| **SEC-11** token lifecycle | Exposed token file replaced, not chmod-ed; `token --rotate`; fragment URLs keep the token out of server logs, `Referer` and the address bar; no 400-day cookie. | daemon `units.test.ts` (modes 644/640/606/622 replaced with a new inode; private file kept). CLI `token-urls-terminal.test.ts` (rotate: new 0600 inode, never printed, running-daemon message). Manual check: 644 file replaced, old token 401, new 200; rotate while running, then restart. | A running daemon keeps the old token until restarted (documented). The pre-strip `/#token=` URL may be kept in browser history (Chromium session history is updated by `replaceState`; the history DB was not checked). On filesystems without POSIX modes (DrvFs `/mnt/c` without metadata), a state dir there would get a new token on every start. |
| **SEC-12** unauthenticated health | Health stays public (by design) but is no longer trusted: the proof is required before the token is used. | As SEC-02, plus daemon/e2e tests: proof correct, absent without a challenge, 400 for a malformed one, Host-checked. | Health still discloses versions and uptime (as designed). |

## Verification

All commands run from the repo root on this branch (Node 26.13.0, git 2.53.0, WSL2):

- Base check before any change (`6f44f53`): `pnpm check` green; `pnpm test:e2e` **36 passed**.
- `pnpm check` (final): exit 0, 13.4 s wall. Biome checked 226 files with no issues. Unit tests by
  package:

  | Package | Tests | Change |
  |---|---|---|
  | contracts | 58 | |
  | git-core | 98 | |
  | web | 49 | was 38: +9 token, +2 SSE/auth |
  | daemon | 97 | was 86 |
  | cli | 139 | was 108; includes the built-bin integration test |
  | fixtures | 48 | |
  | e2e vitest | 5 | |
  | **Total** | **494** | **0 failures** |

- `pnpm test:e2e` (final): **43 passed** in 1.2 min (was 36). Read-only proof: **12 control
  repos, 1652 lock polls, 0 violations**. The `08-auth` spec has 14 tests:
  - HTTP (8): health proof; bearer on every `ROUTES` entry plus SSE (none, wrong token, v1 cookie);
    public static assets with a Host check and no `Set-Cookie`; stale cookie expired; `?token=` to
    `#token=` and a wrong one refused; SEC-10; foreign Origin; foreign Host.
  - Browser (6): `authUrl` sign-in (token in localStorage, address bar clean, no cookies, the page's
    bearer fetch gets 200 and one without gets 401, reload and a new tab stay signed in); a v1
    `?token=` URL; a stale cookie in the browser expired; no token shows the banner, then pasting
    the URL into the tab signs in; a wrong `#token=` is stripped; SEC-04 launcher via the built
    CLI.
- Manual check with the built CLI. Commands: `node apps/cli/dist/index.js serve --port 0
  --state-dir <tmp> --config-dir <tmp>` (loopback, ephemeral port), then curl, CLI commands and a
  Playwright page. The temp dir was removed afterwards.
  - **Startup and health**
    - Banner prints `Open: http://127.0.0.1:41156/#token=<token file contents>`.
    - `/api/health` has no proof; with a random challenge, `proof` equals an independently
      computed HMAC.
  - **API and SSE**
    - `/api/projects`: no token → 401, wrong bearer → 401, bearer → 200, v1 cookie with the right
      token → 401.
    - `/api/events`: 401 without a token, 200 `text/event-stream` with it.
  - **Static UI and redirects**
    - `/` and `/assets/index-*.js` → 200 without auth, no `Set-Cookie`.
    - `/?token=<t>` → `302 Location: /#token=<t>`, no cookie; a wrong token → 401, no `Location`.
    - Any request with the old cookie gets the expiring `Set-Cookie`.
    - `/%61pi/projects` → 400; foreign `Host` → 403.
  - **CLI commands**
    - `status` prints the `#token=` URL; `token` shows the path and mode 600.
    - A second `serve` prints "already running" with the verified URL.
  - **Squatter**: a fake server answering health with a copied body and a fake proof. `status
    --open --port <squatter>` and `add` both refuse with the "could not prove" message. The
    squatter received only two `GET /api/health?challenge=…` requests and the token 0 times.
  - **Token file replacement (SEC-11)**: stopped the daemon, `chmod 644 token`, restarted. The
    token was replaced (mode 600, new inode) and a WARN line explains it; the old token gets 401,
    the new one 200.
  - **Rotation**: `token --rotate` while running prints the restart message. The running daemon
    still takes the old token (200; the new one gets 401) and `status` refuses until restart.
    After a restart the rotated token gets 200 and the previous one 401.
  - **Playwright page**: opening the `#token=` URL leaves the address bar at
    `http://127.0.0.1:41156/` with no token. `localStorage` holds the token; cookies are `[]`; all
    4 API requests including `/api/events` carried the bearer header and none had a `Cookie`
    header; `data-ready=true`. A fresh context shows the `auth` banner mentioning `#token=`.
- WSL interop (harmless, no browser opened): `powershell.exe -Command -` spawned detached with
  stdin reads and runs a script (`Write-Output` → `detached-stdin-ok 42`).
- Not run: a wildcard bind (`--host 0.0.0.0`). The instructions limit binds to loopback, so LAN
  URLs are covered by unit tests with injected interfaces.

## Decisions

1. **Router-matched API middleware plus rejecting escaped unreserved characters** (SEC-10).
   Registering auth as `/api` middleware makes Hono apply it to exactly the paths it routes to the
   API. The 400 for `%61`-style paths is defense in depth; no client needs those escapes.
2. **Health is registered before the auth middleware**, and every other route after it. A route
   added after the middleware (e.g. by the UX round) is protected by construction.
3. **A wrong `?token=` gets 401, not a redirect.** Redirecting would overwrite a good stored token
   with a bad one. A correct one keeps the path and other query parameters in the redirect.
4. **The legacy cookie is expired on any response** whose request carries it, including health,
   static and rejected requests. This is harmless and drops the stale secret as early as possible.
5. **Token replacement also covers a token file owned by another uid**, besides group/other
   permission bits. Replacement is an atomic rename (new inode).
6. **The web client stops the event stream on 401** instead of retrying every ≤10 s. A token
   pasted into the open tab reloads the page only when it changed. This avoids reload loops and
   keeps Playwright's same-URL `goto` from reloading.
7. **`EventSourceFactory` stays as an optional test seam** in `useServerEvents` (default: the
   fetch-based `subscribe`). Removing it would change `App.tsx` props and `app.test.tsx`, which
   the UX round is editing.
8. **SEC-04 uses the launcher file** (suggested in the brief), except on WSL, where PowerShell
   reads the URL from stdin. `wslview` was dropped. Launchers are deleted after 60 s and stale
   ones swept, rather than keeping the CLI alive.
9. **Openers run from the state dir with a sanitized `PATH`**, not just resolved absolutely. This
   also covers programs the opener script itself spawns.
10. **SEC-09 escapes rather than deletes** (`\uXXXX`). The output stays informative, and JSON stays
    valid and equivalent. It is applied at the output boundary (`run()`), not per call site, plus
    `oneLine()` for repository values.
11. **`serve` refuses when the recorded daemon is alive and ours but fails the proof** (exit 1, no
    URL, no new daemon). The realistic cause is a token rotated while it ran. Starting another
    daemon would break "one daemon per state dir"; a squatter would need our own process to reuse
    the recorded pid.
12. **Token rotation requires restarting the daemon.** No live reload: that would need a new
    authenticated route (a contract change) or file watching. The CLI says so, and README
    documents it.
13. **LAN URLs**: IPv4 only for `0.0.0.0`, IPv4 and IPv6 for `::`, never IPv6 link-local. The
    browser is opened with the loopback URL.

## Contract changes

None. Everything used was already in `packages/contracts` (`AUTH_FRAGMENT_PARAM`,
`TOKEN_STORAGE_KEY`, `HEALTH_CHALLENGE_PARAM`, `healthProofMessage`, `HealthQuerySchema`,
`HealthResponse.proof`, `client.health({ challenge })`, `subscribe`). `AUTH_COOKIE_NAME` and
`AUTH_QUERY_PARAM` are still used, to expire the old cookie and to redirect old links.

## Known gaps

- The SEC-02 relay residual described in the table.
- Windows and macOS openers are unit-tested only.
- Not verified with a real Windows browser: that `Start-Process` keeps the `#token=` fragment (no
  real browser may be opened here).
- Already-open tabs don't notice a token change in another tab (no `storage` event listener);
  reloading picks it up.
- The CLI's "older octopus-diff" case: a v1 daemon (no proof) is refused by the new CLI until it
  is restarted. The message says so.

## Requested doc changes (for the lead)

- **`docs/DECISIONS.md`**, new Phase 2 entry "fix-auth-v2 implementation choices": the list under
  Decisions above. Highlights: router-matched `/api` middleware plus 400 for escaped unreserved
  characters (SEC-10); `serve` refuses an unverified recorded daemon; the launcher file with WSL
  PowerShell stdin, and `wslview` dropped; rotation needs a restart; the escape-not-strip terminal
  policy.
- **`docs/DECISIONS.md`**, proposal (not implemented, breaking): bind the health proof to the
  daemon's port to close the SEC-02 relay. For example, `octopus-diff-health:v2:<port>:<challenge>`,
  where the daemon uses its bound port and the CLI the port it connects to. It could be additive as
  a new optional `proofV2` field with an `apiVersion`-gated CLI check.
- **`docs/PLAN.md` §5.4**: replace "require a per-install random token (cookie / bearer)" with
  "bearer token only (`#token=` bootstrap into localStorage; static UI public; health
  challenge-response)".

## Notes for integration

Existing files edited on this branch:

- Daemon:
  - `apps/daemon/src/app.ts`: middleware block, health route, static handler, imports.
  - `apps/daemon/src/daemon.ts`: `authUrl`, the `replaced` token log, import.
  - `apps/daemon/src/security.ts`: added `isApiPath`, `hasEncodedUnreserved`.
  - `apps/daemon/src/token.ts`: rewritten.
  - `apps/daemon/test/auth.test.ts`: rewritten.
  - `apps/daemon/test/static.test.ts`, `apps/daemon/test/units.test.ts`.
- Web:
  - `apps/web/src/main.tsx`, `apps/web/src/api/hooks.ts`, `apps/web/src/api/queries.ts`.
  - `apps/web/src/App.tsx`: one string, the `?token=…` hint in `ErrorBanner` becomes `#token=…`.
  - `apps/web/mock/dev.ts`, `apps/web/mock/router.ts`, `apps/web/mock/server.ts`.
- CLI:
  - `apps/cli/src/args.ts`, `cli.ts`, `deps.ts`, `logger.ts`, `open-browser.ts` (rewritten),
    `runtime.ts`.
  - `apps/cli/src/commands/add.ts`, `daemon-client.ts`, `doctor.ts`, `serve.ts`, `status.ts`.
  - `apps/cli/test/add-status.test.ts`, `doctor.test.ts`, `helpers.ts`, `integration.test.ts`,
    `live-http.test.ts`, `open-browser.test.ts` (rewritten), `serve.test.ts`.
- e2e: `e2e/support/app.ts` (comment), `e2e/tests/08-auth.spec.ts` (rewritten).
- `README.md`.

New files:

- `apps/web/src/api/token.ts`, `apps/web/test/token.test.ts`, `apps/web/test/events-auth.test.tsx`.
- `apps/cli/src/which.ts`, `apps/cli/src/terminal.ts`, `apps/cli/src/urls.ts`,
  `apps/cli/src/commands/token.ts`, `apps/cli/test/token-urls-terminal.test.ts`.
- `docs/reports/fix-auth-v2.md`.

Merge hotspots:

- **`apps/daemon/src/app.ts` with ux-daemon's `wire:` commit** (getSettings, updateSettings,
  setReviewPolicy, bulkReview, undoReview):
  - Their routes must be registered after the auth `onApi(...)` middleware, as all existing routes
    are; that is where `route('listProjects', …)` now starts. Never before it, except `health`.
  - The `route` helper moved above `health`.
  - The `/api/*` 404 and static handlers stay last.
  - The daemon and e2e auth tests derive their route lists from `ROUTES`, so new routes are
    checked for bearer auth automatically.
- **`apps/web/src/api/hooks.ts` with ux-web/ux-daemon**: keep `useServerEvents`' default
  transport as the fetch-based `subscribe`, and keep the 401 → `sub.close()` branch in
  `subscribeViaFetch`. `EventSource` cannot send the bearer token.
- **`apps/web/src/App.tsx`**: one-line text change in `ErrorBanner`. If ux-web rewrote it, keep
  any sign-in hint free of `?token=`. The API client must come from `createBrowserApiClient()` (or
  `createApiClient({ token: readToken(), credentials: 'omit' })`).
- **`apps/web/src/main.tsx`**: `installTokenBootstrap()` must run before the first API request.
- `pnpm build` must run before `pnpm test:e2e`: e2e uses the built daemon, web and CLI. The SEC-04
  e2e test skips if `apps/cli/dist` is missing.
- No lockfile, dependency or contract changes.
