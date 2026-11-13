/**
 * Keeps the address bar and the UI store saying the same thing (docs/DECISIONS.md #459).
 *
 *  - store -> URL: a change of view, file or scope writes the query parameters (`urlState.ts`),
 *    as a new history entry when the user moved somewhere else and as a replacement for the
 *    landing, scope changes and anything leaving a stale entry (`historyMode`).
 *  - URL -> store: Back, Forward or an edited URL applies to the store the same way a click would
 *    (`commands.openView`, so the filter clearing for a hidden worktree stays).
 *
 * Both directions compare the selection before writing, so they settle instead of looping. The
 * URL never overrides the `lastWorktree` preference except when it names a view; a stale id is
 * left to the landing flow (`useLanding`), which replaces it.
 */
import { useRouter, useSearch } from '@tanstack/react-router';
import { useEffect, useRef } from 'react';
import { DIRECT_FOLDER_ID } from '../lib/model.ts';
import type { Commands } from './commands.ts';
import type { AppModel } from './model.tsx';
import { scopeForPref } from './prefs.ts';
import { type UiState, useUi, useUiStore, type View } from './ui.tsx';
import {
  historyMode,
  sameState,
  searchKey,
  searchOf,
  stateOfSearch,
  type UrlSearch,
  type UrlState,
} from './urlState.ts';

function stateOfUi(s: Pick<UiState, 'view' | 'selected' | 'scope'>): UrlState {
  return {
    view: s.view,
    selected: s.selected,
    scope: s.view.kind === 'worktree' ? s.scope : null,
  };
}

/** Whether the project list (not the filtered sidebar) still has the view's worktree/project/folder. */
function isKnown(model: AppModel, view: View): boolean {
  switch (view.kind) {
    case 'none':
      return false;
    case 'worktree':
      return model.sidebar.byId.has(view.worktreeId);
    case 'project':
      return (model.projects.data?.projects ?? []).some((p) => p.project.id === view.projectId);
    case 'folder':
      return (
        view.scanRootId === DIRECT_FOLDER_ID ||
        (model.scanRoots.data?.scanRoots ?? []).some((r) => r.id === view.scanRootId)
      );
  }
}

export function useUrlSync(model: AppModel, commands: Commands) {
  const router = useRouter();
  const store = useUiStore();
  const search = useSearch({ strict: false }) as UrlSearch;
  const view = useUi((s) => s.view);
  const selected = useUi((s) => s.selected);
  const scope = useUi((s) => s.scope);
  const latest = useRef({ model, commands });
  latest.current = { model, commands };
  /** What the address bar says right now (also right after our own write, before it settles). */
  const urlRef = useRef<UrlState>(stateOfSearch(search));
  /** The first pass: the store was built from the address (or deliberately holds another view). */
  const first = useRef(true);

  // URL -> store.
  const searchText = searchKey(search);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key stands for `search`
  useEffect(() => {
    const url = stateOfSearch(search);
    urlRef.current = url;
    if (first.current) return;
    // An address without a selection (the entry before the landing) changes nothing.
    if (url.view.kind === 'none') return;
    const state = store.getState();
    if (sameState(url, stateOfUi(state))) return;
    const sameView = JSON.stringify(url.view) === JSON.stringify(state.view);
    if (!sameView) {
      // Name the tab so a worktree opened without one does not inherit the previous tab.
      latest.current.commands.openView(
        url.view.kind === 'worktree' ? { ...url.view, tab: url.view.tab ?? 'changes' } : url.view,
      );
    }
    if (url.view.kind === 'worktree') {
      store.setState({
        selected: url.selected,
        scope: url.scope ?? scopeForPref(state.defaultScope),
      });
    }
  }, [searchText, store]);

  // Once the lists are there, a project or folder the URL named that does not exist is dropped
  // (a worktree id is handled by the landing flow). Runs for the first view only.
  const checked = useRef(false);
  const loaded = model.projects.data !== undefined && model.scanRoots.data !== undefined;
  useEffect(() => {
    if (!loaded || checked.current) return;
    checked.current = true;
    const current = store.getState().view;
    if ((current.kind === 'project' || current.kind === 'folder') && !isKnown(model, current)) {
      store.setState({ view: { kind: 'none' } });
    }
  }, [loaded, model, store]);

  // store -> URL.
  useEffect(() => {
    // Nothing chosen yet: leave the address alone (the landing writes it).
    if (view.kind === 'none') return;
    const next = stateOfUi({ view, selected, scope });
    const prev = urlRef.current;
    const initial = first.current;
    first.current = false;
    if (sameState(prev, next)) return;
    const mode = initial
      ? 'replace'
      : historyMode(prev, next, (v) => isKnown(latest.current.model, v));
    urlRef.current = next;
    void router.navigate({ to: '/', search: searchOf(next), replace: mode === 'replace' });
  }, [view, selected, scope, router]);
}
