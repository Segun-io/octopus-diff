import { randomBytes } from 'node:crypto';
import {
  formatSseComment,
  formatSseEvent,
  type ServerEvent,
  SSE_HEARTBEAT_INTERVAL_MS,
} from '@octopus-diff/contracts';
import type * as Context from 'effect/Context';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Exit from 'effect/Exit';
import type * as Fiber from 'effect/Fiber';
import * as Option from 'effect/Option';
import * as PubSub from 'effect/PubSub';
import * as Scope from 'effect/Scope';
import { Timers } from './timers.js';

export interface EventHubOptions {
  /** Interval of `: ping` comments (default `SSE_HEARTBEAT_INTERVAL_MS` = 15 s). */
  heartbeatMs?: number;
  /** Events kept for `Last-Event-ID` replay (default 1000). */
  replayBufferSize?: number;
  /** A client whose queue grows beyond this many frames is disconnected (default 2000). */
  maxQueuedFrames?: number;
  /**
   * Tests only: the Effect context of the hub's fibers (inside `it.effect`,
   * `yield* Effect.context<never>()`, whose `TestClock` then drives the heartbeat).
   */
  context?: Context.Context<never>;
}

interface BufferedEvent {
  seq: number;
  event: ServerEvent;
  frame: string;
}

interface SseClient {
  controller: ReadableStreamDefaultController<Uint8Array<ArrayBuffer>>;
  /** Owns the client's subscription: closing it unsubscribes. */
  scope: Scope.Closeable;
  subscription: PubSub.Subscription<Uint8Array<ArrayBuffer>>;
  /** The fiber waiting for the next frames (a pull in progress). */
  waiting: Fiber.Fiber<unknown, unknown> | null;
  /** Removes the listener on the request's signal. */
  offAbort: (() => void) | null;
  closed: boolean;
}

export type EventListener = (event: ServerEvent, id: string) => void;

const encoder = new TextEncoder();

/** The last `size` events, oldest first (a ring: no `shift()` per event). */
class ReplayRing {
  readonly #items: Array<BufferedEvent | undefined>;
  #start = 0;
  #length = 0;

  constructor(size: number) {
    this.#items = new Array(size);
  }

  push(item: BufferedEvent): void {
    const size = this.#items.length;
    if (size === 0) return;
    if (this.#length < size) {
      this.#items[(this.#start + this.#length) % size] = item;
      this.#length++;
    } else {
      this.#items[this.#start] = item;
      this.#start = (this.#start + 1) % size;
    }
  }

  /** Buffered events with a sequence number above `seq`, oldest first. */
  after(seq: number): BufferedEvent[] {
    const out: BufferedEvent[] = [];
    const size = this.#items.length;
    for (let i = 0; i < this.#length; i++) {
      const item = this.#items[(this.#start + i) % size];
      if (item && item.seq > seq) out.push(item);
    }
    return out;
  }
}

function concat(chunks: readonly Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer> {
  if (chunks.length === 1) return chunks[0] as Uint8Array<ArrayBuffer>;
  let length = 0;
  for (const c of chunks) length += c.byteLength;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Fan-out of server events to SSE clients and in-process listeners. Event ids are
 * `<bootId>.<seq>`, so a client reconnecting with `Last-Event-ID` gets the missed events
 * replayed from a bounded buffer, and ids from a previous daemon run are never confused with
 * the current one.
 *
 * On Effect (#48, DECISIONS #446): frames are published to an unbounded `PubSub`; every SSE
 * connection holds a subscription in a `Scope` of its own, which the stream's `pull` drains and
 * which is closed when the client goes away (the body stream is cancelled, or `signal` aborts),
 * when the client is too slow, or when the hub closes. Heartbeats are a fiber on the hub's clock
 * that runs while at least one client is connected. In-process listeners stay synchronous.
 */
export class EventHub {
  readonly bootId = randomBytes(6).toString('hex');
  readonly #heartbeatMs: number;
  readonly #maxQueued: number;
  readonly #ring: ReplayRing;
  readonly #replayEnabled: boolean;
  readonly #timers: Timers;
  readonly #run: <A, E>(effect: Effect.Effect<A, E>) => A;
  readonly #pubsub: PubSub.PubSub<Uint8Array<ArrayBuffer>>;
  readonly #clients = new Set<SseClient>();
  readonly #listeners = new Set<EventListener>();
  readonly #ping = encoder.encode(formatSseComment('ping'));
  #seq = 0;
  /** Subscriptions whose scope is still open. */
  #subscriptions = 0;
  #heartbeat: Fiber.Fiber<unknown, unknown> | null = null;
  #closed = false;

  constructor(options: EventHubOptions = {}) {
    this.#heartbeatMs = Math.max(10, options.heartbeatMs ?? SSE_HEARTBEAT_INTERVAL_MS);
    const bufferSize = Math.max(0, options.replayBufferSize ?? 1000);
    this.#ring = new ReplayRing(bufferSize);
    this.#replayEnabled = bufferSize > 0;
    this.#maxQueued = Math.max(16, options.maxQueuedFrames ?? 2000);
    this.#timers = new Timers(options.context);
    this.#run = Effect.runSyncWith(this.#timers.context);
    this.#pubsub = this.#run(PubSub.unbounded<Uint8Array<ArrayBuffer>>());
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  get lastEventId(): string | null {
    return this.#seq === 0 ? null : `${this.bootId}.${this.#seq}`;
  }

  /** Subscribes an in-process listener; returns the unsubscribe function. */
  on(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Sends `event` to every client and listener. `replay` is what the `Last-Event-ID` buffer keeps
   * instead (default: the event itself): `worktree.changed` keeps its slim form there (#51), since a
   * reconnecting client resyncs anyway and the buffer should not hold 1000 rows and path lists.
   */
  emit(event: ServerEvent, replay: ServerEvent = event): void {
    if (this.#closed) return;
    const seq = ++this.#seq;
    const id = `${this.bootId}.${seq}`;
    const frame = formatSseEvent(event, id);
    if (this.#replayEnabled) {
      this.#ring.push({
        seq,
        event: replay,
        frame: replay === event ? frame : formatSseEvent(replay, id),
      });
    }
    if (this.#clients.size > 0) this.#publish(encoder.encode(frame));
    for (const listener of this.#listeners) {
      try {
        listener(event, id);
      } catch {
        // listeners must not break delivery
      }
    }
  }

  /**
   * Creates an SSE body stream: the `hello` event first, then any events after `lastEventId`
   * that are still buffered, then live events and heartbeats until the client disconnects (the
   * stream is cancelled or `signal` aborts) or the hub closes.
   */
  createStream(
    hello: ServerEvent,
    lastEventId?: string | null,
    signal?: AbortSignal,
  ): ReadableStream<Uint8Array<ArrayBuffer>> {
    let client: SseClient | undefined;
    return new ReadableStream<Uint8Array<ArrayBuffer>>(
      {
        start: (controller) => {
          if (this.#closed || signal?.aborted) {
            controller.close();
            return;
          }
          // Subscribe before reading the replay buffer: an event emitted from here on is in the
          // subscription, every earlier one in the buffer, none in both (emit is synchronous).
          const scope = Scope.makeUnsafe();
          const subscription = this.#run(
            Scope.provide(scope)(
              Effect.tap(PubSub.subscribe(this.#pubsub), () =>
                Effect.andThen(
                  Effect.sync(() => this.#subscriptions++),
                  Effect.addFinalizer(() => Effect.sync(() => this.#subscriptions--)),
                ),
              ),
            ),
          );
          const c: SseClient = {
            controller,
            scope,
            subscription,
            waiting: null,
            offAbort: null,
            closed: false,
          };
          client = c;
          controller.enqueue(encoder.encode(formatSseEvent(hello)));
          for (const missed of this.#replayAfter(lastEventId)) {
            controller.enqueue(encoder.encode(missed.frame));
          }
          this.#clients.add(c);
          if (signal) {
            const onAbort = () => this.#drop(c, true);
            signal.addEventListener('abort', onAbort, { once: true });
            c.offAbort = () => signal.removeEventListener('abort', onAbort);
          }
          this.#ensureHeartbeat();
        },
        pull: () => (client ? this.#pull(client) : undefined),
        cancel: () => {
          if (client) this.#drop(client, false);
        },
      },
      { highWaterMark: 1 },
    );
  }

  /** Waits for the next frames of `client` and hands them to its stream in one chunk. */
  #pull(client: SseClient): Promise<void> | undefined {
    if (client.closed) return undefined;
    return new Promise<void>((resolve) => {
      const fiber = this.#timers.fork(PubSub.takeAll(client.subscription));
      client.waiting = fiber;
      fiber.addObserver((exit) => {
        if (client.waiting === fiber) client.waiting = null;
        if (Exit.isSuccess(exit) && !client.closed) {
          try {
            client.controller.enqueue(concat(exit.value));
          } catch {
            this.#drop(client, false);
          }
        }
        resolve();
      });
    });
  }

  #publish(bytes: Uint8Array<ArrayBuffer>): void {
    PubSub.publishUnsafe(this.#pubsub, bytes);
    for (const client of this.#clients) {
      const queued = Option.getOrElse(PubSub.remainingUnsafe(client.subscription), () => 0);
      // Slow consumer: disconnect it; it reconnects with Last-Event-ID.
      if (queued > this.#maxQueued) this.#drop(client, true);
    }
  }

  #replayAfter(lastEventId: string | null | undefined): BufferedEvent[] {
    if (!lastEventId) return [];
    const dot = lastEventId.lastIndexOf('.');
    if (dot <= 0) return [];
    if (lastEventId.slice(0, dot) !== this.bootId) return [];
    const seq = Number(lastEventId.slice(dot + 1));
    if (!Number.isInteger(seq) || seq < 0 || seq > this.#seq) return [];
    return this.#ring.after(seq);
  }

  /** Releases a client: its subscription (scope), its waiting pull, and (optionally) its stream. */
  #drop(client: SseClient, closeController: boolean): void {
    if (client.closed) return;
    client.closed = true;
    this.#clients.delete(client);
    client.waiting?.interruptUnsafe();
    client.waiting = null;
    client.offAbort?.();
    client.offAbort = null;
    this.#run(Scope.close(client.scope, Exit.void));
    if (closeController) {
      try {
        client.controller.close();
      } catch {
        // already closed or errored
      }
    }
    if (this.#clients.size === 0) this.#stopHeartbeat();
  }

  #ensureHeartbeat(): void {
    if (this.#heartbeat || this.#closed) return;
    this.#heartbeat = this.#timers.fork(
      Effect.forever(
        Effect.andThen(
          Effect.sleep(Duration.millis(this.#heartbeatMs)),
          Effect.sync(() => this.#publish(this.#ping)),
        ),
      ),
    );
  }

  #stopHeartbeat(): void {
    this.#heartbeat?.interruptUnsafe();
    this.#heartbeat = null;
  }

  /** Connected clients' subscriptions and the hub's fibers (diagnostics and leak tests). */
  get diagnostics(): {
    clients: number;
    subscriptions: number;
    fibers: number;
    heartbeat: boolean;
  } {
    return {
      clients: this.#clients.size,
      subscriptions: this.#subscriptions,
      fibers: this.#timers.size,
      heartbeat: this.#heartbeat !== null,
    };
  }

  /** Ends every stream and stops heartbeats. Further events are dropped. */
  close(): void {
    this.#closed = true;
    for (const client of [...this.#clients]) this.#drop(client, true);
    this.#stopHeartbeat();
    this.#timers.close();
    this.#run(PubSub.shutdown(this.#pubsub));
    this.#listeners.clear();
  }
}
