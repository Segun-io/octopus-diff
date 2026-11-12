/**
 * #38: the live-view contracts are additive: a new entry schema and two routes, an optional
 * `activitySeq` on `worktree.changed` and an optional `counts.deleted`. Older payloads still parse.
 */
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_BLOB_MAX_BYTES,
  ActivityEntrySchema,
  ActivityQuerySchema,
  ActivityResponseSchema,
  BlobQuerySchema,
  BlobResponseSchema,
  buildPath,
  ChangeCountsSchema,
  createApiClient,
  parseServerEvent,
  ROUTES,
} from '../src/index.js';

const at = '2026-11-12T10:00:00.000Z';
const oid = 'c'.repeat(40);
const worktreeId = '0123456789abcdef';

describe('activity contracts', () => {
  it('parses each kind of entry', () => {
    const base = { id: 1, seq: 1, at, updatedAt: at, count: 1 };
    const entries = [
      { ...base, kind: 'modified', path: 'a.ts', xy: '.M', added: 3, deleted: 1 },
      { ...base, kind: 'deleted', path: 'b.ts', xy: '.D', oid, added: 0, deleted: 9 },
      { ...base, kind: 'deleted', path: 'tmp.log', oid: null, untracked: true },
      { ...base, kind: 'restored', path: 'c.ts' },
      { ...base, kind: 'added', path: 'd.ts', xy: '??', added: 2, deleted: 0, origin: 'base' },
      { ...base, kind: 'commit', sha: 'd'.repeat(40), subject: 'wip', paths: ['a'], pathCount: 1 },
      { ...base, kind: 'head', op: 'checkout', from: null, to: 'e'.repeat(40), branch: 'x' },
      {
        ...base,
        kind: 'bulk',
        paths: ['a'],
        pathCount: 60,
        kinds: { added: 60, modified: 0, deleted: 0, restored: 0 },
      },
    ];
    for (const e of entries) expect(ActivityEntrySchema.parse(e)).toEqual(e);
    expect(ActivityEntrySchema.safeParse({ ...base, kind: 'renamed' }).success).toBe(false);
    expect(ActivityEntrySchema.safeParse({ ...base, kind: 'deleted', oid: 'abc' }).success).toBe(
      false,
    );
    expect(ActivityEntrySchema.safeParse({ ...base, kind: 'added', count: 0 }).success).toBe(false);
  });

  it('validates the queries', () => {
    expect(ActivityQuerySchema.parse({})).toEqual({ after: 0 });
    expect(ActivityQuerySchema.parse({ after: '42' })).toEqual({ after: 42 });
    for (const after of ['-1', '1.5', 'x', '1e400']) {
      expect(ActivityQuerySchema.safeParse({ after }).success).toBe(false);
    }
    expect(BlobQuerySchema.parse({})).toEqual({});
    expect(BlobQuerySchema.parse({ maxBytes: '100' })).toEqual({ maxBytes: 100 });
    expect(
      BlobQuerySchema.safeParse({ maxBytes: String(ACTIVITY_BLOB_MAX_BYTES + 1) }).success,
    ).toBe(false);
    expect(BlobQuerySchema.safeParse({ maxBytes: '0' }).success).toBe(false);
  });

  it('parses responses', () => {
    const activity = {
      worktreeId,
      entries: [],
      seq: 0,
      dropped: false,
      live: true,
      watch: { mode: 'polling', pollMs: 5000 },
    };
    expect(ActivityResponseSchema.parse(activity)).toEqual(activity);
    const blob = {
      worktreeId,
      blob: { oid, kind: 'text', size: 3, maxBytes: 1024, content: 'hi\n' },
    };
    expect(BlobResponseSchema.parse(blob)).toEqual(blob);
  });

  it('keeps older payloads valid (additive fields are optional)', () => {
    const counts = { staged: 0, unstaged: 1, untracked: 0, conflicted: 0 };
    expect(ChangeCountsSchema.parse(counts)).toEqual(counts);
    expect(ChangeCountsSchema.parse({ ...counts, deleted: 2 }).deleted).toBe(2);
    const changed = { type: 'worktree.changed', projectId: worktreeId, worktreeId, stateHash: 'h' };
    expect(parseServerEvent({ data: JSON.stringify(changed) })).toEqual(changed);
    expect(parseServerEvent({ data: JSON.stringify({ ...changed, activitySeq: 7 }) })).toEqual({
      ...changed,
      activitySeq: 7,
    });
  });

  it('builds the route paths and client calls', async () => {
    expect(buildPath(ROUTES.getActivity.path, { worktreeId })).toBe(
      `/api/worktrees/${worktreeId}/activity`,
    );
    expect(buildPath(ROUTES.getBlob.path, { worktreeId, oid })).toBe(
      `/api/worktrees/${worktreeId}/blob/${oid}`,
    );
    const urls: string[] = [];
    const api = createApiClient({
      baseUrl: 'http://d',
      token: 't',
      fetch: async (input) => {
        urls.push(String(input));
        const body = String(input).includes('/blob/')
          ? { worktreeId, blob: { oid, kind: 'binary', size: 9, maxBytes: 5, content: null } }
          : {
              worktreeId,
              entries: [],
              seq: 3,
              dropped: false,
              live: true,
              watch: { mode: 'native', pollMs: 30000 },
            };
        return new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    expect((await api.getActivity(worktreeId, { after: 3 })).seq).toBe(3);
    expect((await api.getBlob(worktreeId, oid, { maxBytes: 5 })).blob.kind).toBe('binary');
    expect(urls).toEqual([
      `http://d/api/worktrees/${worktreeId}/activity?after=3`,
      `http://d/api/worktrees/${worktreeId}/blob/${oid}?maxBytes=5`,
    ]);
  });
});
