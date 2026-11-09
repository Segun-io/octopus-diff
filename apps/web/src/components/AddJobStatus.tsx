/**
 * What happens after "Add" / "Watch" (state/addJob.ts): a status panel inside the add forms and a
 * toast once no form is on screen (the first-run screen is replaced by the app as soon as the
 * first repository appears; the dialog and the palette may close while a folder is scanned).
 *
 * `useAddJobWatcher` (mounted once by the app shell) follows folder scans: it polls the scan
 * roots while one runs (even after its message is dismissed or replaced), so the outcome and the new repositories show up even when the event
 * stream is late or down (a proxy that buffers it, a reconnect), and then refetches the projects.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { describeError, queryKeys, useApi, useProjectsQuery } from '../api/queries.ts';
import {
  type AddJob,
  type AddJobAction,
  type AddJobSummary,
  describeAddJob,
  folderJobOutcome,
  scanFollowDone,
} from '../state/addJob.ts';
import { actions, type UiStore, useUi, useUiStore } from '../state/ui.tsx';
import { CheckIcon, CloseIcon, SpinnerIcon, WarningIcon } from './bits.tsx';

/** Test ids (web only) of the add-job status. */
export const ADD_JOB_TEST_IDS = {
  panel: 'add-job-status',
  toast: 'add-job-toast',
  action: 'add-job-action',
} as const;

const POLL_MS = 1000;
const SUCCESS_TOAST_MS = 10_000;

/**
 * Follows folder scans to their outcome (`UiState.scanFollows`, kept even when the job's message
 * is dismissed or replaced) and settles the current folder job. Mount once.
 */
export function useAddJobWatcher() {
  const api = useApi();
  const store = useUiStore();
  const queryClient = useQueryClient();
  const job = useUi((s) => s.addJob);
  const scan = useUi((s) => s.scan);
  const follows = useUi((s) => s.scanFollows);
  const following = follows.length > 0;
  const roots = useQuery({
    queryKey: queryKeys.scanRoots(),
    queryFn: () => api.listScanRoots(),
    enabled: following,
    refetchInterval: following ? POLL_MS : false,
  });
  const scanRoot =
    job?.kind === 'folder' ? roots.data?.scanRoots.find((r) => r.id === job.scanRootId) : undefined;

  // While scanning, projects are registered one by one: refetch them with the poll too, so the
  // first-run screen gives way to the app as soon as the first one exists.
  const polledAt = roots.dataUpdatedAt;
  const followedFound = follows.reduce(
    (n, f) => n + (roots.data?.scanRoots.find((r) => r.id === f.scanRootId)?.projectCount ?? 0),
    0,
  );
  useEffect(() => {
    if (!following || polledAt === 0) return;
    if (followedFound > 0) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
    }
  }, [following, polledAt, followedFound, queryClient]);

  // Stop following finished scans, and fetch what they found.
  const rootsData = roots.data;
  useEffect(() => {
    if (follows.length === 0) return;
    const listed = rootsData ? { scanRoots: rootsData.scanRoots, updatedAt: polledAt } : undefined;
    const done = follows.filter((f) => scanFollowDone(f, listed, scan));
    if (done.length === 0) return;
    store.setState((s) => ({ scanFollows: s.scanFollows.filter((f) => !done.includes(f)) }));
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll() }),
    ]);
  }, [follows, rootsData, polledAt, scan, store, queryClient]);

  useEffect(() => {
    if (job?.kind !== 'folder') return;
    const outcome = folderJobOutcome(job, scanRoot, scan);
    if (!outcome) return;
    store.setState((s) =>
      s.addJob?.id === job.id ? { addJob: { ...job, ...outcome } as AddJob } : {},
    );
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.projects() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll() }),
    ]);
  }, [job, scanRoot, scan, store, queryClient]);
}

/** Registers an add form on screen (the toast waits until none is). */
export function useAddFormPresence() {
  const store = useUiStore();
  useEffect(() => {
    store.setState((s) => ({ addFormsOpen: s.addFormsOpen + 1 }));
    return () => store.setState((s) => ({ addFormsOpen: Math.max(0, s.addFormsOpen - 1) }));
  }, [store]);
}

function useSummary(): { job: AddJob | null; summary: AddJobSummary | null } {
  const job = useUi((s) => s.addJob);
  const scan = useUi((s) => s.scan);
  const projects = useProjectsQuery();
  if (!job) return { job: null, summary: null };
  return { job, summary: describeAddJob(job, { scan, projects: projects.data?.projects }) };
}

function useRunAction(onRetry?: () => void) {
  const store = useUiStore();
  const api = useApi();
  const queryClient = useQueryClient();
  return async (job: AddJob, action: AddJobAction) => {
    if (action.id === 'open' && action.view) {
      store.setState({ addJob: null, addProjectOpen: false, settingsOpen: false });
      actions.setView(store, action.view);
      return;
    }
    if (action.id === 'stop-watching' && job.kind === 'folder' && job.scanRootId) {
      try {
        await api.removeScanRoot(job.scanRootId);
        const stopped = job.scanRootId;
        store.setState((s) => ({
          scanFollows: s.scanFollows.filter((f) => f.scanRootId !== stopped),
        }));
        await queryClient.invalidateQueries({ queryKey: queryKeys.scanRoots() });
        dismiss(store, job.id);
        actions.notice(store, `Stopped watching ${job.path}.`);
      } catch (error) {
        store.setState((s) =>
          s.addJob?.id === job.id
            ? { addJob: { ...job, state: 'error', error: describeError(error).detail } }
            : {},
        );
      }
      return;
    }
    dismiss(store, job.id);
    if (action.id === 'retry') onRetry?.();
  };
}

function dismiss(store: UiStore, id: number) {
  store.setState((s) => (s.addJob?.id === id ? { addJob: null } : {}));
}

function ToneIcon({ tone }: { tone: AddJobSummary['tone'] }) {
  if (tone === 'working') return <SpinnerIcon size={14} className="shrink-0 text-accent" />;
  if (tone === 'success') {
    return (
      <span className="flex shrink-0 text-add">
        <CheckIcon />
      </span>
    );
  }
  return (
    <WarningIcon
      size={14}
      className={`shrink-0 ${tone === 'error' ? 'text-danger' : 'text-warn'}`}
    />
  );
}

function SummaryBody({
  job,
  summary,
  onAction,
}: {
  job: AddJob;
  summary: AddJobSummary;
  onAction: (job: AddJob, action: AddJobAction) => void;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="mt-0.5 flex">
        <ToneIcon tone={summary.tone} />
      </span>
      <div className="min-w-0 flex-1">
        <p className={`font-medium ${summary.tone === 'error' ? 'text-danger' : 'text-fg'}`}>
          {summary.title}
        </p>
        {summary.detail && <p className="mt-0.5 text-muted">{summary.detail}</p>}
        {summary.names.length > 0 && (
          <p className="mt-1 text-muted">
            {summary.names.map((name, i) => (
              <span key={name}>
                {i > 0 && ', '}
                <span className="font-mono text-fg">{name}</span>
              </span>
            ))}
            {summary.more > 0 && ` and ${summary.more} more`}
          </p>
        )}
        {summary.actions.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {summary.actions.map((action, i) => (
              <button
                key={action.id}
                type="button"
                data-testid={ADD_JOB_TEST_IDS.action}
                data-action={action.id}
                onClick={() => onAction(job, action)}
                className={`od-btn ${i === 0 && action.id === 'open' ? 'od-btn-primary' : ''}`}
              >
                {action.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** The status of the current add job, inside an add form. */
export function AddJobPanel({ onRetry }: { onRetry?: () => void }) {
  const { job, summary } = useSummary();
  const run = useRunAction(onRetry);
  if (!job || !summary) return null;
  return (
    <div
      data-testid={ADD_JOB_TEST_IDS.panel}
      data-kind={job.kind}
      data-tone={summary.tone}
      role={summary.tone === 'error' ? 'alert' : 'status'}
      aria-busy={summary.tone === 'working'}
      className={`od-fade-in rounded-md border px-3 py-2 ${
        summary.tone === 'error'
          ? 'border-danger/50'
          : summary.tone === 'empty'
            ? 'border-warn/50'
            : 'border-line'
      } bg-raised`}
    >
      <SummaryBody job={job} summary={summary} onAction={(j, a) => void run(j, a)} />
    </div>
  );
}

/** The add job's status once no add form is on screen. Mount once. */
export function AddJobToast() {
  const store = useUiStore();
  const formsOpen = useUi((s) => s.addFormsOpen);
  const { job, summary } = useSummary();
  const run = useRunAction(() => store.setState({ addProjectOpen: true }));
  const tone = summary?.tone;
  const id = job?.id;
  useEffect(() => {
    if (tone !== 'success' || id === undefined || formsOpen > 0) return;
    const timer = setTimeout(() => dismiss(store, id), SUCCESS_TOAST_MS);
    return () => clearTimeout(timer);
  }, [tone, id, formsOpen, store]);
  if (!job || !summary || formsOpen > 0) return null;
  return (
    <div
      data-testid={ADD_JOB_TEST_IDS.toast}
      data-kind={job.kind}
      data-tone={summary.tone}
      role={summary.tone === 'error' ? 'alert' : 'status'}
      aria-busy={summary.tone === 'working'}
      className="od-overlay od-slide-up fixed right-4 bottom-4 z-40 w-[min(380px,calc(100vw-2rem))] rounded-lg p-3 text-xs"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <SummaryBody job={job} summary={summary} onAction={(j, a) => void run(j, a)} />
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => dismiss(store, job.id)}
          className="od-btn od-btn-ghost -mt-1 -mr-1 h-6 px-1"
        >
          <CloseIcon size={12} />
        </button>
      </div>
    </div>
  );
}
