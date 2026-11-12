/**
 * #43 follow-up (Greptile P2 on PR #95): the follow-up requests for overtaken rows are split by
 * the endpoint's limit (INBOX_WORKTREES_MAX ids), and a chunk that fails does not stop the others.
 */
import {
  type ApiClient,
  INBOX_WORKTREES_MAX,
  type InboxEntry,
  type InboxResponse,
} from '@octopus-diff/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inboxOvertakenRetry, settleOvertaken } from '../src/api/queries.ts';

const saved = [...inboxOvertakenRetry.delaysMs];
beforeEach(() => {
  inboxOvertakenRetry.delaysMs = [1, 1];
});
afterEach(() => {
  inboxOvertakenRetry.delaysMs = saved;
});

function entry(id: string, overtaken: boolean): InboxEntry {
  return {
    worktree: { id },
    summary: null,
    files: overtaken ? [] : [{ path: `${id}.txt` }],
    ...(overtaken ? { listing: 'overtaken' } : {}),
  } as unknown as InboxEntry;
}

const response = (entries: InboxEntry[]): InboxResponse => ({
  scope: { kind: 'working' },
  entries,
  generatedAt: '2026-11-12T00:00:00.000Z',
});

describe('settleOvertaken follow-ups', () => {
  it('splits more rows than the endpoint accepts into requests within its limit', async () => {
    const ids = Array.from({ length: 450 }, (_, i) => `w${i}`);
    const sizes: number[] = [];
    const api = {
      inbox: async (query: { worktreeIds?: string[] }) => {
        sizes.push(query.worktreeIds?.length ?? 0);
        // The endpoint rejects more than the limit.
        if ((query.worktreeIds?.length ?? 0) > INBOX_WORKTREES_MAX) throw new Error('400');
        return response((query.worktreeIds ?? []).map((id) => entry(id, false)));
      },
    } as unknown as ApiClient;
    const out = await settleOvertaken(api, response(ids.map((id) => entry(id, true))));
    expect(sizes.sort((a, b) => b - a)).toEqual([200, 200, 50]);
    expect(out.entries).toHaveLength(450);
    expect(out.entries.every((e) => e.listing === undefined && e.files.length === 1)).toBe(true);
  });

  it('a chunk that fails keeps its marked rows and does not stop the other chunks', async () => {
    const ids = Array.from({ length: 300 }, (_, i) => `w${i}`);
    const api = {
      inbox: async (query: { worktreeIds?: string[] }) => {
        const asked = query.worktreeIds ?? [];
        if (asked.includes('w0')) throw new Error('boom'); // the first chunk fails every time
        return response(asked.map((id) => entry(id, false)));
      },
    } as unknown as ApiClient;
    const out = await settleOvertaken(api, response(ids.map((id) => entry(id, true))));
    const first = out.entries.filter((e) => Number(e.worktree.id.slice(1)) < 200);
    const rest = out.entries.filter((e) => Number(e.worktree.id.slice(1)) >= 200);
    expect(first.every((e) => e.listing === 'overtaken')).toBe(true);
    expect(rest).toHaveLength(100);
    expect(rest.every((e) => e.listing === undefined && e.files.length === 1)).toBe(true);
  });
});
