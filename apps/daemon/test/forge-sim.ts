import {
  type ChangeRequest,
  type ChangeRequestConversation,
  type ChangeRequestDetail,
  type ForgeCliStatus,
  type ForgeKind,
  type ForgeRepositoryInfo,
  type GitRemoteConfig,
  noopLogger,
  type ProjectForge,
  type ProjectListItem,
  type ServerEvent,
} from '@octopus-diff/contracts';
import { estimateQueryPoints } from '@octopus-diff/forge';
import { vi } from 'vitest';
import { type ForgeClientLike, ForgeService, type ForgeServiceOptions } from '../src/forges.js';

/**
 * Fake clock, fake forge client and synthetic fleets for the forge scheduling tests
 * (forge-fleet.test.ts, forge-fetching.test.ts). The real `ForgeService` runs on vitest's fake
 * timers; the client only counts queries and costs them with `estimateQueryPoints`.
 */

export const NOW = '2026-11-11T10:00:00.000Z';
export const HOUR = 3_600_000;
const SHA = 'a'.repeat(40);

export interface Tally {
  queries: number;
  points: number;
}

export class CountingClient implements ForgeClientLike {
  probes = 0;
  batch: Tally = { queries: 0, points: 0 };
  detail: Tally = { queries: 0, points: 0 };
  conversation: Tally = { queries: 0, points: 0 };
  repository: Tally = { queries: 0, points: 0 };
  /** Make the next batch queries fail with this error (null: succeed). */
  fail: Error | null = null;
  /** Holds every batch query until it resolves (a slow forge). */
  batchGate: Promise<void> | null = null;
  /** Head branches that have no request yet (every other branch has an open one). */
  withoutRequest = new Set<string>();
  /** Numbers of the open requests the repository query lists. */
  openNumbers: number[] = [1];

  get total(): Tally {
    const all = [this.batch, this.detail, this.conversation, this.repository];
    return {
      queries: all.reduce((n, t) => n + t.queries, 0),
      points: all.reduce((n, t) => n + t.points, 0),
    };
  }

  async probe(kind: ForgeKind): Promise<ForgeCliStatus> {
    this.probes += 1;
    return {
      kind,
      executable: kind === 'github' ? 'gh' : 'glab',
      available: true,
      version: '1',
      auth: kind === 'github' ? 'authenticated' : 'unauthenticated',
      accounts: kind === 'github' ? [{ host: 'github.com', account: 'octo' }] : [],
      hint: '',
      detail: null,
      checkedAt: NOW,
    };
  }

  async fetchChangeRequests(
    _forge: Pick<ProjectForge, 'kind' | 'host' | 'repository'>,
    branches: readonly string[],
  ): Promise<Map<string, ChangeRequest[]>> {
    this.batch.queries += 1;
    await this.batchGate;
    this.batch.points += estimateQueryPoints('github', 'batch', branches.length);
    if (this.fail) throw this.fail;
    return new Map(
      branches.map((b, i) => [
        b,
        this.withoutRequest.has(b)
          ? []
          : [
              {
                kind: 'github',
                number: i + 1,
                title: 't',
                url: 'https://github.com/o/r/pull/1',
                state: 'open',
                draft: false,
                author: 'octo',
                baseBranch: 'main',
                headBranch: b,
                headSha: null,
                crossRepository: false,
                headRepository: null,
                updatedAt: NOW,
                checks: null,
                review: null,
                conflicts: null,
                comments: null,
              } satisfies ChangeRequest,
            ],
      ]),
    );
  }

  async fetchRepository(): Promise<ForgeRepositoryInfo> {
    this.repository.queries += 1;
    this.repository.points += estimateQueryPoints('github', 'repository');
    return {
      requests: this.openNumbers.map((number) => ({ number, title: 't', worktreeId: null })),
    } as unknown as ForgeRepositoryInfo;
  }

  async fetchDetail(): Promise<ChangeRequestDetail | null> {
    this.detail.queries += 1;
    this.detail.points += estimateQueryPoints('github', 'detail');
    return {} as ChangeRequestDetail;
  }

  async fetchConversation(): Promise<ChangeRequestConversation | null> {
    this.conversation.queries += 1;
    this.conversation.points += estimateQueryPoints('github', 'conversation');
    return {} as ChangeRequestConversation;
  }
}

export function fleet(projects: number, branches: number): ProjectListItem[] {
  return Array.from({ length: projects }, (_, p) => {
    const worktree = (id: string, branch: string | null, isMain: boolean) => ({
      worktree: {
        id,
        projectId: `p${p}`,
        path: `/tmp/p${p}/${id}`,
        branch,
        headSha: SHA,
        detached: false,
        isMain,
        bare: false,
        locked: false,
        prunable: false,
        missing: false,
      },
      summary: null,
      error: null,
    });
    return {
      project: {
        id: `p${p}`,
        name: `repo${p}`,
        commonDir: `/tmp/p${p}/.git`,
        mainWorktreePath: `/tmp/p${p}/main`,
        bare: false,
        defaultBranch: 'main',
        defaultBranchOverride: null,
        scanRootId: null,
        addedAt: NOW,
      },
      worktrees: [
        worktree(`p${p}-main`, 'main', true),
        ...Array.from({ length: branches }, (_, b) => worktree(`p${p}-w${b}`, `feat-${b}`, false)),
      ],
    };
  });
}

export type Listener = (event: ServerEvent) => void;

export function build(
  projects: number,
  branches: number,
  options: Partial<ForgeServiceOptions> = {},
) {
  const items = fleet(projects, branches);
  const listeners = new Set<Listener>();
  const emitted: ServerEvent[] = [];
  const client = new CountingClient();
  /** Per project git config (`git push -u` is `configs.set(...)`). */
  const configs = new Map<string, GitRemoteConfig>();
  const config = (commonDir: string): GitRemoteConfig =>
    configs.get(commonDir) ?? {
      remotes: [
        {
          name: 'origin',
          url: `git@github.com:org/${commonDir.split('/')[2]}.git`,
          pushUrl: null,
          ghResolved: null,
        },
      ],
      branches: {},
      pushDefault: null,
    };
  const service = new ForgeService({
    core: { listProjects: async () => items },
    gitCore: { readRemoteConfig: async (project) => config(project.commonDir) },
    settings: { settings: { forges: { enabled: true, hosts: {} } } as never },
    hub: {
      on: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      emit: (event) => {
        emitted.push(event);
        for (const l of listeners) l(event);
      },
    },
    logger: noopLogger,
    client,
    readSshConfig: async () => null,
    ...options,
  });
  const emit = (event: ServerEvent) => {
    for (const l of listeners) l(event);
  };
  return { items, client, service, emit, emitted, configs, config };
}

export async function advance(ms: number, step = 1000): Promise<void> {
  for (let done = 0; done < ms; done += step) await vi.advanceTimersByTimeAsync(step);
}
