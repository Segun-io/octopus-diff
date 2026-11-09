import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeGitCore } from './fake-git-core.js';
import { client, eventually, recordEvents, startTestDaemon, tempDir } from './helpers.js';

/**
 * PLAN §6 WS2 "done when", with the fake git-core (fs-backed: every file in a worktree is an
 * untracked change): start the daemon, register repos, mutate files externally, receive SSE
 * `worktree.changed` within ~1 s; restart preserves registry and review marks.
 */
describe('live updates end to end (fake git-core, real watcher, real SSE)', () => {
  it('delivers worktree.changed within ~1 s of an external edit and survives a restart', async () => {
    const fake = new FakeGitCore();
    const base = await tempDir();
    const stateDir = await tempDir();
    const alpha = await fake.createRepo(base, 'alpha', { linked: ['agent'], fsBacked: true });
    const beta = await fake.createRepo(base, 'beta', { fsBacked: true });
    const mainWt = alpha.worktrees[0];
    const agentWt = alpha.worktrees[1];
    if (!mainWt || !agentWt) throw new Error('fixture');
    await writeFile(path.join(agentWt.path, 'app.ts'), 'export const a = 1;\n');

    const daemon = await startTestDaemon({ fake, stateDir });
    const api = client(daemon);
    await api.addProject({ path: alpha.mainPath });
    await api.addProject({ path: beta.mainPath });
    const events = recordEvents(daemon);
    await events.opened;

    const before = await api.listFiles(agentWt.id);
    expect(before.files.map((f) => f.path)).toEqual(['app.ts']);
    // Registration does not wait for watching to start (the watch host may still be booting
    // under load, DECISIONS #130): the latency below is measured once it is active.
    await eventually(async () => (await api.health()).watcher.mode === 'native', 10_000);

    // An "agent" edits a file in the linked worktree.
    const t0 = Date.now();
    await writeFile(path.join(agentWt.path, 'app.ts'), 'export const a = 2;\n');
    const changed = await events.waitFor(
      (e) => e.type === 'worktree.changed' && e.worktreeId === agentWt.id,
      2000,
    );
    const latency = Date.now() - t0;
    expect(latency).toBeLessThan(1000);
    expect(changed).toMatchObject({ projectId: alpha.projectId });
    expect(changed.type === 'worktree.changed' && changed.stateHash).not.toBe(before.stateHash);

    // A new file in a subdirectory of another project.
    await mkdir(path.join(beta.mainPath, 'src'), { recursive: true });
    await writeFile(path.join(beta.mainPath, 'src', 'new.ts'), 'x\n');
    await events.waitFor(
      (e) => e.type === 'worktree.changed' && e.worktreeId === beta.worktrees[0]?.id,
      2000,
    );

    // Review, then restart on the same state dir.
    const after = await api.listFiles(agentWt.id);
    expect(after.stateHash).toBe(changed.type === 'worktree.changed' ? changed.stateHash : '');
    const file = after.files[0];
    if (!file) throw new Error('missing');
    await api.setReview({
      projectId: alpha.projectId,
      scopeKind: 'working',
      path: file.path,
      patchHash: file.patchHash,
      reviewed: true,
    });
    expect((await api.inbox({ onlyUnreviewed: true })).entries.map((e) => e.worktree.id)).toEqual([
      beta.worktrees[0]?.id,
    ]);
    await daemon.close();

    const restarted = await startTestDaemon({ fake, stateDir });
    const api2 = client(restarted);
    const projects = await api2.listProjects();
    expect(projects.projects.map((p) => p.project.name)).toEqual(['alpha', 'beta']);
    expect(projects.projects[0]?.worktrees.map((w) => w.worktree.id)).toEqual([
      mainWt.id,
      agentWt.id,
    ]);
    expect((await api2.listFiles(agentWt.id)).files[0]?.reviewed).toBe(true);

    // Editing the reviewed file again makes it unreviewed (new patch hash) and is live too.
    const events2 = recordEvents(restarted);
    await events2.opened;
    await eventually(async () => (await api2.health()).watcher.mode === 'native', 10_000);
    await writeFile(path.join(agentWt.path, 'app.ts'), 'export const a = 3;\n');
    await events2.waitFor(
      (e) => e.type === 'worktree.changed' && e.worktreeId === agentWt.id,
      2000,
    );
    expect((await api2.listFiles(agentWt.id)).files[0]?.reviewed).toBe(false);
  });
});
