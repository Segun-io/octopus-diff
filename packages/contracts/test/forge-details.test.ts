import { describe, expect, it } from 'vitest';
import {
  AppSettingsPatchSchema,
  ChangeRequestConversationResponseSchema,
  ChangeRequestDetailResponseSchema,
  ChangeRequestSchema,
  ForgeSettingsSchema,
  GitRepositoryInfoSchema,
  RepositoriesQuerySchema,
  RepositoriesResponseSchema,
  RepositoryForgeResponseSchema,
} from '../src/index.js';

const BASE = {
  kind: 'github',
  number: 12,
  title: 'Add forges',
  url: 'https://github.com/o/r/pull/12',
  state: 'open',
  draft: false,
  author: 'octo',
  baseBranch: 'main',
  headBranch: 'feat/forges',
  headSha: 'a'.repeat(40),
  crossRepository: false,
  headRepository: 'o/r',
  updatedAt: '2026-11-08T10:00:00.000Z',
  checks: { state: 'pending', passed: 3, failed: 0, pending: 1, total: 4 },
  review: 'review_required',
  conflicts: false,
  comments: 2,
} as const;

const ACTOR = { login: 'octo', name: 'Octo Cat', avatarUrl: null, bot: false };

describe('request detail contracts', () => {
  it('ChangeRequest accepts old payloads and the new optional scalars', () => {
    expect(ChangeRequestSchema.parse(BASE)).toEqual(BASE);
    const extended = {
      ...BASE,
      createdAt: '2026-11-01T10:00:00.000Z',
      additions: 10,
      deletions: 2,
      changedFiles: 3,
      mergeState: 'blocked',
    };
    expect(ChangeRequestSchema.parse(extended)).toEqual(extended);
    expect(ChangeRequestSchema.safeParse({ ...BASE, mergeState: 'weird' }).success).toBe(false);
  });

  it('round-trips a detail response', () => {
    const response = {
      worktreeId: '0123456789abcdef',
      status: 'ok',
      message: null,
      fetchedAt: '2026-11-08T10:00:00.000Z',
      imageHosts: ['github.com', '*.githubusercontent.com'],
      request: {
        ...BASE,
        body: '# Hello',
        bodyTruncated: false,
        mergedAt: null,
        closedAt: null,
        mergedBy: null,
        authorActor: ACTOR,
        labels: [{ name: 'bug', color: 'd73a4a' }],
        assignees: [ACTOR],
        reviewers: [{ actor: ACTOR, state: 'approved', stale: true }],
        checkList: [
          {
            name: 'test',
            group: 'CI',
            status: 'action_required',
            description: null,
            url: 'https://github.com/o/r/actions/runs/1',
          },
        ],
        checksTruncated: false,
        commits: [
          {
            sha: 'b'.repeat(40),
            headline: 'feat: x',
            committedAt: '2026-11-08T09:00:00.000Z',
            authorName: 'Octo',
            authorLogin: 'octo',
          },
        ],
        commitsTotal: 1,
        files: [{ path: 'src/a.ts', additions: 1, deletions: 0, change: 'added' }],
        filesTotal: 1,
      },
    };
    expect(ChangeRequestDetailResponseSchema.parse(response)).toEqual(response);
    const bad = structuredClone(response);
    bad.request.labels[0] = { name: 'bug', color: '#d73a4a' };
    expect(ChangeRequestDetailResponseSchema.safeParse(bad).success).toBe(false);
  });

  it('round-trips a conversation response', () => {
    const comment = {
      id: 'IC_1',
      author: null,
      body: 'hi',
      bodyTruncated: false,
      createdAt: '2026-11-08T10:00:00.000Z',
      editedAt: null,
      url: null,
    };
    const response = {
      worktreeId: '0123456789abcdef',
      status: 'ok',
      message: null,
      fetchedAt: null,
      imageHosts: [],
      conversation: {
        comments: [comment],
        reviews: [{ ...comment, id: 'PRR_1', state: 'changes_requested' }],
        threads: [
          {
            id: 'T1',
            path: 'a.ts',
            line: 3,
            side: 'right',
            resolved: false,
            outdated: true,
            comments: [comment],
            commentsTotal: 12,
          },
        ],
        commentsTotal: 1,
        reviewsTotal: 1,
        threadsTotal: 1,
        truncated: true,
      },
    };
    expect(ChangeRequestConversationResponseSchema.parse(response)).toEqual(response);
  });

  it('round-trips repository responses', () => {
    const forge = {
      projectId: '0123456789abcdef',
      status: 'ok',
      message: null,
      forge: {
        kind: 'github',
        host: 'github.com',
        repository: 'o/r',
        webUrl: 'https://github.com/o/r',
        remoteName: 'origin',
        detectedBy: 'hostname',
      },
      fetchedAt: '2026-11-08T10:00:00.000Z',
      repository: {
        kind: 'github',
        host: 'github.com',
        repository: 'o/r',
        webUrl: 'https://github.com/o/r',
        description: null,
        visibility: 'public',
        archived: false,
        forkOf: null,
        defaultBranch: 'main',
        defaultBranchHead: {
          sha: 'c'.repeat(40),
          headline: 'x',
          committedAt: null,
          checks: 'success',
        },
        license: 'MIT',
        language: 'TypeScript',
        topics: ['git'],
        pushedAt: null,
        openRequests: 3,
        openIssues: null,
        requests: [
          {
            number: 1,
            title: 't',
            url: 'https://github.com/o/r/pull/1',
            draft: false,
            author: null,
            headBranch: 'h',
            baseBranch: 'main',
            crossRepository: true,
            updatedAt: null,
            checks: null,
            review: null,
            worktreeId: null,
          },
        ],
        requestsTruncated: true,
      },
    };
    expect(RepositoryForgeResponseSchema.parse(forge)).toEqual(forge);
    const local = {
      defaultBranch: {
        name: 'main',
        head: {
          sha: 'd'.repeat(40),
          subject: 's',
          authorName: 'A',
          authorDate: '2026-11-08T10:00:00.000Z',
        },
        upstream: 'origin/main',
        ahead: 0,
        behind: 2,
      },
      localBranches: 3,
      tags: 1,
      remotes: [{ name: 'origin', url: 'https://github.com/o/r.git', pushUrl: null }],
      lastActivityAt: null,
    };
    expect(GitRepositoryInfoSchema.parse(local)).toEqual(local);
    const list = {
      repositories: [{ projectId: '0123456789abcdef', info: local, error: null }],
      generatedAt: '2026-11-08T10:00:00.000Z',
    };
    expect(RepositoriesResponseSchema.parse(list)).toEqual(list);
  });

  it('limits the repositories query to valid, at most 200 ids', () => {
    expect(
      RepositoriesQuerySchema.parse({ projectIds: '0123456789abcdef,0123456789abcdef' }),
    ).toEqual({ projectIds: ['0123456789abcdef'] });
    expect(RepositoriesQuerySchema.safeParse({ projectIds: '' }).success).toBe(false);
    expect(RepositoriesQuerySchema.safeParse({ projectIds: 'nope' }).success).toBe(false);
    const many = Array.from({ length: 201 }, (_, i) => i.toString(16).padStart(16, '0'));
    expect(RepositoriesQuerySchema.safeParse({ projectIds: many.join(',') }).success).toBe(false);
  });

  it('forges.images is optional in settings and patches', () => {
    expect(ForgeSettingsSchema.parse({ enabled: true, hosts: {} })).toEqual({
      enabled: true,
      hosts: {},
    });
    expect(AppSettingsPatchSchema.parse({ forges: { images: false } })).toEqual({
      forges: { images: false },
    });
  });
});
