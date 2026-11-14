import { type ParseArgsOptionsConfig, parseArgs } from 'node:util';
import { SCAN_DEPTH_MAX, ServeReadyNonceSchema } from '@octopus-diff/contracts';
import { LogLevelSchema } from './config.js';
import { UsageError } from './errors.js';

export type LogLevelName = 'debug' | 'info' | 'warn' | 'error' | 'silent';

/** Options accepted by every command. */
export interface GlobalFlags {
  config?: string;
  configDir?: string;
  stateDir?: string;
  logLevel?: LogLevelName;
}

/** Options that say where the daemon is (or should be). */
export interface AddressFlags {
  host?: string;
  port?: number;
}

export interface ServeFlags extends GlobalFlags, AddressFlags {
  open?: boolean;
  scan: string[];
  depth?: number;
  projects: string[];
  allowNonLoopback?: boolean;
  allowedHosts: string[];
  watch?: boolean;
  poll?: boolean;
  webRoot?: string;
  /** File descriptor (>= 3) that receives the one-line JSON ready message (`ServeReady`). */
  readyFd?: number;
  /**
   * `--ready-stdout <nonce>` (#22): the ready line goes to stdout, framed with this nonce
   * (`formatServeReadyFrame`), for supervisors that cannot pass a descriptor (`wsl.exe`).
   */
  readyStdout?: string;
  /** Shut down gracefully when stdin ends (a supervisor's lifeline; works on Windows). */
  exitWithStdin?: boolean;
}

export interface AddFlags extends GlobalFlags, AddressFlags {
  paths: string[];
  scan: string[];
  depth?: number;
  url?: string;
}

export interface StatusFlags extends GlobalFlags, AddressFlags {
  url?: string;
  open?: boolean;
  json?: boolean;
}

export interface DoctorFlags extends GlobalFlags, AddressFlags {
  json?: boolean;
  webRoot?: string;
}

export interface ConfigFlags extends GlobalFlags {
  schema?: boolean;
  path?: boolean;
}

export interface TokenFlags extends GlobalFlags {
  rotate?: boolean;
}

export type ParsedCommand =
  | { command: 'help'; topic?: string }
  | { command: 'version' }
  | { command: 'serve'; flags: ServeFlags }
  | { command: 'add'; flags: AddFlags }
  | { command: 'status'; flags: StatusFlags }
  | { command: 'doctor'; flags: DoctorFlags }
  | { command: 'config'; flags: ConfigFlags }
  | { command: 'token'; flags: TokenFlags };

export const COMMANDS = ['serve', 'add', 'status', 'doctor', 'config', 'token', 'help'] as const;

const GLOBAL_OPTIONS = {
  config: { type: 'string', short: 'c' },
  'config-dir': { type: 'string' },
  'state-dir': { type: 'string' },
  'log-level': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsOptionsConfig;

const ADDRESS_OPTIONS = {
  host: { type: 'string' },
  port: { type: 'string', short: 'p' },
} as const satisfies ParseArgsOptionsConfig;

type Values = Record<string, string | boolean | Array<string | boolean> | undefined>;

function parse(
  command: string,
  args: readonly string[],
  options: ParseArgsOptionsConfig,
  allowPositionals: boolean,
): { values: Values; positionals: string[] } {
  try {
    const { values, positionals } = parseArgs({
      args: [...args],
      options,
      allowPositionals,
      allowNegative: true,
      strict: true,
    });
    return { values: values as Values, positionals };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`${command}: ${message.split('\n')[0]}`);
  }
}

function str(values: Values, key: string): string | undefined {
  const value = values[key];
  return typeof value === 'string' ? value : undefined;
}

function bool(values: Values, key: string): boolean | undefined {
  const value = values[key];
  return typeof value === 'boolean' ? value : undefined;
}

function list(values: Values, key: string): string[] {
  const value = values[key];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function int(values: Values, key: string, min: number, max: number): number | undefined {
  const raw = str(values, key);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new UsageError(`--${key} must be an integer, got "${raw}"`);
  const value = Number(raw);
  if (value < min || value > max) {
    throw new UsageError(`--${key} must be between ${min} and ${max}, got ${value}`);
  }
  return value;
}

function nonEmpty(values: Values, key: string): string | undefined {
  const value = str(values, key);
  if (value !== undefined && value.trim() === '')
    throw new UsageError(`--${key} must not be empty`);
  return value;
}

function globalFlags(values: Values): GlobalFlags {
  const flags: GlobalFlags = {};
  const config = nonEmpty(values, 'config');
  const configDir = nonEmpty(values, 'config-dir');
  const stateDir = nonEmpty(values, 'state-dir');
  const logLevel = str(values, 'log-level');
  if (config !== undefined) flags.config = config;
  if (configDir !== undefined) flags.configDir = configDir;
  if (stateDir !== undefined) flags.stateDir = stateDir;
  if (logLevel !== undefined) {
    const parsed = LogLevelSchema.safeParse(logLevel);
    if (!parsed.success) {
      throw new UsageError(
        `--log-level must be one of ${LogLevelSchema.options.join(', ')}, got "${logLevel}"`,
      );
    }
    flags.logLevel = parsed.data;
  }
  return flags;
}

function addressFlags(values: Values): AddressFlags {
  const flags: AddressFlags = {};
  const host = nonEmpty(values, 'host');
  const port = int(values, 'port', 0, 65_535);
  if (host !== undefined) flags.host = host;
  if (port !== undefined) flags.port = port;
  return flags;
}

/** Copies only defined values so `exactOptionalPropertyTypes`-style merging stays predictable. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function parseServe(args: readonly string[]): ParsedCommand {
  const { values, positionals } = parse(
    'serve',
    args,
    {
      ...GLOBAL_OPTIONS,
      ...ADDRESS_OPTIONS,
      open: { type: 'boolean', short: 'o' },
      scan: { type: 'string', multiple: true, short: 's' },
      depth: { type: 'string', short: 'd' },
      'allow-non-loopback': { type: 'boolean' },
      'allowed-host': { type: 'string', multiple: true },
      watch: { type: 'boolean' },
      poll: { type: 'boolean' },
      'web-root': { type: 'string' },
      'ready-fd': { type: 'string' },
      'ready-stdout': { type: 'string' },
      'exit-with-stdin': { type: 'boolean' },
    },
    true,
  );
  if (values.help) return { command: 'help', topic: 'serve' };
  const fd = readyFd(values);
  const stdoutNonce = readyStdout(values);
  if (fd !== undefined && stdoutNonce !== undefined) {
    throw new UsageError('--ready-fd and --ready-stdout cannot be combined (one ready channel)');
  }
  return {
    command: 'serve',
    flags: defined({
      ...globalFlags(values),
      ...addressFlags(values),
      open: bool(values, 'open'),
      scan: list(values, 'scan'),
      depth: int(values, 'depth', 0, SCAN_DEPTH_MAX),
      projects: positionals,
      allowNonLoopback: bool(values, 'allow-non-loopback'),
      allowedHosts: list(values, 'allowed-host'),
      watch: bool(values, 'watch'),
      poll: bool(values, 'poll'),
      webRoot: nonEmpty(values, 'web-root'),
      readyFd: fd,
      readyStdout: stdoutNonce,
      exitWithStdin: bool(values, 'exit-with-stdin'),
    }),
  };
}

/** `--ready-fd <n>`: an integer >= 3 (0-2 are stdin/stdout/stderr, and a fd is a 32-bit int). */
function readyFd(values: Values): number | undefined {
  const raw = str(values, 'ready-fd');
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) {
    throw new UsageError(`--ready-fd must be an integer file descriptor (3 or more), got "${raw}"`);
  }
  const fd = Number(raw);
  if (fd < 3 || fd > 2_147_483_647) {
    throw new UsageError(
      `--ready-fd must be a file descriptor of 3 or more (0-2 are stdin, stdout and stderr), got ${raw}`,
    );
  }
  return fd;
}

/** `--ready-stdout <nonce>`: 16-128 characters of `[A-Za-z0-9_-]` (`ServeReadyNonceSchema`). */
function readyStdout(values: Values): string | undefined {
  const raw = str(values, 'ready-stdout');
  if (raw === undefined) return undefined;
  if (!ServeReadyNonceSchema.safeParse(raw).success) {
    throw new UsageError(
      '--ready-stdout needs a nonce of 16-128 characters (letters, digits, "_" and "-")',
    );
  }
  return raw;
}

function parseAdd(args: readonly string[]): ParsedCommand {
  const { values, positionals } = parse(
    'add',
    args,
    {
      ...GLOBAL_OPTIONS,
      ...ADDRESS_OPTIONS,
      scan: { type: 'string', multiple: true, short: 's' },
      depth: { type: 'string', short: 'd' },
      url: { type: 'string' },
    },
    true,
  );
  if (values.help) return { command: 'help', topic: 'add' };
  const flags: AddFlags = defined({
    ...globalFlags(values),
    ...addressFlags(values),
    paths: positionals,
    scan: list(values, 'scan'),
    depth: int(values, 'depth', 0, SCAN_DEPTH_MAX),
    url: nonEmpty(values, 'url'),
  });
  if (flags.paths.length === 0 && flags.scan.length === 0) {
    throw new UsageError('add: give at least one repository path, or --scan <dir>');
  }
  if (flags.depth !== undefined && flags.scan.length === 0) {
    throw new UsageError('add: --depth only applies to --scan directories');
  }
  return { command: 'add', flags };
}

function parseStatus(args: readonly string[]): ParsedCommand {
  const { values } = parse(
    'status',
    args,
    {
      ...GLOBAL_OPTIONS,
      ...ADDRESS_OPTIONS,
      url: { type: 'string' },
      open: { type: 'boolean', short: 'o' },
      json: { type: 'boolean' },
    },
    false,
  );
  if (values.help) return { command: 'help', topic: 'status' };
  return {
    command: 'status',
    flags: defined({
      ...globalFlags(values),
      ...addressFlags(values),
      url: nonEmpty(values, 'url'),
      open: bool(values, 'open'),
      json: bool(values, 'json'),
    }),
  };
}

function parseDoctor(args: readonly string[]): ParsedCommand {
  const { values } = parse(
    'doctor',
    args,
    {
      ...GLOBAL_OPTIONS,
      ...ADDRESS_OPTIONS,
      json: { type: 'boolean' },
      'web-root': { type: 'string' },
    },
    false,
  );
  if (values.help) return { command: 'help', topic: 'doctor' };
  return {
    command: 'doctor',
    flags: defined({
      ...globalFlags(values),
      ...addressFlags(values),
      json: bool(values, 'json'),
      webRoot: nonEmpty(values, 'web-root'),
    }),
  };
}

function parseConfigCommand(args: readonly string[]): ParsedCommand {
  const { values } = parse(
    'config',
    args,
    { ...GLOBAL_OPTIONS, schema: { type: 'boolean' }, path: { type: 'boolean' } },
    false,
  );
  if (values.help) return { command: 'help', topic: 'config' };
  return {
    command: 'config',
    flags: defined({
      ...globalFlags(values),
      schema: bool(values, 'schema'),
      path: bool(values, 'path'),
    }),
  };
}

function parseToken(args: readonly string[]): ParsedCommand {
  const { values } = parse(
    'token',
    args,
    { ...GLOBAL_OPTIONS, rotate: { type: 'boolean' } },
    false,
  );
  if (values.help) return { command: 'help', topic: 'token' };
  return {
    command: 'token',
    flags: defined({ ...globalFlags(values), rotate: bool(values, 'rotate') }),
  };
}

/**
 * Parses the command line (without `node` and the script path). With no command, or when the
 * first argument is an option, the command is `serve`, so `npx octopus-diff` just starts.
 */
export function parseCommandLine(argv: readonly string[]): ParsedCommand {
  const [first, ...rest] = argv;
  if (first === '--version' || first === '-v' || first === 'version') return { command: 'version' };
  if (first === '--help' || first === '-h') return { command: 'help' };
  if (first === 'help')
    return rest[0] === undefined ? { command: 'help' } : { command: 'help', topic: rest[0] };
  if (first === undefined || first.startsWith('-')) return parseServe(argv);
  switch (first) {
    case 'serve':
      return parseServe(rest);
    case 'add':
      return parseAdd(rest);
    case 'status':
      return parseStatus(rest);
    case 'doctor':
      return parseDoctor(rest);
    case 'config':
      return parseConfigCommand(rest);
    case 'token':
      return parseToken(rest);
    default:
      throw new UsageError(`unknown command "${first}" (commands: ${COMMANDS.join(', ')})`);
  }
}
