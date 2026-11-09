/**
 * Main-pane view registry (COORDINATION §3.1.9, docs/design/FOLDERS.md). A view declares what it
 * applies to; the shell asks the registry which views fit the current selection and renders the
 * active one. A worktree has `Changes` and, when its branch has a matched pull/merge request, a
 * `Request` tab (`View.tab` chooses); folders and projects get the `Overview`. Future read-only
 * views (Files, History, Search) register here without shell edits.
 */
import type { View } from '../state/ui.tsx';

export type ViewId = 'changes' | 'overview' | 'request';

/** What the user selected, as a path through the hierarchy. */
export interface Selection {
  folder?: string | undefined;
  project?: string | undefined;
  worktree?: string | undefined;
  inbox: boolean;
  /** The selected worktree has a matched pull/merge request (docs/FORGES.md). */
  hasRequest?: boolean;
}

export interface ViewDefinition {
  id: ViewId;
  label: string;
  /** Small glyph for tabs and the palette. */
  icon: string;
  appliesTo(selection: Selection): boolean;
}

export const VIEWS: readonly ViewDefinition[] = [
  {
    id: 'changes',
    label: 'Changes',
    icon: '±',
    appliesTo: (s) => s.inbox || s.worktree !== undefined,
  },
  {
    id: 'overview',
    label: 'Overview',
    icon: '▦',
    appliesTo: (s) => !s.inbox && s.worktree === undefined,
  },
  {
    id: 'request',
    label: 'Request',
    icon: '⇄',
    appliesTo: (s) => s.worktree !== undefined && s.hasRequest === true,
  },
];

export function selectionOf(view: View, context: { hasRequest?: boolean } = {}): Selection {
  switch (view.kind) {
    case 'inbox':
      return { inbox: true };
    case 'folder':
      return { inbox: false, folder: view.scanRootId };
    case 'project':
      return { inbox: false, project: view.projectId };
    case 'worktree':
      return {
        inbox: false,
        worktree: view.worktreeId,
        ...(context.hasRequest ? { hasRequest: true } : {}),
      };
  }
}

export function viewsFor(selection: Selection): ViewDefinition[] {
  return VIEWS.filter((v) => v.appliesTo(selection));
}

/**
 * The view to render: for a worktree, its chosen tab when that view applies (the Request tab only
 * with a matched request), else the first view that applies (never empty by construction).
 */
export function activeView(view: View, context: { hasRequest?: boolean } = {}): ViewDefinition {
  const fits = viewsFor(selectionOf(view, context));
  if (view.kind === 'worktree' && view.tab) {
    const chosen = fits.find((v) => v.id === view.tab);
    if (chosen) return chosen;
  }
  const fit = fits.find((v) => v.id !== 'request') ?? fits[0];
  if (!fit) throw new Error('no view applies to the selection');
  return fit;
}
