/**
 * UX-2 / UX-3 in the browser: review policy through the chip and menus, precedence visible in
 * `data-source`, disabled worktrees out of the loop (badge, no toggle, `n`, counts,
 * onlyUnreviewed) also after a live update, "on by default for new things" end to end with
 * repositories created during the test, persistence across a daemon restart, and live
 * propagation to a second tab.
 */
import { join } from 'node:path';
import { TEST_IDS } from '@octopus-diff/contracts';
import { findProject, findWorktree, LIVE_FILES } from '@octopus-diff/fixtures';
import { stateHashes, waitForStateHashChange } from '../support/api.js';
import { addWorktree, createRepo } from '../support/repos.js';
import { sleep } from '../support/test.js';
import { expect, test, UiPage, unreviewedTotal } from '../support/ui.js';

test.describe('UX-2/3 review policy (UI)', () => {
  test('disable a worktree from the chip: badge, no toggle, counts, onlyUnreviewed, n; survives a live update', async ({
    manifest,
    daemon,
    ui,
    edits,
    page,
  }) => {
    const live = findWorktree(manifest, 'live');
    const alpha = findWorktree(manifest, 'alpha');
    // Everything reviewed except one file in live and one in alpha, so `n` has two candidates.
    const keep = new Set([
      `${live.worktree.id}:${LIVE_FILES.edit}`,
      `${alpha.worktree.id}:README.md`,
    ]);
    // Status flow v2: the counts are To review's (commits after the bookmark + uncommitted).
    const review = { kind: 'review' } as const;
    for (const entry of (await daemon.client.inbox({ scope: review })).entries) {
      for (const file of entry.files) {
        if (keep.has(`${entry.worktree.id}:${file.path}`)) continue;
        await daemon.client.setReview({
          projectId: entry.project.id,
          scopeKind: 'review',
          path: file.path,
          ...(file.rawPath ? { rawPath: file.rawPath } : {}),
          patchHash: file.patchHash,
          reviewed: true,
        });
      }
    }
    expect(await unreviewedTotal(daemon.client, review)).toBe(2);

    // `n` walks the toolbar scope: To review, where the marks above were made.
    await ui.open(daemon.authUrl, { prefs: { settledOpen: true, defaultScope: 'review' } });
    await ui.selectWorktree(live.worktree.id);
    await ui.expectChip(true, 'default');
    await expect(page).toHaveTitle('(2) octopus-diff');
    await expect(ui.unreviewedBadge(live.worktree.id)).toHaveText('1');
    await ui.openFile(LIVE_FILES.edit);
    await expect(ui.byTestId(TEST_IDS.reviewToggle)).toBeVisible();

    await ui.setPolicyViaChip('worktree', 'off');
    await ui.expectChip(false, 'worktree');
    await expect(ui.reviewOffBadge(live.worktree.id)).toHaveAttribute('data-source', 'worktree');
    await expect(ui.byTestId(TEST_IDS.reviewToggle)).toHaveCount(0);
    await expect(ui.unreviewedBadge(live.worktree.id)).toHaveCount(0);
    await expect(page).toHaveTitle('(1) octopus-diff');
    const settings = await daemon.client.getSettings();
    expect(settings.overrides).toEqual([
      expect.objectContaining({
        target: { kind: 'worktree', worktreeId: live.worktree.id },
        enabled: false,
      }),
    ]);
    const unreviewed = await daemon.client.inbox({ onlyUnreviewed: true, scope: review });
    expect(unreviewed.entries.map((e) => e.worktree.id)).toEqual([alpha.worktree.id]);

    // `n` never lands in the disabled worktree: from a reviewed file in beta it goes to alpha
    // and then has nowhere else to go.
    const beta = findWorktree(manifest, 'beta').worktree;
    await ui.selectWorktree(beta.id);
    await ui.setToggle(TEST_IDS.showReviewedToggle, true);
    await ui.openFile((await ui.fileItems())[0]?.path ?? '');
    await ui.focusApp();
    for (let i = 0; i < 3; i++) {
      await ui.press('n');
      await expect(ui.diffViewer).toHaveAttribute('data-worktree-id', alpha.worktree.id);
      await expect(ui.diffViewer).toHaveAttribute('data-path', 'README.md');
    }

    // A live update in the disabled worktree must not switch review back on (merge bug 12f039c).
    const before = (await stateHashes(daemon.client))[live.worktree.id] ?? '';
    await edits.append(
      join(live.worktree.path, LIVE_FILES.other),
      '// octopus-marker-policy-live\n',
    );
    await waitForStateHashChange(daemon.client, live.worktree.id, before);
    await expect
      .poll(
        async () =>
          (await daemon.client.inbox()).entries.find((e) => e.worktree.id === live.worktree.id)
            ?.summary.stateHash,
      )
      .not.toBe(before);
    await sleep(1200); // let the UI apply the worktree.changed refetches
    await expect(ui.reviewOffBadge(live.worktree.id)).toHaveAttribute('data-source', 'worktree');
    await expect(ui.unreviewedBadge(live.worktree.id)).toHaveCount(0);
    await expect(page).toHaveTitle('(1) octopus-diff');
    await ui.selectWorktree(live.worktree.id);
    await ui.expectChip(false, 'worktree');

    // Inherit again: back to the default.
    await ui.setPolicyViaChip('worktree', 'inherit');
    await ui.expectChip(true, 'default');
    await expect(ui.reviewOffBadge(live.worktree.id)).toHaveCount(0);
    expect((await daemon.client.getSettings()).overrides).toEqual([]);
  });

  test('precedence worktree > branch > project > folder > default is visible in data-source', async ({
    manifest,
    daemon,
    ui,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    const agent = findWorktree(manifest, 'live-agent').worktree;
    const beta = findWorktree(manifest, 'beta').worktree;
    const betaDetached = findWorktree(manifest, 'beta-detached').worktree;
    const alpha = findWorktree(manifest, 'alpha').worktree;
    expect(agent.branch).toBe('agent/live');
    await ui.open(daemon.authUrl);

    await ui.selectWorktree(agent.id);
    await ui.expectChip(true, 'default');
    await ui.setPolicyViaChip('project', 'off');
    await ui.expectChip(false, 'project');
    await ui.selectWorktree(live.id);
    await ui.expectChip(false, 'project');
    await expect(ui.reviewOffBadge(live.id)).toHaveAttribute('data-source', 'project');

    await ui.selectWorktree(agent.id);
    await ui.setPolicyViaChip('branch', 'on');
    await ui.expectChip(true, 'branch');
    await expect(ui.reviewOffBadge(agent.id)).toHaveCount(0);
    await ui.selectWorktree(live.id);
    await ui.expectChip(false, 'project');

    await ui.selectWorktree(agent.id);
    await ui.setPolicyViaChip('worktree', 'off');
    await ui.expectChip(false, 'worktree');
    await ui.setPolicyViaChip('worktree', 'inherit');
    await ui.expectChip(true, 'branch');

    // Folder level through a scan-root project; the detached worktree has no branch level.
    await ui.selectWorktree(beta.id);
    await ui.setPolicyViaChip('folder', 'off');
    await ui.expectChip(false, 'folder');
    await ui.selectWorktree(betaDetached.id);
    await ui.expectChip(false, 'folder');
    await ui.chip.click();
    await expect(ui.policyItem('branch', 'off')).toBeDisabled();
    await ui.press('Escape');
    await ui.selectWorktree(beta.id);
    await ui.setPolicyViaChip('project', 'on');
    await ui.expectChip(true, 'project');
    await ui.selectWorktree(betaDetached.id);
    await ui.expectChip(true, 'project');

    // The default: everything without an override.
    await ui.selectWorktree(alpha.id);
    await ui.expectChip(true, 'default');
    await ui.openSettings('review');
    await ui.setReviewDefault(false);
    await ui.closeSettings();
    await ui.expectChip(false, 'default');
    await expect(ui.reviewOffBadge(alpha.id)).toHaveAttribute('data-source', 'default');
    await ui.selectWorktree(agent.id);
    await ui.expectChip(true, 'branch');

    const settings = await daemon.client.getSettings();
    expect(settings.settings.review.defaultEnabled).toBe(false);
    expect(settings.overrides.map((o) => [o.target.kind, o.enabled]).sort()).toEqual(
      [
        ['branch', true],
        ['folder', false],
        ['project', false],
        ['project', true],
      ].sort(),
    );
  });

  test('review is ON by default for repositories and worktrees added later; the default is a setting', async ({
    manifest,
    gitEnv,
    daemon,
    ui,
  }) => {
    const parent = join(manifest.root, `ux-e2e-new-${Date.now()}`);
    const alpha = findWorktree(manifest, 'alpha').worktree;
    await ui.open(daemon.authUrl);

    // A repository added through the sidebar form while the default is on.
    const first = await createRepo(parent, 'fresh-a', gitEnv);
    await ui.byTestId(TEST_IDS.addProjectButton).click();
    await ui.byTestId(TEST_IDS.folderPickerInput).fill(first.dir);
    await ui.byTestId(TEST_IDS.addProjectSubmit).click();
    await expect(ui.worktreeItem(first.worktreeId)).toBeVisible({ timeout: 15_000 });
    // The form stays open ("Added fresh-a.") so more can be added; dismiss it.
    await ui.press('Escape');
    await expect(ui.byTestId(TEST_IDS.folderPickerInput)).toBeHidden();
    await ui.selectWorktree(first.worktreeId);
    await ui.expectChip(true, 'default');
    await expect(ui.reviewOffBadge(first.worktreeId)).toHaveCount(0);
    // Pin this one explicitly so it keeps review when the default flips.
    await ui.setPolicyViaChip('worktree', 'on');
    await ui.expectChip(true, 'worktree');

    // Flip the default off in Settings.
    await ui.openSettings('review');
    await ui.setReviewDefault(false);
    await ui.closeSettings();
    expect((await daemon.client.getSettings()).settings.review.defaultEnabled).toBe(false);
    await expect(ui.reviewOffBadge(alpha.id)).toHaveAttribute('data-source', 'default');
    await expect(ui.reviewOffBadge(first.worktreeId)).toHaveCount(0);

    // A new repository with a new worktree, discovered afterwards: review off, from the default.
    const second = await createRepo(parent, 'fresh-b', gitEnv);
    const linkedId = await addWorktree(second, join(parent, 'fresh-b-task'), 'agent/task', gitEnv);
    await daemon.client.addProject({ path: second.dir });
    await expect(ui.worktreeItem(linkedId)).toBeVisible({ timeout: 15_000 });
    await expect(ui.reviewOffBadge(second.worktreeId)).toHaveAttribute('data-source', 'default');
    await expect(ui.reviewOffBadge(linkedId)).toHaveAttribute('data-source', 'default');
    await ui.selectWorktree(linkedId);
    await ui.expectChip(false, 'default');
    const items = (await daemon.client.listProjects()).projects.flatMap((p) => p.worktrees);
    expect(items.find((w) => w.worktree.id === linkedId)?.review).toEqual({
      enabled: false,
      source: 'default',
    });
    expect(items.find((w) => w.worktree.id === first.worktreeId)?.review).toEqual({
      enabled: true,
      source: 'worktree',
    });
    const unreviewed = await daemon.client.inbox({ onlyUnreviewed: true });
    expect(unreviewed.entries.map((e) => e.worktree.id)).toEqual([first.worktreeId]);

    // Default back on: the new worktrees follow immediately.
    await ui.openSettings('review');
    await ui.setReviewDefault(true);
    await ui.closeSettings();
    await ui.expectChip(true, 'default');
    await expect(ui.reviewOffBadge(linkedId)).toHaveCount(0);
  });

  test('overrides, default and revision persist across a daemon restart; a second tab follows live', async ({
    manifest,
    daemon,
    ui,
    guard,
    context,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    const alpha = findWorktree(manifest, 'alpha').worktree;
    await ui.open(daemon.authUrl);
    await ui.selectWorktree(live.id);
    await ui.setPolicyViaChip('worktree', 'off');
    await ui.openSettings('review');
    await ui.setReviewDefault(false);
    await ui.closeSettings();
    const before = await daemon.client.getSettings();
    expect(before.revision).toBe(2);

    // The SSE stream and in-flight requests fail while the daemon is down: expected noise.
    guard.allow(/Failed to load resource/, /net::ERR_/, /event stream|EventSource|fetch/i);
    await daemon.restart();
    await daemon.waitForProjects();
    expect(await daemon.client.getSettings()).toEqual(before);

    await ui.open(daemon.authUrl);
    await ui.selectWorktree(live.id);
    await ui.expectChip(false, 'worktree');
    await ui.selectWorktree(alpha.id);
    await ui.expectChip(false, 'default');
    await ui.openSettings('review');
    await expect(ui.reviewDefaultSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(ui.settings.locator('tbody tr')).toHaveCount(1);
    await expect(ui.settings.locator('tbody tr')).toContainText('off');
    await ui.closeSettings();

    // Second tab: receives settings.changed and re-resolves policies.
    const page2 = await context.newPage();
    guard.watch(page2);
    const ui2 = new UiPage(page2);
    await ui2.open(daemon.authUrl);
    await ui2.selectWorktree(live.id);
    await ui2.expectChip(false, 'worktree');

    await ui.selectWorktree(live.id);
    await ui.setPolicyViaChip('worktree', 'inherit');
    await ui.expectChip(false, 'default');
    await ui2.expectChip(false, 'default');
    await ui.openSettings('review');
    await ui.setReviewDefault(true);
    await ui.closeSettings();
    await ui2.expectChip(true, 'default');
    await expect(ui2.reviewOffBadge(live.id)).toHaveCount(0);
    expect((await daemon.client.getSettings()).revision).toBe(4);
    await page2.close();
  });
});

export { findProject };
