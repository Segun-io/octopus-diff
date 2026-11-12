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

/**
 * Knobs for the loading-state surfaces (#11, DECISIONS #212): what the forge side of the daemon
 * reports while it is slow, held back or failing. Changed at run time through
 * `MockBackend.setForgeSim` (or `POST /api/__mock/forge-sim`); all off = the plain fixture.
 */
export interface ForgeSim {
  /** Every project's request lookup is running: status `pending`, no requests, nothing fetched. */
  pending?: boolean;
  /** github.com's budget state (docs/FORGES.md 3a). `backoff` and `low` carry `resumeAt`. */
  budget?: 'ok' | 'busy' | 'low' | 'backoff';
  /** The last fetch of every project failed with this message; the last good data is kept. */
  error?: string | null;
  /** How long ago the last successful fetch was (ms before `generatedAt`); default: a fixed stamp. */
  fetchedAgoMs?: number;
}

/** When a held-back host resumes, relative to `generatedAt`. */
export const MOCK_RESUME_AFTER_MS = 12 * 60_000;

export function mockForges(
  projects: ProjectsResponse,
  settings: AppSettings,
  generatedAt: string,
  sim: ForgeSim = {},
): ForgesResponse {
  const enabled = settings.forges?.enabled ?? true;
  const fetchedAt =
    sim.fetchedAgoMs === undefined
      ? STAMP
      : new Date(Date.parse(generatedAt) - sim.fetchedAgoMs).toISOString();
  const budgetState = sim.budget ?? 'ok';
  const resumeAt =
    budgetState === 'backoff' || budgetState === 'low'
      ? new Date(Date.parse(generatedAt) + MOCK_RESUME_AFTER_MS).toISOString()
      : null;
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
      status: !enabled
        ? 'disabled'
        : sim.pending
          ? 'pending'
          : sim.error && worktrees.length > 0
            ? 'error'
            : worktrees.length > 0
              ? 'ok'
              : 'idle',
      message: sim.error && !sim.pending ? sim.error : null,
      // A lookup that has not answered yet has nothing to show (and nothing fetched).
      worktrees: !enabled ? [] : sim.pending ? [] : worktrees,
      fetchedAt: sim.pending ? null : fetchedAt,
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
    budgets: [
      {
        host: 'github.com',
        kind: 'github',
        state: budgetState,
        spentLastHour: budgetState === 'ok' ? 214 : 1500,
        backgroundLimit: 1500,
        hourlyLimit: 4000,
        remaining: budgetState === 'ok' ? 4786 : budgetState === 'busy' ? 900 : 0,
        resetAt: resumeAt,
        resumeAt,
        message:
          budgetState === 'backoff'
            ? 'GitHub refused the last request (rate limit); lookups are paused.'
            : budgetState === 'low'
              ? 'Little quota left; only lookups you ask for run.'
              : budgetState === 'busy'
                ? 'Using a lot of the hourly quota; polling slower.'
                : null,
      },
    ],
    generatedAt,
  };
}
