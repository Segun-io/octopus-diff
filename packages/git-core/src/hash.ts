import { createHash } from 'node:crypto';

/**
 * Stable identifier used for project, worktree and scan-root ids (DECISIONS #8): the first 16
 * lowercase hex chars of SHA-256 over the UTF-8 value (a realpath).
 */
export function hashId(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16);
}

/** Length of `patchHash` values (hex chars of SHA-256). */
export const PATCH_HASH_LENGTH = 40;
/** Length of `stateHash` values (hex chars of SHA-256). */
export const STATE_HASH_LENGTH = 32;

const PATCH_HASH_PREFIX = 'octopus-diff/patch/v1\n';

/** Incremental hasher for one file's canonical patch; input is bstr (raw bytes). */
export class PatchHasher {
  private readonly hash = createHash('sha256');
  bytes = 0;

  constructor(kind: string) {
    this.hash.update(PATCH_HASH_PREFIX, 'latin1');
    this.hash.update(`${kind}\n`, 'latin1');
  }

  update(data: string): void {
    this.bytes += data.length;
    this.hash.update(data, 'latin1');
  }

  updateBytes(data: Uint8Array): void {
    this.bytes += data.length;
    this.hash.update(data);
  }

  digest(): string {
    return this.hash.digest('hex').slice(0, PATCH_HASH_LENGTH);
  }
}

/** Hashes a list of parts (bstr or numbers) with unambiguous separators. */
export function hashParts(parts: ReadonlyArray<string | number | null>, length: number): string {
  const hash = createHash('sha256');
  for (const part of parts) {
    const text = part === null ? '\u0001null' : String(part);
    hash.update(`${text.length}:`, 'latin1');
    hash.update(text, 'latin1');
  }
  return hash.digest('hex').slice(0, length);
}
