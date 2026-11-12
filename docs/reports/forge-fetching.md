# forge-fetching report (issue #8, roadmap step 07)

Branch `perf/forge-fetching`. Decision #197 in `docs/DECISIONS.md` (the next free number was #197; the
integration-base branch uses #196).

**How to read the numbers.** Three kinds, never mixed:

- **Arithmetic**: computed from the query shape and GitHub's published rules (docs.github.com, "Rate limits and
  query limits for the GraphQL API", read on 2026-11-11: primary limit 5 000 points an hour per user; a query costs
  the requests needed to fill every connection, a nested connection counting once per parent node, divided by 100,
  rounded to the nearest whole number, minimum 1; secondary limits 100 concurrent requests, 2 000 points a minute,
  CPU time). The code is `packages/forge/src/cost.ts` (`estimateQueryPoints`), tested against the documentation's
  own worked example (5 101 requests = 51 points).
- **Simulated**: counted from the real `ForgeService` scheduler running on a fake clock with a fake forge client
  (`apps/daemon/test/forge-fleet.test.ts`, `forge-sim.ts`); the query counts are real scheduler behaviour, the points
  are the arithmetic above. Run it with `FORGE_FLEET_TABLE=1 pnpm --filter @octopus-diff/daemon exec vitest run
  test/forge-fleet.test.ts --silent=false`. The "before" column was produced by running the same harness on the
  commit before any behaviour change (`20a70b3`).
- **Measured**: nothing in this report was measured against a real forge (no real API call, no token, no secret).
  The only measurements are the ones earlier sessions recorded (`docs/reports/forges.md`, `forge-details.md`: the
  batch with few branches, detail, conversation and repository each reported `rateLimit.cost` 1, which agrees with
  the arithmetic). The opt-in live test now also asserts the cost of 1/13/14/20-branch batches, so the maintainer
  can confirm the one claim that changes (14 to 20 branches cost 2, not 1).

## Shipped

- **Budget** (`apps/daemon/src/forge-budget.ts`): per-host rolling-hour ledger, three ceilings (background 1 500,
  event-driven 2 500, user-asked 4 000 points an hour), the forge's `remaining` / `resetAt` as authority, backoff
  after a refusal (until the reported reset, else 5 min doubling to 1 h). `ForgeService` admits every query through it.
- **Adaptive polling** in `ForgeService`: 2 min while a browser looks, 10 min when none, stretched to a points target
  (1 000 an hour looking, 300 not), at most 30 min; the project in view every 60 s; attention from `PUT /api/focus`
  (new `DaemonCore` option `onFocus`) with a 5-minute keep-alive in the web (`useFocusReporting`).
- **Focus refresh**: a project coming into view is looked up when older than 30 s; the fleet poll runs at once after
  a break; the open Overview reloads its repository information every 2 min (and `forge.updated` tells the UI).
- **Bounded "Check again"** (`ForgeService.checkAgain`): skips projects fetched under 5 s ago, at most 150 points a call.
- **Eviction** of detail, conversation and repository caches (64 per kind, least recently used; an hour unused).
- **Push follow-ups** only for branches whose upstream or push destination changed, stopped once found.
- **Basic query variant remembered** per host and query for an hour (`ForgeClient`).
- **Rate-limit recognition**: `ForgeFetchError.rateLimited` / `isRateLimitMessage`; `resetAt` added to the four
  GitHub queries' `rateLimit` selection (same read-only queries, allowlist rebuilt from the builders).
- **Visible feedback**: `ForgesResponse.budgets` (additive; `contracts:` commit `4bba6b6`), Settings → Forges "Rate
  limit" block (used points, what the forge reports left, when lookups resume), `forge.updated` on state changes.
- Docs: `docs/FORGES.md` (3, 3a, 3b, API), DECISIONS #197.

## The audit: every call path

Cost is GitHub GraphQL points (arithmetic). `b` = head branches asked about for the project (non-default branches
checked out in worktrees); batch cost `c(b)` = 1 for b ≤ 13, 2 for 14–20, then per chunk of 20. GitLab counts one
request per query (no points). "Before" is the behaviour at `b770b8e`; "after" is this branch.

| # | Call path | Trigger | Frequency before → after | Cost |
|---|---|---|---|---|
| 1 | Batch per project (`fetchChangeRequests`) at **startup** | `ForgeService.start()` | once per queried project → same (not throttled; background ceiling applies) | `c(b)` per project |
| 2 | Batch, **fleet poll** | timer | every 2 min, always (30 an hour per project) → 2 min while a browser looks, 10 min when none, stretched to ≤ 1 000 / 300 points an hour, max 30 min | `c(b)` per project per round |
| 3 | Batch, **event** | `worktree.added/removed/changed`, `project.*`, pending cache seen by `GET /api/forges`, git change burst (debounced 1.5 s) | when the branch set changed, or the data is older than the poll → same, but "older than the poll" now means the real (stretched) poll interval; edits alone cost 0 | `c(b)` |
| 4 | Batch, **push** | upstream / push destination of a branch changed (`git push -u`) | at once, then forced again at 30 s and 90 s even when found; any new branch counted as a push → only changed branches, second lookup skipped when the request was found | `c(b)` × 1–3 → × 1–3 only for real pushes |
| 5 | Batch, **focus** (new) | `PUT /api/focus` with a visible tab: project in view older than 30 s; fleet poll if overdue | none → ≤ 1 lookup per project per 30 s of attention, only when stale | `c(b)` |
| 6 | Batch, **hot project** (new) | timer while someone looks | none → every 60 s for the project in view | `c(b)` |
| 7 | Batch, **Check again** | Settings button, `POST /api/forges/refresh` | every project, unbounded → skips projects < 5 s old, ≤ 150 points a call | `c(b)` per project |
| 8 | Batch, **Request tab Refresh** | button | forced batch + detail + conversation → same | `c(b)` + 1 + 1 |
| 9 | Detail (`OctopusDiffPullRequestDetail`) | Request tab open | on open and when TTL (60 s open, 10 min merged/closed) or the batch fingerprint (`updatedAt|headSha|checks|state`) moves → same | 1 (8 requests) |
| 10 | Detail, **live checks** | web `refetchInterval` 45 s while a check runs, tab visible, input in the last 20 min | the daemon TTL (60 s) turns this into one fetch per ~90 s → same | 1 each |
| 11 | Conversation | Summary's Conversation or Timeline shown | TTL 60 s / 10 min, fingerprint without CI state → same | 1 (53 requests) |
| 12 | Repository + 20 newest open requests | Overview opens, "Refresh" | TTL 10 min → TTL 10 min, plus every 2 min while that Overview is in view | 1 (24 requests) |
| 13 | CLI probes (`gh --version`, `gh auth status`, `glab …`) | first use, then TTL 10 min (30 s on Check again) | 4–5 spawns per 10 min → same | 0 GraphQL points; `auth status` validates the token over the network (REST, not measured here) |
| 14 | Basic-variant retry (GHES, self-managed GitLab) | "unknown field" error | on **every** call: the rejected query then the basic one → once per hour per host and query | 1 wasted query (cost unmeasured) per call → 0 |
| 15 | Web `GET /api/forges` | mount, focus, 5 min interval, `forge.updated`, Refresh | cached daemon read → same | 0 |
| 16 | SSE `forge.updated` | any batch change; (new) a host's budget state change | free | 0 |
| 17 | Local `git config` read for the push signal | each batch decision / git change burst | local, not forge → same | 0 |

Search for further forge call paths found none: `gh`/`glab` run only through `packages/forge`'s runner; the
daemon calls `fetchChangeRequests`, `fetchRepository`, `fetchDetail`, `fetchConversation` and `probe`, from the
paths above.

## Fleet estimates

Assumptions: every repository has a forge host the CLI is signed in to and `b` branches in worktrees (a repository
with only its default branch checked out costs 0); one GitHub user for all of them (one budget); "busy hour" =
a user looking at one project with the Request tab open on a PR whose checks are running (detail polled every 45 s,
conversation shown) while agents edit three worktrees every 5 s. Percentages are of 5 000 points an hour.

### Arithmetic (closed form, before)

| Fleet | Startup | Idle hour, 2-min poll (`30 · F · c(b)`) | % of limit |
|---|---|---|---|
| 5 repos, b = 3 | 5 | 150 | 3 % |
| 30 repos, b = 3 | 30 | 900 | 18 % |
| 100 repos, b = 3 | 100 | 3 000 | 60 % |
| 30 repos, b = 15 | 60 | 1 800 | 36 % |
| 100 repos, b = 15 | 200 | 6 000 | **120 %: the limit is gone in about 50 minutes, on an idle machine** |

A busy hour adds roughly 40 (detail) + 40 (conversation) points and 3 per Request-tab Refresh, Overview 6 an hour.
The user's own `gh`, T3 Code and CI helpers draw from the same 5 000.

### Simulated: points and queries an hour (scheduler on a fake clock)

| Fleet (b = branches) | Scenario | Before | After |
|---|---|---|---|
| 5 x 3 | startup (first 2 min) | 5 | 5 |
| | idle hour (no browser) | 150 | 30 |
| | busy hour | 230 | 265 |
| | headless daemon, first hour (no focus report ever) | n/a | 45 |
| | Check again | 5 | 5 |
| 30 x 3 | startup | 30 | 30 |
| | idle hour | 900 | 180 |
| | busy hour | 980 | 1 040 |
| | headless first hour | n/a | 270 |
| | Check again | 30 | 30 |
| 100 x 3 | startup | 100 | 100 |
| | idle hour | 3 000 | 300 |
| | busy hour | 3 080 | 1 140 |
| | headless first hour | n/a | 400 |
| | Check again | 100 | 100 |
| 30 x 15 | startup | 60 | 60 |
| | idle hour | 1 800 | 300 |
| | busy hour | 1 880 | 1 194 |
| | headless first hour | n/a | 420 |
| 100 x 15 | startup | 200 | 200 |
| | idle hour | 6 000 | 400 |
| | busy hour | 6 080 | 1 200 |
| | headless first hour | n/a | 600 |
| | Check again | 200 (all 100) | 150 (75 projects, then the poll) |

Reading it: the idle hour drops 5 to 15 times; the busy hour is a little **higher** for small fleets (5x3: +35, the
60-second hot-project poll, deliberately: that is the "faster when focused" half) and much lower for big ones (the
stretch). Check again for 100 x 15 is capped at 150 points instead of 200. The simulation does not model rate-limit
refusals: the "before" 6 000 is demand, the real daemon would have been refused after about 50 minutes.

### GitLab

No points. The same counts apply as requests (100 repos at 2 min = 3 000 requests an hour before, 300 idle now).
gitlab.com's authenticated per-user rate limit (from memory of GitLab's documentation, not re-verified here) and a
self-managed default of no limit are far above this, so only the backoff on HTTP 429 matters. GitLab's GraphQL query
complexity limit (also from memory: 250 authenticated) is a different risk: the conversation query is the largest;
the recorded unauthenticated run against `gitlab-org/cli` (limit lower than authenticated) worked.

## Where we can hit the limits or waste points, ranked

1. **Idle polling, 24/7, regardless of any browser** (fixed: adaptive poll, stretch, 6-minute startup attention).
2. **No budget and no backoff**: a refused account kept sending (fixed: budget, backoff, held-back lookups).
3. **Batches of 14–20 branches cost 2, and 21+ branches cost per chunk**; FORGES.md said 1 (corrected; arithmetic,
   live check available). Big agent fleets create many branches per repository.
4. **Check again** forced every project with no per-call limit (fixed: skip < 5 s, 150-point allowance).
5. **A new worktree counted as a push**: two forced follow-ups per new branch (fixed: only changed branches, and the
   second is skipped when found). This was the #12 note "2 forced points per pushed branch with no PR yet".
6. **Basic-variant retry on every call** for GHES / self-managed GitLab (fixed: remembered for an hour).
7. **Staleness gaps from the #12 notes**: PR created elsewhere (now shows when someone looks, ≤ 30 s stale per focus,
   or at the next poll); focus reached no network (now a stale-only refresh); an open request on a branch no worktree
   has checked out (the Overview reloads every 2 min while in view; 10 min otherwise); caches never evicted (fixed).
8. **Edit events refetching on the poll's old interval** (fixed: use the real interval).
9. Not changed, deliberately: the 15 s project spacing (only bites unforced retries and event bursts), the 60 s /
   10 min detail TTLs and the web's `staleTime`s (detail and conversation are 1 point and only run when someone has
   them open; the budget bounds them), `refetchInterval` 5 min of `['forges']` (reads the daemon's cache).

## Verification

- `pnpm check` (lint with the credits check, typecheck, build, tests): **exit 0**. Tests: contracts 84, forge 101 (+5
  skipped live), git-core 202, fixtures 53, web 253, daemon 259 (+1 skipped), e2e package 5, cli 139, scripts 34.
- `cd e2e && pnpm exec playwright test` (all): **91 passed in 2.7 min**, exit 0, no hang, no flaky retry
  (`16-copy.spec.ts:226` passed); the `git-core has been disposed` log lines are the usual shutdown noise. This
  includes `14-ui-forge-details.spec.ts` (fake `gh` serving the recorded fixtures through the new queries with
  `resetAt`).
- Tests added (each of the behavioural ones fails when the behaviour is removed; two were checked by mutation:
  dropping the follow-up guard, and counting a new branch as a push):
  - `packages/forge/test/cost.test.ts` (the documentation's worked example, 13/14/20/21/45-branch batches),
    `cli.test.ts` (basic variant remembered, rate-limit message recognition), live (skipped by default).
  - `packages/contracts/test/forge.test.ts` (`budgets`).
  - `apps/daemon/test/forge-budget.test.ts` (7), `forge-fetching.test.ts` (16: refusal and backoff, ceilings per
    priority, detail admitted by the budget, adaptive intervals, stretch, focus, hot poll, Check again, eviction,
    pushes, Overview reload), `forge-fleet.test.ts` (5 fleets, asserts the hourly points), `forges.test.ts` (budgets in
    `GET /api/forges`, `PUT /api/focus` reaches the forge service).
  - `apps/web/test/forges.test.tsx` (budget line, Settings), `focus-reporting.test.tsx` (keep-alive, hidden).

## Decisions

#197 (this report's findings, the strategy and what was decided against).

## Contract changes

`ForgesResponse.budgets?: ForgeBudgetState[]` (new optional field, new `ForgeBudgetStateSchema`), separate commit
`4bba6b6` (`contracts:`), logged in #197. Nothing renamed or removed. `PUT /api/focus` is unchanged.

## Dependencies

None added or removed (`pnpm credits` not needed; `pnpm lint` runs `credits:check`).

## Known gaps

- **No real forge was called.** The 14–20-branch cost of 2 and the strategy's headroom rest on GitHub's documented
  rule. The opt-in live test (`OCTOPUS_FORGE_LIVE=1`, maintainer only) now asserts it.
- The budget's ledger holds estimates; the forge's `remaining` (GitHub only) corrects it. GitLab and GitHub
  Enterprise Server hosts that do not report `rateLimit` rely on the estimates and on backoff.
- Refusals are recognised from the CLI's message text (no headers within the allowlist): a message that does not
  mention a rate limit is treated as an ordinary error (no backoff).
- Ceilings and polling targets are constants (not settings).
- The `basic` memo and the budget live in memory only: a daemon restart forgets both (one wasted query per host).
- `docs/FORGES.md` "Safety" is unchanged: the runner, allowlist, neutral cwd and per-host tokens are as before; the
  only query change is `resetAt` in `rateLimit { cost remaining resetAt }`.

## Proposed follow-up issues (not built)

| Title | Scope | Size |
|---|---|---|
| forge: one GraphQL query for several repositories | A new allowlisted read-only query with one aliased `repository(...)` per repository (and the matching `QUERY_REGISTRY` entry and DECISIONS reason). Merging repositories removes the per-query minimum of 1 point: 100 repos x 3 branches is about 100 points a round today and about 33 in 4 queries (arithmetic: `11 · 3 · 100 / 100`), cutting the poll and startup cost by about two thirds. Needs parsing per repository and partial failure handling. | M (opus: allowlist) |
| forge: read the real limit for free | Allow one exact REST read `gh api rate_limit` (does not count against the limit, per GitHub's documentation, to be verified) so `remaining` / `resetAt` are known at startup and before bursts, and on hosts whose GraphQL responses omit `rateLimit`. | S |
| forge: conditional-request change detector (spike first) | REST `pulls` list with `If-None-Match`: a 304 is free, so unchanged repositories would cost 0. Needs `--include` and `--header` in the allowlist, an ETag store, and covers PR updates but not CI state flips; spike to decide. | S spike, L build |
| forge: tunable ceilings and polling targets | Settings → Forges "Advanced": background/event/user ceilings, looking/idle intervals; defaults as now. | S |
| forge: coalesce identical batches across projects | Clones or forks of one repository with the same head branches send the same query: share one in-flight/short-lived result keyed by (host, repository, branches). | S |
| web: a rate-limit notice outside Settings | A quiet status-bar/toast line when a host is `busy`/`low`/`backoff`, tied to #11 (loading states). | S |
| daemon: serve-stale detail with background revalidation | Detail and conversation answer the last value at once after the TTL and refresh in the background, with `forge.updated` driving the web (the web already keeps the previous response). | S–M |

## Notes for integration

- Daemon, forge package, contracts (one additive commit), web and docs. `DaemonInternals.forges` gained
  `idlePollMs`, `hotPollMs`, `attentionMs`, `focusStaleMs`, `checkAgainSkipMs`, `checkAgainMaxPoints`, `budgetLimits`,
  `maxCacheEntries`, `cacheMaxAgeMs` (test seams). Existing forge tests that call Check again right after
  startup pass `checkAgainSkipMs: 0` (the new 5 s double-click guard would skip a just-fetched project).
- `DaemonCore` gained an optional `onFocus(visible, projectId, overview)` option; `daemon.ts` wires it to
  `ForgeService.focusChanged`.
- `apps/daemon/test/forge-sim.ts` is a test helper (fake client, synthetic fleets, fake-clock `advance`) for any
  later scheduler tests.

## PR review round 1 (Greptile on #62)

All three findings were valid.

- **Automatic polls spent the reserved points.** The project-in-view poll (`#hotTick`) used the `event` ceiling and the open Overview's reload went through `#guarded`, which always used `interactive`, so both kept spending after the background ceiling was reached and the Overview timer kept running below 500 remaining points. Both timers now use `background`; explicit opens, refreshes and focus lookups keep `interactive` / `event` (`#guarded` and `repository()` take an optional priority). Test: with the background share used up, neither the poll nor the reload goes out in five minutes (it fails without the change).
- **Visible pages got idle polling.** A visible Inbox or folder Overview selects no worktree, so the focus report `{ worktreeId: null }` looked like a hidden tab and the daemon slowed its forge polling while someone watched. `FocusRequest` gets an optional `visible` (own `contracts:` commit, additive); the web sends `visible: !hidden`, and its de-duplication key now includes visibility (a visible empty tab and a hidden one were the same key, so the switch was never reported). Older clients keep the old inference. Tests: schema, the web hook (visible with nothing selected; hiding is reported) and the daemon route.
- **Later pushes erased earlier lookups.** A second push replaced `followBranches`, so a branch still waiting for its request was forgotten and its follow-ups skipped when the new branch already had one. The set is now kept across pushes and pruned when a request is found or the branch is gone (`#stillWaiting`). Test: feat-0 pushed, feat-1 pushed shortly after with its request already there, then feat-0's request appears: the follow-up still finds it (fails without the change).
