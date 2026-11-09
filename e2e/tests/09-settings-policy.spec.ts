/**
 * UX round 1 (COORDINATION §2.1, §2.3, acceptance UX-2 / UX-3 / UX-4): app settings and review
 * policy, driven over the API against the real daemon and the fixture repositories. No UI here:
 * the UI lands on the ux/web branch and the lead extends these specs after the merge.
 */
import { ApiClientError, type EffectiveReviewPolicy } from '@octopus-diff/contracts';
import { findProject, findWorktree } from '@octopus-diff/fixtures';
import { recordEvents } from '../support/api.js';
import type { TestDaemon } from '../support/daemon.js';
import { dirtyCheckouts, expect, registeredCheckouts, test } from '../support/test.js';

const ON_DEFAULT: EffectiveReviewPolicy = { enabled: true, source: 'default' };

async function policies(daemon: TestDaemon): Promise<Record<string, EffectiveReviewPolicy>> {
  const out: Record<string, EffectiveReviewPolicy> = {};
  for (const p of (await daemon.client.listProjects()).projects) {
    for (const w of p.worktrees) {
      if (!w.review) throw new Error(`no review policy on ${w.worktree.path}`);
      out[w.worktree.id] = w.review;
    }
  }
  return out;
}

async function scanRootId(daemon: TestDaemon): Promise<string> {
  const id = (await daemon.client.listScanRoots()).scanRoots[0]?.id;
  if (!id) throw new Error('fixture scan root not registered');
  return id;
}

test.describe('UX-2/3/4 settings and review policy (API)', () => {
  test('review is on by default for everything, settings start at revision 0', async ({
    manifest,
    daemon,
  }) => {
    const settings = await daemon.client.getSettings();
    expect(settings).toEqual({
      settings: { review: { defaultEnabled: true }, forges: { enabled: true, hosts: {} } },
      overrides: [],
      revision: 0,
    });
    const resolved = await policies(daemon);
    for (const { worktree } of registeredCheckouts(manifest)) {
      expect(resolved[worktree.id], worktree.name).toEqual(ON_DEFAULT);
    }
    const inbox = await daemon.client.inbox();
    expect(inbox.entries.length).toBeGreaterThan(0);
    for (const entry of inbox.entries) expect(entry.review).toEqual(ON_DEFAULT);
  });

  test('the default applies to everything without an override: off hides from onlyUnreviewed and bulk', async ({
    manifest,
    daemon,
  }) => {
    const events = await recordEvents(daemon.client);
    const off = await daemon.client.updateSettings({ review: { defaultEnabled: false } });
    expect(off.revision).toBe(1);
    expect(off.settings.review.defaultEnabled).toBe(false);
    await events.waitFor((e) => e.type === 'settings.changed' && e.revision === 1);

    const resolved = await policies(daemon);
    for (const { worktree } of registeredCheckouts(manifest)) {
      expect(resolved[worktree.id], worktree.name).toEqual({ enabled: false, source: 'default' });
    }
    expect((await daemon.client.inbox({ onlyUnreviewed: true })).entries).toEqual([]);
    // Changes stay visible and diffable (diff first).
    const visible = await daemon.client.inbox();
    expect(visible.entries.length).toBe(dirtyCheckouts(manifest).length);
    const bulk = await daemon.client.bulkReview({ target: { kind: 'all' } });
    expect(bulk.changed).toBe(0);
    expect(bulk.undoToken).toBeNull();
    expect(bulk.skippedDisabled.sort()).toEqual(
      dirtyCheckouts(manifest)
        .map(({ worktree }) => worktree.id)
        .sort(),
    );

    // Same value again: no new revision, no event.
    expect(
      (await daemon.client.updateSettings({ review: { defaultEnabled: false } })).revision,
    ).toBe(1);
    const on = await daemon.client.updateSettings({ review: { defaultEnabled: true } });
    expect(on.revision).toBe(2);
    await events.waitFor((e) => e.type === 'settings.changed' && e.revision === 2);
    expect(events.ofType('settings.changed').map((e) => e.revision)).toEqual([1, 2]);
    events.close();
  });

  test('precedence: worktree > branch > project > folder > default (detached worktrees skip branch)', async ({
    manifest,
    daemon,
  }) => {
    const root = await scanRootId(daemon);
    const live = findWorktree(manifest, 'live');
    const agent = findWorktree(manifest, 'live-agent');
    const beta = findProject(manifest, 'beta');
    const betaMain = findWorktree(manifest, 'beta').worktree;
    const betaDetached = findWorktree(manifest, 'beta-detached').worktree;
    const gamma = findProject(manifest, 'gamma');
    expect(betaDetached.detached).toBe(true);
    expect(agent.worktree.branch).toBe('agent/live');

    // folder: every project the scan root discovered, nothing else
    await daemon.client.setReviewPolicy({
      target: { kind: 'folder', scanRootId: root },
      enabled: false,
    });
    let p = await policies(daemon);
    for (const name of manifest.scanRoots[0]?.expectedProjects ?? []) {
      for (const w of findProject(manifest, name).worktrees) {
        expect(p[w.id], w.name).toEqual({ enabled: false, source: 'folder' });
      }
    }
    expect(p[live.worktree.id]).toEqual(ON_DEFAULT);

    // project beats folder
    await daemon.client.setReviewPolicy({
      target: { kind: 'project', projectId: gamma.id },
      enabled: true,
    });
    p = await policies(daemon);
    expect(p[findWorktree(manifest, 'gamma').worktree.id]).toEqual({
      enabled: true,
      source: 'project',
    });

    // branch beats project/folder; a detached worktree has no branch level
    await daemon.client.setReviewPolicy({
      target: { kind: 'branch', projectId: beta.id, branch: betaMain.branch ?? 'main' },
      enabled: true,
    });
    p = await policies(daemon);
    expect(p[betaMain.id]).toEqual({ enabled: true, source: 'branch' });
    expect(p[betaDetached.id]).toEqual({ enabled: false, source: 'folder' });

    // branch off for the agent's branch in the live project; worktree beats branch
    await daemon.client.setReviewPolicy({
      target: { kind: 'branch', projectId: live.project.id, branch: 'agent/live' },
      enabled: false,
    });
    p = await policies(daemon);
    expect(p[agent.worktree.id]).toEqual({ enabled: false, source: 'branch' });
    expect(p[live.worktree.id]).toEqual(ON_DEFAULT);
    const unreviewed = await daemon.client.inbox({ onlyUnreviewed: true });
    expect(unreviewed.entries.map((e) => e.worktree.id)).not.toContain(agent.worktree.id);
    expect(unreviewed.entries.map((e) => e.worktree.id)).toContain(live.worktree.id);
    const all = await daemon.client.inbox();
    expect(all.entries.find((e) => e.worktree.id === agent.worktree.id)?.review).toEqual({
      enabled: false,
      source: 'branch',
    });

    await daemon.client.setReviewPolicy({
      target: { kind: 'worktree', worktreeId: agent.worktree.id },
      enabled: true,
    });
    p = await policies(daemon);
    expect(p[agent.worktree.id]).toEqual({ enabled: true, source: 'worktree' });

    // null removes the override: inherit again
    const removed = await daemon.client.setReviewPolicy({
      target: { kind: 'worktree', worktreeId: agent.worktree.id },
      enabled: null,
    });
    expect(removed.overrides.map((o) => o.target.kind).sort()).toEqual([
      'branch',
      'branch',
      'folder',
      'project',
    ]);
    p = await policies(daemon);
    expect(p[agent.worktree.id]).toEqual({ enabled: false, source: 'branch' });
    expect((await daemon.client.getSettings()).revision).toBe(removed.revision);
  });

  test('targets must exist; a branch override may precede its branch', async ({
    manifest,
    daemon,
  }) => {
    const live = findProject(manifest, 'live');
    const unknown = '0123456789abcdef';
    for (const target of [
      { kind: 'project', projectId: unknown },
      { kind: 'worktree', worktreeId: unknown },
      { kind: 'folder', scanRootId: unknown },
      { kind: 'branch', projectId: unknown, branch: 'main' },
    ] as const) {
      await expect(
        daemon.client.setReviewPolicy({ target, enabled: false }),
        JSON.stringify(target),
      ).rejects.toMatchObject({ code: 'not_found', status: 404 });
    }
    const early = await daemon.client.setReviewPolicy({
      target: { kind: 'branch', projectId: live.id, branch: 'agent/not-created-yet' },
      enabled: false,
    });
    expect(early.overrides).toHaveLength(1);
    expect(early.revision).toBe(1);
    await expect(
      daemon.client.setReviewPolicy({
        target: { kind: 'branch', projectId: live.id, branch: '--not-a-ref' },
        enabled: false,
      }),
    ).rejects.toBeInstanceOf(ApiClientError);
  });

  test('settings, overrides and the revision survive a daemon restart', async ({
    manifest,
    daemon,
  }) => {
    const live = findWorktree(manifest, 'live');
    await daemon.client.updateSettings({ review: { defaultEnabled: false } });
    await daemon.client.setReviewPolicy({
      target: { kind: 'project', projectId: live.project.id },
      enabled: true,
    });
    await daemon.client.setReviewPolicy({
      target: { kind: 'worktree', worktreeId: live.worktree.id },
      enabled: false,
    });
    const before = await daemon.client.getSettings();
    expect(before.revision).toBe(3);

    await daemon.restart();
    await daemon.waitForProjects();
    const after = await daemon.client.getSettings();
    expect(after).toEqual(before);
    const p = await policies(daemon);
    expect(p[live.worktree.id]).toEqual({ enabled: false, source: 'worktree' });
    expect(p[findWorktree(manifest, 'live-agent').worktree.id]).toEqual({
      enabled: true,
      source: 'project',
    });
    expect(p[findWorktree(manifest, 'beta').worktree.id]).toEqual({
      enabled: false,
      source: 'default',
    });
    expect(
      (await daemon.client.updateSettings({ review: { defaultEnabled: true } })).revision,
    ).toBe(4);
  });

  test('removing a scan root or project deletes its overrides', async ({ manifest, daemon }) => {
    const root = await scanRootId(daemon);
    const gamma = findProject(manifest, 'gamma');
    const live = findWorktree(manifest, 'live');
    const events = await recordEvents(daemon.client);
    await daemon.client.setReviewPolicy({
      target: { kind: 'folder', scanRootId: root },
      enabled: false,
    });
    await daemon.client.setReviewPolicy({
      target: { kind: 'project', projectId: gamma.id },
      enabled: true,
    });
    await daemon.client.setReviewPolicy({
      target: { kind: 'worktree', worktreeId: live.worktree.id },
      enabled: false,
    });
    await daemon.client.setReviewPolicy({
      target: { kind: 'branch', projectId: live.project.id, branch: 'agent/live' },
      enabled: false,
    });
    expect((await daemon.client.getSettings()).overrides).toHaveLength(4);

    await daemon.client.removeProject(live.project.id);
    const afterProject = await daemon.client.getSettings();
    expect(afterProject.overrides.map((o) => o.target.kind).sort()).toEqual(['folder', 'project']);
    expect(afterProject.revision).toBe(5);
    await events.waitFor((e) => e.type === 'settings.changed' && e.revision === 5);

    await daemon.client.removeScanRoot(root);
    const afterRoot = await daemon.client.getSettings();
    expect(afterRoot.overrides).toEqual([]);
    // gamma's project override went with gamma, the folder override with the root.
    expect(afterRoot.revision).toBe(7);
    events.close();
  });
});
