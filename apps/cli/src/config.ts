import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { InputPathSchema, ScanDepthSchema } from '@octopus-diff/contracts';
import { z } from 'zod';
import { UsageError } from './errors.js';
import { resolveUserPath } from './paths.js';

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'silent']);

const PortSchema = z.number().int().min(0).max(65_535);

const ScanRootEntrySchema = z.union([
  InputPathSchema,
  z.strictObject({ path: InputPathSchema, depth: ScanDepthSchema.optional() }),
]);

export const WatchConfigSchema = z.strictObject({
  /** Default true. False = only fallback polling and manual refresh. */
  enabled: z.boolean().optional(),
  /** Extra directory names / globs to ignore in working trees (added to the daemon's defaults). */
  ignore: z.array(z.string().min(1)).optional(),
  /** Per-worktree debounce, 150–300 ms (PLAN §5.6). */
  debounceMs: z.number().int().min(150).max(300).optional(),
  /** Fallback poll interval for the focused worktree. */
  pollFocusedMs: z.number().int().min(1_000).optional(),
  /** Fallback poll interval for all other worktrees. */
  pollIdleMs: z.number().int().min(1_000).optional(),
  /** Never use native watchers; poll instead (WSL `/mnt/*`, NFS, inotify limits). */
  forcePolling: z.boolean().optional(),
});

export const GitConfigSchema = z.strictObject({
  /** Git executable; default `git` from PATH. */
  gitBinary: z.string().min(1).optional(),
  /** Max concurrent git processes (default 4). */
  concurrency: z.number().int().min(1).max(64).optional(),
  /** Per-invocation timeout in ms (default 15 000). */
  timeoutMs: z.number().int().min(1_000).optional(),
  /** Hard cap on stdout bytes per git invocation. */
  maxOutputBytes: z.number().int().positive().optional(),
  /** Soft per-file patch limit in bytes; larger patches are shown as "too large". */
  maxPatchBytes: z.number().int().positive().optional(),
  /** Max untracked files read per worktree for line counts / patch hashes. */
  maxUntrackedFiles: z.number().int().min(0).optional(),
  /**
   * Start git through a helper process so the daemon stays responsive (default true; not on
   * Windows). `false` spawns git from the daemon itself, as does `OCTOPUS_DIFF_GIT_HELPER=0`.
   */
  helper: z.boolean().optional(),
});

/**
 * `~/.config/octopus-diff/config.json`. Every field is optional; command-line flags win over the
 * file. Unknown keys are rejected so typos don't silently do nothing.
 */
export const ConfigSchema = z.strictObject({
  /** Lets editors validate the file; ignored. */
  $schema: z.string().optional(),
  /** Bind address (default 127.0.0.1). Non-loopback also needs `allowNonLoopback`. */
  host: z.string().min(1).optional(),
  /** Port (default 7428); 0 picks a free port. */
  port: PortSchema.optional(),
  allowNonLoopback: z.boolean().optional(),
  /** Extra `Host` header values to accept (loopback names are always accepted). */
  allowedHosts: z.array(z.string().min(1)).optional(),
  /** Open the browser when `serve` starts. */
  open: z.boolean().optional(),
  /** Repositories (or linked worktrees) to register at startup. */
  projects: z.array(InputPathSchema).optional(),
  /** Directories to scan for repositories at startup: a path, or `{ path, depth }`. */
  scanRoots: z.array(ScanRootEntrySchema).optional(),
  /** Depth for scan roots given without one (default 3, max 8). */
  scanDepth: ScanDepthSchema.optional(),
  watch: WatchConfigSchema.optional(),
  git: GitConfigSchema.optional(),
  logLevel: LogLevelSchema.optional(),
  /** Where the daemon keeps its token, SQLite database and runtime file. */
  stateDir: InputPathSchema.optional(),
  /** Directory with the built web UI (overrides auto-detection). */
  webRoot: InputPathSchema.optional(),
});
export type Config = z.infer<typeof ConfigSchema>;

export interface ScanRootSetting {
  path: string;
  depth?: number;
}

/** The config with every path made absolute (relative paths are relative to the config file). */
export interface ResolvedConfig extends Omit<Config, 'projects' | 'scanRoots' | '$schema'> {
  projects?: string[];
  scanRoots?: ScanRootSetting[];
}

export interface LoadedConfig {
  /** Absolute path of the config file that was (or would have been) read. */
  path: string;
  exists: boolean;
  config: ResolvedConfig;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) => `  - ${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
    )
    .join('\n');
}

/** Validates already-parsed JSON and resolves its paths. Throws `UsageError` on invalid input. */
export function parseConfig(json: unknown, file: string, home: string): ResolvedConfig {
  const parsed = ConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new UsageError(`invalid config file ${file}:\n${formatIssues(parsed.error)}`);
  }
  const { $schema: _schema, projects, scanRoots, stateDir, webRoot, ...rest } = parsed.data;
  const base = path.dirname(file);
  const resolve = (p: string) => resolveUserPath(p, base, home);
  const resolved: ResolvedConfig = { ...rest };
  if (projects) resolved.projects = projects.map(resolve);
  if (scanRoots) {
    resolved.scanRoots = scanRoots.map((entry) =>
      typeof entry === 'string'
        ? { path: resolve(entry) }
        : {
            path: resolve(entry.path),
            ...(entry.depth === undefined ? {} : { depth: entry.depth }),
          },
    );
  }
  if (stateDir) resolved.stateDir = resolve(stateDir);
  if (webRoot) resolved.webRoot = resolve(webRoot);
  return resolved;
}

/**
 * Reads the config file. A missing file is fine (defaults) unless the path was given explicitly
 * with `--config`.
 */
export async function loadConfig(
  file: string,
  explicit: boolean,
  home: string,
): Promise<LoadedConfig> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !explicit) {
      return { path: file, exists: false, config: {} };
    }
    throw new UsageError(`cannot read config file ${file}: ${(error as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`config file ${file} is not valid JSON: ${(error as Error).message}`);
  }
  return { path: file, exists: true, config: parseConfig(json, file, home) };
}

/** JSON Schema of the config file (printed by `octopus-diff config --schema`). */
export function configJsonSchema(): unknown {
  return z.toJSONSchema(ConfigSchema, { io: 'input' });
}
