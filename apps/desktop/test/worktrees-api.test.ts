import { describe, expect, it } from 'vitest';
import { listWorktrees } from '../src/worktrees-api.js';

const TOKEN = 'T'.repeat(43);

const worktree = (id: string, path: string, missing = false) => ({
  worktree: {
    id,
    projectId: '1111111111111111',
    path,
    branch: 'main',
    headSha: null,
    detached: false,
    isMain: true,
    bare: false,
    locked: false,
    prunable: false,
    missing,
  },
  summary: null,
  error: null,
});

const projects = {
  projects: [
    {
      project: {
        id: '1111111111111111',
        name: 'repo',
        commonDir: '/r/.git',
        mainWorktreePath: '/r',
        bare: false,
        defaultBranch: 'main',
        defaultBranchOverride: null,
        scanRootId: null,
        addedAt: '2026-11-13T00:00:00.000Z',
      },
      worktrees: [worktree('0123456789abcdef', '/r'), worktree('fedcba9876543210', '/r-wt', true)],
    },
  ],
};

describe('listWorktrees', () => {
  it('asks GET /api/projects with the token and flattens the worktrees', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const result = await listWorktrees('http://127.0.0.1:7428', TOKEN, async (url, init) => {
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return Response.json(projects);
    });
    expect(seen).toEqual([{ url: 'http://127.0.0.1:7428/api/projects', auth: `Bearer ${TOKEN}` }]);
    expect(result).toEqual([
      { id: '0123456789abcdef', path: '/r', missing: false, bare: false },
      { id: 'fedcba9876543210', path: '/r-wt', missing: true, bare: false },
    ]);
  });

  it('is null when the daemon is down or answers something else', async () => {
    expect(
      await listWorktrees('http://x', TOKEN, async () => {
        throw new TypeError('fetch failed');
      }),
    ).toBeNull();
    expect(
      await listWorktrees('http://x', TOKEN, async () => Response.json({ projects: [{}] })),
    ).toBeNull();
    expect(
      await listWorktrees('http://x', TOKEN, async () =>
        Response.json({ error: { code: 'unauthorized', message: 'no' } }, { status: 401 }),
      ),
    ).toBeNull();
  });
});
