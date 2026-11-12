/**
 * PLAN §8 item 2: add fixture projects (one with two linked worktrees) by path and by scan root;
 * all appear with correct branch, ahead/behind and counts.
 */
import { TEST_IDS } from '@octopus-diff/contracts';
import { findProject, findWorktree, registeredProjects } from '@octopus-diff/fixtures';
import { TestDaemon } from '../support/daemon.js';
import { expect, registeredCheckouts, test } from '../support/test.js';

test.describe('§8.2 projects and worktrees', () => {
  test('add by path and by scan root through the UI (empty daemon)', async ({ manifest, app }) => {
    const daemon = await TestDaemon.start({ manifest, register: 'none' });
    try {
      await app.open(daemon.authUrl);
      await expect(app.byTestId(TEST_IDS.emptyState)).toBeVisible();

      const pathInput = app.byTestId(TEST_IDS.folderPickerInput);
      if (!(await pathInput.isVisible())) await app.byTestId(TEST_IDS.addProjectButton).click();

      // By path: alpha (main checkout + two linked worktrees).
      const alpha = findProject(manifest, 'alpha');
      await pathInput.fill(alpha.mainWorktreePath ?? '');
      await app.byTestId(TEST_IDS.addProjectSubmit).click();
      await app.expectProjectListed('alpha', undefined, 15_000);
      for (const worktree of alpha.worktrees) await app.expectWorktreeItem(worktree);

      // The folder picker lists the real filesystem: alpha's folder is a repository, now added.
      const alphaDir = alpha.mainWorktreePath ?? '';
      const parentDir = alphaDir.slice(0, alphaDir.lastIndexOf('/') + 1);
      if (!(await pathInput.isVisible())) await app.byTestId(TEST_IDS.addProjectButton).click();
      await pathInput.fill(parentDir);
      const alphaRow = app.page.locator(
        `[data-testid="${TEST_IDS.folderPickerEntry}"][data-path$="/alpha"]`,
      );
      await expect(alphaRow).toHaveAttribute('data-kind', 'repo');
      await expect(alphaRow).toHaveAttribute('data-registered', 'true');

      // A linked worktree path resolves to the same project (idempotent).
      const login = findWorktree(manifest, 'alpha-login').worktree;
      const again = await daemon.client.addProject({ path: login.path });
      expect(again.created).toBe(false);
      expect(again.project.project.id).toBe(alpha.id);

      // By scan root: beta (depth 1, detached linked worktree), gamma (depth 3), epsilon (clean).
      const [scan] = manifest.scanRoots;
      if (!scan) throw new Error('manifest has no scan root');
      const scanInput = app.byTestId(TEST_IDS.folderPickerInput);
      if (!(await scanInput.isVisible())) await app.byTestId(TEST_IDS.addProjectButton).click();
      await scanInput.fill(scan.path);
      // Wait for the picker to list the typed folder: until then it cannot tell a folder from a
      // repository, offers "Add" first, and the two buttons swap actions (and test ids) when the
      // listing arrives, so a click could land on "Add as one repository" (CI, run 42572487669).
      const watchButton = app.page.locator(
        `[data-testid="${TEST_IDS.addScanRootSubmit}"][data-action="watch"]`,
      );
      await expect(watchButton).toBeEnabled();
      await watchButton.click();
      for (const name of scan.expectedProjects) {
        await app.expectProjectListed(name);
        for (const worktree of findProject(manifest, name).worktrees) {
          await app.expectWorktreeItem(worktree);
        }
      }

      // Nothing from node_modules, below the scan depth, or via symlink loops.
      const listed = await daemon.waitForProjects(['alpha', ...scan.expectedProjects]);
      expect(listed.map((p) => p.project.name).sort()).toEqual(
        ['alpha', ...scan.expectedProjects].sort(),
      );
      const listedPaths = listed.flatMap((p) => p.worktrees.map((w) => w.worktree.path));
      for (const excluded of scan.excludedRepoPaths) expect(listedPaths).not.toContain(excluded);
      const roots = await daemon.client.listScanRoots();
      expect(roots.scanRoots).toHaveLength(1);
      expect(roots.scanRoots[0]?.projectCount).toBe(scan.expectedProjects.length);
      expect(roots.scanRoots[0]?.lastScannedAt).not.toBeNull();
    } finally {
      await daemon.close();
    }
  });

  test('API lists every fixture project, worktree and summary correctly', async ({
    manifest,
    daemon,
  }) => {
    const { projects } = await daemon.client.listProjects();
    const expected = registeredProjects(manifest);
    expect(projects.map((p) => p.project.name).sort()).toEqual(expected.map((p) => p.name).sort());

    for (const fixture of expected) {
      const item = projects.find((p) => p.project.name === fixture.name);
      if (!item) throw new Error(`missing ${fixture.name}`);
      const { project } = item;
      expect(project, fixture.name).toMatchObject({
        id: fixture.id,
        commonDir: fixture.commonDir,
        mainWorktreePath: fixture.mainWorktreePath,
        bare: fixture.bare,
        defaultBranch: fixture.defaultBranch,
      });
      expect(project.scanRootId === null).toBe(fixture.registration?.kind !== 'scan');

      const checkouts = fixture.worktrees.filter((w) => !w.bare);
      const listed = item.worktrees.filter((w) => !w.worktree.bare);
      expect(listed.map((w) => w.worktree.path).sort(), `${fixture.name} worktrees`).toEqual(
        checkouts.map((w) => w.path).sort(),
      );
      for (const wt of checkouts) {
        const entry = listed.find((w) => w.worktree.path === wt.path);
        const label = `${fixture.name}/${wt.name}`;
        expect(entry?.error ?? null, label).toBeNull();
        expect(entry?.worktree, label).toMatchObject({
          id: wt.id,
          projectId: fixture.id,
          branch: wt.branch,
          headSha: wt.headSha,
          detached: wt.detached,
          isMain: wt.isMain,
          bare: false,
          missing: false,
        });
        const summary = entry?.summary;
        expect(summary, label).not.toBeNull();
        expect(summary, label).toMatchObject({
          worktreeId: wt.id,
          projectId: fixture.id,
          branch: wt.branch,
          headSha: wt.headSha,
          detached: wt.detached,
          upstream: wt.upstream,
          counts: wt.counts,
          changedFiles: wt.changedFiles,
          inProgress: wt.inProgress,
        });
        if (wt.ahead !== undefined) expect(summary?.ahead, `${label} ahead`).toBe(wt.ahead);
        if (wt.behind !== undefined) expect(summary?.behind, `${label} behind`).toBe(wt.behind);
        if (wt.aheadBehindRef !== undefined && wt.aheadBehindRef !== null) {
          // Accept `main` or `refs/heads/main`-style spellings of the same ref.
          expect(summary?.aheadBehindRef ?? '', `${label} aheadBehindRef`).toMatch(
            new RegExp(`(^|/)${wt.aheadBehindRef.replace(/[/.]/g, '\\$&')}$`),
          );
        }
      }
    }
  });

  test('sidebar shows every worktree with branch, ahead/behind and counts', async ({
    manifest,
    daemon,
    app,
  }) => {
    await app.open(daemon.authUrl);
    for (const project of registeredProjects(manifest)) {
      await app.expectProjectListed(project.name, project.id);
    }
    for (const { worktree } of registeredCheckouts(manifest))
      await app.expectWorktreeItem(worktree);
  });

  test('sidebar filters: project dropdown and only-dirty', async ({ manifest, daemon, app }) => {
    await app.open(daemon.authUrl);
    const epsilon = findWorktree(manifest, 'epsilon').worktree;
    const { project: gammaProject, worktree: gamma } = findWorktree(manifest, 'gamma');
    await expect(app.worktreeItem(epsilon.id)).toBeVisible();

    await app.setFilterOption(TEST_IDS.onlyDirtyToggle, true);
    await expect(app.worktreeItem(epsilon.id)).toBeHidden();
    await expect(app.worktreeItem(gamma.id)).toBeVisible();
    await app.setFilterOption(TEST_IDS.onlyDirtyToggle, false);
    await expect(app.worktreeItem(epsilon.id)).toBeVisible();

    await app.filterProject(gammaProject.id, gammaProject.name);
    await expect(app.worktreeItem(gamma.id)).toBeVisible();
    await expect(app.worktreeItem(epsilon.id)).toBeHidden();
    await expect(app.worktreeItem(findWorktree(manifest, 'alpha').worktree.id)).toBeHidden();
    await app.clearFilters();
    await expect(app.worktreeItem(epsilon.id)).toBeVisible();
  });
});
