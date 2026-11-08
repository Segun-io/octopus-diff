/**
 * PLAN §8 item 8 (and §5.5): read-only proof. The whole suite is covered by the proof that global
 * setup starts and global teardown asserts. This spec adds a self-contained, attributable check:
 * its own fixture set, its own proof, a daemon that is driven through every read endpoint (all
 * scopes, every file diff, full/whitespace/context variants, commits, refresh, SSE) and the UI,
 * while an agent simulator edits the mutable project. Not a single control-repo write is allowed.
 *
 * (The subcommand allowlist itself is unit-tested in packages/git-core, WS1.)
 */
import {
  type FixtureSet,
  findWorktree,
  generateFixtures,
  proofTargetsFromManifest,
  ReadOnlyViolationError,
  startAgentSimulator,
  startReadOnlyProof,
} from '@octopus-diff/fixtures';
import { TestDaemon } from '../support/daemon.js';
import { expect, registeredCheckouts, test } from '../support/test.js';

test.describe('§8.8 read-only proof', () => {
  let fixtures: FixtureSet;

  test.beforeAll(async () => {
    fixtures = await generateFixtures({ seed: 808 });
  });
  test.afterAll(async () => {
    await fixtures?.cleanup();
  });

  test('driving every read path never writes to a control repository', async ({ app }) => {
    test.setTimeout(180_000);
    const { manifest } = fixtures;
    const proof = await startReadOnlyProof({
      env: fixtures.env,
      targets: proofTargetsFromManifest(manifest),
    });
    const daemon = await TestDaemon.start({ manifest });
    const live = findWorktree(manifest, 'live-agent').worktree;
    const sim = startAgentSimulator({
      targets: [{ path: live.path, name: 'live-agent' }],
      env: fixtures.env,
      seed: 8,
      durationMs: 60_000,
      minIntervalMs: 100,
      maxIntervalMs: 400,
    });
    try {
      await daemon.waitForProjects();
      const sub = daemon.client.subscribe({ onEvent: () => {} });
      const client = daemon.client;
      await client.health();
      await client.inbox();
      await client.inbox({ onlyUnreviewed: true });
      await client.listScanRoots();
      for (const { worktree } of registeredCheckouts(manifest)) {
        await client.refreshWorktree(worktree.id);
        await client.setFocus({ worktreeId: worktree.id });
        const commits = worktree.headSha
          ? (await client.listCommits(worktree.id, { limit: 5 })).commits
          : [];
        const scopes = [
          { kind: 'working' as const },
          { kind: 'staged' as const },
          { kind: 'unstaged' as const },
          ...(worktree.headSha ? [{ kind: 'branch' as const }] : []),
          ...commits.slice(0, 2).map((c) => ({ kind: 'commit' as const, sha: c.sha })),
        ];
        for (const scope of scopes) {
          const { files } = await client.listFiles(worktree.id, { scope });
          for (const file of files) {
            const base = {
              scope,
              path: file.path,
              ...(file.rawPath ? { rawPath: file.rawPath } : {}),
            };
            await client.getDiff(worktree.id, base);
            await client.getDiff(worktree.id, { ...base, ignoreWhitespace: true, context: 10 });
            if (file.additions !== null && file.additions > 1000)
              await client.getDiff(worktree.id, { ...base, full: true });
          }
        }
      }
      for (const scanRoot of (await client.listScanRoots()).scanRoots)
        await client.rescanScanRoot(scanRoot.id);
      await daemon.waitForProjects();

      // The UI exercises the same endpoints through the browser.
      await app.open(daemon.authUrl);
      await app.selectInbox();
      const items = await app.fileItems();
      for (const item of items.slice(0, 8)) {
        await app.openFile(item.path, item.worktreeId ?? undefined);
      }
      sub.close();
    } finally {
      await sim.stop();
      await daemon.close();
    }

    const report = await proof.finish();
    test.info().annotations.push({
      type: 'readonly-proof',
      description: `${report.repos.length} repos, ${report.pollCount} polls, ${report.violations.length} violations`,
    });
    if (!report.ok) throw new ReadOnlyViolationError(report);
    expect(report.violations).toEqual([]);
  });
});
