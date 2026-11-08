import { isIP } from 'node:net';
import os from 'node:os';

/** Host names that always mean "this machine" and cannot be rebound by DNS. */
const LOOPBACK_NAMES = new Set(['localhost']);

/** Strips IPv6 brackets and lowercases. */
function bare(hostname: string): string {
  const h = hostname.toLowerCase();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/** True for `localhost`, 127.0.0.0/8, `::1` and IPv4-mapped loopback (with or without brackets). */
export function isLoopbackHost(hostname: string): boolean {
  const h = bare(hostname);
  if (LOOPBACK_NAMES.has(h)) return true;
  if (isIP(h) === 4) return h.startsWith('127.');
  if (isIP(h) === 6) {
    if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
    const mapped = /^::ffff:(.+)$/.exec(h)?.[1];
    if (mapped) {
      if (isIP(mapped) === 4) return mapped.startsWith('127.');
      // URL-normalized form, e.g. ::ffff:7f00:1
      return /^7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(mapped);
    }
  }
  return false;
}

export function isWildcardHost(hostname: string): boolean {
  const h = bare(hostname);
  return h === '0.0.0.0' || h === '::' || h === '0:0:0:0:0:0:0:0';
}

const HOST_HEADER_PATTERN = /^[A-Za-z0-9.\-_:[\]%]+$/;

export interface ParsedHost {
  /** Lowercased host name; IPv6 literals keep their brackets (URL form). */
  hostname: string;
  /** Explicit port, or null when absent (or the scheme default). */
  port: number | null;
  /** `hostname[:port]` as normalized by the URL parser. */
  host: string;
}

/** Parses a `Host` header value (or an `allowedHosts` entry). Rejects anything URL-ish. */
export function parseHost(value: string): ParsedHost | null {
  if (!value || value.length > 300 || !HOST_HEADER_PATTERN.test(value)) return null;
  try {
    const url = new URL(`http://${value}`);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) return null;
    const explicitPort = /:(\d+)$/.exec(value)?.[1];
    return {
      hostname: url.hostname.toLowerCase(),
      port: explicitPort !== undefined ? Number(explicitPort) : null,
      host: url.host.toLowerCase(),
    };
  } catch {
    return null;
  }
}

export interface HostPolicy {
  /** Address the server is bound to. */
  boundHost: string;
  /** Actual listening port (known after listen). */
  port: () => number;
  /** Extra accepted Host values: `name` (any port) or `name:port`. */
  allowedHosts: readonly string[];
}

function localAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list ?? []) out.add(addr.address.toLowerCase());
  }
  return out;
}

/**
 * DNS-rebinding defense (PLAN §5.4): the Host header must name this daemon. Accepted:
 * loopback names/addresses with the bound port; the bound address itself (non-loopback binds,
 * which need `allowNonLoopback`); for wildcard binds, IP literals of local interfaces; and
 * `allowedHosts` entries (`name` matches any port, `name:port` only that port).
 */
export function isHostAllowed(hostHeader: string | undefined, policy: HostPolicy): boolean {
  if (!hostHeader) return false;
  const parsed = parseHost(hostHeader);
  if (!parsed) return false;
  const port = parsed.port ?? 80;
  for (const entry of policy.allowedHosts) {
    const allowed = parseHost(entry.trim());
    if (!allowed || allowed.hostname !== parsed.hostname) continue;
    if (allowed.port === null || allowed.port === port) return true;
  }
  if (port !== policy.port()) return false;
  const hn = bare(parsed.hostname);
  if (isLoopbackHost(hn)) return true;
  if (hn === bare(policy.boundHost)) return true;
  if (isWildcardHost(policy.boundHost) && isIP(hn) !== 0 && localAddresses().has(hn)) return true;
  return false;
}

/**
 * Cross-site request defense: when an `Origin` header is present it must be this daemon's own
 * origin, i.e. http(s) with exactly the (already validated) Host. `Origin: null` is rejected.
 */
export function isOriginAllowed(
  origin: string | undefined,
  hostHeader: string | undefined,
): boolean {
  if (origin === undefined) return true;
  if (!hostHeader) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  if (url.origin === 'null') return false;
  const host = parseHost(hostHeader);
  if (!host) return false;
  if (url.protocol === 'http:') return url.host.toLowerCase() === host.host;
  // https (TLS-terminating proxy listed in allowedHosts): compare names and explicit ports.
  const httpsDefault = host.port === null || host.port === 443;
  return (
    url.hostname.toLowerCase() === host.hostname &&
    (url.port === '' ? httpsDefault : Number(url.port) === host.port)
  );
}

/** Formats a host for use in a URL (brackets for IPv6). */
export function hostForUrl(host: string): string {
  return isIP(bare(host)) === 6 ? `[${bare(host)}]` : host;
}

/** Content-Security-Policy for the web UI (see DECISIONS, WS2). */
export const UI_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

/** CSP for API responses and error pages: nothing may load. */
export const API_CSP = "default-src 'none'; frame-ancestors 'none'";

/** True for `/api` and everything below it. Pass Hono's routing path (`c.req.path`). */
export function isApiPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/');
}

/** `%XX` escapes of RFC 3986 unreserved characters (ALPHA, DIGIT, `-`, `.`, `_`, `~`). */
const ENCODED_UNRESERVED = /%(?:[46][1-9a-f]|[57][0-9a]|3[0-9]|2[de]|5f|7e)/i;

/**
 * SEC-10: Hono routes on a percent-decoded path (`/%61pi/projects` reaches `/api/projects`),
 * while anything that looks at the raw URL sees `/%61pi/...`. No client needs to escape an
 * unreserved character (RFC 3986 §2.3 says they are equivalent unescaped), so such paths are
 * refused before routing; the remaining escapes (`%2F`, `%25`, …) are ones the router leaves
 * encoded too. Pass the raw path (`new URL(c.req.url).pathname`).
 */
export function hasEncodedUnreserved(rawPath: string): boolean {
  return ENCODED_UNRESERVED.test(rawPath);
}
