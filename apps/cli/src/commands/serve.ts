import {
  APP_NAME,
  type DaemonHandle,
  formatServeReadyFrame,
  type ServeReady,
} from '@octopus-diff/contracts';
import type { ServeFlags } from '../args.js';
import type { BrokenPipes, CliDeps, Output, ReadyChannel } from '../deps.js';
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
import { removeRuntimeInfo, runtimeFilePath, writeRuntimeInfo } from '../runtime.js';
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
  /**
   * With `--ready-fd` the token travels on that fd only, with `--ready-stdout` in the ready frame
   * only (`'stdout'`): no `#token=` URL in the banner.
   */
  readyFd?: number | 'stdout',
): string {
  if (readyFd !== undefined) {
    const lines = [
      '',
      `  ${APP_NAME} ${version} is running`,
      '',
      `  API:    ${handle.url}`,
      `  State:  ${oneLine(tildify(handle.stateDir, home))}`,
      `  Web UI: ${webRoot ? oneLine(tildify(webRoot, home)) : 'not found (API only; run `pnpm build`)'}`,
      '',
      readyFd === 'stdout'
        ? '  The access URL was sent in the ready frame on stdout.'
        : `  The access URL was sent on file descriptor ${readyFd}.`,
      '',
    ];
    return `${lines.join('\n')}\n`;
  }
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

/** One compact JSON line (the `ServeReadySchema` shape) ending in a newline. */
export function formatReadyLine(ready: ServeReady): string {
  return `${JSON.stringify(ready)}\n`;
}

/** The supervisor's ready channel: `--ready-fd <n>`, or stdout with `--ready-stdout <nonce>`. */
interface Ready {
  channel: ReadyChannel;
  /** Where it goes, for messages (never the token). */
  where: string;
  /** What is written: one JSON line, or that line framed for stdout. */
  format(ready: ServeReady): string;
  /** For the banner. */
  banner: number | 'stdout';
}

function openReadyChannel(flags: ServeFlags, deps: CliDeps): Ready | undefined {
  const nonce = flags.readyStdout;
  if (nonce !== undefined) {
    return {
      channel: deps.openStdoutReadyChannel(),
      where: 'stdout',
      format: (ready) => formatServeReadyFrame(nonce, ready),
      banner: 'stdout',
    };
  }
  if (flags.readyFd === undefined) return undefined;
  try {
    return {
      channel: deps.openReadyChannel(flags.readyFd),
      where: `file descriptor ${flags.readyFd}`,
      format: formatReadyLine,
      banner: flags.readyFd,
    };
  } catch (error) {
    throw new CliError(`--ready-fd ${flags.readyFd}: ${errorMessage(error)}`);
  }
}

/** `out`, minus every write once `broken()` says its pipe is gone (a supervised run). */
function dropWhenBroken(out: Output, broken: () => boolean): Output {
  return {
    write: (chunk) => {
      if (broken()) return false;
      return out.write(chunk);
    },
  };
}

/**
 * A supervised run (`--exit-with-stdin` or `--ready-stdout`) outlives its reader when the
 * supervisor dies: writes to a broken stdout/stderr are dropped from then on (#22 review).
 */
function superviseOutputs(flags: ServeFlags, deps: CliDeps): CliDeps {
  if (!flags.exitWithStdin && flags.readyStdout === undefined) return deps;
  const pipes: BrokenPipes = deps.watchBrokenPipes();
  return {
    ...deps,
    stdout: dropWhenBroken(deps.stdout, pipes.stdout),
    stderr: dropWhenBroken(deps.stderr, pipes.stderr),
  };
}

export async function runServe(
  flags: ServeFlags,
  rawDeps: CliDeps,
  version: string,
  hooks: ServeHooks = {},
): Promise<number> {
  const deps = superviseOutputs(flags, rawDeps);
  const ctx = { env: deps.env, cwd: deps.cwd };
  const { paths, loaded } = await loadContext(flags, ctx);
  const settings = buildServeSettings(flags, loaded.config, paths, ctx, version);
  const { options } = settings;
  const err = (line: string) => deps.stderr.write(`${line}\n`);
  const logger = createLogger(settings.logLevel, (line) => deps.stderr.write(line), deps.now);
  options.logger = logger;
  const wsl = detectWsl(deps.platform, deps.env, deps.readText);
  // Fail before starting anything when the supervisor's channel is not there.
  const ready = openReadyChannel(flags, deps);

  // One daemon per state dir: two would share the SQLite store and the token. The recorded
  // daemon must prove it holds the token before its URL is printed or opened (SEC-02).
  const running = await findRunningDaemon(paths.stateDir, deps);
  if (running?.verified && running.token) {
    const authUrl = authUrlFor(running.url, running.token);
    if (ready && flags.host !== undefined && flags.host !== running.info.host) {
      // The supervisor asked for this bind address (the desktop's WSL backend: 127.0.0.1); a
      // daemon bound elsewhere (0.0.0.0: the LAN) is not what it asked for, even though its URL
      // reads 127.0.0.1 (#22 review). Nothing secret is printed.
      throw new CliError(
        `a daemon already runs for this state directory (pid ${running.pid}) bound to ` +
          `${running.info.host}, not to --host ${flags.host}; not attaching. Stop it, or run ` +
          `serve without --host to use it.`,
      );
    }
    if (ready) {
      // The token goes to the supervisor on its fd only, never to stdout.
      deps.stdout.write(
        `${APP_NAME} is already running (pid ${running.pid}) with this state directory.\n`,
      );
      const failure = sendReady(ready, {
        mode: 'attached',
        url: running.url,
        authUrl,
        pid: running.pid,
        version: running.health.version,
        host: running.info.host,
      });
      if (failure) {
        err(failure);
        return EXIT_FAILURE;
      }
    } else {
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
    }
    if (settings.open) await openOrWarn(authUrl, wsl.wsl, deps, err, paths.stateDir);
    return EXIT_OK;
  }
  if (running) {
    // Most likely our daemon with a token rotated since it started (or an older version): don't
    // start a second daemon on the same state dir, and don't print or open its URL either.
    throw new CliError(
      `a daemon is recorded for this state directory (pid ${running.pid}, ${running.url}) and ` +
        "answers, but it did not prove that it holds this state directory's token (was the token " +
        'rotated while it ran?). The token was not sent. Stop that daemon and run serve again; if ' +
        `it is not yours, remove ${runtimeFilePath(paths.stateDir)}.`,
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
  const signals = deps.waitForShutdown();
  // `--exit-with-stdin`: the end of stdin is the same request as a signal. Not read otherwise.
  const stdin = flags.exitWithStdin ? deps.watchStdin() : undefined;
  const shutdown = stdin ? Promise.race([signals, stdin.closed]) : signals;
  let handle: DaemonHandle;
  try {
    handle = await startDaemon(options);
  } catch (error) {
    stdin?.stop();
    ready?.channel.close();
    const host = options.host ?? '';
    const port = options.port ?? 0;
    if (hasErrorCode(error, 'EADDRINUSE')) {
      const other = await probeHealth(baseUrlFor(host, port), deps);
      throw new CliError(
        `port ${port} on ${host} is already in use` +
          (other
            ? ` by another ${APP_NAME} daemon (${other.version}, different --state-dir?)`
            : '') +
          '. Pass --port <n> (or --port 0 for any free port), or stop the program using it.' +
          (wsl.wsl
            ? ' In WSL with mirrored networking, Windows programs (another octopus-diff too) share these ports.'
            : ''),
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
  deps.stdout.write(
    formatBanner(handle, version, paths.home, options.webRoot ?? null, lan, ready?.banner),
  );
  let exitCode = EXIT_OK;
  let proceed = true;
  if (ready) {
    const failure = sendReady(ready, {
      mode: 'started',
      url: handle.url,
      authUrl: handle.authUrl,
      pid: deps.pid,
      version,
      host: handle.host,
    });
    if (failure) {
      // Nobody can learn where this daemon is: do not leave it running unseen.
      err(failure);
      exitCode = EXIT_FAILURE;
      proceed = false;
    }
  }
  if (proceed) {
    if (settings.open) await openOrWarn(handle.authUrl, wsl.wsl, deps, err, paths.stateDir);
    hooks.onReady?.(handle);
    const reason = await shutdown;
    err(
      reason.startsWith('SIG')
        ? `\nreceived ${reason}, shutting down…`
        : `\n${reason}, shutting down…`,
    );
  }
  stdin?.stop();
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

/**
 * Writes the ready line and closes the channel. Returns a message (never containing the token)
 * when the line could not be delivered, e.g. the supervisor already closed its end.
 */
function sendReady(target: Ready, ready: ServeReady): string | undefined {
  const what = target.banner === 'stdout' ? 'the ready frame' : 'the ready line';
  try {
    target.channel.write(target.format(ready));
    return undefined;
  } catch (error) {
    return `could not write ${what} to ${target.where}: ${errorMessage(error)}`;
  } finally {
    target.channel.close();
  }
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
