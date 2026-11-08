import { isIP } from 'node:net';
import path from 'node:path';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  type GitCoreOptions,
  type LogLevel,
  type StartDaemonOptions,
  type WatchOptions,
} from '@octopus-diff/contracts';
import type { AddressFlags, GlobalFlags, ServeFlags } from './args.js';
import {
  type LoadedConfig,
  loadConfig,
  type ResolvedConfig,
  type ScanRootSetting,
} from './config.js';
import { UsageError } from './errors.js';
import {
  CONFIG_FILE_NAME,
  defaultConfigDir,
  defaultStateDir,
  type Env,
  homeDir,
  resolveUserPath,
} from './paths.js';

/** Where things live, after flags, env and config are combined. */
export interface ResolvedPaths {
  home: string;
  configDir: string;
  configFile: string;
  /** True when `--config` named the file explicitly (then it must exist). */
  configFileExplicit: boolean;
  stateDir: string;
}

export interface Context {
  env: Env;
  cwd: string;
}

/** Where the config file is: `--config` > `--config-dir`/config.json > XDG default. */
export function resolveConfigLocation(
  flags: GlobalFlags,
  ctx: Context,
): Pick<ResolvedPaths, 'home' | 'configDir' | 'configFile' | 'configFileExplicit'> {
  const home = homeDir(ctx.env);
  const resolve = (p: string) => resolveUserPath(p, ctx.cwd, home);
  const configDir = flags.configDir ? resolve(flags.configDir) : defaultConfigDir(ctx.env);
  const configFile = flags.config ? resolve(flags.config) : path.join(configDir, CONFIG_FILE_NAME);
  return { home, configDir, configFile, configFileExplicit: flags.config !== undefined };
}

/** State dir: `--state-dir` > config `stateDir` > `$XDG_STATE_HOME/octopus-diff`. */
export function resolveStateDir(
  flags: GlobalFlags,
  ctx: Context,
  configStateDir: string | undefined,
): string {
  if (flags.stateDir) return resolveUserPath(flags.stateDir, ctx.cwd, homeDir(ctx.env));
  return configStateDir ?? defaultStateDir(ctx.env);
}

/** Resolves config/state locations and loads the config file. */
export async function loadContext(
  flags: GlobalFlags,
  ctx: Context,
): Promise<{ paths: ResolvedPaths; loaded: LoadedConfig }> {
  const location = resolveConfigLocation(flags, ctx);
  const loaded = await loadConfig(location.configFile, location.configFileExplicit, location.home);
  const stateDir = resolveStateDir(flags, ctx, loaded.config.stateDir);
  return { paths: { ...location, stateDir }, loaded };
}

export function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  if (isIP(h) === 4) return h.startsWith('127.');
  if (h.startsWith('::ffff:')) return h.slice(7).startsWith('127.');
  return false;
}

/** The address a client should use to reach a daemon bound to `host`. */
export function clientHost(host: string): string {
  const h = host.replace(/^\[|\]$/g, '');
  if (h === '0.0.0.0' || h === '') return '127.0.0.1';
  if (h === '::') return '[::1]';
  return isIP(h) === 6 ? `[${h}]` : h;
}

export function baseUrlFor(host: string, port: number): string {
  return `http://${clientHost(host)}:${port}`;
}

/** Host and port from flags > config > defaults. */
export function resolveAddress(
  flags: AddressFlags,
  config: ResolvedConfig,
): { host: string; port: number } {
  return {
    host: flags.host ?? config.host ?? DEFAULT_HOST,
    port: flags.port ?? config.port ?? DEFAULT_PORT,
  };
}

export interface ServeSettings {
  options: StartDaemonOptions;
  open: boolean;
  /** Explicit web root (flag or config), if any; otherwise auto-detected later. */
  webRoot?: string;
  logLevel: LogLevel;
}

function mergeScanRoots(
  fromConfig: ScanRootSetting[],
  fromFlags: string[],
  flagDepth: number | undefined,
  configDepth: number | undefined,
): Array<{ path: string; depth?: number }> {
  const byPath = new Map<string, { path: string; depth?: number }>();
  for (const root of fromConfig) {
    const depth = root.depth ?? configDepth;
    byPath.set(root.path, depth === undefined ? { path: root.path } : { path: root.path, depth });
  }
  for (const p of fromFlags) {
    const depth = flagDepth ?? configDepth;
    byPath.set(p, depth === undefined ? { path: p } : { path: p, depth });
  }
  return [...byPath.values()];
}

/**
 * Merges `serve` flags over the config file into `StartDaemonOptions`. Scalars: flags win.
 * Lists (`projects`, `scanRoots`, `allowedHosts`): flags are added to the config's entries,
 * since registration is idempotent and additive anyway.
 */
export function buildServeSettings(
  flags: ServeFlags,
  config: ResolvedConfig,
  paths: ResolvedPaths,
  ctx: Context,
  version: string,
): ServeSettings {
  const resolve = (p: string) => resolveUserPath(p, ctx.cwd, paths.home);
  const { host, port } = resolveAddress(flags, config);
  const allowNonLoopback = flags.allowNonLoopback ?? config.allowNonLoopback ?? false;
  if (!isLoopbackHost(host) && !allowNonLoopback) {
    throw new UsageError(
      `refusing to bind ${host}: it is not a loopback address and the API serves the contents of ` +
        'your repositories. Pass --allow-non-loopback (or set "allowNonLoopback": true) if you ' +
        'really want that.',
    );
  }

  const watch: WatchOptions = { ...config.watch };
  if (flags.watch !== undefined) watch.enabled = flags.watch;
  if (flags.poll !== undefined) watch.forcePolling = flags.poll;

  const git: GitCoreOptions = { ...config.git };
  const logLevel: LogLevel = flags.logLevel ?? config.logLevel ?? 'info';

  const projects = [...new Set([...(config.projects ?? []), ...flags.projects.map(resolve)])];
  const scanRoots = mergeScanRoots(
    config.scanRoots ?? [],
    flags.scan.map(resolve),
    flags.depth,
    config.scanDepth,
  );
  const allowedHosts = [...new Set([...(config.allowedHosts ?? []), ...flags.allowedHosts])];

  const options: StartDaemonOptions = {
    host,
    port,
    allowNonLoopback,
    stateDir: paths.stateDir,
    configDir: paths.configDir,
    projects,
    scanRoots,
    watch,
    git,
    version,
    logLevel,
  };
  if (allowedHosts.length > 0) options.allowedHosts = allowedHosts;

  const settings: ServeSettings = {
    options,
    open: flags.open ?? config.open ?? false,
    logLevel,
  };
  const webRoot = flags.webRoot ? resolve(flags.webRoot) : config.webRoot;
  if (webRoot !== undefined) settings.webRoot = webRoot;
  return settings;
}
