import './zod-config.ts';
import { type ApiClient, TEST_IDS } from '@octopus-diff/contracts';
import { type QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useForgeIndex } from './api/forges.ts';
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
import { AddJobToast, useAddJobWatcher } from './components/AddJobStatus.tsx';
import { AddProjectForm } from './components/AddProjectForm.tsx';
import { BulkReviewToast } from './components/BulkReviewToast.tsx';
import { ContextBar } from './components/ContextBar.tsx';
import { CopyToastHost } from './components/CopyButton.tsx';
import { Dialog } from './components/Dialog.tsx';
import { DiffPane } from './components/diff/DiffPane.tsx';
import { FileList } from './components/FileList.tsx';
import { FilePaneHeader } from './components/FilePaneHeader.tsx';
import { HelpDialog } from './components/HelpDialog.tsx';
import { Mark } from './components/Mark.tsx';
import { OriginGroupHeader } from './components/OriginGroupHeader.tsx';
import { Sidebar } from './components/Sidebar.tsx';
import { SkeletonLines, StaleNote, WaitNote } from './components/WaitNote.tsx';
import { useFaviconDot } from './lib/favicon.ts';
import { toFileRef } from './lib/fileRef.ts';
import {
  hasSidebarFilters,
  type NavEntry,
  repairSelection,
  type WorktreeRow,
  worktreeLabel,
} from './lib/model.ts';
import { useDocumentTitle } from './lib/title.ts';
import { useDelayedFlag } from './lib/useWait.ts';
import { LOCAL_WAIT } from './lib/wait.ts';
import { useCommands, useKeyboardShortcuts } from './state/commands.ts';
import { CommandsContext } from './state/commandsContext.tsx';
import { AppModelProvider, useAppModel } from './state/model.tsx';
import { actions, type UiStore, UiStoreProvider, useUi, useUiStore } from './state/ui.tsx';
import { applyTheme } from './theme/apply.ts';
import { useTheme } from './theme/useTheme.ts';
import { activeView } from './views/registry.ts';

// @pierre/trees (and its preact runtime) only loads when the tree layout is used.
const FileTreeView = lazy(() =>
  import('./components/FileTreeView.tsx').then((m) => ({ default: m.FileTreeView })),
);
// Settings, the palette and the Overview are separate chunks: not needed for the first paint.
const SettingsDialog = lazy(() =>
  import('./components/settings/SettingsDialog.tsx').then((m) => ({ default: m.SettingsDialog })),
);
const CommandPalette = lazy(() =>
  import('./components/CommandPalette.tsx').then((m) => ({ default: m.CommandPalette })),
);
const Overview = lazy(() =>
  import('./components/Overview.tsx').then((m) => ({ default: m.Overview })),
);
// The Request tab (and its markdown renderer) loads when first opened.
const RequestView = lazy(() =>
  import('./components/request/RequestView.tsx').then((m) => ({ default: m.RequestView })),
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
  const { entries, visible, viewReady, selectedKey, view } = model;
  const viewKey =
    view.kind === 'worktree'
      ? view.worktreeId
      : view.kind === 'folder'
        ? `folder:${view.scanRootId}`
        : view.kind === 'project'
          ? `project:${view.projectId}`
          : 'none';
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
    const next = repairSelection(entries, selectedKey, lastIndex.current, visible);
    actions.select(store, next ? toFileRef(next.worktreeId, next.file) : null);
  }, [entries, visible, viewReady, selectedKey, viewKey, store]);
}

/**
 * Where the app lands (#83): with nothing open (a fresh load, or the open worktree was removed)
 * it opens the worktree that was open last when it is still there, else the top row of the list
 * (pinned first, then the latest activity). With no row it stays on the empty state. The
 * worktree that is open is remembered (`lastWorktree`) for the next load.
 */
function useLanding() {
  const model = useAppModel();
  const store = useUiStore();
  const { view, projects, sidebar } = model;
  const lastWorktree = useUi((s) => s.lastWorktree);
  const loaded = projects.data !== undefined;
  const openId = view.kind === 'worktree' ? view.worktreeId : null;
  const missing = openId !== null && !sidebar.byId.has(openId);
  // Only a row of the list counts (the filters apply): the last worktree if it is there, else the top.
  const pick =
    (lastWorktree && sidebar.order.includes(lastWorktree) ? lastWorktree : null) ??
    sidebar.order[0];

  useEffect(() => {
    if (!loaded) return;
    if ((view.kind === 'none' || missing) && pick) {
      actions.setView(store, { kind: 'worktree', worktreeId: pick });
    }
  }, [loaded, view.kind, missing, pick, store]);

  // The list the pane may show, for `actions.setView` (it clears the filters that hide a picked worktree).
  const { listedIds } = model;
  useEffect(() => {
    store.setState({ listed: loaded ? listedIds : null });
  }, [loaded, listedIds, store]);

  useEffect(() => {
    if (openId !== null && !missing && lastWorktree !== openId) {
      store.setState({ lastWorktree: openId });
    }
  }, [openId, missing, lastWorktree, store]);
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
      data-testid="notice"
      className="pointer-events-none fixed bottom-4 left-1/2 z-40 -translate-x-1/2"
    >
      {notice && (
        <div className="od-overlay od-fade-in rounded-md px-3 py-1.5 text-xs">{notice.text}</div>
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
        <pre className="mt-3 rounded-md bg-canvas p-2 font-mono text-xs">
          octopus-diff serve # prints http://127.0.0.1:7428/#token=…
        </pre>
      )}
      <button type="button" onClick={onRetry} className="od-btn mt-4">
        Retry
      </button>
    </div>
  );
}

function EmptyState() {
  return (
    <div data-testid={TEST_IDS.emptyState} className="mx-auto mt-[8vh] w-[min(600px,92vw)]">
      <div className="od-settle mb-5 flex items-center gap-4">
        <Mark size={56} className="text-accent" />
        <div>
          <h1 className="text-lg font-semibold">
            octopus<span className="font-mono font-normal text-muted">-diff</span>
          </h1>
          <p className="text-sm text-muted">Nothing is watched yet.</p>
        </div>
      </div>
      <p className="mb-4 text-sm text-muted">
        Pick the folder where your repositories and worktrees live, then press{' '}
        <span className="font-medium text-fg">Continue</span>. Every repository inside it shows up
        here, and the diffs update as files change. You can also pick a single repository. Nothing
        is ever written to a repository.
      </p>
      <div className="rounded-lg border border-line bg-surface p-4">
        <AddProjectForm variant="onboarding" autoFocus />
      </div>
      <p className="mt-4 text-xs text-faint">
        From a terminal: <code className="font-mono">octopus-diff scan ~/code</code> or{' '}
        <code className="font-mono">octopus-diff add ~/code/my-repo</code>
      </p>
    </div>
  );
}

/**
 * The main pane when the open worktree is not in the list the sidebar shows (#83). `empty`: the
 * list has no row at all (every worktree is filtered out or gone; no project at all is the
 * onboarding screen). `hidden`: rows are listed but the filters leave the open worktree out; it
 * stays the open view, so clearing the filters brings its pane back. Says what to do.
 */
function NoWorktree({
  reason,
  open,
  first,
}: {
  reason: 'empty' | 'hidden';
  open?: WorktreeRow;
  first?: WorktreeRow;
}) {
  const store = useUiStore();
  const filtered = useUi((s) =>
    hasSidebarFilters({
      folders: s.filterFolders,
      projects: s.filterProjects,
      worktrees: s.filterWorktrees,
      onlyDirty: s.onlyDirty,
      onlyUnreviewed: s.onlyUnreviewed,
    }),
  );
  const clear = () =>
    store.setState({
      filterFolders: [],
      filterProjects: [],
      filterWorktrees: [],
      onlyDirty: false,
      onlyUnreviewed: false,
    });
  return (
    <div
      data-testid="no-worktree"
      data-reason={reason}
      className="mx-auto mt-[8vh] w-[min(480px,92vw)] p-4 text-sm"
    >
      <h1 className="mb-2 text-base font-semibold">
        {reason === 'hidden' ? 'The open worktree is hidden by the filters' : 'No worktree to show'}
      </h1>
      <p className="mb-4 text-muted">
        {reason === 'hidden' && open
          ? `${open.project.name} ${worktreeLabel(open.worktree)} is not in the list the sidebar shows. Clear the filters to see it again, or open the first worktree in the list.`
          : filtered
            ? 'The filters in the sidebar hide every worktree. Clear them to see the list again, or add a folder to watch.'
            : 'Add a folder to watch: every repository inside it shows up in the list.'}
      </p>
      <div className="flex flex-wrap gap-2">
        {filtered && (
          <button type="button" className="od-btn" onClick={clear}>
            Clear filters
          </button>
        )}
        {reason === 'hidden' && first && (
          <button
            type="button"
            className="od-btn"
            onClick={() =>
              actions.setView(store, { kind: 'worktree', worktreeId: first.worktree.id })
            }
          >
            Open the first worktree in the list ({first.project.name}{' '}
            {worktreeLabel(first.worktree)})
          </button>
        )}
        {reason === 'empty' && (
          <button
            type="button"
            className="od-btn"
            onClick={() => store.setState({ addProjectOpen: true })}
          >
            Add repositories…
          </button>
        )}
      </div>
    </div>
  );
}

/** First paint before the projects list arrives: the shell's shape, nothing jumping later. */
function LoadingSkeleton() {
  // Named only after the threshold: a cold start that paints in 150 ms flashes no text.
  const slow = useDelayedFlag(true);
  return (
    <div
      role="status"
      aria-label="Connecting to the octopus-diff daemon"
      className="grid h-full min-h-0 grid-cols-[minmax(200px,260px)_minmax(240px,340px)_1fr]"
    >
      <div className="border-r border-line bg-surface p-3">
        <div className="mb-4 flex items-center gap-2 text-faint">
          <Mark size={16} />
          <span className="text-xs">{slow ? 'Connecting…' : ''}</span>
        </div>
        {[72, 48, 64, 40, 56].map((w, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
            key={i}
            className="mb-2 h-3 rounded-sm bg-raised"
            style={{ width: `${w}%` }}
          />
        ))}
      </div>
      <div className="border-r border-line bg-surface p-3">
        {[80, 60, 70, 50, 65, 75].map((w, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: static placeholder rows
            key={i}
            className="mb-2.5 h-3 rounded-sm bg-raised"
            style={{ width: `${w}%` }}
          />
        ))}
      </div>
      <div />
    </div>
  );
}

/**
 * The tree layout's "from main" group: a bar under the tree (the tree itself cannot host a
 * sub-group). Expanded, the files join the tree, tagged with how they arrived.
 */
function TreeOriginBar() {
  const model = useAppModel();
  const store = useUiStore();
  if (model.view.kind !== 'worktree' || model.originView.fromMainOnly) return null;
  const id = model.view.worktreeId;
  const stats = model.originStats.get(id);
  if (!stats || stats.base === 0) return null;
  return (
    <OriginGroupHeader
      worktreeId={id}
      stats={stats}
      integrationRef={model.originRefs.get(id) ?? 'main'}
      open={model.originView.expanded.has(id)}
      onToggle={(worktreeId) => actions.toggleOriginGroup(store, worktreeId)}
      className="h-(--od-row) shrink-0"
    />
  );
}

function AppShell({ eventSourceFactory }: { eventSourceFactory?: EventSourceFactory | null }) {
  const model = useAppModel();
  const store = useUiStore();
  const theme = useResolvedTheme();
  const commands = useCommands(model, theme);
  const helpOpen = useUi((s) => s.helpOpen);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const paletteOpen = useUi((s) => s.paletteOpen);
  const addProjectOpen = useUi((s) => s.addProjectOpen);
  const layout = useUi((s) => s.fileListLayout);
  const selected = useUi((s) => s.selected);
  const titleCount = useUi((s) => s.titleCount);

  useApplyTheme();
  useDocumentTitle(model.unreviewedTotal, titleCount);
  useFaviconDot(titleCount && model.unreviewedTotal > 0);
  useServerEvents(eventSourceFactory);
  useAddJobWatcher();
  const focusWorktree =
    model.view.kind === 'worktree' ? model.view.worktreeId : (selected?.worktreeId ?? null);
  // The project Overview opens its project too: the daemon computes review states on demand (#10).
  useFocusReporting(focusWorktree, model.view.kind === 'project' ? model.view.projectId : null);
  useSelectionRepair();
  useLanding();
  const toggleOrigin = useCallback(
    (worktreeId: string) => actions.toggleOriginGroup(store, worktreeId),
    [store],
  );
  const origin = useMemo(
    () => ({
      view: model.originView,
      stats: model.originStats,
      refs: model.originRefs,
      onToggle: toggleOrigin,
    }),
    [model.originView, model.originStats, model.originRefs, toggleOrigin],
  );

  const projectsData = model.projects.data;
  const hasProjects = (projectsData?.projects.length ?? 0) > 0;
  // First paint is the sidebar from `/api/projects` (#10); the review data fills in afterwards.
  const ready = projectsData !== undefined;
  useKeyboardShortcuts(commands, ready && hasProjects);

  const onSelectEntry = useCallback((entry: NavEntry) => commands.selectEntry(entry), [commands]);
  const forgeIndex = useForgeIndex();
  const viewWorktreeId = model.view.kind === 'worktree' ? model.view.worktreeId : null;
  const hasRequest =
    viewWorktreeId !== null && !!forgeIndex.get(viewWorktreeId)?.worktree.changeRequest;
  const viewId = model.view.kind === 'none' ? null : activeView(model.view, { hasRequest }).id;

  let body: React.ReactNode;
  if (model.projects.isError && !projectsData) {
    body = (
      <ErrorBanner error={model.projects.error} onRetry={() => void model.projects.refetch()} />
    );
  } else if (!projectsData) {
    body = <LoadingSkeleton />;
  } else if (!hasProjects) {
    body = <EmptyState />;
  } else if (viewId === 'request' && viewWorktreeId !== null) {
    body = (
      <div className="grid h-full min-h-0 grid-cols-[minmax(200px,260px)_1fr] grid-rows-[auto_1fr]">
        <div className="row-span-2 min-h-0">
          <Sidebar />
        </div>
        <div>
          <ContextBar />
        </div>
        <div className="min-h-0 min-w-0 bg-canvas">
          <Suspense fallback={<p className="p-5 text-xs text-muted">Loading…</p>}>
            <RequestView key={viewWorktreeId} worktreeId={viewWorktreeId} />
          </Suspense>
        </div>
      </div>
    );
  } else if (model.view.kind === 'none' || !model.viewListed) {
    // Nothing is open, or the open worktree is not a row of the list the sidebar shows (the
    // filters leave it out, or it is gone): the pane says so instead of keeping a stale worktree
    // on screen. The landing effect opens a row as soon as there is one to open.
    const open =
      model.view.kind === 'worktree' ? model.sidebar.byId.get(model.view.worktreeId) : null;
    const first = model.sidebar.byId.get(model.sidebar.order[0] ?? '');
    body = (
      <div className="grid h-full min-h-0 grid-cols-[minmax(200px,260px)_1fr]">
        <div className="min-h-0">
          <Sidebar />
        </div>
        <div className="min-h-0 min-w-0 bg-canvas">
          {first === undefined ? (
            <NoWorktree reason="empty" />
          ) : open ? (
            <NoWorktree reason="hidden" open={open} first={first} />
          ) : null}
        </div>
      </div>
    );
  } else if (viewId === 'overview' && model.view.kind !== 'worktree') {
    const view = model.view;
    body = (
      <div className="grid h-full min-h-0 grid-cols-[minmax(200px,260px)_1fr]">
        <div className="min-h-0">
          <Sidebar />
        </div>
        <div className="min-h-0 min-w-0 bg-canvas">
          <Suspense fallback={<p className="p-5 text-xs text-muted">Loading overview…</p>}>
            <Overview view={view} />
          </Suspense>
        </div>
      </div>
    );
  } else {
    const useTree = layout === 'tree';
    body = (
      <div className="grid h-full min-h-0 grid-cols-[minmax(200px,260px)_minmax(240px,340px)_1fr] grid-rows-[auto_1fr]">
        <div className="row-span-2 min-h-0">
          <Sidebar />
        </div>
        <div className="col-span-2">
          <ContextBar />
        </div>
        <div className="relative flex min-h-0 flex-col border-r border-line bg-surface">
          {model.projects.isError && (
            <>
              <div
                data-testid={TEST_IDS.errorBanner}
                role="alert"
                className="bg-raised px-2 py-1 text-xs text-danger"
              >
                {describeError(model.projects.error).title}: showing the last known state.
              </div>
              {projectsData && (
                <div className="border-b border-line bg-raised px-2 pb-1">
                  <StaleNote
                    updatedAt={model.projects.dataUpdatedAt}
                    onRefresh={() => void model.projects.refetch()}
                    refreshing={model.projects.isFetching}
                  />
                </div>
              )}
            </>
          )}
          <FilePaneHeader />
          <div className="min-h-0 flex-1">
            {!model.viewReady && model.files.isError ? (
              <p role="alert" className="p-3 text-xs text-danger">
                {describeError(model.files.error).detail}
              </p>
            ) : !model.viewReady ? (
              <div className="p-3">
                <SkeletonLines widths={[80, 60, 70, 50, 65]} />
                <WaitNote active source={LOCAL_WAIT} />
              </div>
            ) : useTree ? (
              <div className="flex h-full min-h-0 flex-col">
                <div className="min-h-0 flex-1">
                  <Suspense fallback={<p className="p-3 text-xs text-muted">Loading tree…</p>}>
                    <FileTreeView
                      entries={model.entries.filter(model.visible)}
                      selectedKey={model.selectedKey}
                      onSelect={onSelectEntry}
                      theme={theme}
                      worktreePathOf={(id) => model.sidebar.byId.get(id)?.worktree.path}
                    />
                  </Suspense>
                </div>
                <TreeOriginBar />
              </div>
            ) : (
              <FileList
                groups={model.groups}
                entries={model.entries}
                visible={model.visible}
                selectedKey={model.selectedKey}
                onSelect={onSelectEntry}
                origin={origin}
                emptyMessage="No changes in this scope."
              />
            )}
          </div>
          <WaitNote
            variant="float"
            active={model.viewReady && model.files.isFetching}
            source={LOCAL_WAIT}
          />
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
        {paletteOpen && (
          <Suspense fallback={null}>
            <CommandPalette />
          </Suspense>
        )}
        <BulkReviewToast />
        <CopyToastHost />
        {addProjectOpen && (
          <Dialog
            title="Add repositories"
            onClose={() => store.setState({ addProjectOpen: false })}
          >
            <AddProjectForm
              autoFocus
              onOpen={(view) => {
                store.setState({ addProjectOpen: false });
                actions.setView(store, view);
              }}
            />
          </Dialog>
        )}
        <AddJobToast />
        <Notice />
      </main>
    </CommandsContext>
  );
}
