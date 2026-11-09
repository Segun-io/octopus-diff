import type {
  AppSettings,
  ChangeRequest,
  ForgeKind,
  ForgesResponse,
  ProjectForgeState,
  ProjectsResponse,
  WorktreeForge,
} from '@octopus-diff/contracts';

/**
 * Mock `GET /api/forges` (docs/FORGES.md): deterministic pull/merge requests for the demo data.
 * Every second project is on GitLab; the default branch is never looked up, like the daemon. The
 * rotation covers every look the UI has (open, draft, merged, closed, none) and CI state.
 */
const LOOKS: Array<Pick<ChangeRequest, 'state' | 'draft'> | null> = [
  { state: 'open', draft: false },
  { state: 'open', draft: true },
  { state: 'merged', draft: false },
  null,
  { state: 'closed', draft: false },
];
const CHECKS: ChangeRequest['checks'][] = [
  { state: 'failure', passed: 21, failed: 1, pending: 0, total: 22 },
  { state: 'pending', passed: 12, failed: 0, pending: 3, total: 15 },
  { state: 'success', passed: 18, failed: 0, pending: 0, total: 18 },
  null,
];
const STAMP = '2026-11-08T09:00:00.000Z';
const CREATED = '2026-11-05T14:30:00.000Z';
const MERGE_STATES: NonNullable<ChangeRequest['mergeState']>[] = [
  'blocked',
  'clean',
  'behind',
  'unstable',
];

export function mockForges(
  projects: ProjectsResponse,
  settings: AppSettings,
  generatedAt: string,
): ForgesResponse {
  const enabled = settings.forges?.enabled ?? true;
  let n = 0;
  const states = projects.projects.map((item, index): ProjectForgeState => {
    const kind: ForgeKind = index % 2 === 0 ? 'github' : 'gitlab';
    const host = kind === 'github' ? 'github.com' : 'gitlab.com';
    const repository = `octo-demo/${item.project.name}`;
    const worktrees: WorktreeForge[] = [];
    for (const w of item.worktrees) {
      const branch = w.summary?.branch ?? w.worktree.branch;
      if (!branch || branch === item.project.defaultBranch || w.worktree.missing) continue;
      const look = LOOKS[n % LOOKS.length] ?? null;
      const number = 100 + n * 7;
      const checks = CHECKS[n % CHECKS.length] ?? null;
      n += 1;
      const changeRequest: ChangeRequest | null = look && {
        kind,
        number,
        title: `${branch.replace(/[-/_]/g, ' ')}`,
        url:
          kind === 'github'
            ? `https://${host}/${repository}/pull/${number}`
            : `https://${host}/${repository}/-/merge_requests/${number}`,
        state: look.state,
        draft: look.draft,
        author: 'agent-bot',
        baseBranch: item.project.defaultBranch ?? 'main',
        headBranch: branch,
        headSha: w.summary?.headSha ?? w.worktree.headSha,
        crossRepository: false,
        headRepository: repository,
        updatedAt: STAMP,
        checks:
          kind === 'gitlab' && checks
            ? { state: checks.state, passed: null, failed: null, pending: null, total: null }
            : checks,
        review: look.state === 'open' && !look.draft ? 'review_required' : null,
        conflicts: n % 6 === 0 ? true : look.state === 'open' ? false : null,
        comments: n % 3,
        createdAt: CREATED,
        additions: 40 + ((n * 37) % 300),
        deletions: (n * 13) % 90,
        changedFiles: 2 + (n % 9),
        mergeState:
          look.state !== 'open'
            ? null
            : look.draft
              ? 'draft'
              : n % 6 === 0
                ? 'conflicts'
                : (MERGE_STATES[n % MERGE_STATES.length] ?? 'unknown'),
      };
      worktrees.push({
        worktreeId: w.worktree.id,
        branch,
        changeRequest,
        sync: changeRequest?.headSha ? 'same' : 'unknown',
      });
    }
    return {
      projectId: item.project.id,
      forge: {
        kind,
        host,
        repository,
        webUrl: `https://${host}/${repository}`,
        remoteName: 'origin',
        detectedBy: 'hostname',
      },
      status: enabled ? (worktrees.length > 0 ? 'ok' : 'idle') : 'disabled',
      message: null,
      worktrees: enabled ? worktrees : [],
      fetchedAt: STAMP,
    };
  });
  return {
    enabled,
    clis: [
      {
        kind: 'github',
        executable: 'gh',
        available: true,
        version: 'gh version 2.46.0 (mock)',
        auth: 'authenticated',
        accounts: [{ host: 'github.com', account: 'octo' }],
        hint: 'Run `gh auth login`.',
        detail: null,
        checkedAt: STAMP,
      },
      {
        kind: 'gitlab',
        executable: 'glab',
        available: true,
        version: 'glab 1.128.0 (mock)',
        auth: 'authenticated',
        accounts: [{ host: 'gitlab.com', account: 'octo' }],
        hint: 'Run `glab auth login`.',
        detail: null,
        checkedAt: STAMP,
      },
    ],
    projects: states,
    generatedAt,
  };
}
