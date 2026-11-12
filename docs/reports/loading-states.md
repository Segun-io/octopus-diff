# loading-states report (GitHub #11, roadmap step 08)

Branch `feat/loading-states`, from `main` at `152f90e`. Session of 2026-11-12. Decisions #213-#216 in
`docs/DECISIONS.md` (the brief said #212 was next, but #212 is already the perf-script entry on this base; other open
branches also use #213+: renumber at merge).

## Shipped

When data is slow, the UI now says who is slow, after a threshold, and says when what it shows is stale.

- **Attributed messages** (`apps/web/src/lib/wait.ts`, `components/WaitNote.tsx`, `lib/useWait.ts`):
  "Waiting for GitHub…" / "Waiting for GitLab…" (by the project's forge kind; "GitHub and GitLab" when both are
  pending) for forge requests, "Loading from your computer…" for local work. The threshold is the constant
  `WAIT_NOTE_DELAY_MS = 700`. A load that ends sooner shows no text at all, only the skeleton. Each note is a single
  always-mounted `role="status" aria-live="polite"` region whose text comes and goes (announced once per change), in
  one of three placements that take no layout: `block` (reserved line under a skeleton), `inline` (zero-width until it
  has text, beside a Refresh button) and `float` (a pill over the foot of the sidebar / file pane).
- **Rate limit / busy** (from `ForgesResponse.budgets`): a host in `backoff` or `low` replaces the plain wait with
  "GitHub is rate-limiting requests, retrying at HH:MM" (`low`: "Your GitHub quota is nearly used up, checking only on
  request until HH:MM"), in the warn colour; `busy` says "Using a lot of your GitHub quota, polling slower" while a
  lookup on that host is being waited for. No endless spinner anywhere.
- **Stale** (`describeStale`): "Could not refresh from GitHub. Last updated 3 min ago · Refresh" (or the rate-limit
  sentence), a real `<button>` (Tab reaches it, Enter/Space click). Signals: the host's budget is `backoff`/`low`; the
  project's status `error` / a detail or repository response's `message` (the daemon keeps the last good data); the
  browser's own refetch failed with data cached (`isError` + `dataUpdatedAt`). The time is the data's own
  (`fetchedAt`, `dataUpdatedAt`). No age timer decides staleness.
- **Where** (the brief's list):
  - Sidebar PR chips: a floating status pill at the foot of the sidebar (`data-testid="sidebar-status"`,
    `data-state` waiting / stale / idle): project forge status `pending` -> "Waiting for GitHub…", held-back host ->
    rate-limit sentence + Refresh ("Check again", `POST /api/forges/refresh`), and the review-state note below.
  - File list: first-load skeleton + note (was "Loading files…"); a pill while inbox batches (or a files refetch) are
    still loading and content is already shown.
  - Diff pane: skeleton + note (was "Loading diff…").
  - Request tab: skeleton + note while the detail loads, an inline note beside Refresh while a refresh or refetch is
    slow, the conversation and Timeline notes (were "Loading the conversation…"), and the stale banner with Refresh
    (replaces "Showing the last loaded data").
  - Overview: repository facts (local: skeleton + note; forge: a skeleton that holds the place when the project is
    known to have a forge, note after the threshold, inline note + stale line with Refresh), the Branches list, the
    folder Overview's table (note while `/api/repositories` is pending), and the project header.
  - Project / worktree open: "Loading from your computer…" while a worktree of the opened project has changes and a
    summary without `review` (`reviewPending`, the rule `rowVisible` already used; ends when `review.ready` makes the
    sidebar refetch). Stops being claimed after `REVIEW_WAIT_GIVE_UP_MS` = 30 s, for a daemon that never sends the
    states.
  - Cold start: the "Connecting…" label in the first-paint skeleton only appears after the threshold (a 150 ms paint
    no longer flashes it).
- **Mock knobs** (`apps/web/mock`): `MockRouterOptions.gate` (hold a request, release it from the test),
  `forgeLatencyMs` / `localLatencyMs`, `MockBackend.setForgeSim({ pending, budget, error, fetchedAgoMs })`,
  `POST /api/__mock/forge-sim?...`, env `MOCK_FORGE_LATENCY_MS`, `MOCK_LOCAL_LATENCY_MS`, `MOCK_FORGE_SIM=pending,backoff,error`.
- Small refactor: `reviewPending(row)` exported from `lib/model.ts`, used by `rowVisible`.

## Verification

All on the dev machine (WSL2, Node 26). Commands run from the repo root unless stated.

| Command | Result |
|---|---|
| `pnpm check` (lint + credits check, typecheck, build, tests) | exit 0. Tests: contracts 99, forge 101 (+5 skipped), git-core 276, fixtures 58, **web 324** (was 284 + 34 in `loading-states.test.tsx` + 6 in `mock.test.ts`), daemon 284 (+1 skipped), e2e package 5, cli 139, scripts 34 |
| `pnpm --filter @octopus-diff/web perf:smoke` | exit 0, every check `ok: true` (6000-file inbox, 46 mounted rows, J visits 8 of 8 worktrees, 2-3 requests per refresh) |
| `cd e2e && pnpm exec playwright test tests/14-ui-forge-details.spec.ts tests/15-ui-status-flow.spec.ts tests/01-projects.spec.ts tests/02-inbox-diff.spec.ts tests/18-onboarding.spec.ts tests/13-ui-settings-themes.spec.ts tests/11-ui-bulk-review.spec.ts` | **28 passed** in 1.2 min, exit 0, read-only proof 0 violations |
| mutation check: `WAIT_NOTE_DELAY_MS = 0` | 11 of the 34 new tests fail (threshold, no-flash, every "after the threshold" case), so they do guard the threshold; restored |

I did not run the full e2e suite (it can hang at daemon shutdown, BLOCKERS Open 2); only the specs above, which cover
the Request tab, the Overview, the sidebar, the inbox/diff and the cold start that this change touches.

New tests, with fake timers (`vi.useFakeTimers`) and the mock's request gate:

- `apps/web/test/loading-states.test.tsx`: pure text (local / GitHub / GitLab / both; backoff / low / busy; the
  stale text; `describeStale` for held, failed, failed refetch and "merely old is not stale"); the hooks and notes
  (`useDelayedFlag` threshold and restart, `useExpiring`, a single live region announced once, fast load shows
  nothing, rate-limit text is warned, the stale note's button and its clock); in the whole app: nothing at all on a
  fast load, the diff pane (message after 700 ms, never for a diff that arrives at 400 ms), file list during inbox
  batches, Request tab on GitHub and on GitLab, a slow Request refresh, the conversation, backoff text instead of a
  plain wait, busy text, the stale Request banner (and its Refresh posts), backoff in the Request tab, the
  sidebar pending note ("GitHub and GitLab", then gone after `forge.updated`), backoff in the sidebar, stale pill
  with a working Refresh, "busy" stays quiet when nothing waits, Overview forge + local facts, the folder Overview,
  the review-state note until `review.ready` lands and its give-up, and a failed projects refetch with the last data
  kept and its Refresh.
- `apps/web/test/mock.test.ts`: `sideOf`, the gate, per-side latency, the forge sim (pending / budget / error,
  contract-valid), the control endpoint and `MOCK_FORGE_SIM`.

Visual check: `pnpm build`, `preview:mock` (with `MOCK_FORGE_LATENCY_MS=600000` for the slow-forge state, without for
the others) and `pnpm --filter @octopus-diff/web shots` with `STATES=wait-forge,rate-limit,rate-limit-stale,stale-request`
(octopus-dark, 1440 and 960). Looked at them; this found the sidebar pill's text and button spilling past its edge,
fixed (the text now wraps inside the pill). Shots went to `/tmp/ls-shots*`, not committed.

## Decisions

#213 (sources, threshold, placement), #214 (stale from real signals, rate-limit wording), #215 (review-state note read
from the summaries, 30 s give-up), #216 (mock knobs). Numbers start at #213 because #212 is taken on this base.

## Contract changes

None.

## Dependencies

None added or removed (`pnpm credits` not needed; the credits check passes in `pnpm lint`).

## Known gaps

- **No e2e added.** The e2e run the real daemon and the fixtures' forge and local answers cannot be slowed on demand;
  a "nothing is said on a fast load" e2e would depend on a cold paint staying under 700 ms on CI. The behaviour is
  covered by the component tests with the mock's request gate instead.
- **README screenshots (`docs/screenshots/*`) were not regenerated.** As in `web-merge-noise.md` / `copy-tools.md`,
  they come from fixture repositories that never show these states (a slow forge, a rate limit), so they look the same.
  `scripts/shots.ts` gained the four states for the next design review.
- **Sidebar pill is aggregate.** It shows the strongest reason over all projects (rate limit before a failed fetch,
  the oldest data time). A per-project breakdown is in Settings -> Forges ("Rate limit" block) and in each
  Request tab / Overview.
- **A held-back host with no data yet** (`backoff` before the first fetch) shows the wait/rate-limit sentence only
  while a project is `pending`; with nothing on screen there is nothing to call stale.
- **`busy` is quiet by design** unless a lookup on that host is being waited for (a user with a big fleet would
  otherwise see it all day). Settings -> Forges still shows it.
- **Local "stale" is only for the projects list** (it keeps the last data and shows the banner). Files, diffs and
  the inbox refetch failures keep their existing error states.
- The give-up for the review-state note is a timer (30 s), the only one in the feature; it only bounds a claim, it
  never decides staleness.
- The brief's `docs/PLAN.md 4.2` was read but not edited.

## Notes for integration

- Renumber DECISIONS #213-#216 at merge (other branches use #212+).
- Web only; the mock knobs are `apps/web/mock` (dev/test, never imported from `src/`). Nothing in the daemon or the
  contracts changed, so it merges independently of the daemon branches. It reads `ForgesResponse.budgets` /
  `status` / `message` / `fetchedAt` and `WorktreeSummary.review` as #197 and #180 define them.
- Tuning: `WAIT_NOTE_DELAY_MS`, `REVIEW_WAIT_GIVE_UP_MS`, `STALE_CLOCK_MS` in `apps/web/src/lib/wait.ts`.
