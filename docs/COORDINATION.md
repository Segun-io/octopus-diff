# Coordination — UX round 1 (identity, theming-ready, review controls)

> **Status: integrated (2026-11-08).** All streams merged on `lead/ux-foundation` together with `main` (auth v2,
> git-core and watcher fixes); `pnpm check` green, `pnpm test:e2e` 68 passed. Results, seams found and open items:
> `docs/reports/ux-round-1.md`. The rest of this file is kept as the record of how the round was split.

> Written by the lead on 2026-11-08, branch `lead/ux-foundation`. Two delegated sessions (both Claude Fable 5.1,
> effort high) work **in parallel** from this commit, each in its own git worktree. This file is their shared
> brief and the lead's merge plan. Anything not covered here: follow `AGENTS.md` and `docs/PLAN.md`.

## 0. Goal of the round

1. **Identity and design system**: a core identity (name treatment, logo, palette, typography), favicons and app
   icons, and a UI that feels designed rather than default. Informed by SproutGit's answers to the same design
   problems (see §3).
2. **Themes: prepare, do not build a theme zoo.** The architecture must make "add a theme" a one-file change,
   like t3.chat or VS Code. Ship only the brand light/dark pair plus at most one extra to prove the registry.
3. **Room to evolve toward read-only capabilities for a whole folder** (browse and inspect a folder, not just its
   diffs). Only the information architecture and extension points are built now (§3.3), nothing speculative on the daemon.
4. **Review QoL**: "Mark all as verified" (with undo), review **policy** (disable review per worktree, branch,
   project or folder; review ON by default for anything new), and a real **Settings** screen.

## 1. Streams, branches, ownership

| Stream | Branch | Owns (may edit) | Writes |
|---|---|---|---|
| **ux-web** (design + all UI) | `ux/web` | `apps/web/**` (minus reserved), `docs/design/**` | `docs/reports/ux-web.md` |
| **ux-daemon** (settings, policy, bulk review) | `ux/daemon` | `apps/daemon/**` (minus reserved), **new** files under `e2e/tests/` + `e2e/support/`, **new** files under `tools/fixtures/` | `docs/reports/ux-daemon.md` |
| **lead** | `lead/ux-foundation` → `main` | `packages/contracts/**`, `docs/COORDINATION.md`, `docs/PLAN.md`, `docs/DECISIONS.md`, `docs/BLOCKERS.md`, README, merges | integration report |

Rules specific to this round (they override AGENTS.md where they differ):

- **Contracts are frozen** (`642a116` is the seam). If you need a change, do not edit `packages/contracts`: work around
  it and list it under "Contract requests" in your report. The lead applies it.
- **Do not edit `docs/DECISIONS.md`, `docs/PLAN.md`, `docs/BLOCKERS.md`** (append-conflicts between parallel branches).
  Put decisions in your report's `Decisions` section (date, decision, reason); blockers in `Known gaps`. The lead folds
  them into DECISIONS.md at integration.
- **No new dependencies** unless unavoidable; if you add one, say why in the report (license MIT/Apache/BSD/ISC only,
  `pnpm --filter <pkg> add`). `ux-daemon` should need none. Do not hand-edit `pnpm-lock.yaml` (the lead re-runs `pnpm install`).
- Everything else in `AGENTS.md` applies: never ask the user questions, no `git push`/remotes/publishing, no secrets,
  read-only guarantee, commit often with `<area>: <what>`, end commits with the `Co-Authored-By` trailer your harness gives,
  never touch repositories outside this project and temp fixtures, verify with real command output.
- First thing in your worktree: `git branch -m <your branch>` then `pnpm install`.

### Reserved: other agents' work, do NOT touch (even if tempting)

| Path / area | Why |
|---|---|
| `review/perf` branch is **still running** and edits `apps/web/src/api/cache.ts`, `apps/web/src/api/hooks.ts`, `apps/daemon/src/{app,core,daemon,watcher}.ts` | You will conflict with it. In those files make only **minimal, additive, wiring-only** edits, each in its own small commit prefixed `wire:` so the lead can resolve the merge. Put real logic in **new files**. |
| Auth v2 implementation (contracts landed in `35e2ad7`; implementation unassigned): `apps/daemon/src/{security,token,static}.ts`, the token bootstrap in `apps/web/src/main.tsx` and wherever the web client obtains/sends credentials, `apps/cli/**` | Someone will implement bearer-only auth + `#token=` bootstrap. Do not change how the web app authenticates or how the daemon authenticates. Design for it: no cookies, no `?token=` anywhere in anything you write. |
| `packages/git-core/**` and `apps/cli/**` | Review findings F1, F3–F8 and SEC-03/04/09 are queued for others. |
| `docs/reports/review-*.md`, `docs/bench/**` | Review artefacts. |

Review findings that are **claimed** by this round: **F2** (the review toggle must key on the *displayed* diff's
`patchHash`, see `git show review/code:docs/reports/review-code.md`, section F2) is claimed by **ux-web**, because it
rewrites the review mutation path anyway. Nothing else from the review reports is in scope.

## 2. The shared behaviour spec (both streams implement exactly this)

Contract types live in `packages/contracts/src/settings.ts`; read it first. The **pure resolver
`resolveReviewPolicy` / `resolveReviewPolicyFromMap` in the contracts is the only implementation of the precedence
rule**: the daemon and the web mock both call it, so they cannot drift.

### 2.1 Review policy

- Levels, most specific first: **worktree > branch > project > folder > default**. `folder` = scan root
  (`Project.scanRootId`; explicitly added projects have none and skip that level). `branch` = (projectId, short
  branch name) of the worktree's *current* branch; detached worktrees skip it. `default` = `AppSettings.review.defaultEnabled`
  (initially `true`).
- **"Review ON by default for new repos, worktrees and branches" is the `default` level**: anything with no own
  override and no overridden ancestor inherits it, so new discoveries follow whatever the user chose. Flipping the default
  to `false` makes review opt-in everywhere that has no explicit setting. The Settings UI must say this in plain words.
- Effective policy is attached as optional `review: { enabled, source }` to every `WorktreeListItem` (in
  `GET /api/projects`) and every `InboxEntry`. Clients treat an absent value as enabled/`default` (older daemons).
- When **disabled**: the worktree is out of the review loop. Its changes are still listed and diffable (diff first).
  `GET /api/inbox?onlyUnreviewed=true` omits the whole worktree. UI: no review toggle, no unreviewed badges/counts, `n`
  skips it, bulk actions skip it (unless `includeDisabled`), a `review-off-badge` marks it.
- `PUT /api/review` (single mark) is always accepted; marks are per project, not per worktree.
- Overrides: `PUT /api/review-policy { target, enabled: boolean|null }` (`null` = remove the override, inherit again).
  The target must exist (`not_found` otherwise); a `branch` target needs an existing project but not an existing branch.
  Returns the full `SettingsResponse`. Overrides of a removed project (its project/branch/worktree overrides) and of a
  removed scan root are deleted with it. Otherwise overrides are kept (cheap, and a recreated worktree path gets its
  override back; ids are path hashes).
- `PATCH /api/settings` is a partial update, returns the full `SettingsResponse`. `revision` increases on every change
  of settings or overrides, is persisted, and is sent in the `settings.changed` SSE event (also to the caller; clients
  ignore revisions they already applied).

### 2.2 Bulk review ("Mark all as verified") and undo

- `POST /api/review/bulk` resolves the target **on the server** (`all` | `folder` | `project` | `worktree`) from current
  state, for the given `scope` (default `working`), and sets or clears (`reviewed:false`) the marks of every changed file
  with the file's current `patchHash`, using the same key as single marks `(projectId, scopeKind, rawPath ?? path, patchHash)`.
  Same file list logic as `GET .../files` (untracked, renamed, binary and too-large files included).
- `paths` is only valid with a `worktree` target (else `bad_request`). `expectedStateHashes[worktreeId]`: if present and
  not equal to the worktree's current summary `stateHash`, that worktree is skipped and listed in `stale` (the user never
  saw that state). Missing/prunable worktrees are ignored. Disabled worktrees are listed in `skippedDisabled` unless
  `includeDisabled`.
- `changed` counts mark rows actually created/removed (marks are per project, so identical patches in two worktrees of one
  project count once); `unchanged` counts files already in the requested state. Atomic (one SQLite transaction).
- One `review.bulk` SSE event (distinct `projectIds`), **not** one `review.changed` per file.
- `undoToken` (null if `changed` is 0): `POST /api/review/undo { undoToken }` reverses exactly the rows that call
  changed and emits `review.bulk` with the inverse `reviewed`; rows changed again since are left alone. Tokens are random,
  single-use, kept in memory only (lost on daemon restart), valid `BULK_UNDO_TTL_MS`, at most `BULK_UNDO_MAX_ENTRIES`
  (oldest dropped). Unknown/expired/used token: `not_found`.
- Performance target: `all` on the 30 repos x 3 worktrees x ~200 files dataset in well under 2 s without spawning git per
  file (reuse the aggregation the inbox already does); report the measured number.

### 2.3 Where settings live

- **Daemon, shared** (`settings` / `review_overrides` tables, SQLite migration v2): things that change what the daemon
  reports or what is shared between devices: review default + overrides.
- **Browser, per device** (`localStorage['octopus-diff:prefs']`, versioned, migrate the existing keys): theme, density,
  layout, default scope, auto-advance, display preferences. The Settings screen shows which is which ("Saved on this
  device" / "Shared by the daemon").

### 2.4 Graceful degradation

The web app must work against a daemon **without** these endpoints (404 on `/api/settings`): hide policy/bulk/settings
controls that need them, keep everything else. This lets `ux-web` run the existing e2e suite on its own branch.

## 3. Stream briefs

### 3.1 ux-web (design + all UI) — the large one

Phases, in priority order. Commit after each; P0 must be green before P1.

**P0: foundation**
1. *Identity* (`docs/design/IDENTITY.md` + assets). The product is a calm, precise, technical tool for supervising many
   agents' work. Name `octopus-diff` (lower case). Concept to explore: many arms, one view; arms as diff lines. Deliver:
   mark (works at 16 px and in one colour), wordmark, palette, typography (system stacks only; CSP forbids remote fonts),
   spacing/radius/elevation/motion tokens, focus ring, density. Not cute; not generic blue (`#3d63dd` today). Brand hue
   must be clearly distinct from the semantic add/delete/modified/warn/danger hues and distinguishable by colour-blind users
   (never rely on colour alone; +/- glyphs and icons stay). Every text/background pair used must meet WCAG AA (4.5:1; 3:1 for
   UI components) in every shipped theme, **verified by a unit test** that computes contrast from the token values.
2. *Favicons and app icons* in `apps/web/public/` (served by the daemon at `/`; CSP is `img-src 'self' data:`): adaptive
   `favicon.svg`, `favicon.ico`, `apple-touch-icon.png`, 192/512 and maskable PNGs, `site.webmanifest`, `theme-color` metas
   (light/dark, updated on theme switch). Generate PNG/ICO reproducibly with a script in `apps/web/scripts/` (Playwright's
   Chromium is installed; see AGENTS.md for `LD_LIBRARY_PATH`) and **commit the outputs**. Render a contact sheet
   (`docs/design/assets/contact-sheet.png`: mark at 16/32/64/512 on light and dark) and look at it before declaring done.
   `document.title` shows the unreviewed count, e.g. `(12) octopus-diff` (user setting, default on).
3. *Theming, prepared* (`docs/design/THEMING.md`): token names from one source (`src/theme/tokens.ts`) → themes as data
   (`src/theme/themes/*.ts`, each a complete token map + `kind: 'light'|'dark'` + diff-viewer theme mapping) → registry →
   apply (`data-theme` attr + `.dark` class kept for Tailwind compat). Preference model `{ mode: 'system'|'light'|'dark',
   light: ThemeId, dark: ThemeId }` (migrate the old `theme` pref). No flash on load: `index.html` cannot use inline scripts
   (CSP `script-src 'self'`), so ship a tiny external `public/theme-init.js`. Unknown/removed theme id falls back safely.
   Tests: every theme defines every token; ids unique; contrast (above); fallback; prefs migration. Document "add a theme
   in one file". Ship Octopus Dark and Octopus Light, plus at most one more (e.g. high contrast).
4. *Settings plumbing + UI*: typed registry-driven Settings screen (opened with `,`, the sidebar gear, the palette). Sections
   `general | review | appearance | folders | keyboard | about` (TEST_IDS `settingsDialog`, `settingsSection[data-section]`,
   `settingsReviewDefault`, `themePicker`/`themeOption`). Review: the default switch (explain the inheritance in one sentence),
   and a table of all overrides (target label, state, remove). Folders: scan roots (list, add, rescan, remove; depth) and
   projects. Keyboard: generated from the command registry. About: version, git version, watcher mode (`/api/health`).
   Client prefs worth having: theme/density, default scope for the Inbox, auto-advance to the next unreviewed file after
   marking, how review-off worktrees show in the Inbox (`dim` | `hide` | `show`), title count, confirm-before-bulk, tree vs list,
   diff layout/whitespace defaults. New API hooks go in **new files** (`src/api/settings.ts`).
5. *Mark all as verified*: `markAllButton` (file-list header: "Mark N visible as verified" respecting the current filters via
   `paths`, in the Inbox: all, with counts), also in sidebar context menus (worktree/project/folder), the palette, and
   `Shift+R`. Sends `expectedStateHashes` from the cached summaries. Shows `bulkReviewToast` with `bulkReviewUndo`
   (also Ctrl/Cmd+Z while visible) and says what was skipped ("2 skipped: review off", "1 changed meanwhile"). The inverse
   ("mark all unreviewed") exists in the same menus. Handle `review.bulk` and `settings.changed` events (small `wire:` edits
   in `api/cache.ts`/`hooks.ts`).
6. *Review policy UI*: `reviewPolicyChip` for the selected worktree (shows on/off and where it comes from) opening
   `reviewPolicyMenu` with `reviewPolicyItem`s for worktree / branch (named) / project / folder, each On / Off / Inherit;
   `reviewOffBadge` in the sidebar; Settings → Review lists every override. Fix **F2** here.
7. *Mock backend parity* (`apps/web/mock/`): implement every new route and event with the contract's resolver and the
   semantics in §2, so the UI is developed and tested against it.

**P1: shell and information architecture** (SproutGit-informed, §3.3)
8. Sidebar hierarchy `Inbox → Folders (scan roots) → Projects → Worktrees`, with a "Added directly" group for projects
   without a scan root; collapsible, persisted; a folder row aggregates repos / dirty worktrees / unreviewed files and has
   the same actions as projects. Worktree rows: main checkout vs linked clearly distinct, a **source chip** inferred from the
   path (`.t3/worktrees`, `.claude/worktrees`, `.codex`, conductor, else plain; presentation only, no agent integration),
   branch, ahead/behind, compact change counts, review-off badge, and a live **activity pulse** when the worktree changed in
   the last ~10 s.
9. Main pane **view registry**: `ViewDefinition { id, label, icon, appliesTo(selection) }`. Only `Changes` is real for a
   worktree; selecting a folder or project shows an **Overview** (stats per project/worktree, bulk actions, policy). Future
   read-only views (Files, History) plug in without touching the shell (§3.3). Do not show non-functional tabs.
10. **Command palette** (Ctrl/Cmd+K, `commandPalette*` ids): jump to any folder/project/worktree, run any command from
    the existing registry, open Settings sections, switch theme, mark all. Fuzzy, keyboard-only usable.
11. First-run and empty states with the mascot/mark; primary call to action is "Watch a folder" (scan root), then
    "Add a repository". Loading skeletons, consistent focus states, middle-ellipsis paths with tooltips, density tokens.

**P2: stretch** (only if P0+P1 are green): favicon dot when unreviewed changes exist; `Settings → Keyboard` rebinding.

**Constraints**: keep every existing `TEST_IDS` behaviour and shortcut working (e2e `01`–`08` must still pass on your
branch against the *old* daemon, run them and report); keep the perf budget in `docs/reports/web.md` (re-run
`pnpm --filter @octopus-diff/web perf` and report; no regressions); keep the initial JS budget (lazy-load Settings, palette,
Overview); accessible (roles, names, focus management, `prefers-reduced-motion`); no Node built-ins in `src/`.

### 3.2 ux-daemon (settings, policy, bulk review)

1. SQLite migration v2: `settings` (key/value JSON, plus a persisted `revision`) and `review_overrides`
   (target kind + keys, `enabled`, `updated_at`). New modules, e.g. `src/settings.ts`, `src/review-policy.ts`,
   `src/bulk-review.ts`; edits to existing files are wiring only (`wire:` commits, see §1).
2. Routes per `ROUTES` (`getSettings`, `updateSettings`, `setReviewPolicy`, `bulkReview`, `undoReview`), validated with the
   contract schemas, mapped to `ApiErrorBody` like the others; they must sit behind the existing auth and Origin/Host checks
   (add them to the auth test matrix, mutating routes included).
3. Attach `review` to `GET /api/projects` items and `GET /api/inbox` entries via the contract resolver (build the key map once
   per request); `onlyUnreviewed` omits disabled worktrees. No measurable cost on the perf bench (report before/after).
4. Bulk review and undo exactly as §2.2, including `stale`, `skippedDisabled`, `paths`, atomic transaction, single `review.bulk`
   event, in-memory undo store with TTL/size limit, and the performance target. Never spawn git per file.
5. `settings.changed` SSE after every settings/override change (revision persisted across restarts).
6. Cleanup of overrides when a project or scan root is removed.
7. Tests: unit (store, resolver wiring, undo store TTL/limits), route tests with `FakeGitCore`, real-git integration, restart
   persistence, concurrency (worktree changes during a bulk call → `stale`), auth matrix, and a proof that bulk review never
   writes to a repository (reuse the read-only proof harness). **API-level Playwright specs** in new files
   `e2e/tests/09-settings-policy.spec.ts` and `e2e/tests/10-bulk-review.spec.ts` (+ `e2e/support/*` helpers in new files) that
   drive the real daemon over HTTP; no UI assertions (the UI lands on the other branch; the lead and you extend them after merge).
8. Update `docs/reports/ux-daemon.md` with measured numbers (bulk latency, `GET /api/projects` and `/api/inbox` before/after).

### 3.3 Design direction: read-only capabilities for a whole folder (imagine, then prepare)

Today the unit of attention is a *diff*. The next unit is a *folder you watch*: a place where repos and worktrees live
(`~/code`, `~/.t3/worktrees`), plus, later, things that are not diffs at all: browsing the tree, reading a file at HEAD or in
the working copy, search, repo-less folders, history. Everything stays read-only. ux-web must therefore:

- make **Folder** a first-class node in navigation and state (it exists today as a scan root), with its own Overview;
- make the main pane a **registry of views per selected node**, with `Changes` the only implemented one;
- keep selection/URL-ish state shaped as `{ folder?, project?, worktree?, view, ... }` so a new view needs no shell changes;
- write `docs/design/FOLDERS.md`: the vision, which views would come (Files, File history, Search, Snapshot-diff for repo-less
  folders), how each would look in this shell, and the **daemon prerequisites and security model** it implies (only registered
  roots are ever readable; realpath containment and symlink rules as in `static.ts`; size caps; no write endpoints; same auth).
  Design only. Do not add daemon endpoints.

SproutGit (sproutgit.dev) answers these design problems, and we borrow the answer, not the product: (a) *isolation made
visible*: worktrees look like places, main checkout is "protected", managed vs external worktrees differ visibly → our
source chip, primary marker, folder tier; (b) *mission control*: one overlay for everything running → our Inbox plus the
activity pulse; (c) *command palette* → Ctrl/Cmd+K; (d) *works with zero agents* and honest empty states; (e) *light/dark
share one palette with full contrast* → shared tokens, AA test; (f) *undo for destructive actions* (they have reflog undo) →
our undo for bulk review marks; (g) *settings as a real screen, not a pile of toggles* → sectioned Settings; (h) *your tools,
your preference* → `GIT_EDITOR`-style respect for user choice → prefs, not opinions.

## 4. Merge plan (lead)

1. Wait for the running `review/perf` session to finish; merge it to `main` first (it owns `cache.ts`/`hooks.ts`/watcher).
2. Rebase/merge `lead/ux-foundation` (contracts + this file) onto that `main`.
3. Merge `ux/daemon`, then `ux/web` (`--no-ff`), resolving the expected hot spots: `apps/daemon/src/{app,core}.ts`,
   `apps/web/src/api/{cache,hooks}.ts` (all the `wire:` commits), `pnpm-lock.yaml` (re-run `pnpm install`).
4. `pnpm check` + `pnpm test:e2e` on the merged tree; then UI-level e2e for the new features (ux-daemon's session is
   continued for that, since it knows the API), fix seams, fold the reports' decisions into `docs/DECISIONS.md`, update
   PLAN.md and README, write `docs/reports/ux-round-1.md`.

## 5. Round acceptance (UX-1 …)

- UX-1 Bulk "Mark all as verified" works for worktree/project/folder/all, respects UI filters, is undoable, and never marks a
  state the user did not see (`stale`).
- UX-2 Review can be disabled per worktree/branch/project/folder; precedence worktree>branch>project>folder>default; disabled
  worktrees stay visible but out of `n`, badges, `onlyUnreviewed`, bulk.
- UX-3 Review is ON by default for anything new; the default is a setting; changing it applies to everything without an override.
- UX-4 Settings screen with the six sections; daemon settings persist across restart; browser prefs persist and migrate.
- UX-5 Identity: logo mark, palette, favicons/app icons/manifest, theme-color, title count; contact sheet reviewed.
- UX-6 Themes are data: adding one is a one-file change; two shipped themes pass the AA contrast test; no flash on load.
- UX-7 Folder tier + view registry + Overview + command palette exist; `docs/design/FOLDERS.md` written.
- UX-8 No regression: e2e `01`–`08` green, read-only proof green, perf bench and web perf within the previous budgets, `pnpm check` green.
