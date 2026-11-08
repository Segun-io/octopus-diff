import {
  APP_NAME,
  type ApiClient,
  ApiClientError,
  AUTH_QUERY_PARAM,
  type HealthResponse,
} from '@octopus-diff/contracts';
import type { AddressFlags } from '../args.js';
import type { ResolvedConfig } from '../config.js';
import type { CliDeps } from '../deps.js';
import { CliError } from '../errors.js';
import { readRuntimeInfo, readToken, tokenFilePath } from '../runtime.js';
import { baseUrlFor, resolveAddress } from '../settings.js';

export function authUrlFor(baseUrl: string, token: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/?${AUTH_QUERY_PARAM}=${encodeURIComponent(token)}`;
}

/** Health of the daemon at `baseUrl`, or null if nothing (or something else) answers there. */
export async function probeHealth(baseUrl: string, deps: CliDeps): Promise<HealthResponse | null> {
  try {
    return await deps.createApiClient({ baseUrl }).health();
  } catch {
    return null;
  }
}

/** The daemon recorded in `<stateDir>/daemon.json`, if its process is alive and it answers. */
export async function findRunningDaemon(
  stateDir: string,
  deps: CliDeps,
): Promise<{ url: string; pid: number; health: HealthResponse } | null> {
  const info = await readRuntimeInfo(stateDir);
  if (!info || !deps.isProcessAlive(info.pid)) return null;
  const health = await probeHealth(info.url, deps);
  return health ? { url: info.url, pid: info.pid, health } : null;
}

export type DaemonSource = 'flag' | 'runtime' | 'config';

export interface DaemonConnection {
  client: ApiClient;
  baseUrl: string;
  source: DaemonSource;
  health: HealthResponse;
  token: string;
}

/**
 * Finds the daemon to talk to: `--url` > `<stateDir>/daemon.json` (written by `serve`) >
 * host/port from flags/config. Reads the token from `<stateDir>/token`. Throws a `CliError` with
 * a clear message when no daemon answers.
 */
export async function connectToDaemon(
  flags: AddressFlags & { url?: string },
  config: ResolvedConfig,
  stateDir: string,
  deps: CliDeps,
): Promise<DaemonConnection> {
  let baseUrl: string;
  let source: DaemonSource;
  if (flags.url) {
    let parsed: URL;
    try {
      parsed = new URL(flags.url);
    } catch {
      throw new CliError(`--url is not a valid URL: ${flags.url}`);
    }
    baseUrl = parsed.origin;
    source = 'flag';
  } else {
    const info = await readRuntimeInfo(stateDir);
    if (
      info &&
      deps.isProcessAlive(info.pid) &&
      flags.host === undefined &&
      flags.port === undefined
    ) {
      baseUrl = info.url;
      source = 'runtime';
    } else {
      const { host, port } = resolveAddress(flags, config);
      baseUrl = baseUrlFor(host, port);
      source = 'config';
    }
  }

  let health: HealthResponse;
  try {
    health = await deps.createApiClient({ baseUrl }).health();
  } catch (error) {
    if (error instanceof ApiClientError && error.code === 'network') {
      throw new CliError(
        `no ${APP_NAME} daemon is running at ${baseUrl}. Start one with \`${APP_NAME} serve\`` +
          (source === 'config' ? ' (or pass --url / --port if it runs elsewhere).' : '.'),
      );
    }
    throw new CliError(
      `something at ${baseUrl} answered, but it is not an ${APP_NAME} daemon (${(error as Error).message})`,
    );
  }

  const token = await readToken(stateDir);
  if (!token) {
    throw new CliError(
      `no auth token at ${tokenFilePath(stateDir)}. Is the daemon at ${baseUrl} using a different ` +
        '--state-dir?',
    );
  }
  return { client: deps.createApiClient({ baseUrl, token }), baseUrl, source, health, token };
}

/** Turns API client errors into one readable line. */
export function describeApiError(error: unknown): string {
  if (error instanceof ApiClientError) {
    if (error.code === 'unauthorized') {
      return 'the daemon rejected the token (it may use a different --state-dir)';
    }
    if (error.code === 'not_a_repository') return 'not a git repository';
    if (error.code === 'network') return 'lost the connection to the daemon';
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
