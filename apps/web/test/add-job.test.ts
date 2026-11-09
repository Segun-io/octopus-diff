import type { ProjectListItem, ScanRoot } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { type AddJob, describeAddJob, folderJobOutcome } from '../src/state/addJob.ts';
import type { ScanStatus } from '../src/state/ui.tsx';

type FolderJob = Extract<AddJob, { kind: 'folder' }>;

const folder: FolderJob = {
  id: 1,
  kind: 'folder',
  path: '~/code',
  depth: 3,
  state: 'working',
  scanRootId: 'root1',
  created: true,
  scannedBefore: null,
};

function root(patch: Partial<ScanRoot> = {}): ScanRoot {
  return {
    id: 'root1',
    path: '/home/me/code',
    depth: 3,
    addedAt: '2026-11-09T00:00:00.000Z',
    lastScannedAt: null,
    projectCount: 0,
    ...patch,
  };
}

function project(name: string, scanRootId: string | null): ProjectListItem {
  return {
    project: {
      id: `p-${name}`,
      name,
      commonDir: `/home/me/code/${name}/.git`,
      mainWorktreePath: `/home/me/code/${name}`,
      bare: false,
      defaultBranch: 'main',
      defaultBranchOverride: null,
      scanRootId,
      addedAt: '2026-11-09T00:00:00.000Z',
    },
    worktrees: [],
  };
}

const scanning: ScanStatus = {
  scanRootId: 'root1',
  state: 'scanning',
  scannedDirs: 120,
  foundRepos: 2,
  message: null,
};

describe('folderJobOutcome', () => {
  it('waits until the scan root was scanned after the request', () => {
    expect(folderJobOutcome(folder, root(), scanning)).toBeNull();
    expect(folderJobOutcome(folder, undefined, null)).toBeNull();
    expect(
      folderJobOutcome(
        folder,
        root({ lastScannedAt: '2026-11-09T01:00:00.000Z', projectCount: 4 }),
        null,
      ),
    ).toEqual({ state: 'done', found: 4 });
  });

  it('a re-watched folder is done when lastScannedAt moves', () => {
    const again: FolderJob = {
      ...folder,
      created: false,
      scannedBefore: '2026-11-08T00:00:00.000Z',
    };
    expect(
      folderJobOutcome(again, root({ lastScannedAt: '2026-11-08T00:00:00.000Z' }), null),
    ).toBeNull();
    expect(
      folderJobOutcome(
        again,
        root({ lastScannedAt: '2026-11-09T00:00:00.000Z', projectCount: 1 }),
        null,
      ),
    ).toEqual({ state: 'done', found: 1 });
  });

  it('reports a scan error for this folder only', () => {
    const error: ScanStatus = { ...scanning, state: 'error', message: 'permission denied' };
    expect(folderJobOutcome(folder, root(), error)).toEqual({
      state: 'error',
      error: 'permission denied',
    });
    expect(folderJobOutcome(folder, root(), { ...error, scanRootId: 'other' })).toBeNull();
  });

  it('ignores jobs that are not running or not yet registered', () => {
    expect(
      folderJobOutcome({ ...folder, state: 'done' }, root({ lastScannedAt: 'x' }), null),
    ).toBeNull();
    const pending: FolderJob = { ...folder };
    delete pending.scanRootId;
    expect(folderJobOutcome(pending, root({ lastScannedAt: 'x' }), null)).toBeNull();
  });
});

describe('describeAddJob', () => {
  it('shows scan progress while working', () => {
    const s = describeAddJob(folder, { scan: scanning, projects: [] });
    expect(s.tone).toBe('working');
    expect(s.title).toBe('Looking for repositories in ~/code…');
    expect(s.detail).toBe('120 folders checked, 2 repositories found so far.');
    expect(describeAddJob(folder, { scan: null, projects: [] }).detail).toContain('3 levels deep');
  });

  it('lists what a folder added and offers to open it', () => {
    const projects = ['zeta', 'alpha', 'beta', 'gamma', 'delta', 'eps', 'mu'].map((n) =>
      project(n, 'root1'),
    );
    projects.push(project('elsewhere', null));
    const s = describeAddJob({ ...folder, state: 'done', found: 7 }, { scan: null, projects });
    expect(s.tone).toBe('success');
    expect(s.title).toBe('Watching ~/code: 7 repositories found');
    expect(s.names).toEqual(['alpha', 'beta', 'delta', 'eps', 'gamma']);
    expect(s.more).toBe(2);
    expect(s.actions).toEqual([
      { id: 'open', label: 'Show folder', view: { kind: 'folder', scanRootId: 'root1' } },
    ]);
  });

  it('explains an empty folder and offers the next steps', () => {
    const s = describeAddJob({ ...folder, state: 'done', found: 0 }, { scan: null, projects: [] });
    expect(s.tone).toBe('empty');
    expect(s.title).toBe('No repositories found in ~/code');
    expect(s.actions.map((a) => a.id)).toEqual(['retry', 'stop-watching']);
  });

  it('describes a repository and errors', () => {
    const repo: AddJob = { id: 2, kind: 'repo', path: '~/code/app', state: 'working' };
    expect(describeAddJob(repo, { scan: null, projects: [] }).title).toBe('Adding ~/code/app…');
    const done = describeAddJob(
      { ...repo, state: 'done', name: 'app', projectId: 'p1', created: true, worktrees: 3 },
      { scan: null, projects: [] },
    );
    expect(done.title).toBe('Added app');
    expect(done.detail).toContain('3 worktrees');
    expect(done.actions[0]?.view).toEqual({ kind: 'project', projectId: 'p1' });
    const again = describeAddJob(
      { ...repo, state: 'done', name: 'app', projectId: 'p1', created: false, worktrees: 1 },
      { scan: null, projects: [] },
    );
    expect(again.title).toBe('app was already added');
    const failed = describeAddJob(
      { ...repo, state: 'error', error: 'not a git repository' },
      { scan: null, projects: [] },
    );
    expect(failed.tone).toBe('error');
    expect(failed.title).toBe('Could not add ~/code/app');
    expect(failed.detail).toBe('not a git repository');
  });
});
