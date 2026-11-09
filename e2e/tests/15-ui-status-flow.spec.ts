/**
 * Status flow v2 (docs/STATUS-FLOW.md §5, PLAN §8 items 12–18) in the browser against the real
 * daemon: the toolbar scope never moves a sidebar row; "Hide until it changes" returns the row on
 * the next edit; no activity pulse and no "verify" wording anywhere.
 */
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TEST_IDS } from '@octopus-diff/contracts';
import type { Locator } from '@playwright/test';
import { createRepo } from '../support/repos.js';
import { expect, test } from '../support/test.js';

/** Where every worktree row sits: id, section (folder / pinned / settled), state and stage. */
async function rowPlaces(items: Locator): Promise<string[]> {
  const places = await items.evaluateAll((els) =>
    els.map((el) => {
      const e = el as HTMLElement;
      const section = e.closest('li[data-section]')?.getAttribute('data-section') ?? '';
      return `${e.dataset.worktreeId}:${section}:${e.dataset.state}:${e.dataset.stage}`;
    }),
  );
  return places.sort();
}

test.describe('status flow v2 (UI)', () => {
  test('switching the toolbar scope never moves a sidebar row (acceptance 1)', async ({
    daemon,
    app,
  }) => {
    await app.open(daemon.authUrl);
    const before = await rowPlaces(app.allWorktreeItems());
    expect(before.length).toBeGreaterThan(3);
    for (const kind of ['branch', 'staged', 'unstaged', 'working'] as const) {
      await app.setScope(kind);
      // Give the inbox for the new scope time to land; nothing may move meanwhile either.
      await app.page.waitForTimeout(400);
      await app.waitReady();
      expect(await rowPlaces(app.allWorktreeItems()), `after scope ${kind}`).toEqual(before);
    }
  });

  test('"Hide until it changes" returns the row on the next edit (acceptance 5)', async ({
    manifest,
    gitEnv,
    daemon,
    app,
  }) => {
    const parent = join(manifest.root, `status-flow-hide-${Date.now()}`);
    const repo = await createRepo(parent, 'hide-me', gitEnv);
    await daemon.client.addProject({ path: repo.dir });
    await app.open(daemon.authUrl);
    const row = app.worktreeItem(repo.worktreeId);
    await expect(row).toHaveAttribute('data-state', 'attention', { timeout: 15_000 });

    await row.hover();
    await row
      .locator('xpath=ancestor::li[1]')
      .getByRole('button', { name: 'Hide until it changes' })
      .click();
    await expect(row).toHaveAttribute('data-state', 'settled');
    await expect(row.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-section', 'settled');

    await appendFile(join(repo.dir, 'work.txt'), 'the agent wrote more\n');
    await expect(row).toHaveAttribute('data-state', 'attention', { timeout: 15_000 });
    await expect(row.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-section', 'folder');
  });

  test('no activity pulse and no "verify" wording (acceptance 6)', async ({
    manifest,
    gitEnv,
    daemon,
    app,
  }) => {
    const parent = join(manifest.root, `status-flow-words-${Date.now()}`);
    const repo = await createRepo(parent, 'words', gitEnv);
    await daemon.client.addProject({ path: repo.dir });
    await app.open(daemon.authUrl);
    const row = app.worktreeItem(repo.worktreeId);
    await expect(row).toBeVisible({ timeout: 15_000 });
    // Fresh activity used to light the pulse for ~10 s.
    await appendFile(join(repo.dir, 'work.txt'), 'activity\n');
    await app.selectWorktree(repo.worktreeId);
    await expect(app.page.locator('.od-pulse')).toHaveCount(0);

    const texts: string[] = [(await app.page.locator('body').textContent()) ?? ''];
    texts.push(
      ...(await app.page
        .locator('[title], [aria-label]')
        .evaluateAll((els) =>
          els.flatMap((el) => [
            el.getAttribute('title') ?? '',
            el.getAttribute('aria-label') ?? '',
          ]),
        )),
    );
    await row.click({ button: 'right' });
    const menu = app.page.getByRole('menu');
    await expect(menu).toBeVisible();
    texts.push((await menu.textContent()) ?? '');
    await app.press('Escape');
    await app.byTestId(TEST_IDS.scopeSelect).focus();
    texts.push((await app.byTestId(TEST_IDS.scopeSelect).textContent()) ?? '');
    for (const text of texts) expect(text).not.toMatch(/verif/i);
  });
});
