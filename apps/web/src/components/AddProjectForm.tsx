import { SCAN_DEPTH_DEFAULT, SCAN_DEPTH_MAX, TEST_IDS } from '@octopus-diff/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { describeError, queryKeys, useApi } from '../api/queries.ts';
import { useUi } from '../state/ui.tsx';

/** Minimal add-project / add-scan-root form (DECISIONS #22). */
export function AddProjectForm({ onDone }: { onDone?: () => void }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const scan = useUi((s) => s.scan);
  const [projectPath, setProjectPath] = useState('');
  const [scanPath, setScanPath] = useState('');
  const [depth, setDepth] = useState(SCAN_DEPTH_DEFAULT);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.scanRoots() }),
    ]);

  const addProject = useMutation({
    mutationFn: (path: string) => api.addProject({ path }),
    onSuccess: async (res) => {
      setProjectPath('');
      setMessage(
        res.created
          ? `Added ${res.project.project.name}.`
          : `${res.project.project.name} was already registered.`,
      );
      await refresh();
      onDone?.();
    },
  });
  const addScanRoot = useMutation({
    mutationFn: (path: string) => api.addScanRoot({ path, depth }),
    onSuccess: async (res) => {
      setScanPath('');
      setMessage(
        res.created
          ? `Scanning ${res.scanRoot.path}…`
          : `${res.scanRoot.path} is already a scan folder.`,
      );
      await refresh();
    },
  });

  const error = addProject.error ?? addScanRoot.error;

  return (
    <div className="flex flex-col gap-4 text-xs">
      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (projectPath.trim()) addProject.mutate(projectPath.trim());
        }}
      >
        <label htmlFor="add-project-path" className="font-semibold">
          Add a repository
        </label>
        <p className="text-muted">Any folder inside a git repo, including a linked worktree.</p>
        <div className="flex gap-2">
          <input
            id="add-project-path"
            data-testid={TEST_IDS.addProjectPathInput}
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
            placeholder="~/code/my-repo"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-line bg-canvas px-2 py-1 font-mono"
          />
          <button
            type="submit"
            data-testid={TEST_IDS.addProjectSubmit}
            disabled={addProject.isPending}
            className="rounded bg-accent px-3 py-1 font-medium text-accent-fg disabled:opacity-50"
          >
            {addProject.isPending ? 'Adding…' : 'Add'}
          </button>
        </div>
      </form>

      <form
        className="flex flex-col gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (scanPath.trim()) addScanRoot.mutate(scanPath.trim());
        }}
      >
        <label htmlFor="add-scan-root-path" className="font-semibold">
          Scan a folder for repositories
        </label>
        <p className="text-muted">
          Every repo (and its worktrees) found up to the given depth is added.
        </p>
        <div className="flex gap-2">
          <input
            id="add-scan-root-path"
            data-testid={TEST_IDS.addScanRootPathInput}
            value={scanPath}
            onChange={(e) => setScanPath(e.target.value)}
            placeholder="~/code"
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded border border-line bg-canvas px-2 py-1 font-mono"
          />
          <label className="flex items-center gap-1 text-muted">
            depth
            <input
              type="number"
              min={0}
              max={SCAN_DEPTH_MAX}
              value={depth}
              onChange={(e) =>
                setDepth(Math.max(0, Math.min(SCAN_DEPTH_MAX, Number(e.target.value) || 0)))
              }
              className="w-12 rounded border border-line bg-canvas px-1 py-1"
            />
          </label>
          <button
            type="submit"
            data-testid={TEST_IDS.addScanRootSubmit}
            disabled={addScanRoot.isPending}
            className="rounded bg-accent px-3 py-1 font-medium text-accent-fg disabled:opacity-50"
          >
            {addScanRoot.isPending ? 'Adding…' : 'Scan'}
          </button>
        </div>
      </form>

      <div aria-live="polite" className="min-h-4">
        {error && <p className="text-danger">{describeError(error).detail}</p>}
        {!error && message && <p className="text-muted">{message}</p>}
        {scan && (
          <p className="text-muted">
            Scan {scan.state}: {scan.scannedDirs} folders, {scan.foundRepos} repositories
            {scan.message ? ` — ${scan.message}` : ''}
          </p>
        )}
      </div>
    </div>
  );
}
