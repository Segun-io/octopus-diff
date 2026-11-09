import type {
  ChangeRequest,
  ChangeRequestChecks,
  ChecksState,
  MergeState,
} from '@octopus-diff/contracts';
import {
  asArray,
  asBool,
  asNumber,
  asRecord,
  asString,
  normaliseTimestamp,
  toSha,
} from './json.js';

/**
 * GitHub pull requests for a batch of head branches, in one GraphQL query per repository
 * (`gh api graphql`). Each branch becomes an aliased `pullRequests(headRefName:)` connection, so
 * N worktrees cost one request (1 rate-limit point), not N. Branch names travel as GraphQL
 * variables (`--raw-field bN=<branch>`), never inside the query text.
 */

export const GITHUB_MAX_BRANCHES_PER_QUERY = 20;
/** Requests per branch: an open one and recent merged/closed ones, newest first. */
const PER_BRANCH = 5;

/**
 * `full` adds `mergeStateStatus`, which old GitHub Enterprise Server versions lack; `basic` drops
 * it and is used when the full query reports unknown fields (same rule as GitLab's variants).
 */
export type GithubQueryVariant = 'full' | 'basic';

const PR_FIELDS = `number title url state isDraft createdAt updatedAt baseRefName headRefName headRefOid
  additions deletions changedFiles
  isCrossRepository author { login } headRepository { nameWithOwner }
  reviewDecision mergeable totalCommentsCount
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 1) {
    totalCount checkRunCountsByState { state count } statusContextCountsByState { state count }
  } } } } }`;

/** The query for `count` branches. Deterministic, so the allowlist can rebuild and compare it. */
export function buildGithubQuery(count: number, variant: GithubQueryVariant = 'full'): string {
  if (!Number.isInteger(count) || count < 1 || count > GITHUB_MAX_BRANCHES_PER_QUERY) {
    throw new RangeError(`branch count out of range: ${count}`);
  }
  const vars = ['$owner: String!', '$name: String!'];
  const fields: string[] = [];
  for (let i = 0; i < count; i++) {
    vars.push(`$b${i}: String!`);
    fields.push(
      `b${i}: pullRequests(headRefName: $b${i}, first: ${PER_BRANCH}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { ...pr } }`,
    );
  }
  const body = variant === 'full' ? `${PR_FIELDS} mergeStateStatus` : PR_FIELDS;
  return `query OctopusDiffPullRequests(${vars.join(', ')}) { rateLimit { cost remaining } repository(owner: $owner, name: $name) { ${fields.join(' ')} } } fragment pr on PullRequest { ${body} }`;
}

const PASSED_RUNS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED']);
const FAILED_RUNS = new Set([
  'FAILURE',
  'TIMED_OUT',
  'CANCELLED',
  'STARTUP_FAILURE',
  'ACTION_REQUIRED',
]);
const PENDING_RUNS = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED']);

function countBy(list: unknown, states: ReadonlySet<string>): number {
  let total = 0;
  for (const entry of asArray(list)) {
    const record = asRecord(entry);
    const state = asString(record?.state);
    const count = asNumber(record?.count);
    if (state !== null && count !== null && states.has(state)) total += count;
  }
  return total;
}

function rollupState(state: string | null): ChecksState {
  switch (state) {
    case 'SUCCESS':
      return 'success';
    case 'FAILURE':
    case 'ERROR':
      return 'failure';
    case 'PENDING':
    case 'EXPECTED':
      return 'pending';
    default:
      return 'neutral';
  }
}

function normaliseChecks(commits: unknown): ChangeRequestChecks | null {
  const node = asRecord(asArray(asRecord(commits)?.nodes)[0]);
  const rollup = asRecord(asRecord(node?.commit)?.statusCheckRollup);
  if (!rollup) return null;
  const contexts = asRecord(rollup.contexts);
  const runs = contexts?.checkRunCountsByState;
  const statuses = contexts?.statusContextCountsByState;
  return {
    state: rollupState(asString(rollup.state)),
    passed: countBy(runs, PASSED_RUNS) + countBy(statuses, new Set(['SUCCESS'])),
    failed: countBy(runs, FAILED_RUNS) + countBy(statuses, new Set(['FAILURE', 'ERROR'])),
    pending: countBy(runs, PENDING_RUNS) + countBy(statuses, new Set(['PENDING', 'EXPECTED'])),
    total: asNumber(contexts?.totalCount),
  };
}

/** GitHub `mergeStateStatus` -> `MergeState` (null when absent). */
export function githubMergeState(value: unknown): MergeState | null {
  switch (asString(value)) {
    case null:
      return null;
    case 'CLEAN':
    case 'HAS_HOOKS':
      return 'clean';
    case 'BLOCKED':
      return 'blocked';
    case 'BEHIND':
      return 'behind';
    case 'DIRTY':
      return 'conflicts';
    case 'UNSTABLE':
      return 'unstable';
    case 'DRAFT':
      return 'draft';
    default:
      return 'unknown';
  }
}

/** One `PullRequest` node -> `ChangeRequest`; null when required fields are missing. */
export function normaliseGithubPullRequest(raw: unknown): ChangeRequest | null {
  const pr = asRecord(raw);
  if (!pr) return null;
  const number = asNumber(pr.number);
  const url = asString(pr.url);
  const baseBranch = asString(pr.baseRefName);
  const headBranch = asString(pr.headRefName);
  if (number === null || number < 1 || !url?.startsWith('https://') || !baseBranch || !headBranch) {
    return null;
  }
  const state = asString(pr.state);
  const review = asString(pr.reviewDecision);
  const mergeable = asString(pr.mergeable);
  return {
    kind: 'github',
    number,
    title: asString(pr.title) ?? '',
    url,
    state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open',
    draft: asBool(pr.isDraft) ?? false,
    author: asString(asRecord(pr.author)?.login),
    baseBranch,
    headBranch,
    headSha: toSha(pr.headRefOid),
    crossRepository: asBool(pr.isCrossRepository) ?? false,
    headRepository: asString(asRecord(pr.headRepository)?.nameWithOwner),
    updatedAt: normaliseTimestamp(pr.updatedAt),
    checks: normaliseChecks(pr.commits),
    review:
      review === 'APPROVED'
        ? 'approved'
        : review === 'CHANGES_REQUESTED'
          ? 'changes_requested'
          : review === 'REVIEW_REQUIRED'
            ? 'review_required'
            : null,
    conflicts: mergeable === 'CONFLICTING' ? true : mergeable === 'MERGEABLE' ? false : null,
    comments: asNumber(pr.totalCommentsCount),
    createdAt: normaliseTimestamp(pr.createdAt),
    additions: asNumber(pr.additions),
    deletions: asNumber(pr.deletions),
    changedFiles: asNumber(pr.changedFiles),
    mergeState: state === 'OPEN' ? githubMergeState(pr.mergeStateStatus) : null,
  };
}

export interface GraphqlBatchResult {
  /** Requests per branch, in the order the branches were given. */
  byBranch: Map<string, ChangeRequest[]>;
  /** GraphQL error messages (the data may still be partial). */
  errors: string[];
  /** The repository was not found or not visible to the signed-in account. */
  notFound: boolean;
}

export function graphqlErrors(json: Record<string, unknown> | null): string[] {
  return asArray(json?.errors)
    .map((e) => asString(asRecord(e)?.message))
    .filter((m): m is string => m !== null);
}

/** Parses the `gh api graphql` response for `branches` (same order as the query variables). */
export function parseGithubResponse(
  json: Record<string, unknown> | null,
  branches: readonly string[],
): GraphqlBatchResult {
  const errors = graphqlErrors(json);
  const repository = asRecord(asRecord(json?.data)?.repository);
  const byBranch = new Map<string, ChangeRequest[]>();
  branches.forEach((branch, i) => {
    const nodes = asArray(asRecord(repository?.[`b${i}`])?.nodes);
    byBranch.set(
      branch,
      nodes.map(normaliseGithubPullRequest).filter((c): c is ChangeRequest => c !== null),
    );
  });
  const notFound =
    repository === null &&
    asArray(json?.errors).some((e) => asString(asRecord(e)?.type) === 'NOT_FOUND');
  return { byBranch, errors, notFound };
}
