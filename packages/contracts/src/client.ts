import type { z } from 'zod';
import {
  type AddProjectRequest,
  type AddProjectResponse,
  AddProjectResponseSchema,
  type AddScanRootRequest,
  type AddScanRootResponse,
  AddScanRootResponseSchema,
  buildPath,
  type CommitsResponse,
  CommitsResponseSchema,
  type DiffResponse,
  DiffResponseSchema,
  type FilesResponse,
  FilesResponseSchema,
  type FocusRequest,
  type HealthResponse,
  HealthResponseSchema,
  type InboxResponse,
  InboxResponseSchema,
  type ProjectsResponse,
  ProjectsResponseSchema,
  type RefreshResponse,
  RefreshResponseSchema,
  type RescanResponse,
  RescanResponseSchema,
  type ReviewRequest,
  type ReviewResponse,
  ReviewResponseSchema,
  ROUTES,
  type ScanRootsResponse,
  ScanRootsResponseSchema,
  type UpdateProjectRequest,
  type UpdateProjectResponse,
  UpdateProjectResponseSchema,
} from './api.js';
import {
  ApiErrorBodySchema,
  type ApiErrorCode,
  type OkResponse,
  OkResponseSchema,
} from './common.js';
import { parseServerEvent, type ServerEvent, SseParser } from './events.js';
import { appendScopeParams, type DiffScope } from './scope.js';

export type ApiClientErrorCode = ApiErrorCode | 'network' | 'invalid_response' | 'aborted';

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: ApiClientErrorCode;
  readonly details: unknown;

  constructor(code: ApiClientErrorCode, message: string, status = 0, details?: unknown) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** Origin of the daemon, e.g. `http://127.0.0.1:7428`. Empty string = same origin (browser). */
  baseUrl?: string;
  /** Sent as `Authorization: Bearer <token>`. Browsers normally rely on the auth cookie instead. */
  token?: string;
  /** Custom fetch (tests, Node). Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Validate responses with zod (default true). */
  validate?: boolean;
  /** Fetch credentials mode (default `same-origin`). */
  credentials?: 'omit' | 'same-origin' | 'include';
  headers?: Record<string, string>;
}

export interface ScopeParams {
  scope?: DiffScope;
}

export interface InboxParams extends ScopeParams {
  onlyUnreviewed?: boolean;
}

export interface DiffParams extends ScopeParams {
  path: string;
  rawPath?: string;
  ignoreWhitespace?: boolean;
  context?: number;
  full?: boolean;
}

export interface SubscribeOptions {
  onEvent: (event: ServerEvent) => void;
  /** Called each time the stream (re)connects. */
  onOpen?: () => void;
  /** Called on stream errors; the client reconnects automatically until closed. */
  onError?: (error: unknown) => void;
  signal?: AbortSignal;
  /** Initial reconnect delay; doubles up to `maxReconnectDelayMs`. */
  reconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

export interface EventSubscription {
  close(): void;
  /** Resolves when the subscription has been closed. */
  readonly closed: Promise<void>;
}

export interface ApiClient {
  health(): Promise<HealthResponse>;
  listProjects(): Promise<ProjectsResponse>;
  addProject(body: AddProjectRequest): Promise<AddProjectResponse>;
  updateProject(projectId: string, body: UpdateProjectRequest): Promise<UpdateProjectResponse>;
  removeProject(projectId: string): Promise<OkResponse>;
  listScanRoots(): Promise<ScanRootsResponse>;
  addScanRoot(body: AddScanRootRequest): Promise<AddScanRootResponse>;
  removeScanRoot(scanRootId: string): Promise<OkResponse>;
  rescanScanRoot(scanRootId: string): Promise<RescanResponse>;
  inbox(params?: InboxParams): Promise<InboxResponse>;
  listFiles(worktreeId: string, params?: ScopeParams): Promise<FilesResponse>;
  getDiff(worktreeId: string, params: DiffParams): Promise<DiffResponse>;
  listCommits(worktreeId: string, params?: { limit?: number }): Promise<CommitsResponse>;
  refreshWorktree(worktreeId: string): Promise<RefreshResponse>;
  setReview(body: ReviewRequest): Promise<ReviewResponse>;
  setFocus(body: FocusRequest): Promise<OkResponse>;
  /** Absolute or same-origin URL of the SSE stream (for `EventSource` with cookie auth). */
  eventsUrl(): string;
  /** Subscribes via fetch streaming (works with bearer tokens and in Node). */
  subscribe(options: SubscribeOptions): EventSubscription;
}

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = (options.baseUrl ?? '').replace(/\/+$/, '');
  const validate = options.validate ?? true;
  const credentials = options.credentials ?? 'same-origin';
  const doFetch: FetchLike =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init) as Promise<Response>);

  function headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { accept: 'application/json', ...options.headers, ...extra };
    if (options.token) h.authorization = `Bearer ${options.token}`;
    return h;
  }

  function url(path: string, query?: URLSearchParams): string {
    const qs = query?.toString();
    return `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
  }

  async function request<S extends z.ZodType>(
    schema: S,
    method: string,
    path: string,
    init: { query?: URLSearchParams; body?: unknown } = {},
  ): Promise<z.output<S>> {
    let response: Response;
    try {
      response = await doFetch(url(path, init.query), {
        method,
        credentials,
        headers: headers(
          init.body === undefined ? undefined : { 'content-type': 'application/json' },
        ),
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
    } catch (error) {
      throw new ApiClientError('network', `request failed: ${method} ${path}`, 0, error);
    }
    const text = await response.text();
    let json: unknown;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      throw new ApiClientError(
        'invalid_response',
        `non-JSON response (${response.status}) from ${method} ${path}`,
        response.status,
      );
    }
    if (!response.ok) {
      const parsed = ApiErrorBodySchema.safeParse(json);
      if (parsed.success) {
        const { code, message, details } = parsed.data.error;
        throw new ApiClientError(code, message, response.status, details);
      }
      throw new ApiClientError(
        response.status === 401 ? 'unauthorized' : 'internal',
        `HTTP ${response.status} from ${method} ${path}`,
        response.status,
        json,
      );
    }
    if (!validate) return json as z.output<S>;
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiClientError(
        'invalid_response',
        `response from ${method} ${path} does not match the contract`,
        response.status,
        parsed.error.issues,
      );
    }
    return parsed.data;
  }

  const p = (route: { path: string }, params?: Record<string, string>) =>
    buildPath(route.path, params);

  function scopeQuery(scope: DiffScope | undefined): URLSearchParams {
    return appendScopeParams(new URLSearchParams(), scope ?? { kind: 'working' });
  }

  function subscribe(sub: SubscribeOptions): EventSubscription {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    sub.signal?.addEventListener('abort', onAbort, { once: true });
    const initialDelay = sub.reconnectDelayMs ?? 1000;
    const maxDelay = sub.maxReconnectDelayMs ?? 10_000;

    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        controller.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });

    const run = async () => {
      let delay = initialDelay;
      let lastEventId: string | undefined;
      while (!controller.signal.aborted) {
        const parser = new SseParser();
        try {
          const extra: Record<string, string> = { accept: 'text/event-stream' };
          if (lastEventId !== undefined) extra['last-event-id'] = lastEventId;
          const response = await doFetch(url(ROUTES.events.path), {
            method: 'GET',
            credentials,
            headers: headers(extra),
            signal: controller.signal,
          });
          if (!response.ok || !response.body) {
            throw new ApiClientError(
              response.status === 401 ? 'unauthorized' : 'network',
              `event stream failed with HTTP ${response.status}`,
              response.status,
            );
          }
          sub.onOpen?.();
          delay = initialDelay;
          const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const message of parser.push(value)) {
              if (message.retry !== undefined) delay = message.retry;
              const event = parseServerEvent(message);
              if (event) sub.onEvent(event);
            }
          }
          lastEventId = parser.lastEventId ?? lastEventId;
        } catch (error) {
          lastEventId = parser.lastEventId ?? lastEventId;
          if (controller.signal.aborted) break;
          sub.onError?.(error);
        }
        if (controller.signal.aborted) break;
        await sleep(delay);
        delay = Math.min(delay * 2, maxDelay);
      }
      sub.signal?.removeEventListener('abort', onAbort);
    };

    const closed = run();
    return {
      close: () => controller.abort(),
      closed,
    };
  }

  return {
    health: () => request(HealthResponseSchema, 'GET', ROUTES.health.path),
    listProjects: () => request(ProjectsResponseSchema, 'GET', ROUTES.listProjects.path),
    addProject: (body) =>
      request(AddProjectResponseSchema, 'POST', ROUTES.addProject.path, { body }),
    updateProject: (projectId, body) =>
      request(UpdateProjectResponseSchema, 'PATCH', p(ROUTES.updateProject, { projectId }), {
        body,
      }),
    removeProject: (projectId) =>
      request(OkResponseSchema, 'DELETE', p(ROUTES.removeProject, { projectId })),
    listScanRoots: () => request(ScanRootsResponseSchema, 'GET', ROUTES.listScanRoots.path),
    addScanRoot: (body) =>
      request(AddScanRootResponseSchema, 'POST', ROUTES.addScanRoot.path, { body }),
    removeScanRoot: (scanRootId) =>
      request(OkResponseSchema, 'DELETE', p(ROUTES.removeScanRoot, { scanRootId })),
    rescanScanRoot: (scanRootId) =>
      request(RescanResponseSchema, 'POST', p(ROUTES.rescanScanRoot, { scanRootId })),
    inbox: (params = {}) => {
      const query = scopeQuery(params.scope);
      if (params.onlyUnreviewed) query.set('onlyUnreviewed', 'true');
      return request(InboxResponseSchema, 'GET', ROUTES.inbox.path, { query });
    },
    listFiles: (worktreeId, params = {}) =>
      request(FilesResponseSchema, 'GET', p(ROUTES.listFiles, { worktreeId }), {
        query: scopeQuery(params.scope),
      }),
    getDiff: (worktreeId, params) => {
      const query = scopeQuery(params.scope);
      query.set('path', params.path);
      if (params.rawPath) query.set('rawPath', params.rawPath);
      if (params.ignoreWhitespace) query.set('ignoreWhitespace', 'true');
      if (params.context !== undefined) query.set('context', String(params.context));
      if (params.full) query.set('full', 'true');
      return request(DiffResponseSchema, 'GET', p(ROUTES.getDiff, { worktreeId }), { query });
    },
    listCommits: (worktreeId, params = {}) => {
      const query = new URLSearchParams();
      if (params.limit !== undefined) query.set('limit', String(params.limit));
      return request(CommitsResponseSchema, 'GET', p(ROUTES.listCommits, { worktreeId }), {
        query,
      });
    },
    refreshWorktree: (worktreeId) =>
      request(RefreshResponseSchema, 'POST', p(ROUTES.refreshWorktree, { worktreeId })),
    setReview: (body) => request(ReviewResponseSchema, 'PUT', ROUTES.setReview.path, { body }),
    setFocus: (body) => request(OkResponseSchema, 'PUT', ROUTES.setFocus.path, { body }),
    eventsUrl: () => url(ROUTES.events.path),
    subscribe,
  };
}
