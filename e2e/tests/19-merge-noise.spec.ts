/**
 * Merge noise out of the box (roadmap #24 step 14, issue #35), in the browser against the real
 * daemon and git: a worktree that merged `main`, resolved a conflict, took a cherry-pick or was
 * rebased onto `origin/main` shows its own work first; what the default branch brought sits in a
 * collapsed "From main" group (wrapped, not hidden) and is never counted or reviewed as the
 * branch's work. Scenarios: `tools/fixtures/src/merge-noise.ts` (real git, isolated config, a bare
 * `origin` filled by clone / push / fetch; no network).
 *
 * Test ids: `ORIGIN_TEST_IDS` in apps/web/src/components/OriginGroupHeader.tsx (`from-main-group`,
 * `from-main-chip`, `branch-only-toggle`, `origin-tag`), `file-item[data-origin]` / `data-origin-via`.
 */
import { type ApiClient, type DiffScope, TEST_IDS } from '@octopus-diff/contracts';
import {
  generateMergeNoise,
  MERGE_NOISE_AFTER_FETCH,
  MERGE_NOISE_EXPECTED,
  MERGE_NOISE_OWN_COUNTS,
  type MergeNoiseSet,
  type MergeNoiseWorktree,
} from '@octopus-diff/fixtures';
import type { Locator } from '@playwright/test';
import type { AppPage } from '../support/app.js';
import { TestDaemon } from '../support/daemon.js';
import { test as base, expect } from '../support/test.js';

/** The ids of the controls under test (kept in sync with `ORIGIN_TEST_IDS` in the web app). */
const ORIGIN = {
  group: 'from-main-group',
  chip: 'from-main-chip',
  branchToggle: 'branch-only-toggle',
  tag: 'origin-tag',
} as const;

const TO_REVIEW = { settledOpen: true, defaultScope: 'review' };
const BRANCH_ALL: DiffScope = { kind: 'branch', includeWorking: true };
const REVIEW: DiffScope = { kind: 'review' };

interface Noise {
  set: MergeNoiseSet;
  daemon: TestDaemon;
  api: ApiClient;
  /** Every worktree of both projects. */
  all: MergeNoiseWorktree[];
  /** Own commits, then main moves and the features take it (stage 2). Waits until the daemon saw it. */
  integrate(): Promise<void>;
  /** The worktree of `noise-local` / `noise-remote` with this role. */
  local(role: string): MergeNoiseWorktree;
  remote(role: string): MergeNoiseWorktree;
}

const test = base.extend<{ noise: Noise }>({
  noise: async ({ manifest }, use) => {
    const set = await generateMergeNoise({ parentDir: manifest.root, prefix: 'merge-noise-' });
    // Its own daemon: only these two projects, so the tab title count is exactly theirs.
    const daemon = await TestDaemon.start({ manifest, register: 'none' });
    try {
      const api = daemon.client;
      await api.addProject({ path: set.local.dir });
      await api.addProject({ path: set.remote.dir });
      const all = [...Object.values(set.local.worktrees), ...Object.values(set.remote.worktrees)];
      // First sight at the base commit: the review bookmarks start there (docs/STATUS-FLOW.md).
      for (const w of all) await api.refreshWorktree(w.id);
      const pick = (project: MergeNoiseSet['local'], role: string) => {
        const w = project.worktrees[role];
        if (!w) throw new Error(`no worktree ${role}`);
        return w;
      };
      await use({
        set,
        daemon,
        api,
        all,
        async integrate() {
          await set.commitOwnWork();
          await set.integrate();
          await settle(api, all);
        },
        local: (role) => pick(set.local, role),
        remote: (role) => pick(set.remote, role),
      });
    } finally {
      await daemon.close();
      await set.cleanup();
    }
  },
});

/** Recomputes every summary and waits until the labels the scenarios expect are the daemon's. */
async function settle(api: ApiClient, all: MergeNoiseWorktree[]): Promise<void> {
  for (const w of all) await api.refreshWorktree(w.id);
  await expect
    .poll(async () => (await api.listFiles(all[0]?.id as string, { scope: REVIEW })).files.length)
    .toBeGreaterThan(0);
}

/** Opens the app on To review and the worktree, waiting until its list is on screen. */
async function openWorktree(noise: Noise, app: AppPage, worktree: MergeNoiseWorktree) {
  await app.open(noise.daemon.authUrl, { prefs: TO_REVIEW });
  await app.selectWorktree(worktree.id);
  await expect(app.byTestId(TEST_IDS.scopeSelect)).toHaveAttribute('data-scope', 'review');
  await expect(app.fileList).toBeVisible();
}

const groupOf = (app: AppPage) => app.byTestId(ORIGIN.group);
const tags = (app: AppPage) => app.byTestId(ORIGIN.tag);

/** Text of the scope select's option for one scope (`To review (2)`). */
async function scopeLabel(app: AppPage, value: string): Promise<string> {
  const option = app.byTestId(TEST_IDS.scopeSelect).locator(`option[value="${value}"]`);
  return ((await option.textContent()) ?? '').trim();
}

/** Every row's path and origin, in list order. */
async function rows(app: AppPage): Promise<Array<{ path: string; origin: string | null }>> {
  return app.fileList.locator(`[data-testid="${TEST_IDS.fileItem}"]`).evaluateAll((nodes) =>
    nodes.map((n) => ({
      path: n.getAttribute('data-path') ?? '',
      origin: n.getAttribute('data-origin'),
    })),
  );
}

const sorted = (values: readonly string[]) => [...values].sort();
const unreviewedPill = (item: Locator) => item.locator('.od-pill');

test.describe('merge noise (real daemon, real git)', () => {
  test('a merge of main: own work first, the rest in a collapsed "From main" group; expanding shows dimmed, tagged rows', async ({
    noise,
    app,
  }) => {
    await noise.integrate();
    const merge = noise.local('merge');
    const want = MERGE_NOISE_EXPECTED.merge;
    await openWorktree(noise, app, merge);

    // Collapsed: only the branch's own files are rows; the group says what is inside.
    await expect.poll(() => app.filePaths()).toEqual([...want.own]);
    const group = groupOf(app);
    await expect(group).toHaveCount(1);
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await expect(group).toHaveAttribute('data-count', String(want.base.length));
    await expect(group).toHaveText(`From main - merge (${want.base.length} files)`);
    // Wrapped, not hidden: the group is a row of the list, after the own files.
    expect(await tags(app).count()).toBe(0);

    // Expanded: the files the merge brought, after the own ones, dimmed and tagged with the via.
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'true');
    await expect.poll(() => app.filePaths()).toEqual([...want.own, ...want.base]);
    const list = await rows(app);
    expect(list.slice(0, want.own.length).every((r) => r.origin === null)).toBe(true);
    expect(list.slice(want.own.length).every((r) => r.origin === 'base')).toBe(true);
    for (const path of want.base) {
      const row = app.fileItem(path);
      await expect(row).toHaveAttribute('data-origin', 'base');
      await expect(row).toHaveAttribute('data-origin-via', 'merge');
      await expect(row).toHaveClass(/opacity-60/);
      await expect(row.locator(`[data-testid="${ORIGIN.tag}"]`)).toHaveText('merge');
    }
    for (const path of want.own) {
      await expect(app.fileItem(path)).not.toHaveClass(/opacity-60/);
    }

    // The group closes again and the own rows stay.
    await group.click();
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => app.filePaths()).toEqual([...want.own]);
  });

  test('j, k and n skip the collapsed group; expanding makes its rows reachable', async ({
    noise,
    app,
  }) => {
    await noise.integrate();
    const want = MERGE_NOISE_EXPECTED.merge;
    await openWorktree(noise, app, noise.local('merge'));
    await expect.poll(() => app.filePaths()).toEqual([...want.own]);
    const [first, second] = want.own;
    // The list opens its first file by itself; open it explicitly so the walk starts there.
    await app.openFile(first);
    await app.focusApp();

    await app.press('j');
    await expect(app.selectedFile).toHaveAttribute('data-path', second);
    // Past the last own file there is nothing to step to: the collapsed group is not a stop.
    await app.press('j');
    await app.press('j');
    await expect(app.selectedFile).toHaveAttribute('data-path', second);
    await app.press('k');
    await expect(app.selectedFile).toHaveAttribute('data-path', first);
    // `n` (next unreviewed) is global: the next unreviewed file, wrapping through every worktree.
    // From the first own file it steps to the second; around the whole ring it never lands on a
    // file of a collapsed group (every worktree here has one, except `main`'s own files).
    const selection = async () =>
      app.selectedFile.evaluate(
        (el) => `${el.getAttribute('data-worktree-id')}:${el.getAttribute('data-path')}`,
      );
    await app.press('n');
    await expect(app.selectedFile).toHaveAttribute('data-path', second);
    for (let i = 0; i < 18; i++) {
      const previous = await selection();
      await app.press('n');
      await expect.poll(selection, `n #${i + 2} did not move`).not.toBe(previous);
      await expect(
        app.selectedFile,
        `n #${i + 2} landed on ${await selection()}`,
      ).not.toHaveAttribute('data-origin', 'base');
    }
    // Back on the merge worktree's own files (the ring is closed), nothing was expanded on the way.
    await app.selectWorktree(noise.local('merge').id);
    expect(await tags(app).count()).toBe(0);

    // Expanded, the same keys walk into the group: from the last own file, `j` enters it.
    await app.openFile(second);
    await groupOf(app).click();
    await app.focusApp();
    await app.press('j');
    await expect(app.selectedFile).toHaveAttribute('data-origin', 'base');
    await expect(app.selectedFile).toHaveAttribute('data-path', want.base[0]);
  });

  test('the "From main (N)" chip lists only the merge-brought files, tagged, and `m` toggles it', async ({
    noise,
    app,
  }) => {
    await noise.integrate();
    const want = MERGE_NOISE_EXPECTED.merge;
    await openWorktree(noise, app, noise.local('merge'));
    const chip = app.byTestId(ORIGIN.chip);
    await expect(chip).toHaveText(`From main (${want.base.length})`);
    await expect(chip).toHaveAttribute('data-count', String(want.base.length));
    await expect(chip).toHaveAttribute('aria-pressed', 'false');

    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    // Only those files, plain rows: no own file, no group row.
    await expect.poll(() => app.filePaths()).toEqual([...want.base]);
    await expect(groupOf(app)).toHaveCount(0);
    expect((await rows(app)).every((r) => r.origin === 'base')).toBe(true);
    await expect(tags(app)).toHaveCount(want.base.length);

    await app.focusApp();
    await app.press('m');
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(() => app.filePaths()).toEqual([...want.own]);
    await expect(groupOf(app)).toHaveCount(1);
    await app.press('m');
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => app.filePaths()).toEqual([...want.base]);
  });

  test('counts are own work only and a merge of main does not change them (row, scope, title, favicon)', async ({
    noise,
    app,
  }) => {
    const { all } = noise;
    const ids = (role: string) => noise.local(role).id;
    // Before the merge: the branches have their own commits, main has not moved.
    await noise.set.commitOwnWork();
    await Promise.all(all.map((w) => noise.api.refreshWorktree(w.id)));
    await app.open(noise.daemon.authUrl, { prefs: TO_REVIEW });
    const before = {
      merge: MERGE_NOISE_OWN_COUNTS.merge,
      conflict: 2, // own file + the file both sides will change: all own until main moves
      mixed: 2,
      pick: MERGE_NOISE_OWN_COUNTS.pick,
      main: 0,
    };
    for (const [role, count] of Object.entries(before)) {
      await expect(app.worktreeItem(ids(role)), role).toHaveAttribute(
        'data-unreviewed',
        String(count),
      );
    }
    // Local 0 + 2 + 2 + 2 + 1, remote 1 (rebase) + 2 (fix).
    await expect(app.page).toHaveTitle('(10) octopus-diff');

    // Main moves and the features take it: three merges, a cherry-pick, a rebase.
    await noise.set.integrate();
    await Promise.all(all.map((w) => noise.api.refreshWorktree(w.id)));

    // The branches' counts do not move: their files are the same own files, now with noise around.
    const after = { ...before, conflict: 2, mixed: 2, main: MERGE_NOISE_OWN_COUNTS.main };
    for (const [role, count] of Object.entries(after)) {
      await expect(app.worktreeItem(ids(role)), role).toHaveAttribute(
        'data-unreviewed',
        String(count),
        { timeout: 15_000 },
      );
    }
    // The pill on the row says the same number; the raw count would be 7 / 6 / 6 / 2.
    await expect(unreviewedPill(app.worktreeItem(ids('merge')))).toHaveText('2');
    await expect(unreviewedPill(app.worktreeItem(ids('pick')))).toHaveText('1');
    // The tab title and the favicon dot count the own work of every worktree: 5 (main) + 2 + 2 + 2
    // + 1 + 1 + 2 = 15. Merge-brought files would add 5 + 4 + 4 + 1 + 2 more.
    await expect(app.page).toHaveTitle('(15) octopus-diff');
    await expect(app.page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute(
      'href',
      /^data:image\/svg\+xml/,
    );

    // The scope select of the merged worktree counts own files too, and so does the group header.
    await app.selectWorktree(ids('merge'));
    await expect.poll(() => scopeLabel(app, 'review')).toBe('To review (2)');
    await expect(groupOf(app)).toHaveAttribute('data-count', '5');
    // The Inbox's "Review all N" counts what Review all would mark: own work, never the group.
    await app.selectInbox();
    await expect(app.byTestId(TEST_IDS.markAllButton)).toHaveAttribute('data-count', String(15));
  });

  test('a resolved conflict and a file both sides changed are `+main`; "Only this branch\'s changes" shows them as own', async ({
    noise,
    app,
  }) => {
    await noise.integrate();
    await app.open(noise.daemon.authUrl, { prefs: TO_REVIEW });
    for (const role of ['conflict', 'mixed'] as const) {
      const want = MERGE_NOISE_EXPECTED[role];
      const worktree = noise.local(role);
      await app.selectWorktree(worktree.id);
      await expect(app.byTestId(TEST_IDS.scopeSelect)).toHaveAttribute('data-scope', 'review');
      const toggle = app.byTestId(ORIGIN.branchToggle);
      await expect(toggle, role).toHaveAttribute('aria-pressed', 'false');

      // To review: the own file, the mixed one (own, not wrapped, tagged `+main`), then the group.
      await expect.poll(() => app.filePaths(), role).toEqual(sorted([...want.own, ...want.mixed]));
      const mixedFile = want.mixed[0];
      const row = app.fileItem(mixedFile);
      await expect(row).toHaveAttribute('data-origin', 'mixed');
      await expect(row.locator(`[data-testid="${ORIGIN.tag}"]`)).toHaveText('+main');
      await expect(row).not.toHaveClass(/opacity-60/);
      await expect(groupOf(app)).toHaveText(`From main - merge (${want.base.length} files)`);
      await expect(app.fileItem(want.own[0] as string)).not.toHaveAttribute('data-origin', /.+/);

      // The toggle is All on branch: only this branch's changes, the file is plain own there.
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect(app.byTestId(TEST_IDS.scopeSelect)).toHaveAttribute('data-scope', /^branch/);
      await expect.poll(() => app.filePaths(), role).toEqual(sorted([...want.own, ...want.mixed]));
      expect(
        (await rows(app)).every((r) => r.origin === null),
        role,
      ).toBe(true);
      await expect(groupOf(app)).toHaveCount(0);
      await expect(tags(app)).toHaveCount(0);

      // And the way back lands on To review with the group.
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await expect(app.byTestId(TEST_IDS.scopeSelect)).toHaveAttribute('data-scope', 'review');
      await expect(groupOf(app)).toHaveCount(1);
      await expect(app.fileItem(mixedFile)).toHaveAttribute('data-origin', 'mixed');
    }
  });

  test('a cherry-pick is "same as main", a rebase onto origin/main (stale local main) is "From origin/main - rebase"', async ({
    noise,
    app,
  }) => {
    await noise.integrate();
    await app.open(noise.daemon.authUrl, { prefs: TO_REVIEW });

    const pick = MERGE_NOISE_EXPECTED.pick;
    await app.selectWorktree(noise.local('pick').id);
    await expect.poll(() => app.filePaths()).toEqual([...pick.own]);
    await expect(groupOf(app)).toHaveText('From main - same as main (1 file)');
    await groupOf(app).click();
    await expect(app.fileItem('src/hotfix.txt')).toHaveAttribute('data-origin-via', 'same-as-base');
    await expect(
      app.fileItem('src/hotfix.txt').locator(`[data-testid="${ORIGIN.tag}"]`),
    ).toHaveText('same as main');

    const rebase = MERGE_NOISE_EXPECTED.rebase;
    await app.selectWorktree(noise.remote('rebase').id);
    await expect.poll(() => app.filePaths()).toEqual([...rebase.own]);
    await expect(groupOf(app)).toHaveText(
      `From origin/main - rebase (${rebase.base.length} files)`,
    );
    // The local main is stale: the noise is what origin/main has that the branch took, and the
    // chip names the branch without the remote.
    await expect(app.byTestId(ORIGIN.chip)).toHaveText(`From main (${rebase.base.length})`);
    expect(
      await noise.api.listFiles(noise.remote('main').id, { scope: REVIEW }).then((r) => r.files),
    ).toEqual([]);
  });

  test('Review all marks own files only, moves the bookmark and the noise leaves To review; the main worktree stays unreviewed', async ({
    noise,
    app,
  }) => {
    await noise.integrate();
    const merge = noise.local('merge');
    const main = noise.local('main');
    const want = MERGE_NOISE_EXPECTED.merge;
    await openWorktree(noise, app, merge);
    await expect.poll(() => app.filePaths()).toEqual([...want.own]);
    // Expanded or not, the button counts what it will mark: own files.
    const button = app.byTestId(TEST_IDS.markAllButton);
    await expect(button).toHaveAttribute('data-count', String(want.own.length));
    await groupOf(app).click();
    await expect(button).toHaveAttribute('data-count', String(want.own.length));
    const mainBefore = await noise.api.listFiles(main.id, { scope: REVIEW });
    expect(mainBefore.files.length).toBe(MERGE_NOISE_OWN_COUNTS.main);

    await button.click();
    await expect(app.byTestId(TEST_IDS.bulkReviewToast)).toBeVisible();
    await expect(app.byTestId(TEST_IDS.bulkReviewToast)).toHaveAttribute(
      'data-changed',
      String(want.own.length),
    );
    // The worktree is reviewed, the group is gone from To review: the bookmark moved to HEAD.
    const row = app.worktreeItem(merge.id);
    await expect(row).toHaveAttribute('data-stage', 'reviewed', { timeout: 15_000 });
    await expect(row).toHaveAttribute('data-unreviewed', '0');
    await expect(groupOf(app)).toHaveCount(0);
    await expect.poll(() => app.filePaths()).toEqual([]);
    expect((await noise.api.listFiles(merge.id, { scope: REVIEW })).files).toEqual([]);
    const summary = (await noise.api.refreshWorktree(merge.id)).summary.review;
    expect(summary).toMatchObject({ newCommits: 0, unreviewedFiles: 0, baseFiles: 0 });

    // Own files are marked (All on branch lists them all, reviewed), nothing else was touched.
    const branch = await noise.api.listFiles(merge.id, { scope: BRANCH_ALL });
    expect(branch.files.map((f) => `${f.path}:${f.reviewed}`).sort()).toEqual(
      want.own.map((p) => `${p}:true`),
    );
    // The `main` worktree owns those commits and files: not reviewed by the feature's Review all.
    // (Marks are per project and path + patch, so a marked base file would show reviewed here.)
    const mainAfter = await noise.api.listFiles(main.id, { scope: REVIEW });
    expect(mainAfter.files.map((f) => `${f.path}:${f.reviewed}`).sort()).toEqual(
      mainBefore.files.map((f) => `${f.path}:false`).sort(),
    );
    expect((await noise.api.refreshWorktree(main.id)).summary.review).toMatchObject({
      newCommits: 3,
      unreviewedFiles: MERGE_NOISE_OWN_COUNTS.main,
    });
    await expect(app.worktreeItem(main.id)).toHaveAttribute('data-stage', 'review');
    await expect(app.worktreeItem(main.id)).toHaveAttribute(
      'data-unreviewed',
      String(MERGE_NOISE_OWN_COUNTS.main),
    );
  });

  test('a git fetch that moves origin/main relabels the files (live)', async ({ noise, app }) => {
    await noise.integrate();
    const fix = noise.remote('fix');
    await openWorktree(noise, app, fix);
    // Before: both of the branch's files are its own, there is nothing to wrap.
    await expect
      .poll(() => app.filePaths())
      .toEqual([...MERGE_NOISE_AFTER_FETCH.own, ...MERGE_NOISE_AFTER_FETCH.base]);
    await expect(groupOf(app)).toHaveCount(0);
    await expect(app.worktreeItem(fix.id)).toHaveAttribute('data-unreviewed', '2');
    await expect.poll(() => scopeLabel(app, 'review')).toBe('To review (2)');

    // The same fix lands on origin/main; only the remote-tracking ref moves in this project.
    await noise.set.fetchMovesOrigin();
    const group = groupOf(app);
    await expect(group).toHaveText('From origin/main - same as main (1 file)', {
      timeout: 15_000,
    });
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await expect.poll(() => app.filePaths()).toEqual([...MERGE_NOISE_AFTER_FETCH.own]);
    await expect(app.worktreeItem(fix.id)).toHaveAttribute('data-unreviewed', '1');
    await expect.poll(() => scopeLabel(app, 'review')).toBe('To review (1)');
    await group.click();
    await expect(app.fileItem(MERGE_NOISE_AFTER_FETCH.base[0])).toHaveAttribute(
      'data-origin-via',
      'same-as-base',
    );
    // The other worktrees keep their labels.
    await app.selectWorktree(noise.remote('rebase').id);
    await expect(groupOf(app)).toHaveText('From origin/main - rebase (2 files)');
  });
});
