import type { ServerEvent } from '@octopus-diff/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { advance, build, NOW } from './forge-sim.js';

/**
 * The fetching strategy of DECISIONS #197: the rate-limit budget and backoff, the adaptive poll,
 * the focus refresh, bounded "Check again", cache eviction and the push follow-ups. The real
 * `ForgeService` on a fake clock with a fake client (forge-sim.ts); nothing here reaches a forge.
 */

beforeEach(() => {
  vi.useFakeTimers({ now: new Date(NOW) });
});
afterEach(() => {
  vi.useRealTimers();
});

const budgetOf = async (service: ReturnType<typeof build>['service']) =>
  (await service.response()).budgets?.[0];

describe('budget and backoff', () => {
  it('a refusal by the forge pauses every lookup on that host, says so, and resumes later', async () => {
    const { service, client, emitted } = build(3, 2);
    client.fail = new Error('gh: API rate limit exceeded for user ID 1. (HTTP 403)');
    await service.refresh(['p0']);
    expect(client.batch.queries).toBe(1);
    expect((await service.response()).projects[0]).toMatchObject({
      status: 'error',
      message: expect.stringContaining('rate limit'),
    });
    expect(await budgetOf(service)).toMatchObject({ host: 'github.com', state: 'backoff' });
    expect(emitted).toContainEqual({ type: 'forge.updated', projectIds: [] });

    // Even a forced refresh of another project waits: the forge would only refuse again.
    client.fail = null;
    await service.refresh(['p1'], { force: true });
    expect(client.batch.queries).toBe(1);

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1000);
    await service.refresh(['p1'], { force: true });
    expect(client.batch.queries).toBe(2);
    expect(await budgetOf(service)).toMatchObject({ state: 'ok' });
  });

  it('background lookups stop at their ceiling, user-asked ones go on, projects wait with a reason', async () => {
    const { service, client } = build(5, 3, {
      budgetLimits: { background: 3, event: 4, interactive: 6 },
    });
    for (const id of ['p0', 'p1', 'p2', 'p3', 'p4']) await service.refresh([id]);
    expect(client.batch.queries).toBe(3);
    const held = (await service.response()).projects.find((p) => p.projectId === 'p3');
    expect(held).toMatchObject({ status: 'pending', message: expect.stringContaining('share') });
    expect(await budgetOf(service)).toMatchObject({ state: 'busy', spentLastHour: 3 });

    // An event (a push) has a higher ceiling, the user's own request the highest.
    await service.refresh(['p3'], { priority: 'event' });
    expect(client.batch.queries).toBe(4);
    await service.refresh(['p4'], { force: true });
    await service.refresh(['p0'], { force: true });
    expect(client.batch.queries).toBe(6);
    await service.refresh(['p1'], { force: true });
    expect(client.batch.queries).toBe(6);

    // An hour later the ledger is empty again.
    await vi.advanceTimersByTimeAsync(3_600_001);
    await service.refresh(['p1']);
    expect(client.batch.queries).toBe(7);
  });

  it('opening a request is admitted by the same budget and says why it could not load', async () => {
    const { service, client } = build(1, 1, { budgetLimits: { interactive: 1 } });
    await service.refresh(['p0']);
    const detail = await service.detail('p0-w0');
    expect(client.detail.queries).toBe(0);
    expect(detail).toMatchObject({
      status: 'unavailable',
      message: expect.stringContaining('share'),
    });
  });

  it('a rate limit hit while loading a detail backs the whole host off', async () => {
    const { service, client } = build(2, 1);
    await service.refresh(['p0']);
    client.fetchDetail = async () => {
      throw new Error('You have exceeded a secondary rate limit.');
    };
    const detail = await service.detail('p0-w0');
    expect(detail.status).toBe('unavailable');
    await service.refresh(['p1'], { force: true });
    expect(client.batch.queries).toBe(1);
    expect(await budgetOf(service)).toMatchObject({ state: 'backoff' });
  });
});

describe('adaptive polling', () => {
  const options = { pollMs: 60_000, idlePollMs: 600_000, hotPollMs: 1e9, attentionMs: 600_000 };

  it('polls every minute while a browser looks and every 10 minutes when none does', async () => {
    const hidden = build(2, 2, options);
    hidden.service.start();
    hidden.service.focusChanged(false, null);
    await advance(30 * 60_000);
    await hidden.service.close();
    // Rounds at 0, 10, 20 and 30 minutes.
    expect(hidden.client.batch.queries).toBeLessThanOrEqual(2 * 4);
    expect(hidden.client.batch.queries).toBeGreaterThanOrEqual(2 * 3);

    const visible = build(2, 2, options);
    visible.service.start();
    for (let t = 0; t < 30 * 60_000; t += 4 * 60_000) {
      visible.service.focusChanged(true, null);
      await advance(4 * 60_000);
    }
    await visible.service.close();
    expect(visible.client.batch.queries).toBeGreaterThanOrEqual(2 * 28);
  });

  it('a daemon nobody reports to counts a browser as looking for its first minutes only', async () => {
    const { service, client } = build(1, 1, options);
    service.start();
    await advance(20 * 60_000);
    await service.close();
    // Counted as looking for the first 6 minutes (7 rounds), then every 10 minutes (1 more).
    expect(client.batch.queries).toBeGreaterThanOrEqual(7);
    expect(client.batch.queries).toBeLessThanOrEqual(10);
  });

  it('a big fleet stretches the interval so polling stays near its points target', async () => {
    const { service, client } = build(100, 1, { ...options, pollMs: 60_000 });
    service.start();
    service.focusChanged(true, null);
    await advance(5 * 60_000);
    // One round is 100 points; at 1 000 points an hour the next one waits 6 minutes.
    expect(client.batch.queries).toBe(100);
    await advance(2 * 60_000);
    expect(client.batch.queries).toBe(200);
    await service.close();
  });

  it('looking again after a break refreshes the fleet and the project in view, once', async () => {
    const { service, client } = build(2, 1, { ...options, idlePollMs: 3_600_000 });
    service.start();
    service.focusChanged(false, null);
    await advance(20 * 60_000);
    expect(client.batch.queries).toBe(2);

    service.focusChanged(true, 'p0');
    await advance(2000);
    // The overdue fleet poll fetched both; the project in view shared that fetch.
    expect(client.batch.queries).toBe(4);
    // Moving to the other project right away finds it fresh.
    service.focusChanged(true, 'p1');
    await advance(2000);
    expect(client.batch.queries).toBe(4);
    // Later, a project that comes into view with data older than 30 s is looked up.
    await advance(40_000);
    service.focusChanged(true, 'p0');
    await advance(2000);
    expect(client.batch.queries).toBe(5);
    await service.close();
  });

  it('polls the project in view on its own while someone looks', async () => {
    const { service, client } = build(3, 1, { ...options, pollMs: 3_600_000, hotPollMs: 60_000 });
    service.start();
    service.focusChanged(true, 'p0');
    await advance(5 * 60_000);
    await service.close();
    // Startup: 3. Then p0 about every minute (the others are not polled for an hour).
    expect(client.batch.queries).toBeGreaterThanOrEqual(3 + 4);
    expect(client.batch.queries).toBeLessThanOrEqual(3 + 6);
  });
});

describe('automatic timers use the background share (PR #62 review)', () => {
  it('the project-in-view poll and the Overview reload stop at the background ceiling', async () => {
    const { service, client } = build(1, 1, {
      budgetLimits: { background: 1, event: 50, interactive: 100 },
      hotPollMs: 30_000,
      pollMs: 3_600_000,
      idlePollMs: 3_600_000,
    });
    await service.refresh(['p0']); // the batch spends the one background point
    await service.repository('p0'); // opened by a person: the user's share
    expect(client.batch.queries).toBe(1);
    expect(client.repository.queries).toBe(1);
    service.start();
    service.focusChanged(true, 'p0', true);
    await advance(5 * 60_000);
    await service.close();
    // Timers only: the background share is used up, so neither poll nor reload went out.
    expect(client.batch.queries).toBe(1);
    expect(client.repository.queries).toBe(1);
  });
});

describe('the first lookup is named while it runs (PR #76 review)', () => {
  it('announces the forge as soon as the lookup starts, not only when it finishes', async () => {
    const { service, client, emitted } = build(1, 1);
    let release = () => {};
    client.batchGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = service.refresh(['p0']);
    await vi.advanceTimersByTimeAsync(50);
    // The batch query is held (a slow forge): the project is pending and its forge is known, and
    // the clients were told, so the UI can say "Waiting for GitHub..." now.
    expect(client.batch.queries).toBe(1);
    expect((await service.response()).projects[0]).toMatchObject({
      status: 'pending',
      forge: { kind: 'github' },
    });
    expect(emitted).toContainEqual({ type: 'forge.updated', projectIds: ['p0'] });
    client.batchGate = null;
    release();
    await run;
    expect((await service.response()).projects[0]?.status).toBe('ok');
  });
});

describe('Check again', () => {
  it('spends at most its allowance per call and leaves just-fetched projects alone', async () => {
    const { service, client } = build(10, 1, { checkAgainMaxPoints: 4, checkAgainSkipMs: 5000 });
    await service.checkAgain();
    expect(client.batch.queries).toBe(4);
    // A double click: the four fetched a moment ago are not fetched again, the next four are.
    await advance(1000);
    await service.checkAgain();
    expect(client.batch.queries).toBe(8);
    await advance(6000);
    await service.checkAgain();
    // All ten were looked at once; now four (the oldest) go again.
    expect(client.batch.queries).toBe(12);
  });
});

describe('cache eviction', () => {
  it('keeps the most recently used details and conversations only', async () => {
    const { service, client } = build(1, 3, { maxCacheEntries: 2 });
    await service.refresh();
    for (const w of ['p0-w0', 'p0-w1', 'p0-w2']) await service.detail(w);
    expect(client.detail.queries).toBe(3);
    await service.detail('p0-w2');
    expect(client.detail.queries).toBe(3);
    await service.detail('p0-w0'); // evicted by w2, fetched again
    expect(client.detail.queries).toBe(4);
  });

  it('drops entries nobody asked for in a long time, in the poll', async () => {
    const { service, client } = build(1, 1, {
      cacheMaxAgeMs: 10_000,
      pollMs: 15_000,
      idlePollMs: 15_000,
    });
    service.start();
    await advance(1000);
    await service.detail('p0-w0');
    expect(client.detail.queries).toBe(1);
    await advance(20_000); // a poll swept it (the 60 s TTL has not even passed)
    await service.detail('p0-w0');
    expect(client.detail.queries).toBe(2);
    await service.close();
  });
});

describe('pushes', () => {
  const origin = (branches: Record<string, unknown> = {}) => ({
    remotes: [
      { name: 'origin', url: 'git@github.com:org/p0.git', pushUrl: null, ghResolved: null },
    ],
    branches: branches as never,
    pushDefault: null,
  });

  it('looks again after a push, stops when the request was found, and not for a new worktree', async () => {
    const { service, client, configs, emit, items } = build(1, 2, {
      followUpMs: [30_000, 90_000],
      debounceMs: 10,
      pollMs: 3_600_000,
      idlePollMs: 3_600_000,
    });
    client.withoutRequest.add('feat-0');
    service.start();
    await advance(2000);
    expect(client.batch.queries).toBe(1);

    // `git push -u` on feat-0.
    configs.set(
      '/tmp/p0/.git',
      origin({ 'feat-0': { remote: 'origin', merge: 'refs/heads/feat-0', pushRemote: null } }),
    );
    emit({ type: 'worktree.changed', projectId: 'p0', worktreeId: 'p0-w0', stateHash: 'x' });
    await advance(2000);
    expect(client.batch.queries).toBe(2);

    // The request is created a moment later: the first follow-up finds it...
    client.withoutRequest.delete('feat-0');
    await advance(31_000);
    expect(client.batch.queries).toBe(3);
    // ...so the second one is not spent.
    await advance(100_000);
    expect(client.batch.queries).toBe(3);

    // A new worktree on a new branch changes the branch set (one lookup) but is no push.
    client.withoutRequest.add('feat-new');
    items[0]?.worktrees.push({
      ...(items[0].worktrees[1] as NonNullable<(typeof items)[0]['worktrees'][1]>),
      worktree: {
        ...(items[0].worktrees[1]?.worktree as NonNullable<
          (typeof items)[0]['worktrees'][1]
        >['worktree']),
        id: 'p0-new',
        branch: 'feat-new',
      },
    });
    emit({ type: 'worktree.added', projectId: 'p0', worktreeId: 'p0-new' });
    await advance(2000);
    expect(client.batch.queries).toBe(4);
    await advance(200_000);
    expect(client.batch.queries).toBe(4);
    await service.close();
  });
});

describe('pushes in quick succession (PR #62 review)', () => {
  const origin = (branches: Record<string, unknown>) => ({
    remotes: [
      { name: 'origin', url: 'git@github.com:org/p0.git', pushUrl: null, ghResolved: null },
    ],
    branches: branches as never,
    pushDefault: null,
  });
  const up = (b: string) => ({ remote: 'origin', merge: `refs/heads/${b}`, pushRemote: null });

  it('a second push does not make the first branch lose its follow-up lookups', async () => {
    const { service, client, configs, emit } = build(1, 2, {
      followUpMs: [30_000, 90_000],
      debounceMs: 10,
      pollMs: 3_600_000,
      idlePollMs: 3_600_000,
    });
    client.withoutRequest.add('feat-0');
    client.withoutRequest.add('feat-1');
    service.start();
    await advance(2000);
    const start = client.batch.queries;

    // feat-0 is pushed (no request yet), then feat-1 a little later (its request exists at once).
    configs.set('/tmp/p0/.git', origin({ 'feat-0': up('feat-0') }));
    emit({ type: 'worktree.changed', projectId: 'p0', worktreeId: 'p0-w0', stateHash: 'a' });
    await advance(2000);
    client.withoutRequest.delete('feat-1');
    configs.set('/tmp/p0/.git', origin({ 'feat-0': up('feat-0'), 'feat-1': up('feat-1') }));
    emit({ type: 'worktree.changed', projectId: 'p0', worktreeId: 'p0-w1', stateHash: 'b' });
    await advance(2000);
    const afterPushes = client.batch.queries;
    expect(afterPushes).toBeGreaterThan(start);

    // The request for feat-0 appears later: the follow-ups still look for it.
    client.withoutRequest.delete('feat-0');
    await advance(40_000);
    expect(client.batch.queries).toBeGreaterThan(afterPushes);
    await service.close();
  });
});

describe('the open project overview', () => {
  it('is reloaded in the background while in view and the UI is told when it changed', async () => {
    const { service, client, emitted } = build(1, 1, {
      hotPollMs: 30_000,
      pollMs: 3_600_000,
      idlePollMs: 3_600_000,
    });
    await service.refresh();
    const first = await service.repository('p0');
    expect(first.repository?.requests).toHaveLength(1);
    expect(client.repository.queries).toBe(1);
    service.start();
    service.focusChanged(true, 'p0', true);
    // A request appears on a branch no worktree has checked out.
    client.openNumbers = [1, 9];
    const events: ServerEvent[] = [];
    emitted.length = 0;
    await advance(3 * 60_000);
    events.push(...emitted);
    expect(client.repository.queries).toBe(2);
    expect(events).toContainEqual({ type: 'forge.updated', projectIds: ['p0'] });
    expect((await service.repository('p0')).repository?.requests).toHaveLength(2);
    expect(client.repository.queries).toBe(2);
    await service.close();
  });

  it('is not reloaded when nobody has opened it', async () => {
    const { service, client } = build(1, 1, { hotPollMs: 30_000, pollMs: 3_600_000 });
    await service.refresh();
    service.start();
    service.focusChanged(true, 'p0', true);
    await advance(5 * 60_000);
    expect(client.repository.queries).toBe(0);
    await service.close();
  });

  it('is not reloaded while the user works in a worktree of the project', async () => {
    const { service, client } = build(1, 1, { hotPollMs: 30_000, pollMs: 3_600_000 });
    await service.refresh();
    await service.repository('p0');
    service.start();
    service.focusChanged(true, 'p0', false);
    await advance(5 * 60_000);
    expect(client.repository.queries).toBe(1);
    await service.close();
  });
});
