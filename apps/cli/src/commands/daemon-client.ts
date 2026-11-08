import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  APP_NAME,
  type ApiClient,
  ApiClientError,
  type HealthResponse,
  healthProofMessage,
} from '@octopus-diff/contracts';
import type { AddressFlags } from '../args.js';
import type { ResolvedConfig } from '../config.js';
import type { CliDeps } from '../deps.js';
import { CliError } from '../errors.js';
import { type RuntimeInfo, readRuntimeInfo, readToken, tokenFilePath } from '../runtime.js';
import { baseUrlFor, resolveAddress } from '../settings.js';

export { authUrlFor } from '../urls.js';

/** A fresh random challenge for `GET /api/health?challenge=` (64 lowercase hex chars). */
export function newChallenge(): string {
  return randomBytes(32).toString('hex');
}

/** The proof a daemon holding `token` returns for `challenge` (see `healthProofMessage`). */
export function expectedProof(token: string, challenge: string): string {
  return createHmac('sha256', token).update(healthProofMessage(challenge), 'utf8').digest('hex');
}

/** Constant-time check of a daemon's `proof`. */
export function proofMatches(token: string, challenge: string, proof: string | undefined): boolean {
  if (proof === undefined || !/^[0-9a-f]{64}$/.test(proof)) return false;
  return timingSafeEqual(
    Buffer.from(expectedProof(token, challenge), 'hex'),
    Buffer.from(proof, 'hex'),
  );
}

/**
 * Unauthenticated health of whatever answers at `baseUrl`, or null. Identity only: never send
 * the token (or print a tokenized URL) based on this alone; use `verifyDaemon`.
 */
export async function probeHealth(baseUrl: string, deps: CliDeps): Promise<HealthResponse | null> {
  try {
    return await deps.createApiClient({ baseUrl }).health();
  } catch {
    return null;
  }
}

export interface VerifiedHealth {
  health: HealthResponse;
  /** True when the daemon proved it holds `token` (SEC-02/SEC-12). */
  verified: boolean;
}

/**
 * Asks `baseUrl` for its health with a fresh random challenge and checks the HMAC proof
 * against `token`. The token itself is never sent. Rejects like `ApiClient.health`.
 */
export async function verifyDaemon(
  baseUrl: string,
  token: string | null,
  deps: CliDeps,
): Promise<VerifiedHealth> {
  const challenge = newChallenge();
  const health = await deps.createApiClient({ baseUrl }).health({ challenge });
  return { health, verified: token !== null && proofMatches(token, challenge, health.proof) };
}

export interface RunningDaemon extends VerifiedHealth {
  url: string;
  pid: number;
  info: RuntimeInfo;
  /** The state dir's token (null if missing); only use it when `verified`. */
  token: string | null;
}

/**
 * The daemon recorded in `<stateDir>/daemon.json`, if its process is alive (and ours) and
 * something answers at its URL. Check `verified` before trusting it with the token.
 */
export async function findRunningDaemon(
  stateDir: string,
  deps: CliDeps,
): Promise<RunningDaemon | null> {
  const info = await readRuntimeInfo(stateDir);
  if (!info || !deps.isProcessAlive(info.pid)) return null;
  const token = await readToken(stateDir);
  try {
    const result = await verifyDaemon(info.url, token, deps);
    return { ...result, url: info.url, pid: info.pid, info, token };
  } catch {
    return null;
  }
}

export type DaemonSource = 'flag' | 'runtime' | 'config';

export interface DaemonConnection {
  client: ApiClient;
  baseUrl: string;
  source: DaemonSource;
  health: HealthResponse;
  token: string;
  /** daemon.json, when the daemon was found through it (its `host` is the bind address). */
  runtime: RuntimeInfo | null;
}

/** Why a daemon was not trusted with the token. */
export function unverifiedMessage(baseUrl: string, stateDir: string): string {
  return (
    `${baseUrl} answered like an ${APP_NAME} daemon but could not prove that it holds the token ` +
    `in ${tokenFilePath(stateDir)}, so the token was not sent. It may use another --state-dir, ` +
    `still hold a token replaced by \`${APP_NAME} token --rotate\` or run an older ${APP_NAME} ` +
    '(restart it in both cases), or be another program listening on that port.'
  );
}

/**
 * Finds the daemon to talk to: `--url` > `<stateDir>/daemon.json` (written by `serve`) >
 * host/port from flags/config, and verifies with a health challenge that it holds the token in
 * `<stateDir>/token` before returning a client that sends it. Throws a `CliError` with a clear
 * message when no daemon answers or it can't prove its identity.
 */
export async function connectToDaemon(
  flags: AddressFlags & { url?: string },
  config: ResolvedConfig,
  stateDir: string,
  deps: CliDeps,
): Promise<DaemonConnection> {
  let baseUrl: string;
  let source: DaemonSource;
  let runtime: RuntimeInfo | null = null;
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
      runtime = info;
    } else {
      const { host, port } = resolveAddress(flags, config);
      baseUrl = baseUrlFor(host, port);
      source = 'config';
    }
  }

  const token = await readToken(stateDir);
  let result: VerifiedHealth;
  try {
    result = await verifyDaemon(baseUrl, token, deps);
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

  if (!token) {
    throw new CliError(
      `no auth token at ${tokenFilePath(stateDir)}. Is the daemon at ${baseUrl} using a different ` +
        '--state-dir?',
    );
  }
  if (!result.verified) throw new CliError(unverifiedMessage(baseUrl, stateDir));
  return {
    client: deps.createApiClient({ baseUrl, token }),
    baseUrl,
    source,
    health: result.health,
    token,
    runtime,
  };
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
