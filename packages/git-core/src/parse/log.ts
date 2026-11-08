import type { CommitInfo } from '@octopus-diff/contracts';
import { splitNul } from './tokens.js';

/** `git log -z --format=` string matching `parseLog`. */
export const LOG_FORMAT = '%H%x00%h%x00%P%x00%s%x00%an%x00%ae%x00%at%x00%ct';
const FIELDS = 8;

function isoFromUnix(seconds: string): string {
  const value = Number(seconds);
  return new Date(Number.isFinite(value) ? value * 1000 : 0).toISOString();
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
