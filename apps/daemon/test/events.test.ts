import { parseServerEvent, type ServerEvent, SseParser } from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import { EventHub } from '../src/events.js';
import { FakeGitCore } from './fake-git-core.js';
import { http, startTestDaemon, tempDir } from './helpers.js';

const hello: ServerEvent = { type: 'hello', version: 't', startedAt: '2026-11-08T00:00:00.000Z' };
const projectAdded = (n: number): ServerEvent => ({
  type: 'project.added',
  projectId: n.toString(16).padStart(16, '0'),
});

async function readFrames(
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
  count: number,
): Promise<string[]> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  const frames: string[] = [];
  while (frames.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += value;
    const parts = text.split('\n\n');
    text = parts.pop() ?? '';
    frames.push(...parts);
  }
  await reader.cancel();
  return frames;
}

describe('EventHub', () => {
  it('sends hello first, then live events with ids', async () => {
    const hub = new EventHub();
    const stream = hub.createStream(hello);
    hub.emit(projectAdded(1));
    const frames = await readFrames(stream, 2);
    expect(frames[0]).toBe(`event: hello\ndata: ${JSON.stringify(hello)}`);
    expect(frames[1]).toContain('event: project.added');
    expect(frames[1]).toContain(`id: ${hub.bootId}.1`);
    hub.close();
  });

  it('replays buffered events after Last-Event-ID, only for the same boot', async () => {
    const hub = new EventHub({ replayBufferSize: 3 });
    for (let i = 1; i <= 5; i++) hub.emit(projectAdded(i));
    const replay = await readFrames(hub.createStream(hello, `${hub.bootId}.3`), 3);
    expect(replay.slice(1).map((f) => /id: (\S+)/.exec(f)?.[1])).toEqual([
      `${hub.bootId}.4`,
      `${hub.bootId}.5`,
    ]);
    const other = hub.createStream(hello, 'otherboot.3');
    hub.emit(projectAdded(6));
    const frames = await readFrames(other, 2);
    expect(frames[1]).toContain(`id: ${hub.bootId}.6`);
    hub.close();
  });

  it('sends heartbeats and ends streams on close', async () => {
    const hub = new EventHub({ heartbeatMs: 20 });
    const stream = hub.createStream(hello);
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    let text = '';
    while (!text.includes(': ping')) text += (await reader.read()).value ?? '';
    expect(hub.clientCount).toBe(1);
    hub.close();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(hub.clientCount).toBe(0);
  });

  it('notifies in-process listeners and drops clients that cancel', async () => {
    const hub = new EventHub();
    const seen: string[] = [];
    const off = hub.on((event, id) => seen.push(`${event.type}@${id}`));
    const stream = hub.createStream(hello);
    await stream.cancel();
    expect(hub.clientCount).toBe(0);
    hub.emit(projectAdded(1));
    off();
    hub.emit(projectAdded(2));
    expect(seen).toEqual([`project.added@${hub.bootId}.1`]);
    hub.close();
  });
});

describe('GET /api/events over HTTP', () => {
  it('streams contract-valid events with the right headers and honors Last-Event-ID', async () => {
    const daemon = await startTestDaemon({
      fake: new FakeGitCore(),
      stateDir: await tempDir(),
      internal: { heartbeatMs: 50 },
    });
    const controller = new AbortController();
    const res = await http(daemon, '/api/events', { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-store');
    const reader = res.body?.pipeThrough(new TextDecoderStream()).getReader();
    if (!reader) throw new Error('no body');
    const parser = new SseParser();
    const received: ServerEvent[] = [];
    let raw = '';
    daemon.hub.emit(projectAdded(7));
    while (received.length < 2 || !raw.includes(': ping')) {
      const { value } = await reader.read();
      raw += value ?? '';
      for (const m of parser.push(value ?? '')) {
        const e = parseServerEvent(m);
        if (e) received.push(e);
      }
    }
    expect(received[0]?.type).toBe('hello');
    expect(received[1]).toEqual(projectAdded(7));
    const lastId = parser.lastEventId;
    controller.abort();

    daemon.hub.emit(projectAdded(8));
    const res2 = await http(daemon, '/api/events', { headers: { 'last-event-id': lastId ?? '' } });
    const reader2 = res2.body?.pipeThrough(new TextDecoderStream()).getReader();
    if (!reader2) throw new Error('no body');
    const parser2 = new SseParser();
    const replayed: ServerEvent[] = [];
    while (replayed.length < 2) {
      const { value } = await reader2.read();
      for (const m of parser2.push(value ?? '')) {
        const e = parseServerEvent(m);
        if (e) replayed.push(e);
      }
    }
    expect(replayed[1]).toEqual(projectAdded(8));
    await daemon.close();
    for (;;) {
      const { done } = await reader2.read();
      if (done) break;
    }
  });

  it('requires auth', async () => {
    const daemon = await startTestDaemon({ fake: new FakeGitCore(), stateDir: await tempDir() });
    const res = await http(daemon, '/api/events', { auth: false });
    expect(res.status).toBe(401);
  });
});
