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
import { readToken, removeRuntimeInfo, writeRuntimeInfo } from '../runtime.js';
import { baseUrlFor, buildServeSettings, loadContext } from '../settings.js';
import { resolveWebRoot, webRootCandidates } from '../web-assets.js';
import { authUrlFor, findRunningDaemon, probeHealth } from './daemon-client.js';

export interface ServeHooks {
  /** Web root candidates (tests point these at temp dirs). */
  webRootCandidates?: string[];
  /** Called once the daemon is up and the banner was printed (tests). */
  onReady?: (handle: DaemonHandle) => void;
}

/** The banner `serve` prints. The tokenized URL is the important line. */
export function formatBanner(
  handle: DaemonHandle,
  version: string,
  home: string,
  webRoot: string | null,
): string {
  const lines = [
    '',
    `  ${APP_NAME} ${version} is running`,
    '',
    `  Open:   ${handle.authUrl}`,
    '',
    `  API:    ${handle.url}`,
    `  State:  ${tildify(handle.stateDir, home)}`,
    `  Web UI: ${webRoot ? tildify(webRoot, home) : 'not found (API only; run `pnpm build`)'}`,
    '',
    '  The URL contains your access token; treat it like a password.',
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

  // One daemon per state dir: two would share the SQLite store and the token.
  const running = await findRunningDaemon(paths.stateDir, deps);
  if (running) {
    const token = await readToken(paths.stateDir);
    const authUrl = token ? authUrlFor(running.url, token) : running.url;
    deps.stdout.write(
      `${APP_NAME} is already running (pid ${running.pid}) with this state directory.\n\n  Open:   ${authUrl}\n\n`,
    );
    if (settings.open) await openOrWarn(authUrl, wsl.wsl, deps, err);
    return EXIT_OK;
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

  deps.stdout.write(formatBanner(handle, version, paths.home, options.webRoot ?? null));
  if (settings.open) await openOrWarn(handle.authUrl, wsl.wsl, deps, err);
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
): Promise<void> {
  try {
    await deps.openUrl(url, isWsl);
  } catch (error) {
    err(`warning: ${errorMessage(error)}`);
  }
}
