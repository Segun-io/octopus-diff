/**
 * What the main process asks the daemon, through the contracts' API client (no git, no repository
 * access of its own): its health (liveness of an attached daemon, and whether git is usable) and
 * "add this folder" for File → Add Folder… (the same requests as `octopus-diff add`).
 *
 * The token comes from the ready line's `authUrl` and stays in memory: it is sent as a header,
 * never logged.
 */
import {
  ApiClientError,
  createApiClient,
  type HealthResponse,
  SCAN_DEPTH_DEFAULT,
} from '@octopus-diff/contracts';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The `#token=` value of an auth URL, or null. */
export function tokenFromAuthUrl(authUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(authUrl);
  } catch {
    return null;
  }
  const params = new URLSearchParams(url.hash.replace(/^#/, ''));
  const token = params.get('token');
  return token && token !== '' ? token : null;
}

/** Where the window goes: the auth URL, or (UI dev mode) the same fragment on the Vite server. */
export function windowUrl(authUrl: string, rendererUrl: string | null): string {
  if (!rendererUrl) return authUrl;
  const hash = new URL(authUrl).hash;
  const base = new URL(rendererUrl);
  base.hash = hash;
  return base.toString();
}

function withTimeout(fetchImpl: FetchLike, ms: number): FetchLike {
  return (input, init) => fetchImpl(input, { ...init, signal: AbortSignal.timeout(ms) });
}

export async function fetchHealth(
  url: string,
  token: string | null,
  fetchImpl: FetchLike = globalThis.fetch,
  timeoutMs = 3_000,
): Promise<HealthResponse | null> {
  const client = createApiClient({
    baseUrl: url,
    ...(token ? { token } : {}),
    fetch: withTimeout(fetchImpl, timeoutMs),
  });
  try {
    return await client.health();
  } catch {
    return null;
  }
}

export type GitStatus = 'ok' | 'missing' | 'unknown';

/** From the daemon's health: `missing` when it has no usable git (missing or too old). */
export function gitStatus(health: HealthResponse | null): GitStatus {
  if (!health) return 'unknown';
  return health.git.supported ? 'ok' : 'missing';
}

export type AddFolderResult =
  | { kind: 'project'; name: string; created: boolean }
  | { kind: 'not-a-repository'; message: string }
  | { kind: 'error'; message: string };

export async function addProject(
  url: string,
  token: string,
  folder: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<AddFolderResult> {
  const client = createApiClient({ baseUrl: url, token, fetch: fetchImpl });
  try {
    const { project, created } = await client.addProject({ path: folder });
    return { kind: 'project', name: project.project.name, created };
  } catch (error) {
    if (error instanceof ApiClientError && error.code === 'not_a_repository') {
      return { kind: 'not-a-repository', message: error.message };
    }
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}

export type AddScanRootResult =
  | { kind: 'scan-root'; created: boolean }
  | { kind: 'error'; message: string };

export async function addScanRoot(
  url: string,
  token: string,
  folder: string,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<AddScanRootResult> {
  const client = createApiClient({ baseUrl: url, token, fetch: fetchImpl });
  try {
    const { created } = await client.addScanRoot({ path: folder, depth: SCAN_DEPTH_DEFAULT });
    return { kind: 'scan-root', created };
  } catch (error) {
    return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
}
