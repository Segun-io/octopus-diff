import { isIP } from 'node:net';
import type { NetworkInterfaceInfo } from 'node:os';
import { AUTH_FRAGMENT_PARAM } from '@octopus-diff/contracts';

export type NetworkInterfaces = NodeJS.Dict<NetworkInterfaceInfo[]>;

/**
 * The URL that signs a browser in: `<base>/#token=<token>`. A fragment never reaches a server,
 * a log or a `Referer` header (auth v2, see the contracts' common.ts).
 */
export function authUrlFor(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/#${AUTH_FRAGMENT_PARAM}=${encodeURIComponent(token)}`;
}

function bare(host: string): string {
  return host.replace(/^\[|\]$/g, '').toLowerCase();
}

/** `0.0.0.0`, `::` (any spelling): the daemon listens on every interface. */
export function isWildcardHost(host: string): boolean {
  const h = bare(host);
  return h === '0.0.0.0' || h === '::' || h === '0:0:0:0:0:0:0:0';
}

/**
 * For a wildcard bind, the URL hosts other devices can use: every non-internal interface
 * address (IPv4 for `0.0.0.0`; IPv4 and IPv6 for a dual-stack `::`). IPv6 link-local addresses
 * are skipped (they need a zone id that browsers don't accept). Empty for other binds.
 */
export function lanHosts(bindHost: string, interfaces: NetworkInterfaces): string[] {
  if (!isWildcardHost(bindHost)) return [];
  const ipv6 = bare(bindHost) !== '0.0.0.0';
  const hosts = new Set<string>();
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (info.internal) continue;
      if (isIP(info.address) === 4) hosts.add(info.address);
      else if (ipv6 && isIP(info.address) === 6 && !/^fe[89ab]/i.test(info.address)) {
        hosts.add(`[${info.address.toLowerCase()}]`);
      }
    }
  }
  return [...hosts];
}

/** One `#token=` URL per LAN address of a wildcard bind (a `127.0.0.1` URL is useless there). */
export function lanAuthUrls(
  bindHost: string,
  port: number,
  token: string,
  interfaces: NetworkInterfaces,
): string[] {
  return lanHosts(bindHost, interfaces).map((host) => authUrlFor(`http://${host}:${port}`, token));
}
