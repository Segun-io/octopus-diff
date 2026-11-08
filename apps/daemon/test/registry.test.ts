import { rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { ApiClientError, ScanRootsResponseSchema } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { hashId } from '../src/ids.js';
import { FakeGitCore, fakeFile } from './fake-git-core.js';
import { client, eventually, recordEvents, startTestDaemon, tempDir } from './helpers.js';

describe('registry: scan roots', () => {
  it('scans in the background, emits scan.progress, and registers found projects', async () => {
    const fake = new FakeGitCore();
    const base = await tempDir();
    const root = path.join(base, 'code');
    const a = await fake.createRepo(root, 'a', { linked: ['wt'] });
    const b = await fake.createRepo(path.join(root, 'nested'), 'b');
    const deep = await fake.createRepo(path.join(root, 'x', 'y', 'z'), 'deep');
    const daemon = await startTestDaemon({ fake, stateDir: await tempDir() });
    const api = client(daemon);
    const events = recordEvents(daemon);
    await events.opened;

    const added = await api.addScanRoot({ path: root, depth: 2 });
    expect(added.created).toBe(true);
    expect(added.scanRoot.id).toBe(hashId(fake.repos[0] ? path.dirname(a.mainPath) : root));
    expect(added.scanRoot.depth).toBe(2);
    const done = await events.waitFor((e) => e.type === 'scan.progress' && e.state === 'done');
    expect(done).toMatchObject({ scanRootId: added.scanRoot.id, foundRepos: 2, message: null });
    expect(events.events.some((e) => e.type === 'scan.progress' && e.state === 'scanning')).toBe(
      true,
    );

    const projects = await api.listProjects();
    expect(projects.projects.map((p) => p.project.name).sort()).toEqual(['a', 'b']);
    for (const p of projects.projects) expect(p.project.scanRootId).toBe(added.scanRoot.id);
    expect(projects.projects.some((p) => p.project.id === deep.projectId)).toBe(false);

    const roots = ScanRootsResponseSchema.parse(await api.listScanRoots());
    expect(roots.scanRoots).toHaveLength(1);
    expect(roots.scanRoots[0]?.projectCount).toBe(2);
    expect(roots.scanRoots[0]?.lastScannedAt).not.toBeNull();

    // Idempotent: same root, deeper scan finds the deep repo.
    const again = await api.addScanRoot({ path: root, depth: 4 });
    expect(again.created).toBe(false);
    await daemon.core.waitForScan(added.scanRoot.id);
    expect((await api.listProjects()).projects.map((p) => p.project.name).sort()).toEqual([
      'a',
      'b',
      'deep',
    ]);
    expect(b.projectId).toBeTruthy();
  });

  it('rescans, and does not re-add projects the user removed', async () => {
    const fake = new FakeGitCore();
    const root = await tempDir();
    const a = await fake.createRepo(root, 'a');
    const daemon = await startTestDaemon({ fake, stateDir: await tempDir() });
    const api = client(daemon);
    const { scanRoot } = await api.addScanRoot({ path: root });
    await daemon.core.waitForScan(scanRoot.id);
    expect((await api.listProjects()).projects).toHaveLength(1);

    const later = await fake.createRepo(root, 'later');
    await api.removeProject(a.projectId);
    const rescanned = await api.rescanScanRoot(scanRoot.id);
    expect(rescanned.scanRoot.id).toBe(scanRoot.id);
    await daemon.core.waitForScan(scanRoot.id);
    const names = (await api.listProjects()).projects.map((p) => p.project.name);
    expect(names).toEqual(['later']);
    expect(later.projectId).toBeTruthy();

    // Adding it explicitly brings it back (and detaches it from the scan root).
    const readded = await api.addProject({ path: a.mainPath });
    expect(readded.project.project.scanRootId).toBeNull();
  });

  it('removing a scan root removes the projects it discovered, not explicit ones', async () => {
    const fake = new FakeGitCore();
    const root = await tempDir();
    const a = await fake.createRepo(root, 'a');
    const b = await fake.createRepo(root, 'b');
    const daemon = await startTestDaemon({ fake, stateDir: await tempDir() });
    const api = client(daemon);
    await api.addProject({ path: b.mainPath });
    const { scanRoot } = await api.addScanRoot({ path: root });
    await daemon.core.waitForScan(scanRoot.id);
    const projects = await api.listProjects();
    expect(projects.projects.find((p) => p.project.id === a.projectId)?.project.scanRootId).toBe(
      scanRoot.id,
    );
    expect(
      projects.projects.find((p) => p.project.id === b.projectId)?.project.scanRootId,
    ).toBeNull();

    const events = recordEvents(daemon);
    await events.opened;
    await expect(api.removeScanRoot(scanRoot.id)).resolves.toEqual({ ok: true });
    await events.waitFor((e) => e.type === 'project.removed' && e.projectId === a.projectId);
    expect((await api.listProjects()).projects.map((p) => p.project.id)).toEqual([b.projectId]);
    expect((await api.listScanRoots()).scanRoots).toEqual([]);
    await expect(api.removeScanRoot(scanRoot.id)).rejects.toBeInstanceOf(ApiClientError);
    await expect(api.rescanScanRoot(scanRoot.id)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('reports scan failures as scan.progress errors', async () => {
    const fake = new FakeGitCore();
    const root = await tempDir();
    fake.fail('scan', 'timeout', 'scan timed out');
    const daemon = await startTestDaemon({ fake, stateDir: await tempDir() });
    const events = recordEvents(daemon);
    await events.opened;
    await client(daemon).addScanRoot({ path: root });
    const error = await events.waitFor((e) => e.type === 'scan.progress' && e.state === 'error');
    expect(error).toMatchObject({ message: 'scan timed out' });
  });

  it('rejects scan roots that do not exist or have invalid depth', async () => {
    const daemon = await startTestDaemon({ fake: new FakeGitCore(), stateDir: await tempDir() });
    const api = client(daemon);
    await expect(api.addScanRoot({ path: '/definitely/not/here' })).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    await expect(api.addScanRoot({ path: '/tmp', depth: 99 })).rejects.toMatchObject({
      code: 'bad_request',
      status: 400,
    });
  });
});

describe('registry: persistence and reconciliation', () => {
  it('restart preserves the registry, overrides, scan roots and review marks', async () => {
    const fake = new FakeGitCore();
    const base = await tempDir();
    const stateDir = await tempDir();
    const a = await fake.createRepo(base, 'a', { linked: ['wt'] });
    const wt = a.worktrees[0]?.id ?? '';
    fake.setFiles(wt, 'working', [fakeFile('x.ts'), fakeFile('y.ts')]);

    const first = await startTestDaemon({ fake, stateDir });
    const api1 = client(first);
    await api1.addProject({ path: a.mainPath });
    await api1.updateProject(a.projectId, { defaultBranchOverride: 'trunk' });
    const scanRoot = await api1
      .addScanRoot({ path: path.join(base, 'empty-root-does-not-exist') })
      .catch(() => null);
    expect(scanRoot).toBeNull();
    const sr = await api1.addScanRoot({ path: base, depth: 1 });
    await first.core.waitForScan(sr.scanRoot.id);
    const x = (await api1.listFiles(wt)).files[0];
    if (!x) throw new Error('missing');
    await api1.setReview({
      projectId: a.projectId,
      scopeKind: 'working',
      path: 'x.ts',
      patchHash: x.patchHash,
      reviewed: true,
    });
    const token = first.token;
    await first.close();

    const second = await startTestDaemon({ fake, stateDir, token: undefined });
    expect(second.token).not.toBe(token); // explicit test token vs file token
    const api2 = client(second);
    const projects = await api2.listProjects();
    expect(projects.projects).toHaveLength(1);
    expect(projects.projects[0]?.project).toMatchObject({
      id: a.projectId,
      defaultBranch: 'trunk',
      defaultBranchOverride: 'trunk',
    });
    expect(projects.projects[0]?.worktrees).toHaveLength(2);
    expect((await api2.listScanRoots()).scanRoots.map((s) => s.id)).toEqual([sr.scanRoot.id]);
    expect((await api2.listFiles(wt)).files.map((f) => [f.path, f.reviewed])).toEqual([
      ['x.ts', true],
      ['y.ts', false],
    ]);
  });

  it('persists the generated token in <stateDir>/token across restarts', async () => {
    const stateDir = await tempDir();
    const fake = new FakeGitCore();
    const d1 = await startTestDaemon({ fake, stateDir, token: undefined });
    const t1 = d1.token;
    await d1.close();
    const d2 = await startTestDaemon({ fake, stateDir, token: undefined });
    expect(d2.token).toBe(t1);
    expect(t1).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('reports projects whose paths vanished as missing (not deleted) and recovers them', async () => {
    const fake = new FakeGitCore();
    const base = await tempDir();
    const stateDir = await tempDir();
    const a = await fake.createRepo(base, 'a');
    const b = await fake.createRepo(base, 'b');
    const first = await startTestDaemon({ fake, stateDir });
    await client(first).addProject({ path: a.mainPath });
    await client(first).addProject({ path: b.mainPath });
    await first.close();

    const parked = path.join(base, 'parked');
    await rename(a.mainPath, parked);
    const second = await startTestDaemon({ fake, stateDir, internal: { relistMs: 100 } });
    const api = client(second);
    const missing = await eventually(async () => {
      const list = await api.listProjects();
      const item = list.projects.find((p) => p.project.id === a.projectId);
      return item?.worktrees[0]?.worktree.missing ? item : null;
    });
    expect(missing.worktrees[0]?.summary).toBeNull();
    expect(missing.worktrees[0]?.error?.code).toBe('not_found');
    const other = (await api.listProjects()).projects.find((p) => p.project.id === b.projectId);
    expect(other?.worktrees[0]?.worktree.missing).toBe(false);
    expect(other?.worktrees[0]?.summary).not.toBeNull();
    const inbox = await api.inbox();
    expect(inbox.entries.every((e) => e.project.id !== a.projectId)).toBe(true);

    // The repository comes back: the retry timer restores it.
    await rename(parked, a.mainPath);
    await eventually(async () => {
      const item = (await api.listProjects()).projects.find((p) => p.project.id === a.projectId);
      return item?.worktrees[0]?.worktree.missing === false && item.worktrees[0].summary !== null;
    });
  });

  it('detects worktrees added and removed (relist on git-dir changes and on a timer)', async () => {
    const fake = new FakeGitCore();
    const base = await tempDir();
    const a = await fake.createRepo(base, 'a');
    const daemon = await startTestDaemon({
      fake,
      stateDir: await tempDir(),
      internal: { relistMs: 150 },
    });
    const api = client(daemon);
    await api.addProject({ path: a.mainPath });
    const events = recordEvents(daemon);
    await events.opened;

    const wt = await fake.addLinkedWorktree(a, 'agent-1');
    const added = await events.waitFor(
      (e) => e.type === 'worktree.added' && e.worktreeId === wt.id,
    );
    expect(added).toMatchObject({ projectId: a.projectId });
    await eventually(async () => (await api.listProjects()).projects[0]?.worktrees.length === 2);

    fake.removeWorktree(a, wt.id);
    await rm(wt.gitDir, { recursive: true, force: true });
    await events.waitFor((e) => e.type === 'worktree.removed' && e.worktreeId === wt.id);
    expect((await api.listProjects()).projects[0]?.worktrees).toHaveLength(1);
  });

  it('registers projects and scan roots passed as startup options (idempotent)', async () => {
    const fake = new FakeGitCore();
    const base = await tempDir();
    const stateDir = await tempDir();
    const a = await fake.createRepo(base, 'a');
    const root = path.join(base, 'root');
    const b = await fake.createRepo(root, 'b');
    const opts = {
      fake,
      stateDir,
      projects: [a.mainPath, path.join(base, 'missing')],
      scanRoots: [{ path: root }],
    };
    const d1 = await startTestDaemon(opts);
    const sr = (await client(d1).listScanRoots()).scanRoots[0];
    if (!sr) throw new Error('no scan root');
    await d1.core.waitForScan(sr.id);
    expect((await client(d1).listProjects()).projects.map((p) => p.project.id).sort()).toEqual(
      [a.projectId, b.projectId].sort(),
    );
    await d1.close();
    const d2 = await startTestDaemon(opts);
    expect((await client(d2).listProjects()).projects).toHaveLength(2);
    expect((await client(d2).listScanRoots()).scanRoots).toHaveLength(1);
  });
});

describe('review mark GC', () => {
  it('deletes marks of removed projects and marks unseen for 30 days', async () => {
    const fake = new FakeGitCore();
    const base = await tempDir();
    const stateDir = await tempDir();
    const a = await fake.createRepo(base, 'a');
    const b = await fake.createRepo(base, 'b');
    const wtA = a.worktrees[0]?.id ?? '';
    fake.setFiles(wtA, 'working', [fakeFile('seen.ts')]);
    let now = new Date('2026-01-01T00:00:00.000Z');
    const daemon = await startTestDaemon({ fake, stateDir, internal: { now: () => now } });
    const api = client(daemon);
    await api.addProject({ path: a.mainPath });
    await api.addProject({ path: b.mainPath });
    const seen = (await api.listFiles(wtA)).files[0];
    if (!seen) throw new Error('missing');
    await api.setReview({
      projectId: a.projectId,
      scopeKind: 'working',
      path: 'seen.ts',
      patchHash: seen.patchHash,
      reviewed: true,
    });
    await api.setReview({
      projectId: a.projectId,
      scopeKind: 'working',
      path: 'gone.ts',
      patchHash: 'old',
      reviewed: true,
    });
    await api.setReview({
      projectId: b.projectId,
      scopeKind: 'working',
      path: 'b.ts',
      patchHash: 'h',
      reviewed: true,
    });
    expect(daemon.store.countReviewMarks()).toBe(3);

    await api.removeProject(b.projectId);
    expect(daemon.store.countReviewMarks()).toBe(2);

    // 20 days later the seen mark is listed again (touched); 31 days after marking, only the
    // unseen one is stale.
    now = new Date('2026-01-21T00:00:00.000Z');
    expect((await api.listFiles(wtA)).files[0]?.reviewed).toBe(true);
    now = new Date('2026-02-01T00:00:00.000Z');
    expect(daemon.core.gc()).toEqual({ orphaned: 0, stale: 1 });
    expect(daemon.store.countReviewMarks()).toBe(1);
    expect((await api.listFiles(wtA)).files[0]?.reviewed).toBe(true);
  });
});
