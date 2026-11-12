import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { advance, build, HOUR, NOW, type Tally } from './forge-sim.js';

/**
 * Simulated fleets (DECISIONS #197, docs/reports/forge-fetching.md): the real `ForgeService`
 * scheduler on a fake clock, with a fake forge client that counts every query and costs it with
 * `estimateQueryPoints`. The query counts are measured from the running scheduler; the point
 * values are arithmetic from the query shape. No `gh` / `glab`, no network, no token.
 *
 * `FORGE_FLEET_TABLE=1 pnpm --filter @octopus-diff/daemon exec vitest run test/forge-fleet.test.ts`
 * prints the table the report quotes.
 */

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
  [100, 15],
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

      // "Check again" in Settings, 10 s later: bounded by its allowance, never more than one batch
      // per project.
      await advance(10_000);
      const beforeCheck = { ...client.total };
      await service.checkAgain();
      record(name, 'Check again (all repos, once)', {
        queries: client.total.queries - beforeCheck.queries,
        points: client.total.points - beforeCheck.points,
      });

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

      // A daemon nobody ever talks to: it counts a browser as looking for its first minutes only.
      const headless = build(n, b);
      headless.service.start();
      await advance(HOUR);
      await headless.service.close();
      record(name, 'headless daemon, first hour (no focus report)', { ...headless.client.total });
      expect(headless.client.total.points).toBeLessThanOrEqual(450 + n * 12);

      // Budgets the strategy promises (DECISIONS #197): no browser never costs more than 300 points
      // an hour per fleet, and a busy hour stays under the 1 500-point background ceiling plus
      // the user's own requests (detail + conversation about 40 + 40, the hot project 60).
      expect(idle.points).toBeLessThanOrEqual(450);
      expect(active.points).toBeLessThanOrEqual(1100 + 40 + 40 + 60 + 120);
    },
    120_000,
  );
});
