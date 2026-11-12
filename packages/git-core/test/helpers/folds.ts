import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { foldsCase } from '../../src/incremental.js';

/**
 * Does a worktree in the OS temp dir sit on a case-folding or Unicode-normalising filesystem, as
 * the implementation's own probe sees it (macOS and Windows always; `OCTOPUS_DIFF_TEST_FOLDS_CASE=1`
 * forces it)? There every refresh is full by design (DECISIONS #288): tests about the incremental
 * path are skipped and the fallback is asserted instead.
 */
export async function worktreesFoldCase(): Promise<boolean> {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'octopus-diff-fold-'));
  try {
    mkdirSync(path.join(dir, '.git'));
    return await foldsCase(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export const FOLDING_SKIP =
  'case-folding filesystem: incremental refreshes are off by design, the fallback is tested instead';
