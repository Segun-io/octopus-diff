# gzip-etag report (GitHub #28)

## Shipped
- `apps/daemon/src/http-cache.ts`: Hono middleware `httpCache({ revalidate })`, mounted in `app.ts` on `/api/*`
  right after the token check (Host/Origin/token/CSP code untouched).
  - gzip level 1 (Node zlib, no dependency, async on the libuv pool) for 200 JSON `GET`s of at least 1 KiB when
    `Accept-Encoding` allows gzip; `Vary: Accept-Encoding` on every JSON `GET`; `Content-Length` of the packed body.
  - Weak ETag (SHA-1 of the uncompressed body, trailing per-request `"generatedAt"` excluded) and `If-None-Match`
    → 304 on `/api/projects`, `/api/inbox`, `/api/worktrees/:id/files`. Those three send `Cache-Control: no-cache`
    (so a browser keeps and revalidates them); everything else stays `no-store`.
  - SSE, POSTs, error bodies, small bodies: untouched.
- Tests: `apps/daemon/test/http-cache.test.ts` (11 tests); `auth.test.ts` adjusted for the `no-cache` exception.
- Docs: DECISIONS #171, one paragraph in PLAN §5.4.

## Verification
- `pnpm check` (lint + credits check, typecheck, build, test): exit 0. daemon 210 passed (22 files; 11 new),
  web 240, contracts 83, git-core 176, forge 94 passed / 4 skipped (pre-existing), cli 139, fixtures 48, e2e unit 5,
  scripts 34.
- `pnpm test:e2e` (full Playwright, 4.0 min, no daemon-shutdown hang this run): 89 passed, 1 failed:
  `16-copy.spec.ts:226` "select two lines → Copy bar" (drag selection did not show the bar). Re-run of
  `tests/16-copy.spec.ts` alone twice: 9 passed both times, so it looks like a timing flake in a UI drag test
  that does not touch these routes; not reproduced, not verified on `main`.
- Measured: 4500-file inbox (~1.2 MB) gzips >5x asserted (about 7-9x on this synthetic data); 10.6 MB list: gzip1 +
  hash + copy under 50 ms (asserted, best of 7, against the same route without the middleware). Micro numbers
  (9.3 MB): gzip1 20 ms, gzip4 33 ms, brotli q4 40 ms, sha1 3.8 ms.

## Decisions
DECISIONS #171: gzip 1 over brotli; body hash over `stateHash` (review marks and forge data are not in it, inbox spans
worktrees); `generatedAt` excluded from the hash (without it the inbox ETag never matched: found by the first test
run); `no-cache` instead of `no-store` on the three listings so browsers can send `If-None-Match` at all.

## Contract changes
None.

## Dependencies
None added (`pnpm credits:check` is clean).

## Known gaps
- The daemon still builds the full body for every request (hash needs it); #27's caches reduce that cost, the ETag
  saves transfer only. A state-derived ETag that skips building the body would need per-route invalidation.
- `no-cache` lets the browser keep the project/inbox/files listings (paths and counts, never diff contents) in its
  private HTTP cache. If that is unwanted, revert to `no-store` (ETag then only helps non-browser clients).
- Not checked in a real browser by hand: browser 304/Content-Encoding behaviour relies on standard fetch semantics;
  covered over real HTTP with Node's fetch (gzip decode, 304) only.

## Notes for integration
- Only `apps/daemon/src/app.ts` (import, one `onApi(httpCache(...))` line, the Cache-Control rule in the
  security-header middleware) and the new `http-cache.ts` changed in src. DECISIONS #171.
- Conflict watch with #27 (`core.ts`, web hooks): none expected. If #27 adds a state-derived cache key, an ETag
  from it could replace the body hash for the inbox.
