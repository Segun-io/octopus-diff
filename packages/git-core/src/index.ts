/**
 * @octopus-diff/git-core — PLACEHOLDER until WS1 lands.
 *
 * WS1 replaces this with the real implementation of the `GitCore` contract (PLAN §5.5, §6 WS1).
 * The daemon codes against `GitCore` from `@octopus-diff/contracts` and calls `createGitCore`.
 */
import {
  type CreateGitCore,
  type GitCore,
  GitCoreError,
  type GitCoreOptions,
} from '@octopus-diff/contracts';

/** False in this placeholder; the real implementation exports `true`. */
export const GIT_CORE_IMPLEMENTED: boolean = false;

function notImplemented(): Promise<never> {
  return Promise.reject(
    new GitCoreError('not_implemented', 'git-core is a placeholder until WS1 lands'),
  );
}

export const createGitCore: CreateGitCore = (_options?: GitCoreOptions): GitCore => ({
  version: notImplemented,
  resolveProject: notImplemented,
  listWorktrees: notImplemented,
  detectDefaultBranch: notImplemented,
  scan: notImplemented,
  getSummary: notImplemented,
  listChangedFiles: notImplemented,
  getFileDiff: notImplemented,
  listCommits: notImplemented,
  getWatchTargets: notImplemented,
  dispose: () => Promise.resolve(),
});
