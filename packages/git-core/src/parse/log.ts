import type { CommitInfo } from '@octopus-diff/contracts';
import { splitNul } from './tokens.js';

/** `git log -z --format=` string matching `parseLog`. */
export const LOG_FORMAT = '%H%x00%h%x00%P%x00%s%x00%an%x00%ae%x00%at%x00%ct';
const FIELDS = 8;

/** ISO timestamps must have a 4-digit year (TimestampSchema); git allows any date. */
const MIN_MS = Date.parse('0000-01-01T00:00:00.000Z');
const MAX_MS = Date.parse('9999-12-31T23:59:59.999Z');

function isoFromUnix(seconds: string): string {
  const value = Number(seconds) * 1000;
  const ms = Number.isFinite(value) ? Math.min(Math.max(value, MIN_MS), MAX_MS) : 0;
  return new Date(ms).toISOString();
}

/**
 * Parses `git log -z --format=<LOG_FORMAT>` output (UTF-8 text). Each commit is 8 NUL-separated
 * fields; commits are NUL-separated too, so the token count is a multiple of 8.
 */
export function parseLog(output: string): CommitInfo[] {
  const tokens = splitNul(output);
  const commits: CommitInfo[] = [];
  for (let i = 0; i + FIELDS <= tokens.length; i += FIELDS) {
    const [
      sha = '',
      shortSha = '',
      parents = '',
      subject = '',
      name = '',
      email = '',
      at = '',
      ct = '',
    ] = tokens.slice(i, i + FIELDS);
    commits.push({
      sha,
      shortSha,
      parents: parents.length > 0 ? parents.split(' ') : [],
      subject,
      authorName: name,
      authorEmail: email,
      authorDate: isoFromUnix(at),
      committerDate: isoFromUnix(ct),
    });
  }
  return commits;
}
