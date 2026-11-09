/**
 * @octopus-diff/forge — read-only GitHub (`gh`) and GitLab (`glab`) integration
 * (docs/FORGES.md): remote classification, the hardened CLI runner, batched pull/merge request
 * queries and branch matching. The daemon's forge service drives it.
 */
export { firstSafeLine, parseAuthStatus, stripControl } from './auth.js';
export {
  assertAllowedForgeArgs,
  FORGE_EXECUTABLES,
  ForgeCli,
  ForgeCliError,
  type ForgeCliErrorCode,
  type ForgeCliOptions,
  type ForgeCliResult,
  forgeEnv,
} from './cli.js';
export {
  ForgeClient,
  type ForgeClientOptions,
  ForgeFetchError,
  type ForgeQueryCost,
  loginHint,
} from './client.js';
export {
  buildGithubQuery,
  GITHUB_MAX_BRANCHES_PER_QUERY,
  type GithubQueryVariant,
  githubMergeState,
  normaliseGithubPullRequest,
  parseGithubResponse,
} from './github.js';
export {
  buildGitlabQuery,
  GITLAB_MAX_BRANCHES_PER_QUERY,
  gitlabMergeState,
  isUnknownFieldError,
  normaliseGitlabMergeRequest,
  parseGitlabResponse,
} from './gitlab.js';
export {
  classifyHost,
  forgeFromHostname,
  isRepositoryPathFor,
  type ParsedRemote,
  parseRemoteUrl,
  repositoryWebUrl,
} from './host.js';
export {
  type BranchHead,
  type ProjectForgeResolution,
  pickChangeRequest,
  type ResolveContext,
  remoteLocation,
  resolveBranchHead,
  resolveProjectForge,
} from './resolve.js';
export { parseSshConfigAliases } from './ssh-config.js';
