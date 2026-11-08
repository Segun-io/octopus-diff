import { type ApiClient, TEST_IDS } from '@octopus-diff/contracts';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  type EventSourceFactory,
  useFocusReporting,
  useResolvedTheme,
  useServerEvents,
} from './api/hooks.ts';
import {
  ApiContext,
  createBrowserApiClient,
  createQueryClient,
  describeError,
} from './api/queries.ts';
import { AddProjectForm } from './components/AddProjectForm.tsx';
import { BulkReviewToast } from './components/BulkReviewToast.tsx';
import { Dialog } from './components/Dialog.tsx';
import { DiffPane } from './components/diff/DiffPane.tsx';
import { FileList } from './components/FileList.tsx';
import { HelpDialog } from './components/HelpDialog.tsx';
import { MarkAllButton } from './components/MarkAllButton.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { Toolbar } from './components/Toolbar.tsx';
import { toFileRef } from './lib/fileRef.ts';
import { type NavEntry, repairSelection } from './lib/model.ts';
import { useDocumentTitle } from './lib/title.ts';
import { useCommands, useKeyboardShortcuts } from './state/commands.ts';
import { CommandsContext } from './state/commandsContext.tsx';
import { AppModelProvider, useAppModel } from './state/model.tsx';
import { actions, type UiStore, UiStoreProvider, useUi, useUiStore } from './state/ui.tsx';
import { applyTheme } from './theme/apply.ts';
import { useTheme } from './theme/useTheme.ts';

// @pierre/trees (and its preact runtime) only loads when the tree layout is used.
const FileTreeView = lazy(() =>
  import('./components/FileTreeView.tsx').then((m) => ({ default: m.FileTreeView })),
);
// Settings is a separate chunk: it is not needed for the first paint.
const SettingsDialog = lazy(() =>
  import('./components/settings/SettingsDialog.tsx').then((m) => ({ default: m.SettingsDialog })),
);

export interface AppProps {
  api?: ApiClient;
  queryClient?: QueryClient;
  uiStore?: UiStore;
  /** Override the SSE transport (tests); `null` uses the client's fetch-based subscribe. */
  eventSourceFactory?: EventSourceFactory | null;
}

export function App({ api, queryClient, uiStore, eventSourceFactory }: AppProps) {
  const [client] = useState(() => api ?? createBrowserApiClient());
  const [qc] = useState(() => queryClient ?? createQueryClient());
  return (
    <ApiContext value={client}>
      <QueryClientProvider client={qc}>
        <UiStoreProvider {...(uiStore ? { store: uiStore } : {})}>
          <AppModelProvider>
            <AppShell {...(eventSourceFactory !== undefined ? { eventSourceFactory } : {})} />
          </AppModelProvider>
        </UiStoreProvider>
      </QueryClientProvider>
    </ApiContext>
  );
}

function useApplyTheme() {
  const theme = useTheme();
  const density = useUi((s) => s.density);
  useLayoutEffect(() => {
    applyTheme(theme);
    document.documentElement.dataset.density = density;
  }, [theme, density]);
}

/** Keeps the selection valid as data refreshes (PLAN §4.2: preserve selection). */
function useSelectionRepair() {
  const model = useAppModel();
  const store = useUiStore();
  const lastIndex = useRef(0);
  const { entries, globalEntries, visible, viewReady, selectedKey, view } = model;
  const viewKey = view.kind === 'inbox' ? 'inbox' : view.worktreeId;
  const lastView = useRef(viewKey);

  useEffect(() => {
    if (!viewReady) return;
    if (lastView.current !== viewKey) {
      lastView.current = viewKey;
      lastIndex.current = 0;
    }
    const current = selectedKey === null ? undefined : entries.find((e) => e.key === selectedKey);
    if (current) {
      const visibleIndex = entries.filter(visible).indexOf(current);
      if (visibleIndex !== -1) lastIndex.current = visibleIndex;
      return;
    }
    // In the inbox, a selection hidden by the sidebar filters still exists: keep it open.
    if (
      selectedKey !== null &&
      view.kind === 'inbox' &&
      globalEntries.some((e) => e.key === selectedKey)
    ) {
      return;
    }
    const next = repairSelection(entries, selectedKey, lastIndex.current, visible);
    actions.select(store, next ? toFileRef(next.worktreeId, next.file) : null);
  }, [entries, globalEntries, visible, viewReady, selectedKey, viewKey, view.kind, store]);
}

function Notice() {
  const notice = useUi((s) => s.notice);
  const store = useUiStore();
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => store.setState({ notice: null }), 3500);
    return () => clearTimeout(timer);
  }, [notice, store]);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-4 left-1/2 z-40 -translate-x-1/2"
    >
      {notice && (
        <div className="od-fade-in rounded-md border border-line bg-raised px-3 py-1.5 text-xs shadow-lg">
          {notice.text}
        </div>
      )}
    </div>
  );
}

function ErrorBanner({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const info = describeError(error);
  return (
    <div
      data-testid={TEST_IDS.errorBanner}
      data-kind={info.kind}
      role="alert"
      className="m-6 max-w-2xl rounded-lg border border-danger/50 bg-surface p-5"
    >
      <h1 className="text-base font-semibold text-danger">{info.title}</h1>
      <p className="mt-2 text-sm text-muted">{info.detail}</p>
      {info.kind === 'auth' && (
        <pre className="mt-3 rounded bg-canvas p-2 font-mono text-xs">
          octopus-diff serve # prints http://127.0.0.1:7428/?token=…
        </pre>
      )}
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 rounded border border-line px-3 py-1 text-xs hover:bg-hover"
      >
        Retry
      </button>
    </div>
  );
}

function EmptyState() {
  return (
    <div data-testid={TEST_IDS.emptyState} className="mx-auto mt-[10vh] w-[min(560px,92vw)]">
      <h1 className="text-lg font-semibold">Welcome to octopus-diff</h1>
      <p className="mt-1 mb-5 text-sm text-muted">
        Add a repository or a folder to scan. Every worktree of every project shows up here, with
        live diffs as your agents edit code.
      </p>
      <div className="rounded-lg border border-line bg-surface p-4">
        <AddProjectForm />
      </div>
      <p className="mt-4 text-xs text-faint">
        From a terminal: <code className="font-mono">octopus-diff add ~/code/my-repo</code>
      </p>
    </div>
  );
}

/** Above the file list: what is listed, and the bulk action for it. */
function FilePaneHeader() {
  const model = useAppModel();
  const inbox = model.view.kind === 'inbox';
  const total = model.entries.length;
  const shown = model.entries.filter(model.visible).length;
  const unreviewed = model.entries.filter(
    (e) => !e.file.reviewed && !model.disabledWorktrees.has(e.worktreeId),
  ).length;
  const label = inbox
    ? `${model.groups.length} ${model.groups.length === 1 ? 'worktree' : 'worktrees'}`
    : (model.viewPolicy?.enabled ?? true)
      ? `${unreviewed} unreviewed`
      : 'review off';
  return (
    <div className="flex h-[var(--od-row-header)] shrink-0 items-center gap-2 border-b border-line bg-surface px-[var(--od-pad-x)] text-[11px] text-muted">
      <span className="truncate">
        {shown < total ? `${shown}/${total}` : total} {total === 1 ? 'file' : 'files'} · {label}
      </span>
      <span className="ml-auto" />
      <MarkAllButton compact />
    </div>
  );
}

function AppShell({ eventSourceFactory }: { eventSourceFactory?: EventSourceFactory | null }) {
  const model = useAppModel();
  const store = useUiStore();
  const theme = useResolvedTheme();
  const commands = useCommands(model, theme);
  const helpOpen = useUi((s) => s.helpOpen);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const addProjectOpen = useUi((s) => s.addProjectOpen);
  const layout = useUi((s) => s.fileListLayout);
  const selected = useUi((s) => s.selected);
  const titleCount = useUi((s) => s.titleCount);
  const reviewOffDisplay = useUi((s) => s.reviewOffDisplay);

  useApplyTheme();
  useDocumentTitle(model.unreviewedTotal, titleCount);
  useServerEvents(eventSourceFactory);
  const focusWorktree =
    model.view.kind === 'worktree' ? model.view.worktreeId : (selected?.worktreeId ?? null);
  useFocusReporting(focusWorktree);
  useSelectionRepair();

  const projectsData = model.projects.data;
  const hasProjects = (projectsData?.projects.length ?? 0) > 0;
  const ready = projectsData !== undefined && model.inbox.data !== undefined;
  useKeyboardShortcuts(commands, ready && hasProjects);

  const onSelectEntry = useCallback((entry: NavEntry) => commands.selectEntry(entry), [commands]);

  let body: React.ReactNode;
  if (model.projects.isError && !projectsData) {
    body = (
      <ErrorBanner error={model.projects.error} onRetry={() => void model.projects.refetch()} />
    );
  } else if (!projectsData) {
    body = (
      <p className="p-6 text-sm text-muted" role="status">
        Connecting to the octopus-diff daemon…
      </p>
    );
  } else if (!hasProjects) {
    body = <EmptyState />;
  } else {
    const inbox = model.view.kind === 'inbox';
    const useTree = !inbox && layout === 'tree';
    body = (
      <div className="grid h-full min-h-0 grid-cols-[minmax(200px,260px)_minmax(240px,340px)_1fr] grid-rows-[auto_1fr]">
        <div className="row-span-2 min-h-0">
          <Sidebar />
        </div>
        <div className="col-span-2">
          <Toolbar />
        </div>
        <div className="flex min-h-0 flex-col border-r border-line bg-surface">
          {model.projects.isError && (
            <div
              data-testid={TEST_IDS.errorBanner}
              role="alert"
              className="border-b border-line bg-raised px-2 py-1 text-xs text-danger"
            >
              {describeError(model.projects.error).title}: showing the last known state.
            </div>
          )}
          {model.inbox.isError && !model.inbox.data && (
            <div
              data-testid={TEST_IDS.errorBanner}
              role="alert"
              className="px-2 py-1 text-xs text-danger"
            >
              Inbox: {describeError(model.inbox.error).detail}
            </div>
          )}
          <FilePaneHeader />
          <div className="min-h-0 flex-1">
            {!model.viewReady && model.files.isError ? (
              <p role="alert" className="p-3 text-xs text-danger">
                {describeError(model.files.error).detail}
              </p>
            ) : !model.viewReady ? (
              <p className="p-3 text-xs text-muted" role="status">
                Loading files…
              </p>
            ) : useTree ? (
              <Suspense fallback={<p className="p-3 text-xs text-muted">Loading tree…</p>}>
                <FileTreeView
                  entries={model.entries.filter(model.visible)}
                  selectedKey={model.selectedKey}
                  onSelect={onSelectEntry}
                  theme={theme}
                />
              </Suspense>
            ) : (
              <FileList
                groups={model.groups}
                disabled={model.disabledWorktrees}
                dimDisabled={reviewOffDisplay === 'dim'}
                entries={model.entries}
                visible={model.visible}
                selectedKey={model.selectedKey}
                grouped={inbox}
                onSelect={onSelectEntry}
                emptyMessage={
                  inbox
                    ? 'Inbox zero: no dirty worktrees in this scope.'
                    : 'No changes in this scope.'
                }
              />
            )}
          </div>
        </div>
        <div className="min-h-0 min-w-0">
          <DiffPane />
        </div>
      </div>
    );
  }

  return (
    <CommandsContext value={commands}>
      <main
        data-testid={TEST_IDS.app}
        data-ready={String(ready)}
        data-theme={theme}
        className="h-full min-h-0 bg-canvas text-fg"
      >
        {body}
        {helpOpen && <HelpDialog />}
        {settingsOpen && (
          <Suspense fallback={null}>
            <SettingsDialog />
          </Suspense>
        )}
        <BulkReviewToast />
        {addProjectOpen && (
          <Dialog title="Add project" onClose={() => store.setState({ addProjectOpen: false })}>
            <AddProjectForm />
          </Dialog>
        )}
        <Notice />
      </main>
    </CommandsContext>
  );
}
