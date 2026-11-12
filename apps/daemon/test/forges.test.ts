import {
  type ApiClient,
  type ChangeRequest,
  type ForgeCliStatus,
  type ForgeKind,
  type ForgesResponse,
  ForgesResponseSchema,
  type ProjectForge,
} from '@octopus-diff/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Daemon } from '../src/daemon.js';
import type { ForgeClientLike } from '../src/forges.js';
import { FakeGitCore, type FakeRepo } from './fake-git-core.js';
import { client, eventually, recordEvents, startTestDaemon, tempDir } from './helpers.js';

const NOW = '2026-11-08T10:00:00.000Z';

function cli(kind: ForgeKind, hosts: string[], available = true): ForgeCliStatus {
  return {
    kind,
    executable: kind === 'github' ? 'gh' : 'glab',
    available,
    version: available ? `${kind} 1.0` : null,
    auth: hosts.length > 0 ? 'authenticated' : 'unauthenticated',
    accounts: hosts.map((host) => ({ host, account: 'octo' })),
    hint: `sign in to ${kind}`,
    detail: null,
    checkedAt: NOW,
  };
}

function pr(over: Partial<ChangeRequest>): ChangeRequest {
  return {
    kind: 'github',
    number: 1,
    title: 'Change',
    url: 'https://github.com/org/alpha/pull/1',
    state: 'open',
    draft: false,
    author: 'octo',
    baseBranch: 'main',
    headBranch: 'feat',
    headSha: null,
    crossRepository: false,
    headRepository: 'org/alpha',
    updatedAt: NOW,
    checks: null,
    review: null,
    conflicts: null,
    comments: null,
    ...over,
  };
}

class FakeForgeClient implements ForgeClientLike {
  clis: Record<ForgeKind, ForgeCliStatus> = {
    github: cli('github', ['github.com']),
    gitlab: cli('gitlab', ['git.acme.io']),
  };
  probes = 0;
  fetches: Array<{
    forge: Pick<ProjectForge, 'kind' | 'host' | 'repository'>;
    branches: string[];
  }> = [];
  responses = new Map<string, ChangeRequest[]>();
  fail: string | null = null;

  async probe(kind: ForgeKind): Promise<ForgeCliStatus> {
    this.probes += 1;
    return this.clis[kind];
  }

  async fetchChangeRequests(
    forge: Pick<ProjectForge, 'kind' | 'host' | 'repository'>,
    branches: readonly string[],
  ): Promise<Map<string, ChangeRequest[]>> {
    this.fetches.push({ forge, branches: [...branches] });
    if (this.fail) throw new Error(this.fail);
    return new Map(branches.map((b) => [b, this.responses.get(`${forge.repository}#${b}`) ?? []]));
  }
}

describe('forge service (fake git-core, fake gh/glab)', () => {
  let fake: FakeGitCore;
  let forge: FakeForgeClient;
  let daemon: Daemon;
  let api: ApiClient;
  let alpha: FakeRepo;
  let beta: FakeRepo;
  let gamma: FakeRepo;

  const state = async (repo: FakeRepo) => {
    const body: ForgesResponse = ForgesResponseSchema.parse(await api.getForges());
    return body.projects.find((p) => p.projectId === repo.projectId);
  };

  beforeEach(async () => {
    fake = new FakeGitCore();
    forge = new FakeForgeClient();
    const base = await tempDir();
    alpha = await fake.createRepo(base, 'alpha', { linked: ['feat', 'other'] });
    beta = await fake.createRepo(base, 'beta', { linked: ['wip'] });
    gamma = await fake.createRepo(base, 'gamma', { linked: ['feat'] });
    fake.remoteConfigs.set(alpha.commonDir, {
      remotes: [
        { name: 'origin', url: 'git@github.com:me/alpha.git', pushUrl: null, ghResolved: null },
        {
          name: 'upstream',
          url: 'https://github.com/org/alpha.git',
          pushUrl: null,
          ghResolved: null,
        },
      ],
      branches: {},
      pushDefault: null,
    });
    fake.remoteConfigs.set(gamma.commonDir, {
      remotes: [
        { name: 'origin', url: 'git@git.acme.io:grp/gamma.git', pushUrl: null, ghResolved: null },
      ],
      branches: {},
      pushDefault: null,
    });
    const featHead = alpha.worktrees[1]?.headSha ?? '';
    forge.responses.set('org/alpha#feat', [
      pr({ number: 9, crossRepository: true, headRepository: 'stranger/alpha' }),
      pr({ number: 7, crossRepository: true, headRepository: 'me/alpha', headSha: featHead }),
    ]);
    forge.responses.set('grp/gamma#feat', [
      pr({
        kind: 'gitlab',
        number: 3,
        url: 'https://git.acme.io/grp/gamma/-/merge_requests/3',
        headRepository: 'grp/gamma',
        state: 'merged',
        headSha: 'f'.repeat(40),
      }),
    ]);
    daemon = await startTestDaemon({
      fake,
      stateDir: await tempDir(),
      projects: [alpha.mainPath, beta.mainPath, gamma.mainPath],
      internal: {
        forges: {
          client: forge,
          checkAgainSkipMs: 0,
          debounceMs: 20,
          readSshConfig: async () => null,
        },
      },
    });
    api = client(daemon);
  });

  it('resolves forges, matches requests to worktrees and ignores same-named fork branches', async () => {
    const a = await eventually(async () => {
      const s = await state(alpha);
      return s?.status === 'ok' ? s : null;
    });
    expect(a.forge).toEqual({
      kind: 'github',
      host: 'github.com',
      repository: 'org/alpha',
      webUrl: 'https://github.com/org/alpha',
      remoteName: 'upstream',
      detectedBy: 'hostname',
    });
    const feat = a.worktrees.find((w) => w.worktreeId === alpha.worktrees[1]?.id);
    expect(feat).toMatchObject({ branch: 'feat', sync: 'same', changeRequest: { number: 7 } });
    const other = a.worktrees.find((w) => w.worktreeId === alpha.worktrees[2]?.id);
    expect(other).toMatchObject({ branch: 'other', changeRequest: null, sync: 'unknown' });
    // The default branch is never looked up.
    expect(a.worktrees.some((w) => w.worktreeId === alpha.worktrees[0]?.id)).toBe(false);
    expect(forge.fetches.find((f) => f.forge.repository === 'org/alpha')?.branches).toEqual([
      'feat',
      'other',
    ]);

    const g = await eventually(async () => {
      const s = await state(gamma);
      return s?.status === 'ok' ? s : null;
    });
    expect(g.forge).toMatchObject({ kind: 'gitlab', host: 'git.acme.io', detectedBy: 'cli-login' });
    expect(g.worktrees[0]).toMatchObject({
      changeRequest: { number: 3, state: 'merged' },
      sync: 'differs',
    });

    expect(await state(beta)).toMatchObject({
      status: 'no-forge',
      forge: null,
      message: 'No git remote is configured.',
    });
    const body = ForgesResponseSchema.parse(await api.getForges());
    expect(body.enabled).toBe(true);
    expect(body.clis.map((c) => c.kind)).toEqual(['github', 'gitlab']);
  });

  it('rate-limits background refreshes; a forced refresh refetches', async () => {
    await eventually(async () => (await state(alpha))?.status === 'ok');
    const count = () => forge.fetches.filter((f) => f.forge.repository === 'org/alpha').length;
    const before = count();
    await daemon.forges?.refresh();
    expect(count()).toBe(before);
    await api.refreshForges({ projectIds: [alpha.projectId] });
    expect(count()).toBe(before + 1);
  });

  it('reports signed-out CLIs, fetch errors and the disabled setting, with forge.updated events', async () => {
    await eventually(async () => (await state(alpha))?.status === 'ok');
    const events = recordEvents(daemon);
    await events.opened;

    forge.fail = 'HTTP 502: Bad Gateway';
    await api.refreshForges({ projectIds: [alpha.projectId] });
    const failed = await state(alpha);
    expect(failed).toMatchObject({ status: 'error', message: 'HTTP 502: Bad Gateway' });
    // Earlier results are kept.
    expect(failed?.worktrees.find((w) => w.branch === 'feat')?.changeRequest?.number).toBe(7);
    await events.waitFor(
      (e) => e.type === 'forge.updated' && e.projectIds.includes(alpha.projectId),
    );

    forge.fail = null;
    forge.clis.github = cli('github', []);
    // CLI probes are reused for 30 s even when forced; a new daemon would re-probe.
    await api.updateSettings({ forges: { enabled: false } });
    await eventually(async () => (await state(alpha))?.status === 'disabled');
    expect((await api.getForges()).enabled).toBe(false);
    const fetches = forge.fetches.length;
    await api.refreshForges();
    expect(forge.fetches.length).toBe(fetches);
  });

  it('honours host overrides from settings', async () => {
    await eventually(async () => (await state(alpha))?.status === 'ok');
    await api.updateSettings({ forges: { hosts: { 'github.com': 'none' } } });
    await eventually(async () => (await state(alpha))?.status === 'ignored');
    await api.updateSettings({ forges: { hosts: { 'git.acme.io': 'github' } } });
    const g = await eventually(async () => {
      const s = await state(gamma);
      return s?.forge?.kind === 'github' ? s : null;
    });
    // gh is not signed in to git.acme.io: nothing is queried.
    expect(g).toMatchObject({ status: 'unauthenticated', forge: { detectedBy: 'setting' } });
  });
});

describe('forge service without remotes', () => {
  it('never starts a forge CLI', async () => {
    const fake = new FakeGitCore();
    const forge = new FakeForgeClient();
    const base = await tempDir();
    const repo = await fake.createRepo(base, 'local', { linked: ['feat'] });
    const daemon = await startTestDaemon({
      fake,
      stateDir: await tempDir(),
      projects: [repo.mainPath],
      internal: { forges: { client: forge, checkAgainSkipMs: 0, debounceMs: 20 } },
    });
    const api = client(daemon);
    await eventually(async () => {
      const body = await api.getForges();
      return body.projects.find((p) => p.projectId === repo.projectId)?.status === 'no-forge';
    });
    await api.refreshForges();
    expect(forge.probes).toBe(0);
    expect(forge.fetches).toEqual([]);
    expect((await api.getForges()).clis).toEqual([]);
  });
});
