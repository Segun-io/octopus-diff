import type { FileStatus } from '@octopus-diff/contracts';
import type { ExpectedFile } from '@octopus-diff/fixtures';

// Pure helpers (no Playwright import) so vitest can unit-test them.

/**
 * Status equivalence between the daemon and the git oracle. The oracle runs without copy
 * detection, so a copy may legitimately be reported as `copied` by git-core and `added` by git.
 */
export function statusMatches(actual: FileStatus, expected: ExpectedFile): boolean {
  if (actual === expected.status) return true;
  return expected.status === 'added' && actual === 'copied';
}

/** Files whose line counts are compared exactly (plain text, below git-core's caps). */
export function hasComparableLineCounts(file: ExpectedFile): boolean {
  if (file.binary || file.additions === null || file.deletions === null) return false;
  if (file.newMode === '160000' || file.oldMode === '160000') return false;
  if (file.newMode === '120000' || file.oldMode === '120000') return false;
  if (file.status === 'conflicted' || file.status === 'typechange') return false;
  return file.additions + file.deletions < 20_000;
}

/** Counts `+`/`-` lines in a unified diff (headers excluded). */
export function countPatchLines(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) inHunk = false;
    else if (line.startsWith('@@')) inHunk = true;
    else if (inHunk && line.startsWith('+')) additions++;
    else if (inHunk && line.startsWith('-')) deletions++;
  }
  return { additions, deletions };
}

/** First added and removed content lines of a patch (for UI text assertions). */
export function sampleLines(patch: string): { added: string | null; removed: string | null } {
  let added: string | null = null;
  let removed: string | null = null;
  let inHunk = false;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) inHunk = true;
    else if (!inHunk) continue;
    const text = line.slice(1).trim();
    if (text.length < 6) continue;
    if (added === null && line.startsWith('+')) added = text;
    if (removed === null && line.startsWith('-')) removed = text;
    if (added !== null && removed !== null) break;
  }
  return { added, removed };
}
