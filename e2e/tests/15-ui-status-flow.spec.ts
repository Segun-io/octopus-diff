/**
 * Status flow v2 (docs/STATUS-FLOW.md §5, PLAN §8 items 12–18) in the browser against the real
 * daemon: the toolbar scope never moves a sidebar row; "Hide until it changes" returns the row on
 * the next edit; no activity pulse and no "verify" wording anywhere.
 */
import { appendFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TEST_IDS } from '@octopus-diff/contracts';
import { fixtureId, type IsolatedGitEnv, runGit } from '@octopus-diff/fixtures';
import type { Locator } from '@playwright/test';
import type { AppPage } from '../support/app.js';
import { addWorktree, createRepo } from '../support/repos.js';
import { expect, test } from '../support/test.js';

/** Where every worktree row sits: id, section (flat / hidden), state and stage. */
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

const TO_REVIEW = { settledOpen: true, defaultScope: 'review' };

async function git(cwd: string, env: IsolatedGitEnv, ...args: string[]): Promise<void> {
  await runGit(args, { cwd, env });
}

async function commitAll(cwd: string, env: IsolatedGitEnv, message: string): Promise<void> {
  await git(cwd, env, 'add', '-A');
  await git(cwd, env, 'commit', '-q', '-m', message);
}

/** "Review all" (the toolbar button) in To review for one worktree, which moves its bookmark. */
async function reviewAll(app: AppPage, worktreeId: string): Promise<void> {
  await app.selectWorktree(worktreeId);
  // The worktree may already have been open (the app lands on the top row, #83) with a file list
  // from before the commit. The row moves on at once (the event carries it), the list a moment
  // later; in between the button is pending (`data-pending`) and "Review all" would send the old
  // list's hash, which the daemon correctly skips ("changed meanwhile"). Wait for that condition.
  const button = app.byTestId(TEST_IDS.markAllButton);
  await expect(button).not.toHaveAttribute('data-pending', 'true');
  await expect(button).not.toHaveAttribute('data-count', '0');
  await button.click();
  await expect(app.byTestId(TEST_IDS.bulkReviewToast)).toBeVisible();
  await expect(app.worktreeItem(worktreeId)).toHaveAttribute('data-stage', 'reviewed', {
    timeout: 15_000,
  });
}

test.describe('status flow v2 (UI)', () => {
  test('switching the toolbar scope never moves a sidebar row (acceptance 1)', async ({
    daemon,
    app,
  }) => {
    // Since #10 review states are computed on demand (a project is opened), not at startup. The To
    // review inbox computes every one of them, so no row changes stage while the test watches.
    await daemon.client.inbox({ scope: { kind: 'review' } });
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
    // #13: a row hidden by hand sits in the Hidden section (open here: `settledOpen`).
    await expect(row.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-section', 'hidden');

    await appendFile(join(repo.dir, 'work.txt'), 'the agent wrote more\n');
    await expect(row).toHaveAttribute('data-state', 'attention', { timeout: 15_000 });
    await expect(row.locator('xpath=ancestor::li[1]')).toHaveAttribute('data-section', 'flat');
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

  test('a commit keeps the work out of the shelf; merges into main show only unreviewed content (acceptance 2, 3)', async ({
    manifest,
    gitEnv,
    daemon,
    app,
  }) => {
    test.setTimeout(120_000);
    const parent = join(manifest.root, `status-flow-merge-${Date.now()}`);
    const repo = await createRepo(parent, 'merge-app', gitEnv);
    await rm(join(repo.dir, 'work.txt'));
    const featureDir = join(parent, 'merge-app-feature');
    const featureId = await addWorktree(repo, featureDir, 'feature', gitEnv);
    await daemon.client.addProject({ path: repo.dir });
    await app.open(daemon.authUrl, { prefs: TO_REVIEW });
    const feature = app.worktreeItem(featureId);
    const main = app.worktreeItem(repo.worktreeId);
    await expect(feature).toHaveAttribute('data-stage', 'review', { timeout: 15_000 });
    await expect(main).toHaveAttribute('data-stage', 'reviewed');

    // Acceptance 2: the agent commits. The working tree is clean, the row still has work.
    await commitAll(featureDir, gitEnv, 'agent: work');
    await expect(feature).toHaveAttribute('data-commits', '1', { timeout: 15_000 });
    await expect(feature).toHaveAttribute('data-dirty', 'false');
    await expect(feature).toHaveAttribute('data-state', 'attention');
    await expect(feature).toContainText('1 commit');
    await app.selectWorktree(featureId);
    await expect.poll(() => app.filePaths()).toEqual(['work.txt']);
    await reviewAll(app, featureId);
    await expect(feature).toHaveAttribute('data-commits', '0');

    // Acceptance 3, fast-forward: main gets the reviewed commit and has nothing to review.
    await git(repo.dir, gitEnv, 'merge', '-q', '--ff-only', 'feature');
    await expect
      .poll(async () => {
        const items = (await daemon.client.listProjects()).projects.flatMap((p) => p.worktrees);
        return items.find((w) => w.worktree.id === repo.worktreeId)?.summary?.headSha;
      })
      .toBe(
        (await daemon.client.listProjects()).projects
          .flatMap((p) => p.worktrees)
          .find((w) => w.worktree.id === featureId)?.summary?.headSha,
      );
    await expect(main).toHaveAttribute('data-unreviewed', '0', { timeout: 15_000 });
    await expect(main).toHaveAttribute('data-stage', 'reviewed');

    // Acceptance 3, squash: a two-commit branch reviewed, then squash-merged into main.
    const squashDir = join(parent, 'merge-app-squash');
    await git(repo.dir, gitEnv, 'worktree', 'add', '-q', '-b', 'squashme', squashDir);
    await writeFile(join(squashDir, 'one.txt'), 'first file\n');
    await commitAll(squashDir, gitEnv, 'one');
    await writeFile(join(squashDir, 'two.txt'), 'second file\n');
    await commitAll(squashDir, gitEnv, 'two');
    const squashId = fixtureId(squashDir);
    await expect(app.worktreeItem(squashId)).toHaveAttribute('data-commits', '2', {
      timeout: 15_000,
    });
    await reviewAll(app, squashId);
    await git(repo.dir, gitEnv, 'merge', '-q', '--squash', 'squashme');
    await git(repo.dir, gitEnv, 'commit', '-q', '-m', 'squash: one and two');
    await expect
      .poll(
        async () =>
          (await daemon.client.listFiles(repo.worktreeId, { scope: { kind: 'review' } })).files
            .map((f) => `${f.path}:${f.reviewed}`)
            .sort(),
        { timeout: 15_000 },
      )
      .toEqual(['one.txt:true', 'two.txt:true', 'work.txt:true']);
    await expect(main).toHaveAttribute('data-unreviewed', '0', { timeout: 15_000 });
    await expect(main).toHaveAttribute('data-stage', 'reviewed');
    await app.selectWorktree(repo.worktreeId);
    // To review never lists reviewed files (no eye there): nothing is left.
    await expect.poll(() => app.filePaths()).toEqual([]);
  });
});
