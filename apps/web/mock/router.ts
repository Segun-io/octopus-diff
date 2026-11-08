/**
 * Fetch-style router for the mock backend: `(Request) => Response`. Inputs are validated with
 * the contract schemas, exactly like the real daemon is required to. Used by the Node mock
 * server and directly (as a custom `fetch`) by tests.
 */
import {
  AddProjectRequestSchema,
  AddScanRootRequestSchema,
  type ApiErrorBody,
  CommitsQuerySchema,
  DiffQuerySchema,
  FilesQuerySchema,
  FocusRequestSchema,
  InboxQuerySchema,
  ReviewRequestSchema,
} from '@octopus-diff/contracts';
import { MockApiError, type MockBackend } from './backend.js';

export interface MockRouterOptions {
  /** If set, every route except /api/health requires this token (cookie or bearer). */
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

function authorized(request: Request, token: string): boolean {
  const header = request.headers.get('authorization');
  if (header === `Bearer ${token}`) return true;
  const cookie = request.headers.get('cookie') ?? '';
  return cookie.split(/;\s*/).includes(`octopus_diff_token=${token}`);
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
      if (path === '/api/scan-roots' && method === 'GET') return json(200, backend.listScanRoots());
      if (path === '/api/scan-roots' && method === 'POST') {
        const req = parse(AddScanRootRequestSchema, await body());
        return json(200, backend.addScanRoot(req.path, req.depth));
      }
      const scanMatch = path.match(/^\/api\/scan-roots\/([^/]+)$/);
      if (scanMatch && method === 'DELETE') {
        return json(200, backend.removeScanRoot(decodeURIComponent(scanMatch[1] ?? '')));
      }
      if (path === '/api/inbox' && method === 'GET') {
        const q = parse(InboxQuerySchema, queryObject(url));
        return json(200, backend.inbox(q.scope, q.onlyUnreviewed));
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
        return json(200, backend.setFocus(req.worktreeId));
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
