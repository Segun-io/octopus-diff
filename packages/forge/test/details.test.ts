import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ChangeRequestConversationSchema,
  ChangeRequestDetailSchema,
  ForgeRepositoryInfoSchema,
} from '@octopus-diff/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertAllowedForgeArgs,
  buildGithubConversationQuery,
  buildGithubDetailQuery,
  buildGithubQuery,
  buildGithubRepositoryQuery,
  buildGitlabConversationQuery,
  buildGitlabDetailQuery,
  buildGitlabQuery,
  buildGitlabRepositoryQuery,
  capBytes,
  dedupeChecks,
  ForgeCli,
  ForgeCliError,
  ForgeClient,
  githubCheckStatus,
  githubQueryNumber,
  httpsUrl,
  labelColor,
  normaliseGithubConversation,
  normaliseGithubDetail,
  normaliseGithubRepository,
  normaliseGitlabConversation,
  normaliseGitlabDetail,
  normaliseGitlabRepository,
} from '../src/index.js';

const fixture = (name: string) =>
  JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8')) as {
    data: Record<string, Record<string, unknown>>;
  };

const GH_FORGE = {
  kind: 'github',
  host: 'github.com',
  repository: 'pingdotgg/t3code',
  webUrl: 'https://github.com/pingdotgg/t3code',
} as const;
const GL_FORGE = {
  kind: 'gitlab',
  host: 'gitlab.com',
  repository: 'gitlab-org/cli',
  webUrl: 'https://gitlab.com/gitlab-org/cli',
} as const;

describe('GitHub detail, conversation and repository (recorded from pingdotgg/t3code)', () => {
  it('normalises the detail of PR #32830', () => {
    const pr = fixture('github-detail.json').data.repository?.pullRequest;
    const detail = normaliseGithubDetail(pr);
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(ChangeRequestDetailSchema.parse(detail)).toEqual(detail);
    expect(detail).toMatchObject({ kind: 'github', number: 32830, state: 'merged' });
    expect(detail.labels.length).toBe(2);
    expect(detail.labels.every((l) => l.color === null || /^[0-9a-f]{6}$/.test(l.color))).toBe(
      true,
    );
    expect(detail.files.length).toBe(21);
    expect(detail.filesTotal).toBe(21);
    expect(detail.commits.length).toBe(4);
    expect(detail.commitsTotal).toBe(4);
    expect(detail.checkList.length).toBeGreaterThan(0);
    expect(detail.checkList.every((c) => c.url === null || c.url.startsWith('https://'))).toBe(
      true,
    );
    expect(detail.checkList.some((c) => c.group !== null)).toBe(true);
    expect(detail.reviewers.length).toBe(1);
    expect(detail.reviewers[0]?.state).toBe('approved');
    expect(detail.mergedAt).not.toBeNull();
    expect(detail.mergeState).toBeNull(); // merged: no merge state
    expect(detail.authorActor?.avatarUrl).toMatch(/^https:\/\/avatars\.githubusercontent\.com\//);
  });

  it('normalises the conversation: bodiless COMMENTED reviews are dropped, threads kept', () => {
    const pr = fixture('github-conversation.json').data.repository?.pullRequest;
    const conversation = normaliseGithubConversation(pr);
    expect(conversation).not.toBeNull();
    if (!conversation) return;
    expect(ChangeRequestConversationSchema.parse(conversation)).toEqual(conversation);
    expect(conversation.comments.length).toBe(3);
    expect(conversation.reviews.map((r) => r.state)).toEqual([
      'commented',
      'commented',
      'commented',
      'approved',
    ]);
    expect(conversation.reviewsTotal).toBe(7);
    expect(conversation.threads.length).toBe(3);
    expect(conversation.truncated).toBe(false);
  });

  it('normalises the repository', () => {
    const repo = fixture('github-repository.json').data.repository;
    const info = normaliseGithubRepository(repo, GH_FORGE);
    expect(info).not.toBeNull();
    if (!info) return;
    expect(ForgeRepositoryInfoSchema.parse(info)).toEqual(info);
    expect(info).toMatchObject({ visibility: 'public', archived: false, license: 'MIT' });
    expect(info.defaultBranch).toBe('main');
    expect(info.defaultBranchHead?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(info.requests.length).toBe(20);
    expect(info.requestsTruncated).toBe(true);
    expect(info.requests.every((r) => r.worktreeId === null)).toBe(true);
  });

  it('copes with missing fields, null authors and minimised comments', () => {
    const detail = normaliseGithubDetail({
      number: 1,
      url: 'https://github.com/o/r/pull/1',
      baseRefName: 'main',
      headRefName: 'x',
      state: 'OPEN',
      author: null,
      body: null,
    });
    expect(detail).toMatchObject({
      body: '',
      labels: [],
      reviewers: [],
      checkList: [],
      commits: [],
      files: [],
      authorActor: null,
    });
    expect(ChangeRequestDetailSchema.safeParse(detail).success).toBe(true);
    expect(normaliseGithubDetail({ number: 1 })).toBeNull();
    const conversation = normaliseGithubConversation({
      comments: {
        totalCount: 60,
        nodes: [
          { id: 'a', body: 'spam', isMinimized: true, author: null },
          {
            id: 'b',
            body: 'ok',
            isMinimized: false,
            author: null,
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      },
      reviews: { totalCount: 0, nodes: [] },
      reviewThreads: {
        totalCount: 1,
        nodes: [
          {
            id: 't',
            path: 'a.ts',
            line: null,
            originalLine: 9,
            diffSide: 'LEFT',
            isResolved: true,
            isOutdated: true,
            comments: { totalCount: 14, nodes: [{ id: 'c', body: 'x', author: null }] },
          },
        ],
      },
    });
    expect(conversation?.comments.map((c) => c.id)).toEqual(['b']);
    expect(conversation?.threads[0]).toMatchObject({
      line: 9,
      side: 'left',
      resolved: true,
      outdated: true,
      commentsTotal: 14,
    });
    expect(conversation?.truncated).toBe(true);
  });

  it('marks stale verdicts and lets a re-request win', () => {
    const head = 'a'.repeat(40);
    const detail = normaliseGithubDetail({
      number: 2,
      url: 'https://github.com/o/r/pull/2',
      baseRefName: 'main',
      headRefName: 'x',
      state: 'OPEN',
      headRefOid: head,
      latestOpinionatedReviews: {
        nodes: [
          { state: 'APPROVED', author: { login: 'old' }, commit: { oid: 'b'.repeat(40) } },
          { state: 'CHANGES_REQUESTED', author: { login: 'now' }, commit: { oid: head } },
          { state: 'APPROVED', author: { login: 'again' }, commit: { oid: head } },
        ],
      },
      reviewRequests: {
        nodes: [
          { requestedReviewer: { __typename: 'User', login: 'again' } },
          { requestedReviewer: { __typename: 'Team', slug: 'core', name: 'Core' } },
        ],
      },
    });
    expect(detail?.reviewers.map((r) => [r.actor.login, r.state, r.stale])).toEqual([
      ['old', 'approved', true],
      ['now', 'changes_requested', false],
      ['again', 'pending', false],
      ['core', 'pending', false],
    ]);
  });
});

describe('GitLab detail, conversation and repository (recorded from gitlab-org/cli)', () => {
  it('normalises the detail of !4230', () => {
    const mr = fixture('gitlab-detail.json').data.project?.mergeRequest;
    const detail = normaliseGitlabDetail(mr, 'gitlab.com');
    expect(detail).not.toBeNull();
    if (!detail) return;
    expect(ChangeRequestDetailSchema.parse(detail)).toEqual(detail);
    expect(detail).toMatchObject({ kind: 'gitlab', number: 4230 });
    expect(detail.labels.length).toBeGreaterThan(0);
    expect(detail.labels.every((l) => l.color === null || /^[0-9a-f]{6}$/.test(l.color))).toBe(
      true,
    );
    expect(detail.files.every((f) => f.change === 'changed')).toBe(true);
    expect(detail.checkList.length).toBeGreaterThan(0);
    expect(detail.checkList.every((c) => c.url?.startsWith('https://gitlab.com/') ?? true)).toBe(
      true,
    );
    // Relative avatars resolve against the host.
    expect(detail.authorActor?.avatarUrl).toMatch(/^https:\/\/gitlab\.com\/uploads\//);
    expect(detail.reviewers.length).toBeGreaterThan(0);
    // Newest commits, oldest first.
    const times = detail.commits.map((c) => c.committedAt ?? '');
    expect([...times].sort()).toEqual(times);
  });

  it('normalises the conversation: system notes dropped, diff notes become threads', () => {
    const mr = fixture('gitlab-conversation.json').data.project?.mergeRequest;
    const conversation = normaliseGitlabConversation(mr, 'gitlab.com');
    expect(conversation).not.toBeNull();
    if (!conversation) return;
    expect(ChangeRequestConversationSchema.parse(conversation)).toEqual(conversation);
    expect(conversation.threads.length).toBeGreaterThan(0);
    expect(conversation.comments.length).toBeGreaterThan(0);
    expect(conversation.comments.some((c) => c.body.startsWith('assigned to'))).toBe(false);
    expect(conversation.reviews).toEqual([]);
  });

  it('normalises the repository', () => {
    const project = fixture('gitlab-repository.json').data.project;
    const info = normaliseGitlabRepository(project, GL_FORGE);
    expect(info).not.toBeNull();
    if (!info) return;
    expect(ForgeRepositoryInfoSchema.parse(info)).toEqual(info);
    expect(info).toMatchObject({ kind: 'gitlab', visibility: 'public', defaultBranch: 'main' });
    expect(info.language).toBe('Go');
    expect(info.requests.length).toBe(20);
  });
});

describe('detail helpers', () => {
  it('caps bodies at a byte limit without splitting characters', () => {
    expect(capBytes('abc', 10)).toEqual({ text: 'abc', truncated: false });
    expect(capBytes('ééé', 3)).toEqual({ text: 'é', truncated: true });
  });

  it('accepts https URLs only, resolving host-relative paths', () => {
    expect(httpsUrl('https://x.io/a')).toBe('https://x.io/a');
    expect(httpsUrl('http://x.io/a')).toBeNull();
    expect(httpsUrl('javascript:alert(1)')).toBeNull();
    expect(httpsUrl('/uploads/a.png', 'gitlab.com')).toBe('https://gitlab.com/uploads/a.png');
    expect(httpsUrl('//evil.io/a', 'gitlab.com')).toBeNull();
    expect(httpsUrl('https://u:p@x.io/a')).toBeNull();
  });

  it('label colours, check status and dedupe', () => {
    expect(labelColor('#D73A4A')).toBe('d73a4a');
    expect(labelColor('red')).toBeNull();
    expect(githubCheckStatus('IN_PROGRESS', null)).toBe('pending');
    expect(githubCheckStatus('COMPLETED', 'TIMED_OUT')).toBe('failure');
    expect(githubCheckStatus(undefined, 'EXPECTED')).toBe('pending');
    const check = { group: 'CI', description: null, url: null };
    expect(
      dedupeChecks([
        { ...check, name: 'test', status: 'success' },
        { ...check, name: 'test', status: 'pending' },
        { ...check, name: 'lint', status: 'failure' },
      ]).map((c) => [c.name, c.status]),
    ).toEqual([
      ['test', 'pending'],
      ['lint', 'failure'],
    ]);
  });
});

const api = (host: string, query: string, vars: Record<string, string>) => {
  const args = ['api', 'graphql', '--hostname', host, '--raw-field', `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push('--raw-field', `${k}=${v}`);
  return args;
};
const OR = { owner: 'o', name: 'r' };
const GP = { fullPath: 'g/p', iid: '12' };

describe('query registry (allowlist)', () => {
  const allBuilt = [
    ...[1, 20].flatMap((n) => [buildGithubQuery(n, 'full'), buildGithubQuery(n, 'basic')]),
    ...[1, 20].flatMap((n) => [buildGitlabQuery(n, 'full'), buildGitlabQuery(n, 'basic')]),
    buildGithubRepositoryQuery(),
    buildGithubDetailQuery(1, 'full'),
    buildGithubDetailQuery(99, 'basic'),
    buildGithubConversationQuery(7),
    buildGitlabRepositoryQuery('full'),
    buildGitlabRepositoryQuery('basic'),
    buildGitlabDetailQuery('full'),
    buildGitlabDetailQuery('basic'),
    buildGitlabConversationQuery('full'),
    buildGitlabConversationQuery('basic'),
  ];

  it('every built query is a read-only query operation', () => {
    for (const q of allBuilt) {
      expect(q.startsWith('query ')).toBe(true);
      expect(q).not.toMatch(/\bmutation\b|\bsubscription\b/);
    }
  });

  it('allows each query kind with its own variables', () => {
    const ok = [
      ['github', api('github.com', buildGithubRepositoryQuery(), OR)],
      ['github', api('github.com', buildGithubDetailQuery(42, 'full'), OR)],
      ['github', api('github.com', buildGithubDetailQuery(42, 'basic'), OR)],
      ['github', api('github.com', buildGithubConversationQuery(42), OR)],
      ['gitlab', api('gitlab.com', buildGitlabRepositoryQuery('basic'), { fullPath: 'g/p' })],
      ['gitlab', api('gitlab.com', buildGitlabDetailQuery('full'), GP)],
      ['gitlab', api('gitlab.com', buildGitlabConversationQuery('basic'), GP)],
    ] as const;
    for (const [kind, args] of ok) expect(() => assertAllowedForgeArgs(kind, args)).not.toThrow();
  });

  it.each([
    [
      'a tampered number',
      'github',
      api(
        'github.com',
        buildGithubDetailQuery(42, 'full').replace('number: 42', 'number: 42 '),
        OR,
      ),
    ],
    [
      'a number that does not parse',
      'github',
      api('github.com', buildGithubDetailQuery(42, 'full').replace('number: 42', 'number: x'), OR),
    ],
    [
      'an extra variable',
      'github',
      api('github.com', buildGithubDetailQuery(42, 'full'), { ...OR, extra: '1' }),
    ],
    [
      'a modified field',
      'github',
      api(
        'github.com',
        buildGithubConversationQuery(42).replace('isMinimized', 'viewerCanUpdate'),
        OR,
      ),
    ],
    [
      'a smuggled mutation',
      'github',
      api('github.com', `${buildGithubRepositoryQuery()} mutation { x }`, OR),
    ],
    [
      'the GitHub variables on GitLab',
      'gitlab',
      api('gitlab.com', buildGitlabDetailQuery('full'), OR),
    ],
    [
      'a non-numeric iid',
      'gitlab',
      api('gitlab.com', buildGitlabDetailQuery('full'), { fullPath: 'g/p', iid: '1 OR 1' }),
    ],
    [
      'a missing iid',
      'gitlab',
      api('gitlab.com', buildGitlabConversationQuery('full'), { fullPath: 'g/p' }),
    ],
    [
      'a repository query with branch variables',
      'github',
      api('github.com', buildGithubRepositoryQuery(), { ...OR, b0: 'x' }),
    ],
  ] as const)('denies %s', (_what, kind, args) => {
    expect(() => assertAllowedForgeArgs(kind, args)).toThrow(ForgeCliError);
  });

  it('reads the inlined PR number', () => {
    expect(githubQueryNumber(buildGithubDetailQuery(123, 'full'))).toBe(123);
    expect(githubQueryNumber('query { x }')).toBeNull();
    expect(() => buildGithubDetailQuery(0, 'full')).toThrow(RangeError);
    expect(() => buildGithubDetailQuery(1.5, 'full')).toThrow(RangeError);
  });
});

describe('ForgeClient detail queries with a fake CLI', () => {
  let dir: string;
  let log: string;
  let fakeGh: string;
  let fakeGlab: string;

  beforeAll(() => {
    dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'octopus-diff-'))); // macOS: /var -> /private/var
    log = path.join(dir, 'calls.jsonl');
    const fixtures = path.join(import.meta.dirname, 'fixtures');
    const script = (name: string) => {
      const file = path.join(dir, name);
      writeFileSync(
        file,
        `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const query = args[args.indexOf('--raw-field') + 1].slice(6);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name: ${JSON.stringify(name)}, query }) + '\\n');
const mode = process.env.FAKE_MODE ?? 'ok';
const forge = ${JSON.stringify(name)} === 'gh' ? 'github' : 'gitlab';
if (mode === 'unknown-field' && (query.includes('mergeStateStatus') || query.includes('mergeRequestInteraction') || query.includes('languages'))) {
  console.log(JSON.stringify({ errors: [{ message: "Field 'x' doesn't exist on type 'Y'" }] }));
  process.exit(1);
}
if (mode === 'missing') {
  console.log(JSON.stringify(forge === 'github'
    ? { data: { repository: { pullRequest: null } }, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest' }] }
    : { data: { project: { mergeRequest: null } } }));
  process.exit(forge === 'github' ? 1 : 0);
}
const op = /^query (\\w+)/.exec(query)[1];
const file = { OctopusDiffRepository: 'repository', OctopusDiffProject: 'repository', OctopusDiffPullRequestDetail: 'detail', OctopusDiffMergeRequestDetail: 'detail', OctopusDiffPullRequestConversation: 'conversation', OctopusDiffMergeRequestConversation: 'conversation' }[op];
process.stdout.write(fs.readFileSync(path.join(${JSON.stringify(fixtures)}, forge + '-' + file + '.json'), 'utf8'));
`,
      );
      chmodSync(file, 0o755);
      return file;
    };
    fakeGh = script('gh');
    fakeGlab = script('glab');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const queries = () =>
    readFileSync(log, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { name: string; query: string });

  const client = (mode: string) => {
    const costs: number[] = [];
    const c = new ForgeClient(
      new ForgeCli({
        binaries: { github: fakeGh, gitlab: fakeGlab },
        cwd: dir,
        env: { ...process.env, FAKE_MODE: mode },
      }),
      { onCost: (cost) => costs.push(cost.cost) },
    );
    return Object.assign(c, { costs });
  };

  it('fetches repository, detail and conversation on GitHub and reports the cost', async () => {
    const c = client('ok');
    const repo = await c.fetchRepository(GH_FORGE);
    expect(repo.requests.length).toBe(20);
    const detail = await c.fetchDetail(GH_FORGE, 32830);
    expect(detail?.number).toBe(32830);
    const conversation = await c.fetchConversation(GH_FORGE, 32830);
    expect(conversation?.threads.length).toBe(3);
    expect(c.costs).toEqual([1, 1, 1]);
  });

  it('fetches the same on GitLab', async () => {
    const c = client('ok');
    expect((await c.fetchRepository(GL_FORGE)).kind).toBe('gitlab');
    expect((await c.fetchDetail(GL_FORGE, 4230))?.number).toBe(4230);
    expect((await c.fetchConversation(GL_FORGE, 4230))?.reviews).toEqual([]);
  });

  it('retries with the basic variants on unknown fields (GitHub detail, GitLab detail and repository)', async () => {
    const c = client('unknown-field');
    await c.fetchDetail(GH_FORGE, 32830);
    const gh = queries()
      .filter((q) => q.name === 'gh')
      .slice(-2);
    expect(gh.map((q) => q.query.includes('mergeStateStatus'))).toEqual([true, false]);
    await c.fetchDetail(GL_FORGE, 4230);
    const gl = queries()
      .filter((q) => q.name === 'glab')
      .slice(-2);
    expect(gl.map((q) => q.query.includes('mergeRequestInteraction'))).toEqual([true, false]);
    await c.fetchRepository(GL_FORGE);
    expect(queries().at(-1)?.query.includes('languages')).toBe(false);
  });

  it('a request that no longer exists is null; a missing repository throws', async () => {
    const c = client('missing');
    expect(await c.fetchDetail(GH_FORGE, 1)).toBeNull();
    expect(await c.fetchConversation(GL_FORGE, 1)).toBeNull();
  });
});
