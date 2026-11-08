import { z } from 'zod';
import { IdSchema, RawPathSchema, RepoPathSchema, TimestampSchema } from './common.js';
import { ScopeKindSchema } from './scope.js';

/**
 * Server-Sent Events on `GET /api/events`. Each event is sent as a *named* SSE event whose
 * `event:` field equals `type`, and whose `data:` is the JSON object (including `type`).
 * Events are deliberately small (ids + hashes); clients refetch what they need.
 * The server sends a `: ping` comment at least every 15 s to keep proxies from timing out.
 */
export const HelloEventSchema = z.object({
  type: z.literal('hello'),
  version: z.string(),
  startedAt: TimestampSchema,
});

export const WorktreeChangedEventSchema = z.object({
  type: z.literal('worktree.changed'),
  projectId: IdSchema,
  worktreeId: IdSchema,
  stateHash: z.string().min(1),
});

export const WorktreeAddedEventSchema = z.object({
  type: z.literal('worktree.added'),
  projectId: IdSchema,
  worktreeId: IdSchema,
});

export const WorktreeRemovedEventSchema = z.object({
  type: z.literal('worktree.removed'),
  projectId: IdSchema,
  worktreeId: IdSchema,
});

export const ProjectAddedEventSchema = z.object({
  type: z.literal('project.added'),
  projectId: IdSchema,
});

export const ProjectUpdatedEventSchema = z.object({
  type: z.literal('project.updated'),
  projectId: IdSchema,
});

export const ProjectRemovedEventSchema = z.object({
  type: z.literal('project.removed'),
  projectId: IdSchema,
});

export const ScanProgressEventSchema = z.object({
  type: z.literal('scan.progress'),
  scanRootId: IdSchema,
  state: z.enum(['scanning', 'done', 'error']),
  scannedDirs: z.number().int().min(0),
  foundRepos: z.number().int().min(0),
  message: z.string().nullable(),
});

export const ReviewChangedEventSchema = z.object({
  type: z.literal('review.changed'),
  projectId: IdSchema,
  scopeKind: ScopeKindSchema,
  path: RepoPathSchema,
  rawPath: RawPathSchema.optional(),
  patchHash: z.string().min(1),
  reviewed: z.boolean(),
});

/**
 * A bulk review call changed many marks at once (the per-file `review.changed` is NOT sent for
 * each of them). Clients refetch inbox/files for the listed projects.
 */
export const ReviewBulkEventSchema = z.object({
  type: z.literal('review.bulk'),
  projectIds: z.array(IdSchema),
  reviewed: z.boolean(),
  changed: z.number().int().min(0),
});

/**
 * Settings or a review-policy override changed. Clients that did not make the change refetch
 * `GET /api/settings`, projects and the inbox (effective policies may have moved).
 */
export const SettingsChangedEventSchema = z.object({
  type: z.literal('settings.changed'),
  revision: z.number().int().min(0),
});

export const ServerEventSchema = z.discriminatedUnion('type', [
  HelloEventSchema,
  WorktreeChangedEventSchema,
  WorktreeAddedEventSchema,
  WorktreeRemovedEventSchema,
  ProjectAddedEventSchema,
  ProjectUpdatedEventSchema,
  ProjectRemovedEventSchema,
  ScanProgressEventSchema,
  ReviewChangedEventSchema,
  ReviewBulkEventSchema,
  SettingsChangedEventSchema,
]);
export type ServerEvent = z.infer<typeof ServerEventSchema>;
export type ServerEventType = ServerEvent['type'];
export type ServerEventOf<T extends ServerEventType> = Extract<ServerEvent, { type: T }>;

export const SERVER_EVENT_TYPES = [
  'hello',
  'worktree.changed',
  'worktree.added',
  'worktree.removed',
  'project.added',
  'project.updated',
  'project.removed',
  'scan.progress',
  'review.changed',
  'review.bulk',
  'settings.changed',
] as const satisfies readonly ServerEventType[];

export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

// ---------------------------------------------------------------------------------------------
// SSE wire format (encode on the daemon, decode in clients that cannot use EventSource)
// ---------------------------------------------------------------------------------------------

/** Encodes one event as an SSE frame: `event:`, optional `id:`, `data:` and a blank line. */
export function formatSseEvent(event: ServerEvent, id?: string | number): string {
  const lines = [`event: ${event.type}`];
  if (id !== undefined) lines.push(`id: ${id}`);
  lines.push(`data: ${JSON.stringify(event)}`);
  return `${lines.join('\n')}\n\n`;
}

/** Encodes an SSE comment (used for heartbeats). */
export function formatSseComment(text = 'ping'): string {
  return `: ${text.replace(/[\r\n]+/g, ' ')}\n\n`;
}

export interface SseMessage {
  event: string;
  data: string;
  id: string | undefined;
  retry: number | undefined;
}

/**
 * Incremental parser for the `text/event-stream` format (WHATWG HTML §9.2). Feed decoded text
 * chunks with `push`; complete messages are returned. Handles CRLF, CR and LF line endings,
 * comments, multi-line data, and chunk boundaries anywhere (including between CR and LF).
 */
export class SseParser {
  #buffer = '';
  #event = '';
  #data: string[] = [];
  #id: string | undefined;
  #retry: number | undefined;
  #lastEventId: string | undefined;
  #pendingCR = false;

  get lastEventId(): string | undefined {
    return this.#lastEventId;
  }

  push(chunk: string): SseMessage[] {
    let text = chunk;
    if (this.#pendingCR) {
      this.#pendingCR = false;
      if (text.startsWith('\n')) text = text.slice(1);
    }
    this.#buffer += text;
    const out: SseMessage[] = [];
    let start = 0;
    for (let i = 0; i < this.#buffer.length; i++) {
      const ch = this.#buffer[i];
      if (ch !== '\n' && ch !== '\r') continue;
      const line = this.#buffer.slice(start, i);
      if (ch === '\r') {
        if (i + 1 < this.#buffer.length) {
          if (this.#buffer[i + 1] === '\n') i++;
        } else {
          this.#pendingCR = true;
        }
      }
      start = i + 1;
      const message = this.#processLine(line);
      if (message) out.push(message);
    }
    this.#buffer = this.#buffer.slice(start);
    return out;
  }

  /** Drops any partial message (call when the stream ends; incomplete events are discarded). */
  reset(): void {
    this.#buffer = '';
    this.#event = '';
    this.#data = [];
    this.#id = undefined;
    this.#retry = undefined;
    this.#pendingCR = false;
  }

  #processLine(line: string): SseMessage | undefined {
    if (line === '') return this.#dispatch();
    if (line.startsWith(':')) return undefined;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'event':
        this.#event = value;
        break;
      case 'data':
        this.#data.push(value);
        break;
      case 'id':
        if (!value.includes('\u0000')) this.#id = value;
        break;
      case 'retry':
        if (/^\d+$/.test(value)) this.#retry = Number(value);
        break;
      default:
        break;
    }
    return undefined;
  }

  #dispatch(): SseMessage | undefined {
    if (this.#id !== undefined) this.#lastEventId = this.#id;
    const hasData = this.#data.length > 0;
    const message: SseMessage = {
      event: this.#event || 'message',
      data: this.#data.join('\n'),
      id: this.#id,
      retry: this.#retry,
    };
    this.#event = '';
    this.#data = [];
    this.#id = undefined;
    this.#retry = undefined;
    return hasData ? message : undefined;
  }
}

/**
 * Parses an SSE message into a typed event. Returns null for unknown event types or invalid
 * payloads so that newer daemons can add event types without breaking older clients.
 */
export function parseServerEvent(message: Pick<SseMessage, 'data'>): ServerEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(message.data);
  } catch {
    return null;
  }
  const result = ServerEventSchema.safeParse(json);
  return result.success ? result.data : null;
}
