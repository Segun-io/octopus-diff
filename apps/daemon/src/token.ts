import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { healthProofMessage } from '@octopus-diff/contracts';

export const TOKEN_FILE = 'token';
/** Header-safe and URL-fragment-safe (no encoding needed in `#token=`). */
const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{16,512}$/;

export function isValidToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Constant-time comparison (hashing first makes the lengths equal). */
export function tokensEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb);
}

/**
 * `proof` for `GET /api/health?challenge=` (security review SEC-02/SEC-12): hex
 * HMAC-SHA256 keyed by the token over `healthProofMessage(challenge)`. Proves possession of the
 * token without revealing it.
 */
export function healthProof(token: string, challenge: string): string {
  return createHmac('sha256', token).update(healthProofMessage(challenge), 'utf8').digest('hex');
}

export interface LoadedToken {
  token: string;
  /** Where it came from, for logs. `replaced`: the old file was exposed and was regenerated. */
  source: 'option' | 'file' | 'created' | 'replaced';
  warnings: string[];
}

/**
 * Writes a fresh token to `file` atomically: a new 0600 file is renamed over the old one, so
 * a process that opened the old file (or a hard link to it) never sees the new token.
 */
async function writeNewToken(file: string): Promise<string> {
  const token = generateToken();
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(`${token}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  return token;
}

/** Why an existing token file can no longer be trusted, or null if it is private. */
async function exposure(file: string): Promise<string | null> {
  if (process.platform === 'win32') return null;
  const info = await stat(file);
  if ((info.mode & 0o077) !== 0) {
    return `was readable or writable by other users (mode ${(info.mode & 0o777).toString(8)})`;
  }
  const uid = process.getuid?.();
  if (uid !== undefined && info.uid !== uid) return `was owned by another user (uid ${info.uid})`;
  return null;
}

/**
 * Returns the per-install token: the explicit option, else `<stateDir>/token` (created with
 * mode 0600 if missing or invalid). A token file that other users could read or write is
 * replaced with a new token (SEC-11): it may already have been copied, so tightening its mode
 * would not help. The token itself is never logged.
 */
export async function loadOrCreateToken(stateDir: string, explicit?: string): Promise<LoadedToken> {
  const warnings: string[] = [];
  if (explicit !== undefined) {
    if (!isValidToken(explicit)) {
      throw new Error('token must be 16-512 characters of [A-Za-z0-9._~-]');
    }
    return { token: explicit, source: 'option', warnings };
  }
  const file = path.join(stateDir, TOKEN_FILE);
  try {
    const existing = (await readFile(file, 'utf8')).trim();
    if (isValidToken(existing)) {
      const problem = await exposure(file);
      if (problem === null) return { token: existing, source: 'file', warnings };
      const token = await writeNewToken(file);
      warnings.push(
        `the auth token file ${file} ${problem}, so the token may have been copied; ` +
          'replaced it with a new token. Previously printed URLs and signed-in browser tabs ' +
          'stop working: open the new URL.',
      );
      return { token, source: 'replaced', warnings };
    }
    warnings.push(`${file} did not contain a valid token; generated a new one`);
    return { token: await writeNewToken(file), source: 'created', warnings };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const token = generateToken();
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, 'wx', 0o600);
  } catch (error) {
    // Another process created it in the meantime: use theirs.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return loadOrCreateToken(stateDir);
    throw error;
  }
  try {
    await handle.writeFile(`${token}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  return { token, source: 'created', warnings };
}
