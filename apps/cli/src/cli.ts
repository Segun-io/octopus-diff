import { APP_NAME, DEFAULT_HOST, DEFAULT_PORT, SCAN_DEPTH_DEFAULT } from '@octopus-diff/contracts';
import { parseCommandLine } from './args.js';
import { runAdd } from './commands/add.js';
import { runConfig } from './commands/config.js';
import { type DoctorHooks, runDoctor } from './commands/doctor.js';
import { runServe, type ServeHooks } from './commands/serve.js';
import { runStatus } from './commands/status.js';
import { runToken } from './commands/token.js';
import { type CliDeps, cliVersion } from './deps.js';
import { CliError, EXIT_FAILURE, EXIT_OK, EXIT_USAGE, UsageError } from './errors.js';
import { safeOutput } from './terminal.js';

const GLOBAL_HELP = `Global options:
  -c, --config <file>      Config file (default: $XDG_CONFIG_HOME/${APP_NAME}/config.json)
      --config-dir <dir>   Config directory (default: ~/.config/${APP_NAME})
      --state-dir <dir>    State directory: token, database (default: ~/.local/state/${APP_NAME})
      --log-level <level>  debug | info | warn | error | silent (default: info)
  -h, --help               Show help`;

export const USAGE = `Usage: ${APP_NAME} [command] [options]

A read-only, diff-first git UI for many repositories and worktrees at once.

Commands:
  serve [path…]     Start the daemon and print the URL to open (the default command)
  add <path…>       Register repositories with the running daemon (--scan <dir> for scan roots)
  status            Show whether a daemon is running and the URL to open it
  doctor            Check git, Node, inotify limits, WSL, paths, port and web assets
  config            Show the config file location and contents (--schema for its JSON Schema)
  token --rotate    Replace the access token (restart the daemon afterwards)
  help [command]    Show help for a command

Run \`${APP_NAME} help <command>\` for the options of a command.
  -v, --version     Print the version

${GLOBAL_HELP}
`;

const COMMAND_HELP: Record<string, string> = {
  serve: `Usage: ${APP_NAME} serve [path…] [options]

Starts the daemon, serves the web UI and prints the URL to open (it ends in #token=…; the
browser keeps the token and removes it from the address bar). With --host 0.0.0.0 or :: it also
prints one URL per LAN address. Paths given as arguments are registered as projects (any
directory inside a repository, or a linked worktree).

Options:
  -p, --port <n>             Port (default ${DEFAULT_PORT}; 0 = any free port)
      --host <addr>          Bind address (default ${DEFAULT_HOST})
      --allow-non-loopback   Required to bind an address other than loopback (exposes your code!)
      --allowed-host <name>  Extra Host header value to accept (repeatable)
  -o, --open / --no-open     Open the browser
  -s, --scan <dir>           Scan a directory for repositories (repeatable)
  -d, --depth <n>            Scan depth for --scan (default ${SCAN_DEPTH_DEFAULT}, max 8)
      --watch / --no-watch   File watching (default on; off = polling and manual refresh only)
      --poll                 Poll instead of using native file watchers (WSL /mnt/*, NFS)
      --web-root <dir>       Serve the web UI from this directory

${GLOBAL_HELP}
`,
  add: `Usage: ${APP_NAME} add <path…> [--scan <dir>…] [options]

Registers repositories (or scan roots) with the running daemon. Needs \`${APP_NAME} serve\`
running; the daemon is found through the state directory, --url, or --host/--port.

Options:
  -s, --scan <dir>    Add a scan root instead of a single repository (repeatable)
  -d, --depth <n>     Scan depth (default ${SCAN_DEPTH_DEFAULT}, max 8)
      --url <url>     Daemon URL (default: the running daemon, else http://${DEFAULT_HOST}:${DEFAULT_PORT})
  -p, --port <n>      Daemon port
      --host <addr>   Daemon host

${GLOBAL_HELP}
`,
  status: `Usage: ${APP_NAME} status [options]

Shows whether a daemon is running, its health, and the URL to open (#token=…). The daemon
must first prove that it holds the token (a health challenge); the token is never sent to, or
printed for, a daemon that can't.

Options:
  -o, --open          Open the URL in the browser
      --json          Machine-readable output
      --url <url>     Daemon URL
  -p, --port <n>      Daemon port
      --host <addr>   Daemon host

${GLOBAL_HELP}
`,
  doctor: `Usage: ${APP_NAME} doctor [options]

Checks Node, git (version), inotify limits (Linux), WSL caveats, the config file, the state
directory and token permissions, the port, and the web assets. Exits with 1 if a check fails.

Options:
      --json             Machine-readable output
  -p, --port <n>         Port to check
      --host <addr>      Host to check
      --web-root <dir>   Web assets directory to check

${GLOBAL_HELP}
`,
  token: `Usage: ${APP_NAME} token [--rotate] [options]

Without options, shows where the access token is stored (never the token itself).

Options:
      --rotate   Replace the token with a new random one. A running daemon keeps the old token
                 until it restarts: stop it and run \`${APP_NAME} serve\` again, then open the new
                 URL. Browsers signed in with the old token must open the new URL.

${GLOBAL_HELP}
`,
  config: `Usage: ${APP_NAME} config [--path | --schema] [options]

Prints the config file path, the state directory and the validated config.

Options:
      --path     Print only the config file path
      --schema   Print the JSON Schema of the config file

${GLOBAL_HELP}
`,
};

export function helpText(topic?: string): string | null {
  if (topic === undefined) return USAGE;
  return COMMAND_HELP[topic] ?? null;
}

export interface RunHooks {
  serve?: ServeHooks;
  doctor?: DoctorHooks;
}

/** Runs the CLI and returns the exit code. Never calls `process.exit`. */
export async function run(
  argv: readonly string[],
  rawDeps: CliDeps,
  hooks: RunHooks = {},
): Promise<number> {
  // SEC-09: repository-derived text (names, paths, git messages, daemon logs) must not reach
  // the terminal with control or bidi characters, whatever code path prints it.
  const deps: CliDeps = {
    ...rawDeps,
    stdout: safeOutput(rawDeps.stdout),
    stderr: safeOutput(rawDeps.stderr),
  };
  const version = cliVersion();
  try {
    const parsed = parseCommandLine(argv);
    switch (parsed.command) {
      case 'help': {
        const text = helpText(parsed.topic);
        if (text === null) throw new UsageError(`no help for unknown command "${parsed.topic}"`);
        deps.stdout.write(text);
        return EXIT_OK;
      }
      case 'version':
        deps.stdout.write(`${version}\n`);
        return EXIT_OK;
      case 'serve':
        return await runServe(parsed.flags, deps, version, hooks.serve);
      case 'add':
        return await runAdd(parsed.flags, deps);
      case 'status':
        return await runStatus(parsed.flags, deps);
      case 'doctor':
        return await runDoctor(parsed.flags, deps, version, hooks.doctor);
      case 'config':
        return await runConfig(parsed.flags, deps);
      case 'token':
        return await runToken(parsed.flags, deps);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      deps.stderr.write(`${APP_NAME}: ${error.message}\nRun \`${APP_NAME} --help\` for usage.\n`);
      return EXIT_USAGE;
    }
    if (error instanceof CliError) {
      deps.stderr.write(`${APP_NAME}: ${error.message}\n`);
      return error.exitCode;
    }
    deps.stderr.write(
      `${APP_NAME}: unexpected error: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    return EXIT_FAILURE;
  }
}
