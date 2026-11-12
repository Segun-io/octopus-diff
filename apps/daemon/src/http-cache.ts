import { hash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { MiddlewareHandler } from 'hono';

/**
 * Compression and conditional requests for JSON API responses (DECISIONS #171, GitHub #28).
 *
 * - gzip level 1 for every successful JSON `GET` response of at least `MIN_COMPRESS_BYTES`, when the
 *   client accepts it. Level 1 measured 20 ms CPU per 9.3 MB (7x smaller); level 4 costs 33 ms for
 *   a few percent more, brotli q4 40 ms. Node's zlib runs it on the libuv pool, so the event loop
 *   is not blocked for the length of a 9 MB body. No dependency.
 * - ETag + `If-None-Match` (304) on the routes passed in `revalidate`: a weak validator, the SHA-1
 *   of the uncompressed body (3.8 ms per 9 MB; see `etagOf` for the one volatile field). Not a
 *   state id: the body also holds review marks, forge data and project fields that the worktree
 *   `stateHash` does not cover, so a hash of what we are about to send cannot be stale. The daemon still builds the body (the caches in
 *   `core.ts` make that cheap); the saving is the transfer, and the compression is skipped on 304.
 * - Server-sent events and anything that is not `application/json` pass through untouched.
 *
 * Mount it after the security headers, the Host/Origin checks and the token check, so a rejected
 * request never reaches it and a 304 is only ever answered to an authenticated client.
 */

/** Below this a response is not worth the gzip header and the CPU (and often grows). */
export const MIN_COMPRESS_BYTES = 1024;

/**
 * `Cache-Control` of a revalidated response. Browsers never keep a `no-store` response, so they
 * would never send `If-None-Match`; `no-cache` stores it but revalidates on every use. Only for
 * path-and-count listings (inbox, files, projects), never for diffs (file contents).
 */
export const REVALIDATE_CACHE_CONTROL = 'no-cache';

const gzipAsync = promisify(gzip);

/** True when `Accept-Encoding` allows gzip (`gzip`, `x-gzip` or `*`, and no `;q=0`). */
export function acceptsGzip(header: string | undefined): boolean {
  if (!header) return false;
  let star: boolean | null = null;
  for (const part of header.split(',')) {
    const [coding, ...params] = part.trim().toLowerCase().split(';');
    const q = params
      .map((p) => /^\s*q\s*=\s*([\d.]+)\s*$/.exec(p)?.[1])
      .find((v) => v !== undefined);
    const allowed = q === undefined ? true : Number(q) > 0;
    if (coding === 'gzip' || coding === 'x-gzip') return allowed;
    if (coding === '*') star = allowed;
  }
  return star === true;
}

/** `generatedAt` is the last key of the inbox body and changes on every request. */
const VOLATILE_TAIL = /,"generatedAt":"[^"]*"\}$/;

/**
 * The weak ETag of a body: SHA-1 of the body without a trailing `"generatedAt":"<now>"` (the one
 * per-request field the inbox carries; left in, no two answers would ever share an ETag). The tail
 * is found in the last 80 bytes and hashed as a view, no copy. If that field ever moves from the
 * end, the ETag only stops matching (a full 200 every time), never matches wrongly.
 */
export function etagOf(body: Uint8Array): string {
  const tailAt = Math.max(0, body.byteLength - 80);
  const tail = Buffer.from(body.buffer, body.byteOffset + tailAt, body.byteLength - tailAt);
  const match = VOLATILE_TAIL.exec(tail.toString('latin1'));
  const stable = match ? body.subarray(0, tailAt + match.index) : body;
  return `W/"${hash('sha1', stable, 'base64url')}"`;
}

/** Weak comparison of an `If-None-Match` value with our ETag (RFC 9110 §13.1.2). */
export function ifNoneMatchHits(header: string | undefined, etag: string): boolean {
  if (!header) return false;
  const bare = (tag: string) => tag.trim().replace(/^W\//, '');
  const ours = bare(etag);
  return header.split(',').some((tag) => tag.trim() === '*' || bare(tag) === ours);
}

function addVary(headers: Headers, field: string): void {
  const current = headers.get('Vary');
  if (!current) headers.set('Vary', field);
  else if (!current.split(',').some((v) => v.trim().toLowerCase() === field.toLowerCase())) {
    headers.set('Vary', `${current}, ${field}`);
  }
}

export interface HttpCacheOptions {
  /** `c.req.path` values that get an ETag and answer 304 (exact route paths, `:param` allowed). */
  revalidate: readonly RegExp[];
}

/** The middleware. Registered with `app.use` on the API paths. */
export function httpCache(options: HttpCacheOptions): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const res = c.res;
    if (c.req.method !== 'GET' || res.status !== 200 || res.body === null) return;
    if (res.headers.has('Content-Encoding')) return;
    if (!(res.headers.get('Content-Type') ?? '').startsWith('application/json')) return;

    // Vary on every JSON GET answer: whether it is packed depends on the request header.
    addVary(res.headers, 'Accept-Encoding');
    const revalidate = options.revalidate.some((re) => re.test(c.req.path));
    const gz = acceptsGzip(c.req.header('accept-encoding'));
    if (!revalidate && !gz) return;
    // Hono's `c.res` setter copies the old response's headers over the new one's, so what
    // changes is set on the old headers too (`res.headers`) before the response is replaced.
    const headers = res.headers;

    const body = new Uint8Array(await res.arrayBuffer());
    if (revalidate) {
      const etag = etagOf(body);
      headers.set('ETag', etag);
      headers.set('Cache-Control', REVALIDATE_CACHE_CONTROL);
      if (ifNoneMatchHits(c.req.header('if-none-match'), etag)) {
        headers.delete('Content-Length');
        c.res = new Response(null, { status: 304, headers });
        return;
      }
    }

    if (gz && body.byteLength >= MIN_COMPRESS_BYTES) {
      const packed = await gzipAsync(body, { level: 1 });
      headers.set('Content-Encoding', 'gzip');
      headers.set('Content-Length', String(packed.byteLength));
      c.res = new Response(packed, { status: 200, headers });
      return;
    }
    headers.set('Content-Length', String(body.byteLength));
    c.res = new Response(body, { status: 200, headers });
  };
}
