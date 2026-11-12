# stale-forge-data report (issue #12, roadmap step 06)

Branch `fix/stale-forge-data`. Decision #195 in `docs/DECISIONS.md` (the next free number was #195; other
sessions use #188-#194).

## Shipped

Root causes (all in `apps/daemon/src/forges.ts` unless noted):

1. **A forced refresh was silently skipped.** `#load` refused to refetch an entry whose last attempt was under
   15 s old, even with `force`. Opening the Request tab (a fetch) and pressing Refresh within 15 s answered with
   the cached detail: the button finished "loading" and the old version stayed. The same applied to the
   conversation and to the Overview's repository "Refresh". The old test (`a forced refresh is spaced 15 s`)
   asserted this as intended behaviour; it is replaced.
2. **The refresh did not touch the project batch.** The chip, the header's state, the matched request (and its
   number) and every cache fingerprint come from the batch, refreshed only by the 2-minute poll. `refreshRequest`
   now forces the batch first, then the detail and conversation (3 points).
3. **A forced call shared an older in-flight fetch** whose answer may predate the click. It now waits and
   fetches again (two forced calls share one).
4. **The repository cache (10 min) had no key.** A request the batch had just discovered (or merged) did not
   reach the Overview's open-requests list. Its fingerprint is now the batch's `number:state` set.
5. **A new request had one signal: the 2-minute poll.** A push on an unchanged branch set was ignored by the
   event path (`onlyIfBranchesChanged`) and a request created seconds after the push was never looked for. A
   changed branch configuration (upstream / push remote, what `git push -u` and `gh pr create` change) now
   refetches at once (bypassing the 15 s spacing) and, when the pushed branch has no request yet, looks again
   30 s and 90 s later (forced; `followUpMs`, test seam in `DaemonInternals.forges`).

Web: `useRefreshChangeRequest` also invalidates `['forges']` (the batch), so the chip and the keys do not wait for
`forge.updated`. UI hints no longer promise a 15 s spacing. `docs/FORGES.md` documents both.

Spacing now applies only to unforced retries after an error or a missing object (not to a changed fingerprint).

## Verification

Regression tests (each fails on the old code, checked by restoring the old `forges.ts` / `request.ts`):

- `apps/daemon/test/forge-details.test.ts`: `a refresh right after loading refetches and shows the new version`,
  `a refresh during a slower plain fetch still returns data newer than the click`, `errors on a refresh keep the
  last good data`, `the open-requests list follows a request the batch just discovered`, `a branch that was just
  pushed is looked up again at once, and a bit later` (5 failed on the old code, 21 pass in the two forge files).
- `apps/web/test/request.test.tsx`: `Refresh in the Request tab (#12) > shows the refreshed version everywhere
  and refetches the forge batch` (failed on the old hook: no `GET /api/forges` after the refresh).

Full runs (this worktree, after the last code commit):

- `pnpm check` (lint + credits check, typecheck, build, tests): exit 0. Tests: contracts 83, forge 94 (+4 skipped
  live), git-core 188, fixtures 53, web 249, daemon 226 (+1 skipped), e2e package 5, cli 139, scripts 34.
- `pnpm --filter @octopus-diff/e2e exec playwright test` (all): 91 passed in 2.9 min, no flaky or hung run
  (the `git-core has been disposed` lines in its log are the usual shutdown noise).
- `playwright test tests/14-ui-forge-details.spec.ts`: 2 passed.

## Decisions

#195 (this report's causes and fixes, and what was left for #8).

## Contract changes

None. (`packages/contracts/src/client.ts` still says "at most every 15 s per request" on
`refreshChangeRequest`; a comment only, contracts are the lead's: please fix it in a `contracts:` commit.)

## Dependencies

None added or removed (`pnpm credits` not needed).

## Known gaps

- A request created from another machine or the forge's web page, for a branch with no local push signal, still
  waits for the 2-minute poll. Not fixed: shortening it is the #8 strategy.
- A request on a branch no worktree has checked out is only in the Overview's list after its 10 min TTL or
  "Refresh" (the batch never asks about it).
- The Request tab's Refresh now costs 3 points (batch + detail + conversation), was 2.

## Notes for #8 (not changed here)

- Window focus / tab visibility could trigger one unforced `POST /api/forges/refresh`-style lookup; today the
  daemon only learns from its poll and local git events. The web `useForgesQuery` refetches on focus but the
  daemon serves its cache, so it never reaches the network.
- The 15 s per-project spacing, the 2-minute poll, the 60 s / 10 min detail TTLs, and the web `staleTime`s
  (60 s forges, 30 s detail, 60 s conversation) were left as is; the detail fingerprint includes `checks.state`
  so a CI flip refetches the detail, which is right but not budgeted.
- The follow-ups after a push cost 2 forced points per pushed branch without a request.
- Detail and conversation caches are keyed per request number but never evicted (a long-running daemon keeps
  every viewed request); repository entries are dropped per project.
- `refreshForges` (Settings "Check again") forces every project's batch (1 point each) with no per-call limit.
- The #27 cache keys (`stateHash` + default-branch oid) are the inbox/files caches, not forge caches: nothing
  there needed changing for #12.

## Notes for integration

Daemon + web only, plus docs. No contract changes. `DaemonInternals.forges.followUpMs` is test-only.
