import { APP_NAME, type DaemonHandle } from '@octopus-diff/contracts';
import type { ServeFlags } from '../args.js';
import type { CliDeps } from '../deps.js';
import {
  CliError,
  EXIT_FAILURE,
  EXIT_OK,
  errorMessage,
  hasErrorCode,
  UsageError,
} from '../errors.js';
import { createLogger } from '../logger.js';
import { tildify } from '../paths.js';
import { detectWsl, isWindowsMountPath } from '../platform.js';
import { removeRuntimeInfo, writeRuntimeInfo } from '../runtime.js';
import { baseUrlFor, buildServeSettings, loadContext } from '../settings.js';
import { oneLine } from '../terminal.js';
import { lanAuthUrls } from '../urls.js';
import { resolveWebRoot, webRootCandidates } from '../web-assets.js';
import { authUrlFor, findRunningDaemon, probeHealth } from './daemon-client.js';

export interface ServeHooks {
  /** Web root candidates (tests point these at temp dirs). */
  webRootCandidates?: string[];
  /** Called once the daemon is up and the banner was printed (tests). */
  onReady?: (handle: DaemonHandle) => void;
}

/**
 * The banner `serve` prints. The `#token=` URL is the important line; for a wildcard bind
 * (`--host 0.0.0.0` / `::`) one LAN URL per interface address follows, since a `127.0.0.1`
 * URL is useless on other devices.
 */
export function formatBanner(
  handle: DaemonHandle,
  version: string,
  home: string,
  webRoot: string | null,
  lanUrls: readonly string[] = [],
): string {
  const lines = [
    '',
    `  ${APP_NAME} ${version} is running`,
    '',
    `  Open:   ${handle.authUrl}`,
    ...lanUrls.map((url) => `  LAN:    ${url}`),
    '',
    `  API:    ${handle.url}`,
    `  State:  ${oneLine(tildify(handle.stateDir, home))}`,
    `  Web UI: ${webRoot ? oneLine(tildify(webRoot, home)) : 'not found (API only; run `pnpm build`)'}`,
    '',
    '  The URL contains your access token; treat it like a password.',
    ...(lanUrls.length > 0
      ? ['  LAN traffic is plain HTTP: use it only on networks you trust.']
      : []),
    '  Press Ctrl+C to stop.',
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function runServe(
  flags: ServeFlags,
  deps: CliDeps,
  version: string,
  hooks: ServeHooks = {},
): Promise<number> {
  const ctx = { env: deps.env, cwd: deps.cwd };
  const { paths, loaded } = await loadContext(flags, ctx);
  const settings = buildServeSettings(flags, loaded.config, paths, ctx, version);
  const { options } = settings;
  const err = (line: string) => deps.stderr.write(`${line}\n`);
  const logger = createLogger(settings.logLevel, (line) => deps.stderr.write(line), deps.now);
  options.logger = logger;
  const wsl = detectWsl(deps.platform, deps.env, deps.readText);

  // One daemon per state dir: two would share the SQLite store and the token. The recorded
  // daemon must prove it holds the token before its URL is printed or opened (SEC-02).
  const running = await findRunningDaemon(paths.stateDir, deps);
  if (running?.verified && running.token) {
    const authUrl = authUrlFor(running.url, running.token);
    const lan = lanAuthUrls(
      running.info.host,
      running.info.port,
      running.token,
      deps.networkInterfaces(),
    );
    deps.stdout.write(
      `${APP_NAME} is already running (pid ${running.pid}) with this state directory.\n\n  Open:   ${authUrl}\n` +
        lan.map((url) => `  LAN:    ${url}\n`).join('') +
        '\n',
    );
    if (settings.open) await openOrWarn(authUrl, wsl.wsl, deps, err, paths.stateDir);
    return EXIT_OK;
  }
  if (running) {
    err(
      `warning: ${running.url} (pid ${running.pid}, recorded in the state directory) did not prove ` +
        "that it holds this state directory's token; ignoring it and starting a new daemon.",
    );
  }

  const web = resolveWebRoot(settings.webRoot, hooks.webRootCandidates ?? webRootCandidates());
  if (web.kind === 'missing' && web.explicit) {
    throw new UsageError(`web root ${web.dir} has no index.html`);
  }
  if (web.kind === 'missing') {
    err(
      `warning: built web UI not found (looked in ${web.searched.join(', ')}); serving the API only. ` +
        'Run `pnpm build` (or pass --web-root <dir>).',
    );
  }
  options.webRoot = web.kind === 'found' ? web.dir : null;

  if (wsl.wsl) {
    const onMount = [
      ...(options.projects ?? []),
      ...(options.scanRoots ?? []).map((r) => r.path),
    ].filter(isWindowsMountPath);
    if (onMount.length > 0 && !options.watch?.forcePolling) {
      err(
        `warning: ${onMount.join(', ')} ${onMount.length === 1 ? 'is' : 'are'} on a Windows drive; ` +
          'file watching may miss edits made from Windows. Consider --poll (see `octopus-diff doctor`).',
      );
    }
  }

  const startDaemon = await deps.loadStartDaemon();
  // Listen for signals before starting, so Ctrl+C during startup still shuts down cleanly.
  const shutdown = deps.waitForShutdown();
  let handle: DaemonHandle;
  try {
    handle = await startDaemon(options);
  } catch (error) {
    const host = options.host ?? '';
    const port = options.port ?? 0;
    if (hasErrorCode(error, 'EADDRINUSE')) {
      const other = await probeHealth(baseUrlFor(host, port), deps);
      throw new CliError(
        `port ${port} on ${host} is already in use` +
          (other
            ? ` by another ${APP_NAME} daemon (${other.version}, different --state-dir?)`
            : '') +
          '. Pass --port <n> (or --port 0 for any free port), or stop the program using it.',
      );
    }
    if (hasErrorCode(error, 'EACCES')) {
      throw new CliError(`not allowed to listen on ${host}:${port} (try a port above 1024)`);
    }
    throw new CliError(`failed to start the daemon: ${errorMessage(error)}`);
  }

  try {
    await writeRuntimeInfo(paths.stateDir, {
      pid: deps.pid,
      url: handle.url,
      host: handle.host,
      port: handle.port,
      version,
      startedAt: deps.now().toISOString(),
    });
  } catch (error) {
    logger.warn(
      'could not write the runtime file; `octopus-diff add` will fall back to the configured port',
      {
        error: errorMessage(error),
      },
    );
  }

  const lan = lanAuthUrls(handle.host, handle.port, handle.token, deps.networkInterfaces());
  deps.stdout.write(formatBanner(handle, version, paths.home, options.webRoot ?? null, lan));
  if (settings.open) await openOrWarn(handle.authUrl, wsl.wsl, deps, err, paths.stateDir);
  hooks.onReady?.(handle);

  const signal = await shutdown;
  err(`\nreceived ${signal}, shutting down…`);
  let exitCode = EXIT_OK;
  try {
    const result = await withTimeout(handle.close(), deps.shutdownTimeoutMs);
    if (result === 'timeout') {
      err(`shutdown did not finish within ${deps.shutdownTimeoutMs} ms; exiting anyway`);
      exitCode = EXIT_FAILURE;
    }
  } catch (error) {
    err(`error while shutting down: ${errorMessage(error)}`);
    exitCode = EXIT_FAILURE;
  }
  await removeRuntimeInfo(paths.stateDir, deps.pid).catch(() => undefined);
  return exitCode;
}

async function openOrWarn(
  url: string,
  isWsl: boolean,
  deps: CliDeps,
  err: (line: string) => void,
  stateDir: string,
): Promise<void> {
  try {
    await deps.openUrl(url, isWsl, stateDir);
  } catch (error) {
    err(`warning: ${errorMessage(error)}`);
  }
}
