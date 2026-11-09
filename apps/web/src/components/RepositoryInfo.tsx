import {
  changeRequestNoun,
  type ForgeRepositoryInfo,
  type GitRepositoryInfo,
  type ProjectForge,
  TEST_IDS,
} from '@octopus-diff/contracts';
import type { ReactNode } from 'react';
import {
  type RepositoryEntry,
  useForgeIndex,
  useRefreshRepositoryForge,
  useRepositoryForge,
} from '../api/forges.ts';
import { CHECKS_STATE_WORD, projectStatusLine, REVIEW_WORD, remoteLabel } from '../lib/forge.ts';
import { absoluteTime, relativeTime } from '../lib/time.ts';
import { actions, useUiStore } from '../state/ui.tsx';
import { ChangeRequestGlyph } from './ChangeRequest.tsx';

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
        <p className="text-xs text-muted">Reading the repository…</p>
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
  const data = query.data;
  if (!data) {
    if (query.isError) {
      return (
        <section data-testid={TEST_IDS.repoInfoForge} data-status="error" className="text-xs">
          <p className="text-danger">Could not load forge facts.</p>
        </section>
      );
    }
    return null;
  }
  if (data.status === 'no-forge' || data.status === 'disabled' || data.status === 'ignored') {
    return null;
  }
  const info = data.repository;
  const noun = data.forge ? changeRequestNoun(data.forge.kind) : null;
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
        <button
          type="button"
          className="od-btn ml-auto"
          disabled={refresh.isPending}
          onClick={() => refresh.mutate()}
          title="Ask the forge again (at most every 15 s)"
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
          {data.message && (
            <p className="text-[11px] text-muted">Showing older data: {data.message}</p>
          )}
        </dl>
      )}
    </section>
  );
}

/** "Open pull requests" below the worktree table (newest 20). */
export function OpenRequests({ projectId }: { projectId: string }) {
  const query = useRepositoryForge(projectId);
  const store = useUiStore();
  const index = useForgeIndex();
  const info = query.data?.repository;
  if (!info || info.requests.length === 0) return null;
  const noun = changeRequestNoun(info.kind).long;
  const sigil = info.kind === 'github' ? '#' : '!';
  const more = (info.openRequests ?? info.requests.length) - info.requests.length;
  return (
    <section className="mt-6">
      <h2 className="mb-1.5 text-xs font-medium">Open {noun}s</h2>
      <table className="w-full text-xs">
        <tbody>
          {info.requests.map((r) => {
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
        <p className="mt-1.5 text-[11px] text-muted">
          <External
            href={
              info.kind === 'github' ? `${info.webUrl}/pulls` : `${info.webUrl}/-/merge_requests`
            }
          >
            {more > 0 ? `${more} more` : 'More'} on {info.host}
          </External>
        </p>
      )}
    </section>
  );
}
