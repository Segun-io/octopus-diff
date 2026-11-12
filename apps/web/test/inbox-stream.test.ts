import { createApiClient, type InboxResponse } from '@octopus-diff/contracts';
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import { applyReviewToCaches } from '../src/api/cache.ts';
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
    const seen: Array<{ data: InboxResponse; partial: boolean }> = [];
    const options = inboxQueryOptions(api, queryClient, { kind: 'working' });
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== 'updated' || event.query.queryKey[0] !== 'inbox') return;
      const data = event.query.state.data as InboxResponse | undefined;
      if (data && seen.at(-1)?.data !== data) {
        seen.push({ data, partial: isPartialInbox({ kind: 'working' }) });
      }
    });
    const final = await queryClient.fetchQuery(options);
    unsubscribe();

    const expected = backend.inbox({ kind: 'working' }, false);
    expect(ids(final)).toEqual(ids(expected));
    expect(isPartialInbox({ kind: 'working' })).toBe(false);
    expect(inboxRequests.length).toBeGreaterThan(1);
    expect(inboxRequests.every((u) => u.includes('projectIds='))).toBe(true);
    // It filled in: earlier states were partial and smaller.
    const partial = seen.filter((s) => s.partial);
    expect(partial.length).toBeGreaterThan(0);
    for (const s of partial) expect(s.data.entries.length).toBeLessThan(final.entries.length);
    // The render that shows the complete data already sees the flag clear.
    expect(seen.at(-1)?.partial).toBe(false);

    // A refetch is one request, and the data is replaced once it is in.
    inboxRequests.length = 0;
    await queryClient.refetchQueries({ queryKey: options.queryKey });
    expect(inboxRequests).toHaveLength(1);
    expect(inboxRequests[0]).not.toContain('projectIds=');
    const after = queryClient.getQueryData<InboxResponse>(options.queryKey);
    expect(ids(after)).toEqual(ids(expected));
    expect(isPartialInbox({ kind: 'working' })).toBe(false);
  });

  it('a review mark made while batches are still landing keeps the inbox partial', async () => {
    // A cache patch replaces the data with a new object; bulk "all" must still see it as incomplete.
    const { api, queryClient } = harness('large');
    await queryClient.fetchQuery({
      queryKey: queryKeys.projects(),
      queryFn: () => api.listProjects(),
    });
    const options = inboxQueryOptions(api, queryClient, { kind: 'working' });
    let patched = false;
    let partialAfterMark: boolean | null = null;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (patched || event.type !== 'updated' || event.query.queryKey[0] !== 'inbox') return;
      const data = event.query.state.data as InboxResponse | undefined;
      if (!data || !isPartialInbox({ kind: 'working' })) return;
      const entry = data.entries.find((e) => e.files.length > 0);
      const file = entry?.files[0];
      if (!entry || !file) return;
      patched = true;
      applyReviewToCaches(queryClient, {
        projectId: entry.project.id,
        scopeKind: 'working',
        path: file.path,
        patchHash: file.patchHash,
        reviewed: !file.reviewed,
      });
      partialAfterMark = isPartialInbox({ kind: 'working' });
    });
    await queryClient.fetchQuery(options);
    unsubscribe();
    expect(patched).toBe(true);
    expect(partialAfterMark).toBe(true);
  });
});
