/**
 * The event hub on a `PubSub` (#48): the SSE protocol (ids, replay, slim replay, heartbeats) with
 * the heartbeat on Effect's `TestClock`, scoped subscriptions released when a client goes away,
 * the slow-client policy, and no leak over 1000 connect/disconnect cycles. `events.test.ts` keeps
 * the original protocol tests, unchanged.
 */
import { getEventListeners } from 'node:events';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { assert, describe, it } from '@effect/vitest';
import { type ServerEvent, SSE_HEARTBEAT_INTERVAL_MS } from '@octopus-diff/contracts';
import * as Effect from 'effect/Effect';
import * as TestClock from 'effect/testing/TestClock';
import { expect, it as vitestIt } from 'vitest';
import { EventHub } from '../src/events.js';
import { FakeGitCore } from './fake-git-core.js';
import { eventually, http, startTestDaemon, tempDir } from './helpers.js';

const hello: ServerEvent = { type: 'hello', version: 't', startedAt: '2026-11-08T00:00:00.000Z' };
const projectAdded = (n: number): ServerEvent => ({
  type: 'project.added',
  projectId: n.toString(16).padStart(16, '0'),
});

/** Reads a stream in the background into `text`; `stop()` cancels the reader. */
function drain(stream: ReadableStream<Uint8Array<ArrayBuffer>>) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  const state = { text: '', done: false };
  const loop = (async () => {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      state.text += value;
    }
    state.done = true;
  })().catch(() => {
    state.done = true;
  });
  return {
    state,
    frames: () => state.text.split('\n\n').filter((f) => f.length > 0),
    ids: () => [...state.text.matchAll(/^id: (\S+)$/gm)].map((m) => m[1]),
    stop: async () => {
      await reader.cancel().catch(() => {});
      await loop;
    },
    ended: () => loop,
  };
}

/** Lets fibers and stream reads run; no time passes on the TestClock. */
const settle = Effect.promise(
  () => new Promise<void>((resolve) => setImmediate(() => setImmediate(resolve))),
);

const untilReal = (what: string, check: () => boolean, ms = 10_000) =>
  Effect.promise(async () => {
    const deadline = Date.now() + ms;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setImmediate(resolve));
    }
  });

describe('EventHub on PubSub (TestClock)', () => {
  it.effect('pings every heartbeatMs on the test clock, only while clients are connected', () =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const hub = new EventHub({ context });
      const client = drain(hub.createStream(hello));
      yield* settle;
      assert.strictEqual(hub.diagnostics.heartbeat, true);
      yield* TestClock.adjust(SSE_HEARTBEAT_INTERVAL_MS - 1);
      yield* settle;
      assert.notInclude(client.state.text, ': ping');
      yield* TestClock.adjust(1);
      yield* untilReal('the first ping', () => client.state.text.includes(': ping'));
      assert.strictEqual(client.state.text.split(': ping').length - 1, 1);
      yield* TestClock.adjust(SSE_HEARTBEAT_INTERVAL_MS);
      yield* untilReal('the second ping', () => client.state.text.split(': ping').length === 3);

      // The last client leaves: the heartbeat fiber ends, and so does every other fiber.
      yield* Effect.promise(() => client.stop());
      assert.strictEqual(hub.clientCount, 0);
      assert.deepStrictEqual(hub.diagnostics, {
        clients: 0,
        subscriptions: 0,
        fibers: 0,
        heartbeat: false,
      });
      hub.close();
    }),
  );

  it.effect('a stalled client is disconnected at maxQueuedFrames and blocks nobody', () =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const hub = new EventHub({ context, maxQueuedFrames: 16, replayBufferSize: 1000 });
      // Never read: its frames stay queued in its subscription.
      const stalled = hub.createStream(hello);
      const fast = drain(hub.createStream(hello));
      yield* settle;
      assert.strictEqual(hub.clientCount, 2);
      for (let i = 1; i <= 100; i++) {
        hub.emit(projectAdded(i));
        if (i % 10 === 0) yield* settle;
      }
      // Dropped once more than 16 frames waited for it, not later.
      assert.strictEqual(hub.clientCount, 1);
      yield* untilReal('every event at the fast client', () => fast.ids().length === 100);
      assert.deepStrictEqual(
        fast.ids(),
        Array.from({ length: 100 }, (_, i) => `${hub.bootId}.${i + 1}`),
      );
      // The stalled stream ends after what was already handed to it (hello, maybe one batch).
      const reader = stalled.pipeThrough(new TextDecoderStream()).getReader();
      let text = '';
      for (;;) {
        const { value, done } = yield* Effect.promise(() => reader.read());
        if (done) break;
        text += value;
      }
      assert.include(text, 'event: hello');
      assert.isAtMost(text.split('event: project.added').length - 1, 17);
      // It reconnects with Last-Event-ID and gets what it missed from the replay buffer.
      const lastId = [...text.matchAll(/^id: (\S+)$/gm)].map((m) => m[1]).pop() ?? '';
      const back = drain(hub.createStream(hello, lastId === '' ? `${hub.bootId}.0` : lastId));
      yield* untilReal('the replay', () => back.ids().at(-1) === `${hub.bootId}.100`);
      yield* Effect.promise(() => Promise.all([fast.stop(), back.stop()]));
      assert.deepStrictEqual(hub.diagnostics, {
        clients: 0,
        subscriptions: 0,
        fibers: 0,
        heartbeat: false,
      });
      hub.close();
    }),
  );

  it.effect('releases the subscription when the request signal aborts', () =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const hub = new EventHub({ context });
      const controller = new AbortController();
      const client = drain(hub.createStream(hello, null, controller.signal));
      yield* settle;
      assert.strictEqual(hub.clientCount, 1);
      controller.abort();
      assert.strictEqual(hub.clientCount, 0);
      yield* Effect.promise(() => client.ended());
      assert.deepStrictEqual(hub.diagnostics, {
        clients: 0,
        subscriptions: 0,
        fibers: 0,
        heartbeat: false,
      });
      // Dropped another way (the stream is cancelled): its listener leaves the signal too.
      const kept = new AbortController();
      const other = drain(hub.createStream(hello, null, kept.signal));
      yield* settle;
      assert.strictEqual(getEventListeners(kept.signal, 'abort').length, 1);
      yield* Effect.promise(() => other.stop());
      assert.strictEqual(getEventListeners(kept.signal, 'abort').length, 0);
      // An already aborted signal never subscribes.
      const late = drain(hub.createStream(hello, null, controller.signal));
      yield* Effect.promise(() => late.ended());
      assert.strictEqual(late.state.text, '');
      assert.strictEqual(hub.clientCount, 0);
      hub.close();
    }),
  );

  it.effect('replays the slim form and streams the full one, ids in order across bursts', () =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const hub = new EventHub({ context, replayBufferSize: 3 });
      const live = drain(hub.createStream(hello));
      yield* settle;
      // `replay` is kept instead of the event: here a full form with a field the slim one lacks.
      const slim: ServerEvent = {
        type: 'worktree.changed',
        projectId: 'a'.repeat(16),
        worktreeId: 'b'.repeat(16),
        stateHash: 's1',
      };
      const full: ServerEvent = { ...slim, activitySeq: 3 };
      hub.emit(projectAdded(1));
      hub.emit(full, slim);
      // A burst emitted synchronously reaches the client in order (and in one chunk).
      for (let i = 2; i <= 6; i++) hub.emit(projectAdded(i));
      yield* untilReal('the burst', () => live.ids().length === 7);
      assert.deepStrictEqual(
        live.ids(),
        Array.from({ length: 7 }, (_, i) => `${hub.bootId}.${i + 1}`),
      );
      assert.include(live.state.text, '"activitySeq":3');

      const replayed = drain(hub.createStream(hello, `${hub.bootId}.1`));
      yield* untilReal('the replay', () => replayed.ids().length === 3);
      // Buffer of 3: events 5, 6, 7; the slim event (2) fell out. Then replay from 1 of a
      // buffer that still holds it:
      assert.deepStrictEqual(
        replayed.ids(),
        [5, 6, 7].map((n) => `${hub.bootId}.${n}`),
      );
      const hub2 = new EventHub({ context });
      hub2.emit(projectAdded(1));
      hub2.emit(full, slim);
      const again = drain(hub2.createStream(hello, `${hub2.bootId}.1`));
      yield* untilReal('the slim replay', () => again.ids().length === 1);
      assert.include(again.state.text, `id: ${hub2.bootId}.2`);
      assert.notInclude(again.state.text, 'activitySeq');
      assert.include(again.state.text, '"stateHash":"s1"');
      yield* Effect.promise(() => Promise.all([live.stop(), replayed.stop(), again.stop()]));
      hub.close();
      hub2.close();
    }),
  );

  it.effect('close ends every stream and interrupts every fiber; later emits are dropped', () =>
    Effect.gen(function* () {
      const context = yield* Effect.context<never>();
      const hub = new EventHub({ context });
      const a = drain(hub.createStream(hello));
      const b = drain(hub.createStream(hello));
      yield* settle;
      assert.isAbove(hub.diagnostics.fibers, 0);
      hub.close();
      yield* Effect.promise(() => Promise.all([a.ended(), b.ended()]));
      assert.deepStrictEqual(hub.diagnostics, {
        clients: 0,
        subscriptions: 0,
        fibers: 0,
        heartbeat: false,
      });
      hub.emit(projectAdded(1));
      assert.strictEqual(hub.lastEventId, null);
      const late = drain(hub.createStream(hello));
      yield* Effect.promise(() => late.ended());
      assert.strictEqual(late.state.text, '');
    }),
  );
});

function forceGc(): void {
  setFlagsFromString('--expose-gc');
  (runInNewContext('gc') as () => void)();
}

const timeouts = () => process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;

describe('EventHub leaks', () => {
  vitestIt(
    '1000 SSE connect/disconnect cycles over HTTP leave nothing behind',
    async () => {
      const daemon = await startTestDaemon({ fake: new FakeGitCore(), stateDir: await tempDir() });
      const hub = daemon.hub;
      // Warm up (first connections allocate lazily), then measure.
      const cycle = async (i: number) => {
        const controller = new AbortController();
        const res = await http(daemon, '/api/events', { signal: controller.signal });
        const reader = res.body?.getReader();
        if (!reader) throw new Error('no body');
        await reader.read(); // hello
        if (i % 2 === 0) hub.emit(projectAdded(i)); // half of them with a pull in progress
        if (i % 3 === 0) await reader.cancel();
        else controller.abort();
      };
      for (let i = 0; i < 50; i++) await cycle(i);
      await eventually(() => hub.clientCount === 0, 5000);
      forceGc();
      const heapBefore = process.memoryUsage().heapUsed;
      const timersBefore = timeouts();
      for (let i = 0; i < 1000; i++) await cycle(i);
      await eventually(() => hub.clientCount === 0, 10_000);
      expect(hub.diagnostics).toEqual({
        clients: 0,
        subscriptions: 0,
        fibers: 0,
        heartbeat: false,
      });
      await eventually(() => timeouts() <= timersBefore, 5000);
      forceGc();
      const grown = process.memoryUsage().heapUsed - heapBefore;
      // 1000 connections that were kept would hold their subscriptions, scopes and streams.
      expect(grown).toBeLessThan(8 * 1024 * 1024);
    },
    60_000,
  );

  vitestIt('1000 in-process stream cycles release their subscriptions', async () => {
    const hub = new EventHub();
    forceGc();
    const heapBefore = process.memoryUsage().heapUsed;
    for (let i = 0; i < 1000; i++) {
      const stream = hub.createStream(hello);
      const reader = stream.getReader();
      await reader.read();
      const pending = reader.read(); // a pull waiting for frames
      hub.emit(projectAdded(i));
      await pending;
      void reader.read();
      await reader.cancel();
    }
    expect(hub.diagnostics).toEqual({ clients: 0, subscriptions: 0, fibers: 0, heartbeat: false });
    forceGc();
    expect(process.memoryUsage().heapUsed - heapBefore).toBeLessThan(4 * 1024 * 1024);
    hub.close();
  });
});
