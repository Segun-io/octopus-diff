import type {
  ChangeRequestCheck,
  ChangeRequestComment,
  ChangeRequestConversation,
  ChangeRequestDetail,
  ChangeRequestReviewer,
  ChangeRequestThread,
  ForgeActor,
  ForgeRepositoryInfo,
  GitRepositoryInfo,
  ProjectForgeState,
  ProjectListItem,
  WorktreeForge,
} from '@octopus-diff/contracts';

/**
 * Mock request detail, conversation and repository information (docs/FORGES.md "Request tab"),
 * derived deterministically from the mock forge data (mock/forges.ts). The rotation covers every
 * look the UI has: each reviewer state and `stale`, every check group, resolved and outdated
 * threads, bots, truncation banners, and markdown that must not become active content.
 */

const STAMP = Date.parse('2026-11-08T09:00:00.000Z');
const at = (minutesBefore: number) => new Date(STAMP - minutesBefore * 60_000).toISOString();

function hash40(seed: string): string {
  let h = 2166136261;
  let out = '';
  for (let i = 0; out.length < 40; i++) {
    h ^= seed.charCodeAt(i % Math.max(1, seed.length)) + i;
    h = Math.imul(h, 16777619) >>> 0;
    out += h.toString(16).padStart(8, '0');
  }
  return out.slice(0, 40);
}

const actor = (login: string, name: string | null = null, bot = false): ForgeActor => ({
  login,
  name,
  avatarUrl: null,
  bot,
});

const PEOPLE = {
  ada: actor('ada', 'Ada Lovelace'),
  linus: actor('linus', 'Linus T.'),
  grace: actor('grace', 'Grace Hopper'),
  ken: actor('ken'),
  bot: actor('review-bot[bot]', null, true),
  agent: actor('agent-bot', 'Agent', true),
};

/** Image hosts the mock "signs in" to, like the daemon's `forgeImageHosts`. */
export function mockImageHosts(images: boolean, enabled: boolean): string[] {
  if (!images || !enabled) return [];
  return ['*.githubusercontent.com', 'github.com', 'gitlab.com', 'secure.gravatar.com'];
}

// --- local repository facts -----------------------------------------------------------------

export function mockRepositoryInfo(item: ProjectListItem, index: number): GitRepositoryInfo {
  const name = item.project.defaultBranch ?? 'main';
  const main = item.worktrees.find((w) => w.worktree.isMain) ?? item.worktrees[0];
  const host = index % 2 === 0 ? 'github.com' : 'gitlab.com';
  return {
    defaultBranch: {
      name,
      head: {
        sha: main?.worktree.headSha ?? hash40(`main:${item.project.id}`),
        subject: [
          'Merge pull request #96 from octo-demo/fix/cache',
          'release: 0.4.2',
          'docs: usage',
        ][index % 3] as string,
        authorName: ['Ada Lovelace', 'Grace Hopper', 'Linus T.'][index % 3] as string,
        authorDate: at(90 + index * 37),
      },
      upstream: `origin/${name}`,
      ahead: index % 3 === 1 ? 2 : 0,
      behind: index % 2,
    },
    localBranches: item.worktrees.length + 3,
    tags: 4 + index * 3,
    remotes: [
      {
        name: 'origin',
        url: `https://${host}/octo-demo/${item.project.name}.git`,
        pushUrl: null,
      },
      ...(index === 0
        ? [
            {
              name: 'upstream',
              url: `git@${host}:upstream-org/${item.project.name}.git`,
              pushUrl: null,
            },
          ]
        : []),
    ],
    lastActivityAt: at(5 + index * 11),
  };
}

// --- forge repository facts -----------------------------------------------------------------

export function mockRepositoryForgeInfo(
  state: ProjectForgeState,
  index: number,
): ForgeRepositoryInfo | null {
  const forge = state.forge;
  if (!forge) return null;
  const mine = state.worktrees
    .filter((w) => w.changeRequest?.state === 'open')
    .map((w) => ({ w, cr: w.changeRequest as NonNullable<WorktreeForge['changeRequest']> }));
  const others = [0, 1, 2].map((i) => ({
    number: 300 + index * 10 + i,
    title: ['Bump dependencies', 'Docs: clarify the setup steps', 'Faster startup on Windows'][
      i
    ] as string,
    author: ['renovate[bot]', 'ken', 'grace'][i] as string,
    draft: i === 1,
    checks: (['success', 'pending', 'failure'] as const)[i] ?? null,
    review: (['approved', null, 'changes_requested'] as const)[i] ?? null,
  }));
  const path = forge.kind === 'github' ? 'pull' : '-/merge_requests';
  const requests = [
    ...mine.map(({ w, cr }) => ({
      number: cr.number,
      title: cr.title,
      url: cr.url,
      draft: cr.draft,
      author: cr.author,
      headBranch: cr.headBranch,
      baseBranch: cr.baseBranch,
      crossRepository: cr.crossRepository,
      updatedAt: cr.updatedAt,
      checks: cr.checks?.state ?? null,
      review: cr.review,
      worktreeId: w.worktreeId,
    })),
    ...others.map((o, i) => ({
      number: o.number,
      title: o.title,
      url: `${forge.webUrl}/${path}/${o.number}`,
      draft: o.draft,
      author: o.author,
      headBranch: `chore/update-${i}`,
      baseBranch: 'main',
      crossRepository: i === 2,
      updatedAt: at(30 + i * 240),
      checks: o.checks,
      review: o.review,
      worktreeId: null,
    })),
  ];
  return {
    kind: forge.kind,
    host: forge.host,
    repository: forge.repository,
    webUrl: forge.webUrl,
    description: [
      'The API behind the octopus demo: auth, cache and the public endpoints.',
      'Web client for the octopus demo.',
      null,
    ][index % 3] as string | null,
    visibility: index % 3 === 2 ? 'private' : 'public',
    archived: false,
    forkOf: index === 1 ? 'upstream-org/octopus-web' : null,
    defaultBranch: 'main',
    defaultBranchHead: {
      sha: hash40(`forge-main:${forge.repository}`),
      headline: 'Merge pull request #96 from octo-demo/fix/cache',
      committedAt: at(90),
      checks: (['success', 'failure', 'pending'] as const)[index % 3] ?? null,
    },
    license: forge.kind === 'github' ? 'MIT' : null,
    language: ['TypeScript', 'Go', 'Rust'][index % 3] ?? null,
    topics: index % 2 === 0 ? ['git', 'diff', 'agents'] : [],
    pushedAt: at(12),
    openRequests: requests.length + 9,
    openIssues: 14 + index,
    requests,
    requestsTruncated: true,
  };
}

// --- request detail --------------------------------------------------------------------------

const BODY = `## What

Adds a cache in front of the token endpoint, so a burst of requests asks the issuer once.

- keeps entries for **60 s** (\`CACHE_TTL\`)
- drops them on logout
- see #96 for the first attempt

## Checklist

- [x] tests
- [ ] docs

\`\`\`ts
const cached = cache.get(key) ?? (await issue(key));
\`\`\`

> Measured: p95 went from 180 ms to 12 ms.

| Before | After |
|---|---|
| 180 ms | 12 ms |

[Design notes](https://github.com/octo-demo/octopus-api/wiki/cache) · [a link that must stay inert](javascript:alert(1))

<script>alert('raw html is not rendered')</script>
<!-- an HTML comment the UI strips -->
`;

const IMAGE_BODY = `${BODY}
![chart of p95 latency](https://user-images.githubusercontent.com/1/latency.png)
![tracking pixel](https://evil.example/pixel.png)
`;

const CHECKS: ChangeRequestCheck[] = [
  {
    name: 'test (ubuntu)',
    group: 'CI',
    status: 'failure',
    description: '2 tests failed',
    url: 'https://github.com/octo-demo/x/actions/runs/1',
  },
  {
    name: 'deploy preview',
    group: 'Preview',
    status: 'action_required',
    description: 'Waiting for approval',
    url: null,
  },
  { name: 'test (windows)', group: 'CI', status: 'pending', description: null, url: null },
  { name: 'e2e', group: 'CI', status: 'pending', description: 'In progress', url: null },
  {
    name: 'lint',
    group: 'CI',
    status: 'success',
    description: null,
    url: 'https://github.com/octo-demo/x/actions/runs/2',
  },
  { name: 'typecheck', group: 'CI', status: 'success', description: null, url: null },
  { name: 'build', group: 'CI', status: 'success', description: null, url: null },
  { name: 'codeql', group: 'Security', status: 'neutral', description: 'No new alerts', url: null },
  { name: 'release notes', group: null, status: 'skipped', description: null, url: null },
  { name: 'flaky canary', group: 'Nightly', status: 'cancelled', description: null, url: null },
];

const REVIEWERS: ChangeRequestReviewer[][] = [
  [
    { actor: PEOPLE.ada, state: 'approved', stale: false },
    { actor: PEOPLE.linus, state: 'changes_requested', stale: false },
    { actor: PEOPLE.grace, state: 'approved', stale: true },
    { actor: PEOPLE.ken, state: 'pending', stale: false },
    { actor: PEOPLE.bot, state: 'commented', stale: false },
  ],
  [
    { actor: PEOPLE.grace, state: 'dismissed', stale: false },
    { actor: PEOPLE.ada, state: 'pending', stale: false },
  ],
  [],
];

/** The Request tab's data for a mock worktree. `localFiles` are its changed paths. */
export function mockDetail(
  wf: WorktreeForge,
  n: number,
  localFiles: readonly string[],
): ChangeRequestDetail | null {
  const cr = wf.changeRequest;
  if (!cr) return null;
  const checks = cr.checks === null ? [] : CHECKS.filter((_, i) => i < 4 + (n % 7));
  const files = [
    ...localFiles
      .slice(0, 3)
      .map((path) => ({ path, additions: 12, deletions: 3, change: 'modified' as const })),
    { path: 'src/cache/token.ts', additions: 88, deletions: 0, change: 'added' as const },
    { path: 'src/cache/legacy.ts', additions: 0, deletions: 41, change: 'removed' as const },
    { path: 'docs/cache.md', additions: 15, deletions: 2, change: 'renamed' as const },
  ];
  const commits = Array.from({ length: 4 + (n % 3) }, (_, i) => ({
    sha: hash40(`${cr.url}:commit:${i}`),
    headline: [
      'feat: cache tokens',
      'test: cover expiry',
      'fix: drop entries on logout',
      'docs: cache notes',
      'refactor: one clock',
      'chore: lint',
    ][i] as string,
    committedAt: at(600 - i * 70),
    authorName: 'Agent',
    authorLogin: 'agent-bot',
  }));
  const filesTotal = files.length + (n % 5 === 0 ? 140 : 0);
  return {
    ...cr,
    changedFiles: filesTotal,
    additions: files.reduce((sum, f) => sum + f.additions, 0) + (n % 5 === 0 ? 1200 : 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0) + (n % 5 === 0 ? 300 : 0),
    mergeState:
      cr.state === 'open'
        ? cr.draft
          ? 'draft'
          : checks.some((c) => c.status === 'failure')
            ? 'unstable'
            : (cr.mergeState ?? null)
        : null,
    body: n % 4 === 3 ? '' : n % 2 === 1 ? IMAGE_BODY : BODY,
    bodyTruncated: false,
    mergedAt: cr.state === 'merged' ? at(60) : null,
    closedAt: cr.state === 'closed' || cr.state === 'merged' ? at(60) : null,
    mergedBy: cr.state === 'merged' ? PEOPLE.ada : null,
    authorActor: PEOPLE.agent,
    labels: [
      { name: 'enhancement', color: 'a2eeef' },
      { name: 'size: M', color: 'fbca04' },
      ...(n % 2 === 0 ? [{ name: 'needs review', color: null }] : []),
    ],
    assignees: [PEOPLE.agent],
    reviewers: REVIEWERS[n % REVIEWERS.length] ?? [],
    checkList: checks,
    checksTruncated: false,
    commits,
    commitsTotal: commits.length + (n % 5 === 0 ? 120 : 0),
    files,
    filesTotal,
  };
}

// --- conversation ---------------------------------------------------------------------------

function comment(
  id: string,
  author: ForgeActor | null,
  body: string,
  minutes: number,
  url: string,
): ChangeRequestComment {
  return {
    id,
    author,
    body,
    bodyTruncated: false,
    createdAt: at(minutes),
    editedAt: null,
    url: `${url}#${id}`,
  };
}

export function mockConversation(wf: WorktreeForge, n: number): ChangeRequestConversation | null {
  const cr = wf.changeRequest;
  if (!cr) return null;
  const u = cr.url;
  const comments = [
    comment(
      'c1',
      PEOPLE.agent,
      'Opened by the agent. The cache lives in `src/cache/token.ts`.',
      580,
      u,
    ),
    comment(
      'c2',
      PEOPLE.bot,
      '**Coverage** 91.2% (+0.4%)\n\n<!-- bot marker: coverage v2 -->',
      560,
      u,
    ),
    comment('c3', PEOPLE.ada, 'Thanks. Can we keep the TTL configurable? Ticket: #96', 300, u),
    comment('c4', null, 'A comment from a deleted account.', 200, u),
    ...Array.from({ length: n % 3 === 0 ? 12 : 0 }, (_, i) =>
      comment(`cx${i}`, PEOPLE.ken, `Follow-up note ${i + 1}.`, 190 - i * 5, u),
    ),
  ];
  const reviews = [
    {
      ...comment(
        'r1',
        PEOPLE.linus,
        'The expiry check reads the wall clock twice; please use one `now`.',
        250,
        u,
      ),
      state: 'changes_requested' as const,
    },
    { ...comment('r2', PEOPLE.ada, 'Looks good to me.', 120, u), state: 'approved' as const },
    {
      ...comment('r3', PEOPLE.grace, 'Superseded by the new design.', 100, u),
      state: 'dismissed' as const,
    },
  ];
  const thread = (
    id: string,
    path: string,
    line: number,
    resolved: boolean,
    outdated: boolean,
    replies: ChangeRequestComment[],
    total?: number,
  ): ChangeRequestThread => ({
    id,
    path,
    line,
    side: 'right',
    resolved,
    outdated,
    comments: replies,
    commentsTotal: total ?? replies.length,
  });
  const threads = [
    thread('t1', 'src/cache/token.ts', 42, false, false, [
      comment('t1a', PEOPLE.linus, 'Two reads of `Date.now()` here can disagree.', 245, u),
      comment('t1b', PEOPLE.agent, 'Fixed in the next commit: one `now` per call.', 230, u),
    ]),
    thread('t2', 'src/cache/legacy.ts', 7, true, false, [
      comment('t2a', PEOPLE.ada, 'Delete this file entirely?', 240, u),
      comment('t2b', PEOPLE.agent, 'Done.', 235, u),
    ]),
    thread(
      't3',
      'docs/cache.md',
      3,
      false,
      true,
      [comment('t3a', PEOPLE.bot, 'Typo: "expirey".', 400, u)],
      n % 2 === 0 ? 14 : undefined,
    ),
  ];
  return {
    comments,
    reviews,
    threads,
    commentsTotal: comments.length,
    reviewsTotal: reviews.length,
    threadsTotal: threads.length,
    truncated: n % 2 === 0,
  };
}
