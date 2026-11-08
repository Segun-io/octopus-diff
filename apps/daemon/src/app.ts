import {
  AddProjectRequestSchema,
  type AddProjectResponse,
  AddScanRootRequestSchema,
  type AddScanRootResponse,
  AUTH_COOKIE_NAME,
  AUTH_FRAGMENT_PARAM,
  AUTH_QUERY_PARAM,
  CommitsQuerySchema,
  type CommitsResponse,
  DiffQuerySchema,
  FilesQuerySchema,
  FocusRequestSchema,
  HealthQuerySchema,
  IdSchema,
  InboxQuerySchema,
  type Logger,
  type OkResponse,
  type ProjectsResponse,
  type RefreshResponse,
  type RescanResponse,
  ReviewRequestSchema,
  ROUTES,
  type RouteName,
  type ScanRootsResponse,
  type ServerEvent,
  UpdateProjectRequestSchema,
  type UpdateProjectResponse,
} from '@octopus-diff/contracts';
import { type Context, Hono, type MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { DaemonCore } from './core.js';
import { ApiError, toApiError } from './errors.js';
import type { EventHub } from './events.js';
import {
  API_CSP,
  type HostPolicy,
  hasEncodedUnreserved,
  isApiPath,
  isHostAllowed,
  isOriginAllowed,
  UI_CSP,
} from './security.js';
import type { StaticFiles } from './static.js';
import { healthProof, tokensEqual } from './token.js';

/** Max JSON request body. */
export const MAX_BODY_BYTES = 1024 * 1024;
/**
 * Expires the v1 auth cookie (auth v2 never sets or reads it). Same name, `Path=/` and no
 * `Domain` as the cookie v1 set, so browsers replace and drop it.
 */
export const EXPIRE_LEGACY_COOKIE = `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; HttpOnly; SameSite=Strict`;

export interface AppDeps {
  core: DaemonCore;
  hub: EventHub;
  logger: Logger;
  token: string;
  hostPolicy: HostPolicy;
  staticFiles: StaticFiles | null;
  hello: () => ServerEvent;
}

interface SafeParser<T> {
  safeParse(data: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> };
      };
}

function parseWith<T>(schema: SafeParser<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  const first = issues[0];
  const summary = first ? `${first.path ? `${first.path}: ` : ''}${first.message}` : 'invalid';
  throw new ApiError('bad_request', `invalid ${what}: ${summary}`, { details: { issues } });
}

/** Reads at most `MAX_BODY_BYTES` of the request body (413 beyond that). */
async function readBody(c: Context): Promise<string> {
  const declared = Number(c.req.header('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) throw new ApiError('too_large', 'request body too large');
  const body = c.req.raw.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ApiError('too_large', 'request body too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(c: Context): Promise<unknown> {
  const contentType = c.req.header('content-type') ?? '';
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    throw new ApiError('bad_request', 'expected Content-Type: application/json', { status: 415 });
  }
  const text = await readBody(c);
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError('bad_request', 'request body is not valid JSON');
  }
}

function idParam(c: Context, name: string): string {
  return parseWith(IdSchema, c.req.param(name), name);
}

const UNAUTHORIZED_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>octopus-diff: sign in</title></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem">
<h1>octopus-diff</h1>
<p>This link does not contain the current access token of this octopus-diff daemon.</p>
<p>Open the URL printed by <code>octopus-diff serve</code> (it ends in <code>#token=…</code>).
The token is also stored in the daemon's state directory, in the file <code>token</code>.</p>
</body></html>
`;

function errorResponse(c: Context, error: ApiError): Response {
  return c.json(error.toBody(), error.status as ContentfulStatusCode);
}

/**
 * Builds the Hono app: security middleware (Host, Origin, token, headers), every route in
 * `ROUTES`, SSE, and the static web UI.
 */
export function createApp(deps: AppDeps): Hono {
  const { core, hub, logger, token, hostPolicy, staticFiles } = deps;
  const app = new Hono();

  // Security headers on every response (set after the handler so they cannot be dropped).
  // Path decisions use `c.req.path`: the path Hono routes on (SEC-10).
  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    const pathname = c.req.path;
    const headers = c.res.headers;
    try {
      headers.set('X-Content-Type-Options', 'nosniff');
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('X-Frame-Options', 'DENY');
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Resource-Policy', 'same-origin');
      if (!headers.has('Content-Security-Policy')) {
        const isHtml = (headers.get('content-type') ?? '').startsWith('text/html');
        headers.set('Content-Security-Policy', isHtml && !isApiPath(pathname) ? UI_CSP : API_CSP);
      }
      if (isApiPath(pathname) || !headers.has('Cache-Control'))
        headers.set('Cache-Control', 'no-store');
      // Auth v2 has no cookie; drop the v1 cookie (it held the token) wherever it shows up.
      if (getCookie(c, AUTH_COOKIE_NAME) !== undefined) {
        headers.append('Set-Cookie', EXPIRE_LEGACY_COOKIE);
      }
    } catch {
      // Immutable headers (should not happen: every response is built here).
    }
    logger.debug('request', {
      method: c.req.method,
      path: pathname,
      status: c.res.status,
      ms: Math.round(performance.now() - started),
    });
  });

  // Host and Origin checks on every request, including static files, SSE and /api/health.
  app.use('*', async (c, next) => {
    const host = c.req.header('host');
    if (!isHostAllowed(host, hostPolicy)) {
      logger.warn('rejected request with a foreign Host header', { host: host ?? null });
      return errorResponse(c, new ApiError('forbidden', 'Host header not allowed'));
    }
    const origin = c.req.header('origin');
    if (!isOriginAllowed(origin, host)) {
      logger.warn('rejected cross-origin request', { origin: origin ?? null });
      return errorResponse(c, new ApiError('forbidden', 'cross-origin requests are not allowed'));
    }
    // SEC-10: the router decodes `%61` to `a`, raw-URL checks would not; refuse the ambiguity.
    if (hasEncodedUnreserved(new URL(c.req.url).pathname)) {
      return errorResponse(
        c,
        new ApiError('bad_request', 'percent-encoded unreserved characters in the path'),
      );
    }
    return next();
  });

  // API-only rules are registered as `/api` middleware, so Hono matches them with the same
  // router (and the same decoded path) as the API routes themselves.
  const onApi = (handler: MiddlewareHandler) => {
    app.use('/api', handler);
    app.use('/api/*', handler);
  };

  onApi(async (c, next) => {
    if (c.req.header('sec-fetch-site') === 'cross-site') {
      return errorResponse(c, new ApiError('forbidden', 'cross-site requests are not allowed'));
    }
    return next();
  });

  const route = (name: RouteName, handler: (c: Context) => Promise<Response> | Response) => {
    const { method, path } = ROUTES[name];
    app.on(method, path, handler);
  };

  // Health is the one unauthenticated API route: registered before the auth middleware, so its
  // handler answers before that middleware would run. `?challenge=` adds a proof that this
  // daemon holds the token (SEC-02/SEC-12) without revealing it.
  route('health', async (c) => {
    const query = parseWith(HealthQuerySchema, c.req.query(), 'query');
    const body = await core.health();
    if (query.challenge !== undefined) body.proof = healthProof(token, query.challenge);
    return c.json(body);
  });

  // Every other API route, including `/api/events`, needs `Authorization: Bearer <token>`.
  // No cookie and no `?token=` (auth v2): browsers hold no ambient credential for this daemon.
  onApi(async (c, next) => {
    const authorization = c.req.header('authorization');
    const bearer = authorization ? /^Bearer\s+(\S+)\s*$/i.exec(authorization)?.[1] : undefined;
    if (bearer !== undefined && tokensEqual(bearer, token)) return next();
    c.header('WWW-Authenticate', 'Bearer realm="octopus-diff"');
    return errorResponse(
      c,
      new ApiError('unauthorized', authorization ? 'invalid token' : 'missing token'),
    );
  });

  route('listProjects', async (c) => {
    const body: ProjectsResponse = { projects: await core.listProjects() };
    return c.json(body);
  });

  route('addProject', async (c) => {
    const request = parseWith(AddProjectRequestSchema, await readJson(c), 'request body');
    const { item, created } = await core.addProject(request.path);
    const body: AddProjectResponse = { project: item, created };
    return c.json(body, created ? 201 : 200);
  });

  route('updateProject', async (c) => {
    const projectId = idParam(c, 'projectId');
    const request = parseWith(UpdateProjectRequestSchema, await readJson(c), 'request body');
    const body: UpdateProjectResponse = { project: await core.updateProject(projectId, request) };
    return c.json(body);
  });

  route('removeProject', async (c) => {
    await core.removeProject(idParam(c, 'projectId'));
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  route('listScanRoots', (c) => {
    const body: ScanRootsResponse = { scanRoots: core.listScanRoots() };
    return c.json(body);
  });

  route('addScanRoot', async (c) => {
    const request = parseWith(AddScanRootRequestSchema, await readJson(c), 'request body');
    const { scanRoot, created } = await core.addScanRoot(request.path, request.depth);
    const body: AddScanRootResponse = { scanRoot, created };
    return c.json(body, created ? 201 : 200);
  });

  route('removeScanRoot', async (c) => {
    await core.removeScanRoot(idParam(c, 'scanRootId'));
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  route('rescanScanRoot', (c) => {
    const body: RescanResponse = { scanRoot: core.rescan(idParam(c, 'scanRootId')) };
    return c.json(body, 202);
  });

  route('inbox', async (c) => {
    const query = parseWith(InboxQuerySchema, c.req.query(), 'query');
    return c.json(await core.inbox(query.scope, query.onlyUnreviewed));
  });

  route('listFiles', async (c) => {
    const worktreeId = idParam(c, 'worktreeId');
    const query = parseWith(FilesQuerySchema, c.req.query(), 'query');
    return c.json(await core.listFiles(worktreeId, query.scope));
  });

  route('getDiff', async (c) => {
    const worktreeId = idParam(c, 'worktreeId');
    const query = parseWith(DiffQuerySchema, c.req.query(), 'query');
    return c.json(await core.getDiff(worktreeId, query));
  });

  route('listCommits', async (c) => {
    const worktreeId = idParam(c, 'worktreeId');
    const query = parseWith(CommitsQuerySchema, c.req.query(), 'query');
    const body: CommitsResponse = { commits: await core.listCommits(worktreeId, query.limit) };
    return c.json(body);
  });

  route('refreshWorktree', async (c) => {
    const body: RefreshResponse = { summary: await core.refreshWorktree(idParam(c, 'worktreeId')) };
    return c.json(body);
  });

  route('setReview', async (c) => {
    const request = parseWith(ReviewRequestSchema, await readJson(c), 'request body');
    return c.json(core.setReview(request));
  });

  route('setFocus', async (c) => {
    const request = parseWith(FocusRequestSchema, await readJson(c), 'request body');
    core.setFocus(request.worktreeId);
    const body: OkResponse = { ok: true };
    return c.json(body);
  });

  route('events', (c) => {
    const stream = hub.createStream(deps.hello(), c.req.header('last-event-id') ?? null);
    return c.body(stream, 200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
  });

  // Unknown API routes: JSON 404 (never the SPA fallback).
  app.all('/api/*', (c) => errorResponse(c, new ApiError('not_found', 'no such API route')));
  app.all('/api', (c) => errorResponse(c, new ApiError('not_found', 'no such API route')));

  // Static web UI: public (no secrets in it; Host/Origin checks above still apply). Only
  // non-API paths get here, since every `/api` path is answered above.
  app.on(['GET', 'HEAD'], '*', async (c) => {
    const url = new URL(c.req.url);
    const queryToken = url.searchParams.get(AUTH_QUERY_PARAM);
    if (queryToken !== null) {
      // v1 links (`/?token=`): move the token into the fragment, which the web app stores in
      // localStorage; a fragment never reaches servers, logs or `Referer`. No cookie.
      if (!tokensEqual(queryToken, token)) {
        return c.html(UNAUTHORIZED_HTML, 401, { 'Cache-Control': 'no-store' });
      }
      url.searchParams.delete(AUTH_QUERY_PARAM);
      const search = url.searchParams.toString();
      // Same-origin relative target only: collapse leading slashes (no `//host` redirects).
      const target = `/${url.pathname.replace(/^\/+/, '')}`;
      c.header('Cache-Control', 'no-store');
      return c.redirect(
        `${target}${search ? `?${search}` : ''}#${AUTH_FRAGMENT_PARAM}=${encodeURIComponent(token)}`,
        302,
      );
    }
    if (!staticFiles) {
      return errorResponse(c, new ApiError('not_found', 'the web UI is not available (API only)'));
    }
    const result = await staticFiles.lookup(url.pathname, {
      head: c.req.method === 'HEAD',
      acceptsHtml: (c.req.header('accept') ?? '').includes('text/html'),
    });
    if (result.kind === 'bad_request')
      return errorResponse(c, new ApiError('bad_request', 'invalid path'));
    if (result.kind === 'not_found')
      return errorResponse(c, new ApiError('not_found', 'not found'));
    const { file } = result;
    const headers: Record<string, string> = {
      'Content-Type': file.contentType,
      'Cache-Control': file.cacheControl,
    };
    // Scripts get the UI policy too: a dedicated worker runs under the CSP of its own script
    // response, and the API policy (`default-src 'none'`) blocked the highlight workers'
    // chunk imports, so every diff was highlighted on the main thread.
    if (file.isHtml || file.contentType.startsWith('text/javascript')) {
      headers['Content-Security-Policy'] = UI_CSP;
    }
    return file.body === null ? c.body(null, 200, headers) : c.body(file.body, 200, headers);
  });

  app.notFound((c) => errorResponse(c, new ApiError('not_found', 'not found')));

  app.onError((error, c) => {
    const apiError = toApiError(error);
    if (apiError.status >= 500) {
      logger.error('request failed', {
        method: c.req.method,
        path: new URL(c.req.url).pathname,
        error,
      });
    } else {
      logger.debug('request rejected', { code: apiError.code, message: apiError.message });
    }
    return errorResponse(c, apiError);
  });

  return app;
}
