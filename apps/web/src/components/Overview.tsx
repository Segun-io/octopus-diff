import { type ReviewPolicyTarget, reviewTargetKey } from '@octopus-diff/contracts';
import type { ReactNode } from 'react';
import {
  useRescanScanRoot,
  useSetReviewPolicy,
  useSettingsQuery,
  useSettingsSupport,
} from '../api/settings.ts';
import {
  DIRECT_FOLDER_ID,
  type FolderNode,
  isDirtySummary,
  type NodeStats,
  type ProjectGroup,
  statsOfRows,
  worktreeLabel,
} from '../lib/model.ts';
import { policyLabel, shortenHome } from '../lib/policy.ts';
import { worktreeSource } from '../lib/source.ts';
import { useCommandsContext } from '../state/commandsContext.tsx';
import { useAppModel } from '../state/model.tsx';
import { actions, useUiStore, type View } from '../state/ui.tsx';
import { Dot } from './bits.tsx';
import { Mark } from './Mark.tsx';

/**
 * Overview for a folder or a project (views/registry.ts): stats, the worktrees or projects
 * inside, bulk actions and the review policy of the node. Future read-only views (Files, History)
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

function StatsRow({ stats, repos }: { stats: NodeStats; repos: boolean }) {
  return (
    <dl className="flex flex-wrap gap-x-8 gap-y-3 border-y border-line py-3">
      {repos && <Stat label="repositories" value={stats.projects} />}
      <Stat label="worktrees" value={stats.worktrees} />
      <Stat label="with changes" value={stats.dirty} tone={stats.dirty ? 'text-mod' : undefined} />
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
      <span className="text-muted">Review for {label}:</span>
      {(['on', 'off', 'inherit'] as const).map((choice) => (
        <button
          key={choice}
          type="button"
          aria-pressed={state === choice}
          disabled={setPolicy.isPending}
          onClick={() =>
            setPolicy.mutate({ target, enabled: choice === 'inherit' ? null : choice === 'on' })
          }
          className={`rounded-sm border px-2 py-0.5 ${
            state === choice
              ? 'border-accent bg-accent-soft text-fg'
              : 'border-line text-muted hover:bg-hover hover:text-fg'
          }`}
        >
          {choice === 'inherit' ? 'Inherit' : choice === 'on' ? 'On' : 'Off'}
        </button>
      ))}
    </div>
  );
}

function BulkButtons({
  onVerified,
  onUnreviewed,
}: {
  onVerified: () => void;
  onUnreviewed: () => void;
}) {
  const support = useSettingsSupport();
  if (support !== 'ready') return null;
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onVerified}
        className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:border-add hover:bg-add-soft hover:text-fg"
      >
        Mark all as verified
      </button>
      <button
        type="button"
        onClick={onUnreviewed}
        className="rounded-md border border-line px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg"
      >
        Mark all as unreviewed
      </button>
    </div>
  );
}

function FolderOverview({ node }: { node: FolderNode }) {
  const store = useUiStore();
  const commands = useCommandsContext();
  const rescan = useRescanScanRoot();
  const root = node.root;
  const ids = node.groups.flatMap((g) => g.allRows.map((r) => r.worktree.id));
  const target = root
    ? ({ kind: 'folder', scanRootId: root.id } as const)
    : ({ kind: 'all' } as const);
  return (
    <div className="od-scroll h-full overflow-y-auto p-5">
      <header className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="od-heading">
            {node.id === DIRECT_FOLDER_ID ? 'Added directly' : 'Folder'}
          </div>
          <h1 className="truncate font-mono text-base font-semibold" title={root?.path}>
            {node.label}
          </h1>
          {root && (
            <p className="text-[11px] text-muted">
              depth {root.depth} · scanned{' '}
              {root.lastScannedAt ? new Date(root.lastScannedAt).toLocaleString() : 'never'}
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2">
          <BulkButtons
            onVerified={() => commands.markAllFor(target, true, ids)}
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
                className="rounded-md border border-line px-2 py-0.5 text-xs text-muted hover:bg-hover hover:text-fg"
              >
                Rescan
              </button>
            )}
          </div>
        </div>
      </header>
      <StatsRow stats={node.stats} repos />
      <table className="mt-4 w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] tracking-wide text-faint uppercase">
            <th className="py-1 font-medium">Repository</th>
            <th className="py-1 font-medium">Worktrees</th>
            <th className="py-1 font-medium">Changes</th>
            <th className="py-1 font-medium">Unreviewed</th>
            <th className="py-1 font-medium">Path</th>
          </tr>
        </thead>
        <tbody>
          {node.groups.map((g) => {
            const s = statsOfRows(g.allRows);
            return (
              <tr
                key={g.project.id}
                className="cursor-pointer border-t border-line hover:bg-hover"
                onClick={() => actions.setView(store, { kind: 'project', projectId: g.project.id })}
              >
                <td className="py-1.5 pr-3 font-medium">{g.project.name}</td>
                <td className="py-1.5 pr-3 font-mono tabular-nums">{s.worktrees}</td>
                <td className="py-1.5 pr-3 font-mono tabular-nums">
                  {s.dirty > 0 ? (
                    <>
                      <span className="inline-flex items-center gap-0.5 text-mod">
                        <Dot />
                        {s.dirty}
                      </span>{' '}
                      <span className="text-add">+{s.additions}</span>{' '}
                      <span className="text-del">−{s.deletions}</span>
                    </>
                  ) : (
                    <span className="text-faint">clean</span>
                  )}
                </td>
                <td className="py-1.5 pr-3 font-mono tabular-nums">
                  {s.unreviewed > 0 ? <span className="font-semibold">{s.unreviewed}</span> : '–'}
                </td>
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

function ProjectOverview({ group }: { group: ProjectGroup }) {
  const store = useUiStore();
  const commands = useCommandsContext();
  const model = useAppModel();
  const { project } = group;
  const ids = group.allRows.map((r) => r.worktree.id);
  const folder = model.sidebar.folders.find((f) => f.groups.includes(group));
  const stats = statsOfRows(group.allRows);
  return (
    <div className="od-scroll h-full overflow-y-auto p-5">
      <header className="mb-4 flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="od-heading">
            Project
            {folder && (
              <>
                {' · '}
                <span className="font-mono font-normal tracking-normal normal-case">
                  {folder.label}
                </span>
              </>
            )}
          </div>
          <h1 className="truncate text-base font-semibold">{project.name}</h1>
          <p className="truncate font-mono text-[11px] text-muted" title={project.commonDir}>
            {shortenHome(project.mainWorktreePath ?? project.commonDir)} · base{' '}
            {project.defaultBranch ?? 'unknown'}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <BulkButtons
            onVerified={() =>
              commands.markAllFor({ kind: 'project', projectId: project.id }, true, ids)
            }
            onUnreviewed={() =>
              commands.markAllFor({ kind: 'project', projectId: project.id }, false, ids)
            }
          />
          <PolicyControl target={{ kind: 'project', projectId: project.id }} label="this project" />
        </div>
      </header>
      <StatsRow stats={stats} repos={false} />
      <table className="mt-4 w-full text-xs">
        <thead>
          <tr className="text-left text-[10px] tracking-wide text-faint uppercase">
            <th className="py-1 font-medium">Worktree</th>
            <th className="py-1 font-medium">Source</th>
            <th className="py-1 font-medium">Ahead / behind</th>
            <th className="py-1 font-medium">Changes</th>
            <th className="py-1 font-medium">Unreviewed</th>
            <th className="py-1 font-medium">Review</th>
          </tr>
        </thead>
        <tbody>
          {group.allRows.map((row) => {
            const s = row.summary;
            const source = row.worktree.isMain ? null : worktreeSource(row.worktree.path);
            return (
              <tr
                key={row.worktree.id}
                className="cursor-pointer border-t border-line hover:bg-hover"
                onClick={() =>
                  actions.setView(store, { kind: 'worktree', worktreeId: row.worktree.id })
                }
                title={row.worktree.path}
              >
                <td className="py-1.5 pr-3">
                  <span className={row.worktree.branch ? 'font-medium' : 'italic text-muted'}>
                    {worktreeLabel(row.worktree)}
                  </span>
                  {row.worktree.isMain && <span className="ml-1 text-[10px] text-faint">main</span>}
                  {s?.inProgress && (
                    <span className="ml-1 text-[10px] text-warn">{s.inProgress}</span>
                  )}
                  {row.worktree.missing && (
                    <span className="ml-1 text-[10px] text-danger">missing</span>
                  )}
                </td>
                <td className="py-1.5 pr-3 font-mono text-[11px] text-muted">
                  {source?.label ?? (row.worktree.isMain ? '–' : 'plain')}
                </td>
                <td className="py-1.5 pr-3 font-mono tabular-nums text-muted">
                  {s && s.ahead !== null && s.behind !== null ? `↑${s.ahead} ↓${s.behind}` : '–'}
                </td>
                <td className="py-1.5 pr-3 font-mono tabular-nums">
                  {s && isDirtySummary(s) ? (
                    <>
                      {s.changedFiles} <span className="text-add">+{s.additions}</span>{' '}
                      <span className="text-del">−{s.deletions}</span>
                    </>
                  ) : row.error ? (
                    <span className="text-danger">error</span>
                  ) : (
                    <span className="text-faint">clean</span>
                  )}
                </td>
                <td className="py-1.5 pr-3 font-mono tabular-nums">
                  {row.unreviewed > 0 ? (
                    <span className="font-semibold">{row.unreviewed}</span>
                  ) : (
                    '–'
                  )}
                </td>
                <td className="py-1.5 text-[11px] text-muted">
                  {row.review.enabled ? <span className="text-add">on</span> : <span>off</span>}{' '}
                  <span className="text-faint">({policyLabel(row.review).split('from ')[1]})</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
