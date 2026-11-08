import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, open, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const TOKEN_FILE = 'token';
/** Cookie-safe and header-safe: the token is also sent as a cookie value. */
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

export interface LoadedToken {
  token: string;
  /** Where it came from, for logs. */
  source: 'option' | 'file' | 'created';
  warnings: string[];
}

/**
 * Returns the per-install token: the explicit option, else `<stateDir>/token` (created with
 * mode 0600 if missing or invalid). The token itself is never logged.
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
      if (process.platform !== 'win32') {
        const info = await stat(file);
        if ((info.mode & 0o077) !== 0) {
          await chmod(file, 0o600);
          warnings.push(`tightened permissions of ${file} to 0600`);
        }
      }
      return { token: existing, source: 'file', warnings };
    }
    warnings.push(`${file} did not contain a valid token; generated a new one`);
    const token = generateToken();
    await writeFile(file, `${token}\n`, { mode: 0o600 });
    await chmod(file, 0o600);
    return { token, source: 'created', warnings };
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
