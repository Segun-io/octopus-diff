import {
  type ChangeRequest,
  type ChangeRequestConversation,
  type ChangeRequestDetail,
  type ForgeCliStatus,
  type ForgeKind,
  type GitRemoteConfig,
  noopLogger,
  type ProjectForge,
  type ProjectListItem,
  type ServerEvent,
} from '@octopus-diff/contracts';
import { estimateQueryPoints } from '@octopus-diff/forge';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ForgeClientLike, ForgeService } from '../src/forges.js';

/**
 * Simulated fleets (DECISIONS #197, docs/reports/forge-fetching.md): the real `ForgeService`
 * scheduler on a fake clock, with a fake forge client that counts every query and costs it with
 * `estimateQueryPoints`. The query counts are measured from the running scheduler; the point
 * values are arithmetic from the query shape. No `gh` / `glab`, no network, no token.
 *
 * `FORGE_FLEET_TABLE=1 pnpm --filter @octopus-diff/daemon exec vitest run test/forge-fleet.test.ts`
 * prints the table the report quotes.
 */

const NOW = '2026-11-11T10:00:00.000Z';
const HOUR = 3_600_000;
const SHA = 'a'.repeat(40);

interface Tally {
  queries: number;
  points: number;
}

class CountingClient implements ForgeClientLike {
  probes = 0;
  batch: Tally = { queries: 0, points: 0 };
  detail: Tally = { queries: 0, points: 0 };
  conversation: Tally = { queries: 0, points: 0 };
  repository: Tally = { queries: 0, points: 0 };

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
    this.batch.points += estimateQueryPoints('github', 'batch', branches.length);
    return new Map(
      branches.map((b, i) => [
        b,
        [
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

function fleet(projects: number, branches: number): ProjectListItem[] {
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

type Listener = (event: ServerEvent) => void;

function build(projects: number, branches: number) {
  const items = fleet(projects, branches);
  const listeners = new Set<Listener>();
  const client = new CountingClient();
  const config = (commonDir: string): GitRemoteConfig => ({
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
  });
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
        for (const l of listeners) l(event);
      },
    },
    logger: noopLogger,
    client,
    readSshConfig: async () => null,
  });
  const emit = (event: ServerEvent) => {
    for (const l of listeners) l(event);
  };
  return { items, client, service, emit };
}

async function advance(ms: number, step = 1000): Promise<void> {
  for (let done = 0; done < ms; done += step) await vi.advanceTimersByTimeAsync(step);
}

interface Row {
  fleet: string;
  scenario: string;
  queries: number;
  points: number;
}
const rows: Row[] = [];

function record(fleetName: string, scenario: string, tally: Tally): void {
  rows.push({ fleet: fleetName, scenario, ...tally });
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW) });
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  if (process.env.FORGE_FLEET_TABLE) {
    console.log(
      `\nfleet | scenario | queries | points\n${rows.map((r) => `${r.fleet} | ${r.scenario} | ${r.queries} | ${r.points}`).join('\n')}`,
    );
  }
});

const FLEETS: Array<[projects: number, branches: number]> = [
  [5, 3],
  [30, 3],
  [100, 3],
  [30, 15],
];

describe('simulated fleets: forge queries per scenario (fake clock, fake client)', () => {
  it.each(FLEETS)(
    '%i repos x %i branches: startup, idle hour, active hour',
    async (n, b) => {
      const name = `${n}x${b}`;
      const { client, service, items, emit } = build(n, b);

      // Startup: the daemon starts, every project is looked up once.
      service.start();
      await advance(120_000 - 1000);
      record(name, 'startup (first 2 min)', { ...client.total });

      // Idle hour: no browser is looking (the tab is hidden or closed), nothing is edited.
      service.focusChanged(false, null);
      const before = { ...client.total };
      await advance(HOUR);
      const idle = {
        queries: client.total.queries - before.queries,
        points: client.total.points - before.points,
      };
      record(name, 'idle hour (no browser)', idle);

      // Active hour: a user looks at project 0 with the Request tab open on a PR whose checks are
      // running (the web polls the detail every 45 s and the conversation is shown, the focus is
      // re-reported every 5 min), and agents edit three worktrees every 5 s (each edit is a
      // `worktree.changed` event).
      const mark = { ...client.total };
      const first = items[0]?.worktrees[1]?.worktree.id ?? '';
      for (let t = 0; t < HOUR; t += 5000) {
        if (t % 300_000 === 0) service.focusChanged(true, 'p0');
        for (const p of items.slice(0, 3)) {
          emit({
            type: 'worktree.changed',
            projectId: p.project.id,
            worktreeId: p.worktrees[1]?.worktree.id ?? '',
            stateHash: String(t),
          });
        }
        if (t % 45_000 === 0) {
          await service.detail(first);
          await service.conversation(first);
          await service.response();
        }
        await vi.advanceTimersByTimeAsync(5000);
      }
      const active = {
        queries: client.total.queries - mark.queries,
        points: client.total.points - mark.points,
      };
      record(name, 'active hour (focused, edits, Request tab)', active);
      await service.close();

      // Budgets the strategy promises (DECISIONS #197): no browser never costs more than 300 points
      // an hour per fleet, and a busy hour stays under the 1 500-point background ceiling plus
      // the user's own requests (detail + conversation about 40 + 40, the hot project 60).
      expect(idle.points).toBeLessThanOrEqual(330);
      expect(active.points).toBeLessThanOrEqual(1100 + 40 + 40 + 60 + 120);
    },
    120_000,
  );
});
