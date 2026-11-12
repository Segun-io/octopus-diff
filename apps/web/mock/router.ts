/**
 * Fetch-style router for the mock backend: `(Request) => Response`. Inputs are validated with
 * the contract schemas, exactly like the real daemon is required to. Used by the Node mock
 * server and directly (as a custom `fetch`) by tests.
 */
import {
  ActivityQuerySchema,
  AddProjectRequestSchema,
  AddScanRootRequestSchema,
  type ApiErrorBody,
  AppSettingsPatchSchema,
  BlobQuerySchema,
  BulkReviewRequestSchema,
  CommitsQuerySchema,
  DiffQuerySchema,
  DirsQuerySchema,
  FilesQuerySchema,
  FocusRequestSchema,
  GitObjectIdSchema,
  IdSchema,
  InboxQuerySchema,
  RefreshForgesRequestSchema,
  RepositoriesQuerySchema,
  ReviewRequestSchema,
  SetReviewPolicyRequestSchema,
  UndoReviewRequestSchema,
  UpdateProjectRequestSchema,
} from '@octopus-diff/contracts';
import { MockApiError, type MockBackend, type MutateAction } from './backend.js';
import { listMockDirs } from './fs.js';

export interface MockRouterOptions {
  /** If set, every route except /api/health requires `Authorization: Bearer <token>`. */
  token?: string;
  /** Artificial latency in ms for every response. */
  latencyMs?: number;
  /** Extra latency for the routes that reach a forge (`/api/forges/...`, but not `GET /api/forges`). */
  forgeLatencyMs?: number;
  /** Extra latency for the local routes (files, diffs, inbox, projects, repositories...). */
  localLatencyMs?: number;
  /**
   * Called before a request is answered with the side it is slow on; the response waits for the
   * returned promise. Tests hold a request open with it and release it when they choose
   * (#11: slow forge / slow local, without real timers).
   */
  gate?: (request: { path: string; method: string; side: RequestSide }) => Promise<void> | void;
}

export type RequestSide = 'forge' | 'local';

/**
 * Which side answers a route slowly in the real daemon: the forge for the lookups that may reach
 * it (the Request tab's detail, conversation and refresh, the Overview's repository facts, the
 * forge refresh), the local machine for everything else. `GET /api/forges` and `/api/settings`
 * read the daemon's own cache, so they count as local.
 */
export function sideOf(path: string, method: string): RequestSide {
  if (path === '/api/forges/refresh' && method === 'POST') return 'forge';
  if (/^\/api\/forges\/(worktrees|projects)\//.test(path)) return 'forge';
  return 'local';
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function error(
  status: number,
  code: ApiErrorBody['error']['code'],
  message: string,
  details?: unknown,
): Response {
  const body: ApiErrorBody = {
    error: { code, message, ...(details === undefined ? {} : { details }) },
  };
  return json(status, body);
}

interface SafeParser<T> {
  safeParse(
    input: unknown,
  ): { success: true; data: T } | { success: false; error: { issues: unknown } };
}

function parse<T>(schema: SafeParser<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw Object.assign(new MockApiError(400, 'bad_request', 'invalid request'), {
      details: result.error.issues,
    });
  }
  return result.data;
}

function queryObject(url: URL): Record<string, string> {
  return Object.fromEntries(url.searchParams.entries());
}

/** Bearer only, like the daemon (auth v2: no cookie). */
function authorized(request: Request, token: string): boolean {
  return request.headers.get('authorization') === `Bearer ${token}`;
}

export function createMockRouter(backend: MockBackend, options: MockRouterOptions = {}) {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));
    if (path !== '/api/health' && !path.startsWith('/api/__mock/')) {
      const side = sideOf(path, method);
      const extra = side === 'forge' ? options.forgeLatencyMs : options.localLatencyMs;
      if (extra) await new Promise((r) => setTimeout(r, extra));
      await options.gate?.({ path, method, side });
    }
    try {
      if (path === '/api/health' && method === 'GET') return json(200, backend.health());
      if (options.token && !authorized(request, options.token)) {
        return error(401, 'unauthorized', 'missing or invalid token');
      }
      const body = async () => {
        const text = await request.text();
        try {
          return text ? (JSON.parse(text) as unknown) : {};
        } catch {
          throw new MockApiError(400, 'bad_request', 'invalid JSON body');
        }
      };

      if (path === '/api/projects' && method === 'GET') return json(200, backend.listProjects());
      if (path === '/api/projects' && method === 'POST') {
        const req = parse(AddProjectRequestSchema, await body());
        return json(200, backend.addProject(req.path));
      }
      const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
      if (projectMatch && method === 'DELETE') {
        return json(200, backend.removeProject(decodeURIComponent(projectMatch[1] ?? '')));
      }
      if (projectMatch && method === 'PATCH') {
        const req = parse(UpdateProjectRequestSchema, await body());
        return json(200, backend.updateProject(decodeURIComponent(projectMatch[1] ?? ''), req));
      }
      if (path === '/api/scan-roots' && method === 'GET') return json(200, backend.listScanRoots());
      if (path === '/api/scan-roots' && method === 'POST') {
        const req = parse(AddScanRootRequestSchema, await body());
        return json(200, backend.addScanRoot(req.path, req.depth));
      }
      const scanMatch = path.match(/^\/api\/scan-roots\/([^/]+)$/);
      if (scanMatch && method === 'DELETE') {
        return json(200, backend.removeScanRoot(decodeURIComponent(scanMatch[1] ?? '')));
      }
      const rescanMatch = path.match(/^\/api\/scan-roots\/([^/]+)\/rescan$/);
      if (rescanMatch && method === 'POST') {
        return json(200, backend.rescanScanRoot(decodeURIComponent(rescanMatch[1] ?? '')));
      }
      if (path === '/api/fs/dirs' && method === 'GET') {
        const q = parse(DirsQuerySchema, queryObject(url));
        return json(200, listMockDirs(backend, q.path));
      }
      if (path === '/api/inbox' && method === 'GET') {
        const q = parse(InboxQuerySchema, queryObject(url));
        return json(200, backend.inbox(q.scope, q.onlyUnreviewed, q.projectIds));
      }
      const wtMatch = path.match(/^\/api\/worktrees\/([^/]+)\/(files|diff|commits|refresh)$/);
      if (wtMatch) {
        const worktreeId = decodeURIComponent(wtMatch[1] ?? '');
        const action = wtMatch[2];
        if (action === 'files' && method === 'GET') {
          const q = parse(FilesQuerySchema, queryObject(url));
          return json(200, backend.listFiles(worktreeId, q.scope));
        }
        if (action === 'diff' && method === 'GET') {
          const q = parse(DiffQuerySchema, queryObject(url));
          return json(200, backend.getDiff(worktreeId, q));
        }
        if (action === 'commits' && method === 'GET') {
          const q = parse(CommitsQuerySchema, queryObject(url));
          return json(200, backend.listCommits(worktreeId, q.limit));
        }
        if (action === 'refresh' && method === 'POST')
          return json(200, backend.refresh(worktreeId));
      }
      // --- live view (#38) ---
      const activityMatch = path.match(/^\/api\/worktrees\/([^/]+)\/activity$/);
      if (activityMatch && method === 'GET') {
        const q = parse(ActivityQuerySchema, queryObject(url));
        return json(
          200,
          backend.activityFeed(decodeURIComponent(activityMatch[1] ?? ''), q.after, q.run),
        );
      }
      const blobMatch = path.match(/^\/api\/worktrees\/([^/]+)\/blob\/([^/]+)$/);
      if (blobMatch && method === 'GET') {
        const oid = decodeURIComponent(blobMatch[2] ?? '');
        if (!GitObjectIdSchema.safeParse(oid).success) {
          throw new MockApiError(400, 'bad_request', 'invalid object id');
        }
        const q = parse(BlobQuerySchema, queryObject(url));
        return json(
          200,
          backend.blob(decodeURIComponent(blobMatch[1] ?? ''), oid, q.maxBytes ?? 1024 * 1024),
        );
      }
      if (path === '/api/review' && method === 'PUT') {
        const req = parse(ReviewRequestSchema, await body());
        return json(200, backend.setReview(req));
      }
      if (path === '/api/focus' && method === 'PUT') {
        const req = parse(FocusRequestSchema, await body());
        return json(200, backend.setFocus(req.worktreeId, req.projectId ?? null));
      }
      // --- UX round 1 ---
      if (path === '/api/settings' && method === 'GET') return json(200, backend.getSettings());
      if (path === '/api/settings' && method === 'PATCH') {
        const req = parse(AppSettingsPatchSchema, await body());
        return json(200, backend.updateSettings(req));
      }
      if (path === '/api/review-policy' && method === 'PUT') {
        const req = parse(SetReviewPolicyRequestSchema, await body());
        return json(200, backend.setReviewPolicy(req));
      }
      if (path === '/api/review/bulk' && method === 'POST') {
        const req = parse(BulkReviewRequestSchema, await body());
        return json(200, backend.bulkReview(req));
      }
      if (path === '/api/review/undo' && method === 'POST') {
        const req = parse(UndoReviewRequestSchema, await body());
        return json(200, backend.undoReview(req.undoToken));
      }
      // --- forges ---
      if (path === '/api/forges' && method === 'GET') return json(200, backend.forges());
      if (path === '/api/forges/refresh' && method === 'POST') {
        parse(RefreshForgesRequestSchema, await body());
        return json(200, backend.forges());
      }
      const requestMatch = path.match(
        /^\/api\/forges\/worktrees\/([^/]+)\/request(\/conversation|\/refresh)?$/,
      );
      if (requestMatch) {
        const worktreeId = decodeURIComponent(requestMatch[1] ?? '');
        if (!IdSchema.safeParse(worktreeId).success)
          throw new MockApiError(400, 'bad_request', 'invalid worktreeId');
        const sub = requestMatch[2];
        if (sub === undefined && method === 'GET')
          return json(200, backend.changeRequest(worktreeId));
        if (sub === '/conversation' && method === 'GET') {
          return json(200, backend.changeRequestConversation(worktreeId));
        }
        if (sub === '/refresh' && method === 'POST')
          return json(200, backend.changeRequest(worktreeId));
      }
      const repoMatch = path.match(/^\/api\/forges\/projects\/([^/]+)\/repository(\/refresh)?$/);
      if (repoMatch && (method === 'GET' || (repoMatch[2] && method === 'POST'))) {
        return json(200, backend.repositoryForge(decodeURIComponent(repoMatch[1] ?? '')));
      }
      if (path === '/api/repositories' && method === 'GET') {
        const q = parse(RepositoriesQuerySchema, queryObject(url));
        return json(200, backend.repositories(q.projectIds));
      }
      // Mock-only control endpoint: what the forge side reports (#11), e.g.
      // `?pending=1&budget=backoff&error=rate%20limited&fetchedAgoMs=180000`; no parameters = reset.
      if (path === '/api/__mock/forge-sim' && method === 'POST') {
        const q = url.searchParams;
        const budget = q.get('budget');
        const ago = q.get('fetchedAgoMs');
        return json(
          200,
          backend.setForgeSim({
            ...(q.get('pending') === '1' ? { pending: true } : {}),
            ...(budget === 'busy' || budget === 'low' || budget === 'backoff' ? { budget } : {}),
            ...(q.get('error') ? { error: q.get('error') } : {}),
            ...(ago !== null && Number.isFinite(Number(ago)) ? { fetchedAgoMs: Number(ago) } : {}),
          }),
        );
      }
      // Mock-only control endpoint: how a worktree is watched (`mode=polling&pollMs=5000`), or a
      // daemon restart (`restart=1`: a new run, every feed gone).
      if (path === '/api/__mock/activity' && method === 'POST') {
        const q = url.searchParams;
        if (q.get('restart') === '1') backend.activity.restart();
        const id = q.get('worktreeId');
        const mode = q.get('mode');
        if (id && (mode === 'native' || mode === 'polling' || mode === 'disabled')) {
          const ms = Number(q.get('pollMs'));
          backend.activity.setWatch(id, {
            mode,
            pollMs: mode !== 'native' && Number.isInteger(ms) && ms > 0 ? ms : null,
          });
        }
        return json(200, { ok: true });
      }
      // Mock-only control endpoint: simulate an agent edit right now.
      if (path === '/api/__mock/mutate' && method === 'POST') {
        const worktreeId = url.searchParams.get('worktreeId') ?? undefined;
        const action = (url.searchParams.get('action') ?? undefined) as MutateAction | undefined;
        const target = url.searchParams.get('path') ?? undefined;
        return json(200, backend.mutate(worktreeId, action, target));
      }
      return error(404, 'not_found', `no route for ${method} ${path}`);
    } catch (err) {
      if (err instanceof MockApiError) {
        return error(err.status, err.code, err.message, (err as { details?: unknown }).details);
      }
      return error(500, 'internal', err instanceof Error ? err.message : String(err));
    }
  };
}

/** A `fetch` replacement that routes requests to the mock (for tests and benchmarks). */
export function createMockFetch(backend: MockBackend, options: MockRouterOptions = {}) {
  const handle = createMockRouter(backend, options);
  return (input: string, init?: RequestInit): Promise<Response> =>
    handle(new Request(new URL(input, 'http://mock.local'), init));
}
