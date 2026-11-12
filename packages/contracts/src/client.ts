import type { z } from 'zod';
import {
  type ActivityResponse,
  ActivityResponseSchema,
  type BlobResponse,
  BlobResponseSchema,
} from './activity.js';
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
  type DirsResponse,
  DirsResponseSchema,
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
  type RepositoriesResponse,
  RepositoriesResponseSchema,
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
  HEALTH_CHALLENGE_PARAM,
  type OkResponse,
  OkResponseSchema,
} from './common.js';
import { parseServerEvent, type ServerEvent, SseParser } from './events.js';
import {
  type ChangeRequestConversationResponse,
  ChangeRequestConversationResponseSchema,
  type ChangeRequestDetailResponse,
  ChangeRequestDetailResponseSchema,
  type ForgesResponse,
  ForgesResponseSchema,
  type RefreshForgesRequest,
  type RepositoryForgeResponse,
  RepositoryForgeResponseSchema,
} from './forge.js';
import { appendScopeParams, type DiffScope } from './scope.js';
import {
  type AppSettingsPatch,
  type BulkReviewRequest,
  type BulkReviewResponse,
  BulkReviewResponseSchema,
  type SetBookmarkRequest,
  type SetBookmarkResponse,
  SetBookmarkResponseSchema,
  type SetReviewPolicyRequest,
  type SettingsResponse,
  SettingsResponseSchema,
  type UndoReviewRequest,
  type UndoReviewResponse,
  UndoReviewResponseSchema,
} from './settings.js';

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
  /** Sent as `Authorization: Bearer <token>` on every request, including the event stream. */
  token?: string;
  /** Custom fetch (tests, Node). Defaults to `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Validate responses with zod (default true). */
  validate?: boolean;
  /** Fetch credentials mode (default `same-origin`). */
  credentials?: 'omit' | 'same-origin' | 'include';
  headers?: Record<string, string>;
}

/**
 * Per-request options (#44). `signal` is passed to `fetch`: aborting it cancels the request (the
 * daemon then stops the git work it started for it) and the call rejects with an
 * `ApiClientError` of code `aborted`.
 */
export interface RequestParams {
  signal?: AbortSignal;
}

export interface ScopeParams extends RequestParams {
  scope?: DiffScope;
}

export interface InboxParams extends ScopeParams {
  onlyUnreviewed?: boolean;
  /** Only these projects (at most `INBOX_PROJECTS_MAX`); omitted = every project. */
  projectIds?: readonly string[];
  /** Only these worktrees (at most `INBOX_WORKTREES_MAX`, #51); omitted = every worktree. */
  worktreeIds?: readonly string[];
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
  /** Pass `challenge` to receive a `proof` of token possession (see `healthProofMessage`). */
  health(params?: { challenge?: string }): Promise<HealthResponse>;
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
  listCommits(
    worktreeId: string,
    params?: { limit?: number } & RequestParams,
  ): Promise<CommitsResponse>;
  refreshWorktree(worktreeId: string): Promise<RefreshResponse>;
  setReview(body: ReviewRequest): Promise<ReviewResponse>;
  setFocus(body: FocusRequest): Promise<OkResponse>;
  getSettings(): Promise<SettingsResponse>;
  updateSettings(body: AppSettingsPatch): Promise<SettingsResponse>;
  /** `enabled: null` clears the override. Returns the new settings state. */
  setReviewPolicy(body: SetReviewPolicyRequest): Promise<SettingsResponse>;
  /** "Mark all as verified" (or unverified) for a worktree, project, folder or everything. */
  bulkReview(body: BulkReviewRequest): Promise<BulkReviewResponse>;
  undoReview(body: UndoReviewRequest): Promise<UndoReviewResponse>;
  /** Moves a worktree's review bookmark (status flow v2). 404 on older daemons. */
  setBookmark(body: SetBookmarkRequest): Promise<SetBookmarkResponse>;
  /** Subdirectories of `path` (default: home) for the folder picker. */
  listDirs(params?: { path?: string }): Promise<DirsResponse>;
  /** Forge integration: CLI status and pull/merge requests per project (forge.ts). */
  getForges(): Promise<ForgesResponse>;
  refreshForges(body?: RefreshForgesRequest): Promise<ForgesResponse>;
  /** The worktree's matched request in detail (Request tab). */
  getChangeRequest(worktreeId: string): Promise<ChangeRequestDetailResponse>;
  getChangeRequestConversation(worktreeId: string): Promise<ChangeRequestConversationResponse>;
  /** Refetches the project batch, then detail and conversation: always a fresh fetch (no spacing). */
  refreshChangeRequest(worktreeId: string): Promise<ChangeRequestDetailResponse>;
  /** Forge facts and open requests of a project's repository (project Overview). */
  getRepositoryForge(projectId: string): Promise<RepositoryForgeResponse>;
  refreshRepositoryForge(projectId: string): Promise<RepositoryForgeResponse>;
  /** Local git facts for the listed projects (Overview). */
  listRepositories(projectIds: readonly string[]): Promise<RepositoriesResponse>;
  /** Live view (#38): the worktree's activity feed after `after` (default 0: all of it). */
  getActivity(
    worktreeId: string,
    params?: { after?: number; run?: string } & RequestParams,
  ): Promise<ActivityResponse>;
  /** Live view (#38): a blob of the worktree's feed (a deleted file's `oid`). */
  getBlob(
    worktreeId: string,
    oid: string,
    params?: { maxBytes?: number } & RequestParams,
  ): Promise<BlobResponse>;
  /** Absolute or same-origin URL of the SSE stream. */
  eventsUrl(): string;
  /** Subscribes via fetch streaming with the bearer token (browsers and Node). */
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
    init: { query?: URLSearchParams; body?: unknown; signal?: AbortSignal } = {},
  ): Promise<z.output<S>> {
    const { signal } = init;
    const aborted = (error?: unknown) =>
      new ApiClientError('aborted', `request cancelled: ${method} ${path}`, 0, error);
    if (signal?.aborted) throw aborted();
    let response: Response;
    let text: string;
    try {
      response = await doFetch(url(path, init.query), {
        method,
        credentials,
        headers: headers(
          init.body === undefined ? undefined : { 'content-type': 'application/json' },
        ),
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted) throw aborted(error);
      throw new ApiClientError('network', `request failed: ${method} ${path}`, 0, error);
    }
    try {
      text = await response.text();
    } catch (error) {
      if (signal?.aborted) throw aborted(error);
      throw new ApiClientError(
        'network',
        `reading the response failed: ${method} ${path}`,
        0,
        error,
      );
    }
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
    health: (params = {}) => {
      const query = new URLSearchParams();
      if (params.challenge) query.set(HEALTH_CHALLENGE_PARAM, params.challenge);
      return request(HealthResponseSchema, 'GET', ROUTES.health.path, { query });
    },
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
      if (params.projectIds?.length) query.set('projectIds', params.projectIds.join(','));
      if (params.worktreeIds?.length) query.set('worktreeIds', params.worktreeIds.join(','));
      return request(InboxResponseSchema, 'GET', ROUTES.inbox.path, {
        query,
        signal: params.signal,
      });
    },
    listFiles: (worktreeId, params = {}) =>
      request(FilesResponseSchema, 'GET', p(ROUTES.listFiles, { worktreeId }), {
        query: scopeQuery(params.scope),
        signal: params.signal,
      }),
    getDiff: (worktreeId, params) => {
      const query = scopeQuery(params.scope);
      query.set('path', params.path);
      if (params.rawPath) query.set('rawPath', params.rawPath);
      if (params.ignoreWhitespace) query.set('ignoreWhitespace', 'true');
      if (params.context !== undefined) query.set('context', String(params.context));
      if (params.full) query.set('full', 'true');
      return request(DiffResponseSchema, 'GET', p(ROUTES.getDiff, { worktreeId }), {
        query,
        signal: params.signal,
      });
    },
    listCommits: (worktreeId, params = {}) => {
      const query = new URLSearchParams();
      if (params.limit !== undefined) query.set('limit', String(params.limit));
      return request(CommitsResponseSchema, 'GET', p(ROUTES.listCommits, { worktreeId }), {
        query,
        signal: params.signal,
      });
    },
    refreshWorktree: (worktreeId) =>
      request(RefreshResponseSchema, 'POST', p(ROUTES.refreshWorktree, { worktreeId })),
    setReview: (body) => request(ReviewResponseSchema, 'PUT', ROUTES.setReview.path, { body }),
    setFocus: (body) => request(OkResponseSchema, 'PUT', ROUTES.setFocus.path, { body }),
    getSettings: () => request(SettingsResponseSchema, 'GET', ROUTES.getSettings.path),
    updateSettings: (body) =>
      request(SettingsResponseSchema, 'PATCH', ROUTES.updateSettings.path, { body }),
    setReviewPolicy: (body) =>
      request(SettingsResponseSchema, 'PUT', ROUTES.setReviewPolicy.path, { body }),
    bulkReview: (body) =>
      request(BulkReviewResponseSchema, 'POST', ROUTES.bulkReview.path, { body }),
    undoReview: (body) =>
      request(UndoReviewResponseSchema, 'POST', ROUTES.undoReview.path, { body }),
    setBookmark: (body) =>
      request(SetBookmarkResponseSchema, 'PUT', ROUTES.setBookmark.path, { body }),
    listDirs: (params = {}) => {
      const query = new URLSearchParams();
      if (params.path !== undefined) query.set('path', params.path);
      return request(DirsResponseSchema, 'GET', ROUTES.listDirs.path, { query });
    },
    getForges: () => request(ForgesResponseSchema, 'GET', ROUTES.getForges.path),
    refreshForges: (body = {}) =>
      request(ForgesResponseSchema, 'POST', ROUTES.refreshForges.path, { body }),
    getChangeRequest: (worktreeId) =>
      request(ChangeRequestDetailResponseSchema, 'GET', p(ROUTES.getChangeRequest, { worktreeId })),
    getChangeRequestConversation: (worktreeId) =>
      request(
        ChangeRequestConversationResponseSchema,
        'GET',
        p(ROUTES.getChangeRequestConversation, { worktreeId }),
      ),
    refreshChangeRequest: (worktreeId) =>
      request(
        ChangeRequestDetailResponseSchema,
        'POST',
        p(ROUTES.refreshChangeRequest, { worktreeId }),
      ),
    getRepositoryForge: (projectId) =>
      request(RepositoryForgeResponseSchema, 'GET', p(ROUTES.getRepositoryForge, { projectId })),
    refreshRepositoryForge: (projectId) =>
      request(
        RepositoryForgeResponseSchema,
        'POST',
        p(ROUTES.refreshRepositoryForge, { projectId }),
      ),
    listRepositories: (projectIds) => {
      const query = new URLSearchParams();
      query.set('projectIds', projectIds.join(','));
      return request(RepositoriesResponseSchema, 'GET', ROUTES.listRepositories.path, { query });
    },
    getActivity: (worktreeId, params = {}) => {
      const query = new URLSearchParams();
      if (params.after !== undefined) query.set('after', String(params.after));
      if (params.run !== undefined) query.set('run', params.run);
      return request(ActivityResponseSchema, 'GET', p(ROUTES.getActivity, { worktreeId }), {
        query,
        signal: params.signal,
      });
    },
    getBlob: (worktreeId, oid, params = {}) => {
      const query = new URLSearchParams();
      if (params.maxBytes !== undefined) query.set('maxBytes', String(params.maxBytes));
      return request(BlobResponseSchema, 'GET', p(ROUTES.getBlob, { worktreeId, oid }), {
        query,
        signal: params.signal,
      });
    },
    eventsUrl: () => url(ROUTES.events.path),
    subscribe,
  };
}
