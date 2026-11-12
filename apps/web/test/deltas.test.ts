/**
 * #51 review: rows are ordered by the daemon's `rev`, not by `summary.updatedAt`, so a row whose
 * summary is null (a failed refresh) is ordered too: an older projects answer can undo neither an
 * error nor a recovery, and a row event with the same `stateHash` but a later `rev` (the review
 * state landed after a projects answer showed the summary) is applied.
 */
import type {
  ProjectsResponse,
  ServerEvent,
  WorktreeListItem,
  WorktreeSummary,
} from '@octopus-diff/contracts';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { collectEventEffects, emptyEffects, flushEffects } from '../src/api/cache.ts';
import { applyRow, keepNewerRows, type WorktreeDeltaEvent } from '../src/api/deltas.ts';
import { queryKeys } from '../src/api/queries.ts';

const P = '0123456789abcdef';
const W = 'fedcba9876543210';
const SHA = 'a'.repeat(40);

function summary(stateHash: string, updatedAt: string, review = false): WorktreeSummary {
  return {
    worktreeId: W,
    projectId: P,
    branch: 'main',
    headSha: SHA,
    detached: false,
    upstream: null,
    aheadBehindRef: null,
    ahead: null,
    behind: null,
    counts: { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 },
    changedFiles: 1,
    additions: 1,
    deletions: 0,
    inProgress: null,
    stateHash,
    updatedAt,
    ...(review
      ? {
          review: {
            bookmark: SHA,
            base: SHA,
            newCommits: 0,
            unreviewedFiles: 1,
            historyRewritten: false,
          },
        }
      : {}),
  };
}

const worktree = {
  id: W,
  projectId: P,
  path: '/repo',
  branch: 'main',
  headSha: SHA,
  detached: false,
  isMain: true,
  bare: false,
  locked: false,
  prunable: false,
  missing: false,
};

const healthy = (rev: number | undefined, hash = 'h1', at = '2026-11-12T10:00:00.000Z') =>
  ({
    worktree,
    summary: summary(hash, at),
    error: null,
    ...(rev !== undefined ? { rev } : {}),
  }) satisfies WorktreeListItem;
const failed = (rev: number | undefined) =>
  ({
    worktree,
    summary: null,
    error: { code: 'timeout', message: 'git status timed out' },
    ...(rev !== undefined ? { rev } : {}),
  }) satisfies WorktreeListItem;

function list(row: WorktreeListItem): ProjectsResponse {
  return {
    projects: [
      {
        project: {
          id: P,
          name: 'repo',
          commonDir: '/repo/.git',
          mainWorktreePath: '/repo',
          bare: false,
          defaultBranch: 'main',
          defaultBranchOverride: null,
          scanRootId: null,
          addedAt: '2026-11-12T09:00:00.000Z',
        },
        worktrees: [row],
      },
    ],
  };
}

function event(row: WorktreeListItem, stateHash = row.summary?.stateHash ?? 'error:timeout') {
  return {
    type: 'worktree.changed',
    projectId: P,
    worktreeId: W,
    stateHash,
    ...row,
  } as WorktreeDeltaEvent;
}

function seeded(row: WorktreeListItem) {
  const qc = new QueryClient();
  qc.setQueryData(queryKeys.projects(), list(row));
  return qc;
}
const rowIn = (r: ProjectsResponse | undefined) => r?.projects[0]?.worktrees[0];
const cached = (qc: QueryClient) => rowIn(qc.getQueryData<ProjectsResponse>(queryKeys.projects()));

describe('rows ordered by rev (#51 review)', () => {
  it('an older answer (healthy) does not undo an applied error', () => {
    const qc = seeded(healthy(5));
    expect(applyRow(qc, event(failed(6))).kind).toBe('applied');
    // The projects request was answered before the failure: healthy, rev 5.
    expect(rowIn(keepNewerRows(qc, list(healthy(5))))?.error?.code).toBe('timeout');
  });

  it('an older answer (error) does not undo an applied recovery', () => {
    const qc = seeded(failed(6));
    expect(applyRow(qc, event(healthy(7, 'h2'))).kind).toBe('applied');
    expect(rowIn(keepNewerRows(qc, list(failed(6))))?.summary?.stateHash).toBe('h2');
  });

  it('an event older than the cached row is dropped, whichever side has a null summary', () => {
    const errorLater = seeded(failed(9));
    expect(applyRow(errorLater, event(healthy(8))).kind).toBe('stale');
    expect(cached(errorLater)?.error?.code).toBe('timeout');
    const healthyLater = seeded(healthy(9, 'h3'));
    expect(applyRow(healthyLater, event(failed(8))).kind).toBe('stale');
    expect(cached(healthyLater)?.summary?.stateHash).toBe('h3');
  });

  it('a newer answer wins, and so does an answer with the same rev (the same state)', () => {
    const qc = seeded(healthy(5));
    applyRow(qc, event(failed(6)));
    expect(rowIn(keepNewerRows(qc, list(healthy(7, 'h4'))))?.summary?.stateHash).toBe('h4');
    const same = { ...failed(6), review: { enabled: false, source: 'worktree' as const } };
    expect(rowIn(keepNewerRows(qc, list(same)))?.review?.enabled).toBe(false);
  });

  it('without rev (older daemons) the updatedAt rule still orders healthy rows', () => {
    const qc = seeded(healthy(undefined, 'h1', '2026-11-12T10:00:00.000Z'));
    applyRow(qc, event(healthy(undefined, 'h2', '2026-11-12T10:00:05.000Z')));
    const older = list(healthy(undefined, 'h1', '2026-11-12T10:00:01.000Z'));
    expect(rowIn(keepNewerRows(qc, older))?.summary?.stateHash).toBe('h2');
  });

  it('a reconnect forgets the remembered rows (a restarted daemon counts again)', async () => {
    const qc = seeded(healthy(5));
    applyRow(qc, event(failed(6)));
    const hello: ServerEvent = {
      type: 'hello',
      version: '1',
      startedAt: '2026-11-12T11:00:00.000Z',
    };
    await flushEffects(qc, collectEventEffects(qc, hello, emptyEffects(), { reconnect: true }));
    expect(rowIn(keepNewerRows(qc, list(healthy(2))))?.error).toBeNull();
  });
});

describe('a row event with the cached stateHash (#51 review)', () => {
  it('is applied when its rev is newer (the review state landed after the projects answer)', async () => {
    const qc = seeded(healthy(5, 'h1'));
    const withReview: WorktreeListItem = {
      ...healthy(6, 'h1'),
      summary: summary('h1', '2026-11-12T10:00:00.000Z', true),
    };
    qc.setQueryData(queryKeys.files(W, { kind: 'working' }), {
      worktreeId: W,
      scope: { kind: 'working' },
      stateHash: 'h1',
      files: [],
    });
    const effects = collectEventEffects(qc, event(withReview), emptyEffects(), {
      reconnect: false,
    });
    await flushEffects(qc, effects);
    expect(cached(qc)?.summary?.review?.unreviewedFiles).toBe(1);
    expect(cached(qc)?.rev).toBe(6);
    // Same git state: no list is refetched for it.
    expect(qc.getQueryState(queryKeys.files(W, { kind: 'working' }))?.isInvalidated).toBe(false);
    expect(qc.getQueryState(queryKeys.projects())?.isInvalidated).toBe(false);
  });

  it('is skipped when its rev is not newer (nothing new)', () => {
    const qc = seeded(healthy(6, 'h1'));
    const effects = collectEventEffects(qc, event(healthy(6, 'h1')), emptyEffects(), {
      reconnect: false,
    });
    expect(effects.deltas.size + effects.worktrees.size).toBe(0);
    expect(effects.projects).toBe(false);
  });
});
