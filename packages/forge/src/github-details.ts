import {
  CHANGE_REQUEST_LIMITS,
  type ChangeRequestCheck,
  type ChangeRequestCommit,
  type ChangeRequestConversation,
  type ChangeRequestDetail,
  type ChangeRequestFile,
  type ChangeRequestFileChange,
  type ChangeRequestReviewEntry,
  type ChangeRequestReviewer,
  type ChangeRequestThread,
  type ForgeRepositoryInfo,
  type ForgeRepositoryRequest,
  type ProjectForge,
} from '@octopus-diff/contracts';
import {
  capBytes,
  dedupeChecks,
  githubCheckStatus,
  httpsUrl,
  labelColor,
  nodesOf,
  reviewerState,
  toActor,
  toComment,
} from './details.js';
import { type GithubQueryVariant, normaliseGithubPullRequest } from './github.js';
import { asBool, asNumber, asRecord, asString, normaliseTimestamp, toSha } from './json.js';

/**
 * GitHub queries for the Request tab and the Overview (docs/FORGES.md "Fetching"): one query each
 * for a pull request's detail, its conversation, and a repository. Each costs 1 rate-limit point
 * (measured; every query asks for `rateLimit { cost remaining resetAt }`). `gh api graphql` cannot pass
 * an `Int!` variable without `-F` (which reads files and is banned), so the PR number is inlined:
 * the builders take a validated safe integer, and the allowlist extracts it from the query text,
 * rebuilds the query and compares byte for byte.
 */

const ACTOR = `__typename login avatarUrl ... on User { name }`;

function checkNumber(number: number): number {
  if (!Number.isSafeInteger(number) || number < 1)
    throw new RangeError(`invalid number: ${number}`);
  return number;
}

export function buildGithubRepositoryQuery(): string {
  return `query OctopusDiffRepository($owner: String!, $name: String!) { rateLimit { cost remaining resetAt } repository(owner: $owner, name: $name) { nameWithOwner url description visibility isArchived parent { nameWithOwner } licenseInfo { spdxId name } primaryLanguage { name } repositoryTopics(first: ${CHANGE_REQUEST_LIMITS.topics}) { nodes { topic { name } } } pushedAt defaultBranchRef { name target { ... on Commit { oid messageHeadline committedDate statusCheckRollup { state } } } } openRequests: pullRequests(states: OPEN) { totalCount } openIssues: issues(states: OPEN) { totalCount } recent: pullRequests(states: OPEN, first: ${CHANGE_REQUEST_LIMITS.repositoryRequests}, orderBy: {field: UPDATED_AT, direction: DESC}) { nodes { number title url state isDraft updatedAt baseRefName headRefName isCrossRepository headRepository { nameWithOwner } author { login } reviewDecision commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } } }`;
}

export function buildGithubDetailQuery(number: number, variant: GithubQueryVariant): string {
  const n = checkNumber(number);
  const mergeState = variant === 'full' ? ' mergeStateStatus' : '';
  const opinions =
    variant === 'full'
      ? ` latestOpinionatedReviews(first: 20) { nodes { state author { ...actor } commit { oid } } }`
      : '';
  return `query OctopusDiffPullRequestDetail($owner: String!, $name: String!) { rateLimit { cost remaining resetAt } repository(owner: $owner, name: $name) { pullRequest(number: ${n}) { number title url state isDraft body createdAt updatedAt mergedAt closedAt baseRefName headRefName headRefOid isCrossRepository headRepository { nameWithOwner } mergeable${mergeState} reviewDecision additions deletions changedFiles totalCommentsCount author { ...actor } mergedBy { ...actor } labels(first: 20) { nodes { name color } } assignees(first: 10) { nodes { ${ACTOR} } } reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login name avatarUrl } ... on Bot { login avatarUrl } ... on Mannequin { login avatarUrl } ... on Team { slug name } } } }${opinions} commits(last: ${CHANGE_REQUEST_LIMITS.commits}) { totalCount nodes { commit { oid messageHeadline committedDate author { name user { login } } } } } files(first: ${CHANGE_REQUEST_LIMITS.files}) { totalCount nodes { path additions deletions changeType } } head: commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: ${CHANGE_REQUEST_LIMITS.checks}) { totalCount checkRunCountsByState { state count } statusContextCountsByState { state count } nodes { __typename ... on CheckRun { name status conclusion detailsUrl title checkSuite { workflowRun { workflow { name } } } } ... on StatusContext { context state description targetUrl } } } } } } } } } } fragment actor on Actor { ${ACTOR} }`;
}

export function buildGithubConversationQuery(number: number): string {
  const n = checkNumber(number);
  const L = CHANGE_REQUEST_LIMITS;
  const remark = `id body createdAt lastEditedAt url isMinimized author { ...actor }`;
  return `query OctopusDiffPullRequestConversation($owner: String!, $name: String!) { rateLimit { cost remaining resetAt } repository(owner: $owner, name: $name) { pullRequest(number: ${n}) { comments(last: ${L.comments}) { totalCount nodes { ${remark} } } reviews(last: ${L.reviews}) { totalCount nodes { ${remark} state submittedAt } } reviewThreads(last: ${L.threads}) { totalCount nodes { id path line originalLine diffSide isResolved isOutdated comments(first: ${L.threadComments}) { totalCount nodes { ${remark} } } } } } } } fragment actor on Actor { ${ACTOR} }`;
}

/** The PR number inlined in a detail or conversation query, for the allowlist; null if none. */
export function githubQueryNumber(query: string): number | null {
  const match = /\bpullRequest\(number: (\d{1,15})\)/.exec(query);
  const n = match ? Number(match[1]) : Number.NaN;
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
}

const FILE_CHANGE: Record<string, ChangeRequestFileChange> = {
  ADDED: 'added',
  MODIFIED: 'modified',
  DELETED: 'removed',
  RENAMED: 'renamed',
  COPIED: 'copied',
  CHANGED: 'changed',
};

function toCheck(raw: unknown): ChangeRequestCheck | null {
  const node = asRecord(raw);
  if (!node) return null;
  const name = asString(node.name) ?? asString(node.context);
  if (name === null) return null;
  const isRun = asString(node.__typename) === 'CheckRun' || node.conclusion !== undefined;
  const workflow = asString(
    asRecord(asRecord(asRecord(node.checkSuite)?.workflowRun)?.workflow)?.name,
  );
  return {
    name: name.slice(0, 512),
    group: workflow?.slice(0, 512) ?? null,
    status: isRun
      ? githubCheckStatus(node.status, node.conclusion)
      : githubCheckStatus(undefined, node.state),
    description: (asString(node.title) ?? asString(node.description))?.slice(0, 2048) ?? null,
    url: httpsUrl(node.detailsUrl) ?? httpsUrl(node.targetUrl),
  };
}

function toReviewers(pr: Record<string, unknown>, headSha: string | null): ChangeRequestReviewer[] {
  const out = new Map<string, ChangeRequestReviewer>();
  const opinions = nodesOf(pr.latestOpinionatedReviews);
  for (const raw of opinions) {
    const node = asRecord(raw);
    const actor = toActor(node?.author);
    const state = reviewerState(node?.state);
    if (!actor || state === null || state === 'pending') continue;
    const commit = toSha(asRecord(node?.commit)?.oid);
    const verdict = state === 'approved' || state === 'changes_requested';
    out.set(actor.login.toLowerCase(), {
      actor,
      state,
      stale: verdict && headSha !== null && commit !== null && commit !== headSha,
    });
  }
  // A (re-)requested reviewer is waiting for a review, whatever they said before.
  for (const raw of nodesOf(pr.reviewRequests)) {
    const actor = toActor(asRecord(raw)?.requestedReviewer);
    if (!actor) continue;
    out.set(actor.login.toLowerCase(), { actor, state: 'pending', stale: false });
  }
  return [...out.values()];
}

/** `pullRequest` of the detail query -> `ChangeRequestDetail`; null when unusable. */
export function normaliseGithubDetail(raw: unknown): ChangeRequestDetail | null {
  const pr = asRecord(raw);
  if (!pr) return null;
  const base = normaliseGithubPullRequest({ ...pr, commits: pr.head });
  if (!base) return null;
  const body = capBytes(
    typeof pr.body === 'string' ? pr.body : '',
    CHANGE_REQUEST_LIMITS.bodyBytes,
  );
  const rollup = asRecord(asRecord(asRecord(nodesOf(pr.head)[0])?.commit)?.statusCheckRollup);
  const contexts = asRecord(rollup?.contexts);
  const checkList = dedupeChecks(
    nodesOf(contexts)
      .map(toCheck)
      .filter((c): c is ChangeRequestCheck => c !== null),
  );
  const contextTotal = asNumber(contexts?.totalCount) ?? 0;
  const commits = nodesOf(pr.commits)
    .map((n): ChangeRequestCommit | null => {
      const commit = asRecord(asRecord(n)?.commit);
      const sha = toSha(commit?.oid);
      if (!commit || sha === null) return null;
      const author = asRecord(commit.author);
      return {
        sha,
        headline: asString(commit.messageHeadline) ?? '',
        committedAt: normaliseTimestamp(commit.committedDate),
        authorName: asString(author?.name),
        authorLogin: asString(asRecord(author?.user)?.login),
      };
    })
    .filter((c): c is ChangeRequestCommit => c !== null);
  const files = nodesOf(pr.files)
    .map((n): ChangeRequestFile | null => {
      const file = asRecord(n);
      const path = asString(file?.path);
      if (!file || path === null || path.length > 4096) return null;
      return {
        path,
        additions: asNumber(file.additions) ?? 0,
        deletions: asNumber(file.deletions) ?? 0,
        change: FILE_CHANGE[asString(file.changeType) ?? ''] ?? 'changed',
      };
    })
    .filter((f): f is ChangeRequestFile => f !== null);
  return {
    ...base,
    body: body.text,
    bodyTruncated: body.truncated,
    mergedAt: normaliseTimestamp(pr.mergedAt),
    closedAt: normaliseTimestamp(pr.closedAt),
    mergedBy: toActor(pr.mergedBy),
    authorActor: toActor(pr.author),
    labels: nodesOf(pr.labels).flatMap((n) => {
      const label = asRecord(n);
      const name = asString(label?.name);
      return name === null ? [] : [{ name: name.slice(0, 256), color: labelColor(label?.color) }];
    }),
    assignees: nodesOf(pr.assignees)
      .map((n) => toActor(n))
      .filter((a) => a !== null),
    reviewers: toReviewers(pr, base.headSha),
    checkList,
    checksTruncated: contextTotal > nodesOf(contexts).length,
    commits,
    commitsTotal: asNumber(asRecord(pr.commits)?.totalCount) ?? commits.length,
    files,
    filesTotal: asNumber(asRecord(pr.files)?.totalCount) ?? files.length,
  };
}

function remarks(connection: unknown): { visible: unknown[]; total: number; hidden: number } {
  const nodes = nodesOf(connection);
  const visible = nodes.filter((n) => asBool(asRecord(n)?.isMinimized) !== true);
  return {
    visible,
    total: asNumber(asRecord(connection)?.totalCount) ?? nodes.length,
    hidden: nodes.length - visible.length,
  };
}

/**
 * `pullRequest` of the conversation query -> `ChangeRequestConversation`. Minimised (hidden)
 * comments are dropped, as github.com collapses them (T3 Code's `toComments`); bodiless
 * COMMENTED reviews only carry line comments, which arrive through the threads.
 */
export function normaliseGithubConversation(raw: unknown): ChangeRequestConversation | null {
  const pr = asRecord(raw);
  if (!pr) return null;
  const comments = remarks(pr.comments);
  const reviews = remarks(pr.reviews);
  const threadNodes = nodesOf(pr.reviewThreads);
  const threadsTotal = asNumber(asRecord(pr.reviewThreads)?.totalCount) ?? threadNodes.length;
  let truncated =
    comments.total > nodesOf(pr.comments).length ||
    reviews.total > nodesOf(pr.reviews).length ||
    threadsTotal > threadNodes.length;
  const reviewEntries: ChangeRequestReviewEntry[] = [];
  for (const node of reviews.visible) {
    const record = asRecord(node);
    const state = reviewerState(record?.state);
    const comment = toComment(node);
    if (!comment || state === null || state === 'pending') continue;
    if (state === 'commented' && comment.body.trim() === '') continue;
    reviewEntries.push({ ...comment, state });
  }
  const threads: ChangeRequestThread[] = [];
  for (const node of threadNodes) {
    const thread = asRecord(node);
    const id = asString(thread?.id);
    if (!thread || id === null) continue;
    const inner = remarks(thread.comments);
    if (inner.total > nodesOf(thread.comments).length) truncated = true;
    const list = inner.visible.map((n) => toComment(n)).filter((c) => c !== null);
    if (list.length === 0) continue;
    threads.push({
      id: id.slice(0, 256),
      path: (asString(thread.path) ?? '').slice(0, 4096),
      line: asNumber(thread.line) ?? asNumber(thread.originalLine),
      side: asString(thread.diffSide) === 'LEFT' ? 'left' : 'right',
      resolved: asBool(thread.isResolved) ?? false,
      outdated: asBool(thread.isOutdated) ?? false,
      comments: list,
      commentsTotal: inner.total,
    });
  }
  return {
    comments: comments.visible.map((n) => toComment(n)).filter((c) => c !== null),
    reviews: reviewEntries,
    threads,
    commentsTotal: comments.total,
    reviewsTotal: reviews.total,
    threadsTotal,
    truncated,
  };
}

function rollup(value: unknown) {
  switch (asString(value)) {
    case 'SUCCESS':
      return 'success' as const;
    case 'FAILURE':
    case 'ERROR':
      return 'failure' as const;
    case 'PENDING':
    case 'EXPECTED':
      return 'pending' as const;
    case null:
      return null;
    default:
      return 'neutral' as const;
  }
}

/** `repository` of the repository query -> `ForgeRepositoryInfo` (worktree ids unset). */
export function normaliseGithubRepository(
  raw: unknown,
  forge: Pick<ProjectForge, 'kind' | 'host' | 'repository' | 'webUrl'>,
): ForgeRepositoryInfo | null {
  const repo = asRecord(raw);
  if (!repo) return null;
  const license = asRecord(repo.licenseInfo);
  const spdx = asString(license?.spdxId);
  const ref = asRecord(repo.defaultBranchRef);
  const target = asRecord(ref?.target);
  const headSha = toSha(target?.oid);
  const requests = nodesOf(asRecord(repo.recent)).flatMap((n): ForgeRepositoryRequest[] => {
    const cr = normaliseGithubPullRequest(n);
    if (cr?.state !== 'open') return [];
    const head = asRecord(asRecord(nodesOf(asRecord(n)?.commits)[0])?.commit);
    return [
      {
        number: cr.number,
        title: cr.title,
        url: cr.url,
        draft: cr.draft,
        author: cr.author,
        headBranch: cr.headBranch,
        baseBranch: cr.baseBranch,
        crossRepository: cr.crossRepository,
        updatedAt: cr.updatedAt,
        checks: rollup(asRecord(head?.statusCheckRollup)?.state),
        review: cr.review,
        worktreeId: null,
      },
    ];
  });
  const openRequests = asNumber(asRecord(repo.openRequests)?.totalCount);
  const visibility = asString(repo.visibility)?.toLowerCase();
  return {
    kind: 'github',
    host: forge.host,
    repository: forge.repository,
    webUrl: httpsUrl(repo.url) ?? forge.webUrl,
    description: asString(repo.description)?.slice(0, 4096) ?? null,
    visibility:
      visibility === 'public' || visibility === 'private' || visibility === 'internal'
        ? visibility
        : null,
    archived: asBool(repo.isArchived) ?? false,
    forkOf: asString(asRecord(repo.parent)?.nameWithOwner)?.slice(0, 1024) ?? null,
    defaultBranch: asString(ref?.name),
    defaultBranchHead:
      headSha === null
        ? null
        : {
            sha: headSha,
            headline: asString(target?.messageHeadline) ?? '',
            committedAt: normaliseTimestamp(target?.committedDate),
            checks: rollup(asRecord(target?.statusCheckRollup)?.state),
          },
    license:
      (spdx && spdx !== 'NOASSERTION' ? spdx : asString(license?.name))?.slice(0, 256) ?? null,
    language: asString(asRecord(repo.primaryLanguage)?.name)?.slice(0, 256) ?? null,
    topics: nodesOf(repo.repositoryTopics)
      .map((n) => asString(asRecord(asRecord(n)?.topic)?.name))
      .filter((t): t is string => t !== null)
      .slice(0, CHANGE_REQUEST_LIMITS.topics)
      .map((t) => t.slice(0, 256)),
    pushedAt: normaliseTimestamp(repo.pushedAt),
    openRequests,
    openIssues: asNumber(asRecord(repo.openIssues)?.totalCount),
    requests: requests.slice(0, CHANGE_REQUEST_LIMITS.repositoryRequests),
    requestsTruncated: openRequests !== null && openRequests > requests.length,
  };
}
