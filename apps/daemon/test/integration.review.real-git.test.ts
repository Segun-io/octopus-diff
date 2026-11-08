import { readdirSync, realpathSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { GIT_CORE_IMPLEMENTED } from '@octopus-diff/git-core';
import { describe, expect, it } from 'vitest';
import { hashId } from '../src/ids.js';
import { client, tempDir } from './helpers.js';
import { makeRealGitFixture, makeRealRepo, startRealGitDaemon } from './real-git-fixture.js';

/** Every file under a git dir (no `objects/`), with its mtime: the write-detection snapshot. */
function gitDirSnapshot(gitDir: string): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'objects') walk(full);
      } else {
        out.set(path.relative(gitDir, full), statSync(full).mtimeMs);
      }
    }
  };
  walk(gitDir);
  return out;
}

describe.skipIf(!GIT_CORE_IMPLEMENTED)('UX round 1 + real git-core (integration)', () => {
  it('bulk-reviews real repositories, undoes, applies policy, survives restart, and never writes to a repo', async () => {
    const fx = await makeRealGitFixture();
    const stateDir = await tempDir();
    const alpha = await makeRealRepo(fx, 'alpha', { 'a.txt': 'one\ntwo\n', 'b.txt': 'b\n' });
    const beta = await makeRealRepo(fx, 'beta', { 'c.txt': 'c\n' });
    const feature = path.join(fx.root, 'alpha-feature');
    fx.git(alpha, 'worktree', 'add', '-q', '-b', 'feature', feature);
    const alphaId = hashId(realpathSync(path.join(alpha, '.git')));
    const betaId = hashId(realpathSync(path.join(beta, '.git')));
    const mainId = hashId(alpha);
    const featureId = hashId(feature);
    const betaMainId = hashId(beta);

    // Agents at work: the same edit in two worktrees (one patch), a second file, an untracked file.
    await writeFile(path.join(alpha, 'a.txt'), 'one\nTWO\n');
    await writeFile(path.join(alpha, 'b.txt'), 'B\n');
    await writeFile(path.join(feature, 'a.txt'), 'one\nTWO\n');
    await writeFile(path.join(beta, 'new.txt'), 'hello\n');

    const daemon = await startRealGitDaemon(fx, stateDir);
    const api = client(daemon);
    await api.addProject({ path: alpha });
    await api.addProject({ path: beta });
    const gitDir = realpathSync(path.join(alpha, '.git'));
    const betaGitDir = realpathSync(path.join(beta, '.git'));
    const before = { alpha: gitDirSnapshot(gitDir), beta: gitDirSnapshot(betaGitDir) };
    const headBefore = fx.git(alpha, 'rev-parse', 'HEAD');

    const inbox = await api.inbox();
    expect(inbox.entries.map((e) => e.worktree.id).sort()).toEqual(
      [mainId, featureId, betaMainId].sort(),
    );
    for (const e of inbox.entries) expect(e.review).toEqual({ enabled: true, source: 'default' });

    // Project-wide: a.txt's patch is identical in both worktrees, so 2 marks for 3 files.
    const project = await api.bulkReview({ target: { kind: 'project', projectId: alphaId } });
    expect(project).toMatchObject({ changed: 2, unchanged: 0, worktrees: 2, stale: [] });
    expect((await api.listFiles(mainId)).files.map((f) => f.reviewed)).toEqual([true, true]);
    expect((await api.listFiles(featureId)).files.map((f) => f.reviewed)).toEqual([true]);
    expect((await api.inbox({ onlyUnreviewed: true })).entries.map((e) => e.worktree.id)).toEqual([
      betaMainId,
    ]);

    // Everything, with the state the user saw; then undo it.
    const summaries = (await api.listProjects()).projects.flatMap((p) => p.worktrees);
    const expected: Record<string, string> = {};
    for (const w of summaries) if (w.summary) expected[w.worktree.id] = w.summary.stateHash;
    const all = await api.bulkReview({ target: { kind: 'all' }, expectedStateHashes: expected });
    expect(all).toMatchObject({ changed: 1, unchanged: 2, worktrees: 3, stale: [] });
    expect((await api.listFiles(betaMainId)).files[0]).toMatchObject({
      status: 'untracked',
      reviewed: true,
    });
    if (!all.undoToken) throw new Error('token');
    expect(await api.undoReview({ undoToken: all.undoToken })).toEqual({ ok: true, restored: 1 });
    expect((await api.listFiles(betaMainId)).files[0]?.reviewed).toBe(false);

    // A stale hash is refused.
    const stale = await api.bulkReview({
      target: { kind: 'worktree', worktreeId: betaMainId },
      expectedStateHashes: { [betaMainId]: 'gone' },
    });
    expect(stale).toMatchObject({ changed: 0, stale: [betaMainId], undoToken: null });

    // Policy: review off for the feature branch and for beta's project.
    await api.setReviewPolicy({
      target: { kind: 'branch', projectId: alphaId, branch: 'feature' },
      enabled: false,
    });
    const settings = await api.setReviewPolicy({
      target: { kind: 'project', projectId: betaId },
      enabled: false,
    });
    expect(settings.revision).toBe(2);
    const policies = Object.fromEntries(
      (await api.listProjects()).projects
        .flatMap((p) => p.worktrees)
        .map((w) => [w.worktree.id, w.review]),
    );
    expect(policies).toEqual({
      [mainId]: { enabled: true, source: 'default' },
      [featureId]: { enabled: false, source: 'branch' },
      [betaMainId]: { enabled: false, source: 'project' },
    });
    await api.bulkReview({ target: { kind: 'all' }, reviewed: false });
    expect((await api.inbox({ onlyUnreviewed: true })).entries.map((e) => e.worktree.id)).toEqual([
      mainId,
    ]);
    const skipped = await api.bulkReview({ target: { kind: 'all' } });
    expect(skipped.skippedDisabled.sort()).toEqual([featureId, betaMainId].sort());
    expect(skipped).toMatchObject({ changed: 2, worktrees: 1 });

    // Restart on the same state dir: settings, overrides, revision and marks persist.
    await daemon.close();
    const restarted = await startRealGitDaemon(fx, stateDir);
    const api2 = client(restarted);
    const after = await api2.getSettings();
    expect(after.revision).toBe(2);
    expect(after.overrides.map((o) => o.target.kind).sort()).toEqual(['branch', 'project']);
    expect((await api2.listFiles(mainId)).files.map((f) => f.reviewed)).toEqual([true, true]);
    expect(
      (await api2.listProjects()).projects
        .flatMap((p) => p.worktrees)
        .find((w) => w.worktree.id === featureId)?.review,
    ).toEqual({ enabled: false, source: 'branch' });
    await api2.updateSettings({ review: { defaultEnabled: false } });
    expect((await api2.getSettings()).revision).toBe(3);
    await api2.bulkReview({ target: { kind: 'all' }, includeDisabled: true });
    await api2.bulkReview({ target: { kind: 'all' }, includeDisabled: true, reviewed: false });

    // Read-only proof: nothing in either git dir changed (no index refresh, no locks), HEAD is
    // the same, and git's own view of the working trees is unchanged.
    expect(gitDirSnapshot(gitDir)).toEqual(before.alpha);
    expect(gitDirSnapshot(betaGitDir)).toEqual(before.beta);
    expect(fx.git(alpha, 'rev-parse', 'HEAD')).toBe(headBefore);
    for (const dir of [gitDir, betaGitDir]) {
      expect([...gitDirSnapshot(dir).keys()].filter((f) => f.endsWith('.lock'))).toEqual([]);
    }
    expect(fx.git(alpha, '--no-optional-locks', 'status', '--porcelain=v2', '-z')).toContain(
      'a.txt',
    );
  }, 30_000);
});
