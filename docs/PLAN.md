# octopus-diff — Project Plan

> Status: MVP complete (Phases 0–2, 2026-11-08): see `docs/reports/mvp.md`. Phase 3 needs the user. A UX round
> (identity, themes, settings, bulk review) is in progress on `lead/ux-foundation`, coordinated in `docs/COORDINATION.md` there.
> This file is the source of truth for every session working on the project. If reality disagrees
> with it, fix the code or update this file and log why in `docs/DECISIONS.md`. Never leave them out of sync.

## 1. Vision

A **diff-first, read-only git UI that shows many projects in one view**. Name: a nod to GitKraken, but
for diffs. Coding agents (Claude Code, Codex, Cursor, T3 Code, Conductor, …) edit code in many repos and
many git worktrees at once. The developer no longer opens an editor, but still needs to answer:

1. **What changed, across everything I have, since I last looked?**
2. **What exactly is the diff?**
3. **Where am I?** (repo, worktree, branch, ahead/behind, dirty counts)

octopus-diff answers those three questions in one window. It is deliberately **agent-agnostic**: it only
speaks git, so it works with any tool that edits files or creates worktrees.

### Principles

- **Diff first.** The diff is the main screen. Everything else is navigation toward a diff.
- **Many projects, one view.** The unit of navigation is a *changes inbox* across all repos and worktrees.
- **Read-only toward repositories.** octopus-diff never writes to a repo: no stage, commit, checkout, fetch,
  or even index refresh locks. (Its own app state, such as review marks, lives outside the repos.) This is
  enforced in code and tested, not just promised.
- **Worktree-first.** Agents live in worktrees. Worktrees are first-class, auto-discovered nodes.
- **Live.** Edits made by an agent show up without a reload.
- **Keyboard-first**, fast with 30+ repos.
- **Boring tech.** Shell out to the `git` CLI. Don't re-implement git.

### Non-goals (MVP and near term)

History graph, rebase / merge / conflict editors, staging / committing / pushing / discarding, PR hosting
or forge features, embedded editor or terminal, agent orchestration, auth against remotes. Other tools do
these well (lazygit, GitButler, forges). A read-only product also removes the riskiest class of bugs.

## 2. Locked decisions (from the user, 2026-11-08)

| Decision | Choice |
|---|---|
| Write capability | **Read-only** (no stage/commit/discard) |
| Delivery | **Browser app first**; desktop shell (Tauri/Electron) is post-MVP |
| Architecture | **Daemon + web UI** |
| Agent coupling | **Agent-agnostic**: git only, no agent integration in MVP |

Defaults chosen by the planner (change in `docs/DECISIONS.md` with a reason if you disagree):
MIT license, TypeScript everywhere, pnpm monorepo, Node ≥ 24 (dev machine has Node 26), CLI name `octopus-diff`.

## 3. Landscape (why build this)

No dominant open-source tool does a cross-repo, diff-first, agent-era review view. Nearest neighbors, all
small or single-repo: gitpane (multi-repo TUI/VS Code ext, MIT), overgit / Archipel / Detached / DiffDino
(young multi-repo clients), SproutGit (worktree-first Electron), difit (local web diff viewer, single repo),
Emdash / Paradev / Vibe Kanban (agent orchestrators with a secondary diff pane), GitButler (FSL license, not
OSI open source). Closed: GitKraken Workspaces, JetBrains multi-root Commit window.
Risk: agent hosts (T3 Code, Codex, Claude desktop, VS Code) may add similar panes. Mitigation: stay
agent-agnostic, fast, and review-state-centric (§4.3).

**License hygiene:** may reuse ideas from anything; may copy code only from MIT / Apache-2.0 sources with
attribution. Do **not** copy from GitButler (FSL), Zed, or Detached (GPL-3).

References to read (do not fork):
- T3 Code (`pingdotgg/t3code`, MIT): `apps/web/src/lib/diffRendering.ts` (parses raw patches with
  `parsePatchFiles`, caches by patch hash), `apps/web/src/components/DiffWorkerPoolProvider.tsx` (worker pool
  for highlighting), `apps/server/src/vcs/GitVcsDriverCore.ts` (git CLI usage: `diff --find-renames
  --no-ext-diff`, `diff-index -M --numstat -z HEAD`, `worktree list --porcelain`).
- VS Code git extension (`microsoft/vscode/extensions/git/src`, MIT): `git.ts` (CLI wrapper, status parser),
  `model.ts` (multi-repo discovery by scanning workspace folders).
- `@pierre/diffs` (Apache-2.0, https://diffs.com) and `@pierre/trees` (Apache-2.0, beta).

## 4. Product spec (MVP)

### 4.1 Concepts

- **Project** = a git repository (identified by its common git dir). Added explicitly or via a *scan root*.
- **Worktree** = main checkout or linked worktree of a project, from `git worktree list --porcelain`.
  If a user adds a linked-worktree path, resolve it to its project.
- **Scope** = which diff to show for a worktree:
  - `working`: working tree + index vs `HEAD` (default; includes untracked files as additions)
  - `staged`: index vs `HEAD`
  - `unstaged`: working tree vs index
  - `branch`: `HEAD` vs merge-base with the default branch (auto-detected, overridable per project)
  - `commit`: a single commit (`<sha>^..<sha>`; root commits handled)
- **Reviewed mark** = app-side flag keyed by `(projectId, scopeKind, path, patchHash)`. If the file's patch
  changes, the key no longer matches, so the file is automatically "unreviewed" again. This is the core
  agent-era feature.

### 4.2 UI

Three-pane layout, dark and light themes:

1. **Sidebar**: projects → worktrees. Each worktree shows branch, ahead/behind (local refs only), and
   counts (staged / unstaged / untracked / conflicted, +adds −dels). Filters: text filter, "only dirty",
   "only unreviewed". Top entry **Inbox** = every dirty worktree of every project.
2. **File list** (`@pierre/trees`): changed files for the selected worktree (or, in Inbox mode, grouped by
   project → worktree). Status icons, +/− counts, reviewed checkmark.
3. **Diff viewer** (`@pierre/diffs`): split / unified toggle, hide-whitespace toggle, collapsed unchanged
   regions, lazy rendering with virtualization for huge diffs, binary / too-large placeholders,
   rename display (`old → new`), submodule and symlink diffs shown sanely.

Toolbar: scope selector, split/unified, whitespace, "show reviewed" toggle, refresh indicator.

Keyboard: `j`/`k` next/prev file · `J`/`K` next/prev worktree · `n` next **unreviewed** file anywhere ·
`r` toggle reviewed · `s` split/unified · `/` filter · `g i` inbox · `?` help. All actions reachable
without a mouse.

Live updates: selection and scroll position are preserved when the underlying diff refreshes. If the open
file's patch changed, show a subtle "updated" banner and keep reading position where possible.

### 4.3 Differentiators (protect these)

1. Cross-repo **Inbox** ("what did my agents change?").
2. **Reviewed marks that survive and invalidate** correctly (patch-hash keyed).
3. **Worktree auto-discovery**, no agent integration needed (covers T3 Code `~/.t3/worktrees`,
   Claude Code `.claude/worktrees`, Conductor, Codex, hand-made worktrees).
4. **Live** updates via filesystem watching.

### 4.4 Post-MVP backlog (not for the first build)

Interdiff "since I last reviewed" (store the reviewed patch, show the delta), comments that export as an
agent prompt (difit-style), open-in-editor deep links, commit browser, desktop shell, remote access (Tailscale),
multiple machines, fetch-on-demand (opt-in write-ish), PR/CI status via `gh` (read-only).

## 5. Architecture

```
 browser ──HTTP/JSON + SSE──▶ octopus-diff daemon (Node) ──spawn──▶ git CLI ──▶ repos/worktrees
   (React, @pierre/*)            ├─ project registry + scan roots (SQLite, XDG state dir)
                                 ├─ watcher service (@parcel/watcher) → debounced refresh → SSE
                                 ├─ change aggregation (status + numstat per worktree)
                                 └─ review-state store (SQLite)
```

### 5.1 Tech stack (default; deviate only with a logged reason)

- Monorepo: pnpm workspaces, TypeScript strict, ESM. Tests: vitest (unit), Playwright (e2e).
  Lint/format: pick one of oxlint+oxfmt or biome in the scaffold and enforce in CI.
- Contracts: `zod` schemas, shared by daemon and web.
- Daemon: Hono + `@hono/node-server`. Events: **Server-Sent Events** (`/api/events`), since the client
  never sends commands over the stream. Storage: built-in `node:sqlite`. Config: XDG
  (`~/.config/octopus-diff/`, state in `~/.local/state/octopus-diff/`).
- Watcher: `@parcel/watcher`.
- Web: Vite + React + TypeScript, TanStack Query (data + SSE-driven invalidation), Tailwind CSS,
  `@pierre/diffs` (+ worker pool for highlighting, as in T3 Code), `@pierre/trees`.
- Distribution: `npx octopus-diff` / `octopus-diff serve`, serving the built web assets from the daemon.

### 5.2 Repo layout and ownership (ownership prevents merge conflicts between parallel sessions)

```
octopus-diff/
  AGENTS.md  CLAUDE.md(→ points to AGENTS.md)  README.md  LICENSE  docs/{PLAN,DECISIONS,BLOCKERS}.md
  packages/
    contracts/   shared zod schemas, types, API route + SSE event definitions   [owner: lead]
    git-core/    git runner, parsers, discovery, diff retrieval                  [owner: WS1]
  apps/
    daemon/      HTTP + SSE server, registry, watcher, review store              [owner: WS2]
    web/         React UI                                                        [owner: WS3]
    cli/         `octopus-diff` bin, config, packaging                           [owner: WS5]
  tools/
    fixtures/    scratch-repo + agent-simulator generator, perf bench           [owner: WS4]
  e2e/           Playwright tests                                               [owner: WS4]
```

### 5.3 Data model (initial contract; evolve additively in `packages/contracts`)

> Implemented in `packages/contracts/src/domain.ts`, which is authoritative. Additions relative to the
> sketch below are logged in `docs/DECISIONS.md` (#8–#15), e.g. nullable `ahead`/`behind` + `aheadBehindRef`.

```ts
type ProjectId = string;   // stable hash of the realpath of the common git dir
type WorktreeId = string;  // stable hash of the realpath of the worktree root

Project   { id, name, commonDir, mainWorktreePath, defaultBranch|null, addedAt }
Worktree  { id, projectId, path, branch|null, headSha, detached, isMain, locked, prunable, missing }
WorktreeSummary {
  worktreeId, branch|null, upstream|null, ahead, behind,
  counts: { staged, unstaged, untracked, conflicted }, additions, deletions,
  stateHash,            // changes whenever any file or its patch changes
  updatedAt
}
DiffScope =
  | { kind: 'working' } | { kind: 'staged' } | { kind: 'unstaged' }
  | { kind: 'branch'; base?: string } | { kind: 'commit'; sha: string }
ChangedFile {
  path, oldPath|null,
  status: 'added'|'modified'|'deleted'|'renamed'|'copied'|'typechange'|'untracked'|'conflicted',
  staged, unstaged, binary, additions|null, deletions|null,
  patchHash,            // hash of this file's patch text in this scope
  reviewed
}
```

### 5.4 HTTP API (draft; the contracts package is authoritative)

> Implemented in `packages/contracts/src/api.ts` (`ROUTES`) and `events.ts`. List responses are wrapped in
> objects (`{ projects }`, `{ files }`, …) and a few app-state routes were added; see `docs/DECISIONS.md`.

```
GET    /api/health
GET    /api/projects                           → Project[] (+ worktrees + summaries)
POST   /api/projects        { path }           → add repo (path may be a linked worktree)
DELETE /api/projects/:id
GET    /api/scan-roots   POST /api/scan-roots {path, depth}   DELETE /api/scan-roots/:id
GET    /api/inbox?scope=...&onlyUnreviewed=    → [{project, worktree, summary, files[]}]  (dirty only)
GET    /api/worktrees/:id/files?scope=...      → ChangedFile[]
GET    /api/worktrees/:id/diff?scope=...&path= → { patch: string, truncated, binary, ... } raw unified diff
GET    /api/worktrees/:id/commits?limit=       → recent commits (for the commit scope picker)
PUT    /api/review      { projectId, scope, path, patchHash, reviewed }   (app state only)
GET    /api/events                              SSE: worktree.changed {worktreeId, stateHash},
                                                project.added|removed, worktree.added|removed, scan.progress
```

Auth/safety: bind `127.0.0.1` by default; require a per-install random token as a **bearer token only** (no
cookies: the printed URL carries it as `#token=`, the UI moves it into port-scoped `localStorage`; static UI
assets are public; `/api/health?challenge=` proves token possession so the CLI never hands the token to an
impostor; see DECISIONS Phase 2 #5, #7) and validate
`Host` and `Origin` headers to defeat DNS-rebinding and cross-site requests from other browser tabs. The API
returns file contents of local repos, so treat it as sensitive. Binding to non-loopback needs an explicit flag.

### 5.5 Git invocation rules (read-only guarantee)

All git access goes through **one runner** in `packages/git-core`:

- Hard **allowlist** of subcommands: `status`, `diff`, `diff-index`, `diff-tree`, `rev-parse`, `rev-list`,
  `merge-base`, `worktree list`, `for-each-ref`, `symbolic-ref`, `show`, `cat-file`, `ls-files`, `log`,
  `config --get` (read forms `--get`/`--get-all`/`--get-regexp`; DECISIONS WS1 #2), `check-attr` (read forms
  `-z`, `--stdin`, `-a`/`--all`, `--cached`; `--source` rejected; DECISIONS Phase 2 #8). Anything else throws.
- After discovery, every invocation pins `--git-dir` and (with a work tree) `--work-tree`: repository
  `core.worktree` never selects which files are read (security review SEC-06).
  Unit-test that `add`, `commit`, `checkout`, `reset`, `apply`, `fetch`, `gc` are rejected.
- `--no-optional-locks` is not enough on its own: porcelain `git diff` rewrites the index when
  `diff.autoRefreshIndex` is on, so git-core pins it off (DECISIONS WS1 #4).
- Always `--no-optional-locks` (and env `GIT_OPTIONAL_LOCKS=0`) so a read never takes `index.lock` and never
  collides with an agent running `git`. Also `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `LC_ALL=C`.
- Always `--no-ext-diff --no-textconv` on diffs; prefer `-z` machine formats (`status --porcelain=v2 -z
  --branch`, `diff --numstat -z`, `worktree list --porcelain -z` when available). Treat repo config as untrusted.
- Per-call timeout and output byte cap; global concurrency limit (default 4) with per-repo queues; spawn with
  an argv array (never a shell string). Handle git's exit code 1 from `diff --no-index` (used for untracked
  files) as success.
- Support old-ish git gracefully (feature-detect; minimum documented in README).
- **Proof tests:** after a full e2e run, assert no `index.lock` was ever created, and that `git status`
  porcelain plus the mtime of `.git/index` and refs are unchanged in every fixture repo.

### 5.6 Watching and refresh

- Per worktree: watch the working tree (ignore `.git`, `node_modules` and cache/tool dirs by default;
  build-output dirs `dist`, `build`, `out`, `target`, `coverage` only where `.gitignore` / `info/exclude`
  ignore them, so tracked build output stays live; honor a configurable ignore list), plus that worktree's
  git dir files that matter (`HEAD`, `index`, refs, `worktrees/*`, `info/`, and submodule git dirs).
  Linked worktrees keep their git dir under `<common>/worktrees/<name>/`.
- Watch limits (security review SEC-07): never watch `/`, `$HOME` or its parents, top-level system dirs,
  the temp dir, or a folder containing the repo's git dir; at most 64 watched worktrees per project (the
  rest are polled); prunable records are not watched. Health warnings give counts and reasons, not paths.
- Leading-edge refresh (DECISIONS `review/perf` P3): a quiet worktree refreshes on its first event; later
  events in the window use the trailing debounce below.
- Debounce 150–300 ms per worktree, coalesce bursts, then recompute the summary; emit `worktree.changed`
  only if `stateHash` changed. Fallback poll (30 s focused / 5 min others) in case watchers miss events.
- Must degrade gracefully on inotify limits (WSL, big trees): log a clear warning and fall back to polling.
- Detect new / removed worktrees by re-running `worktree list` when git-dir `worktrees/` changes and on a
  timer.

### 5.7 Review state

SQLite table `reviewed(project_id, scope_kind, path, patch_hash, reviewed_at)`. `patchHash` = stable hash
(e.g. SHA-1 of the normalized per-file patch text). Reviewed state is looked up when building `ChangedFile`.
Garbage-collect rows for projects removed and for patch hashes unseen for 30 days.

## 6. Work plan

### Phase 0 — Scaffold and contracts (sequential, the lead session does this, ≈ first hour)

1. Verify toolchain (node, pnpm, git). `git init`, `.gitignore`, MIT `LICENSE`.
2. Scaffold the pnpm monorepo per §5.2 with working `build`, `typecheck`, `test`, `lint` scripts at the root
   and in every package (empty but green).
3. Write `packages/contracts` (zod schemas + types for §5.3/§5.4, plus a typed API client factory) and a
   `GitCore` interface that WS2 can code against before WS1 lands.
4. Write `AGENTS.md` (conventions, commands, the autonomous-operation rules in §7) and `CLAUDE.md` pointing
   to it. Create `docs/DECISIONS.md` and `docs/BLOCKERS.md`.
5. Initial commit on `main`. Delegates branch from this commit.

### Phase 1 — Parallel workstreams (one delegated session each, each in its own git worktree)

Each stream stays inside its owned paths. Contract changes are allowed only if **additive**; make them in a
small separate commit and log them in `docs/DECISIONS.md`. Each stream ends with: green typecheck/lint/tests,
a short report (what shipped, decisions, known gaps) committed as `docs/reports/<stream>.md`.

**WS1 — git-core** (`packages/git-core`) · effort: xhigh
Runner with allowlist and safety flags (§5.5). Parsers: `status --porcelain=v2 -z`, `diff --numstat -z`,
`worktree list --porcelain`, `for-each-ref`. Discovery: resolve a path to project + worktrees; scan a root
to depth N (skip `node_modules`, handle `.git` files for linked worktrees, no symlink loops). Default-branch
detection (`origin/HEAD`, fallbacks `main`/`master`/`trunk`). Diff retrieval for every scope including
untracked files, renames, binary, large files, root commits, submodules, symlinks, CRLF, non-UTF-8 paths.
Per-file patch splitting and `patchHash`. Tests run against real fixture repos created in temp dirs.
*Done when:* all scopes produce correct output on fixtures; the read-only proof tests pass; no `shell:true`.

**WS2 — daemon** (`apps/daemon`) · effort: xhigh
HTTP + SSE per §5.4 using `GitCore` (stub until WS1 merges, then swap). Project registry, scan roots, SQLite
store, watcher service (§5.6), summary/inbox aggregation with concurrency limits, review store (§5.7),
auth token + Host/Origin checks (§5.4), structured logging. Tests with vitest + temp repos.
*Done when:* start the daemon, register fixture repos, mutate files externally, and receive SSE
`worktree.changed` within ~1 s; restart preserves registry and review marks.

**WS3 — web UI** (`apps/web`) · effort: high
Everything in §4.2. Build against a mock server that implements the contract (MSW or a tiny fixture server)
so it does not wait on WS2. Integrate `@pierre/diffs` with the worker pool, `@pierre/trees`, keyboard
navigation, theming, SSE-driven refresh preserving selection, empty/error/loading states, large-diff
handling. Accessible (focus management, aria on tree and diff). Component and logic tests where valuable.
*Done when:* every keyboard shortcut works and the UI handles 30 worktrees × 200 files without jank.

**WS4 — fixtures, e2e, perf** (`tools/fixtures`, `e2e`) · effort: high
A generator that builds N repos (configurable) with linked worktrees, realistic histories, and an **agent
simulator** that edits, adds, renames, deletes files over time at random intervals. Playwright e2e covering
the MVP acceptance list (§8). Perf bench: 30 repos × 3 worktrees, report idle CPU, refresh latency,
time-to-first-paint. The read-only proof harness (§5.5) runs here too. Capture README screenshots.
*Done when:* e2e runs headless with one command and fails loudly on regressions.

**WS5 — CLI, packaging, docs, CI** (`apps/cli`, `README.md`, `.github/workflows`) · effort: high
`octopus-diff serve [--port --host --open --scan <dir>…]`, `add <path>`, `doctor` (git version, inotify
limits, config paths). Serve built web assets from the daemon, print the tokenized URL. Config file schema.
README (what / why / install / usage / security model / limitations), CONTRIBUTING, GitHub Actions workflow
(lint, typecheck, test, e2e) committed but **not pushed anywhere**.
*Done when:* clean checkout → `pnpm i && pnpm build && node apps/cli/dist/index.js serve` works.

### Phase 2 — Integration (lead)

Merge streams in dependency order (contracts → git-core → daemon → web → fixtures/e2e → cli) using
`--no-ff` merges on `main`; resolve seams; run the full acceptance list (§8); fix defects or delegate fixes.
Then run, as separate fresh sessions, in parallel: **(a)** adversarial code review of the whole MVP,
**(b)** security review of the daemon (token, Host/Origin, path traversal, command injection, repo-config
execution, symlink escapes), **(c)** performance pass against the bench. Triage findings, fix, re-run
acceptance. Write `docs/reports/mvp.md` (what works, what does not, next steps).

### Phase 2b — UX round 1 (2026-11-08, user-requested) — done, see `docs/reports/ux-round-1.md`

Identity and design system, theming-ready architecture, a Folder tier in the shell, "Mark all as verified" with undo, review
policy (per worktree / branch / project / folder, ON by default for anything new) and a real Settings screen. Two parallel
streams, `ux-web` and `ux-daemon`; brief, ownership, behaviour spec, merge plan and acceptance (UX-1…UX-8) are in
`docs/COORDINATION.md`; decisions in `docs/DECISIONS.md` ("UX round 1"). New contract surface: `packages/contracts/src/settings.ts`,
routes `/api/settings`, `/api/review-policy`, `/api/review/bulk`, `/api/review/undo`, events `review.bulk` and `settings.changed`.

### Phase 3 — After the MVP (needs user input; do not start autonomously)

Backlog in §4.4. Desktop shell. Naming / branding / public repo / npm publish.

## 7. Rules for autonomous sessions

These apply to the lead and to every delegated session.

1. **Never ask the user questions** (no AskUserQuestion, no "should I…?"). Decide using this plan. If the plan
   is silent, choose the simplest reversible option and log it in `docs/DECISIONS.md` (date, decision,
   reason). If something is truly blocked, record it in `docs/BLOCKERS.md`, then continue with other work.
2. **Stay in scope.** Edit only paths you own (§5.2) plus `docs/`. Don't refactor other streams' code; log
   needed changes instead.
3. **Outward-facing actions are out of bounds:** no `git push`, no remote creation, no publishing to npm, no
   posting anywhere, no use of the user's secrets or credentials, no network access except package
   installation from the npm registry and fetching public docs.
4. **Keep the repository safe.** Never run git commands that modify anyone's repos outside this project and
   its temp fixtures. Fixtures live under the OS temp dir (`mkdtemp`), never in the user's real projects.
5. **Verify, don't claim.** Run the build, typecheck, lint and tests, and report real results. If something
   fails or is skipped, say so in the report. Don't mark a stream done with red checks.
6. **Commit often** on your branch with clear messages; leave `main` to the lead.
7. Don't poll other sessions. Wait for notifications; use the orchestration tools' `next` guidance.

## 8. MVP acceptance list

1. Clean checkout → install → build → `octopus-diff serve` → open the printed URL.
2. Add three fixture projects (one with two linked worktrees) by path and by scan root; all appear with
   correct branch, ahead/behind, counts.
3. Inbox lists every dirty worktree; selecting a file shows a correct diff in split and unified modes.
4. All five scopes produce correct diffs, including untracked, renamed, deleted, binary, and very large files.
5. Editing a file in a worktree from outside updates the UI within ~1.5 s with no reload and preserves the
   user's selection.
6. Mark a file reviewed → it leaves the "unreviewed" views; edit it again → it returns; restart the daemon →
   marks persist.
7. `n` jumps to the next unreviewed file across projects; all keyboard shortcuts in §4.2 work.
8. Read-only proof tests pass: no `index.lock`, unchanged `.git/index` mtime and refs, allowlist enforced.
9. Auth: requests without the token or with a foreign `Origin`/`Host` are rejected.
10. Perf target on the 30-repo fixture: initial paint < 3 s, steady-state idle CPU low (single-digit %),
    single-file refresh < 1 s. (Targets, to be measured; report actual numbers.)
11. `typecheck`, `lint`, unit and e2e tests are green; README accurate.

## 9. Risks and mitigations

- **Watcher load / inotify limits (WSL, large trees):** conservative ignores, debounce, polling fallback, `doctor`.
- **`git status` cost on big repos:** concurrency limit, timeouts, cache by `stateHash`, avoid recomputing
  numstat unless status changed.
- **Huge diffs / minified files:** caps, placeholders, lazy loading, worker-based highlighting.
- **Index contention with agents:** `--no-optional-locks`; never write.
- **Local-file exposure through the web server:** loopback bind, token, Host/Origin checks, no write endpoints.
- **`@pierre/trees` is a beta:** isolate behind a small component so it can be swapped.
- **Hosts absorbing the feature:** keep the Inbox + review-state loop excellent and agent-agnostic.
