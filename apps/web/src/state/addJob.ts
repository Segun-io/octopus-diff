/**
 * Feedback for "add a repository" / "watch a folder" (onboarding, the Add dialog, Settings →
 * Folders and the palette's browse mode). One job at a time lives in the UI store, so it outlives
 * the form that started it: the first-run screen unmounts as soon as the first project appears,
 * and the dialog or the palette may close while a folder is still being scanned. Pure functions
 * here; the hooks and components are in `components/AddJobStatus.tsx`.
 */
import type { ProjectListItem, ScanRoot } from '@octopus-diff/contracts';
import type { ScanStatus, View } from './ui.tsx';

export type AddJob =
  | {
      id: number;
      kind: 'repo';
      /** Display path of what was submitted. */
      path: string;
      state: 'working' | 'done' | 'error';
      projectId?: string;
      name?: string;
      /** False: it was already added. */
      created?: boolean;
      worktrees?: number;
      error?: string;
      dismissed?: boolean;
    }
  | {
      id: number;
      kind: 'folder';
      path: string;
      depth: number;
      state: 'working' | 'done' | 'error';
      scanRootId?: string;
      created?: boolean;
      /**
       * `lastScannedAt` of the scan root when the request returned: the scan this job started is
       * done once the value is later (null → a time for a new folder).
       */
      scannedBefore?: string | null;
      /** Repositories registered through this folder, once the scan is done. */
      found?: number;
      error?: string;
      dismissed?: boolean;
    };

/**
 * A folder scan the UI follows to its end, kept apart from the job's message: dismissing the
 * message or starting another add must not stop fetching what the scan finds when the event
 * stream is down (components/AddJobStatus.tsx `useAddJobWatcher`).
 */
export interface ScanFollow {
  scanRootId: string;
  /** `lastScannedAt` when the watch request returned. */
  scannedBefore: string | null;
  /** `Date.now()` when the follow started: scan-root lists fetched earlier say nothing about it. */
  since: number;
}

/**
 * True when `lastScannedAt` is a scan that finished after `before`. Strictly later: a cached
 * scan-root list can hold a timestamp older than `before` (scanned elsewhere while events were
 * missed), which is not this scan finishing.
 */
export function scannedSince(lastScannedAt: string | null, before: string | null): boolean {
  if (lastScannedAt === null) return false;
  if (before === null) return true;
  return Date.parse(lastScannedAt) > Date.parse(before);
}

/**
 * Whether a followed scan is over: its root was scanned since, a `scan.progress` error arrived for
 * it, or a scan-root list fetched after the follow started no longer has the root (stopped).
 */
export function scanFollowDone(
  follow: ScanFollow,
  roots: { scanRoots: readonly ScanRoot[]; updatedAt: number } | undefined,
  scan: ScanStatus | null,
): boolean {
  if (scan && scan.scanRootId === follow.scanRootId && scan.state === 'error') return true;
  if (!roots) return false;
  const root = roots.scanRoots.find((r) => r.id === follow.scanRootId);
  if (!root) return roots.updatedAt > follow.since;
  return scannedSince(root.lastScannedAt, follow.scannedBefore);
}

export type AddJobTone = 'working' | 'success' | 'empty' | 'error';

export interface AddJobAction {
  id: 'open' | 'retry' | 'stop-watching' | 'dismiss';
  label: string;
  view?: View;
}

export interface AddJobSummary {
  tone: AddJobTone;
  title: string;
  detail: string | null;
  /** Names of the repositories found (at most `NAMES_SHOWN`, then "and N more"). */
  names: string[];
  more: number;
  actions: AddJobAction[];
}

export const NAMES_SHOWN = 5;

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Projects discovered through a scan root, by name. */
export function projectsOfScanRoot(
  projects: readonly ProjectListItem[] | undefined,
  scanRootId: string,
): ProjectListItem[] {
  return (projects ?? [])
    .filter((p) => p.project.scanRootId === scanRootId)
    .sort((a, b) => a.project.name.localeCompare(b.project.name));
}

/**
 * The folder job's scan is over when the scan root's `lastScannedAt` is later than when the
 * request returned (refreshed by `scan.progress` events or by polling), or a `scan.progress` error event
 * arrived for it.
 */
export function folderJobOutcome(
  job: Extract<AddJob, { kind: 'folder' }>,
  scanRoot: ScanRoot | undefined,
  scan: ScanStatus | null,
): { state: 'done'; found: number } | { state: 'error'; error: string } | null {
  if (job.state !== 'working' || !job.scanRootId) return null;
  if (scan && scan.scanRootId === job.scanRootId && scan.state === 'error') {
    return { state: 'error', error: scan.message ?? 'The scan failed.' };
  }
  if (!scanRoot) return null;
  if (scannedSince(scanRoot.lastScannedAt, job.scannedBefore ?? null)) {
    return { state: 'done', found: scanRoot.projectCount };
  }
  return null;
}

/** What the status panel / toast says about a job. */
export function describeAddJob(
  job: AddJob,
  ctx: { scan: ScanStatus | null; projects: readonly ProjectListItem[] | undefined },
): AddJobSummary {
  const none = { names: [] as string[], more: 0 };
  if (job.state === 'error') {
    return {
      tone: 'error',
      title: job.kind === 'repo' ? `Could not add ${job.path}` : `Could not watch ${job.path}`,
      detail: job.error ?? null,
      ...none,
      actions: [{ id: 'retry', label: 'Choose another folder' }],
    };
  }
  if (job.kind === 'repo') {
    if (job.state === 'working') {
      return {
        tone: 'working',
        title: `Adding ${job.path}…`,
        detail: 'Reading its branches and worktrees.',
        ...none,
        actions: [],
      };
    }
    const name = job.name ?? job.path;
    const worktrees = job.worktrees ?? 0;
    return {
      tone: 'success',
      title: job.created === false ? `${name} was already added` : `Added ${name}`,
      detail:
        worktrees > 1
          ? `${plural(worktrees, 'worktree', 'worktrees')}, all shown in the sidebar.`
          : 'It is in the sidebar now.',
      ...none,
      actions: job.projectId
        ? [
            {
              id: 'open',
              label: `Open ${name}`,
              view: { kind: 'project', projectId: job.projectId },
            },
          ]
        : [],
    };
  }

  // folder
  const scanning = ctx.scan && ctx.scan.scanRootId === job.scanRootId ? ctx.scan : null;
  const listed = job.scanRootId ? projectsOfScanRoot(ctx.projects, job.scanRootId) : [];
  if (job.state === 'working') {
    const progress =
      scanning && scanning.state === 'scanning' && scanning.scannedDirs > 0
        ? `${plural(scanning.scannedDirs, 'folder', 'folders')} checked, ${plural(
            scanning.foundRepos,
            'repository',
            'repositories',
          )} found so far.`
        : `Looking ${plural(job.depth, 'level', 'levels')} deep. Big folders can take a while.`;
    return {
      tone: 'working',
      title: `Looking for repositories in ${job.path}…`,
      detail: progress,
      ...none,
      actions: [],
    };
  }
  const found = Math.max(job.found ?? 0, listed.length);
  if (found === 0) {
    return {
      tone: 'empty',
      title: `No repositories found in ${job.path}`,
      detail: `Looked ${plural(job.depth, 'level', 'levels')} deep. The folder stays watched: repositories created there later show up on their own.`,
      ...none,
      actions: [
        { id: 'retry', label: 'Choose another folder' },
        { id: 'stop-watching', label: 'Stop watching' },
      ],
    };
  }
  const names = listed.slice(0, NAMES_SHOWN).map((p) => p.project.name);
  return {
    tone: 'success',
    title: `Watching ${job.path}: ${plural(found, 'repository', 'repositories')} found`,
    detail:
      job.created === false
        ? 'This folder was already watched; it was scanned again.'
        : 'New repositories and worktrees in it show up on their own.',
    names,
    more: Math.max(0, found - names.length),
    actions: job.scanRootId
      ? [{ id: 'open', label: 'Show folder', view: { kind: 'folder', scanRootId: job.scanRootId } }]
      : [],
  };
}
