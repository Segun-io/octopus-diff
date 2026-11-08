# ux-daemon report — settings, review policy, bulk review with undo

Branch `ux/daemon` (from `ae48cb6`, lead/ux-foundation). Brief: `docs/COORDINATION.md` §2 and §3.2.
Owner paths touched: `apps/daemon/**`, new files under `e2e/tests/`, `e2e/support/`, this report.
**No contract changes** (the seam `642a116` is untouched). No new dependencies.

## Shipped

Everything in COORDINATION §3.2 (1–8). Daemon source map of the change:

| File | What |
|---|---|
| `apps/daemon/src/settings-store.ts` (new) | SQLite **migration v2**: `settings(key, value)` with the JSON documents `app` (AppSettings) and `revision`; `review_overrides(target_key PK, kind, scan_root_id, project_id, branch, worktree_id, enabled, updated_at)` keyed by the contracts' `reviewTargetKey`, with owner columns (worktree rows store their project id) so one statement deletes the overrides of a removed project or scan root. `SettingsStore` data access; `parseStoredSettings` merges a stored document with `DEFAULT_APP_SETTINGS`. |
| `apps/daemon/src/settings.ts` (new) | `SettingsService`: in-memory copy of settings, revision and overrides (loaded once, written through), `GET`/`PATCH` semantics, `setOverride(target, enabled \| null)`, `resolve()` = the contracts' `resolveReviewPolicyFromMap` over the cached key→enabled map (precedence is never re-implemented), `settings.changed` with the persisted revision, and cleanup hooks `onProjectRemoved` / `onScanRootRemoved`. |
| `apps/daemon/src/review-policy.ts` (new) | `ReviewPolicyProvider` interface the core depends on (optional), `policyInputFor(project, worktree)` (detached → no branch level), `validateReviewPolicyTarget` (`not_found` rules of §2.1). |
| `apps/daemon/src/bulk-review.ts` (new) | `ReviewSource` (the read-only view of the registry bulk review needs), `UndoStore` (random base64url tokens, single use, memory only, `BULK_UNDO_TTL_MS`, `BULK_UNDO_MAX_ENTRIES` oldest-first eviction, injectable clock), `filterByPaths` / `fileMatchesSelector` (`rawPath` wins), `mayHaveFiles` (the inbox prefilter). |
| `apps/daemon/src/review-controls.ts` (new) | `ReviewControls`: `setPolicy`, `bulk`, `undoBulk`. Bulk resolves the target on the server, checks `expectedStateHashes` **before and after** listing files, skips review-disabled worktrees unless `includeDisabled`, reuses the core's cached per-worktree file lists in parallel (never one git process per file), counts marks **per project** (same key as single marks), writes every row in **one SQLite transaction**, emits a **single `review.bulk`**, and stores the undo entry. Undo reverses exactly the rows that call changed and leaves rows changed since alone. |
| `wire:` commits | `store.ts` registers the migration and exposes `store.settings`; `core.ts` takes an optional `reviewPolicy` provider, attaches `review` to `GET /api/projects` worktrees and inbox entries, skips disabled worktrees for `onlyUnreviewed`, calls the cleanup hooks from `#dropProject` / `removeScanRoot`, and exposes `reviewSource()`; `app.ts` serves the five routes (behind the existing Host/Origin/token middleware; the routes are only registered when the deps are present); `daemon.ts` builds `SettingsService` and `ReviewControls` and exposes them on the `Daemon` handle. Without a provider the core behaves exactly as before (no `review` field). |

Tests (all new files unless noted): `apps/daemon/test/review-controls.test.ts` (route tests with `FakeGitCore`), `review-units.test.ts` (undo store, path selection, prefilter, target validation, migration from a v1 database, `SettingsService` revision rules), `integration.review.real-git.test.ts` + `real-git-fixture.ts` (real git-core: bulk/undo/policy/restart and a no-write check over both git dirs), `auth.test.ts` (**existing file**, one test added: the five routes × {no token, wrong token, `?token=`, foreign Origin, foreign Host, cross-site, ok}). Playwright API specs: `e2e/tests/09-settings-policy.spec.ts` (6 tests), `e2e/tests/10-bulk-review.spec.ts` (6 tests incl. a self-contained read-only proof and the 30 × 3 latency check), helpers `e2e/support/api.ts`, bench `e2e/support/api-bench.ts`.

## Verification

Node v26.13.0, git 2.53.0, WSL2, 2026-11-08, repo root on `ux/daemon` (`8afaa7b`):

| Command | Result |
|---|---|
| `pnpm check` | **exit 0**. lint: `Checked 231 files in 104ms. No fixes applied.`; typecheck: every package `Done`; build: contracts → git-core → daemon → cli, fixtures, e2e, web (Vite) `Done`; tests: contracts **71**, git-core **98**, web **37**, daemon **107** (12 files), cli **108**, fixtures **48**, e2e (vitest) **5**, all passed |
| `pnpm --filter @octopus-diff/daemon test` ×3 | `Tests 107 passed (107)` three times in a row (the concurrency test is timer based; no flakes seen) |
| `pnpm test:e2e` | **48 passed (1.6m)**: specs 01–08 (36 tests) unchanged and green, 09 (6) and 10 (6) green. Global teardown: `read-only proof: 12 control repos, 2235 lock polls, 0 violation(s)`. The self-contained proof in spec 10: 0 violations |

Daemon tests before this stream: 84 (incl. the 2 real-git integration tests, which run now that WS1 is merged). Added: 23.

### Measured numbers

`e2e/support/api-bench.ts` (new; `pnpm exec tsx --conditions=@octopus-diff/source e2e/support/api-bench.ts [--files 200 --dirty 200]`) generates the bench layout, starts the daemon in-process and times the routes. "Before" = the same script run in a temporary worktree of `ae48cb6` (deleted afterwards); "after" = this branch. 10 iterations, p50 (max). "Cold" = the per-worktree file lists are not cached yet (90 `git` processes through git-core, concurrency 4); "warm" = cached by `stateHash`.

| 30 repos × 3 worktrees = 90 worktrees | before `ae48cb6` | after `ux/daemon` |
|---|---|---|
| default layout: 40 files/repo, 3 dirty + 1 untracked per worktree → **360 changed files** | | |
| `GET /api/projects` | 2.4 ms (4.9) | 2.6 ms (5.4) |
| `GET /api/inbox` warm | 4.0 ms (5.1) | 4.2 ms (6.3) |
| `GET /api/inbox?onlyUnreviewed=true` warm | 3.4 ms (5.2) | 3.8 ms (4.8) |
| `GET /api/inbox` cold | 452 ms | n/a (bulk ran first, see next row) |
| `POST /api/review/bulk {all}` cold / warm / clear (`reviewed:false`) | — | **493 ms** / 2.7 ms / 2.9 ms |
| `POST /api/review/undo` | — | 4.9 ms |
| heavy layout: 200 files/repo, 200 dirty + 1 untracked per worktree → **18 090 changed files** | | |
| `GET /api/projects` | 2.3 ms (3.4) | 2.4 ms (3.7) |
| `GET /api/inbox` warm | 59.4 ms (82.7) | 57.5 ms (63.2) |
| `GET /api/inbox?onlyUnreviewed=true` warm | 56.5 ms (72.4) | 55.1 ms (63.4) |
| `GET /api/inbox` cold | 1491 ms | n/a |
| `POST /api/review/bulk {all}` cold / warm / clear | — | **1486 ms** / 51 ms / 65 ms |
| `POST /api/review/undo` (18 090 rows) | — | 71 ms |

Reading: attaching `review` costs nothing measurable on `/api/projects` and `/api/inbox` (differences are within run-to-run noise). Bulk `all` cold equals the inbox's own cold aggregation (452 vs 493 ms, 1491 vs 1486 ms): the bulk call does the same work as the inbox and then ~3 ms (360 rows) or ~50 ms (18 090 rows) of SQLite in one transaction. In the normal UI flow the inbox has already been fetched, so bulk `all` is the warm number. The in-suite check (`10-bulk-review.spec.ts`, built dist, same layout) measured `bulkAllCold` 593 ms and 833 ms in two runs (the second during the full suite, with the browser specs' Chromium still around), both well under the 2 s target; it writes `e2e/test-results/bulk-review-bench.json`.

## Decisions

All 2026-11-08, ux-daemon. For the lead to fold into `docs/DECISIONS.md`.

1. **Storage.** `settings` is a key/value table of JSON documents (`app`, `revision`) rather than one column per setting, so new settings need no migration; stored settings are merged with the defaults and a corrupt document falls back to the defaults instead of failing startup. `review_overrides` stores the owner columns (worktree rows also carry their project id) purely for cleanup; the primary key is the contracts' `reviewTargetKey`.
2. **Revision only moves on real change.** A `PATCH` with the same values, an override set to the value it already has, or removing an override that does not exist keep the revision and emit no `settings.changed`. Removing a project/scan root bumps once if (and only if) it deleted overrides.
3. **`settings.changed` goes to everyone, including the caller**; clients compare the revision with the response they already applied (as the contract says).
4. **`review.bulk` is emitted only when `changed > 0`** (and after an undo only when `restored > 0`). A no-op bulk call returns the counts and `undoToken: null` but produces no event: nothing changed, nothing to refetch. The contract comment does not say either way; see "Contract requests".
5. **Who counts as skipped.** Bare, missing and prunable worktrees and worktrees that have no summary yet (or whose summary failed) are ignored silently. Clean worktrees (prefilter by summary counts, same as the inbox) are not reported in `skippedDisabled` even when review is off for them: "2 skipped: review off" should count worktrees that would have been acted on. `stale` is reported regardless of files (the user saw a different state).
6. **Stale is checked twice**: against the summary when the target is resolved, and again after the file lists are in (`currentStateHash`), so a worktree that changes while files are listed is reported `stale` and nothing is marked (concurrency test). Without `expectedStateHashes` the current files are marked, as the contract says.
7. **Undo semantics.** Marks the bulk call *created* are removed only if their `reviewed_at` still equals the bulk call's timestamp (unmark + re-mark by hand since then leaves a newer mark alone). Marks the bulk call *removed* are restored only if no mark exists for the key now. Restored marks get `reviewed_at = last_seen_at = now` (the original timestamps are not kept; GC sees them as fresh, which is harmless).
8. **Per-project counting**: `changed` counts rows, so the same patch in two worktrees of one project is one mark (and `GET .../files` shows it reviewed in both). `worktrees` counts worktrees with at least one file after the `paths` filter.
9. **Override cleanup runs in the settings layer** (hooks called by the core right after the store deletes the project / scan root), in its own transaction, rather than inside `Store.deleteProject`: it needs the revision bump and the event, which the store does not know about. GC was not extended to orphans: the hooks cover every removal path (`removeProject`, `removeScanRoot`).
10. **Routes are optional in `createApp`** (`settings` / `reviewControls` deps): without them the five routes 404 like an older daemon (useful for tests of the degradation path); `startDaemon` always provides them. The `Daemon` handle exposes `settings` and `reviewControls` for tests.
11. **Bulk waits for first summaries like the list endpoints** (`#awaitInitial`, bounded 2.5 s) for the projects the target resolves to, so a bulk call right after startup sees the same state the inbox would.
12. **The bench script lives in `e2e/support/`** (`api-bench.ts`), not `e2e/bench/`, because the brief grants new files under `e2e/support/`. It runs on an older checkout too (bulk steps are skipped when `/api/settings` is 404), which is how the "before" column was produced.
13. **Branch level uses the registry's current branch** (`worktree.branch`, refreshed by summaries and relists), so a worktree that switches branch follows the new branch's override after its next summary.

## Contract requests

None required; everything in `settings.ts` / `api.ts` / `events.ts` / `domain.ts` was sufficient. Suggestions for the lead, all additive:

1. Document in `ReviewBulkEventSchema` that the event is **not** sent when `changed` is 0 (decision 4), or ask for it to be sent always; the daemon can do either.
2. Document the `SettingsResponse.overrides` order the daemon uses (folder, project, branch, worktree; then by target key) or declare it unspecified.
3. Consider an optional `projectIds` on `BulkReviewResponse` so the caller can refetch without waiting for the event (today it has to use the event or refetch everything).
4. Document `skippedDisabled` as "review-disabled worktrees that had changes in `scope`" (decision 5) and `stale` as "regardless of changes".

## Known gaps

- **No UI-level e2e** for these features yet (by design of the round: the UI is on `ux/web`); specs 09/10 are API-only.
- **Undo restores timestamps as "now"** (decision 7), and undo tokens are memory only (lost on restart, as specified).
- **Worktrees without a first summary** within the bounded wait are silently ignored by bulk (no `stale`, no error). A `worktree.changed` follows and the user can retry.
- **`commit` scope** works through the same path, but the inbox-style prefilter is a no-op for it, so every worktree of the target gets one `listChangedFiles` (cached by sha afterwards).
- **One `settings.changed` per cleanup**: removing a scan root with N discovered projects that had overrides emits up to N+1 events (each a revision step). Clients coalesce by revision anyway.
- The bench numbers are from one machine (WSL2, Ryzen 7 7800X3D); the cold numbers are dominated by git process spawning and will differ elsewhere.

## Notes for integration

**Merge.** `wire:` commits touch `apps/daemon/src/{store,core,app,daemon}.ts` only additively: `store.ts` (+3 lines: import, migration entry, `settings` field), `core.ts` (imports, `reviewPolicy` option/field, `#policy()`, `review` in `#item` and `inbox`, two hook calls, `reviewSource()`), `app.ts` (imports, two optional deps, one route block), `daemon.ts` (construct and pass the two services, two handle fields). `watcher.ts`, `security.ts`, `token.ts`, `static.ts` are untouched. Resolve `review/perf` conflicts by keeping their changes and re-applying these small blocks.

**Daemon handle.** `startDaemon()` returns `settings: SettingsService` and `reviewControls: ReviewControls` in addition to the previous fields; `createApp` accepts them as optional deps.

**For ux-web (parity with the mock).** Exact shapes as served by this daemon:

```http
GET /api/settings
200 {"settings":{"review":{"defaultEnabled":true}},"overrides":[],"revision":0}

PATCH /api/settings
{"review":{"defaultEnabled":false}}
200 {"settings":{"review":{"defaultEnabled":false}},"overrides":[],"revision":1}
→ SSE  event: settings.changed  data: {"type":"settings.changed","revision":1}
(a PATCH that changes nothing returns the same revision and emits nothing)

PUT /api/review-policy
{"target":{"kind":"branch","projectId":"5c14e402f4d7143e","branch":"agent/live"},"enabled":false}
200 {"settings":{"review":{"defaultEnabled":false}},
     "overrides":[{"target":{"kind":"branch","projectId":"5c14e402f4d7143e","branch":"agent/live"},
                   "enabled":false,"updatedAt":"2026-11-08T11:20:03.412Z"}],
     "revision":2}
→ SSE settings.changed {"revision":2}
{"target":{"kind":"worktree","worktreeId":"0123456789abcdef"},"enabled":null}   removes the override
404 {"error":{"code":"not_found","message":"worktree not found"}}                unknown target
400 {"error":{"code":"bad_request","message":"invalid request body: ...","details":{"issues":[...]}}}

POST /api/review/bulk
{"target":{"kind":"all"},"expectedStateHashes":{"<worktreeId>":"<stateHash>"}}
200 {"ok":true,"reviewed":true,"changed":37,"unchanged":0,"worktrees":12,
     "skippedDisabled":["7b17f2f8fe012f28"],"stale":["a274c6d7371ed64b"],
     "undoToken":"Q3lO0m3n9Z4c1XoR2uYvW8bT5kJdH6sA"}
→ SSE  event: review.bulk  data: {"type":"review.bulk","projectIds":["…","…"],"reviewed":true,"changed":37}
{"target":{"kind":"worktree","worktreeId":"…"},"paths":[{"path":"src/a.ts"}],"reviewed":false}
200 {"ok":true,"reviewed":false,"changed":1,"unchanged":0,"worktrees":1,"skippedDisabled":[],"stale":[],"undoToken":"…"}
{"target":{"kind":"project","projectId":"…"},"paths":[{"path":"a"}]}
400 {"error":{"code":"bad_request","message":"paths is only valid with a worktree target"}}
(nothing to do → "changed":0,"undoToken":null and no event; scope defaults to {"kind":"working"})

POST /api/review/undo
{"undoToken":"Q3lO0m3n9Z4c1XoR2uYvW8bT5kJdH6sA"}
200 {"ok":true,"restored":37}
→ SSE review.bulk {"projectIds":[…],"reviewed":false,"changed":37}
404 {"error":{"code":"not_found","message":"undo token not found"}}   unknown, expired, or already used
```

`GET /api/projects` worktree items and `GET /api/inbox` entries carry `"review":{"enabled":true,"source":"default"}` (sources: `worktree` | `branch` | `project` | `folder` | `default`). `GET /api/inbox?onlyUnreviewed=true` omits worktrees whose `review.enabled` is false; without the flag they are listed with their files and `review`. Every route is behind the token and the Host/Origin checks (401/403 as the other routes); all errors are `ApiErrorBody` with the usual statuses (400 validation, 404 unknown target/token, 415 wrong content type, 413 body > 1 MiB).

**Event handling hints.** On `review.bulk`, refetch the inbox and the file lists of the listed `projectIds` (no `review.changed` is sent for the individual files). On `settings.changed`, skip the refetch when `revision` equals the one from the response you just applied; otherwise refetch settings, projects and the inbox (effective policies may have moved).

**e2e after the merge.** Specs 09/10 use the `daemon` fixture (one daemon per test, all fixture projects registered) and `e2e/support/api.ts`; the lead can add UI assertions next to the API ones. The read-only proof in spec 10 and the global proof both cover bulk review. The in-suite bench writes `e2e/test-results/bulk-review-bench.json` and prints a `[bulk-bench]` line.
