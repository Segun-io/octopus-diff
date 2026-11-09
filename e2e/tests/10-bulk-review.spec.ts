/**
 * UX round 1 (COORDINATION §2.2, acceptance UX-1 and UX-8): "Review all" (bulk marks) with undo,
 * driven over the API against the real daemon. Covers the state guard (`stale`), `paths`,
 * per-project counting, review-disabled worktrees, a self-contained read-only proof, and the
 * bulk `all` latency on the 30 × 3 bench layout (reported, with a < 2 s assertion).
 */
import { join } from 'node:path';
import {
  type FixtureSet,
  findProject,
  findWorktree,
  generateFixtures,
  LIVE_FILES,
  proofTargetsFromManifest,
  ReadOnlyViolationError,
  registeredProjects,
  startReadOnlyProof,
} from '@octopus-diff/fixtures';
import {
  distinctMarks,
  median,
  recordEvents,
  reviewedPaths,
  stateHashes,
  timed,
  waitForStateHashChange,
  writeJson,
} from '../support/api.js';
import { TestDaemon } from '../support/daemon.js';
import { E2E_DIR } from '../support/env.js';
import { dirtyCheckouts, expect, test } from '../support/test.js';

test.describe('UX-1 bulk review with undo (API)', () => {
  test('marks the state the user saw, emits one review.bulk, and undo restores exactly it', async ({
    manifest,
    daemon,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    const { files } = await daemon.client.listFiles(live.id);
    expect(files.length).toBeGreaterThan(1);
    const hashes = await stateHashes(daemon.client);
    const events = await recordEvents(daemon.client);

    const marked = await daemon.client.bulkReview({
      target: { kind: 'worktree', worktreeId: live.id },
      expectedStateHashes: { [live.id]: hashes[live.id] ?? '' },
    });
    expect(marked).toMatchObject({
      ok: true,
      reviewed: true,
      changed: files.length,
      unchanged: 0,
      worktrees: 1,
      skippedDisabled: [],
      stale: [],
    });
    expect(marked.undoToken).toEqual(expect.any(String));
    expect(await reviewedPaths(daemon.client, live.id)).toEqual(files.map((f) => f.path).sort());
    const bulk = await events.waitFor((e) => e.type === 'review.bulk');
    expect(bulk).toEqual({
      type: 'review.bulk',
      projectIds: [findProject(manifest, 'live').id],
      reviewed: true,
      changed: files.length,
    });
    expect(events.ofType('review.changed')).toEqual([]);
    const unreviewed = await daemon.client.inbox({ onlyUnreviewed: true });
    expect(unreviewed.entries.map((e) => e.worktree.id)).not.toContain(live.id);

    // Already in the requested state: nothing changes, no token, no event.
    const again = await daemon.client.bulkReview({
      target: { kind: 'worktree', worktreeId: live.id },
    });
    expect(again).toMatchObject({ changed: 0, unchanged: files.length, undoToken: null });

    if (!marked.undoToken) throw new Error('expected an undo token');
    const undone = await daemon.client.undoReview({ undoToken: marked.undoToken });
    expect(undone).toEqual({ ok: true, restored: files.length });
    expect(await reviewedPaths(daemon.client, live.id)).toEqual([]);
    await events.waitFor((e) => e.type === 'review.bulk' && e.reviewed === false);
    expect(events.ofType('review.bulk')).toHaveLength(2);
    await expect(daemon.client.undoReview({ undoToken: marked.undoToken })).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    events.close();
  });

  test('`paths` restricts a worktree call (the UI filters) and is refused for other targets', async ({
    manifest,
    daemon,
  }) => {
    const live = findWorktree(manifest, 'live');
    const { files } = await daemon.client.listFiles(live.worktree.id);
    const [first] = files;
    if (!first) throw new Error('live has no changed files');
    const some = await daemon.client.bulkReview({
      target: { kind: 'worktree', worktreeId: live.worktree.id },
      paths: [{ path: first.path }, { path: 'does/not/exist.ts' }],
    });
    expect(some).toMatchObject({ changed: 1, unchanged: 0, worktrees: 1 });
    expect(await reviewedPaths(daemon.client, live.worktree.id)).toEqual([first.path]);
    await expect(
      daemon.client.bulkReview({
        target: { kind: 'project', projectId: live.project.id },
        paths: [{ path: first.path }],
      }),
    ).rejects.toMatchObject({ code: 'bad_request', status: 400 });
  });

  test('never marks a state the user did not see: a changed worktree is reported stale', async ({
    manifest,
    daemon,
    edits,
  }) => {
    const live = findWorktree(manifest, 'live').worktree;
    const before = (await stateHashes(daemon.client))[live.id] ?? '';
    await edits.append(join(live.path, LIVE_FILES.edit), '// octopus-marker-bulk-stale\n');
    const after = await waitForStateHashChange(daemon.client, live.id, before);

    const stale = await daemon.client.bulkReview({
      target: { kind: 'all' },
      expectedStateHashes: { [live.id]: before },
    });
    expect(stale.stale).toEqual([live.id]);
    expect(await reviewedPaths(daemon.client, live.id)).toEqual([]);
    expect(stale.changed).toBeGreaterThan(0); // the other worktrees were fine
    const fresh = await daemon.client.bulkReview({
      target: { kind: 'worktree', worktreeId: live.id },
      expectedStateHashes: { [live.id]: after },
    });
    expect(fresh.stale).toEqual([]);
    expect(fresh.changed).toBe((await daemon.client.listFiles(live.id)).files.length);
  });

  test('project, folder and all count marks per project and skip review-disabled worktrees', async ({
    manifest,
    daemon,
  }) => {
    const live = findWorktree(manifest, 'live');
    const agent = findWorktree(manifest, 'live-agent');
    const inbox = await daemon.client.inbox();
    const dirty = dirtyCheckouts(manifest);
    expect(inbox.entries.map((e) => e.worktree.id).sort()).toEqual(
      dirty.map(({ worktree }) => worktree.id).sort(),
    );

    const project = await daemon.client.bulkReview({
      target: { kind: 'project', projectId: live.project.id },
    });
    const liveEntries = inbox.entries.filter((e) => e.project.id === live.project.id);
    expect(project).toMatchObject({ changed: distinctMarks(liveEntries), worktrees: 2 });
    expect(await reviewedPaths(daemon.client, agent.worktree.id)).toEqual(
      inbox.entries
        .find((e) => e.worktree.id === agent.worktree.id)
        ?.files.map((f) => f.path)
        .sort(),
    );

    const root = (await daemon.client.listScanRoots()).scanRoots[0];
    if (!root) throw new Error('scan root');
    const folderEntries = inbox.entries.filter((e) => e.project.scanRootId === root.id);
    const folder = await daemon.client.bulkReview({
      target: { kind: 'folder', scanRootId: root.id },
    });
    expect(folder).toMatchObject({
      changed: distinctMarks(folderEntries),
      worktrees: folderEntries.length,
    });

    const all = await daemon.client.bulkReview({ target: { kind: 'all' } });
    expect(all).toMatchObject({
      changed:
        distinctMarks(inbox.entries) - distinctMarks(liveEntries) - distinctMarks(folderEntries),
      unchanged: distinctMarks(liveEntries) + distinctMarks(folderEntries),
      worktrees: inbox.entries.length,
    });
    expect((await daemon.client.inbox({ onlyUnreviewed: true })).entries).toEqual([]);

    // Clear everything, disable the agent worktree, mark the project: it is skipped unless forced.
    const cleared = await daemon.client.bulkReview({ target: { kind: 'all' }, reviewed: false });
    expect(cleared).toMatchObject({ reviewed: false, changed: distinctMarks(inbox.entries) });
    await daemon.client.setReviewPolicy({
      target: { kind: 'worktree', worktreeId: agent.worktree.id },
      enabled: false,
    });
    const skipped = await daemon.client.bulkReview({
      target: { kind: 'project', projectId: live.project.id },
    });
    expect(skipped.skippedDisabled).toEqual([agent.worktree.id]);
    expect(skipped.worktrees).toBe(1);
    const forced = await daemon.client.bulkReview({
      target: { kind: 'project', projectId: live.project.id },
      includeDisabled: true,
    });
    expect(forced.skippedDisabled).toEqual([]);
    expect(forced.worktrees).toBe(2);
    expect(forced.changed + forced.unchanged).toBe(distinctMarks(liveEntries));
  });

  test.describe('read-only proof and performance (own fixtures)', () => {
    let fixtures: FixtureSet;
    test.beforeAll(async () => {
      fixtures = await generateFixtures({ seed: 1010 });
    });
    test.afterAll(async () => {
      await fixtures?.cleanup();
    });

    test('bulk review, undo, policy and settings changes never write to a repository', async () => {
      test.setTimeout(180_000);
      const { manifest } = fixtures;
      const proof = await startReadOnlyProof({
        env: fixtures.env,
        targets: proofTargetsFromManifest(manifest),
      });
      const daemon = await TestDaemon.start({ manifest, webRoot: null });
      try {
        await daemon.waitForProjects();
        const client = daemon.client;
        const hashes = await stateHashes(client);
        const all = await client.bulkReview({
          target: { kind: 'all' },
          expectedStateHashes: hashes,
        });
        expect(all.stale).toEqual([]);
        expect(all.changed).toBeGreaterThan(0);
        if (!all.undoToken) throw new Error('token');
        expect((await client.undoReview({ undoToken: all.undoToken })).restored).toBe(all.changed);
        for (const scope of [
          { kind: 'staged' as const },
          { kind: 'unstaged' as const },
          { kind: 'branch' as const },
        ]) {
          await client.bulkReview({ target: { kind: 'all' }, scope });
          await client.bulkReview({ target: { kind: 'all' }, scope, reviewed: false });
        }
        const root = (await client.listScanRoots()).scanRoots[0];
        if (root) {
          await client.setReviewPolicy({
            target: { kind: 'folder', scanRootId: root.id },
            enabled: false,
          });
        }
        await client.updateSettings({ review: { defaultEnabled: false } });
        await client.bulkReview({ target: { kind: 'all' }, includeDisabled: true });
        await client.updateSettings({ review: { defaultEnabled: true } });
        await client.inbox({ onlyUnreviewed: true });
        await daemon.restart();
        await daemon.waitForProjects();
        expect((await daemon.client.getSettings()).revision).toBeGreaterThan(0);
      } finally {
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

  test('bulk `all` over the 30 × 3 bench layout stays well under 2 s', async () => {
    test.setTimeout(240_000);
    const bench = await generateFixtures({
      seed: 7,
      acceptance: false,
      bench: { repos: 30, worktreesPerRepo: 3 },
      prefix: 'octopus-diff-bulkbench-',
    });
    try {
      const daemon = await TestDaemon.start({ manifest: bench.manifest, webRoot: null });
      try {
        await daemon.waitForProjects(
          registeredProjects(bench.manifest).map((p) => p.name),
          120_000,
        );
        const client = daemon.client;
        const projectsMs = [];
        for (let i = 0; i < 5; i++) projectsMs.push((await timed(() => client.listProjects())).ms);
        const worktrees = (await client.listProjects()).projects.flatMap((p) => p.worktrees).length;
        // Cold: file lists are not cached yet, so this is the same work the inbox does.
        const cold = await timed(() => client.bulkReview({ target: { kind: 'all' } }));
        if (!cold.value.undoToken) throw new Error('token');
        const undo = await timed(() =>
          client.undoReview({ undoToken: cold.value.undoToken ?? '' }),
        );
        const inboxCold = await timed(() => client.inbox());
        const inboxWarm = [];
        for (let i = 0; i < 5; i++) inboxWarm.push((await timed(() => client.inbox())).ms);
        const warm = await timed(() => client.bulkReview({ target: { kind: 'all' } }));
        const clear = await timed(() =>
          client.bulkReview({ target: { kind: 'all' }, reviewed: false }),
        );
        const result = {
          layout: { repos: 30, worktreesPerRepo: 3, worktrees, changedFiles: cold.value.changed },
          ms: {
            listProjectsMedian: Math.round(median(projectsMs)),
            bulkAllCold: Math.round(cold.ms),
            undo: Math.round(undo.ms),
            inboxCold: Math.round(inboxCold.ms),
            inboxWarmMedian: Math.round(median(inboxWarm)),
            bulkAllWarm: Math.round(warm.ms),
            bulkAllClearWarm: Math.round(clear.ms),
          },
          counts: { cold: cold.value, warm: warm.value, clear: clear.value },
        };
        await writeJson(join(E2E_DIR, 'test-results', 'bulk-review-bench.json'), result);
        console.log(`[bulk-bench] ${JSON.stringify(result.layout)} ${JSON.stringify(result.ms)}`);
        test
          .info()
          .annotations.push({ type: 'bulk-bench', description: JSON.stringify(result.ms) });
        expect(cold.value.worktrees).toBe(worktrees);
        expect(cold.value.changed).toBe(warm.value.changed);
        expect(cold.ms).toBeLessThan(2000);
        expect(warm.ms).toBeLessThan(2000);
      } finally {
        await daemon.close();
      }
    } finally {
      await bench.cleanup();
    }
  });
});
