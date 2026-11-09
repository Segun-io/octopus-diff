/**
 * PLAN §8 item 6 (and §4.1, §5.7): mark a file reviewed → it leaves the "unreviewed" views; edit
 * it again → it returns (the patch hash changed); restart the daemon → marks persist.
 */
import { join } from 'node:path';
import { TEST_IDS } from '@octopus-diff/contracts';
import { findWorktree, LIVE_FILES } from '@octopus-diff/fixtures';
import type { TestDaemon } from '../support/daemon.js';
import { liveBudgetMs } from '../support/env.js';
import { expect, test } from '../support/test.js';

async function reviewedInApi(daemon: TestDaemon, worktreeId: string, path: string) {
  const { files } = await daemon.client.listFiles(worktreeId);
  return files.find((f) => f.path === path)?.reviewed ?? null;
}

test.describe('§8.6 review marks', () => {
  test('mark → hidden from unreviewed views → edit → back → restart → persists', async ({
    manifest,
    daemon,
    app,
    edits,
  }) => {
    test.setTimeout(120_000);
    const live = findWorktree(manifest, 'live').worktree;
    const path = LIVE_FILES.review;
    await app.open(daemon.authUrl);
    await app.selectWorktree(live.id);
    await app.setToggle(TEST_IDS.showReviewedToggle, true);
    await app.openFile(path);
    await expect(app.fileItem(path)).toHaveAttribute('data-reviewed', 'false');

    // Mark reviewed with the toolbar button.
    await app.byTestId(TEST_IDS.reviewToggle).click();
    await expect(app.byTestId(TEST_IDS.reviewToggle)).toHaveAttribute('aria-pressed', 'true');
    await expect(app.fileItem(path)).toHaveAttribute('data-reviewed', 'true');
    await expect.poll(() => reviewedInApi(daemon, live.id, path)).toBe(true);

    // It leaves the unreviewed views: file list with "show reviewed" off, and the inbox API.
    await app.setToggle(TEST_IDS.showReviewedToggle, false);
    await expect(app.fileItem(path)).toHaveCount(0);
    const unreviewed = await daemon.client.inbox({ onlyUnreviewed: true });
    const entry = unreviewed.entries.find((e) => e.worktree.id === live.id);
    expect(entry?.files.map((f) => f.path) ?? []).not.toContain(path);

    // Edit it again: the patch hash changes, so the mark no longer applies.
    await edits.append(join(live.path, path), '// octopus-marker-review-edit\n');
    await expect(app.fileItem(path)).toHaveAttribute('data-reviewed', 'false', {
      timeout: liveBudgetMs() + 1000,
    });
    await expect.poll(() => reviewedInApi(daemon, live.id, path)).toBe(false);

    // Review the new state (keyboard this time), then restart the daemon.
    await app.openFile(path);
    await app.focusApp();
    await app.press('r');
    await expect.poll(() => reviewedInApi(daemon, live.id, path)).toBe(true);

    await daemon.restart();
    await daemon.waitForProjects();
    expect(await reviewedInApi(daemon, live.id, path)).toBe(true);
    await app.open(daemon.authUrl);
    await app.selectWorktree(live.id);
    await app.setToggle(TEST_IDS.showReviewedToggle, true);
    await expect(app.fileItem(path)).toHaveAttribute('data-reviewed', 'true');

    // Restoring the original content brings back the first patch hash, which was marked
    // reviewed before the edit: marks are keyed by patchHash, so it is reviewed again.
    await edits.restore();
    await expect(app.fileItem(path)).toHaveAttribute('data-reviewed', 'true', {
      timeout: liveBudgetMs() + 1000,
    });
  });

  test('a worktree with every file reviewed leaves the only-unreviewed sidebar filter', async ({
    manifest,
    daemon,
    app,
    edits,
  }) => {
    const agent = findWorktree(manifest, 'live-agent');
    // What the sidebar counts (status flow v2): the To review diff (commits after the
    // bookmark plus uncommitted files), not only the working tree.
    const { files } = await daemon.client.listFiles(agent.worktree.id, {
      scope: { kind: 'review' },
    });
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      await daemon.client.setReview({
        projectId: agent.project.id,
        scopeKind: 'review',
        path: file.path,
        ...(file.rawPath ? { rawPath: file.rawPath } : {}),
        patchHash: file.patchHash,
        reviewed: true,
      });
    }
    await app.open(daemon.authUrl);
    await app.setFilterOption(TEST_IDS.onlyUnreviewedToggle, true);
    await expect(app.worktreeItem(agent.worktree.id)).toBeHidden();
    await expect(app.worktreeItem(findWorktree(manifest, 'live').worktree.id)).toBeVisible();

    await edits.write(
      join(agent.worktree.path, 'src/fresh-agent-work.ts'),
      'export const fresh = true;\n',
    );
    await expect(app.worktreeItem(agent.worktree.id)).toBeVisible({
      timeout: liveBudgetMs() + 1000,
    });
    await app.setFilterOption(TEST_IDS.onlyUnreviewedToggle, false);
  });

  // Status flow v2 (DECISIONS #95): marks are keyed by (path, patchHash), not by scope kind. A
  // file with staged and unstaged changes has a different patch in each scope, so a mark made in
  // `staged` still does not cover the `working` patch.
  test('a review mark belongs to its patch, not to a scope kind', async ({ manifest, daemon }) => {
    const sink = findWorktree(manifest, 'kitchen-sink');
    const staged = (await daemon.client.listFiles(sink.worktree.id, { scope: { kind: 'staged' } }))
      .files;
    const both = staged.find((f) => f.path === 'src/both.ts');
    if (!both) throw new Error('src/both.ts not staged');
    await daemon.client.setReview({
      projectId: sink.project.id,
      scopeKind: 'staged',
      path: both.path,
      patchHash: both.patchHash,
      reviewed: true,
    });
    const after = (await daemon.client.listFiles(sink.worktree.id, { scope: { kind: 'staged' } }))
      .files;
    expect(after.find((f) => f.path === 'src/both.ts')?.reviewed).toBe(true);
    const working = (await daemon.client.listFiles(sink.worktree.id)).files;
    expect(working.find((f) => f.path === 'src/both.ts')?.reviewed).toBe(false);
    await daemon.client.setReview({
      projectId: sink.project.id,
      scopeKind: 'staged',
      path: both.path,
      patchHash: both.patchHash,
      reviewed: false,
    });
    const cleared = (await daemon.client.listFiles(sink.worktree.id, { scope: { kind: 'staged' } }))
      .files;
    expect(cleared.find((f) => f.path === 'src/both.ts')?.reviewed).toBe(false);
  });
});
