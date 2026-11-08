# octopus-diff MVP report

> Lead session, 2026-11-08. Covers Phase 0 (scaffold and contracts), Phase 1 (five parallel streams) and
> Phase 2 (integration, three reviews, fixes). State of `main` at the end of Phase 2: see `git log main`.
> Phase 3 (PLAN §6) needs the user and was not started. A separate "UX round 1" (started by the user in
> another thread, branch `lead/ux-foundation`) is in progress and not part of this report.

## Summary

The MVP works end to end: `pnpm install && pnpm build && node apps/cli/dist/index.js serve` prints a URL
that opens a three-pane, keyboard-first UI showing every registered repository and worktree, a
cross-project Inbox, five diff scopes, live updates in tens of milliseconds, and review marks that
invalidate when a file's patch changes. All 11 items of the PLAN §8 acceptance list pass on the final tree,
including the read-only proof (0 violations) and the performance targets with large margins. Three
independent reviews (code, security, performance) produced 31 items (11 code findings, 12 security findings, 8
performance prototypes) plus recommendations; all security findings
except one minor residual and all daemon/git-core correctness findings are fixed with regression tests;
four web-UI findings are handed to the UX round, which is rewriting that UI.

## Acceptance list (PLAN §8), final tree

| # | Item | Result | Evidence |
|---|---|---|---|
| 1 | Clean checkout → install → build → `serve` → open the printed URL | **Pass** | Fresh `git clone` into a temp dir: frozen install and build exit 0; `serve` prints `http://127.0.0.1:<port>/#token=…`; in headless Chromium the app is ready in 126 ms, the token moves to `localStorage`, the address bar is clean, no cookies are set, reload works; API without token → 401; SIGINT stops cleanly |
| 2 | Projects by path and by scan root, correct branch / ahead-behind / counts | **Pass** | e2e `01-projects` (4 specs) against a generated fixture set, checked against a git-derived oracle |
| 3 | Inbox lists every dirty worktree; diffs correct in split and unified | **Pass** | e2e `02-inbox-diff` (4) |
| 4 | All five scopes incl. untracked, renamed, deleted, binary, very large | **Pass** | e2e `03-scopes` (7), plus 126 git-core unit tests with real repos |
| 5 | External edit updates the UI within ~1.5 s, no reload, selection kept | **Pass** | e2e `04-live-updates` (5); bench: write → UI p50 29 ms, p95 38 ms |
| 6 | Reviewed → leaves unreviewed views → edit → returns → restart → persists | **Pass** | e2e `05-review` (3) |
| 7 | `n` across projects; every §4.2 shortcut | **Pass** | e2e `06-keyboard` (5) |
| 8 | Read-only proof: no `index.lock`, `.git/index` mtime and refs unchanged, allowlist | **Pass** | e2e `07-readonly` and the suite-wide proof: 12 control repos, ~1,700 lock polls, **0 violations**; allowlist and hostile-config unit tests in git-core |
| 9 | Requests without token or with foreign `Origin`/`Host` rejected | **Pass** | e2e `08-auth` (14 specs: raw HTTP and Chromium) |
| 10 | Perf on the 30-repo fixture | **Pass** | table below |
| 11 | typecheck, lint, unit and e2e green; README accurate | **Pass** | `pnpm check`: lint, typecheck, build, **549 unit tests**; `pnpm test:e2e`: **43/43** |

Unit tests by package: contracts 58, git-core 126, web 49, daemon 124, cli 139, fixtures 48, e2e helpers 5.

## Measured performance (30 repos × 3 worktrees = 90 dirty worktrees)

`pnpm --filter @octopus-diff/fixtures bench`, Ryzen 7 7800X3D (12 cores to WSL2), Node 26.13, git 2.53.0.
Other agent sessions were running during both runs, so treat single numbers as ±10–20 %.

| Metric | Target | First integration (`f777775`) | Final (`main`) |
|---|---|---|---|
| Time to first paint, cold | < 3 s | 1018 ms | **883 ms** |
| Time to first paint, warm reload | — | 67 ms | 72 ms |
| Idle CPU, daemon + git, 60 s average | single-digit % | 0.38 % | **0.38 %** |
| Idle CPU, worst 1 s interval (60 s window) | — | 15 % (108 % in a 330 s window) | **3 %** |
| Write → SSE `worktree.changed` p50 / p95 | < 1 s | 216 / 218 ms | **14 / 15 ms** |
| Write → UI update p50 / p95 | < 1 s | 296 / 298 ms | **29 / 38 ms** |
| Data downloaded per edit (6,000 dirty files) | — | 1.57 MB | 77 KB (perf review) |
| Opening a 10,000-line diff | — | 1.8–1.9 s, 1.7 s long task | ~0.11 s (perf review) |
| Daemon startup: listening / all summaries | — | 1044 / 1103 ms | 805 / 1312 ms |
| Daemon RSS after idle | — | 142 MiB | 138 MiB |

Startup is the one number that got worse. It is not a §8 target; the causes are measured in the fix
reports: git-core's attribute checks for untracked binaries (cold summaries +~100 ms in repos with a
`.gitattributes`), the watcher fixes' stat/ignore-file reads (+~27 ms), and machine load from other
sessions. At 100 × 3 the perf review measured first paint ~1.9 s and write → UI 36 ms.

## What was built

- **`packages/contracts`**: zod schemas for the data model, every route, SSE events with a shared
  encoder/parser, a typed API client (fetch-based SSE with bearer auth), the `GitCore` and `StartDaemon`
  seams, shared UI test ids, auth v2 constants and the health challenge.
- **`packages/git-core`**: one read-only runner (allowlist, pinned config, `--no-optional-locks`,
  pinned `--git-dir`/`--work-tree`, argv only, timeouts, output caps, concurrency 4 with per-repo
  queues), parsers, discovery and scanning, all five scopes with per-file patches and stable
  `patchHash`es, hostile-repo hardening (fsmonitor, filters, external diff, textconv, transports, forged
  worktree records, symlinks out of scan roots). Minimum git 2.31.
- **`apps/daemon`**: Hono HTTP + SSE (event ids, replay, heartbeats), SQLite registry and review store,
  `@parcel/watcher` with leading-edge refresh, debounce, jittered fallback polling, inotify-limit
  degradation, recycled-path handling, watch guards; bearer-only auth, Host/Origin checks, CSP.
- **`apps/web`**: three-pane React UI with `@pierre/diffs` (worker-pool highlighting) and a virtualized
  file list (`@pierre/trees` as an optional tree view), every §4.2 shortcut, live updates that patch the
  changed worktree in place, optimistic review marks, dark and light themes, accessible states.
- **`apps/cli`**: `serve`, `add`, `status`, `doctor`, `config`, `token --rotate`; config file with schema;
  serves the built UI; self-contained tarball (`pack:tarball`, verified locally, not published).
- **`tools/fixtures`, `e2e`**: seeded fixture generator covering every special case, agent simulator,
  read-only proof harness, 43 Playwright specs, perf bench and profiler, screenshot script
  (`docs/screenshots/`).
- **Docs**: README (install, usage, security model, limitations), CONTRIBUTING, CI workflow
  (`.github/workflows/ci.yml`, committed, never pushed), PLAN kept in sync, `docs/DECISIONS.md`
  (every decision with its reason), stream, review and fix reports in `docs/reports/`.

## Reviews and what happened to their findings

| Review | Findings | Outcome |
|---|---|---|
| Adversarial code review (`review-code.md`) | 11 (2 high, 3 medium, 6 low) | Fixed: F1, F3, F4, F5, F6, F7, F8, F11. Handed to the UX round: F2 (review toggle must key on the displayed diff), F9 (false "updated" banner on scope switch), F10 (tree-view `j`/`k` order) |
| Security review (`review-security.md`) | 12 (0 critical/high, 3 medium, 6 low, 3 info) | Fixed: SEC-01/02/03/04/06/07/08/09/10/11/12 (auth v2: bearer only, `#token=` bootstrap into port-scoped `localStorage`, health challenge-response, no token on argv, control-char escaping, token rotation, path normalization, `core.worktree` pinning, forged-worktree validation, scan containment, watch guards). Handed to the UX round: SEC-05 (warn on bidi control characters). Residual: the SEC-02 relay (proposal in DECISIONS Phase 2 #9) |
| Performance pass (`review-perf.md`) | 8 prototypes + recommendations | All 8 merged (P1–P8): latency −93 %, idle spikes gone, per-edit traffic −95 %, worker highlighting fixed (a CSP bug). Recommendations R1 (spawn helper: every `spawn` blocks the event loop ~2 ms) and R3 (cold inbox dominates first paint at scale) not done |

Every fix has a regression test that fails on the pre-fix code (counts in `docs/reports/fix-*.md`).

## What does not work, or is untested

- **Platforms**: tested only on Linux (WSL2) with git 2.53.0. git 2.31–2.52, macOS and native Windows
  are untested; browser openers on Windows/macOS are unit-tested only. The CI workflow has never run
  (no remote, by design).
- **Not published**: `npx octopus-diff` does not work yet (package is private; publishing is Phase 3).
- **Web UI findings pending in the UX round**: F2, F9, F10, SEC-05 (see above). Until F2 lands, pressing
  `r` in the brief window while the file list and the open diff refetch after an agent edit can mark
  the newer patch instead of the one on screen.
- **Submodules**: uncommitted changes *inside* a submodule are not reported (only its checked-out
  commit); non-absorbed submodules (`<sub>/.git` is a directory) are not watched, only polled.
- **Hash stability limits**: an untracked file's review mark survives `git add` only when adding does not
  convert content (CRLF `eol` rules, git-lfs, `ident`). After this upgrade every `stateHash` changes once
  and review marks on untracked files show as unreviewed once.
- **git-core repo-info cache (5 min)**: after a worktree is removed and re-added at the same path, the
  daemon re-watches it correctly, but the summary's in-progress indicator (merge/rebase) can use the old
  admin dir for up to 5 minutes.
- **Repository shapes**: dotfiles repos relying on `core.worktree` and separate-git-dir repos are shown as
  bare; copies in the working scope show as `added`; rename detection stops above 1000 candidates;
  split-index repos get `.git/sharedindex.*` mtimes bumped by git's own reads (content, index, refs and
  locks untouched); user-installed global filter drivers (e.g. git-lfs) still run, as plain `git status`
  would; non-UTF-8 file contents display lossily; non-UTF-8 worktree directory paths are unsupported.
- **Auth residuals**: the SEC-02 relay; an already-open tab does not notice a token rotated in another
  tab; the new CLI refuses an old (pre-auth-v2) daemon until it is restarted.
- **UI**: no picker for the branch-scope base (always the default branch); the "N unmodified lines"
  separators are not clickable (use "More context" / "Expand all"); tree-view rows carry no test ids.
- **Scale**: at 100 × 3 the cold Inbox takes 1.5–1.8 s of the ~1.9 s first paint; every git spawn blocks
  the event loop ~2 ms (perf R1, R3).
- **Two daemons on one state dir** are not prevented by the daemon itself (the CLI detects a running one).
- **Test timing**: the daemon suite has real-filesystem watcher tests with 5 s waits; one flaked under
  heavy machine load during integration and was fixed (the test raced a subscription).

## This machine (environment notes)

- **Chromium for Playwright**: system libraries were extracted user-locally (no sudo) to
  `~/.cache/octopus-diff-dev/chromium-libs/`. Proper fix: `sudo apt install libnss3 libnspr4 libasound2t64`
  (`docs/BLOCKERS.md`).
- **LAN exposure (user request)**: an instance runs from `~/.t3/worktrees/octopus-diff/lead-phase2` on
  port 7428 bound to `::`, with the Hyper-V firewall rule `octopus-diff-7428` (TCP 7428 from private
  ranges). From this PC use `http://127.0.0.1:7428/#token=…` (in `~/.cache/octopus-diff-dev/lan-url.txt`).
  Other devices could not connect in the user's test; a packet capture showed their packets never
  reached this PC (blocked upstream, e.g. client isolation or inter-VLAN rules). Same-PC access via the
  LAN IP needs `hostAddressLoopback=true` in `.wslconfig` (not done: needs `wsl --shutdown`). Remove the
  rule with `Remove-NetFirewallHyperVRule -Name octopus-diff-7428` (elevated) when no longer needed.
- **Worktrees**: the lead's integration worktree is `~/.t3/worktrees/octopus-diff/lead-phase2`
  (`lead/phase2`); stream, review and fix worktrees remain under `~/.t3/worktrees/octopus-diff/` for
  inspection and can be removed with `git worktree remove`.

## Key decisions (full list with reasons: `docs/DECISIONS.md`)

- Biome for lint and format, TypeScript 7, pnpm 12; workspace packages resolve to sources via a custom
  export condition, so typecheck and tests need no prebuild.
- Contract additions over the PLAN sketch: nullable ahead/behind measured against upstream or the
  default branch, list responses wrapped in objects, `rawPath` for non-UTF-8 paths, file modes, diff
  options that never change `patchHash`, focus/refresh/rescan routes, shared `TEST_IDS`.
- Read-only hardening beyond §5.5: `diff.autoRefreshIndex=false` (plain `git diff` rewrites the index
  even with `--no-optional-locks`), repo-local filter neutralization, absolute git binary, pinned
  `--git-dir`/`--work-tree`, `check-attr` allowlisted.
- Auth v2: bearer token only; `#token=` URL → `localStorage`; static UI public; health challenge-response;
  no cookies (they leak to every port on the host).
- All perf prototypes accepted, including a leading-edge refresh that deviates from §5.6's pure debounce.
- Coordination with the UX round: separate worktrees, `main` moved only by fast-forward, findings split
  by ownership (DECISIONS Phase 2 #6).

## Recommended next steps (Phase 3 needs the user; nothing here was started)

1. **Merge the UX round** (its orchestrator's plan in `docs/COORDINATION.md` on `lead/ux-foundation`):
   it brings F2/F9/F10/SEC-05. Hot spots for that merge: new daemon routes must be registered after the
   `/api` auth middleware (the auth tests cover new routes automatically); the web app must keep the
   fetch-based `subscribe` and the `#token=` bootstrap in `main.tsx`.
2. **Decide publishing and naming** (npm package, public repository, license holder), then run CI on
   GitHub and add macOS and older-git (2.31) jobs.
3. **Close the residuals**: port-bound health proof (contract v2), git-core cache invalidation for
   recycled worktree paths, watching non-absorbed submodules.
4. **Performance at scale**: a spawn helper process (perf R1, 4.6× faster spawns in a micro-benchmark)
   and a cheaper cold Inbox (R3) before targeting 100+ repos.
5. **Product backlog (PLAN §4.4)**: interdiff "since I last reviewed", comments exported as an agent
   prompt, open-in-editor links, a commit browser, desktop shell, remote access.
