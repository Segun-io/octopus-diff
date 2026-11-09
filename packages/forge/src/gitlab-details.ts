import {
  CHANGE_REQUEST_LIMITS,
  type ChangeRequestCheck,
  type ChangeRequestComment,
  type ChangeRequestCommit,
  type ChangeRequestConversation,
  type ChangeRequestDetail,
  type ChangeRequestFile,
  type ChangeRequestReviewer,
  type ChangeRequestThread,
  type ForgeRepositoryInfo,
  type ForgeRepositoryRequest,
  type ProjectForge,
} from '@octopus-diff/contracts';
import {
  capBytes,
  dedupeChecks,
  gitlabJobStatus,
  httpsUrl,
  labelColor,
  nodesOf,
  reviewerState,
  toActor,
  toComment,
} from './details.js';
import { type GitlabQueryVariant, normaliseGitlabMergeRequest } from './gitlab.js';
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
 * GitLab queries for the Request tab and the Overview, through `glab api graphql`. Variables:
 * `fullPath` (and `iid`, a `String!` on GitLab, so it can stay a `--raw-field`). Field names were
 * checked against gitlab.com's public GraphQL (2026-11-09). `basic` drops the fields older
 * self-managed versions lack; the client retries with it on "field doesn't exist". GitLab has no
 * review objects like GitHub's: the conversation is its discussions (diff notes become threads).
 */

const USER = 'username name avatarUrl bot';

export function buildGitlabRepositoryQuery(variant: GitlabQueryVariant): string {
  const L = CHANGE_REQUEST_LIMITS;
  const extra =
    variant === 'full' ? ' forkedFrom { fullPath } topics languages { name share }' : '';
  const pipeline = variant === 'full' ? ' pipelines(first: 1) { nodes { status } }' : '';
  return `query OctopusDiffProject($fullPath: ID!) { project(fullPath: $fullPath) { fullPath webUrl description visibility archived lastActivityAt openIssuesCount${extra} repository { rootRef tree { lastCommit { sha title committedDate${pipeline} } } } mergeRequests(state: opened, first: ${L.repositoryRequests}, sort: UPDATED_DESC) { count nodes { iid title webUrl state draft updatedAt targetBranch sourceBranch author { username } sourceProject { fullPath } targetProject { fullPath } headPipeline { status } approved approvedBy(first: 1) { nodes { username } } detailedMergeStatus } } } }`;
}

export function buildGitlabDetailQuery(variant: GitlabQueryVariant): string {
  const L = CHANGE_REQUEST_LIMITS;
  const full = variant === 'full';
  const reviewers = full
    ? ` reviewers(first: 20) { nodes { ${USER} mergeRequestInteraction { reviewState approved } } }`
    : ` reviewers(first: 20) { nodes { ${USER} } }`;
  const fields = full
    ? ' conflicts approved detailedMergeStatus diffStatsSummary { additions deletions fileCount } commitCount commits: commitsWithoutMergeCommits(first: 100) { nodes { sha title committedDate authorName author { username } } }'
    : ' conflicts commits(first: 100) { nodes { sha title committedDate authorName author { username } } }';
  return `query OctopusDiffMergeRequestDetail($fullPath: ID!, $iid: String!) { project(fullPath: $fullPath) { mergeRequest(iid: $iid) { iid title webUrl state draft description createdAt updatedAt mergedAt closedAt targetBranch sourceBranch diffHeadSha userNotesCount author { ${USER} } mergeUser { ${USER} } sourceProject { fullPath } targetProject { fullPath }${fields} labels(first: 20) { nodes { title color } } assignees(first: 10) { nodes { ${USER} } }${reviewers} approvedBy(first: 20) { nodes { ${USER} } } diffStats { path additions deletions } headPipeline { status stages { nodes { name jobs(first: ${L.checks}) { nodes { name status webPath detailedStatus { text } } } } } } } } }`;
}

export function buildGitlabConversationQuery(variant: GitlabQueryVariant): string {
  const L = CHANGE_REQUEST_LIMITS;
  const internal = variant === 'full' ? ' internal' : '';
  return `query OctopusDiffMergeRequestConversation($fullPath: ID!, $iid: String!) { project(fullPath: $fullPath) { mergeRequest(iid: $iid) { discussions(first: ${L.threads}) { pageInfo { hasNextPage } nodes { id resolvable resolved notes(first: ${L.threadComments}) { pageInfo { hasNextPage } nodes { id body createdAt lastEditedAt url system${internal} author { ${USER} } position { filePath newLine oldLine } } } } } } } }`;
}

function pipelineState(status: unknown) {
  switch (asString(status)?.toUpperCase()) {
    case undefined:
      return null;
    case 'SUCCESS':
      return 'success' as const;
    case 'FAILED':
      return 'failure' as const;
    case 'CANCELED':
    case 'CANCELING':
    case 'SKIPPED':
    case 'MANUAL':
      return 'neutral' as const;
    default:
      return 'pending' as const;
  }
}

function gitlabActor(raw: unknown, host: string) {
  return toActor(raw, host);
}

function toReviewers(mr: Record<string, unknown>, host: string): ChangeRequestReviewer[] {
  const out = new Map<string, ChangeRequestReviewer>();
  for (const raw of nodesOf(mr.reviewers)) {
    const actor = gitlabActor(raw, host);
    if (!actor) continue;
    const interaction = asRecord(asRecord(raw)?.mergeRequestInteraction);
    const state =
      asBool(interaction?.approved) === true
        ? 'approved'
        : (reviewerState(interaction?.reviewState) ?? 'pending');
    out.set(actor.login.toLowerCase(), { actor, state, stale: false });
  }
  for (const raw of nodesOf(mr.approvedBy)) {
    const actor = gitlabActor(raw, host);
    if (!actor) continue;
    out.set(actor.login.toLowerCase(), { actor, state: 'approved', stale: false });
  }
  return [...out.values()];
}

function toChecks(mr: Record<string, unknown>, host: string): ChangeRequestCheck[] {
  const checks: ChangeRequestCheck[] = [];
  for (const stage of nodesOf(asRecord(mr.headPipeline)?.stages)) {
    const group = asString(asRecord(stage)?.name)?.slice(0, 512) ?? null;
    for (const job of nodesOf(asRecord(stage)?.jobs)) {
      const record = asRecord(job);
      const name = asString(record?.name);
      if (!record || name === null) continue;
      checks.push({
        name: name.slice(0, 512),
        group,
        status: gitlabJobStatus(record.status),
        description: asString(asRecord(record.detailedStatus)?.text)?.slice(0, 2048) ?? null,
        url: httpsUrl(record.webPath, host),
      });
    }
  }
  return dedupeChecks(checks);
}

/** `mergeRequest` of the detail query -> `ChangeRequestDetail`; null when unusable. */
export function normaliseGitlabDetail(raw: unknown, host: string): ChangeRequestDetail | null {
  const mr = asRecord(raw);
  if (!mr) return null;
  const base = normaliseGitlabMergeRequest(mr);
  if (!base) return null;
  const body = capBytes(
    typeof mr.description === 'string' ? mr.description : '',
    CHANGE_REQUEST_LIMITS.bodyBytes,
  );
  const checkList = toChecks(mr, host);
  // GitLab lists commits newest first; the contract wants the newest N, oldest first.
  const commits = nodesOf(mr.commits)
    .map((n): ChangeRequestCommit | null => {
      const commit = asRecord(n);
      const sha = toSha(commit?.sha);
      if (!commit || sha === null) return null;
      return {
        sha,
        headline: asString(commit.title) ?? '',
        committedAt: normaliseTimestamp(commit.committedDate),
        authorName: asString(commit.authorName),
        authorLogin: asString(asRecord(commit.author)?.username),
      };
    })
    .filter((c): c is ChangeRequestCommit => c !== null)
    .reverse();
  const stats = asArray(mr.diffStats);
  const files = stats
    .slice(0, CHANGE_REQUEST_LIMITS.files)
    .map((n): ChangeRequestFile | null => {
      const file = asRecord(n);
      const path = asString(file?.path);
      if (!file || path === null || path.length > 4096) return null;
      return {
        path,
        additions: asNumber(file.additions) ?? 0,
        deletions: asNumber(file.deletions) ?? 0,
        change: 'changed',
      };
    })
    .filter((f): f is ChangeRequestFile => f !== null);
  const pipeline = asRecord(mr.headPipeline);
  const jobsTruncated = nodesOf(pipeline?.stages).some(
    (s) => nodesOf(asRecord(s)?.jobs).length >= CHANGE_REQUEST_LIMITS.checks,
  );
  return {
    ...base,
    body: body.text,
    bodyTruncated: body.truncated,
    mergedAt: normaliseTimestamp(mr.mergedAt),
    closedAt: normaliseTimestamp(mr.closedAt),
    mergedBy: gitlabActor(mr.mergeUser, host),
    authorActor: gitlabActor(mr.author, host),
    labels: nodesOf(mr.labels).flatMap((n) => {
      const label = asRecord(n);
      const name = asString(label?.title);
      return name === null ? [] : [{ name: name.slice(0, 256), color: labelColor(label?.color) }];
    }),
    assignees: nodesOf(mr.assignees)
      .map((n) => gitlabActor(n, host))
      .filter((a) => a !== null),
    reviewers: toReviewers(mr, host),
    checkList: checkList.slice(0, CHANGE_REQUEST_LIMITS.checks),
    checksTruncated: jobsTruncated || checkList.length > CHANGE_REQUEST_LIMITS.checks,
    commits,
    commitsTotal: asNumber(mr.commitCount) ?? commits.length,
    files,
    filesTotal: base.changedFiles ?? stats.length,
  };
}

/**
 * `mergeRequest` of the conversation query -> `ChangeRequestConversation`. System notes ("added
 * 1 commit", "approved this merge request") are dropped; a discussion on a diff position becomes
 * a thread, any other discussion contributes its notes as top-level comments.
 */
export function normaliseGitlabConversation(
  raw: unknown,
  host: string,
): ChangeRequestConversation | null {
  const mr = asRecord(raw);
  if (!mr) return null;
  const discussions = asRecord(mr.discussions);
  let truncated = asBool(asRecord(discussions?.pageInfo)?.hasNextPage) === true;
  const comments: ChangeRequestComment[] = [];
  const threads: ChangeRequestThread[] = [];
  for (const node of nodesOf(discussions)) {
    const discussion = asRecord(node);
    const id = asString(discussion?.id);
    if (!discussion || id === null) continue;
    const notesConnection = asRecord(discussion.notes);
    const notes = nodesOf(notesConnection).filter((n) => asBool(asRecord(n)?.system) !== true);
    if (notes.length === 0) continue;
    const more = asBool(asRecord(notesConnection?.pageInfo)?.hasNextPage) === true;
    const list = notes.map((n) => toComment(n, host)).filter((c) => c !== null);
    const position = asRecord(asRecord(notes[0])?.position);
    const path = asString(position?.filePath);
    if (path !== null) {
      if (more) truncated = true;
      const newLine = asNumber(position?.newLine);
      threads.push({
        id: id.slice(0, 256),
        path: path.slice(0, 4096),
        line: newLine ?? asNumber(position?.oldLine),
        side: newLine === null && asNumber(position?.oldLine) !== null ? 'left' : 'right',
        resolved: asBool(discussion.resolved) ?? false,
        outdated: false,
        comments: list,
        commentsTotal: list.length + (more ? 1 : 0),
      });
    } else {
      if (more) truncated = true;
      comments.push(...list);
    }
  }
  return {
    comments,
    reviews: [],
    threads,
    commentsTotal: comments.length,
    reviewsTotal: 0,
    threadsTotal: threads.length,
    truncated,
  };
}

/** `project` of the repository query -> `ForgeRepositoryInfo` (worktree ids unset). */
export function normaliseGitlabRepository(
  raw: unknown,
  forge: Pick<ProjectForge, 'kind' | 'host' | 'repository' | 'webUrl'>,
): ForgeRepositoryInfo | null {
  const project = asRecord(raw);
  if (!project) return null;
  const repository = asRecord(project.repository);
  const last = asRecord(asRecord(repository?.tree)?.lastCommit);
  const sha = toSha(last?.sha);
  const mergeRequests = asRecord(project.mergeRequests);
  const requests = nodesOf(mergeRequests).flatMap((n): ForgeRepositoryRequest[] => {
    const cr = normaliseGitlabMergeRequest(n);
    if (!cr || cr.state !== 'open') return [];
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
        checks: cr.checks?.state ?? null,
        review: cr.review,
        worktreeId: null,
      },
    ];
  });
  const openRequests = asNumber(mergeRequests?.count);
  const visibility = asString(project.visibility)?.toLowerCase();
  const languages = asArray(project.languages)
    .map((l) => asString(asRecord(l)?.name))
    .filter((l): l is string => l !== null);
  return {
    kind: 'gitlab',
    host: forge.host,
    repository: forge.repository,
    webUrl: httpsUrl(project.webUrl) ?? forge.webUrl,
    description: asString(project.description)?.slice(0, 4096) ?? null,
    visibility:
      visibility === 'public' || visibility === 'private' || visibility === 'internal'
        ? visibility
        : null,
    archived: asBool(project.archived) ?? false,
    forkOf: asString(asRecord(project.forkedFrom)?.fullPath)?.slice(0, 1024) ?? null,
    defaultBranch: asString(repository?.rootRef),
    defaultBranchHead:
      sha === null
        ? null
        : {
            sha,
            headline: asString(last?.title) ?? '',
            committedAt: normaliseTimestamp(last?.committedDate),
            checks: pipelineState(asRecord(nodesOf(last?.pipelines)[0])?.status),
          },
    license: null,
    language: languages[0]?.slice(0, 256) ?? null,
    topics: asArray(project.topics)
      .map((t) => asString(t))
      .filter((t): t is string => t !== null)
      .slice(0, CHANGE_REQUEST_LIMITS.topics)
      .map((t) => t.slice(0, 256)),
    pushedAt: normaliseTimestamp(project.lastActivityAt),
    openRequests,
    openIssues: asNumber(project.openIssuesCount),
    requests: requests.slice(0, CHANGE_REQUEST_LIMITS.repositoryRequests),
    requestsTruncated: openRequests !== null && openRequests > requests.length,
  };
}
