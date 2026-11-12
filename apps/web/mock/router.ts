/**
 * Fetch-style router for the mock backend: `(Request) => Response`. Inputs are validated with
 * the contract schemas, exactly like the real daemon is required to. Used by the Node mock
 * server and directly (as a custom `fetch`) by tests.
 */
import {
  AddProjectRequestSchema,
  AddScanRootRequestSchema,
  type ApiErrorBody,
  AppSettingsPatchSchema,
  BulkReviewRequestSchema,
  CommitsQuerySchema,
  DiffQuerySchema,
  DirsQuerySchema,
  FilesQuerySchema,
  FocusRequestSchema,
  IdSchema,
  InboxQuerySchema,
  RefreshForgesRequestSchema,
  RepositoriesQuerySchema,
  ReviewRequestSchema,
  SetReviewPolicyRequestSchema,
  UndoReviewRequestSchema,
  UpdateProjectRequestSchema,
} from '@octopus-diff/contracts';
import { MockApiError, type MockBackend } from './backend.js';
import { listMockDirs } from './fs.js';

export interface MockRouterOptions {
  /** If set, every route except /api/health requires `Authorization: Bearer <token>`. */
  token?: string;
  /** Artificial latency in ms for every response. */
  latencyMs?: number;
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
    if (options.latencyMs) await new Promise((r) => setTimeout(r, options.latencyMs));
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
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
      // Mock-only control endpoint: simulate an agent edit right now.
      if (path === '/api/__mock/mutate' && method === 'POST') {
        const worktreeId = url.searchParams.get('worktreeId') ?? undefined;
        const action = (url.searchParams.get('action') ?? undefined) as
          | 'edit'
          | 'add'
          | 'revert'
          | undefined;
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
