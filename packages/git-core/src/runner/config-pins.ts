/**
 * Config pinned with `-c` on every git invocation. Command-line config overrides system,
 * global, repository and worktree config, so these values hold whatever the user's or the
 * repository's config says. Two goals:
 *
 * 1. Nothing a read can trigger may run a program or write: fsmonitor hooks, pagers, gpg for
 *    signatures, auto-gc/maintenance, network transports. (External diff and textconv are
 *    disabled with `--no-ext-diff --no-textconv` flags; repo-local filter drivers are
 *    neutralized per repository, see `repo.ts`.)
 * 2. Output that git-core parses or hashes must not depend on config: prefixes, quoting,
 *    colors, rename detection, diff algorithm, hunk merging, submodule format, status options.
 *
 * Not pinned on purpose: `core.autocrlf`, `core.eol`, `core.fileMode`, `core.ignoreCase`,
 * `core.excludesFile`, `core.attributesFile`, `core.checkStat`, `core.trustctime`. These
 * define what the user's repository *is* (which files are modified or ignored); octopus-diff
 * must agree with the user's own `git status`.
 */
export const CONFIG_PINS: ReadonlyArray<readonly [string, string]> = [
  // Programs and writes.
  ['core.fsmonitor', 'false'],
  ['core.pager', 'cat'],
  ['log.showSignature', 'false'],
  ['gc.auto', '0'],
  ['maintenance.auto', 'false'],
  ['protocol.allow', 'never'],
  ['submodule.recurse', 'false'],
  ['core.safecrlf', 'false'],
  // Output shape.
  ['core.quotePath', 'false'],
  ['color.ui', 'false'],
  ['color.diff', 'false'],
  ['color.status', 'false'],
  ['diff.noprefix', 'false'],
  ['diff.mnemonicPrefix', 'false'],
  ['diff.srcPrefix', 'a/'],
  ['diff.dstPrefix', 'b/'],
  ['diff.relative', 'false'],
  ['diff.renames', 'true'],
  ['diff.renameLimit', '1000'],
  ['diff.algorithm', 'myers'],
  ['diff.indentHeuristic', 'true'],
  ['diff.interHunkContext', '0'],
  ['diff.context', '3'],
  ['diff.suppressBlankEmpty', 'false'],
  ['diff.submodule', 'short'],
  ['diff.ignoreSubmodules', 'dirty'],
  // `git diff` with autoRefreshIndex=true rewrites the index (taking index.lock) when files are
  // stat-dirty, even with --no-optional-locks (git's refresh_index_quietly ignores it). Off,
  // stat-only changes appear as raw entries without a patch, which git-core filters out.
  ['diff.autoRefreshIndex', 'false'],
  ['diff.colorMoved', 'no'],
  ['status.relativePaths', 'false'],
  ['status.renames', 'true'],
  ['status.renameLimit', '1000'],
  ['status.showStash', 'false'],
  ['status.showUntrackedFiles', 'all'],
  ['status.aheadBehind', 'true'],
  ['status.submoduleSummary', 'false'],
  ['log.decorate', 'false'],
  ['log.mailmap', 'false'],
  ['log.showRoot', 'true'],
  ['i18n.logOutputEncoding', 'UTF-8'],
];

/** `CONFIG_PINS` as `-c key=value` argv pairs. */
export const CONFIG_PIN_ARGS: readonly string[] = CONFIG_PINS.flatMap(([key, value]) => [
  '-c',
  `${key}=${value}`,
]);
