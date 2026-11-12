/**
 * #43 follow-up (Greptile P1 on PR #95): an inbox row the daemon marks `listing: 'overtaken'` (its
 * files could not be listed for any summary) keeps the worktree in the inbox and is asked for again
 * shortly, on the first load and on the delta path, with a bound.
 */
import { createApiClient, type DiffScope, type InboxResponse } from '@octopus-diff/contracts';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import { collectEventEffects, emptyEffects, flushEffects } from '../src/api/cache.ts';
import { inboxOvertakenRetry, inboxQueryOptions, queryKeys } from '../src/api/queries.ts';

const WORKING: DiffScope = { kind: 'working' };
const saved = [...inboxOvertakenRetry.delaysMs];
const cleanups: Array<() => void> = [];

beforeEach(() => {
  inboxOvertakenRetry.delaysMs = [5, 10, 20];
});
afterEach(() => {
  inboxOvertakenRetry.delaysMs = saved;
  for (const c of cleanups.splice(0)) c();
});

function setup() {
  const backend = new MockBackend({ dataset: 'demo' });
  const qc = new QueryClient({
    defaultOptions: { queries: { staleTime: Infinity, retry: false } },
  });
  const requests: string[] = [];
  const mockFetch = createMockFetch(backend);
  const api = createApiClient({
    baseUrl: 'http://mock.local',
    fetch: async (input, init) => {
      requests.push(String(input));
      return mockFetch(String(input), init);
    },
  });
  const observer = new QueryObserver(qc, inboxQueryOptions(api, qc, WORKING));
  const inboxOnScreen = () => cleanups.push(observer.subscribe(() => {}));
  const inbox = () => qc.getQueryData<InboxResponse>(queryKeys.inbox(WORKING));
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 400 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
    return check();
  };
  const dirty = backend.inbox(WORKING, false).entries[0];
  if (!dirty) throw new Error('the demo dataset has changes');
  return { backend, qc, api, requests, inboxOnScreen, inbox, until, id: dirty.worktree.id };
}

const rowOf = (inbox: InboxResponse | undefined, id: string) =>
  inbox?.entries.find((e) => e.worktree.id === id);
const followUps = (requests: string[], id: string) =>
  requests.filter((u) => u.includes('/api/inbox') && u.includes(`worktreeIds=${id}`)).length;

describe('inbox rows overtaken by refreshes (#43)', () => {
  it('first load: the worktree stays and one follow-up request brings its files', async () => {
    const s = setup();
    s.backend.overtakeInbox(s.id, 1);
    s.inboxOnScreen();
    expect(await s.until(() => (rowOf(s.inbox(), s.id)?.files.length ?? 0) > 0)).toBe(true);
    expect(rowOf(s.inbox(), s.id)?.listing).toBeUndefined();
    expect(followUps(s.requests, s.id)).toBe(1);
  });

  it('a row overtaken every time stays visible with its marker, after a bounded number of tries', async () => {
    const s = setup();
    s.backend.overtakeInbox(s.id, 100);
    s.inboxOnScreen();
    expect(await s.until(() => followUps(s.requests, s.id) >= 3 && !s.qc.isFetching())).toBe(true);
    await new Promise((r) => setTimeout(r, 100));
    expect(followUps(s.requests, s.id)).toBe(3);
    expect(rowOf(s.inbox(), s.id)).toMatchObject({ listing: 'overtaken', files: [] });
  });

  it('a refetch of the whole inbox (one request) settles its overtaken rows too', async () => {
    const s = setup();
    s.inboxOnScreen();
    expect(await s.until(() => rowOf(s.inbox(), s.id) !== undefined && !s.qc.isFetching())).toBe(
      true,
    );
    s.backend.overtakeInbox(s.id, 1);
    const before = followUps(s.requests, s.id);
    await s.qc.refetchQueries({ queryKey: queryKeys.inbox(WORKING) });
    expect(await s.until(() => (rowOf(s.inbox(), s.id)?.files.length ?? 0) > 0)).toBe(true);
    expect(rowOf(s.inbox(), s.id)?.listing).toBeUndefined();
    expect(followUps(s.requests, s.id) - before).toBe(1);
  });

  it('delta path: an overtaken row in the delta answer is asked for again', async () => {
    const s = setup();
    s.inboxOnScreen();
    expect(await s.until(() => rowOf(s.inbox(), s.id) !== undefined && !s.qc.isFetching())).toBe(
      true,
    );
    s.backend.overtakeInbox(s.id, 1);
    const events: Parameters<typeof collectEventEffects>[1][] = [];
    cleanups.push(s.backend.subscribe((e) => events.push(e)));
    s.backend.mutate(s.id, 'edit');
    const effects = emptyEffects();
    for (const e of events) collectEventEffects(s.qc, e, effects, { reconnect: false });
    const before = followUps(s.requests, s.id);
    await flushEffects(s.qc, effects, s.api);
    expect(await s.until(() => (rowOf(s.inbox(), s.id)?.files.length ?? 0) > 0)).toBe(true);
    expect(rowOf(s.inbox(), s.id)?.listing).toBeUndefined();
    // The delta request and one follow-up.
    expect(followUps(s.requests, s.id) - before).toBe(2);
  });
});
