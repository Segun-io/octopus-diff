/**
 * UX-1 in the browser: "Review all" against the real daemon. Worktree (with filters), every
 * worktree of the list through the palette (the Inbox view that used to do it is gone, #83) with
 * the confirm dialog, undo via the toast and Ctrl/Cmd+Z, Shift+R, project and folder via their
 * Overviews, "mark all unreviewed", and the stale case. Every DOM assertion is paired with the
 * daemon's own `reviewed` flags.
 */
import { join } from 'node:path';
import { TEST_IDS } from '@octopus-diff/contracts';
import { findProject, findWorktree, LIVE_FILES } from '@octopus-diff/fixtures';
import { reviewedPaths, stateHashes, waitForStateHashChange } from '../support/api.js';
import { expect, expectTitle, test, unreviewedTotal } from '../support/ui.js';

test.describe('UX-1 bulk review (UI)', () => {
  test('worktree: marks the visible files only; undo from the toast restores them', async ({
    manifest,
    daemon,
    ui,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    const files = (await daemon.client.listFiles(live.id)).files.map((f) => f.path).sort();
    expect(files.length).toBeGreaterThan(1);
    await ui.open(daemon.authUrl);
    await ui.selectWorktree(live.id);
    await expect(ui.markAll).toHaveAttribute('data-target', 'worktree');
    await expect(ui.markAll).toHaveAttribute('data-count', String(files.length));

    // Review one file by hand and hide reviewed files: the button now counts the rest.
    const [first] = files;
    if (!first) throw new Error('no files');
    await ui.openFile(first);
    await ui.focusApp();
    await ui.press('r');
    await expect.poll(() => reviewedPaths(daemon.client, live.id)).toEqual([first]);
    await ui.setToggle(TEST_IDS.showReviewedToggle, false);
    await expect(ui.markAll).toHaveAttribute('data-count', String(files.length - 1));

    await ui.markAll.click();
    await expect(ui.toast).toBeVisible();
    await expect(ui.toast).toHaveAttribute('data-changed', String(files.length - 1));
    await expect(ui.toast).toHaveAttribute('data-reviewed', 'true');
    await expect(ui.toast).toContainText(new RegExp(`^${files.length - 1} files? marked reviewed`));
    await expect.poll(() => reviewedPaths(daemon.client, live.id)).toEqual(files);
    await expect(ui.fileList.locator(`[data-testid="${TEST_IDS.fileItem}"]`)).toHaveCount(0);

    await ui.undoButton.click();
    await expect(ui.toast).toContainText('Undone');
    await expect(ui.toast).toHaveAttribute('data-changed', String(files.length - 1));
    await expect.poll(() => reviewedPaths(daemon.client, live.id)).toEqual([first]);
    await expect(ui.undoButton).toHaveCount(0);
  });

  test('every worktree of the list with a sidebar filter: only the visible worktrees are marked (paths), Ctrl+Z undoes', async ({
    manifest,
    daemon,
    ui,
    page,
  }) => {
    const liveProject = findProject(manifest, 'live');
    const alpha = findWorktree(manifest, 'alpha').worktree;
    const total = await unreviewedTotal(daemon.client);
    const bulkBodies: { target: { kind: string }; paths?: unknown[] }[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/review/bulk')) {
        bulkBodies.push(request.postDataJSON());
      }
    });
    await ui.open(daemon.authUrl);
    // The palette says what the command would mark: everything the daemon counts, once the
    // review data of every worktree is in.
    await expect.poll(() => ui.everyWorktreeCount()).toBe(total);

    await ui.filterProject(liveProject.id, liveProject.name);
    const liveFiles = (await daemon.client.inbox()).entries
      .filter((e) => e.project.id === liveProject.id)
      .reduce((n, e) => n + e.files.length, 0);
    await expect.poll(() => ui.everyWorktreeCount()).toBe(liveFiles);
    await ui.runEveryWorktree();
    await ui.confirmBulk(); // two worktrees of `live` are visible
    await expect(ui.toast).toHaveAttribute('data-changed', String(liveFiles));
    // One request per visible worktree, each with its paths: never the `all` request.
    expect(bulkBodies.length).toBeGreaterThan(0);
    expect(bulkBodies.every((b) => b.target.kind === 'worktree' && Array.isArray(b.paths))).toBe(
      true,
    );
    await expect
      .poll(async () => {
        const unreviewed = await daemon.client.inbox({ onlyUnreviewed: true });
        return unreviewed.entries.some((e) => e.project.id === liveProject.id);
      })
      .toBe(false);
    expect(await reviewedPaths(daemon.client, alpha.id)).toEqual([]);
    expect(await unreviewedTotal(daemon.client)).toBe(total - liveFiles);

    await ui.clearFilters();
    await ui.focusApp();
    await ui.press('Control+z');
    await expect(ui.toast).toContainText('Undone');
    await expect.poll(() => unreviewedTotal(daemon.client)).toBe(total);
  });

  test('every worktree of the list: one all request, confirm dialog, title count, Ctrl+Z undo', async ({
    daemon,
    ui,
    page,
  }) => {
    // Since #10 review states are computed on demand (a project is opened), not at startup. The To
    // review inbox computes every one of them, so this test starts with them all in place.
    await daemon.client.inbox({ scope: { kind: 'review' } });
    const total = await unreviewedTotal(daemon.client);
    expect(total).toBeGreaterThan(0);
    const bulkBodies: { target: { kind: string } }[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/review/bulk')) {
        bulkBodies.push(request.postDataJSON());
      }
    });
    await ui.open(daemon.authUrl);
    // The title counts To review (status flow v2), not the Uncommitted scope marked here.
    const titled = await expectTitle(page, daemon.client);

    // The review data fills in per project: wait until the command covers everything.
    await expect.poll(() => ui.everyWorktreeCount()).toBe(total);
    await ui.runEveryWorktree();
    await expect(ui.confirmDialog).toBeVisible();
    await expect(ui.confirmDialog).toContainText(`Mark ${total} files reviewed?`);
    await ui.press('Escape');
    await expect(ui.confirmDialog).toBeHidden();
    expect(await unreviewedTotal(daemon.client)).toBe(total);
    expect(bulkBodies).toEqual([]);

    await ui.runEveryWorktree();
    await ui.confirmBulk();
    await expect(ui.toast).toHaveAttribute('data-changed', String(total));
    expect(bulkBodies.map((b) => b.target.kind)).toEqual(['all']);
    await expect.poll(() => unreviewedTotal(daemon.client)).toBe(0);
    expect(await expectTitle(page, daemon.client)).toBeLessThan(titled);

    await ui.press('Control+z');
    await expect(ui.toast).toContainText(`Undone: ${total} marks restored`);
    await expect.poll(() => unreviewedTotal(daemon.client)).toBe(total);
    expect(await expectTitle(page, daemon.client)).toBe(titled);
  });

  test('Shift+R marks the open worktree only', async ({ manifest, daemon, ui }) => {
    const live = findWorktree(manifest, 'live').worktree;
    const files = (await daemon.client.listFiles(live.id)).files.map((f) => f.path).sort();
    const total = await unreviewedTotal(daemon.client);
    expect(total).toBeGreaterThan(files.length);
    await ui.open(daemon.authUrl);
    await ui.selectWorktree(live.id);
    await expect(ui.markAll).toHaveAttribute('data-count', String(files.length));
    await ui.focusApp();
    await ui.press('Shift+R');
    // A single worktree needs no confirmation: the toast comes straight away.
    await expect(ui.toast).toHaveAttribute('data-changed', String(files.length));
    await expect.poll(() => reviewedPaths(daemon.client, live.id)).toEqual(files);
    expect(await unreviewedTotal(daemon.client)).toBe(total - files.length);
  });

  test('project and folder via their Overviews, mark all reviewed / unreviewed', async ({
    manifest,
    daemon,
    ui,
  }) => {
    const liveProject = findProject(manifest, 'live');
    const scan = (await daemon.client.listScanRoots()).scanRoots[0];
    if (!scan) throw new Error('fixture scan root missing');
    const inbox = await daemon.client.inbox();
    const filesOf = (projectId: string) =>
      inbox.entries
        .filter((e) => e.project.id === projectId)
        .reduce((n, e) => n + e.files.length, 0);
    const folderProjects = inbox.entries
      .filter((e) => e.project.scanRootId === scan.id)
      .map((e) => e.project.id);
    expect(folderProjects.length).toBeGreaterThan(0);

    await ui.open(daemon.authUrl);
    // The sidebar has no project header menu any more (#13): the project's Overview has the buttons.
    await ui.openProjectOverview('live');
    await ui.page.getByRole('button', { name: 'Mark all reviewed' }).click();
    await ui.confirmBulk();
    await expect(ui.toast).toHaveAttribute('data-reviewed', 'true');
    await expect
      .poll(async () =>
        (await daemon.client.inbox({ onlyUnreviewed: true })).entries.some(
          (e) => e.project.id === liveProject.id,
        ),
      )
      .toBe(false);
    expect(Number(await ui.toast.getAttribute('data-changed'))).toBeGreaterThan(0);

    // Folder: open its Overview and use the bulk button there.
    await ui.openFolderOverview(scan.id);
    const overviewButton = ui.page.getByRole('button', { name: 'Mark all reviewed' });
    await expect(overviewButton).toBeVisible();
    await overviewButton.click();
    await ui.confirmBulk();
    await expect
      .poll(async () =>
        (await daemon.client.inbox({ onlyUnreviewed: true })).entries.filter((e) =>
          folderProjects.includes(e.project.id),
        ),
      )
      .toEqual([]);
    const alpha = findWorktree(manifest, 'alpha').worktree;
    expect(await reviewedPaths(daemon.client, alpha.id)).toEqual([]); // added directly: untouched

    // Back to unreviewed for the project, from its Overview.
    await ui.openProjectOverview('live');
    await ui.page.getByRole('button', { name: 'Mark all unreviewed' }).click();
    await ui.confirmBulk();
    await expect(ui.toast).toHaveAttribute('data-reviewed', 'false');
    await expect
      .poll(async () =>
        (await daemon.client.inbox({ onlyUnreviewed: true })).entries
          .filter((e) => e.project.id === liveProject.id)
          .reduce((n, e) => n + e.files.length, 0),
      )
      .toBe(filesOf(liveProject.id));
  });

  test('stale: a worktree edited after the UI rendered is skipped and the toast says so', async ({
    manifest,
    daemon,
    ui,
    edits,
    page,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    const total = await unreviewedTotal(daemon.client);
    const liveCount = (await daemon.client.listFiles(live.id)).files.length;
    await ui.open(daemon.authUrl);
    // Another worktree is open: the edited one is known to the UI only by its review data.
    await ui.selectWorktree(findWorktree(manifest, 'alpha').worktree.id);
    // The UI must hold everything it will mark before the refetches are frozen (the review data
    // fills in per project).
    await expect.poll(() => ui.everyWorktreeCount()).toBe(total);
    const before = (await stateHashes(daemon.client))[live.id] ?? '';

    // Freeze what the UI knows: hold the refetches the live update would trigger.
    let frozen = true;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(/\/api\/(inbox|projects)(\?|$)/, async (route) => {
      if (frozen && route.request().method() === 'GET') await held;
      await route.continue();
    });
    await edits.append(join(live.path, LIVE_FILES.edit), '// octopus-marker-ui-stale\n');
    await waitForStateHashChange(daemon.client, live.id, before);

    await ui.runEveryWorktree();
    await ui.confirmBulk();
    await expect(ui.toast).toBeVisible();
    await expect(ui.toast).toContainText('1 changed meanwhile');
    await expect(ui.toast).toHaveAttribute('data-changed', String(total - liveCount));
    expect(await reviewedPaths(daemon.client, live.id)).toEqual([]);
    expect(await unreviewedTotal(daemon.client)).toBe(liveCount);
    frozen = false;
    release();
    // Once the UI catches up, the command offers exactly the skipped worktree's files.
    await expect.poll(() => ui.everyWorktreeCount()).toBe(liveCount);
  });
});
