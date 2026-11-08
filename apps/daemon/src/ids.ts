import { createHash } from 'node:crypto';

/**
 * Stable id per DECISIONS #8: the first 16 lowercase hex chars of SHA-256 over the UTF-8
 * realpath. Used for scan-root ids (git-core computes project and worktree ids the same way).
 */
export function hashId(realpath: string): string {
  return createHash('sha256').update(realpath, 'utf8').digest('hex').slice(0, 16);
}
