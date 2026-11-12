import {
  changeRequestNoun,
  type ForgeRepositoryInfo,
  type GitBranchInfo,
  type GitRepositoryInfo,
  type ProjectForge,
  TEST_IDS,
} from '@octopus-diff/contracts';
import type { ReactNode } from 'react';
import {
  type RepositoryEntry,
  useForgeIndex,
  useForgesQuery,
  useRefreshRepositoryForge,
  useRepositoryForge,
} from '../api/forges.ts';
import { useForgeWaitSource, useHostBudget } from '../api/wait.ts';
import { CHECKS_STATE_WORD, projectStatusLine, REVIEW_WORD, remoteLabel } from '../lib/forge.ts';
import { absoluteTime, relativeTime } from '../lib/time.ts';
import { hasSuspicious } from '../lib/unicode.ts';
import { describeStale, LOCAL_WAIT } from '../lib/wait.ts';
import { actions, useUiStore } from '../state/ui.tsx';
import { ChangeRequestGlyph } from './ChangeRequest.tsx';
import { CopyButton } from './CopyButton.tsx';
import { PAGE_SIZE, Pager, usePage } from './Pager.tsx';
import { SkeletonLines, StaleNote, WaitNote } from './WaitNote.tsx';

/**
 * Repository information on the project Overview (docs/FORGES.md "Repository information"):
 * local git facts (always; no forge needed) and, when the project has a forge and its CLI is
 * signed in, the forge's facts and open requests. Key/value rows like the Overview's `Stat`
 * pattern; tokens only.
 */

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <dt className="w-28 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1">{children}</dd>
    </div>
  );
}

function External({ href, children }: { href: string; children: ReactNode }) {
  if (!href.startsWith('https://')) return <>{children}</>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="hover:underline">
      {children} <span className="text-faint">↗</span>
    </a>
  );
}

const CI_DOT: Record<string, string> = {
  success: 'bg-add',
  failure: 'bg-danger',
  pending: 'bg-warn',
};

export function CiDot({ state }: { state: string | null | undefined }) {
  const tone = state ? CI_DOT[state] : undefined;
  if (!tone) return null;
  return (
    <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${tone}`} />
  );
}

/** Local facts: remotes, default branch and its sync, last commit, counts, last activity. */
export function LocalRepositoryFacts({
  entry,
  forge,
  worktrees,
}: {
  entry: RepositoryEntry | undefined;
  forge: ProjectForge | null;
  worktrees: number;
}) {
  const info: GitRepositoryInfo | null = entry?.info ?? null;
  return (
    <section data-testid={TEST_IDS.repoInfoLocal} className="min-w-0">
      <h2 className="mb-1.5 text-[11px] font-medium text-muted uppercase">Local</h2>
      {!entry ? (
        <div aria-busy="true">
          <SkeletonLines widths={[70, 50, 60, 40]} />
          <WaitNote active source={LOCAL_WAIT} />
        </div>
      ) : !info ? (
        <p className="text-xs text-danger">{entry.error ?? 'Could not read the repository.'}</p>
      ) : (
        <dl className="flex flex-col gap-1 text-xs">
          <Row label="Remotes">
            {info.remotes.length === 0 ? (
              <span className="text-faint">none</span>
            ) : (
              <ul className="flex flex-col">
                {info.remotes.map((r) => {
                  const label = r.url ? remoteLabel(r.url) : null;
                  const isForge =
                    forge !== null &&
                    label !== null &&
                    label === `${forge.host}/${forge.repository}`;
                  return (
                    <li key={r.name} className="truncate font-mono text-[11px]" title={r.url ?? ''}>
                      <span className="text-muted">{r.name}</span>{' '}
                      {isForge && forge ? (
                        <External href={forge.webUrl}>{label}</External>
                      ) : (
                        (label ?? r.url ?? 'no URL')
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Row>
          <Row label="Default branch">
            {info.defaultBranch ? (
              <span className="font-mono">
                {info.defaultBranch.name}
                {info.defaultBranch.upstream && (
                  <span
                    className="ml-2 text-muted"
                    title={`Against ${info.defaultBranch.upstream}, as of the last fetch; octopus-diff never fetches`}
                  >
                    {info.defaultBranch.ahead !== null && info.defaultBranch.behind !== null
                      ? `↑${info.defaultBranch.ahead} ↓${info.defaultBranch.behind}`
                      : 'upstream gone'}{' '}
                    vs {info.defaultBranch.upstream}
                  </span>
                )}
              </span>
            ) : (
              <span className="text-faint">none (no commits yet)</span>
            )}
          </Row>
          {info.defaultBranch?.head && (
            <Row label="Last commit">
              <span className="flex min-w-0 gap-1.5">
                <span className="shrink-0 font-mono text-muted">
                  {info.defaultBranch.head.sha.slice(0, 7)}
                </span>
                <span className="truncate">{info.defaultBranch.head.subject}</span>
                <span
                  className="shrink-0 text-muted"
                  title={absoluteTime(info.defaultBranch.head.authorDate)}
                >
                  {info.defaultBranch.head.authorName} ·{' '}
                  {relativeTime(info.defaultBranch.head.authorDate)}
                </span>
              </span>
            </Row>
          )}
          <Row label="Refs">
            <span className="tabular-nums">
              {info.localBranches} {info.localBranches === 1 ? 'branch' : 'branches'} · {info.tags}{' '}
              {info.tags === 1 ? 'tag' : 'tags'} · {worktrees}{' '}
              {worktrees === 1 ? 'worktree' : 'worktrees'}
            </span>
          </Row>
          <Row label="Last activity">
            <span title={absoluteTime(info.lastActivityAt)}>
              {info.lastActivityAt ? relativeTime(info.lastActivityAt) : 'unknown'}
            </span>
          </Row>
        </dl>
      )}
    </section>
  );
}

function listUrls(info: ForgeRepositoryInfo): { requests: string; issues: string } {
  return info.kind === 'github'
    ? { requests: `${info.webUrl}/pulls`, issues: `${info.webUrl}/issues` }
    : { requests: `${info.webUrl}/-/merge_requests`, issues: `${info.webUrl}/-/issues` };
}

/** Forge facts (project Overview only: one query per project, cached by the daemon). */
export function ForgeRepositoryFacts({ projectId }: { projectId: string }) {
  const query = useRepositoryForge(projectId);
  const refresh = useRefreshRepositoryForge(projectId);
  const forges = useForgesQuery().data;
  const state = forges?.projects.find((p) => p.projectId === projectId);
  const kind = state?.forge?.kind ?? query.data?.forge?.kind ?? 'github';
  const waitSource = useForgeWaitSource(kind, state?.forge?.host ?? query.data?.forge?.host);
  const budget = useHostBudget(state?.forge?.host ?? query.data?.forge?.host, kind);
  const data = query.data;
  if (!data) {
    if (query.isError) {
      return (
        <section data-testid={TEST_IDS.repoInfoForge} data-status="error" className="text-xs">
          <p className="text-danger">Could not load forge facts.</p>
        </section>
      );
    }
    // The project is known to have a forge: hold its place with a skeleton so the facts do not
    // push the lists down when they arrive; the message comes after the threshold (#11).
    const hasForge =
      !!state?.forge &&
      state.status !== 'disabled' &&
      state.status !== 'no-forge' &&
      state.status !== 'ignored';
    if (!hasForge) return null;
    return (
      <section data-testid={TEST_IDS.repoInfoForge} data-status="loading" className="min-w-0">
        <h2 className="mb-1.5 text-[11px] font-medium text-muted uppercase">Forge</h2>
        <div aria-busy="true">
          <SkeletonLines widths={[65, 45, 55, 35]} />
          <WaitNote active source={waitSource} />
        </div>
      </section>
    );
  }
  if (data.status === 'no-forge' || data.status === 'disabled' || data.status === 'ignored') {
    return null;
  }
  const info = data.repository;
  const noun = data.forge ? changeRequestNoun(data.forge.kind) : null;
  const stale = info
    ? describeStale({
        forge: data.forge?.kind ?? null,
        fetchedAt: data.fetchedAt,
        message: data.message,
        budget,
        failed: query.isError,
        dataUpdatedAt: query.dataUpdatedAt,
      })
    : null;
  const busy = refresh.isPending || query.isFetching || data.status === 'pending';
  return (
    <section data-testid={TEST_IDS.repoInfoForge} data-status={data.status} className="min-w-0">
      <div className="mb-1.5 flex items-center gap-2">
        <h2 className="text-[11px] font-medium text-muted uppercase">Forge</h2>
        {data.forge && (
          <span className="min-w-0 truncate font-mono text-[11px]">
            <External href={info?.webUrl ?? data.forge.webUrl}>
              {data.forge.host}/{data.forge.repository}
            </External>
          </span>
        )}
        <WaitNote variant="inline" className="ml-auto truncate" active={busy} source={waitSource} />
        <button
          type="button"
          className="od-btn"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
          title="Ask the forge again"
        >
          Refresh
        </button>
      </div>
      {!info ? (
        <p className="text-xs text-muted">
          {projectStatusLine({
            projectId,
            forge: data.forge,
            status: data.status,
            message: data.message,
            worktrees: [],
            fetchedAt: data.fetchedAt,
          })}
        </p>
      ) : (
        <dl className="flex flex-col gap-1 text-xs">
          {info.description && (
            <Row label="About">
              <span className="line-clamp-2">{info.description}</span>
            </Row>
          )}
          <Row label="Repository">
            <span className="flex flex-wrap gap-x-2 text-muted">
              {info.visibility && <span>{info.visibility}</span>}
              {info.archived && <span className="text-warn">archived</span>}
              {info.forkOf && <span>fork of {info.forkOf}</span>}
              {info.license && <span>{info.license}</span>}
              {info.language && <span>{info.language}</span>}
              {info.topics.map((t) => (
                <span key={t} className="od-chip">
                  {t}
                </span>
              ))}
            </span>
          </Row>
          <Row label="Open">
            <span className="flex flex-wrap gap-x-3 tabular-nums">
              {info.openRequests !== null && (
                <External href={listUrls(info).requests}>
                  {info.openRequests} {noun?.long}
                  {info.openRequests === 1 ? '' : 's'}
                </External>
              )}
              {info.openIssues !== null && (
                <External href={listUrls(info).issues}>
                  {info.openIssues} {info.openIssues === 1 ? 'issue' : 'issues'}
                </External>
              )}
            </span>
          </Row>
          {info.defaultBranchHead && (
            <Row label={`CI on ${info.defaultBranch ?? 'default'}`}>
              <span className="flex items-center gap-1.5">
                <CiDot state={info.defaultBranchHead.checks} />
                <span>
                  {info.defaultBranchHead.checks
                    ? CHECKS_STATE_WORD[info.defaultBranchHead.checks]
                    : 'no CI'}
                </span>
                <span className="font-mono text-muted">
                  {info.defaultBranchHead.sha.slice(0, 7)}
                </span>
              </span>
            </Row>
          )}
          {info.pushedAt && (
            <Row label="Pushed">
              <span title={absoluteTime(info.pushedAt)}>{relativeTime(info.pushedAt)}</span>
            </Row>
          )}
          {stale && (
            <p className="mt-1">
              <StaleNote
                updatedAt={stale.updatedAt}
                reason={stale.reason}
                title={stale.detail ?? undefined}
                onRefresh={() => refresh.mutate()}
                refreshing={refresh.isPending}
              />
            </p>
          )}
        </dl>
      )}
    </section>
  );
}

/**
 * The open pull/merge requests tab of the project Overview: the newest `PAGE_SIZE` (15) the forge
 * returned, then a link to the full list on the forge. No pager: the forge is where the rest lives.
 */
export function OpenRequests({ projectId }: { projectId: string }) {
  const query = useRepositoryForge(projectId);
  const store = useUiStore();
  const index = useForgeIndex();
  const info = query.data?.repository;
  if (!info) return null;
  const noun = changeRequestNoun(info.kind).long;
  const sigil = info.kind === 'github' ? '#' : '!';
  const shown = info.requests.slice(0, PAGE_SIZE);
  const more = Math.max(0, (info.openRequests ?? info.requests.length) - shown.length);
  if (shown.length === 0) {
    return (
      <p className="py-2 text-xs text-muted">
        No open {noun}s.{' '}
        <External href={listUrls(info).requests}>
          All {noun}s on {info.host}
        </External>
      </p>
    );
  }
  return (
    <section>
      <table className="w-full text-xs">
        <tbody>
          {shown.map((r) => {
            const local = r.worktreeId !== null && index.has(r.worktreeId);
            const open = () => {
              if (r.worktreeId && local) {
                actions.setView(store, {
                  kind: 'worktree',
                  worktreeId: r.worktreeId,
                  tab: 'request',
                });
              } else if (r.url.startsWith('https://')) {
                window.open(r.url, '_blank', 'noopener,noreferrer');
              }
            };
            return (
              <tr
                key={r.number}
                data-testid={TEST_IDS.repoOpenRequest}
                data-number={String(r.number)}
                data-worktree={r.worktreeId ?? ''}
                className="cursor-pointer hover:bg-hover"
                onClick={open}
              >
                <td className="py-1.5 pr-2 align-top">
                  <span
                    className={`inline-flex items-center gap-1 ${r.draft ? 'text-faint' : 'text-add'}`}
                  >
                    <ChangeRequestGlyph look={r.draft ? 'draft' : 'open'} />
                    <span className="font-mono tabular-nums">
                      {sigil}
                      {r.number}
                    </span>
                  </span>
                </td>
                <td className="w-full max-w-0 py-1.5 pr-3">
                  <button
                    type="button"
                    className="block w-full truncate text-left hover:underline"
                    onClick={(e) => {
                      e.stopPropagation();
                      open();
                    }}
                    title={local ? 'Open the Request tab of this worktree' : `Open on ${info.host}`}
                  >
                    {r.title}
                    {!local && <span className="text-faint"> ↗</span>}
                  </button>
                  <span className="block truncate text-[11px] text-muted">
                    {r.author ?? 'unknown'} ·{' '}
                    <span className="font-mono">
                      {r.headBranch} → {r.baseBranch}
                    </span>
                    {r.draft && ' · draft'}
                    {local && ' · checked out here'}
                  </span>
                </td>
                <td className="py-1.5 pr-3 whitespace-nowrap text-muted">
                  <span className="inline-flex items-center gap-1.5">
                    <CiDot state={r.checks} />
                    {r.checks ? CHECKS_STATE_WORD[r.checks] : ''}
                  </span>
                </td>
                <td className="py-1.5 pr-3 whitespace-nowrap text-muted">
                  {r.review ? REVIEW_WORD[r.review] : ''}
                </td>
                <td
                  className="py-1.5 whitespace-nowrap text-right text-muted"
                  title={absoluteTime(r.updatedAt)}
                >
                  {relativeTime(r.updatedAt)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {(info.requestsTruncated || more > 0) && (
        <p className="mt-2 text-right text-[11px] text-muted">
          <External href={listUrls(info).requests}>
            {more > 0 ? `${more} more` : 'More'} on {info.host}
          </External>
        </p>
      )}
    </section>
  );
}

const BRANCH_CELL = 'py-1.5 pr-3';

/**
 * The upstream as shown in the Branches list: just the remote (`origin`) when the upstream has
 * the branch's own name there (the usual case), else the whole short name.
 */
export function upstreamLabel(branch: string, upstream: string): string {
  return upstream.endsWith(`/${branch}`) && upstream.length > branch.length + 1
    ? upstream.slice(0, -branch.length - 1)
    : upstream;
}

/**
 * The Branches tab of the project Overview: local branches that no worktree has checked out,
 * newest commit first, 15 a page. Local refs only (as of the last fetch); a branch whose name
 * matches an open request's head branch (same repository) links to it.
 */
export function LocalBranches({
  projectId,
  branches,
  total,
  listed,
  defaultBranch,
  error,
}: {
  projectId: string;
  /** Null while the repository is read. */
  branches: readonly GitBranchInfo[] | null;
  /** All local branches, and how many the daemon listed (it caps the list). */
  total: number | null;
  listed: number | null;
  defaultBranch: string | null;
  error: string | null;
}) {
  const forge = useRepositoryForge(projectId).data?.repository ?? null;
  const requests = new Map(
    (forge?.requests ?? []).filter((r) => !r.crossRepository).map((r) => [r.headBranch, r]),
  );
  const slice = usePage(branches ?? []);
  if (error) return <p className="py-2 text-xs text-danger">{error}</p>;
  if (!branches) {
    return (
      <div className="py-2" aria-busy="true">
        <SkeletonLines widths={[60, 75, 50]} />
        <WaitNote active source={LOCAL_WAIT} />
      </div>
    );
  }
  const merged = defaultBranch ? branches.filter((b) => b.merged).length : 0;
  const capped = total !== null && listed !== null && listed < total;
  return (
    <section>
      <p className="mb-2 text-[11px] text-muted">
        {branches.length === 0
          ? 'Every local branch is checked out in a worktree.'
          : 'Local branches no worktree has checked out, newest commit first.'}
        {merged > 0 && defaultBranch && (
          <>
            {' '}
            {merged} {merged === 1 ? 'is' : 'are'} merged into{' '}
            <span className="font-mono">{defaultBranch}</span>.
          </>
        )}
        {capped && ` Only the ${listed} newest of ${total} branches are read.`}
      </p>
      {branches.length > 0 && (
        <table className="w-full text-xs">
          <thead>
            <tr>
              <th className="od-th">Branch</th>
              <th className="od-th">Last commit</th>
              <th className="od-th">Updated</th>
              <th className="od-th">Upstream</th>
              <th className="od-th">State</th>
            </tr>
          </thead>
          <tbody>
            {slice.rows.map((b) => {
              const request = requests.get(b.name);
              return (
                <tr
                  key={b.name}
                  data-testid={TEST_IDS.overviewBranchRow}
                  data-branch={b.name}
                  data-merged={b.merged === null ? '' : String(b.merged)}
                  className="group/br hover:bg-hover"
                >
                  <td className={`${BRANCH_CELL} max-w-64`}>
                    <span className="flex min-w-0 items-center gap-1">
                      <span className="min-w-0 truncate font-mono font-medium" title={b.name}>
                        {b.name}
                      </span>
                      <CopyButton
                        text={b.name}
                        label="Copy branch name"
                        what="branch name"
                        escaped={hasSuspicious(b.name)}
                        className="opacity-0 group-hover/br:opacity-100 focus-visible:opacity-100"
                      />
                    </span>
                  </td>
                  <td className="w-full max-w-0 py-1.5 pr-3">
                    <span className="flex min-w-0 gap-1.5" title={b.subject}>
                      <span className="shrink-0 font-mono text-muted">{b.sha.slice(0, 7)}</span>
                      <span className="truncate">{b.subject}</span>
                    </span>
                  </td>
                  <td
                    className={`${BRANCH_CELL} whitespace-nowrap text-muted`}
                    title={absoluteTime(b.committerDate)}
                  >
                    {b.committerDate ? relativeTime(b.committerDate) : '–'}
                  </td>
                  <td className={`${BRANCH_CELL} whitespace-nowrap font-mono text-[11px]`}>
                    {b.upstream === null ? (
                      <span className="font-sans text-faint">local only</span>
                    ) : (
                      <span
                        className="text-muted"
                        title={`Against ${b.upstream}, as of the last fetch; octopus-diff never fetches`}
                      >
                        {upstreamLabel(b.name, b.upstream)}{' '}
                        {b.upstreamGone ? (
                          <span className="font-sans text-warn">gone</span>
                        ) : (
                          b.ahead !== null && b.behind !== null && `↑${b.ahead} ↓${b.behind}`
                        )}
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 whitespace-nowrap">
                    <span className="flex items-center gap-1.5">
                      {b.name === defaultBranch && (
                        <span className="od-chip od-chip-default">default</span>
                      )}
                      {b.merged && b.name !== defaultBranch && (
                        <span
                          className="od-chip"
                          title={`Merged into ${defaultBranch ?? 'the default branch'}`}
                        >
                          merged
                        </span>
                      )}
                      {request && (
                        <External href={request.url}>
                          <span
                            className={`inline-flex items-center gap-1 ${request.draft ? 'text-faint' : 'text-add'}`}
                            title={request.title}
                          >
                            <ChangeRequestGlyph look={request.draft ? 'draft' : 'open'} />
                            <span className="font-mono tabular-nums">
                              {forge?.kind === 'gitlab' ? '!' : '#'}
                              {request.number}
                            </span>
                          </span>
                        </External>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <Pager slice={slice} what="branches" />
    </section>
  );
}
