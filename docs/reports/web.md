# web report (WS3)

Branch `ws/web`, based on `db5274c`. Everything lives in `apps/web/**` plus this report and the
`WS3 — web` section of `docs/DECISIONS.md`. No contract changes.

## Shipped

**Three-pane UI** (`apps/web/src/App.tsx`), dark and light themes (follows `prefers-color-scheme`;
toggle persisted in localStorage):

1. **Sidebar** (`components/Sidebar.tsx`): Inbox entry (count of dirty worktrees) then projects →
   worktrees with branch (or `detached @ sha`), ahead/behind (hidden when null), staged/unstaged/
   untracked/conflicted counts, +adds −dels, unreviewed badge (current scope), in-progress operation,
   missing/locked/summary-error states. Filters: text (`/`), "Only dirty", "Only unreviewed".
2. **File list** (`components/FileList.tsx`): virtualized (fixed row height, only rows near the viewport
   mounted; every Inbox `file-group` container is rendered so counts stay exact), Inbox grouped by
   project → worktree with per-group unreviewed counts; status icon, +/−, reviewed checkmark,
   `old → new` for renames/copies. Optional **Tree view** for one worktree via `@pierre/trees`
   (`components/FileTreeView.tsx`, lazy chunk, kept in sync with j/k and clicks).
3. **Diff viewer** (`components/diff/*`): `@pierre/diffs` `FileDiff` per parsed file inside its
   `Virtualizer` (huge diffs mount ~100 line nodes), highlighting in a shared worker pool
   (`DiffWorkerPool.tsx`, adapted from T3 Code, MIT, attributed). Split/unified, hide whitespace
   (`ignoreWhitespace`), "More context" (+20) / "Expand all" (API `context`), placeholders with
   `data-kind` for `binary`, `too-large` (+ "Load anyway" → `full=true`), `truncated` (partial patch
   still rendered, last hunk header repaired), `submodule` (old → new commit), `symlink` (old → new target,
   typechange aware), `empty` (mode-only change, pure rename, empty file, whitespace-only with the
   toggle on, no selection) and `error`. Review toggle, "updated" banner.
- **Toolbar** (`components/Toolbar.tsx`): scope selector (working/staged/unstaged/branch/commit; commit
  picker from `/api/worktrees/:id/commits`), split/unified, whitespace, show reviewed, tree view,
  refresh indicator (`idle` / `refreshing` / `offline`; click = refresh now), theme, help.
- **Empty state** with add-project and add-scan-root forms (also in a dialog from the sidebar), scan
  progress from `scan.progress` events. **Error states**: daemon unreachable, 401/403 (explains opening
  the tokenized URL printed by `octopus-diff serve`), per-pane errors, stale-data banner.
- **Keyboard** (`state/commands.ts`): `j`/`k`, `J`/`K` (Inbox first), `n` (next unreviewed anywhere,
  wraps, switches worktree if needed), `r`, `s`, `/`, `g i`, `?`, plus `w`, `h`, `e`, `t`,
  `Space`/`Shift+Space`, `d`/`u`, `Esc`, and arrow keys in the file list. Never fires while typing.
- **Live updates** (`api/hooks.ts`, `api/cache.ts`): `EventSource('/api/events')` with a listener per
  `SERVER_EVENT_TYPES`; 60 ms batching; `worktree.changed` invalidates that worktree's files/diff/commits
  plus projects and inbox only (deduped by `stateHash`); `review.changed` patches caches; reconnect
  refetches everything. Selection and scroll positions survive refreshes; changed `patchHash` of the open
  file shows the `diff-updated-banner`. `PUT /api/focus` with the focused worktree (null when hidden).
- **Review marks**: `r` / button → `PUT /api/review` with optimistic update + rollback; reviewed files
  leave "unreviewed" views; marks keyed by `patchHash`, so an edited file returns automatically.
- **Accessibility**: listbox/option with `aria-activedescendant`, `aria-selected`, `aria-current`,
  `aria-pressed` on toggles, labelled regions/toolbar, modal dialogs with focus trap and focus restore,
  focusable diff scroll region, visible focus rings, `aria-live` notices.
- **All `TEST_IDS`** implemented with their documented data attributes (grep `TEST_IDS.` in `src/`).
- **Mock daemon** (`apps/web/mock/`): deterministic data generator (demo / large 30×200 / empty),
  fetch-style router validating inputs with the contract schemas, 127.0.0.1 Node server with SSE +
  heartbeats + a simulated agent editing files, review store, add project / scan root (with progress
  events), optional token auth. See `apps/web/README.md`.

Entry points: `pnpm --filter @octopus-diff/web dev:mock` (demo), `MOCK_DATASET=large … dev:mock`,
`… build && … preview:mock` (production build), `… test`, `… check:browser`, `… perf`.

## Verification

Run at the repo root on 2026-11-08 (Node 26.13.0):

| Command | Result |
|---|---|
| `pnpm lint` | `Checked 94 files … No fixes applied.` |
| `pnpm typecheck` | all 7 packages `Done` |
| `pnpm test` | all green; **web: 5 files, 37 tests passed** (~3.5 s); repo total 98 tests |
| `pnpm build` | all packages `Done`; web `✓ built in 1.14s` |

Web tests (`apps/web/test/`): `mock.test.ts` (every route through the validating contract client,
demo + large datasets, events, 400/401), `model.test.ts` (sidebar sort/filters, j/k with hidden files,
`n` ordering and wrap across projects, J/K, selection repair), `cache.test.ts` (optimistic review patch +
rollback, scope-kind isolation, stale-hash ignore, precise SSE invalidation, stateHash dedupe, reconnect),
`diffKind.test.ts` (placeholder classification for every special case, truncated-patch repair parsed by
`@pierre/diffs`), `app.test.tsx` (jsdom, real UI + real contract client + mock: ready state, TEST_IDS
attributes, empty state + add project, 401 banner, j/k/J/K/g i, r optimistic + n, n across projects,
s and no shortcuts while typing, `?`, placeholders incl. Load anyway, scope changes incl. commit,
whitespace, SSE refresh with banner and selection kept, reverted file hand-over, focus reporting).

Real browser (headless Chromium via `@playwright/test`, scripts in `apps/web/scripts/`):
- `browser-check.ts` against `dev:mock`: ready in 236–468 ms; every shortcut works; placeholders for all
  special files; Load anyway → truncated; live edit of the open file reflected **147 ms** after the
  mutation with the banner shown, selection kept and diff `scrollTop` 120 → 120; filter typing does not
  trigger shortcuts; no console errors/warnings.
- `perf.ts` against the **production build** with the large dataset (30 worktrees × 200 files =
  6000 files, 1.5 MB inbox JSON), 1440×900:

  | Measure | Result |
  |---|---|
  | First contentful paint / app ready | 68 ms / 348 ms; 0 long tasks during load |
  | `j` (keydown → second animation frame), 200 presses | p50 33.3 ms, p95 34.0 ms (i.e. next frame); 1 long task of 87 ms (first diff chunk/highlight) |
  | Scroll the whole inbox list (156,900 px, 261 frames) | frame p50 16.7 ms, p95 17.0 ms, max 19.1 ms; 0 frames > 50 ms; 0 long tasks; 49 rows mounted |
  | `J` through all 30 worktrees | p50 34 ms, p95 37 ms; 0 long tasks |
  | Live refresh in the Inbox (mutate → refetch inbox+projects → idle), 10× | p50 362 ms, p95 366 ms; 0 long tasks |
  | Open + scroll a 4000-line diff / 1 MB truncated diff | 0 long tasks; ~100 line nodes mounted; scroll frames p50 16.7 ms, max 17.1 / 19.7 ms |
- `csp-check.ts`: production build under the CSP in DECISIONS WS3 #14: no violations; 4 highlight workers
  started from `/assets/worker-*.js`; highlighted spans rendered. Without `style-src 'unsafe-inline'`
  Chromium blocks inline styles (so it is required).

Bundle (production, `apps/web/dist`): initial JS `index-*.js` 416 KB (125 KB gz) + CSS 19 KB (5 KB gz);
diff renderer chunk 334 KB (86 KB gz) on first diff; tree view chunk 244 KB (69 KB gz) only when used;
worker 46 KB (16 KB gz). Shiki grammars/themes are separate lazy chunks: `dist/` is 16.7 MB without
source maps (43 MB with), almost all of it never loaded.

## Decisions

Logged as WS3 #1–#14 in `docs/DECISIONS.md`. Highlights: own virtualized list as the default file list
(TEST_IDS, Inbox grouping) with `@pierre/trees` as an isolated optional tree view; inbox fetched once
per scope and filtered client-side; commit scope only for a selected worktree; sidebar filters also
filter the Inbox; context expansion via the API; extra shortcuts; SSE batching/dedupe; truncated-patch
header repair; worker-only highlighting; mock server instead of MSW (devDependencies `diff`,
`@playwright/test`); required CSP.

## Contract changes

None.

## Known gaps

- **Inbox refetch cost:** every `worktree.changed` refetches the whole inbox (1.5 MB for 6000 files,
  ~360 ms end to end with the mock, no long tasks). Fine for the target; a per-worktree inbox delta
  (e.g. reuse `/files` for the changed worktree and patch the inbox cache) would cut it.
- **Branch scope base** is always the project's default branch (no picker; the API supports `base`).
- **@pierre/diffs separators** ("N unmodified lines") are not clickable: in-place expansion needs full
  file contents the API does not return. Expansion is per file via "More context"/"Expand all"/`e`.
- **Tree view** rows live in `@pierre/trees`' shadow DOM, so they carry no TEST_IDS; the default list
  does. The Inbox always uses the list.
- **Non-UTF-8 paths** display with U+FFFD (as the contract provides) and are addressed by `rawPath`.
- jsdom tests stub the `@pierre/diffs` renderer (it needs real web components/workers); the real
  renderer is covered by the Chromium scripts, not by `pnpm test`.
- `pnpm install` prints `Ignored build scripts: esbuild@0.28.2` (pre-existing, root config; harmless here).
- Not run: WS4's Playwright suite (`e2e/`), which will exercise the UI against the real daemon.

## Notes for integration

- **Serving:** the daemon serves `apps/web/dist` at `/` (single page, no client routes, so no SPA
  fallback needed beyond `/` → `index.html`), assets under `/assets/` (immutable, hashed). Workers are
  module workers at `/assets/worker-*.js`; serve `.js` as `text/javascript`. Shiki grammar/theme chunks
  load lazily from `/assets/`.
- **CSP** (verified): `default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'
  'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none';
  base-uri 'none'; frame-ancestors 'none'`. No wasm, no `eval`, no blob workers needed.
- **Auth:** the UI uses same-origin requests with the cookie (`credentials: 'same-origin'`) and
  `EventSource(…, { withCredentials: true })`; it never sees the token. The `?token=` → cookie →
  redirect step must happen on the page load (DECISIONS #16). A 401 shows the "open the tokenized URL"
  banner.
- **API expectations:** `GET /api/inbox` for `working`/`staged`/`unstaged`/`branch` (the UI never asks for
  `commit`); `GET …/diff` honors `ignoreWhitespace`, `context` (up to 1,000,000) and `full`, and returns
  the canonical `patchHash` regardless of them; `patchHash` must match between `/files`, `/inbox` and
  `/diff`; `worktree.changed` should only be sent when `stateHash` changes (the UI dedupes anyway);
  `hello` on every (re)connect; `PUT /api/focus` is sent on view changes and visibility changes.
- Dev against a real daemon: `OCTOPUS_DIFF_API=http://127.0.0.1:7428 pnpm --filter @octopus-diff/web dev`.
  The Vite proxy forwards `/api` but keeps the browser's `Origin` (`http://127.0.0.1:5173`), so the
  daemon's Origin check will reject non-GET requests (review, focus) unless it allows the dev origin;
  cookies are shared across ports, so opening the tokenized URL on the daemon port once is enough for
  auth. Not tested against a real daemon (WS2 was not merged into this branch).
- Lockfile: `apps/web/package.json` gained devDependencies `diff@^9` and `@playwright/test@^1.65.0`.
