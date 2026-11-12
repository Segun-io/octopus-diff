import { CHANGE_REQUEST_LIMITS, type ForgeKind } from '@octopus-diff/contracts';
import { GITHUB_MAX_BRANCHES_PER_QUERY, GITHUB_REQUESTS_PER_BRANCH } from './github.js';
import { GITLAB_MAX_BRANCHES_PER_QUERY } from './gitlab.js';

/**
 * What a forge query costs against the rate limit, computed from the query shape (docs/FORGES.md
 * "Rate limits", DECISIONS #197). This is arithmetic, not a measurement: every GitHub response
 * also reports the real `rateLimit.cost`, which the client hands to `onCost`.
 *
 * GitHub's rule (docs.github.com, "Rate limits and query limits for the GraphQL API"): count the
 * requests needed to fulfil every connection in the query, assuming each parent node returns its
 * full `first`/`last` page (one request per parent node for a nested connection), divide by 100,
 * round to the nearest whole number, minimum 1. The primary limit is 5 000 points per hour per
 * user, shared by every tool that uses the same sign-in. GitLab has no points: a request is one
 * unit, and the limits that exist (gitlab.com: a per-user request rate) are far above ours.
 */

export type ForgeQueryKind = 'batch' | 'repository' | 'detail' | 'conversation';

/** GitHub's rule: requests / 100, rounded to nearest, at least 1. */
export function githubPointsForRequests(requests: number): number {
  return Math.max(1, Math.round(requests / 100));
}

/**
 * Connections of the batch query for `branches` head branches: one `pullRequests` connection per
 * branch (the repository is one node), `commits(last: 1)` under each of the up to 5 requests and
 * `contexts(first: 1)` under each of those commits.
 */
export function githubBatchRequests(branches: number): number {
  const requestsPerBranch = GITHUB_REQUESTS_PER_BRANCH;
  return branches * (1 + requestsPerBranch + requestsPerBranch);
}

/** Connections of the other three GitHub queries (each one request per parent node). */
export const GITHUB_SINGLE_QUERY_REQUESTS = {
  // labels, assignees, reviewRequests, latestOpinionatedReviews, commits, files, head commits,
  // and the head commit's check contexts.
  detail: 8,
  // comments, reviews, reviewThreads, and the comments(first: n) under each of up to `threads`.
  conversation: 3 + CHANGE_REQUEST_LIMITS.threads,
  // topics, open count, issue count, recent requests, and commits(last: 1) under each request.
  repository: 4 + CHANGE_REQUEST_LIMITS.repositoryRequests,
} as const;

/** Points one GraphQL query of `kind` costs; for `batch`, `count` is the number of head branches. */
export function estimateQueryPoints(forge: ForgeKind, kind: ForgeQueryKind, count = 1): number {
  if (forge === 'gitlab') {
    return kind === 'batch' ? Math.max(1, Math.ceil(count / GITLAB_MAX_BRANCHES_PER_QUERY)) : 1;
  }
  if (kind !== 'batch') return githubPointsForRequests(GITHUB_SINGLE_QUERY_REQUESTS[kind]);
  // More than 20 branches are asked in chunks of 20; each chunk is its own query.
  let points = 0;
  for (let left = Math.max(1, count); left > 0; left -= GITHUB_MAX_BRANCHES_PER_QUERY) {
    points += githubPointsForRequests(
      githubBatchRequests(Math.min(left, GITHUB_MAX_BRANCHES_PER_QUERY)),
    );
  }
  return points;
}
