/**
 * Main-pane view registry (COORDINATION §3.1.9, docs/design/FOLDERS.md). A view declares what it
 * applies to; the shell asks the registry which views fit the current selection and renders the
 * active one. `Changes` is the only real view for a worktree; folders and projects get the
 * `Overview`. Future read-only views (Files, History, Search) register here without shell edits.
 */
import type { View } from '../state/ui.tsx';

export type ViewId = 'changes' | 'overview';

/** What the user selected, as a path through the hierarchy. */
export interface Selection {
  folder?: string | undefined;
  project?: string | undefined;
  worktree?: string | undefined;
  inbox: boolean;
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
];

export function selectionOf(view: View): Selection {
  switch (view.kind) {
    case 'inbox':
      return { inbox: true };
    case 'folder':
      return { inbox: false, folder: view.scanRootId };
    case 'project':
      return { inbox: false, project: view.projectId };
    case 'worktree':
      return { inbox: false, worktree: view.worktreeId };
  }
}

export function viewsFor(selection: Selection): ViewDefinition[] {
  return VIEWS.filter((v) => v.appliesTo(selection));
}

/** The view to render for a selection: the first that applies (never empty by construction). */
export function activeView(view: View): ViewDefinition {
  const fit = viewsFor(selectionOf(view))[0];
  if (!fit) throw new Error('no view applies to the selection');
  return fit;
}
