import {
  type ForgeDetection,
  type ForgeHostOverride,
  ForgeHostSchema,
  type ForgeKind,
  ForgeRepositoryPathSchema,
} from '@octopus-diff/contracts';

/**
 * Remote URL parsing and forge recognition. Ideas (scp-form parsing, hostname-label rules,
 * per-host CLI-login refinement for self-hosted instances) follow T3 Code's
 * `source-control-core/src/shared/definition.ts` and the GitHub/GitLab definitions
 * (https://github.com/pingdotgg/t3code, MIT); the code here is written for octopus-diff.
 */

export interface ParsedRemote {
  /** Lower-case host as an API/web host: includes the port for http(s) remotes, never for ssh. */
  host: string;
  /** Lower-case hostname without port. */
  hostname: string;
  /** Repository path without leading slash and `.git` (`owner/name`, `group/sub/project`). */
  path: string;
  /** The remote used ssh (`git@host:path`, `ssh://`), so `host` may be an ssh-config alias. */
  ssh: boolean;
}

/** `user@host:path` (scp-like). Not a URL: no `://` before the colon. */
const SCP_REMOTE = /^(?:([^@/:]+)@)?([^@/:[\]]+|\[[^\]]+\]):(?!\/\/)(.+)$/;

function cleanPath(raw: string): string | null {
  const trimmed = raw
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  if (trimmed.length === 0) return null;
  return ForgeRepositoryPathSchema.safeParse(trimmed).success ? trimmed : null;
}

/**
 * Parses a git remote URL (`https://`, `ssh://`, `git://`, scp-like `git@host:path`). Null for
 * local paths, `file://`, and anything whose host or path is not plainly a hostname and a
 * repository path (those are never sent to a forge CLI).
 */
export function parseRemoteUrl(remoteUrl: string): ParsedRemote | null {
  const value = remoteUrl.trim();
  if (value.length === 0 || value.startsWith('-')) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return null;
    }
    const protocol = url.protocol.toLowerCase();
    const ssh = protocol === 'ssh:' || protocol === 'git+ssh:' || protocol === 'ssh+git:';
    if (!ssh && protocol !== 'https:' && protocol !== 'http:' && protocol !== 'git:') return null;
    const hostname = url.hostname.toLowerCase();
    const host = ssh || url.port === '' ? hostname : `${hostname}:${url.port}`;
    const path = cleanPath(decodeURIComponent(url.pathname));
    if (!ForgeHostSchema.safeParse(host).success || path === null) return null;
    return { host, hostname, path, ssh };
  }
  // A Windows drive path (`C:\repo`, `C:/repo`) is local, not scp-like.
  if (/^[a-z]:[\\/]/i.test(value)) return null;
  const scp = SCP_REMOTE.exec(value);
  if (!scp) return null;
  const hostname = (scp[2] ?? '').toLowerCase();
  const path = cleanPath(scp[3] ?? '');
  if (!ForgeHostSchema.safeParse(hostname).success || path === null) return null;
  return { host: hostname, hostname, path, ssh: true };
}

/** Recognises a forge from the hostname alone. */
export function forgeFromHostname(hostname: string): ForgeKind | null {
  const host = hostname.toLowerCase().replace(/:\d+$/, '');
  const labels = host.split('.');
  if (host === 'github.com' || host.endsWith('.ghe.com') || labels.includes('github')) {
    return 'github';
  }
  if (host === 'gitlab.com' || labels.includes('gitlab')) return 'gitlab';
  return null;
}

/** Repository paths each forge can have: GitHub is exactly `owner/name`; GitLab nests groups. */
export function isRepositoryPathFor(kind: ForgeKind, path: string): boolean {
  if (!ForgeRepositoryPathSchema.safeParse(path).success) return false;
  return kind === 'github' ? path.split('/').length === 2 : path.split('/').length >= 2;
}

export interface HostClassifyInput {
  host: string;
  /** `AppSettings.forges.hosts`. */
  overrides: Readonly<Record<string, ForgeHostOverride>>;
  /** Hosts each CLI is signed in to (lower case). */
  logins: Readonly<Record<ForgeKind, ReadonlySet<string>>>;
}

export type HostClassification =
  | { kind: ForgeKind; detectedBy: ForgeDetection }
  | { kind: null; ignored: boolean };

/** Setting override, then the hostname, then a CLI login for that exact host. */
export function classifyHost(input: HostClassifyInput): HostClassification {
  const override = input.overrides[input.host] ?? input.overrides[input.host.replace(/:\d+$/, '')];
  if (override === 'none') return { kind: null, ignored: true };
  if (override === 'github' || override === 'gitlab') {
    return { kind: override, detectedBy: 'setting' };
  }
  const byName = forgeFromHostname(input.host);
  if (byName) return { kind: byName, detectedBy: 'hostname' };
  if (input.logins.github.has(input.host)) return { kind: 'github', detectedBy: 'cli-login' };
  if (input.logins.gitlab.has(input.host)) return { kind: 'gitlab', detectedBy: 'cli-login' };
  return { kind: null, ignored: false };
}

/** Web page of a repository (`https://host/path`). */
export function repositoryWebUrl(host: string, path: string): string {
  return `https://${host}/${path}`;
}
