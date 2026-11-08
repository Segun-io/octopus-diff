import { useState } from 'react';
import { describeError, useProjectsQuery } from '../../api/queries.ts';
import {
  useRemoveProject,
  useRemoveScanRoot,
  useRescanScanRoot,
  useScanRootsQuery,
  useUpdateProject,
} from '../../api/settings.ts';
import { shortenHome } from '../../lib/policy.ts';
import { useUi } from '../../state/ui.tsx';
import { AddProjectForm } from '../AddProjectForm.tsx';
import { SmallButton } from './controls.tsx';

/** Settings → Folders: scan roots and projects, with add / rescan / remove. */
export function FoldersSection() {
  const roots = useScanRootsQuery();
  const projects = useProjectsQuery();
  const remove = useRemoveScanRoot();
  const rescan = useRescanScanRoot();
  const removeProject = useRemoveProject();
  const updateProject = useUpdateProject();
  const scan = useUi((s) => s.scan);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);

  const list = roots.data?.scanRoots ?? [];
  const projectList = [...(projects.data?.projects ?? [])].sort((a, b) =>
    a.project.name.localeCompare(b.project.name),
  );
  const error = remove.error ?? rescan.error ?? removeProject.error ?? updateProject.error;

  return (
    <div className="text-xs">
      <section>
        <h4 className="od-label mb-1">Watched folders</h4>
        <p className="mb-2 text-[11px] text-muted">
          Every repository (and its worktrees) found under a folder, up to the depth, is added and
          kept in sync. Removing a folder removes the projects it discovered.
        </p>
        {list.length === 0 && <p className="text-[11px] text-faint">No folders watched yet.</p>}
        <ul className="flex flex-col">
          {list.map((root) => (
            <li
              key={root.id}
              className="flex items-center gap-3 border-b border-line py-1.5 last:border-0"
            >
              <span className="min-w-0 flex-1 truncate font-mono" title={root.path}>
                {shortenHome(root.path)}
              </span>
              <span className="flex shrink-0 gap-3 text-muted tabular-nums">
                <span>depth {root.depth}</span>
                <span>
                  {root.projectCount} {root.projectCount === 1 ? 'repo' : 'repos'}
                </span>
                {scan && scan.scanRootId === root.id && scan.state === 'scanning' && (
                  <span>scanning…</span>
                )}
              </span>
              <SmallButton
                onClick={() => rescan.mutate(root.id)}
                disabled={rescan.isPending}
                title="Scan the folder again now"
              >
                Rescan
              </SmallButton>
              {confirm === root.id ? (
                <>
                  <SmallButton
                    onClick={() => remove.mutate(root.id)}
                    danger
                    disabled={remove.isPending}
                  >
                    Confirm remove
                  </SmallButton>
                  <SmallButton onClick={() => setConfirm(null)}>Keep</SmallButton>
                </>
              ) : (
                <SmallButton onClick={() => setConfirm(root.id)} danger>
                  Remove
                </SmallButton>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-5">
        <h4 className="od-label mb-1">Repositories</h4>
        {projectList.length === 0 && <p className="text-[11px] text-faint">No repositories yet.</p>}
        <ul className="flex flex-col">
          {projectList.map(({ project, worktrees }) => {
            const root = list.find((r) => r.id === project.scanRootId);
            const isEditing = editing?.id === project.id;
            return (
              <li
                key={project.id}
                className="flex items-center gap-3 border-b border-line py-1.5 last:border-0"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{project.name}</span>
                  <span className="ml-2 text-muted">
                    {worktrees.length} {worktrees.length === 1 ? 'worktree' : 'worktrees'},{' '}
                    {root ? `from ${shortenHome(root.path)}` : 'added directly'}
                  </span>
                  <span
                    className="block truncate font-mono text-[11px] text-faint"
                    title={project.mainWorktreePath ?? project.commonDir}
                  >
                    {shortenHome(project.mainWorktreePath ?? project.commonDir)}
                  </span>
                </span>
                <span
                  className="shrink-0 text-muted"
                  title="Default branch (base for the branch scope)"
                >
                  {isEditing ? (
                    <form
                      className="flex items-center gap-1"
                      onSubmit={(e) => {
                        e.preventDefault();
                        updateProject.mutate({
                          projectId: project.id,
                          defaultBranchOverride: editing.value.trim() || null,
                        });
                        setEditing(null);
                      }}
                    >
                      <input
                        aria-label="Default branch override"
                        value={editing.value}
                        onChange={(e) => setEditing({ id: project.id, value: e.target.value })}
                        placeholder={project.defaultBranch ?? 'main'}
                        className="od-input w-32 font-mono text-[11px]"
                      />
                      <SmallButton onClick={() => setEditing(null)}>Cancel</SmallButton>
                      <button type="submit" className="od-btn od-btn-primary">
                        Save
                      </button>
                    </form>
                  ) : (
                    <button
                      type="button"
                      onClick={() =>
                        setEditing({ id: project.id, value: project.defaultBranchOverride ?? '' })
                      }
                      className="od-btn od-btn-ghost font-mono"
                      title="Change the default branch"
                    >
                      base: {project.defaultBranch ?? '?'}
                      {project.defaultBranchOverride ? ' (override)' : ''}
                    </button>
                  )}
                </span>
                {confirm === project.id ? (
                  <>
                    <SmallButton
                      onClick={() => removeProject.mutate(project.id)}
                      danger
                      disabled={removeProject.isPending}
                    >
                      Confirm remove
                    </SmallButton>
                    <SmallButton onClick={() => setConfirm(null)}>Keep</SmallButton>
                  </>
                ) : (
                  <SmallButton onClick={() => setConfirm(project.id)} danger>
                    Remove
                  </SmallButton>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {error && <p className="mt-2 text-danger">{describeError(error).detail}</p>}

      <section className="mt-5 rounded-md border border-line bg-surface p-3">
        <AddProjectForm />
      </section>
    </div>
  );
}
