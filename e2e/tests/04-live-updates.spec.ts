/**
 * PLAN §8 item 5 (and §5.6): editing a file in a worktree from outside updates the UI within
 * ~1.5 s, with no reload, preserving the user's selection. Only the mutable `live` project is
 * edited; the read-only proof covers everything else.
 */
import { join } from 'node:path';
import { TEST_IDS } from '@octopus-diff/contracts';
import { findWorktree, LIVE_FILES, startAgentSimulator } from '@octopus-diff/fixtures';
import type { Request } from '@playwright/test';
import { liveBudgetMs } from '../support/env.js';
import { expect, sleep, test } from '../support/test.js';

test.describe('§8.5 live updates', () => {
  test('SSE worktree.changed arrives within budget after an external edit', async ({
    manifest,
    daemon,
    edits,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    const events: Array<{ at: number; worktreeId: string }> = [];
    const sub = daemon.client.subscribe({
      onEvent: (event) => {
        if (event.type === 'worktree.changed')
          events.push({ at: Date.now(), worktreeId: event.worktreeId });
      },
    });
    try {
      await sleep(500);
      const started = Date.now();
      await edits.append(join(live.path, LIVE_FILES.other), '// octopus-marker-sse-probe\n');
      await expect
        .poll(() => events.some((e) => e.worktreeId === live.id), {
          timeout: liveBudgetMs() + 3000,
        })
        .toBe(true);
      const latency = (events.find((e) => e.worktreeId === live.id)?.at ?? Date.now()) - started;
      test.info().annotations.push({ type: 'sse-latency-ms', description: String(latency) });
      expect(latency, `file write → worktree.changed took ${latency} ms`).toBeLessThanOrEqual(
        liveBudgetMs(),
      );
    } finally {
      sub.close();
    }
  });

  test('editing the open file updates the diff, keeps the selection, no reload', async ({
    manifest,
    daemon,
    app,
    edits,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    await app.open(daemon.authUrl);
    await app.selectWorktree(live.id);
    await app.openFile(LIVE_FILES.edit);
    const before = await app.fileItem(LIVE_FILES.edit).getAttribute('data-additions');
    const hashBefore = await app.diffViewer.getAttribute('data-patch-hash');
    const done = await app.armReloadDetector();
    await sleep(300);

    const marker = `octopus-marker-live-${Date.now()}`;
    const started = Date.now();
    await edits.append(join(live.path, LIVE_FILES.edit), `// ${marker}\n// second line\n`);

    // Within budget: the list shows the new counts, and the open diff either shows the new
    // content or the "updated" banner (PLAN §4.2).
    await expect(app.fileItem(LIVE_FILES.edit)).not.toHaveAttribute(
      'data-additions',
      before ?? '',
      {
        timeout: liveBudgetMs(),
      },
    );
    await expect(async () => {
      const banner = await app.byTestId(TEST_IDS.diffUpdatedBanner).isVisible();
      const text = await app.diffViewer.getByText(marker).first().isVisible();
      expect(banner || text).toBe(true);
    }).toPass({ timeout: Math.max(100, liveBudgetMs() - (Date.now() - started)) });
    const elapsed = Date.now() - started;
    test.info().annotations.push({ type: 'ui-latency-ms', description: String(elapsed) });

    // The new content is reachable (directly, or after acknowledging the banner).
    const banner = app.byTestId(TEST_IDS.diffUpdatedBanner);
    if (
      !(await app.diffViewer.getByText(marker).first().isVisible()) &&
      (await banner.isVisible())
    ) {
      await banner.click();
    }
    await app.expectDiffText(marker);
    await expect(app.diffViewer).not.toHaveAttribute('data-patch-hash', hashBefore ?? '');

    // Selection preserved, no reload.
    await expect(app.worktreeItem(live.id)).toHaveAttribute('aria-current', 'true');
    await expect(app.fileItem(LIVE_FILES.edit)).toHaveAttribute('aria-selected', 'true');
    await expect(app.diffViewer).toHaveAttribute('data-path', LIVE_FILES.edit);
    const { reloaded, navigations } = await done();
    expect(reloaded, 'page must not reload').toBe(false);
    expect(navigations).toBe(0);
  });

  test('changes to other files update the list without disturbing the open file', async ({
    manifest,
    daemon,
    app,
    edits,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    await app.open(daemon.authUrl);
    await app.selectWorktree(live.id);
    await app.openFile(LIVE_FILES.edit);
    const hash = await app.diffViewer.getAttribute('data-patch-hash');
    const done = await app.armReloadDetector();
    await sleep(300);

    const added = 'src/brand-new-from-agent.ts';
    await edits.write(join(live.path, added), '// octopus-marker-new-file\nexport const n = 1;\n');
    await edits.remove(join(live.path, 'src/stable.ts'));
    await expect(app.fileItem(added)).toHaveAttribute('data-status', 'untracked', {
      timeout: liveBudgetMs(),
    });
    await expect(app.fileItem('src/stable.ts')).toHaveAttribute('data-status', 'deleted', {
      timeout: liveBudgetMs(),
    });

    await expect(app.fileItem(LIVE_FILES.edit)).toHaveAttribute('aria-selected', 'true');
    await expect(app.diffViewer).toHaveAttribute('data-path', LIVE_FILES.edit);
    await expect(app.diffViewer).toHaveAttribute('data-patch-hash', hash ?? '');
    await expect(app.byTestId(TEST_IDS.diffUpdatedBanner)).toBeHidden();
    expect((await done()).reloaded).toBe(false);

    // Reverting removes them again.
    await edits.restore();
    await expect(app.fileItem(added)).toHaveCount(0, { timeout: liveBudgetMs() });
    await expect(app.fileItem('src/stable.ts')).toHaveCount(0, { timeout: liveBudgetMs() });
  });

  test('an edit costs no /api/projects refetch, no refetch of the open diff and under 100 KB (#51)', async ({
    manifest,
    daemon,
    app,
    edits,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    await app.open(daemon.authUrl);
    await app.selectWorktree(live.id);
    await app.openFile(LIVE_FILES.edit);
    const hash = await app.diffViewer.getAttribute('data-patch-hash');
    const additions = () => app.fileItem(LIVE_FILES.other).getAttribute('data-additions');
    const before = (await app.fileItem(LIVE_FILES.other).count()) > 0 ? await additions() : null;
    await sleep(1000);

    const seen: Array<{ url: string; bytes: number }> = [];
    const pending: Promise<void>[] = [];
    const onFinished = (request: Request) => {
      if (!request.url().includes('/api/')) return;
      pending.push(
        request.sizes().then((s) => {
          seen.push({ url: request.url(), bytes: s.responseBodySize + s.responseHeadersSize });
        }),
      );
    };
    app.page.on('requestfinished', onFinished);
    try {
      await edits.append(join(live.path, LIVE_FILES.other), '// octopus-marker-delta\n');
      await expect
        .poll(
          async () => ((await app.fileItem(LIVE_FILES.other).count()) > 0 ? additions() : null),
          {
            timeout: liveBudgetMs() + 3000,
          },
        )
        .not.toBe(before);
      await sleep(1000); // whatever else the edit caused
    } finally {
      app.page.off('requestfinished', onFinished);
    }
    await Promise.all(pending);
    const urls = seen.map((s) => new URL(s.url).pathname);
    expect(
      urls.filter((u) => u === '/api/projects'),
      urls.join(', '),
    ).toEqual([]);
    expect(
      urls.filter((u) => u.endsWith('/diff')),
      urls.join(', '),
    ).toEqual([]);
    expect(urls.filter((u) => u === `/api/worktrees/${live.id}/files`).length).toBeGreaterThan(0);
    const bytes = seen.reduce((sum, s) => sum + s.bytes, 0);
    test.info().annotations.push({ type: 'edit-traffic-bytes', description: String(bytes) });
    expect(bytes, urls.join(', ')).toBeLessThan(100 * 1024);
    await expect(app.diffViewer).toHaveAttribute('data-patch-hash', hash ?? '');
    await expect(app.diffViewer).toHaveAttribute('data-path', LIVE_FILES.edit);
  });

  test('sidebar counts follow external edits while another worktree is open', async ({
    manifest,
    daemon,
    app,
    edits,
  }) => {
    const agent = findWorktree(manifest, 'live-agent').worktree;
    await app.open(daemon.authUrl);
    // Another worktree is open (not the agent's), as the Inbox view used to be.
    await app.selectWorktree(findWorktree(manifest, 'alpha').worktree.id);
    const item = app.worktreeItem(agent.id);
    await app.reveal(item);
    const untracked = Number(await item.getAttribute('data-untracked'));
    await edits.write(join(agent.path, 'src/agent-note.ts'), 'export {};\n');
    await app.reveal(item);
    await expect(item).toHaveAttribute('data-untracked', String(untracked + 1), {
      timeout: liveBudgetMs(),
    });
    // Opening the worktree lists the new file.
    await app.selectWorktree(agent.id);
    await expect
      .poll(async () => (await app.filePaths()).includes('src/agent-note.ts'), { timeout: 10_000 })
      .toBe(true);
  });

  test('UI converges to the daemon state after an agent-simulator burst', async ({
    manifest,
    daemon,
    app,
    gitEnv,
  }) => {
    const agent = findWorktree(manifest, 'live-agent').worktree;
    await app.open(daemon.authUrl);
    await app.selectWorktree(agent.id);
    const done = await app.armReloadDetector();
    const report = await startAgentSimulator({
      targets: [{ path: agent.path, name: 'live-agent' }],
      env: gitEnv,
      seed: 2026,
      durationMs: 4000,
      minIntervalMs: 50,
      maxIntervalMs: 300,
      weights: { commit: 2 },
    }).done;
    expect(report.errors).toBe(0);
    await expect(async () => {
      const { files } = await daemon.client.listFiles(agent.id);
      expect((await app.filePaths()).sort()).toEqual(files.map((f) => f.path).sort());
    }).toPass({ timeout: 5000 + liveBudgetMs() });
    await expect(app.worktreeItem(agent.id)).toHaveAttribute('aria-current', 'true');
    expect((await done()).reloaded).toBe(false);
  });
});
