import type { ChangeRequest, ChecksState } from '@octopus-diff/contracts';
import type { GraphqlBatchResult } from './github.js';
import { graphqlErrors } from './github.js';
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
 * GitLab merge requests for a batch of source branches, one GraphQL query per project
 * (`glab api graphql`): an aliased `mergeRequests(sourceBranches: [$bN])` connection per branch.
 * Field choices follow T3 Code's GitLab provider (MIT; ideas only). `full` asks for approval and
 * detailed merge status; `basic` drops the fields older self-managed GitLab versions lack and is
 * used when the full query reports unknown fields.
 */

export const GITLAB_MAX_BRANCHES_PER_QUERY = 20;
const PER_BRANCH = 5;

export type GitlabQueryVariant = 'full' | 'basic';

const BASIC_FIELDS = `iid title webUrl state draft updatedAt targetBranch sourceBranch diffHeadSha
  author { username } sourceProject { fullPath } targetProject { fullPath }
  userNotesCount headPipeline { status }`;
const FULL_FIELDS = `${BASIC_FIELDS} conflicts approved approvedBy(first: 1) { nodes { username } }
  detailedMergeStatus`;

export function buildGitlabQuery(count: number, variant: GitlabQueryVariant): string {
  if (!Number.isInteger(count) || count < 1 || count > GITLAB_MAX_BRANCHES_PER_QUERY) {
    throw new RangeError(`branch count out of range: ${count}`);
  }
  const vars = ['$fullPath: ID!'];
  const fields: string[] = [];
  for (let i = 0; i < count; i++) {
    vars.push(`$b${i}: String!`);
    fields.push(
      `b${i}: mergeRequests(sourceBranches: [$b${i}], first: ${PER_BRANCH}, sort: UPDATED_DESC) { nodes { ...mr } }`,
    );
  }
  const body = variant === 'full' ? FULL_FIELDS : BASIC_FIELDS;
  return `query OctopusDiffMergeRequests(${vars.join(', ')}) { project(fullPath: $fullPath) { ${fields.join(' ')} } } fragment mr on MergeRequest { ${body} }`;
}

function pipelineState(status: string | null): ChecksState | null {
  switch (status) {
    case null:
      return null;
    case 'SUCCESS':
      return 'success';
    case 'FAILED':
      return 'failure';
    case 'CANCELED':
    case 'CANCELING':
    case 'SKIPPED':
    case 'MANUAL':
      return 'neutral';
    default:
      // CREATED, WAITING_FOR_RESOURCE, PREPARING, PENDING, RUNNING, SCHEDULED, ...
      return 'pending';
  }
}

export function normaliseGitlabMergeRequest(raw: unknown): ChangeRequest | null {
  const mr = asRecord(raw);
  if (!mr) return null;
  const number = asNumber(mr.iid);
  const url = asString(mr.webUrl);
  const baseBranch = asString(mr.targetBranch);
  const headBranch = asString(mr.sourceBranch);
  if (number === null || number < 1 || !url?.startsWith('https://') || !baseBranch || !headBranch) {
    return null;
  }
  const state = asString(mr.state);
  const source = asString(asRecord(mr.sourceProject)?.fullPath);
  const target = asString(asRecord(mr.targetProject)?.fullPath);
  const pipeline = pipelineState(asString(asRecord(mr.headPipeline)?.status));
  const detailed = asString(mr.detailedMergeStatus);
  const approved = asBool(mr.approved);
  const approvers = asArray(asRecord(mr.approvedBy)?.nodes).length;
  // `approved` is also true when no approval is required, so it counts only with an approver.
  const review =
    detailed === 'REQUESTED_CHANGES'
      ? 'changes_requested'
      : approved === true && approvers > 0
        ? 'approved'
        : detailed === 'NOT_APPROVED'
          ? 'review_required'
          : null;
  return {
    kind: 'gitlab',
    number,
    title: asString(mr.title) ?? '',
    url,
    state: state === 'merged' ? 'merged' : state === 'opened' ? 'open' : 'closed',
    draft: asBool(mr.draft) ?? false,
    author: asString(asRecord(mr.author)?.username),
    baseBranch,
    headBranch,
    headSha: toSha(mr.diffHeadSha),
    // A deleted source fork reports no source project: treat it as another repository.
    crossRepository:
      source === null || target === null
        ? source === null
        : source.toLowerCase() !== target.toLowerCase(),
    headRepository: source,
    updatedAt: normaliseTimestamp(mr.updatedAt),
    checks:
      pipeline === null
        ? null
        : { state: pipeline, passed: null, failed: null, pending: null, total: null },
    review,
    conflicts: asBool(mr.conflicts) ?? (detailed === 'CONFLICT' ? true : null),
    comments: asNumber(mr.userNotesCount),
  };
}

/** True when GraphQL rejected fields that the basic variant avoids. */
export function isUnknownFieldError(errors: readonly string[]): boolean {
  return errors.some((e) =>
    /doesn't exist on type|Field '.+' doesn't exist|undefinedField/i.test(e),
  );
}

export function parseGitlabResponse(
  json: Record<string, unknown> | null,
  branches: readonly string[],
): GraphqlBatchResult {
  const errors = graphqlErrors(json);
  const project = asRecord(asRecord(json?.data)?.project);
  const byBranch = new Map<string, ChangeRequest[]>();
  branches.forEach((branch, i) => {
    const nodes = asArray(asRecord(project?.[`b${i}`])?.nodes);
    byBranch.set(
      branch,
      nodes.map(normaliseGitlabMergeRequest).filter((c): c is ChangeRequest => c !== null),
    );
  });
  // GitLab answers `project: null` without an error for missing or invisible projects.
  const notFound = json !== null && errors.length === 0 && project === null;
  return { byBranch, errors, notFound };
}
