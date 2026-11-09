/**
 * @octopus-diff/git-core — read-only git CLI runner, parsers, discovery and diff retrieval.
 *
 * Implements the `GitCore` contract from `@octopus-diff/contracts` (PLAN §5.5, §6 WS1). The
 * daemon should only need `createGitCore` and `hashId`; the rest is exported for tests, tools
 * and the read-only proof harness.
 */

export { compareBstr, decodeRepoPath, selectorToBstr } from './bstr.js';
export { computeFilterOverrides, EMPTY_TREE } from './context.js';
export { createGitCore } from './core.js';
export { PatchCollector, STATUS_ARGS } from './diff.js';
export { SCAN_MAX_DIRS } from './discovery.js';
export { hashId, PATCH_HASH_LENGTH, STATE_HASH_LENGTH } from './hash.js';
export {
  DiffOutputParser,
  type NumstatEntry,
  parseRawNumstat,
  type RawEntry,
} from './parse/diff-output.js';
export { LOG_FORMAT, parseLog } from './parse/log.js';
export {
  type ChunkInfo,
  PatchSplitter,
  parseChunkHeader,
  splitPatch,
  unquoteMaybe,
} from './parse/patch.js';
export { forEachRefFormat, parseForEachRef } from './parse/refs.js';
export { parseStatusV2, type StatusBranch, type StatusEntry } from './parse/status.js';
export { parseWorktreeList, type WorktreeRecord } from './parse/worktrees.js';
export {
  ALLOWED_SUBCOMMANDS,
  assertAllowedGitArgs,
  assertStdinAllowed,
} from './runner/allowlist.js';
export { CONFIG_PINS } from './runner/config-pins.js';
export { buildGitEnv, SAFETY_ENV } from './runner/env.js';
export { buildGitArgv, GitRunner, resolveExecutable } from './runner/runner.js';
export { CANONICAL_CONTEXT, DIFF_PINS } from './scope.js';
export { quotePathName, synthesizeNewFilePatch } from './untracked.js';
export { MIN_GIT_VERSION, parseGitVersion } from './version.js';

/** The real implementation (the Phase 0 placeholder exported `false`). */
export const GIT_CORE_IMPLEMENTED: boolean = true;
export { parseRemoteConfig, REMOTE_CONFIG_REGEX, rewriteUrl } from './remotes.js';
export { readRepositoryInfo, stripUrlCredentials } from './repository.js';
