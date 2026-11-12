import { createApiClient, type InboxResponse } from '@octopus-diff/contracts';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import { inboxBatches, inboxQueryOptions, isPartialInbox, queryKeys } from '../src/api/queries.ts';

/** The inbox fills in project batches after the first paint (#10). */

function harness(dataset: 'demo' | 'large' = 'large') {
  const backend = new MockBackend({ dataset });
  const base = createMockFetch(backend);
  const inboxRequests: string[] = [];
  const api = createApiClient({
    baseUrl: 'http://mock.local',
    fetch: (input, init) => {
      if (String(input).includes('/api/inbox')) inboxRequests.push(String(input));
      return base(input, init);
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return { backend, api, queryClient, inboxRequests };
}

const ids = (r: InboxResponse | undefined) => (r?.entries ?? []).map((e) => e.worktree.id).sort();

describe('inbox batches (#10)', () => {
  it('splits projects into batches, projects with changes first', () => {
    const { backend } = harness('large');
    const projects = backend.listProjects();
    const batches = inboxBatches(projects);
    if (!batches) throw new Error('expected batches');
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.length).toBeLessThanOrEqual(12);
    // Every project with a worktree, once.
    const all = batches.flat();
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(projects.projects.filter((p) => p.worktrees.length > 0).length);
    // Fewer than two projects: one request.
    expect(inboxBatches({ projects: projects.projects.slice(0, 1) })).toBeNull();
    expect(inboxBatches(undefined)).toBeNull();
  });

  it('streams batches into one inbox that ends complete and equal to the single answer', async () => {
    const { backend, api, queryClient, inboxRequests } = harness('large');
    await queryClient.fetchQuery({
      queryKey: queryKeys.projects(),
      queryFn: () => api.listProjects(),
    });
    const seen: InboxResponse[] = [];
    const options = inboxQueryOptions(api, queryClient, { kind: 'working' });
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.query.queryKey[0] !== 'inbox') return;
      const data = event.query.state.data as InboxResponse | undefined;
      if (data && seen.at(-1) !== data) seen.push(data);
    });
    const final = await queryClient.fetchQuery(options);
    unsubscribe();

    const expected = backend.inbox({ kind: 'working' }, false);
    expect(ids(final)).toEqual(ids(expected));
    expect(isPartialInbox(final)).toBe(false);
    expect(inboxRequests.length).toBeGreaterThan(1);
    expect(inboxRequests.every((u) => u.includes('projectIds='))).toBe(true);
    // It filled in: earlier states were partial and smaller.
    const partial = seen.filter((d) => isPartialInbox(d));
    expect(partial.length).toBeGreaterThan(0);
    for (const d of partial) expect(d.entries.length).toBeLessThan(final.entries.length);

    // A refetch is one request, and the data is replaced once it is in.
    inboxRequests.length = 0;
    await queryClient.refetchQueries({ queryKey: options.queryKey });
    expect(inboxRequests).toHaveLength(1);
    expect(inboxRequests[0]).not.toContain('projectIds=');
    const after = queryClient.getQueryData<InboxResponse>(options.queryKey);
    expect(ids(after)).toEqual(ids(expected));
    expect(isPartialInbox(after)).toBe(false);
  });
});
