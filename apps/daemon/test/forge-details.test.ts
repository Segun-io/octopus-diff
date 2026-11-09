import path from 'node:path';
import {
  type ApiClient,
  type ChangeRequest,
  type ChangeRequestConversation,
  ChangeRequestConversationResponseSchema,
  type ChangeRequestDetail,
  ChangeRequestDetailResponseSchema,
  type ForgeCliStatus,
  type ForgeKind,
  type ForgeRepositoryInfo,
  type ProjectForge,
  RepositoriesResponseSchema,
  RepositoryForgeResponseSchema,
} from '@octopus-diff/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { type Daemon, startDaemon } from '../src/daemon.js';
import { type ForgeClientLike, type ForgeTargetLike, forgeImageHosts } from '../src/forges.js';
import { API_CSP, UI_CSP, uiCsp } from '../src/security.js';
import { FakeGitCore, type FakeRepo } from './fake-git-core.js';
import {
  client,
  eventually,
  http,
  onCleanup,
  startTestDaemon,
  TEST_TOKEN,
  tempDir,
} from './helpers.js';
import { makeRealGitFixture, makeRealRepo } from './real-git-fixture.js';

const NOW = '2026-11-08T10:00:00.000Z';

function cli(kind: ForgeKind, hosts: string[], available = true): ForgeCliStatus {
  return {
    kind,
    executable: kind === 'github' ? 'gh' : 'glab',
    available,
    version: available ? `${kind} 1.0` : null,
    auth: hosts.length > 0 ? 'authenticated' : 'unauthenticated',
    accounts: hosts.map((host) => ({ host, account: 'octo' })),
    hint: `install ${kind}`,
    detail: null,
    checkedAt: NOW,
  };
}

function pr(over: Partial<ChangeRequest>): ChangeRequest {
  return {
    kind: 'github',
    number: 7,
    title: 'Feature',
    url: 'https://github.com/org/alpha/pull/7',
    state: 'open',
    draft: false,
    author: 'octo',
    baseBranch: 'main',
    headBranch: 'feat',
    headSha: null,
    crossRepository: false,
    headRepository: 'org/alpha',
    updatedAt: NOW,
    checks: { state: 'pending', passed: 1, failed: 0, pending: 1, total: 2 },
    review: 'review_required',
    conflicts: false,
    comments: 0,
    ...over,
  };
}

function detailOf(cr: ChangeRequest): ChangeRequestDetail {
  return {
    ...cr,
    body: '# Hi',
    bodyTruncated: false,
    mergedAt: null,
    closedAt: null,
    mergedBy: null,
    labels: [],
    assignees: [],
    reviewers: [],
    checkList: [],
    checksTruncated: false,
    commits: [],
    commitsTotal: 0,
    files: [{ path: 'README.md', additions: 1, deletions: 0, change: 'modified' }],
    filesTotal: 1,
  };
}

const CONVERSATION: ChangeRequestConversation = {
  comments: [],
  reviews: [],
  threads: [],
  commentsTotal: 0,
  reviewsTotal: 0,
  threadsTotal: 0,
  truncated: false,
};

class FakeDetailClient implements ForgeClientLike {
  clis: Record<ForgeKind, ForgeCliStatus> = {
    github: cli('github', ['github.com']),
    gitlab: cli('gitlab', []),
  };
  requests = new Map<string, ChangeRequest[]>();
  batchFetches = 0;
  details: number[] = [];
  conversations: number[] = [];
  repositories: string[] = [];
  fail: string | null = null;
  gate: Promise<void> | null = null;
  missing = false;

  async probe(kind: ForgeKind) {
    return this.clis[kind];
  }
  async fetchChangeRequests(
    forge: Pick<ProjectForge, 'kind' | 'host' | 'repository'>,
    branches: readonly string[],
  ) {
    this.batchFetches += 1;
    return new Map(branches.map((b) => [b, this.requests.get(`${forge.repository}#${b}`) ?? []]));
  }
  async fetchDetail(_forge: ForgeTargetLike, number: number) {
    this.details.push(number);
    await this.gate;
    if (this.fail) throw new Error(this.fail);
    if (this.missing) return null;
    const cr = [...this.requests.values()].flat().find((r) => r.number === number);
    return cr ? detailOf(cr) : null;
  }
  async fetchConversation(_forge: ForgeTargetLike, number: number) {
    this.conversations.push(number);
    if (this.fail) throw new Error(this.fail);
    return CONVERSATION;
  }
  async fetchRepository(forge: ForgeTargetLike): Promise<ForgeRepositoryInfo> {
    this.repositories.push(forge.repository);
    if (this.fail) throw new Error(this.fail);
    const open = (number: number) => ({
      number,
      title: `PR ${number}`,
      url: `https://github.com/${forge.repository}/pull/${number}`,
      draft: false,
      author: 'octo',
      headBranch: `b${number}`,
      baseBranch: 'main',
      crossRepository: false,
      updatedAt: NOW,
      checks: null,
      review: null,
      worktreeId: null,
    });
    return {
      kind: forge.kind,
      host: forge.host,
      repository: forge.repository,
      webUrl: forge.webUrl,
      description: 'Alpha',
      visibility: 'public',
      archived: false,
      forkOf: null,
      defaultBranch: 'main',
      defaultBranchHead: null,
      license: 'MIT',
      language: 'TypeScript',
      topics: [],
      pushedAt: NOW,
      openRequests: 3,
      openIssues: 1,
      requests: [open(7), open(8)],
      requestsTruncated: true,
    };
  }
}

describe('request detail and repository routes (fake git-core, fake gh)', () => {
  let fake: FakeGitCore;
  let forge: FakeDetailClient;
  let daemon: Daemon;
  let api: ApiClient;
  let alpha: FakeRepo;
  let beta: FakeRepo;
  let clock: number;

  const featId = () => alpha.worktrees[1]?.id ?? '';

  beforeEach(async () => {
    fake = new FakeGitCore();
    forge = new FakeDetailClient();
    const base = await tempDir();
    alpha = await fake.createRepo(base, 'alpha', { linked: ['feat', 'other'] });
    beta = await fake.createRepo(base, 'beta', { linked: ['wip'] });
    fake.remoteConfigs.set(alpha.commonDir, {
      remotes: [
        {
          name: 'origin',
          url: 'https://github.com/org/alpha.git',
          pushUrl: null,
          ghResolved: null,
        },
      ],
      branches: {},
      pushDefault: null,
    });
    forge.requests.set('org/alpha#feat', [pr({})]);
    clock = 0;
    daemon = await startTestDaemon({
      fake,
      stateDir: await tempDir(),
      projects: [alpha.mainPath, beta.mainPath],
      internal: {
        forges: { client: forge, debounceMs: 20, readSshConfig: async () => null },
        now: () => new Date(Date.now() + clock),
      },
    });
    api = client(daemon);
    await eventually(async () => {
      const forges = await api.getForges();
      const a = forges.projects.find((p) => p.projectId === alpha.projectId);
      expect(a?.worktrees.find((w) => w.worktreeId === featId())?.changeRequest?.number).toBe(7);
      return true;
    });
  });

  it('serves the detail of the matched request, cached and deduped', async () => {
    const [one, two] = await Promise.all([
      api.getChangeRequest(featId()),
      api.getChangeRequest(featId()),
    ]);
    expect(ChangeRequestDetailResponseSchema.parse(one)).toEqual(one);
    expect(one.status).toBe('ok');
    expect(one.request?.number).toBe(7);
    expect(two.request?.number).toBe(7);
    expect(forge.details).toEqual([7]);
    expect(one.imageHosts).toEqual(['*.githubusercontent.com', 'github.com']);
    // Fresh for 60 s.
    clock += 30_000;
    await api.getChangeRequest(featId());
    expect(forge.details).toEqual([7]);
    clock += 31_000;
    await api.getChangeRequest(featId());
    expect(forge.details).toEqual([7, 7]);
  });

  it('a forced refresh is spaced 15 s; errors keep the last good data', async () => {
    await api.getChangeRequest(featId());
    expect(forge.details).toEqual([7]);
    await api.refreshChangeRequest(featId());
    expect(forge.details).toEqual([7]); // under 15 s
    clock += 16_000;
    forge.fail = 'HTTP 502';
    const stale = await api.refreshChangeRequest(featId());
    expect(forge.details).toEqual([7, 7]);
    expect(stale.status).toBe('ok');
    expect(stale.request?.number).toBe(7);
    expect(stale.message).toBe('HTTP 502');
  });

  it('answers no-request for worktrees without a request and 404 for unknown ids', async () => {
    const other = alpha.worktrees[2]?.id ?? '';
    const none = await api.getChangeRequest(other);
    expect(none).toMatchObject({ status: 'no-request', request: null });
    const betaWip = beta.worktrees[1]?.id ?? '';
    expect((await api.getChangeRequest(betaWip)).status).toBe('no-request');
    await expect(api.getChangeRequest('0123456789abcdef')).rejects.toMatchObject({ status: 404 });
    await expect(api.getRepositoryForge('0123456789abcdef')).rejects.toMatchObject({
      status: 404,
    });
    const bad = await http(daemon, '/api/forges/worktrees/not-an-id/request');
    expect(bad.status).toBe(400);
    expect(forge.details).toEqual([]);
  });

  it('a failing first fetch is unavailable; a request gone from the forge is no-request', async () => {
    forge.fail = 'boom';
    const failed = await api.getChangeRequest(featId());
    expect(failed).toMatchObject({ status: 'unavailable', message: 'boom', request: null });
    // Retried only after the 15 s spacing.
    forge.fail = null;
    forge.missing = true;
    expect((await api.getChangeRequest(featId())).status).toBe('unavailable');
    clock += 16_000;
    expect((await api.getChangeRequest(featId())).status).toBe('no-request');
    expect(forge.details).toEqual([7, 7]);
  });

  it('serves the conversation separately and lazily', async () => {
    await api.getChangeRequest(featId());
    expect(forge.conversations).toEqual([]);
    const conversation = await api.getChangeRequestConversation(featId());
    expect(ChangeRequestConversationResponseSchema.parse(conversation).status).toBe('ok');
    expect(forge.conversations).toEqual([7]);
  });

  it('signed out or disabled: unavailable / no-request, nothing fetched', async () => {
    forge.clis.github = cli('github', []);
    clock += 31_000; // a forced refresh re-probes CLIs older than 30 s
    await api.refreshForges();
    const out = await api.getChangeRequest(featId());
    expect(out.status).toBe('unavailable');
    expect(out.message).toContain('gh auth login');
    expect((await api.getRepositoryForge(alpha.projectId)).status).toBe('unauthenticated');
    forge.clis.github = cli('github', [], false);
    clock += 31_000;
    await api.refreshForges();
    expect((await api.getRepositoryForge(alpha.projectId)).status).toBe('cli-missing');
    await api.updateSettings({ forges: { enabled: false } });
    const off = await api.getChangeRequest(featId());
    expect(off).toMatchObject({ status: 'no-request', imageHosts: [] });
    expect((await api.getRepositoryForge(alpha.projectId)).status).toBe('disabled');
    expect(forge.details).toEqual([]);
    expect(forge.repositories).toEqual([]);
  });

  it('repository info joins open requests to worktrees and caches 10 min', async () => {
    const first = RepositoryForgeResponseSchema.parse(
      await api.getRepositoryForge(alpha.projectId),
    );
    expect(first.status).toBe('ok');
    expect(first.repository?.requests.map((r) => [r.number, r.worktreeId])).toEqual([
      [7, featId()],
      [8, null],
    ]);
    clock += 5 * 60_000;
    await api.getRepositoryForge(alpha.projectId);
    expect(forge.repositories).toEqual(['org/alpha']);
    await api.refreshRepositoryForge(alpha.projectId);
    expect(forge.repositories).toEqual(['org/alpha', 'org/alpha']);
    // A project without a forge: its status, no query.
    expect((await api.getRepositoryForge(beta.projectId)).status).toBe('no-forge');
    expect(forge.repositories).toEqual(['org/alpha', 'org/alpha']);
  });

  it('the folder Overview route runs no forge query', async () => {
    const before = { batch: forge.batchFetches, repos: forge.repositories.length };
    fake.repositoryInfo = async () => ({
      defaultBranch: null,
      localBranches: 2,
      tags: 0,
      remotes: [],
      lastActivityAt: null,
    });
    const body = RepositoriesResponseSchema.parse(
      await api.listRepositories([alpha.projectId, beta.projectId, '0123456789abcdef']),
    );
    expect(body.repositories.map((r) => [r.info?.localBranches ?? null, r.error])).toEqual([
      [2, null],
      [2, null],
      [null, 'unknown project'],
    ]);
    expect({ batch: forge.batchFetches, repos: forge.repositories.length }).toEqual(before);
  });

  it('relaxes the UI CSP to the signed-in forge hosts; images off restores the strict policy', async () => {
    const webRoot = await tempDir();
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(webRoot, 'index.html'), '<!doctype html><title>ui</title>');
    const withUi = await startTestDaemon({
      fake,
      stateDir: await tempDir(),
      webRoot,
      projects: [alpha.mainPath],
      internal: { forges: { client: forge, debounceMs: 20, readSshConfig: async () => null } },
    });
    await client(withUi).getForges();
    await eventually(async () => {
      const res = await http(withUi, '/');
      expect(res.headers.get('content-security-policy')).toContain(
        "img-src 'self' data: blob: https://*.githubusercontent.com https://github.com",
      );
      return true;
    });
    const apiRes = await http(withUi, '/api/forges');
    expect(apiRes.headers.get('content-security-policy')).toBe(API_CSP);
    await client(withUi).updateSettings({ forges: { images: false } });
    const strict = await http(withUi, '/');
    expect(strict.headers.get('content-security-policy')).toBe(UI_CSP);
  });
});

describe('CSP builder and image hosts', () => {
  it('lists validated hosts only and never injects directives', () => {
    expect(uiCsp([])).toBe(UI_CSP);
    const relaxed = uiCsp(['github.com', '*.githubusercontent.com']);
    expect(relaxed).toContain(
      "img-src 'self' data: blob: https://*.githubusercontent.com https://github.com;",
    );
    expect(relaxed.replace(/img-src[^;]*/, '')).toBe(UI_CSP.replace(/img-src[^;]*/, ''));
    const hostile = uiCsp(["evil.com; script-src 'unsafe-inline'", '*', 'a b', 'HOST.COM']);
    expect(hostile).toBe(UI_CSP);
  });

  it('maps CLI logins to image hosts per forge, honouring the settings', () => {
    const clis = [
      cli('github', ['github.com', 'ghe.acme.io']),
      cli('gitlab', ['gitlab.example.com:8443']),
      cli('gitlab', ['Bad Host']),
    ];
    expect(forgeImageHosts({ enabled: true, hosts: {} }, clis)).toEqual([
      '*.ghe.acme.io',
      '*.githubusercontent.com',
      'ghe.acme.io',
      'github.com',
      'gitlab.example.com:8443',
      'secure.gravatar.com',
    ]);
    expect(forgeImageHosts({ enabled: true, hosts: {}, images: false }, clis)).toEqual([]);
    expect(forgeImageHosts({ enabled: false, hosts: {} }, clis)).toEqual([]);
    expect(
      forgeImageHosts({ enabled: true, hosts: { 'ghe.acme.io': 'none' } }, [
        clis[0] as ForgeCliStatus,
      ]),
    ).toEqual(['*.githubusercontent.com', 'github.com']);
  });
});

describe('repositories route (real git)', () => {
  it('returns local facts with credentials stripped from remote URLs', async () => {
    const fx = await makeRealGitFixture();
    const repo = await makeRealRepo(fx, 'creds', { 'README.md': '# x\n' });
    fx.git(repo, 'tag', 'v1');
    fx.git(repo, 'branch', 'feat/x');
    fx.git(repo, 'remote', 'add', 'origin', 'https://octo:hunter2@git.example.invalid/o/r.git');
    const daemon = await startDaemon({
      host: '127.0.0.1',
      port: 0,
      token: TEST_TOKEN,
      stateDir: await tempDir(),
      logLevel: 'silent',
      git: { env: fx.env },
      watch: { debounceMs: 150 },
      projects: [repo],
      internal: { forges: false },
    });
    onCleanup(() => daemon.close());
    const api = client(daemon);
    const { projects } = await api.listProjects();
    const id = projects[0]?.project.id ?? '';
    const res = await http(daemon, `/api/repositories?projectIds=${id}`);
    const text = await res.text();
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('octo:');
    const body = RepositoriesResponseSchema.parse(JSON.parse(text));
    expect(body.repositories[0]?.info).toMatchObject({
      localBranches: 2,
      tags: 1,
      remotes: [{ name: 'origin', url: 'https://git.example.invalid/o/r.git', pushUrl: null }],
      defaultBranch: { name: 'main', upstream: null },
    });
    const tooMany = Array.from({ length: 201 }, (_, i) => i.toString(16).padStart(16, '0'));
    expect((await http(daemon, `/api/repositories?projectIds=${tooMany.join(',')}`)).status).toBe(
      400,
    );
    expect((await http(daemon, '/api/repositories')).status).toBe(400);
  });
});
