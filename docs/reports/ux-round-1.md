# UX round 1 — integration report (lead)

2026-11-08. Branch `lead/ux-foundation`. Brief and ownership: `docs/COORDINATION.md`; decisions: `docs/DECISIONS.md`
("UX round 1" #1–#22); stream reports: `ux-daemon.md`, `ux-web.md`, `ux-e2e.md`.

## What shipped

| Area | Result | Where |
|---|---|---|
| Identity | Octopus mark (round mantle, five unequal arms, slit eyes), ink-violet brand hue, wordmark, type/spacing/density tokens; favicons, apple-touch icon, 192/512 + maskable icons, `site.webmanifest`, `theme-color` metas, `(N) octopus-diff` title count, favicon dot | `docs/design/IDENTITY.md`, `apps/web/public/`, `docs/design/assets/` |
| Themes (prepared) | Themes are data compiled at build time; registry; `{mode, light, dark}` prefs with v1 migration; no flash (external `theme-init.js`); AA contrast unit test over every theme; Octopus Dark / Light / Contrast | `docs/design/THEMING.md`, `apps/web/src/theme/` |
| Settings | Six sections (General, Review, Appearance, Folders, Keyboard, About); daemon-shared review settings vs per-device prefs, labelled as such | `apps/web`, `apps/daemon/src/settings*.ts` |
| Mark all as verified | Worktree / project / folder / all, honours UI filters, undo (toast and Ctrl/Cmd+Z), stale-state guard, one `review.bulk` event | contracts `settings.ts`, `apps/daemon/src/{bulk-review,review-controls}.ts` |
| Review policy | worktree > branch > project > folder > default (one shared resolver); ON by default for anything new; disabled worktrees stay visible but leave `n`, badges, `onlyUnreviewed`, bulk | contracts `resolveReviewPolicy` |
| Shell / folder tier | Inbox > Folders > Projects > Worktrees, source chips, activity pulse, view registry with Overview, command palette, first-run states | `apps/web`, `docs/design/FOLDERS.md` (read-only folder views are design only) |
| Review findings handled | F2, F9, F10, SEC-05 (web) | `docs/reports/ux-web.md` |

## Verification (final tree, `lead/ux-foundation` after merging `main` at `f6478dc`)

Node 26.13.0, git 2.53.0, WSL2. All from real command output on the merged tree:

| Command | Result |
|---|---|
| `pnpm check` | exit 0. lint `Checked 306 files … No fixes applied`; typecheck + build every package; tests: contracts 71, git-core 126, web 95, daemon 147, cli 139, fixtures 48, e2e (vitest) 5 |
| `pnpm test:e2e` (specs 01–13) | **68 passed (2.3 m)**; `read-only proof: 12 control repos, 3325 lock polls, 0 violation(s)` |
| Bulk review latency (30 repos x 3 worktrees, 360 changed files, in-suite) | `all` cold 950 ms, warm 3 ms, undo 3 ms (target < 2 s); 18,090 files: cold 1486 ms (equal to the inbox's own cold aggregation) |
| `GET /api/projects`, `GET /api/inbox` before/after the daemon change | no measurable change (2.4 -> 2.6 ms; 4.0 -> 4.2 ms warm) |
| UI perf gate (ux-e2e, two bench runs vs `main` baseline) | cold first paint 1018 -> ~950 ms; idle CPU 0.38 -> 0.42 %; refresh write->UI p50 296 -> ~29 ms; **warm reload 67 -> ~178 ms (flagged)**; initial JS ~145 KB gz (125 before) |

## Seams found by integration (all fixed, each with a regression test)

1. **Inbox patching dropped the new `review` field** (`main`'s perf code rebuilt entries by hand): a review-disabled worktree
   would have regained review controls after the first live update. Fixed in `api/cache.ts`; test with a worktree-level disable.
2. **Escape did not close overlays** once the focused control was disabled or removed (four dialogs). Shared `useEscapeToClose`.
3. **zod's JIT probe violated the CSP on every page load.** zod runs jitless, pinned into one chunk.
4. **Migrated v1 prefs were never persisted as v2.**
5. Merge conflicts with `main`: `DECISIONS.md` (both appended), `api/cache.ts` (perf inbox patching vs `review.bulk`/`settings.changed`
   handling), `apps/daemon/src/app.ts` imports (auth v2 vs the new routes), `apps/daemon/test/auth.test.ts` (auth v2 removed the
   "sign-in hint" test; the new routes' guard test kept), `apps/web/src/main.tsx` (token bootstrap + themes import). No semantic
   conflicts in auth v2: the new routes sit behind the same middleware and the e2e auth specs pass with them.

## Open items

- **Warm reload +110 ms** (decision #22): attributed, not fixed.
- **Contracts follow-ups** (additive, not done): jitless zod inside `packages/contracts`; test ids for the sidebar context menu,
  bulk confirm dialog, add-project dialog and Overview buttons.
- **Not covered by UI tests:** the Overview's policy buttons, the `⋯` keyboard path to context menus, the palette's "mark all"
  and theme items, `reviewOffDisplay` dim/hide/show, auto-advance, confirm-before-bulk turned off.
- **Not built:** keyboard rebinding (Settings → Keyboard is read-only); Files/History views for a whole folder (designed in
  `docs/design/FOLDERS.md`, deliberately no UI and no daemon endpoints); undo tokens are memory-only (lost on restart).
- **Minor:** the activity pulse depends on the daemon bumping `summary.updatedAt` on every state change; the e2e log shows a few
  `git-core has been disposed` lines at fixture teardown (requests arriving while the fixture closes the daemon; all tests pass).
- README and screenshots refreshed from the real UI (`pnpm --filter @octopus-diff/e2e screenshots`).
