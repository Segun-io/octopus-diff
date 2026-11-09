import type { BulkReviewTarget, DiffResponse } from '@octopus-diff/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { useReviewMutation } from '../api/hooks.ts';
import { queryKeys, useApi } from '../api/queries.ts';
import { type BulkPlan, planBulk, planBulkForTarget } from '../lib/bulk.ts';
import { fileRefKey, toFileRef } from '../lib/fileRef.ts';
import { type NavEntry, nextUnreviewed, stepFile, stepWorktree } from '../lib/model.ts';
import type { SettingsSectionId } from '../settings/registry.ts';
import { type BulkActions, hasUndoableToast, useBulkActions } from './bulk.ts';
import { CONTEXT_STEP, DEFAULT_CONTEXT } from './diffContext.ts';
import type { AppModel } from './model.tsx';
import { actions, useUiStore } from './ui.tsx';

export interface Commands {
  nextFile(): void;
  prevFile(): void;
  nextWorktree(): void;
  prevWorktree(): void;
  nextUnreviewed(): void;
  toggleReviewed(): void;
  toggleDiffMode(): void;
  toggleWhitespace(): void;
  toggleShowReviewed(): void;
  toggleTheme(): void;
  toggleTreeLayout(): void;
  expandContext(): void;
  focusFilter(): void;
  goInbox(): void;
  toggleHelp(): void;
  openSettings(section?: SettingsSectionId): void;
  togglePalette(): void;
  refreshNow(): void;
  /** Bulk mark for what is on screen (current view, filters and "show reviewed" respected). */
  markAll(reviewed: boolean): void;
  /** Bulk mark for a sidebar node, ignoring UI filters. */
  markAllFor(target: BulkReviewTarget, reviewed: boolean, worktreeIds: readonly string[]): void;
  confirmBulk(): void;
  cancelBulk(): void;
  undoBulk(): void;
  /** Scrolls the diff by a fraction of its height (negative = up). */
  scrollDiff(fraction: number): void;
  selectEntry(entry: NavEntry): void;
  /** The plan `markAll(true)` would run right now (for button counts). */
  currentPlan(reviewed: boolean): BulkPlan;
}

/** The diff pane's scroll container (the @pierre/diffs virtualizer root or a raw <pre>). */
export function diffScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-diff-scroller]');
}

export { CONTEXT_STEP, DEFAULT_CONTEXT } from './diffContext.ts';

/** Imperative UI commands shared by the keyboard handler and buttons. Stable identity. */
export function useCommands(model: AppModel, resolvedTheme: 'light' | 'dark'): Commands {
  const store = useUiStore();
  const api = useApi();
  const queryClient = useQueryClient();
  const review = useReviewMutation();
  const bulk: BulkActions = useBulkActions();
  const latest = useRef({ model, resolvedTheme, review, bulk });
  latest.current = { model, resolvedTheme, review, bulk };
  const pendingPlan = useRef<BulkPlan | null>(null);

  return useMemo<Commands>(() => {
    const select = (entry: NavEntry | null) => {
      if (entry) actions.select(store, toFileRef(entry.worktreeId, entry.file));
    };
    const currentWorktreeId = () => {
      const view = latest.current.model.view;
      return view.kind === 'worktree' ? view.worktreeId : null;
    };
    const goNextUnreviewed = (): boolean => {
      const m = latest.current.model;
      const eligible = (e: NavEntry) => !m.disabledWorktrees.has(e.worktreeId);
      const target = nextUnreviewed(m.globalEntries, m.selectedKey, eligible);
      if (!target) return false;
      const ref = toFileRef(target.worktreeId, target.file);
      if (m.view.kind === 'worktree' && m.view.worktreeId !== target.worktreeId) {
        store.setState({
          view: { kind: 'worktree', worktreeId: target.worktreeId },
          selected: ref,
        });
      } else if (m.view.kind === 'inbox' && !m.entries.some((e) => e.key === target.key)) {
        // Hidden by sidebar filters in the inbox: open its worktree instead.
        store.setState({
          view: { kind: 'worktree', worktreeId: target.worktreeId },
          selected: ref,
        });
      } else {
        actions.select(store, ref);
      }
      return true;
    };
    const plan = (reviewed: boolean): BulkPlan => {
      const m = latest.current.model;
      return planBulk({
        scope: m.scope,
        reviewed,
        groups: m.groups,
        entries: m.entries,
        visible: m.visible,
        stateHashes: m.stateHashes,
        disabled: m.disabledWorktrees,
        inboxUnfiltered: m.inboxUnfiltered,
        view: m.view.kind === 'inbox' ? 'inbox' : 'worktree',
      });
    };
    const runPlan = (p: BulkPlan, reviewed: boolean) => {
      if (p.requests.length === 0) {
        actions.notice(store, 'Nothing to mark here.');
        return;
      }
      const state = store.getState();
      if (state.confirmBulk && p.worktrees > 1) {
        pendingPlan.current = p;
        store.setState({ bulkConfirm: { reviewed, count: p.count, worktrees: p.worktrees } });
        return;
      }
      void latest.current.bulk.run(p);
    };
    return {
      nextFile() {
        const m = latest.current.model;
        select(stepFile(m.entries, m.selectedKey, 1, m.visible));
      },
      prevFile() {
        const m = latest.current.model;
        select(stepFile(m.entries, m.selectedKey, -1, m.visible));
      },
      nextWorktree() {
        const next = stepWorktree(latest.current.model.sidebar.order, currentWorktreeId(), 1);
        if (next.changed) {
          actions.setView(
            store,
            next.worktreeId ? { kind: 'worktree', worktreeId: next.worktreeId } : { kind: 'inbox' },
          );
        }
      },
      prevWorktree() {
        const next = stepWorktree(latest.current.model.sidebar.order, currentWorktreeId(), -1);
        if (next.changed) {
          actions.setView(
            store,
            next.worktreeId ? { kind: 'worktree', worktreeId: next.worktreeId } : { kind: 'inbox' },
          );
        }
      },
      nextUnreviewed() {
        if (!goNextUnreviewed()) actions.notice(store, 'No unreviewed files left in this scope.');
      },
      toggleReviewed() {
        const m = latest.current.model;
        const entry = m.selectedEntry;
        const selected = store.getState().selected;
        if (!entry || !selected) return;
        if (m.disabledWorktrees.has(entry.worktreeId)) {
          actions.notice(store, 'Review is off for this worktree.');
          return;
        }
        // F2: review exactly what is displayed. The diff pane's query holds the patch on screen;
        // the list entry is only the fallback while the diff is still loading.
        const state = store.getState();
        const opts = state.fileOptions[fileRefKey(selected)] ?? {};
        const shown = queryClient.getQueryData<DiffResponse>(
          queryKeys.diff(selected, m.scope, {
            ignoreWhitespace: state.ignoreWhitespace,
            context: opts.context,
            full: opts.full,
          }),
        );
        const source =
          shown && shown.worktreeId === selected.worktreeId
            ? { patchHash: shown.diff.patchHash, reviewed: shown.diff.reviewed }
            : { patchHash: entry.file.patchHash, reviewed: entry.file.reviewed };
        const reviewed = !source.reviewed;
        latest.current.review.mutate({
          projectId: entry.projectId,
          scopeKind: m.scope.kind,
          path: entry.file.path,
          rawPath: entry.file.rawPath,
          patchHash: source.patchHash,
          reviewed,
        });
        if (reviewed && state.autoAdvance) goNextUnreviewed();
      },
      toggleDiffMode() {
        store.setState((s) => ({ diffMode: s.diffMode === 'split' ? 'unified' : 'split' }));
      },
      toggleWhitespace() {
        store.setState((s) => ({ ignoreWhitespace: !s.ignoreWhitespace }));
      },
      toggleShowReviewed() {
        store.setState((s) => ({ showReviewed: !s.showReviewed }));
      },
      toggleTheme() {
        const mode = latest.current.resolvedTheme === 'dark' ? 'light' : 'dark';
        store.setState((s) => ({ theme: { ...s.theme, mode } }));
      },
      toggleTreeLayout() {
        store.setState((s) => ({ fileListLayout: s.fileListLayout === 'list' ? 'tree' : 'list' }));
      },
      expandContext() {
        const m = latest.current.model;
        if (!m.selectedKey) return;
        const current = store.getState().fileOptions[m.selectedKey] ?? {};
        actions.setFileOptions(store, m.selectedKey, {
          ...current,
          context: (current.context ?? DEFAULT_CONTEXT) + CONTEXT_STEP,
        });
      },
      focusFilter() {
        const input = document.querySelector<HTMLInputElement>('[data-filter-input]');
        input?.focus();
        input?.select();
      },
      goInbox() {
        actions.setView(store, { kind: 'inbox' });
      },
      toggleHelp() {
        store.setState((s) => ({ helpOpen: !s.helpOpen, paletteOpen: false }));
      },
      openSettings(section) {
        actions.openSettings(store, section);
      },
      togglePalette() {
        store.setState((s) => ({ paletteOpen: !s.paletteOpen, helpOpen: false }));
      },
      refreshNow() {
        const id = currentWorktreeId();
        if (id) void api.refreshWorktree(id).catch(() => undefined);
        void queryClient.invalidateQueries({ queryKey: queryKeys.projects() });
        void queryClient.invalidateQueries({ queryKey: queryKeys.inboxAll() });
        void queryClient.invalidateQueries({ queryKey: ['files'] });
        void queryClient.invalidateQueries({ queryKey: ['diff'] });
      },
      markAll(reviewed) {
        runPlan(plan(reviewed), reviewed);
      },
      markAllFor(target, reviewed, worktreeIds) {
        const m = latest.current.model;
        runPlan(planBulkForTarget(target, m.scope, reviewed, m.stateHashes, worktreeIds), reviewed);
      },
      confirmBulk() {
        const p = pendingPlan.current;
        pendingPlan.current = null;
        store.setState({ bulkConfirm: null });
        if (p) void latest.current.bulk.run(p);
      },
      cancelBulk() {
        pendingPlan.current = null;
        store.setState({ bulkConfirm: null });
      },
      undoBulk() {
        if (hasUndoableToast(store)) void latest.current.bulk.undo();
      },
      scrollDiff(fraction) {
        const el = diffScroller();
        if (el) el.scrollTop += Math.round(el.clientHeight * fraction);
      },
      selectEntry(entry) {
        select(entry);
      },
      currentPlan(reviewed) {
        return plan(reviewed);
      },
    };
  }, [store, api, queryClient]);
}

/** True when a key event comes from a text field (shortcuts must not fire while typing). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type);
  }
  return false;
}

function isActivatable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    target.closest('button, a[href], summary, [role="button"]') !== null
  );
}

export const CHORD_TIMEOUT_MS = 1200;

/** Global keyboard shortcuts (PLAN §4.2 plus UX round 1). */
export function useKeyboardShortcuts(commands: Commands, enabled: boolean) {
  const store = useUiStore();
  useEffect(() => {
    if (!enabled) return;
    let pendingG = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey) return;
      const state = store.getState();
      const mod = event.ctrlKey || event.metaKey;
      if (mod) {
        // Ctrl/Cmd+K opens the palette from anywhere, even while typing in the filter.
        if (event.key === 'k' || event.key === 'K') {
          event.preventDefault();
          commands.togglePalette();
          return;
        }
        // Ctrl/Cmd+Z undoes the last bulk mark while its toast is visible (not while typing).
        if ((event.key === 'z' || event.key === 'Z') && !event.shiftKey) {
          if (isTypingTarget(event.target) || !hasUndoableToast(store)) return;
          event.preventDefault();
          commands.undoBulk();
        }
        return;
      }
      if (isTypingTarget(event.target)) return;
      if (state.paletteOpen || state.settingsOpen || state.addProjectOpen || state.bulkConfirm) {
        return; // dialogs handle their own keys (Escape included)
      }
      if (state.helpOpen && event.key !== '?' && event.key !== 'Escape') return;

      if (pendingG && Date.now() - pendingG < CHORD_TIMEOUT_MS) {
        pendingG = 0;
        if (event.key === 'i') {
          event.preventDefault();
          commands.goInbox();
          return;
        }
      }
      pendingG = 0;

      const run = (fn: () => void) => {
        event.preventDefault();
        fn();
      };
      switch (event.key) {
        case 'j':
          return run(commands.nextFile);
        case 'k':
          return run(commands.prevFile);
        case 'J':
          return run(commands.nextWorktree);
        case 'K':
          return run(commands.prevWorktree);
        case 'n':
          return run(commands.nextUnreviewed);
        case 'r':
          return run(commands.toggleReviewed);
        case 'R':
          return run(() => commands.markAll(true));
        case 's':
          return run(commands.toggleDiffMode);
        case 'w':
          return run(commands.toggleWhitespace);
        case 'h':
          return run(commands.toggleShowReviewed);
        case 'e':
          return run(commands.expandContext);
        case 't':
          return run(commands.toggleTheme);
        case '/':
          return run(commands.focusFilter);
        case '?':
          return run(commands.toggleHelp);
        case ',':
          return run(() => commands.openSettings());
        case ' ':
          // Space still activates a focused button/link.
          if (isActivatable(event.target)) return;
          return run(() => commands.scrollDiff(event.shiftKey ? -0.85 : 0.85));
        case 'd':
          return run(() => commands.scrollDiff(0.5));
        case 'u':
          return run(() => commands.scrollDiff(-0.5));
        case 'g':
          event.preventDefault();
          pendingG = Date.now();
          return;
        case 'Escape':
          if (state.helpOpen) run(() => store.setState({ helpOpen: false }));
          else if (state.bulkToast) run(() => store.setState({ bulkToast: null }));
          return;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [commands, enabled, store]);
}

export { SHORTCUTS } from './commandRegistry.ts';
