import {
  changeRequestNoun,
  type ReviewPolicyTarget,
  reviewTargetKey,
  TEST_IDS,
} from '@octopus-diff/contracts';
import { type ReactNode, useState } from 'react';
import {
  type RepositoryEntry,
  useForgeIndex,
  useForgesQuery,
  useRepositories,
  useRepositoryForge,
} from '../api/forges.ts';
import {
  useRescanScanRoot,
  useSetReviewPolicy,
  useSettingsQuery,
  useSettingsSupport,
} from '../api/settings.ts';
import { useReviewComputing } from '../api/wait.ts';
import { type ForgeIndexEntry, needsAttention, REVIEW_WORD, remoteLabel } from '../lib/forge.ts';
import {
  branchesWithoutWorktree,
  DIRECT_FOLDER_ID,
  defaultBranchFirst,
  type FolderNode,
  isDefaultBranch,
  isDirtySummary,
  type NodeStats,
  type ProjectGroup,
  statsOfRows,
  type WorktreeRow,
  worktreeLabel,
} from '../lib/model.ts';
import { SOURCE_LABELS, shortenHome } from '../lib/policy.ts';
import { worktreeSource } from '../lib/source.ts';
import { absoluteTime, relativeTime } from '../lib/time.ts';
import { LOCAL_WAIT } from '../lib/wait.ts';
import { useCommandsContext } from '../state/commandsContext.tsx';
import { type CopyFn, copyAndReport } from '../state/copy.ts';
import { useAppModel } from '../state/model.tsx';
import { actions, useUiStore, type View } from '../state/ui.tsx';
import { ChangeRequestChip } from './ChangeRequest.tsx';
import { ContextMenu, useContextMenu } from './ContextMenu.tsx';
import { separated, worktreeCopyItems } from './copyMenu.ts';
import { useDesktopMenu } from './desktopMenu.ts';
import { Mark } from './Mark.tsx';
import { Pager, usePage } from './Pager.tsx';
import {
  ForgeRepositoryFacts,
  LocalBranches,
  LocalRepositoryFacts,
  OpenRequests,
} from './RepositoryInfo.tsx';
import { SegmentedTabs, type TabItem, tabPanelProps } from './Tabs.tsx';
import { WaitNote } from './WaitNote.tsx';
import { DefaultBranchChip } from './WorktreeChips.tsx';
/**
 * Overview for a folder or a project (views/registry.ts): figures, the worktrees or projects
 * inside, bulk actions and the review policy of the node. A project's lists (worktrees, local
 * branches without a worktree, open pull/merge requests) sit behind `SegmentedTabs`, 15 rows a
 * page (docs/OVERVIEW-LISTS.md). Future read-only views (Files, History)
 * sit next to it; see docs/design/FOLDERS.md.
 */
export function Overview({ view }: { view: Extract<View, { kind: 'folder' | 'project' }> }) {
  const model = useAppModel();
  if (view.kind === 'folder') {
    const node = model.sidebar.folders.find((f) => f.id === view.scanRootId);
    if (!node) return <Missing what="folder" />;
    return <FolderOverview node={node} />;
  }
  const group = model.sidebar.groups.find((g) => g.project.id === view.projectId);
  if (!group) return <Missing what="project" />;
  return <ProjectOverview group={group} />;
}

function Missing({ what }: { what: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted">
      <Mark size={28} className="text-faint" />
      <p>This {what} is no longer listed (or every worktree is hidden by the filters).</p>
    </div>
  );
}

/** One figure of the summary line: the number, then its label. No box around it. */
function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="flex flex-col">
      <dt className="order-2 text-[11px] text-muted">{label}</dt>
      <dd className={`order-1 font-mono text-xl tabular-nums ${tone ?? 'text-fg'}`}>{value}</dd>
    </div>
  );
}

function StatsRow({
  stats,
  repos,
  children,
}: {
  stats: NodeStats;
  repos: boolean;
  children?: ReactNode;
}) {
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-3 border-y border-line py-3">
      {repos && <Stat label="repositories" value={stats.projects} />}
      <Stat label="worktrees" value={stats.worktrees} />
      <Stat label="with changes" value={stats.dirty} />
      <Stat label="unreviewed files" value={stats.unreviewed} />
      <Stat
        label="lines"
        value={
          <>
            <span className="text-add">+{stats.additions}</span>{' '}
            <span className="text-del">−{stats.deletions}</span>
          </>
        }
      />
      {children}
    </dl>
  );
}

function PolicyControl({ target, label }: { target: ReviewPolicyTarget | null; label: string }) {
  const settings = useSettingsQuery();
  const setPolicy = useSetReviewPolicy();
  if (!settings.data || !target) return null;
  const key = reviewTargetKey(target);
  const override = settings.data.overrides.find((o) => reviewTargetKey(o.target) === key);
  const state = override ? (override.enabled ? 'on' : 'off') : 'inherit';
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-muted">Review for {label}</span>
      {(['on', 'off', 'inherit'] as const).map((choice) => (
        <button
          key={choice}
          type="button"
          aria-pressed={state === choice}
          disabled={setPolicy.isPending}
          onClick={() =>
            setPolicy.mutate({ target, enabled: choice === 'inherit' ? null : choice === 'on' })
          }
          className="od-btn"
        >
          {choice === 'inherit' ? 'Inherit' : choice === 'on' ? 'On' : 'Off'}
        </button>
      ))}
    </div>
  );
}

function BulkButtons({
  onReviewed,
  onUnreviewed,
}: {
  onReviewed: () => void;
  onUnreviewed: () => void;
}) {
  const support = useSettingsSupport();
  if (support !== 'ready') return null;
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onReviewed}
        className="od-btn hover:border-add hover:bg-add-soft"
      >
        Mark all reviewed
      </button>
      <button type="button" onClick={onUnreviewed} className="od-btn">
        Mark all unreviewed
      </button>
    </div>
  );
}

/**
 * The first cell of a row: a real button, so the row is reachable by keyboard. The row itself
 * also accepts a pointer click (the handler is idempotent).
 */
function RowLink({
  onClick,
  children,
  className = '',
}: {
  onClick: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`rounded-sm text-left hover:underline ${className}`}
    >
      {children}
    </button>
  );
}

function Figures({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <>
      <span className="text-add">+{additions}</span> <span className="text-del">−{deletions}</span>
    </>
  );
}

const CELL = 'py-1.5 pr-3';

/** Open requests and those needing attention among the given worktrees (batch data only). */
function rollupRequests(worktreeIds: readonly string[], index: Map<string, ForgeIndexEntry>) {
  let open = 0;
  let attention = 0;
  let known = false;
  let github = 0;
  let gitlab = 0;
  for (const id of worktreeIds) {
    const entry = index.get(id);
    if (!entry) continue;
    known = true;
    const cr = entry.worktree.changeRequest;
    if (cr?.state !== 'open') continue;
    open += 1;
    if (cr.kind === 'github') github += 1;
    else gitlab += 1;
    if (needsAttention(cr)) attention += 1;
  }
  const noun = gitlab > github ? 'merge request' : 'pull request';
  return { open, attention, known, noun };
}

/** Folder Overview cells from `/api/repositories` and the cached `/api/forges`. */
function FolderRepoCells({
  entry,
  state,
  worktreeIds,
}: {
  entry: RepositoryEntry | undefined;
  state: { forge: { host: string; repository: string; webUrl: string } | null } | undefined;
  worktreeIds: readonly string[];
}) {
  const index = useForgeIndex();
  const info = entry?.info;
  const branch = info?.defaultBranch;
  const forge = state?.forge ?? null;
  const roll = rollupRequests(worktreeIds, index);
  const origin = info?.remotes.find((r) => r.name === 'origin') ?? info?.remotes[0];
  const label = forge
    ? `${forge.host}/${forge.repository}`
    : origin?.url
      ? remoteLabel(origin.url)
      : null;
  return (
    <>
      <td className={`${CELL} font-mono text-[11px]`}>
        {branch ? (
          <>
            {branch.name}
            {branch.ahead !== null && branch.behind !== null && (
              <span
                className="ml-1.5 text-muted"
                title={`Against ${branch.upstream}, as of the last fetch; octopus-diff never fetches`}
              >
                ↑{branch.ahead} ↓{branch.behind}
              </span>
            )}
          </>
        ) : (
          <span className="text-faint">–</span>
        )}
      </td>
      <td
        className={`${CELL} whitespace-nowrap text-[11px] text-muted`}
        title={absoluteTime(branch?.head?.authorDate)}
      >
        {branch?.head ? relativeTime(branch.head.authorDate) : '–'}
      </td>
      <td className={`${CELL} max-w-48 truncate font-mono text-[11px] text-muted`}>
        {label === null ? (
          <span className="text-faint">–</span>
        ) : forge?.webUrl.startsWith('https://') ? (
          <a
            href={forge.webUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {label} <span className="text-faint">↗</span>
          </a>
        ) : (
          label
        )}
      </td>
      <td className={`${CELL} font-mono tabular-nums`}>
        {roll.open > 0 ? (
          <span title={`${roll.attention} need attention`}>
            {roll.open}
            {roll.attention > 0 && (
              <span className="ml-1.5 font-sans text-[11px] text-danger">
                {roll.attention} need attention
              </span>
            )}
          </span>
        ) : (
          <span className="text-faint">–</span>
        )}
      </td>
    </>
  );
}

/** The Pull request column: chip, truncated title, review word (batch data, no query). */
function RequestCell({ worktreeId }: { worktreeId: string }) {
  const entry = useForgeIndex().get(worktreeId);
  const cr = entry?.worktree.changeRequest;
  if (!cr) return <span className="text-faint">–</span>;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-[11px]" title={cr.title}>
      <ChangeRequestChip worktreeId={worktreeId} />
      <span className="min-w-0 truncate">{cr.title}</span>
      {cr.review && cr.state === 'open' && (
        <span className="shrink-0 text-muted">{REVIEW_WORD[cr.review]}</span>
      )}
    </span>
  );
}
const NUM = `${CELL} font-mono tabular-nums`;

function FolderOverview({ node }: { node: FolderNode }) {
  const store = useUiStore();
  const commands = useCommandsContext();
  const rescan = useRescanScanRoot();
  const root = node.root;
  const ids = node.groups.flatMap((g) => g.allRows.map((r) => r.worktree.id));
  // Local facts for the listed projects (git only) and already-known forge data: the folder
  // Overview runs no forge query of its own (DECISIONS #76).
  const repositories = useRepositories(node.groups.map((g) => g.project.id));
  const forges = useForgesQuery();
  const forgeIndex = useForgeIndex();
  const forgeStates = new Map((forges.data?.projects ?? []).map((p) => [p.projectId, p]));
  const forgeRollup = rollupRequests(ids, forgeIndex);
  const target = root
    ? ({ kind: 'folder', scanRootId: root.id } as const)
    : ({ kind: 'all' } as const);
  const direct = node.id === DIRECT_FOLDER_ID;
  return (
    <div className="od-scroll h-full overflow-y-auto p-5">
      <header className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1
            className={`truncate text-base font-semibold ${direct ? '' : 'font-mono'}`}
            title={root?.path}
          >
            {node.label}
          </h1>
          {root ? (
            <p className="flex flex-wrap gap-x-3 text-[11px] text-muted">
              <span>depth {root.depth}</span>
              <span>
                scanned{' '}
                {root.lastScannedAt ? new Date(root.lastScannedAt).toLocaleString() : 'never'}
              </span>
            </p>
          ) : (
            <p className="text-[11px] text-muted">
              Repositories added one by one, without a folder.
            </p>
          )}
          <WaitNote active={repositories.isPending} source={LOCAL_WAIT} />
        </div>
        <div className="flex flex-col items-end gap-2">
          <BulkButtons
            onReviewed={() => commands.markAllFor(target, true, ids)}
            onUnreviewed={() => commands.markAllFor(target, false, ids)}
          />
          <div className="flex items-center gap-2">
            <PolicyControl
              target={root ? { kind: 'folder', scanRootId: root.id } : null}
              label="this folder"
            />
            {root && (
              <button
                type="button"
                onClick={() => rescan.mutate(root.id)}
                disabled={rescan.isPending}
                className="od-btn"
              >
                Rescan
              </button>
            )}
          </div>
        </div>
      </header>
      <StatsRow stats={node.stats} repos>
        {forgeRollup.known && (
          <>
            <Stat label={`open ${forgeRollup.noun}s`} value={forgeRollup.open} />
            <Stat
              label="need attention"
              value={forgeRollup.attention}
              {...(forgeRollup.attention > 0 ? { tone: 'text-danger' } : {})}
            />
          </>
        )}
      </StatsRow>
      <table className="mt-4 w-full text-xs">
        <thead>
          <tr>
            <th className="od-th">Repository</th>
            <th className="od-th">Worktrees</th>
            <th className="od-th">With changes</th>
            <th className="od-th">Lines</th>
            <th className="od-th">Unreviewed</th>
            <th className="od-th">Default branch</th>
            <th className="od-th">Last commit</th>
            <th className="od-th">Forge</th>
            <th className="od-th">PRs</th>
            <th className="od-th">Path</th>
          </tr>
        </thead>
        <tbody>
          {node.groups.map((g) => {
            const s = statsOfRows(g.allRows);
            const go = () => actions.setView(store, { kind: 'project', projectId: g.project.id });
            return (
              <tr key={g.project.id} className="cursor-pointer hover:bg-hover" onClick={go}>
                <td className={CELL}>
                  <RowLink onClick={go} className="font-medium">
                    {g.project.name}
                  </RowLink>
                </td>
                <td className={NUM}>{s.worktrees}</td>
                <td className={NUM}>
                  {s.dirty > 0 ? s.dirty : <span className="font-sans text-faint">clean</span>}
                </td>
                <td className={NUM}>
                  {s.dirty > 0 && <Figures additions={s.additions} deletions={s.deletions} />}
                </td>
                <td className={NUM}>
                  {s.unreviewed > 0 ? <span className="font-semibold">{s.unreviewed}</span> : '–'}
                </td>
                <FolderRepoCells
                  entry={repositories.data?.get(g.project.id)}
                  state={forgeStates.get(g.project.id)}
                  worktreeIds={g.allRows.map((r) => r.worktree.id)}
                />
                <td className="truncate py-1.5 font-mono text-[11px] text-faint">
                  {shortenHome(g.project.mainWorktreePath ?? g.project.commonDir)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

type OverviewTab = 'worktrees' | 'branches' | 'requests';

function ProjectOverview({ group }: { group: ProjectGroup }) {
  const store = useUiStore();
  const commands = useCommandsContext();
  const menu = useContextMenu<WorktreeRow>();
  const copy: CopyFn = (text, options) => void copyAndReport(store, text, options);
  const desktopItems = useDesktopMenu();
  // The chosen tab survives moving between projects (compare the same list across repositories);
  // the pages start over (the lists below are keyed by project).
  const [tab, setTab] = useState<OverviewTab>('worktrees');
  const { project } = group;
  const reviewComputing = useReviewComputing();
  const repositories = useRepositories([project.id]);
  const entry = repositories.data?.get(project.id);
  const forgeState = useForgesQuery().data?.projects.find((p) => p.projectId === project.id);
  const forgeInfo = useRepositoryForge(project.id).data?.repository ?? null;
  const ids = group.allRows.map((r) => r.worktree.id);
  const stats = statsOfRows(group.allRows);
  const branches = entry?.info?.branches;
  const free = branches ? branchesWithoutWorktree(branches, group.allRows) : null;
  const noun = forgeInfo ? changeRequestNoun(forgeInfo.kind).long : null;
  const tabs: Array<TabItem<OverviewTab>> = [
    { id: 'worktrees', label: 'Worktrees', count: group.allRows.length },
    // Hidden when the daemon answered without a branch list (an older daemon).
    ...(entry?.info && !branches
      ? []
      : [{ id: 'branches' as const, label: 'Branches', count: free?.length ?? null }]),
    ...(forgeInfo && noun
      ? [
          {
            id: 'requests' as const,
            label: `${noun[0]?.toUpperCase()}${noun.slice(1)}s`,
            count: forgeInfo.openRequests ?? forgeInfo.requests.length,
          },
        ]
      : []),
  ];
  const active = tabs.some((t) => t.id === tab) ? tab : 'worktrees';
  const prefix = `overview-${project.id}`;
  return (
    <div className="od-scroll h-full overflow-y-auto p-5">
      <header className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-base font-semibold">{project.name}</h1>
          <p className="flex flex-wrap gap-x-3 text-[11px] text-muted" title={project.commonDir}>
            <span className="truncate font-mono">
              {shortenHome(project.mainWorktreePath ?? project.commonDir)}
            </span>
            <span>
              base <span className="font-mono">{project.defaultBranch ?? 'unknown'}</span>
            </span>
          </p>
          <WaitNote active={reviewComputing} source={LOCAL_WAIT} />
        </div>
        <div className="flex flex-col items-end gap-2">
          <BulkButtons
            onReviewed={() =>
              commands.markAllFor({ kind: 'project', projectId: project.id }, true, ids)
            }
            onUnreviewed={() =>
              commands.markAllFor({ kind: 'project', projectId: project.id }, false, ids)
            }
          />
          <PolicyControl target={{ kind: 'project', projectId: project.id }} label="this project" />
        </div>
      </header>
      <div className="mb-4 grid gap-x-8 gap-y-4 border-t border-line pt-3 lg:grid-cols-2">
        <LocalRepositoryFacts
          entry={entry}
          forge={forgeState?.forge ?? null}
          worktrees={group.allRows.length}
        />
        <ForgeRepositoryFacts projectId={project.id} />
      </div>
      <StatsRow stats={stats} repos={false} />
      <div className="mt-4 mb-2 flex items-center">
        <SegmentedTabs
          tabs={tabs}
          value={active}
          onChange={setTab}
          label={`${project.name} lists`}
          idPrefix={prefix}
          testId={TEST_IDS.overviewTab}
        />
      </div>
      <div {...tabPanelProps(prefix, active)}>
        {active === 'worktrees' ? (
          <WorktreeTable
            key={project.id}
            rows={group.allRows}
            onMenu={(e, row) => menu.open(e, row)}
          />
        ) : active === 'branches' ? (
          <LocalBranches
            key={project.id}
            projectId={project.id}
            branches={free}
            total={entry?.info?.localBranches ?? null}
            listed={branches?.length ?? null}
            defaultBranch={entry?.info?.defaultBranch?.name ?? project.defaultBranch}
            error={entry && !entry.info ? (entry.error ?? 'Could not read the repository.') : null}
          />
        ) : (
          <OpenRequests projectId={project.id} />
        )}
      </div>
      {menu.state && (
        <ContextMenu
          items={[
            {
              id: 'open',
              label: 'Open changes',
              onSelect: () =>
                commands.openView({
                  kind: 'worktree',
                  worktreeId: menu.state?.target.worktree.id ?? '',
                }),
            },
            ...separated(worktreeCopyItems(menu.state.target.worktree, copy, menu.state.position)),
            ...desktopItems({
              worktreeId: menu.state.target.worktree.id,
              deleted: menu.state.target.worktree.missing,
            }),
          ]}
          position={menu.state.position}
          onClose={menu.close}
          label="Actions"
        />
      )}
    </div>
  );
}

/**
 * The project's worktrees, the default-branch one first and the rest by recent activity, 15 a
 * page (`PAGE_SIZE`).
 */
function WorktreeTable({
  rows,
  onMenu,
}: {
  rows: readonly WorktreeRow[];
  onMenu: (event: React.MouseEvent, row: WorktreeRow) => void;
}) {
  const commands = useCommandsContext();
  const slice = usePage(defaultBranchFirst(rows));
  return (
    <>
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th className="od-th">Worktree</th>
            <th className="od-th">Source</th>
            <th className="od-th">Ahead / behind</th>
            <th className="od-th">Files</th>
            <th className="od-th">Lines</th>
            <th className="od-th">Unreviewed</th>
            <th className="od-th">Pull request</th>
            <th className="od-th">Review</th>
          </tr>
        </thead>
        <tbody>
          {slice.rows.map((row) => {
            const s = row.summary;
            const source = row.worktree.isMain ? null : worktreeSource(row.worktree.path);
            const dirty = s ? isDirtySummary(s) : false;
            const isDefault = isDefaultBranch(row.worktree, row.project);
            const go = () => commands.openView({ kind: 'worktree', worktreeId: row.worktree.id });
            return (
              <tr
                key={row.worktree.id}
                className="cursor-pointer hover:bg-hover"
                onClick={go}
                onContextMenu={(e) => onMenu(e, row)}
                data-testid="overview-worktree-row"
                data-worktree-id={row.worktree.id}
                data-default={isDefault ? 'true' : undefined}
                title={row.worktree.path}
              >
                <td className={CELL}>
                  <span className="flex min-w-0 items-center gap-1.5">
                    <RowLink onClick={go} className="min-w-0 truncate">
                      <span className={row.worktree.branch ? 'font-medium' : 'italic text-muted'}>
                        {worktreeLabel(row.worktree)}
                      </span>
                    </RowLink>
                    <DefaultBranchChip row={row} />
                    {s?.inProgress && <span className="text-[11px] text-warn">{s.inProgress}</span>}
                    {row.worktree.missing && (
                      <span className="text-[11px] text-danger">missing</span>
                    )}
                  </span>
                </td>
                <td className={`${CELL} font-mono text-[11px] text-muted`}>
                  {source?.label ??
                    (row.worktree.isMain ? (
                      <span className="font-sans">main checkout</span>
                    ) : (
                      'plain'
                    ))}
                </td>
                <td className={`${NUM} text-muted`}>
                  {s && s.ahead !== null && s.behind !== null ? `↑${s.ahead} ↓${s.behind}` : '–'}
                </td>
                <td className={NUM}>
                  {s && dirty ? (
                    s.changedFiles
                  ) : row.error ? (
                    <span className="font-sans text-danger">error</span>
                  ) : (
                    <span className="font-sans text-faint">clean</span>
                  )}
                </td>
                <td className={NUM}>
                  {s && dirty && <Figures additions={s.additions} deletions={s.deletions} />}
                </td>
                <td className={NUM}>
                  {row.unreviewed > 0 ? (
                    <span className="font-semibold">{row.unreviewed}</span>
                  ) : (
                    '–'
                  )}
                </td>
                <td className={`${CELL} max-w-64`}>
                  <RequestCell worktreeId={row.worktree.id} />
                </td>
                <td className="py-1.5 text-[11px] text-muted">
                  {row.review.enabled ? <span className="text-add">on</span> : <span>off</span>}{' '}
                  <span className="text-faint">(from {SOURCE_LABELS[row.review.source]})</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <Pager slice={slice} what="worktrees" />
    </>
  );
}
