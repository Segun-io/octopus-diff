import { appendFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIsolatedGitEnv, runGit } from '@octopus-diff/fixtures';
import { foldsCase } from '@octopus-diff/git-core';
import { describe, expect, it } from 'vitest';
import { summaryRoles } from '../bench/summary-roles.js';

// Greptile on PR #91: the bench's per-role summary table must use the mode the run asked for.
describe('summaryRoles', () => {
  it('measures with the incremental setting it is given', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'octopus-diff-roles-')));
    try {
      const env = await createIsolatedGitEnv(root);
      const repo = join(root, 'repo');
      await runGit(['init', '-q', repo], { cwd: root, env });
      await writeFile(join(repo, 'README.md'), 'readme\n');
      await runGit(['add', '-A'], { cwd: repo, env });
      await runGit(['commit', '-q', '-m', 'one'], { cwd: repo, env });
      await appendFile(join(repo, 'README.md'), 'dirty\n');
      const worktrees = [{ path: repo, role: 'main' }];
      const [on] = await summaryRoles(worktrees, env.vars, true, 2);
      const [off] = await summaryRoles(worktrees, env.vars, false, 2);
      // A case-folding filesystem (macOS, `OCTOPUS_DIFF_TEST_FOLDS_CASE=1`) refreshes in full by design.
      const folds = await foldsCase(repo);
      expect(on?.editModes).toEqual(folds ? ['full', 'full'] : ['incremental', 'incremental']);
      expect(off?.editModes).toEqual(['full', 'full']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
