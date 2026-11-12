import type { GitVersion } from '@octopus-diff/contracts';

/**
 * Minimum supported git version. 2.31 brings everything git-core relies on without fallbacks:
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_<n>` environment config (used to neutralize repo-local
 * filter drivers whose names may contain `=`), `rev-parse --path-format=absolute`,
 * `config --show-scope` (2.26), `--no-relative` (2.28), `--no-optional-locks` (2.15) and
 * porcelain v2 status (2.11). See docs/reports/git-core.md.
 */
export const MIN_GIT_VERSION = { major: 2, minor: 31, patch: 0 } as const;

export function compareVersion(
  a: { major: number; minor: number; patch: number },
  b: { major: number; minor: number; patch: number },
): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

function atLeast(v: GitVersion, major: number, minor: number, patch = 0): boolean {
  return compareVersion(v, { major, minor, patch }) >= 0;
}

/**
 * Parses `git --version` output such as `git version 2.53.0`, `git version 2.39.3 (Apple
 * Git-146)` or `git version 2.45.1.windows.1`. Returns null if no version number is found.
 */
export function parseGitVersion(raw: string): GitVersion | null {
  const text = raw.trim();
  const match = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
  if (!match) return null;
  const version: GitVersion = {
    raw: text,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    features: {},
  };
  version.features = {
    /** Meets MIN_GIT_VERSION; git-core refuses to run otherwise (`git_unsupported`). */
    supported: atLeast(
      version,
      MIN_GIT_VERSION.major,
      MIN_GIT_VERSION.minor,
      MIN_GIT_VERSION.patch,
    ),
    /** `--end-of-options` for revision-taking commands. */
    endOfOptions: atLeast(version, 2, 24),
    /** `rev-parse --path-format=absolute`. */
    pathFormatAbsolute: atLeast(version, 2, 31),
    /** `config --show-scope`. */
    configShowScope: atLeast(version, 2, 26),
    /** `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`. */
    configEnv: atLeast(version, 2, 31),
    /** `prunable` annotations in `worktree list --porcelain`. */
    worktreePrunable: atLeast(version, 2, 31),
    /** `worktree list --porcelain -z`. */
    worktreeListZ: atLeast(version, 2, 36),
    /** `GIT_NO_LAZY_FETCH` (no on-demand fetches from promisor remotes in partial clones). */
    noLazyFetch: atLeast(version, 2, 44),
    /** `for-each-ref --format=%(ahead-behind:<committish>)` (#29; older git counts with rev-list). */
    forEachRefAheadBehind: atLeast(version, 2, 41),
  };
  return version;
}
