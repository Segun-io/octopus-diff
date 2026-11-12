/**
 * First run and "add repositories" feedback. Regression for the user report: on the first-run
 * screen there was no visible way to continue after picking a folder, and the app did not move
 * on until a manual reload. Now the main button reads "Continue" (disabled until the text points
 * at something valid), the app replaces the first-run screen as soon as repositories exist (even
 * with the event stream down: the scan is polled), and a status panel / toast says what happened.
 */
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { TEST_IDS } from '@octopus-diff/contracts';
import { findProject } from '@octopus-diff/fixtures';
import type { Locator } from '@playwright/test';
import { TestDaemon } from '../support/daemon.js';
import { createRepo } from '../support/repos.js';
import { expect, test } from '../support/test.js';

const IDS = {
  main: '[data-main="true"]',
  panel: 'add-job-status',
  toast: 'add-job-toast',
  action: 'add-job-action',
} as const;

function action(scope: Locator, id: string): Locator {
  return scope.locator(`[data-testid="${IDS.action}"][data-action="${id}"]`);
}

test.describe('first run', () => {
  test('pick a folder, Continue, and the app appears without a reload', async ({
    manifest,
    app,
  }) => {
    const daemon = await TestDaemon.start({ manifest, register: 'none' });
    try {
      await app.open(daemon.authUrl);
      await expect(app.byTestId(TEST_IDS.emptyState)).toBeVisible();
      const input = app.byTestId(TEST_IDS.folderPickerInput);
      await expect(input).toBeFocused();
      const main = app.byTestId(TEST_IDS.folderPicker).locator(IDS.main);
      await expect(main).toContainText('Continue');

      // Nothing valid selected: Continue is disabled.
      await input.fill(join(manifest.root, 'no-such-folder-here', 'x'));
      await expect(main).toBeDisabled();

      const [scan] = manifest.scanRoots;
      if (!scan) throw new Error('manifest has no scan root');
      await input.fill(scan.path);
      await expect(main).toBeEnabled();
      await expect(main).toHaveAttribute('data-action', 'watch');
      await expect(app.byTestId('add-selection')).toContainText(scan.path);

      const reloaded = await app.armReloadDetector();
      await main.click();
      // The app replaces the first-run screen by itself.
      for (const name of scan.expectedProjects) {
        await app.expectProjectListed(name);
      }
      await expect(app.byTestId(TEST_IDS.emptyState)).toHaveCount(0);
      expect((await reloaded()).reloaded).toBe(false);

      // The outcome: how many repositories, which ones, and where to go next.
      const toast = app.byTestId(IDS.toast);
      await expect(toast).toHaveAttribute('data-tone', 'success', { timeout: 20_000 });
      await expect(toast).toContainText(
        `${scan.expectedProjects.length} ${scan.expectedProjects.length === 1 ? 'repository' : 'repositories'} found`,
      );
      for (const name of scan.expectedProjects) await expect(toast).toContainText(name);
      await action(toast, 'open').click();
      await expect(toast).toHaveCount(0);
      // "Show folder" leaves the Inbox for the folder's overview (no context bar there).
      await expect(app.contextBar).toHaveCount(0);
    } finally {
      await daemon.close();
    }
  });

  test('a folder with no repositories says so and offers the next step', async ({
    manifest,
    gitEnv,
    app,
  }) => {
    const daemon = await TestDaemon.start({ manifest, register: 'none' });
    const empty = join(manifest.root, `onboarding-empty-${Date.now()}`);
    await mkdir(join(empty, 'just-a-folder'), { recursive: true });
    try {
      await app.open(daemon.authUrl);
      const input = app.byTestId(TEST_IDS.folderPickerInput);
      const main = app.byTestId(TEST_IDS.folderPicker).locator(IDS.main);
      await input.fill(empty);
      await expect(main).toHaveAttribute('data-action', 'watch');
      await main.click();

      const panel = app.byTestId(IDS.panel);
      await expect(panel).toHaveAttribute('data-tone', 'empty', { timeout: 20_000 });
      await expect(panel).toContainText('No repositories found');
      await expect(app.byTestId(TEST_IDS.emptyState)).toBeVisible();

      // Stop watching it, then pick a single repository instead.
      await action(panel, 'stop-watching').click();
      await expect(panel).toHaveCount(0);
      await expect.poll(async () => (await daemon.client.listScanRoots()).scanRoots.length).toBe(0);

      const repo = await createRepo(empty, 'solo', gitEnv);
      await input.fill(repo.dir);
      await expect(main).toHaveAttribute('data-action', 'add');
      await expect(main).toContainText('Continue');
      await main.click();
      await expect(app.worktreeItem(repo.worktreeId)).toBeVisible({ timeout: 15_000 });
      const toast = app.byTestId(IDS.toast);
      await expect(toast).toHaveAttribute('data-tone', 'success');
      await expect(toast).toContainText('Added solo');
    } finally {
      await daemon.close();
      await rm(empty, { recursive: true, force: true });
    }
  });

  test('the app appears even when the event stream is down (the scan is polled)', async ({
    manifest,
    app,
    page,
  }) => {
    const daemon = await TestDaemon.start({ manifest, register: 'none' });
    try {
      await page.route('**/api/events*', (route) => route.abort());
      await app.open(daemon.authUrl);
      const [scan] = manifest.scanRoots;
      if (!scan) throw new Error('manifest has no scan root');
      await app.byTestId(TEST_IDS.folderPickerInput).fill(scan.path);
      const main = app.byTestId(TEST_IDS.folderPicker).locator(IDS.main);
      await expect(main).toHaveAttribute('data-action', 'watch');
      await main.click();
      for (const name of scan.expectedProjects) {
        await app.expectProjectListed(name);
      }
      await expect(app.byTestId(IDS.toast)).toHaveAttribute('data-tone', 'success', {
        timeout: 20_000,
      });
    } finally {
      await daemon.close();
    }
  });
});

test.describe('add repositories (in the app)', () => {
  test('watching a folder from the Add dialog shows progress and the result', async ({
    manifest,
    gitEnv,
    daemon,
    app,
  }) => {
    const parent = join(manifest.root, `onboarding-add-${Date.now()}`);
    const one = await createRepo(join(parent, 'nested'), 'watch-one', gitEnv);
    const two = await createRepo(parent, 'watch-two', gitEnv);
    try {
      await app.open(daemon.authUrl);
      await app.byTestId(TEST_IDS.addProjectButton).click();
      const form = app.byTestId(TEST_IDS.folderPicker);
      const main = form.locator(IDS.main);
      await expect(main).toContainText('Watch this folder');
      await app.byTestId(TEST_IDS.folderPickerInput).fill(parent);
      await expect(main).toHaveAttribute('data-action', 'watch');
      await main.click();

      const panel = form.getByTestId(IDS.panel);
      await expect(panel).toHaveAttribute('data-tone', 'success', { timeout: 20_000 });
      await expect(panel).toContainText('2 repositories found');
      await expect(panel).toContainText('watch-one');
      await expect(panel).toContainText('watch-two');
      await expect(app.worktreeItem(one.worktreeId)).toBeVisible();
      await expect(app.worktreeItem(two.worktreeId)).toBeVisible();

      // Next step: the folder's overview; the dialog closes.
      await action(panel, 'open').click();
      await expect(form).toHaveCount(0);
      await expect(app.byTestId(IDS.toast)).toHaveCount(0);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('adding a path that is not a repository explains the error', async ({
    manifest,
    daemon,
    app,
  }) => {
    const plain = join(manifest.root, `onboarding-plain-${Date.now()}`);
    await mkdir(plain, { recursive: true });
    try {
      await app.open(daemon.authUrl);
      await app.byTestId(TEST_IDS.addProjectButton).click();
      await app.byTestId(TEST_IDS.folderPickerInput).fill(plain);
      // The folder's main action is Watch; "Add as one repository" is the other one. Wait for
      // the listing: until it arrives the path's kind is unknown and Add is the main action.
      await expect(app.byTestId(TEST_IDS.folderPicker).locator(IDS.main)).toHaveAttribute(
        'data-action',
        'watch',
      );
      await app.byTestId(TEST_IDS.addProjectSubmit).click();
      const panel = app.byTestId(IDS.panel);
      await expect(panel).toHaveAttribute('data-tone', 'error');
      await expect(panel).toContainText('Could not add');
      // Typing a new path clears the old result.
      await app
        .byTestId(TEST_IDS.folderPickerInput)
        .fill(findProject(manifest, 'alpha').mainWorktreePath ?? '');
      await expect(panel).toHaveCount(0);
    } finally {
      await rm(plain, { recursive: true, force: true });
    }
  });
});
