/**
 * Environment for git processes. Safety variables always win over `GitCoreOptions.env`, and
 * variables that redirect git to another repository, run programs, or write trace files are
 * removed whatever their source.
 */

/** Set on every git process (PLAN §5.5). */
export const SAFETY_ENV: Readonly<Record<string, string>> = {
  /** Never take optional locks (e.g. index.lock for the opportunistic index refresh). */
  GIT_OPTIONAL_LOCKS: '0',
  /** Never prompt for credentials. */
  GIT_TERMINAL_PROMPT: '0',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  /** English, unlocalized messages so stderr can be classified. */
  LC_ALL: 'C',
  /** Every pathspec is literal (no globs or magic). */
  GIT_LITERAL_PATHSPECS: '1',
  /** Partial clones: never fetch missing objects on demand (git >= 2.44). */
  GIT_NO_LAZY_FETCH: '1',
  /** No transport protocol is allowed at all: git-core never talks to remotes. */
  GIT_ALLOW_PROTOCOL: 'none',
  GIT_PROTOCOL_FROM_USER: '0',
  GIT_ADVICE: '0',
  GCM_INTERACTIVE: 'never',
};

/** `GIT_*` variables inherited from the daemon's own environment (config locations only). */
const INHERITED_GIT_VARS = new Set([
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_EXEC_PATH',
]);

/** Removed even when passed explicitly through `GitCoreOptions.env`. */
const FORBIDDEN_VARS = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_EXTERNAL_DIFF',
  'GIT_DIFF_OPTS',
  'GIT_DIFF_PATH_COUNTER',
  'GIT_DIFF_PATH_TOTAL',
  'GIT_ATTR_SOURCE',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_SSH_VARIANT',
  'GIT_ASKPASS',
  'SSH_ASKPASS',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_PREFIX',
  'GIT_SHALLOW_FILE',
  'GIT_GRAFT_FILE',
  'GIT_QUARANTINE_PATH',
  'GIT_INDEX_VERSION',
  'GIT_SUPER_PREFIX',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_PROTOCOL',
  'GIT_CONFIG',
]);

const FORBIDDEN_PREFIXES = ['GIT_TRACE', 'GIT_REDIRECT_'];

function isForbidden(name: string): boolean {
  return FORBIDDEN_VARS.has(name) || FORBIDDEN_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Builds the environment for git processes:
 * `process.env` minus `GIT_*` (except config locations), then `extra`, then `SAFETY_ENV`, then
 * forbidden variables removed.
 */
export function buildGitEnv(
  processEnv: NodeJS.ProcessEnv,
  extra: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(processEnv)) {
    if (value === undefined) continue;
    if (name.startsWith('GIT_') && !INHERITED_GIT_VARS.has(name)) continue;
    env[name] = value;
  }
  if (extra) Object.assign(env, extra);
  Object.assign(env, SAFETY_ENV);
  for (const name of Object.keys(env)) {
    if (isForbidden(name)) delete env[name];
  }
  return env;
}

/**
 * Appends config entries through `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` /
 * `GIT_CONFIG_VALUE_<n>` (git >= 2.31), keeping entries already present in `env`. Unlike `-c`,
 * keys may contain `=` (e.g. a filter driver named `a=b`).
 */
export function withConfigEnv(
  env: Readonly<Record<string, string>>,
  entries: ReadonlyArray<readonly [string, string]>,
): Record<string, string> {
  if (entries.length === 0) return { ...env };
  const result = { ...env };
  const existing = Number.parseInt(result.GIT_CONFIG_COUNT ?? '0', 10);
  let count = Number.isFinite(existing) && existing > 0 ? existing : 0;
  for (const [key, value] of entries) {
    result[`GIT_CONFIG_KEY_${count}`] = key;
    result[`GIT_CONFIG_VALUE_${count}`] = value;
    count += 1;
  }
  result.GIT_CONFIG_COUNT = String(count);
  return result;
}
