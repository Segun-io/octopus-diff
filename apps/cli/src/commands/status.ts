import { APP_NAME } from '@octopus-diff/contracts';
import type { StatusFlags } from '../args.js';
import type { CliDeps } from '../deps.js';
import { EXIT_OK, errorMessage } from '../errors.js';
import { detectWsl } from '../platform.js';
import { loadContext, resolveAddress } from '../settings.js';
import { oneLine } from '../terminal.js';
import { lanAuthUrls } from '../urls.js';
import { authUrlFor, connectToDaemon, describeApiError } from './daemon-client.js';

/**
 * `octopus-diff status`: is a daemon running, where, and the URL to open it. The daemon must
 * first prove it holds the token (health challenge); only then is the `#token=` URL printed.
 */
export async function runStatus(flags: StatusFlags, deps: CliDeps): Promise<number> {
  const ctx = { env: deps.env, cwd: deps.cwd };
  const { paths, loaded } = await loadContext(flags, ctx);
  const conn = await connectToDaemon(flags, loaded.config, paths.stateDir, deps);
  const authUrl = authUrlFor(conn.baseUrl, conn.token);
  const bindHost =
    conn.runtime?.host ??
    (conn.source === 'config' ? resolveAddress(flags, loaded.config).host : '');
  const port = Number(new URL(conn.baseUrl).port || 80);
  const lanUrls = lanAuthUrls(bindHost, port, conn.token, deps.networkInterfaces());

  let projects: number | null = null;
  let worktrees: number | null = null;
  let projectsError: string | null = null;
  try {
    const list = await conn.client.listProjects();
    projects = list.projects.length;
    worktrees = list.projects.reduce((sum, p) => sum + p.worktrees.length, 0);
  } catch (error) {
    projectsError = describeApiError(error);
  }

  const { health } = conn;
  if (flags.json) {
    deps.stdout.write(
      `${JSON.stringify({ url: conn.baseUrl, authUrl, lanUrls, health, projects, worktrees, projectsError }, null, 2)}\n`,
    );
  } else {
    const lines = [
      `${APP_NAME} ${oneLine(health.version)} is running at ${conn.baseUrl}`,
      '',
      `  Open:      ${authUrl}`,
      ...lanUrls.map((url) => `  LAN:       ${url}`),
      `  git:       ${oneLine(health.git.version ?? 'unknown')}${health.git.supported ? '' : ' (unsupported!)'}`,
      `  watcher:   ${health.watcher.mode}`,
      `  projects:  ${projects === null ? `unknown (${oneLine(projectsError ?? '')})` : `${projects} (${worktrees} worktrees)`}`,
      `  uptime:    ${Math.round(health.uptimeMs / 1000)} s`,
      ...health.watcher.warnings.map((w) => `  warning:   ${oneLine(w)}`),
      '',
    ];
    deps.stdout.write(`${lines.join('\n')}\n`);
  }

  if (flags.open) {
    const wsl = detectWsl(deps.platform, deps.env, deps.readText);
    try {
      await deps.openUrl(authUrl, wsl.wsl, paths.stateDir);
    } catch (error) {
      deps.stderr.write(`warning: ${errorMessage(error)}\n`);
    }
  }
  return EXIT_OK;
}
