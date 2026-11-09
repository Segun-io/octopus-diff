import path from 'node:path';
import {
  type ApiClient,
  ApiClientError,
  BulkReviewResponseSchema,
  type EffectiveReviewPolicy,
  InboxResponseSchema,
  ProjectsResponseSchema,
  SettingsResponseSchema,
  UndoReviewResponseSchema,
} from '@octopus-diff/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Daemon } from '../src/daemon.js';
import { FakeGitCore, type FakeRepo, fakeFile } from './fake-git-core.js';
import { client, errorOf, http, recordEvents, sleep, startTestDaemon, tempDir } from './helpers.js';

function expectApiError(promise: Promise<unknown>, code: string, status: number) {
  return expect(promise).rejects.toSatisfy((e: unknown) => {
    return e instanceof ApiClientError && e.code === code && e.status === status;
  });
}

const ON_DEFAULT: EffectiveReviewPolicy = { enabled: true, source: 'default' };

describe('UX round 1: settings, review policy, bulk review (fake git-core)', () => {
  let fake: FakeGitCore;
  let base: string;
  let stateDir: string;
  let daemon: Daemon;
  let api: ApiClient;
  let alpha: FakeRepo;
  let beta: FakeRepo;
  let now: Date;

  const mainOf = (repo: FakeRepo) => repo.worktrees[0]?.id ?? '';
  const linkedOf = (repo: FakeRepo) => repo.worktrees[1]?.id ?? '';

  /** Resolved policy per worktree id from GET /api/projects. */
  async function policies(): Promise<Record<string, EffectiveReviewPolicy | undefined>> {
    const { projects } = ProjectsResponseSchema.parse(await api.listProjects());
    const out: Record<string, EffectiveReviewPolicy | undefined> = {};
    for (const p of projects) for (const w of p.worktrees) out[w.worktree.id] = w.review;
    return out;
  }

  async function reviewedPaths(worktreeId: string): Promise<string[]> {
    return (await api.listFiles(worktreeId)).files.filter((f) => f.reviewed).map((f) => f.path);
  }

  beforeEach(async () => {
    fake = new FakeGitCore();
    base = await tempDir();
    stateDir = await tempDir();
    alpha = await fake.createRepo(base, 'alpha', { linked: ['feat'] });
    beta = await fake.createRepo(base, 'beta');
    now = new Date('2026-03-01T00:00:00.000Z');
    daemon = await startTestDaemon({ fake, stateDir, internal: { now: () => now } });
    api = client(daemon);
    // alpha/main: a.ts, b.ts; alpha/feat: a.ts (same patch as main) + c.ts; beta/main: d.ts
    fake.setFiles(mainOf(alpha), 'working', [fakeFile('a.ts'), fakeFile('b.ts')]);
    fake.setFiles(linkedOf(alpha), 'working', [fakeFile('a.ts'), fakeFile('c.ts')]);
    fake.setFiles(mainOf(beta), 'working', [fakeFile('d.ts')]);
    await api.addProject({ path: alpha.mainPath });
    await api.addProject({ path: beta.mainPath });
  });

  it('serves default settings, applies partial patches, and bumps the revision only on change', async () => {
    const events = recordEvents(daemon);
    await events.opened;
    const initial = SettingsResponseSchema.parse(await api.getSettings());
    expect(initial).toEqual({
      settings: { review: { defaultEnabled: true }, forges: { enabled: true, hosts: {} } },
      overrides: [],
      revision: 0,
    });

    const off = await api.updateSettings({ review: { defaultEnabled: false } });
    expect(off.settings.review.defaultEnabled).toBe(false);
    expect(off.revision).toBe(1);
    await events.waitFor((e) => e.type === 'settings.changed' && e.revision === 1);

    // Same value again and an empty patch: no change, no event.
    expect((await api.updateSettings({ review: { defaultEnabled: false } })).revision).toBe(1);
    expect((await api.updateSettings({})).revision).toBe(1);
    expect((await api.updateSettings({ review: {} })).revision).toBe(1);
    expect(events.events.filter((e) => e.type === 'settings.changed')).toHaveLength(1);

    const on = await api.updateSettings({ review: { defaultEnabled: true } });
    expect(on.revision).toBe(2);
    expect((await api.getSettings()).revision).toBe(2);

    for (const body of ['{"review":{"defaultEnabled":"yes"}}', '{"review":5}', '[]']) {
      const res = await http(daemon, '/api/settings', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body,
      });
      expect(res.status, body).toBe(400);
    }
  });

  it('resolves worktree > branch > project > folder > default and attaches `review` everywhere', async () => {
    const scanDir = path.join(base, 'scan');
    const gamma = await fake.createRepo(scanDir, 'gamma');
    fake.setFiles(mainOf(gamma), 'working', [fakeFile('g.ts')]);
    const { scanRoot } = await api.addScanRoot({ path: scanDir, depth: 1 });
    await daemon.core.waitForScan(scanRoot.id);

    expect(await policies()).toEqual({
      [mainOf(alpha)]: ON_DEFAULT,
      [linkedOf(alpha)]: ON_DEFAULT,
      [mainOf(beta)]: ON_DEFAULT,
      [mainOf(gamma)]: ON_DEFAULT,
    });
    const inbox = InboxResponseSchema.parse(await api.inbox());
    for (const entry of inbox.entries) expect(entry.review).toEqual(ON_DEFAULT);

    // project level
    const afterProject = SettingsResponseSchema.parse(
      await api.setReviewPolicy({
        target: { kind: 'project', projectId: alpha.projectId },
        enabled: false,
      }),
    );
    expect(afterProject.revision).toBe(1);
    expect(afterProject.overrides).toEqual([
      {
        target: { kind: 'project', projectId: alpha.projectId },
        enabled: false,
        updatedAt: now.toISOString(),
      },
    ]);
    let p = await policies();
    expect(p[mainOf(alpha)]).toEqual({ enabled: false, source: 'project' });
    expect(p[linkedOf(alpha)]).toEqual({ enabled: false, source: 'project' });
    expect(p[mainOf(beta)]).toEqual(ON_DEFAULT);

    // branch beats project; the branch is keyed by (project, short name)
    await api.setReviewPolicy({
      target: { kind: 'branch', projectId: alpha.projectId, branch: 'feat' },
      enabled: true,
    });
    p = await policies();
    expect(p[linkedOf(alpha)]).toEqual({ enabled: true, source: 'branch' });
    expect(p[mainOf(alpha)]).toEqual({ enabled: false, source: 'project' });

    // worktree beats branch
    await api.setReviewPolicy({
      target: { kind: 'worktree', worktreeId: linkedOf(alpha) },
      enabled: false,
    });
    p = await policies();
    expect(p[linkedOf(alpha)]).toEqual({ enabled: false, source: 'worktree' });

    // removing the override (null) inherits again
    const removed = await api.setReviewPolicy({
      target: { kind: 'worktree', worktreeId: linkedOf(alpha) },
      enabled: null,
    });
    expect(removed.overrides.map((o) => o.target.kind).sort()).toEqual(['branch', 'project']);
    p = await policies();
    expect(p[linkedOf(alpha)]).toEqual({ enabled: true, source: 'branch' });
    // removing it again is a no-op (same revision)
    const again = await api.setReviewPolicy({
      target: { kind: 'worktree', worktreeId: linkedOf(alpha) },
      enabled: null,
    });
    expect(again.revision).toBe(removed.revision);

    // folder (scan root) applies to the projects it discovered; project beats folder
    await api.setReviewPolicy({
      target: { kind: 'folder', scanRootId: scanRoot.id },
      enabled: false,
    });
    p = await policies();
    expect(p[mainOf(gamma)]).toEqual({ enabled: false, source: 'folder' });
    expect(p[mainOf(beta)]).toEqual(ON_DEFAULT);
    await api.setReviewPolicy({
      target: { kind: 'project', projectId: gamma.projectId },
      enabled: true,
    });
    expect((await policies())[mainOf(gamma)]).toEqual({ enabled: true, source: 'project' });

    // the default applies to everything without an override or overridden ancestor
    await api.updateSettings({ review: { defaultEnabled: false } });
    p = await policies();
    expect(p[mainOf(beta)]).toEqual({ enabled: false, source: 'default' });
    expect(p[mainOf(gamma)]).toEqual({ enabled: true, source: 'project' });

    // inbox entries carry the same policy
    const entries = (await api.inbox()).entries;
    expect(entries.find((e) => e.worktree.id === mainOf(beta))?.review).toEqual({
      enabled: false,
      source: 'default',
    });
    expect(entries.find((e) => e.worktree.id === linkedOf(alpha))?.review).toEqual({
      enabled: true,
      source: 'branch',
    });
  });

  it('omits review-disabled worktrees from onlyUnreviewed but keeps them listed otherwise', async () => {
    const all = await api.inbox();
    expect(all.entries.map((e) => e.worktree.id).sort()).toEqual(
      [mainOf(alpha), linkedOf(alpha), mainOf(beta)].sort(),
    );
    await api.setReviewPolicy({
      target: { kind: 'worktree', worktreeId: linkedOf(alpha) },
      enabled: false,
    });
    const unreviewed = await api.inbox({ onlyUnreviewed: true });
    expect(unreviewed.entries.map((e) => e.worktree.id).sort()).toEqual(
      [mainOf(alpha), mainOf(beta)].sort(),
    );
    const listed = await api.inbox();
    const feat = listed.entries.find((e) => e.worktree.id === linkedOf(alpha));
    expect(feat?.review).toEqual({ enabled: false, source: 'worktree' });
    expect(feat?.files).toHaveLength(2);
    // Files of a disabled worktree stay diffable.
    expect((await api.listFiles(linkedOf(alpha))).files).toHaveLength(2);
    await expect(api.getDiff(linkedOf(alpha), { path: 'c.ts' })).resolves.toBeTruthy();
  });

  it('requires policy targets to exist (a branch needs only its project) and validates bodies', async () => {
    await expectApiError(
      api.setReviewPolicy({
        target: { kind: 'project', projectId: '0000000000000000' },
        enabled: false,
      }),
      'not_found',
      404,
    );
    await expectApiError(
      api.setReviewPolicy({
        target: { kind: 'worktree', worktreeId: '0000000000000000' },
        enabled: false,
      }),
      'not_found',
      404,
    );
    await expectApiError(
      api.setReviewPolicy({
        target: { kind: 'folder', scanRootId: '0000000000000000' },
        enabled: false,
      }),
      'not_found',
      404,
    );
    await expectApiError(
      api.setReviewPolicy({
        target: { kind: 'branch', projectId: '0000000000000000', branch: 'x' },
        enabled: false,
      }),
      'not_found',
      404,
    );
    const future = await api.setReviewPolicy({
      target: { kind: 'branch', projectId: alpha.projectId, branch: 'agent/not-yet-created' },
      enabled: false,
    });
    expect(future.overrides).toHaveLength(1);
    expect((await api.getSettings()).revision).toBe(1);

    for (const body of [
      { target: { kind: 'project', projectId: alpha.projectId } },
      { target: { kind: 'project', projectId: alpha.projectId }, enabled: 'off' },
      { target: { kind: 'branch', projectId: alpha.projectId, branch: '--evil' }, enabled: false },
      { target: { kind: 'nope' }, enabled: false },
      { target: { kind: 'worktree', worktreeId: 'short' }, enabled: false },
    ]) {
      const res = await http(daemon, '/api/review-policy', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await errorOf(res)).code).toBe('bad_request');
    }
  });

  it('marks a worktree, a project, a folder and everything; counts per project; undoes exactly that', async () => {
    const events = recordEvents(daemon);
    await events.opened;

    const wt = BulkReviewResponseSchema.parse(
      await api.bulkReview({ target: { kind: 'worktree', worktreeId: mainOf(alpha) } }),
    );
    expect(wt).toMatchObject({
      ok: true,
      reviewed: true,
      changed: 2,
      unchanged: 0,
      worktrees: 1,
      skippedDisabled: [],
      stale: [],
    });
    expect(wt.undoToken).toEqual(expect.any(String));
    const bulkEvent = await events.waitFor((e) => e.type === 'review.bulk');
    expect(bulkEvent).toEqual({
      type: 'review.bulk',
      projectIds: [alpha.projectId],
      reviewed: true,
      changed: 2,
    });
    expect(events.events.filter((e) => e.type === 'review.changed')).toHaveLength(0);
    expect(await reviewedPaths(mainOf(alpha))).toEqual(['a.ts', 'b.ts']);
    // Marks are per project: the identical a.ts patch in the linked worktree is reviewed too.
    expect(await reviewedPaths(linkedOf(alpha))).toEqual(['a.ts']);

    const project = await api.bulkReview({
      target: { kind: 'project', projectId: alpha.projectId },
    });
    expect(project).toMatchObject({ changed: 1, unchanged: 2, worktrees: 2 });
    expect(await reviewedPaths(linkedOf(alpha))).toEqual(['a.ts', 'c.ts']);

    const all = await api.bulkReview({ target: { kind: 'all' } });
    expect(all).toMatchObject({ changed: 1, unchanged: 3, worktrees: 3 });
    expect(await reviewedPaths(mainOf(beta))).toEqual(['d.ts']);

    // Nothing left to do: no token, no event.
    const eventsBefore = events.events.length;
    const noop = await api.bulkReview({ target: { kind: 'all' } });
    expect(noop).toMatchObject({ changed: 0, unchanged: 4, worktrees: 3, undoToken: null });
    await sleep(50);
    expect(events.events.length).toBe(eventsBefore);

    // Undo the "all" call: only beta's mark came from it.
    if (!all.undoToken) throw new Error('expected an undo token');
    const undone = UndoReviewResponseSchema.parse(
      await api.undoReview({ undoToken: all.undoToken }),
    );
    expect(undone).toEqual({ ok: true, restored: 1 });
    expect(await reviewedPaths(mainOf(beta))).toEqual([]);
    expect(await reviewedPaths(mainOf(alpha))).toEqual(['a.ts', 'b.ts']);
    await events.waitFor(
      (e) => e.type === 'review.bulk' && e.reviewed === false && e.changed === 1,
    );
    // Single use.
    await expectApiError(api.undoReview({ undoToken: all.undoToken }), 'not_found', 404);

    // Mark all unreviewed, then undo that.
    const clear = await api.bulkReview({ target: { kind: 'all' }, reviewed: false });
    expect(clear).toMatchObject({ reviewed: false, changed: 3, unchanged: 1, worktrees: 3 });
    expect(await reviewedPaths(mainOf(alpha))).toEqual([]);
    expect(await reviewedPaths(linkedOf(alpha))).toEqual([]);
    if (!clear.undoToken) throw new Error('expected an undo token');
    expect(await api.undoReview({ undoToken: clear.undoToken })).toEqual({ ok: true, restored: 3 });
    expect(await reviewedPaths(mainOf(alpha))).toEqual(['a.ts', 'b.ts']);
    expect(await reviewedPaths(linkedOf(alpha))).toEqual(['a.ts', 'c.ts']);

    // Folder target: the scan root's projects only.
    const scanDir = path.join(base, 'scan');
    const gamma = await fake.createRepo(scanDir, 'gamma');
    fake.setFiles(mainOf(gamma), 'working', [fakeFile('g.ts'), fakeFile('h.ts')]);
    const { scanRoot } = await api.addScanRoot({ path: scanDir, depth: 1 });
    await daemon.core.waitForScan(scanRoot.id);
    const folder = await api.bulkReview({ target: { kind: 'folder', scanRootId: scanRoot.id } });
    expect(folder).toMatchObject({ changed: 2, unchanged: 0, worktrees: 1 });
    expect(await reviewedPaths(mainOf(beta))).toEqual([]);
  });

  it('restricts to paths (worktree only), skips stale and review-disabled worktrees', async () => {
    const withPathsOnProject = await http(daemon, '/api/review/bulk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        target: { kind: 'project', projectId: alpha.projectId },
        paths: [{ path: 'a.ts' }],
      }),
    });
    expect(withPathsOnProject.status).toBe(400);
    expect((await errorOf(withPathsOnProject)).message).toMatch(/paths/);

    const some = await api.bulkReview({
      target: { kind: 'worktree', worktreeId: mainOf(alpha) },
      paths: [{ path: 'a.ts' }, { path: 'not-changed.ts' }],
    });
    expect(some).toMatchObject({ changed: 1, unchanged: 0, worktrees: 1 });
    expect(await reviewedPaths(mainOf(alpha))).toEqual(['a.ts']);

    // Stale: the user looked at a state that is gone.
    const { projects } = await api.listProjects();
    const current =
      projects.flatMap((p) => p.worktrees).find((w) => w.worktree.id === mainOf(beta))?.summary
        ?.stateHash ?? '';
    const stale = await api.bulkReview({
      target: { kind: 'all' },
      expectedStateHashes: { [mainOf(beta)]: 'not-the-current-hash' },
    });
    expect(stale.stale).toEqual([mainOf(beta)]);
    expect(stale).toMatchObject({ changed: 2, worktrees: 2 });
    expect(await reviewedPaths(mainOf(beta))).toEqual([]);
    const fresh = await api.bulkReview({
      target: { kind: 'worktree', worktreeId: mainOf(beta) },
      expectedStateHashes: { [mainOf(beta)]: current },
    });
    expect(fresh).toMatchObject({ changed: 1, stale: [], undoToken: expect.any(String) });

    // Disabled worktrees are skipped unless includeDisabled.
    await api.bulkReview({ target: { kind: 'all' }, reviewed: false });
    await api.setReviewPolicy({
      target: { kind: 'worktree', worktreeId: linkedOf(alpha) },
      enabled: false,
    });
    const skipped = await api.bulkReview({
      target: { kind: 'project', projectId: alpha.projectId },
    });
    expect(skipped).toMatchObject({ changed: 2, worktrees: 1, skippedDisabled: [linkedOf(alpha)] });
    expect(await reviewedPaths(linkedOf(alpha))).toEqual(['a.ts']); // shared patch with main
    const forced = await api.bulkReview({
      target: { kind: 'project', projectId: alpha.projectId },
      includeDisabled: true,
    });
    expect(forced).toMatchObject({ changed: 1, unchanged: 2, worktrees: 2, skippedDisabled: [] });
    expect(await reviewedPaths(linkedOf(alpha))).toEqual(['a.ts', 'c.ts']);

    // With the default off, everything without an override is skipped.
    await api.updateSettings({ review: { defaultEnabled: false } });
    const offEverywhere = await api.bulkReview({ target: { kind: 'all' }, reviewed: false });
    expect(offEverywhere.skippedDisabled.sort()).toEqual(
      [mainOf(alpha), linkedOf(alpha), mainOf(beta)].sort(),
    );
    expect(offEverywhere).toMatchObject({ changed: 0, worktrees: 0, undoToken: null });
    expect((await api.inbox({ onlyUnreviewed: true })).entries).toEqual([]);
  });

  it('undo leaves marks that changed again since the bulk call alone', async () => {
    const marked = await api.bulkReview({
      target: { kind: 'worktree', worktreeId: mainOf(alpha) },
    });
    if (!marked.undoToken) throw new Error('token');
    const a = (await api.listFiles(mainOf(alpha))).files.find((f) => f.path === 'a.ts');
    if (!a) throw new Error('a.ts');
    // Later, the user unmarks a.ts and marks it again by hand (a newer mark).
    now = new Date(now.getTime() + 60_000);
    const key = {
      projectId: alpha.projectId,
      scopeKind: 'working' as const,
      path: 'a.ts',
      patchHash: a.patchHash,
    };
    await api.setReview({ ...key, reviewed: false });
    await api.setReview({ ...key, reviewed: true });
    expect(await api.undoReview({ undoToken: marked.undoToken })).toEqual({
      ok: true,
      restored: 1,
    });
    expect(await reviewedPaths(mainOf(alpha))).toEqual(['a.ts']);

    // The inverse: bulk-unmark, the user re-marks b.ts, undo restores only a.ts.
    await api.bulkReview({ target: { kind: 'worktree', worktreeId: mainOf(alpha) } });
    const cleared = await api.bulkReview({
      target: { kind: 'worktree', worktreeId: mainOf(alpha) },
      reviewed: false,
    });
    if (!cleared.undoToken) throw new Error('token');
    expect(cleared.changed).toBe(2);
    const b = (await api.listFiles(mainOf(alpha))).files.find((f) => f.path === 'b.ts');
    if (!b) throw new Error('b.ts');
    await api.setReview({ ...key, path: 'b.ts', patchHash: b.patchHash, reviewed: true });
    expect(await api.undoReview({ undoToken: cleared.undoToken })).toEqual({
      ok: true,
      restored: 1,
    });
    expect(await reviewedPaths(mainOf(alpha))).toEqual(['a.ts', 'b.ts']);
  });

  it('reports a worktree that changes while the bulk call runs as stale (never marks an unseen state)', async () => {
    const wt = mainOf(beta);
    const before = (await api.refreshWorktree(wt)).summary.stateHash;
    fake.methodDelay.set('listChangedFiles', 300);
    const pending = api.bulkReview({
      target: { kind: 'worktree', worktreeId: wt },
      expectedStateHashes: { [wt]: before },
    });
    await sleep(60);
    // The agent writes while the file list is being computed.
    fake.setFiles(wt, 'working', [fakeFile('d.ts', { patchHash: 'v2:d.ts' }), fakeFile('e.ts')]);
    const after = (await api.refreshWorktree(wt)).summary.stateHash;
    expect(after).not.toBe(before);
    const result = await pending;
    expect(result).toMatchObject({ changed: 0, worktrees: 0, stale: [wt], undoToken: null });
    fake.methodDelay.delete('listChangedFiles');
    expect(await reviewedPaths(wt)).toEqual([]);
    expect(daemon.store.countReviewMarks()).toBe(0);
  });

  it('persists settings, overrides and the revision across restarts; undo tokens do not survive', async () => {
    await api.updateSettings({ review: { defaultEnabled: false } });
    await api.setReviewPolicy({
      target: { kind: 'project', projectId: alpha.projectId },
      enabled: true,
    });
    await api.setReviewPolicy({
      target: { kind: 'branch', projectId: alpha.projectId, branch: 'feat' },
      enabled: false,
    });
    const before = await api.getSettings();
    expect(before.revision).toBe(3);
    const bulk = await api.bulkReview({ target: { kind: 'all' } });
    expect(bulk.changed).toBe(2); // alpha/main only: feat is off (branch), beta is off (default)
    if (!bulk.undoToken) throw new Error('token');
    await daemon.close();

    daemon = await startTestDaemon({ fake, stateDir, internal: { now: () => now } });
    api = client(daemon);
    const after = SettingsResponseSchema.parse(await api.getSettings());
    expect(after).toEqual(before);
    expect((await policies())[mainOf(alpha)]).toEqual({ enabled: true, source: 'project' });
    expect((await policies())[linkedOf(alpha)]).toEqual({ enabled: false, source: 'branch' });
    expect((await policies())[mainOf(beta)]).toEqual({ enabled: false, source: 'default' });
    expect(await reviewedPaths(mainOf(alpha))).toEqual(['a.ts', 'b.ts']);
    await expectApiError(api.undoReview({ undoToken: bulk.undoToken }), 'not_found', 404);
    // The revision keeps increasing from the persisted value.
    expect((await api.updateSettings({ review: { defaultEnabled: true } })).revision).toBe(4);
  });

  it('deletes the overrides of a removed project or scan root and bumps the revision', async () => {
    const events = recordEvents(daemon);
    await events.opened;
    const scanDir = path.join(base, 'scan');
    const gamma = await fake.createRepo(scanDir, 'gamma');
    const { scanRoot } = await api.addScanRoot({ path: scanDir, depth: 1 });
    await daemon.core.waitForScan(scanRoot.id);

    await api.setReviewPolicy({
      target: { kind: 'project', projectId: alpha.projectId },
      enabled: false,
    });
    await api.setReviewPolicy({
      target: { kind: 'branch', projectId: alpha.projectId, branch: 'feat' },
      enabled: true,
    });
    await api.setReviewPolicy({
      target: { kind: 'worktree', worktreeId: mainOf(alpha) },
      enabled: true,
    });
    await api.setReviewPolicy({
      target: { kind: 'project', projectId: beta.projectId },
      enabled: false,
    });
    await api.setReviewPolicy({
      target: { kind: 'folder', scanRootId: scanRoot.id },
      enabled: false,
    });
    await api.setReviewPolicy({
      target: { kind: 'project', projectId: gamma.projectId },
      enabled: true,
    });
    expect((await api.getSettings()).overrides).toHaveLength(6);
    const revision = (await api.getSettings()).revision;

    await api.removeProject(alpha.projectId);
    const afterProject = await api.getSettings();
    const byKey = (a: { kind: string }, b: { kind: string }) =>
      JSON.stringify(a) < JSON.stringify(b) ? -1 : 1;
    expect(afterProject.overrides.map((o) => o.target).sort(byKey)).toEqual(
      [
        { kind: 'folder', scanRootId: scanRoot.id },
        { kind: 'project', projectId: beta.projectId },
        { kind: 'project', projectId: gamma.projectId },
      ].sort(byKey),
    );
    expect(afterProject.revision).toBe(revision + 1);
    await events.waitFor((e) => e.type === 'settings.changed' && e.revision === revision + 1);

    await api.removeScanRoot(scanRoot.id);
    const afterRoot = await api.getSettings();
    expect(afterRoot.overrides.map((o) => o.target)).toEqual([
      { kind: 'project', projectId: beta.projectId },
    ]);
    // gamma's project override went with the project, the folder override with the root.
    expect(afterRoot.revision).toBe(revision + 3);

    // A project without overrides: removing it changes nothing.
    await api.addProject({ path: alpha.mainPath });
    await api.removeProject(alpha.projectId);
    expect((await api.getSettings()).revision).toBe(revision + 3);
  });

  it('validates bulk and undo input and maps unknown targets to not_found', async () => {
    await expectApiError(
      api.bulkReview({ target: { kind: 'project', projectId: '0000000000000000' } }),
      'not_found',
      404,
    );
    await expectApiError(
      api.bulkReview({ target: { kind: 'folder', scanRootId: '0000000000000000' } }),
      'not_found',
      404,
    );
    await expectApiError(
      api.bulkReview({ target: { kind: 'worktree', worktreeId: '0000000000000000' } }),
      'not_found',
      404,
    );
    await expectApiError(api.undoReview({ undoToken: 'nope' }), 'not_found', 404);
    for (const body of [
      {},
      { target: { kind: 'everything' } },
      { target: { kind: 'all' }, scope: { kind: 'commit' } },
      { target: { kind: 'all' }, reviewed: 'yes' },
      { target: { kind: 'all' }, expectedStateHashes: { 'not-an-id': 'x' } },
      {
        target: { kind: 'worktree', worktreeId: mainOf(alpha) },
        paths: [{ path: '../etc/passwd' }],
      },
    ]) {
      const res = await http(daemon, '/api/review/bulk', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const emptyToken = await http(daemon, '/api/review/undo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ undoToken: '' }),
    });
    expect(emptyToken.status).toBe(400);
  });

  it('bulk-marks staged and branch scopes; a mark covers the same patch in every scope', async () => {
    const wt = mainOf(alpha);
    // The summary counts (from the working list) drive the staged prefilter, as in the inbox.
    fake.setFiles(wt, 'working', [
      fakeFile('a.ts', { staged: true, unstaged: false }),
      fakeFile('b.ts'),
    ]);
    fake.setFiles(wt, 'staged', [fakeFile('a.ts', { staged: true, unstaged: false })]);
    fake.setFiles(wt, 'branch', [fakeFile('a.ts'), fakeFile('z.ts')]);
    await api.refreshWorktree(wt);
    const staged = await api.bulkReview({
      target: { kind: 'worktree', worktreeId: wt },
      scope: { kind: 'staged' },
    });
    expect(staged).toMatchObject({ changed: 1, worktrees: 1 });
    expect((await api.listFiles(wt, { scope: { kind: 'staged' } })).files[0]?.reviewed).toBe(true);
    // The fake's a.ts has the same patch hash in every scope: reviewed in `working` too.
    expect(await reviewedPaths(wt)).toEqual(['a.ts']);
    const branch = await api.bulkReview({ target: { kind: 'all' }, scope: { kind: 'branch' } });
    expect(branch).toMatchObject({ changed: 1, unchanged: 1 });
    expect(
      (await api.listFiles(wt, { scope: { kind: 'branch' } })).files.map((f) => f.reviewed),
    ).toEqual([true, true]);
    expect(await reviewedPaths(wt)).toEqual(['a.ts']);
  });

  it('never spawns git per file: one (cached) file list per worktree for `all`', async () => {
    await api.inbox();
    const calls = fake.callCount('listChangedFiles');
    const result = await api.bulkReview({ target: { kind: 'all' } });
    expect(result.changed).toBe(4);
    // The inbox already listed every dirty worktree at this stateHash: nothing to recompute.
    expect(fake.callCount('listChangedFiles')).toBe(calls);
    await api.bulkReview({ target: { kind: 'all' }, reviewed: false });
    fake.bump(mainOf(alpha));
    await api.refreshWorktree(mainOf(alpha));
    const before = fake.callCount('listChangedFiles');
    await api.bulkReview({ target: { kind: 'all' } });
    expect(fake.callCount('listChangedFiles')).toBe(before + 1);
  });
});
