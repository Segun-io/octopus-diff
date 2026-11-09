import { describe, expect, it } from 'vitest';
import {
  formatSseComment,
  formatSseEvent,
  parseServerEvent,
  SERVER_EVENT_TYPES,
  type ServerEvent,
  ServerEventSchema,
  SseParser,
} from '../src/index.js';

const id = '0123456789abcdef';

describe('SseParser', () => {
  it('parses named events with ids', () => {
    const parser = new SseParser();
    const out = parser.push('event: worktree.changed\nid: 7\ndata: {"a":1}\n\n');
    expect(out).toEqual([
      { event: 'worktree.changed', data: '{"a":1}', id: '7', retry: undefined },
    ]);
    expect(parser.lastEventId).toBe('7');
  });

  it('handles chunk boundaries anywhere, including between CR and LF', () => {
    const frame = 'event: x\r\ndata: one\r\ndata: two\r\n\r\n';
    for (let split = 0; split <= frame.length; split++) {
      const parser = new SseParser();
      const out = [...parser.push(frame.slice(0, split)), ...parser.push(frame.slice(split))];
      expect(out).toEqual([{ event: 'x', data: 'one\ntwo', id: undefined, retry: undefined }]);
    }
  });

  it('ignores comments, unknown fields and data-less events; defaults event to message', () => {
    const parser = new SseParser();
    const out = parser.push(': ping\n\nfoo: bar\n\nevent: empty\n\ndata:x\nretry: 500\n\n');
    expect(out).toEqual([{ event: 'message', data: 'x', id: undefined, retry: 500 }]);
  });

  it('accepts bare CR line endings', () => {
    const parser = new SseParser();
    expect(parser.push('data: a\r\rdata: b\r\r')).toEqual([
      { event: 'message', data: 'a', id: undefined, retry: undefined },
      { event: 'message', data: 'b', id: undefined, retry: undefined },
    ]);
  });
});

describe('server events', () => {
  const samples: ServerEvent[] = [
    { type: 'hello', version: '0.0.0', startedAt: new Date(0).toISOString() },
    { type: 'worktree.changed', projectId: id, worktreeId: id, stateHash: 'abc' },
    { type: 'worktree.added', projectId: id, worktreeId: id },
    { type: 'worktree.removed', projectId: id, worktreeId: id },
    { type: 'project.added', projectId: id },
    { type: 'project.updated', projectId: id },
    { type: 'project.removed', projectId: id },
    {
      type: 'scan.progress',
      scanRootId: id,
      state: 'scanning',
      scannedDirs: 3,
      foundRepos: 1,
      message: null,
    },
    {
      type: 'review.changed',
      projectId: id,
      scopeKind: 'working',
      path: 'a.txt',
      patchHash: 'p',
      reviewed: true,
    },
    { type: 'review.bulk', projectIds: [id], reviewed: true, changed: 12 },
    { type: 'settings.changed', revision: 3 },
    { type: 'forge.updated', projectIds: ['0123456789abcdef'] },
  ];

  it('covers every event type in SERVER_EVENT_TYPES', () => {
    expect(samples.map((s) => s.type).sort()).toEqual([...SERVER_EVENT_TYPES].sort());
  });

  it('round-trips through the SSE wire format', () => {
    const parser = new SseParser();
    const wire = samples.map((event, i) => formatSseEvent(event, i)).join(formatSseComment());
    const messages = parser.push(wire);
    expect(messages.map((m) => m.event)).toEqual(samples.map((s) => s.type));
    expect(messages.map((m) => parseServerEvent(m))).toEqual(samples);
    for (const event of samples) expect(ServerEventSchema.parse(event)).toEqual(event);
  });

  it('returns null for unknown or malformed events', () => {
    expect(parseServerEvent({ data: '{"type":"future.event"}' })).toBeNull();
    expect(parseServerEvent({ data: 'not json' })).toBeNull();
  });
});
