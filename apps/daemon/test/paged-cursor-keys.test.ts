/**
 * #42, PR #97 review (second round): a `GET /files` cursor is bound to its worktree too, not only
 * to the state and the scope. Two worktrees can hold the same state (here: a fake git-core whose
 * two repositories have the same branch, HEAD and files, so the same `stateHash`).
 */
import { describe, expect, it } from 'vitest';
import { FakeGitCore, fakeFile } from './fake-git-core.js';
import { client, startTestDaemon, tempDir } from './helpers.js';

describe('cursor keys (#42)', () => {
  it('a cursor of one worktree restarts on another with the same state and files', async () => {
    const fake = new FakeGitCore();
    const base = await tempDir();
    const a = await fake.createRepo(base, 'alpha');
    const b = await fake.createRepo(base, 'beta');
    const files = ['a.txt', 'b.txt', 'c.txt', 'd.txt'].map((p) => fakeFile(p));
    const wa = a.worktrees[0];
    const wb = b.worktrees[0];
    if (!wa || !wb) throw new Error('no worktrees');
    wb.headSha = wa.headSha;
    fake.setFiles(wa.id, 'working', files);
    fake.setFiles(wb.id, 'working', files);
    const daemon = await startTestDaemon({ fake, stateDir: await tempDir() });
    const api = client(daemon);
    for (const repo of [a, b]) await api.addProject({ path: repo.mainPath });
    const pa = await api.listFiles(wa.id, { scope: { kind: 'working' }, limit: 2 });
    const pb = await api.listFiles(wb.id, { scope: { kind: 'working' }, limit: 2 });
    // The case under test: the same state in both.
    expect(pb.stateHash).toBe(pa.stateHash);
    const next = await api.listFiles(wb.id, {
      scope: { kind: 'working' },
      limit: 2,
      cursor: pa.nextCursor as string,
    });
    expect(next.restarted).toBe(true);
    expect(next.offset).toBe(0);
    // Its own cursor goes on.
    const own = await api.listFiles(wb.id, {
      scope: { kind: 'working' },
      limit: 2,
      cursor: pb.nextCursor as string,
    });
    expect(own.restarted).toBe(false);
    expect(own.offset).toBe(2);
  });
});
