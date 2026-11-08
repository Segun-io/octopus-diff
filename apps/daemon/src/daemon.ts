import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import {
  type DaemonHandle,
  DEFAULT_HOST,
  DEFAULT_PORT,
  type GitCore,
  type Logger,
  SCAN_DEPTH_DEFAULT,
  ScanDepthSchema,
  type ServerEvent,
  type StartDaemon,
  type StartDaemonOptions,
} from '@octopus-diff/contracts';
import { createGitCore } from '@octopus-diff/git-core';
import type { Hono } from 'hono';
import { createApp } from './app.js';
import { DaemonCore } from './core.js';
import { EventHub } from './events.js';
import { createLogger } from './logger.js';
import { ensurePrivateDir, resolveDirs } from './paths.js';
import { hostForUrl, isLoopbackHost, isWildcardHost } from './security.js';
import { StaticFiles } from './static.js';
import { Store } from './store.js';
import { loadOrCreateToken } from './token.js';
import type { SubscribeFn } from './watcher.js';

export const DEFAULT_VERSION = '0.0.0-dev';
/** How long `close()` lets in-flight responses finish before cutting connections. */
const CLOSE_GRACE_MS = 200;

/** Internal knobs for tests and benchmarks; not part of the CLI contract. */
export interface DaemonInternals {
  /** SSE heartbeat interval (default 15 s). */
  heartbeatMs?: number;
  /** Max wait for first summaries in list endpoints (default 2500 ms). */
  initialSummaryWaitMs?: number;
  /** Worktree relist / missing-project retry interval (default 60 s). */
  relistMs?: number;
  /** Max delay of a debounced refresh during a continuous burst (default 1000 ms). */
  maxWaitMs?: number;
  /** Poll interval of the focused worktree when native watching is unavailable (default 5 s). */
  pollDegradedFocusedMs?: number;
  /** Replaces `@parcel/watcher`'s subscribe (simulate inotify failures). */
  subscribe?: SubscribeFn;
  /** Clock (GC tests). */
  now?: () => Date;
  /** Line sink for the default JSON logger. */
  logWrite?: (line: string) => void;
  /** cwd for resolving relative input paths. */
  cwd?: string;
}

export interface DaemonOptions extends StartDaemonOptions {
  internal?: DaemonInternals;
}

/** What `startDaemon` returns: the `DaemonHandle` contract plus internals for tests. */
export interface Daemon extends DaemonHandle {
  readonly app: Hono;
  readonly core: DaemonCore;
  readonly hub: EventHub;
  readonly store: Store;
  readonly logger: Logger;
}

function clampDebounce(value: number | undefined, logger: Logger): number | undefined {
  if (value === undefined) return undefined;
  const clamped = Math.min(300, Math.max(150, value));
  if (clamped !== value) {
    logger.warn('watch.debounceMs must be within 150-300 ms (PLAN §5.6); clamped', {
      value,
      clamped,
    });
  }
  return clamped;
}

function listen(server: Server, port: number, host: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(server.address() as AddressInfo);
    });
  });
}

/**
 * Starts the octopus-diff daemon (PLAN §5, §6 WS2): opens the state store, loads the registry,
 * starts watchers and background reconciliation, and serves the API, SSE and web UI.
 */
export const startDaemon = (async (options: DaemonOptions = {}): Promise<Daemon> => {
  const internal = options.internal ?? {};
  const startedAt = new Date();
  let token = '';
  const logger = createLogger({
    level: options.logLevel ?? 'info',
    ...(options.logger ? { logger: options.logger } : {}),
    ...(internal.logWrite ? { write: internal.logWrite } : {}),
    secrets: () => (token ? [token] : []),
  });

  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${port}`);
  if (!isLoopbackHost(host) && !options.allowNonLoopback) {
    throw new Error(
      `refusing to bind ${host}: not a loopback address. The API exposes local repository contents; pass allowNonLoopback to bind it anyway.`,
    );
  }
  if (!isLoopbackHost(host)) {
    logger.warn(
      'binding a non-loopback address: the API is reachable from the network (token still required)',
      {
        host,
      },
    );
  }

  const { stateDir, configDir } = resolveDirs(options);
  const dirWarning = await ensurePrivateDir(stateDir);
  if (dirWarning) logger.warn(dirWarning);
  const loaded = await loadOrCreateToken(stateDir, options.token);
  token = loaded.token;
  for (const warning of loaded.warnings) logger.warn(warning);
  if (loaded.source === 'created')
    logger.info('created a new auth token', { file: `${stateDir}/token` });

  const store = await Store.open(stateDir);
  const hub = new EventHub(
    internal.heartbeatMs !== undefined ? { heartbeatMs: internal.heartbeatMs } : {},
  );
  const ownsGitCore = options.gitCore === undefined;
  const gitCore: GitCore =
    options.gitCore ?? createGitCore({ ...options.git, logger: options.git?.logger ?? logger });
  const version = options.version ?? DEFAULT_VERSION;

  const watch = { ...options.watch };
  const debounceMs = clampDebounce(watch.debounceMs, logger);
  if (debounceMs !== undefined) watch.debounceMs = debounceMs;

  const core = new DaemonCore({
    gitCore,
    store,
    hub,
    logger,
    version,
    startedAt,
    watch,
    ...(internal.relistMs !== undefined ? { relistMs: internal.relistMs } : {}),
    ...(internal.maxWaitMs !== undefined ? { maxWaitMs: internal.maxWaitMs } : {}),
    ...(internal.pollDegradedFocusedMs !== undefined
      ? { pollDegradedFocusedMs: internal.pollDegradedFocusedMs }
      : {}),
    ...(internal.subscribe ? { subscribe: internal.subscribe } : {}),
    ...(internal.initialSummaryWaitMs !== undefined
      ? { initialSummaryWaitMs: internal.initialSummaryWaitMs }
      : {}),
    ...(internal.now ? { now: internal.now } : {}),
    ...(internal.cwd ? { cwd: internal.cwd } : {}),
  });

  let server: Server | undefined;
  const cleanup = async () => {
    await core.close().catch(() => {});
    hub.close();
    if (ownsGitCore) await gitCore.dispose().catch(() => {});
    store.close();
  };

  try {
    core.load();

    // Startup registrations (idempotent); failures are logged, not fatal.
    const justProjects = new Set<string>();
    for (const path of options.projects ?? []) {
      try {
        const { item } = await core.addProject(path);
        justProjects.add(item.project.id);
      } catch (error) {
        logger.warn('could not register project from options', { path, error });
      }
    }
    const justScanRoots = new Set<string>();
    for (const root of options.scanRoots ?? []) {
      try {
        const depth = ScanDepthSchema.parse(root.depth ?? SCAN_DEPTH_DEFAULT);
        const { scanRoot } = await core.addScanRoot(root.path, depth);
        justScanRoots.add(scanRoot.id);
      } catch (error) {
        logger.warn('could not register scan root from options', { path: root.path, error });
      }
    }
    core.start({ projects: justProjects, scanRoots: justScanRoots });

    let staticFiles: StaticFiles | null = null;
    if (options.webRoot) {
      staticFiles = await StaticFiles.create(options.webRoot);
      if (!staticFiles) {
        logger.warn('webRoot has no index.html; serving the API only', {
          webRoot: options.webRoot,
        });
      }
    }

    let boundPort = port;
    const app = createApp({
      core,
      hub,
      logger,
      token,
      hostPolicy: {
        boundHost: host,
        port: () => boundPort,
        allowedHosts: options.allowedHosts ?? [],
      },
      staticFiles,
      hello: (): ServerEvent => ({ type: 'hello', version, startedAt: startedAt.toISOString() }),
    });

    // Do not replace the global Request/Response: the daemon runs inside the CLI process.
    server = createServer(getRequestListener(app.fetch, { overrideGlobalObjects: false }));
    let address: AddressInfo;
    try {
      address = await listen(server, port, host);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        throw new Error(
          `port ${port} on ${host} is already in use (is another octopus-diff running?)`,
          {
            cause: error,
          },
        );
      }
      throw error;
    }
    boundPort = address.port;
    const urlHost = isWildcardHost(host) ? '127.0.0.1' : hostForUrl(host);
    const url = `http://${urlHost}:${boundPort}`;
    const authUrl = `${url}/?token=${encodeURIComponent(token)}`;
    logger.info('daemon listening', {
      url,
      stateDir,
      webUi: staticFiles !== null,
      watcher: core.watcher.status().mode,
    });

    const httpServer = server;
    let closing: Promise<void> | undefined;
    const close = (): Promise<void> => {
      closing ??= (async () => {
        await core
          .close()
          .catch((error) => logger.warn('error while stopping the core', { error }));
        hub.close();
        // SSE streams were ended above; give responses a moment to flush, then cut the rest.
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
          httpServer.closeIdleConnections();
          setTimeout(() => httpServer.closeAllConnections(), CLOSE_GRACE_MS).unref();
        });
        if (ownsGitCore) await gitCore.dispose().catch(() => {});
        store.close();
        logger.info('daemon stopped');
      })();
      return closing;
    };

    const daemon: Daemon = {
      url,
      authUrl,
      token,
      host,
      port: boundPort,
      stateDir,
      configDir,
      app,
      core,
      hub,
      store,
      logger,
      close,
    };
    return daemon;
  } catch (error) {
    if (server?.listening) server.close();
    await cleanup();
    throw error;
  }
}) satisfies StartDaemon;
