import { z } from 'zod';
import {
  CommitShaSchema,
  IdSchema,
  RawPathSchema,
  RepoPathSchema,
  TimestampSchema,
} from './common.js';
import { WorktreeListItemSchema } from './domain.js';
import { DiffScopeSchema, ScopeKindSchema } from './scope.js';

/**
 * Server-Sent Events on `GET /api/events`. Each event is sent as a *named* SSE event whose
 * `event:` field equals `type`, and whose `data:` is the JSON object (including `type`).
 * Events are deliberately small (ids + hashes; `worktree.changed` also carries the worktree's row and
 * a bounded list of changed paths, #51); clients refetch what they need.
 * The server sends a `: ping` comment at least every 15 s to keep proxies from timing out.
 */
export const HelloEventSchema = z.object({
  type: z.literal('hello'),
  version: z.string(),
  startedAt: TimestampSchema,
});

/** Most paths `WorktreeChangedEvent.paths` lists; a worktree with more sends none (#51). */
export const WORKTREE_CHANGED_PATHS_MAX = 200;
/** Most characters of path text (`path` + `rawPath`) the list may hold; above it, none (#51). */
export const WORKTREE_CHANGED_PATHS_MAX_CHARS = 24_000;

/** One changed file of a worktree, by identity and patch (`ChangedFile`'s fields of the same name). */
export const ChangedPathSchema = z.object({
  path: RepoPathSchema,
  rawPath: RawPathSchema.optional(),
  patchHash: z.string().min(1),
});
export type ChangedPath = z.infer<typeof ChangedPathSchema>;

/**
 * The worktree's changed files in `scope` with their `patchHash`, as the daemon had already listed
 * them for the event's `stateHash` (no git process of its own, #51). A client compares them with the
 * file list and diffs it holds for the same scope (`scopeKey` of the resolved scope it got back in
 * `FilesResponse.scope` / `DiffResponse.scope`) to tell whether they are still current.
 * `truncated`: the worktree has more than `WORKTREE_CHANGED_PATHS_MAX` changed files (or more path
 * text than `WORKTREE_CHANGED_PATHS_MAX_CHARS`); `files` is then empty and `total` says how many
 * there are: refetch instead of trusting the list.
 */
export const WorktreeChangedPathsSchema = z.object({
  scope: DiffScopeSchema,
  files: z.array(ChangedPathSchema).max(WORKTREE_CHANGED_PATHS_MAX),
  total: z.number().int().min(0),
  truncated: z.boolean(),
});
export type WorktreeChangedPaths = z.infer<typeof WorktreeChangedPathsSchema>;

export const WorktreeChangedEventSchema = z.object({
  type: z.literal('worktree.changed'),
  projectId: IdSchema,
  worktreeId: IdSchema,
  stateHash: z.string().min(1),
  /**
   * The worktree's latest activity sequence number (`ActivityResponse.seq`, #38) when its live feed
   * has entries: a client showing the feed fetches `GET /api/worktrees/:id/activity?after=<its seq>`
   * when this moved. Absent when the feed is empty, and from older daemons.
   */
  activitySeq: z.number().int().positive().optional(),
  /**
   * Event deltas (#51): the worktree's row exactly as `GET /api/projects` now holds it
   * (`WorktreeListItem`: `worktree`, `summary` with its `review`, `error`, the effective `review`
   * policy), so a client replaces that row in its projects list instead of refetching the list.
   * Present together (`worktree` and `summary` are the feature test); absent from older daemons and
   * from events replayed after a reconnect (`Last-Event-ID`: the client resyncs anyway). Order rows
   * by `rev` (below); without one, drop a row whose `summary.updatedAt` is older than the one held.
   */
  worktree: WorktreeListItemSchema.shape.worktree.optional(),
  summary: WorktreeListItemSchema.shape.summary.optional(),
  error: WorktreeListItemSchema.shape.error.optional(),
  review: WorktreeListItemSchema.shape.review,
  /**
   * The row's `rev` (see `WorktreeListItem.rev`): apply the row when it is higher than the cached
   * row's, even when `stateHash` is the same (the review state can land after a projects answer
   * already showed the summary), and never let a projects answer with a lower `rev` undo it.
   */
  rev: WorktreeListItemSchema.shape.rev,
  /**
   * The changed files the daemon already listed for this state, with their patch hashes (see
   * `WorktreeChangedPathsSchema`). Absent when it had no list for this `stateHash` (nothing asked
   * for one: no git process is spent on the event), and from older daemons.
   */
  paths: WorktreeChangedPathsSchema.optional(),
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
 * each of them). Clients refetch inbox/files for the listed projects. Sent only when something
 * actually changed (`changed > 0`; after an undo, only when marks were restored): a no-op call
 * produces no event.
 */
export const ReviewBulkEventSchema = z.object({
  type: z.literal('review.bulk'),
  projectIds: z.array(IdSchema),
  reviewed: z.boolean(),
  changed: z.number().int().min(0),
});

/**
 * A worktree's review bookmark ("reviewed up to", docs/STATUS-FLOW.md) moved: `PUT
 * /api/review/bookmark`, a bulk review with `advanceBookmarks`, or its undo. Clients refetch
 * projects (summaries carry `review`) and the worktree's files.
 */
export const ReviewBookmarkEventSchema = z.object({
  type: z.literal('review.bookmark'),
  projectId: IdSchema,
  worktreeId: IdSchema,
  bookmark: CommitShaSchema.nullable(),
});

/**
 * Review states of the project's worktrees became available (#10). The daemon computes a
 * worktree's review state on demand (its project was opened through `PUT /api/focus`, a request
 * needed it, or the worktree changed after startup), not for every repository at startup, so
 * summaries start without `review`. Clients refetch projects. Batched: one per burst.
 */
export const ReviewReadyEventSchema = z.object({
  type: z.literal('review.ready'),
  projectId: IdSchema,
});

/**
 * Settings or a review-policy override changed. Clients that did not make the change refetch
 * `GET /api/settings`, projects and the inbox (effective policies may have moved). Sent to every
 * client including the caller (compare `revision` with the response you already applied), and only
 * on a real change: a PATCH/PUT that changes nothing keeps the revision and emits nothing.
 */
export const SettingsChangedEventSchema = z.object({
  type: z.literal('settings.changed'),
  revision: z.number().int().min(0),
});

/**
 * Forge data (pull/merge requests, CLI status) changed for these projects; clients refetch
 * `GET /api/forges`. An empty `projectIds` means only the CLI status changed.
 */
export const ForgeUpdatedEventSchema = z.object({
  type: z.literal('forge.updated'),
  projectIds: z.array(IdSchema),
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
  ReviewBookmarkEventSchema,
  ReviewReadyEventSchema,
  SettingsChangedEventSchema,
  ForgeUpdatedEventSchema,
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
  'review.bookmark',
  'review.ready',
  'settings.changed',
  'forge.updated',
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
