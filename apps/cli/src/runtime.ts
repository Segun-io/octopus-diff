import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { RUNTIME_FILE_NAME, TOKEN_FILE_NAME } from './paths.js';

/**
 * `<stateDir>/daemon.json`: written by `octopus-diff serve` after the daemon starts and removed on
 * shutdown, so `add` / `status` / `doctor` can find a daemon that picked a non-default port. It
 * holds no secrets (the token stays in `<stateDir>/token`), but is written 0600 anyway.
 */
export const RuntimeInfoSchema = z.object({
  pid: z.number().int().positive(),
  url: z.url(),
  host: z.string(),
  port: z.number().int().min(0).max(65_535),
  version: z.string(),
  startedAt: z.string(),
});
export type RuntimeInfo = z.infer<typeof RuntimeInfoSchema>;

export function runtimeFilePath(stateDir: string): string {
  return path.join(stateDir, RUNTIME_FILE_NAME);
}

export function tokenFilePath(stateDir: string): string {
  return path.join(stateDir, TOKEN_FILE_NAME);
}

export async function writeRuntimeInfo(stateDir: string, info: RuntimeInfo): Promise<void> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const file = runtimeFilePath(stateDir);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(info, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, file);
}

export async function readRuntimeInfo(stateDir: string): Promise<RuntimeInfo | null> {
  try {
    const parsed = RuntimeInfoSchema.safeParse(
      JSON.parse(await readFile(runtimeFilePath(stateDir), 'utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Removes the runtime file, but only if it still belongs to `pid` (another serve may own it). */
export async function removeRuntimeInfo(stateDir: string, pid: number): Promise<void> {
  const current = await readRuntimeInfo(stateDir);
  if (current && current.pid !== pid) return;
  await rm(runtimeFilePath(stateDir), { force: true });
}

/** The daemon's auth token, or null if it has not been created yet. */
export async function readToken(stateDir: string): Promise<string | null> {
  try {
    const token = (await readFile(tokenFilePath(stateDir), 'utf8')).trim();
    return token === '' ? null : token;
  } catch {
    return null;
  }
}

/**
 * `process.kill(pid, 0)`: true if a process with this pid exists **and belongs to this user**.
 * `EPERM` (another user's process, e.g. after pid reuse) is not our daemon (SEC-02).
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Replaces `<stateDir>/token` with a new random token (same format as the daemon's: 32 random
 * bytes, base64url), written to a new 0600 file renamed over the old one. Returns the token.
 */
export async function rotateToken(stateDir: string): Promise<string> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const file = tokenFilePath(stateDir);
  const token = randomBytes(32).toString('base64url');
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(tmp, `${token}\n`, { mode: 0o600, flag: 'wx' });
  try {
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  return token;
}
