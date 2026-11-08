import { randomBytes } from 'node:crypto';
import {
  formatSseComment,
  formatSseEvent,
  type ServerEvent,
  SSE_HEARTBEAT_INTERVAL_MS,
} from '@octopus-diff/contracts';

export interface EventHubOptions {
  /** Interval of `: ping` comments (default `SSE_HEARTBEAT_INTERVAL_MS` = 15 s). */
  heartbeatMs?: number;
  /** Events kept for `Last-Event-ID` replay (default 1000). */
  replayBufferSize?: number;
  /** A client whose queue grows beyond this many frames is disconnected (default 2000). */
  maxQueuedFrames?: number;
}

interface BufferedEvent {
  seq: number;
  event: ServerEvent;
  frame: string;
}

interface SseClient {
  controller: ReadableStreamDefaultController<Uint8Array>;
  closed: boolean;
}

export type EventListener = (event: ServerEvent, id: string) => void;

const encoder = new TextEncoder();

/**
 * Fan-out of server events to SSE clients and in-process listeners. Event ids are
 * `<bootId>.<seq>`, so a client reconnecting with `Last-Event-ID` gets the missed events
 * replayed from a bounded buffer, and ids from a previous daemon run are never confused with
 * the current one.
 */
export class EventHub {
  readonly bootId = randomBytes(6).toString('hex');
  readonly #heartbeatMs: number;
  readonly #bufferSize: number;
  readonly #maxQueued: number;
  readonly #buffer: BufferedEvent[] = [];
  readonly #clients = new Set<SseClient>();
  readonly #listeners = new Set<EventListener>();
  #seq = 0;
  #heartbeat: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: EventHubOptions = {}) {
    this.#heartbeatMs = Math.max(10, options.heartbeatMs ?? SSE_HEARTBEAT_INTERVAL_MS);
    this.#bufferSize = Math.max(0, options.replayBufferSize ?? 1000);
    this.#maxQueued = Math.max(16, options.maxQueuedFrames ?? 2000);
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

  emit(event: ServerEvent): void {
    if (this.#closed) return;
    const seq = ++this.#seq;
    const id = `${this.bootId}.${seq}`;
    const frame = formatSseEvent(event, id);
    if (this.#bufferSize > 0) {
      this.#buffer.push({ seq, event, frame });
      if (this.#buffer.length > this.#bufferSize) this.#buffer.shift();
    }
    const bytes = encoder.encode(frame);
    for (const client of this.#clients) this.#send(client, bytes);
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
   * that are still buffered, then live events and heartbeats until the client disconnects or
   * the hub closes.
   */
  createStream(hello: ServerEvent, lastEventId?: string | null): ReadableStream<Uint8Array> {
    let client: SseClient | undefined;
    return new ReadableStream<Uint8Array>(
      {
        start: (controller) => {
          client = { controller, closed: false };
          if (this.#closed) {
            controller.close();
            client.closed = true;
            return;
          }
          this.#send(client, encoder.encode(formatSseEvent(hello)));
          for (const missed of this.#replayAfter(lastEventId)) {
            this.#send(client, encoder.encode(missed.frame));
          }
          this.#clients.add(client);
          this.#ensureHeartbeat();
        },
        cancel: () => {
          if (client) this.#drop(client, false);
        },
      },
      { highWaterMark: 1 },
    );
  }

  #replayAfter(lastEventId: string | null | undefined): BufferedEvent[] {
    if (!lastEventId) return [];
    const dot = lastEventId.lastIndexOf('.');
    if (dot <= 0) return [];
    if (lastEventId.slice(0, dot) !== this.bootId) return [];
    const seq = Number(lastEventId.slice(dot + 1));
    if (!Number.isInteger(seq) || seq < 0 || seq > this.#seq) return [];
    return this.#buffer.filter((e) => e.seq > seq);
  }

  #send(client: SseClient, bytes: Uint8Array): void {
    if (client.closed) return;
    try {
      const desired = client.controller.desiredSize;
      if (desired !== null && desired < -this.#maxQueued) {
        // Slow consumer: disconnect it; it reconnects with Last-Event-ID.
        this.#drop(client, true);
        return;
      }
      client.controller.enqueue(bytes);
    } catch {
      this.#drop(client, false);
    }
  }

  #drop(client: SseClient, closeController: boolean): void {
    if (client.closed) return;
    client.closed = true;
    this.#clients.delete(client);
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
    const ping = encoder.encode(formatSseComment('ping'));
    this.#heartbeat = setInterval(() => {
      for (const client of this.#clients) this.#send(client, ping);
    }, this.#heartbeatMs);
    this.#heartbeat.unref();
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    this.#heartbeat = undefined;
  }

  /** Ends every stream and stops heartbeats. Further events are dropped. */
  close(): void {
    this.#closed = true;
    for (const client of [...this.#clients]) this.#drop(client, true);
    this.#stopHeartbeat();
    this.#listeners.clear();
  }
}
