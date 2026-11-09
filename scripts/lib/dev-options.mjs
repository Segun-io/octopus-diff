// Pure logic for `pnpm dev` (scripts/dev.mjs): option parsing, the two children's argv/env, and the
// token URLs printed in the banner. No I/O here, so scripts/test/dev-options.test.mjs can cover it.
import path from 'node:path';
import { parseArgs } from 'node:util';

/** The production LAN daemon's port (the `octopus-diff-lan` user unit). `pnpm dev` never uses it. */
export const RESERVED_PORT = 7428;
export const DEFAULT_DAEMON_PORT = 7429;
export const DEFAULT_WEB_PORT = 5173;
/** LAN names allowed by default (the dev machine is reachable as `odino`). */
export const DEFAULT_LAN_HOSTS = ['odino', 'odino.local'];
/** Loopback names the browser may use for the Vite port; the daemon needs them listed (any port). */
export const LOOPBACK_HOSTS = ['localhost', '127.0.0.1'];

export class DevUsageError extends Error {}

export const USAGE = `Usage: pnpm dev [options] [repo paths...] [-- extra serve flags]

Runs the web UI under Vite (hot module reload) and the daemon from sources under \`tsx watch\`
(restarts on edits in apps/cli, apps/daemon and packages/*), with /api proxied from Vite to the
daemon. By default both listen on the LAN, reachable as odino / odino.local.

Options:
  --daemon-port <n>     daemon port (default ${DEFAULT_DAEMON_PORT}; env OCTOPUS_DIFF_DEV_DAEMON_PORT)
  --web-port <n>        Vite port, strict (default ${DEFAULT_WEB_PORT}; env OCTOPUS_DIFF_DEV_WEB_PORT)
  --allowed-host <name> extra Host name for the LAN, repeatable
                        (env OCTOPUS_DIFF_DEV_ALLOWED_HOSTS, comma-separated)
  --loopback            listen on 127.0.0.1 only, no LAN names
  --state-dir <dir>     daemon state (token, review store); default
                        $XDG_STATE_HOME/octopus-diff-dev, i.e. ~/.local/state/octopus-diff-dev
                        (env OCTOPUS_DIFF_DEV_STATE_DIR)
  -h, --help            show this help

Repo paths default to this checkout (env OCTOPUS_DIFF_DEV_REPOS, separated by "${path.delimiter}").
Flags after \`--\` go to \`octopus-diff serve\` unchanged, e.g. \`-- --log-level debug --poll\`.
Port ${RESERVED_PORT} is reserved for the production LAN server and is rejected.`;

function parsePort(value, what) {
  const text = String(value).trim();
  const port = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new DevUsageError(`${what} must be a port number from 1 to 65535, got "${value}"`);
  }
  if (port === RESERVED_PORT) {
    throw new DevUsageError(
      `${what} ${RESERVED_PORT} is reserved for the production LAN server (the octopus-diff-lan ` +
        `unit runs the built CLI there); pick another port, e.g. ${DEFAULT_DAEMON_PORT}.`,
    );
  }
  return port;
}

function splitList(value, separator) {
  return (value ?? '')
    .split(separator)
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * Non-internal IPv4 addresses from `os.networkInterfaces()`. The daemon only accepts a Host whose
 * port is its own unless the name is in `--allowed-host`, and the browser sends the Vite port.
 */
export function lanIPv4Addresses(interfaces) {
  const addresses = [];
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) {
      if (!info.internal && (info.family === 'IPv4' || info.family === 4)) {
        addresses.push(info.address);
      }
    }
  }
  return unique(addresses);
}

function validHostName(name) {
  // A bare host name or IPv4 address; ports, schemes, paths and brackets are not accepted here.
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(name);
}

function unique(items) {
  return [...new Set(items)];
}

/** The XDG state dir for dev (relative XDG values are ignored, as the CLI does). */
function defaultStateDir(env, home) {
  const xdg = env.XDG_STATE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, '.local', 'state');
  return path.join(base, 'octopus-diff-dev');
}

/**
 * Parses `pnpm dev` arguments and environment.
 * @param {readonly string[]} argv arguments after the script name
 * @param {Readonly<Record<string, string | undefined>>} env
 * @param {{ repoRoot: string, home: string, cwd: string, lanAddresses?: string[] }} ctx
 *   `lanAddresses`: this machine's LAN IPv4 addresses (see `lanIPv4Addresses`); in LAN mode they
 *   are allowed as Host names too, so `http://<ip>:<web port>/` works where the name doesn't resolve.
 */
export function parseDevArgs(argv, env, ctx) {
  const dashDash = argv.indexOf('--');
  const head = dashDash === -1 ? argv : argv.slice(0, dashDash);
  const serveArgs = dashDash === -1 ? [] : argv.slice(dashDash + 1);
  let parsed;
  try {
    parsed = parseArgs({
      args: [...head],
      allowPositionals: true,
      strict: true,
      options: {
        'daemon-port': { type: 'string' },
        'web-port': { type: 'string' },
        'allowed-host': { type: 'string', multiple: true },
        loopback: { type: 'boolean' },
        'state-dir': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    throw new DevUsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  const help = values.help === true;
  const lan = values.loopback !== true && env.OCTOPUS_DIFF_DEV_LOOPBACK !== '1';

  const daemonPort = parsePort(
    values['daemon-port'] ?? env.OCTOPUS_DIFF_DEV_DAEMON_PORT ?? DEFAULT_DAEMON_PORT,
    'daemon port',
  );
  const webPort = parsePort(
    values['web-port'] ?? env.OCTOPUS_DIFF_DEV_WEB_PORT ?? DEFAULT_WEB_PORT,
    'web port',
  );
  if (daemonPort === webPort) {
    throw new DevUsageError(`the daemon and web ports must differ (both are ${daemonPort})`);
  }

  const extraHosts = [
    ...splitList(env.OCTOPUS_DIFF_DEV_ALLOWED_HOSTS, ','),
    ...(values['allowed-host'] ?? []).map((name) => name.trim()),
  ];
  for (const name of extraHosts) {
    if (!validHostName(name)) {
      throw new DevUsageError(
        `--allowed-host takes a bare host name (no port or scheme), got "${name}"`,
      );
    }
  }
  const lanHosts = unique(
    [
      ...(lan ? DEFAULT_LAN_HOSTS : []),
      ...extraHosts,
      ...(lan ? (ctx.lanAddresses ?? []) : []),
    ].map((name) => name.toLowerCase()),
  );

  const repoInputs =
    positionals.length > 0
      ? positionals
      : env.OCTOPUS_DIFF_DEV_REPOS
        ? splitList(env.OCTOPUS_DIFF_DEV_REPOS, path.delimiter)
        : [ctx.repoRoot];
  const repos = repoInputs.map((input) => path.resolve(ctx.cwd, expandHome(input, ctx.home)));

  const stateInput = values['state-dir'] ?? env.OCTOPUS_DIFF_DEV_STATE_DIR;
  const stateDir = stateInput
    ? path.resolve(ctx.cwd, expandHome(stateInput, ctx.home))
    : defaultStateDir(env, ctx.home);

  return { help, lan, daemonPort, webPort, lanHosts, repos, stateDir, serveArgs };
}

function expandHome(input, home) {
  if (input === '~') return home;
  if (input.startsWith('~/')) return path.join(home, input.slice(2));
  return input;
}

/** `octopus-diff serve` arguments for the dev daemon (after `apps/cli/src/index.ts`). */
export function daemonServeArgs(opts) {
  const allowed = unique([...LOOPBACK_HOSTS, ...opts.lanHosts]);
  return [
    'serve',
    ...(opts.lan ? ['--host', '::', '--allow-non-loopback'] : ['--host', '127.0.0.1']),
    '--port',
    String(opts.daemonPort),
    ...allowed.flatMap((name) => ['--allowed-host', name]),
    '--state-dir',
    opts.stateDir,
    '--no-open',
    ...opts.serveArgs,
    '--',
    ...opts.repos,
  ];
}

/** Environment for the Vite child (read by apps/web/vite.config.ts). */
export function webEnv(opts) {
  return {
    OCTOPUS_DIFF_API: `http://127.0.0.1:${opts.daemonPort}`,
    // `::` is dual-stack on Linux and macOS, like the LAN daemon's bind.
    OCTOPUS_DIFF_WEB_HOST: opts.lan ? '::' : '127.0.0.1',
    OCTOPUS_DIFF_WEB_PORT: String(opts.webPort),
    OCTOPUS_DIFF_ALLOWED_HOSTS: opts.lanHosts.join(','),
  };
}

/** The auth token from a daemon banner line such as `  Open:   http://127.0.0.1:7429/#token=…`. */
export function tokenFromBannerLine(line) {
  const match = /^\s*Open:\s+https?:\/\/\S+#token=([A-Za-z0-9_-]+)\s*$/.exec(line);
  return match ? match[1] : null;
}

/** True for the daemon's "already running with this state directory" message. */
export function isAlreadyRunningLine(line) {
  return /is already running \(pid \d+\) with this state directory/.test(line);
}

/** The Vite URLs to open, with the token fragment (local first, then one per LAN name). */
export function webAuthUrls(opts, token) {
  const fragment = token ? `#token=${token}` : '';
  const local = opts.lan ? 'localhost' : '127.0.0.1';
  return [
    { label: 'Local', url: `http://${local}:${opts.webPort}/${fragment}` },
    ...opts.lanHosts.map((name) => ({
      label: 'LAN',
      url: `http://${name}:${opts.webPort}/${fragment}`,
    })),
  ];
}

const BANNER_START = /^\s*octopus-diff \S+ is running$/;
const BANNER_END = /^\s*Press Ctrl\+C to stop\.$/;
const BANNER_MAX_LINES = 40;
const NO_WEB_UI_WARNING = /^warning: built web UI not found/;

/**
 * A line filter for the daemon's output under `pnpm dev`. The daemon's own banner (URLs on the
 * daemon port, printed again on every restart) and its "built web UI not found" warning are
 * hidden, and blank lines dropped; the end of a banner reports `ready` with the token from its
 * `Open:` line (null if none was found), so the dev banner can point at the Vite port instead.
 */
export function createDaemonOutputFilter() {
  let inBanner = false;
  let bannerLines = 0;
  let token = null;
  return (line) => {
    if (line.trim() === '' || NO_WEB_UI_WARNING.test(line)) return { show: false };
    if (BANNER_START.test(line)) {
      inBanner = true;
      bannerLines = 0;
      token = null;
      return { show: false };
    }
    if (inBanner) {
      token = tokenFromBannerLine(line) ?? token;
      bannerLines++;
      if (BANNER_END.test(line) || bannerLines >= BANNER_MAX_LINES) {
        inBanner = false;
        return { show: false, ready: true, token };
      }
      return { show: false };
    }
    return { show: true, alreadyRunning: isAlreadyRunningLine(line) };
  };
}
