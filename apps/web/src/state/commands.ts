import { useEffect, useMemo, useRef } from 'react';
import { useReviewMutation } from '../api/hooks.ts';
import { toFileRef } from '../lib/fileRef.ts';
import { type NavEntry, nextUnreviewed, stepFile, stepWorktree } from '../lib/model.ts';
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
  expandContext(): void;
  focusFilter(): void;
  goInbox(): void;
  toggleHelp(): void;
  /** Scrolls the diff by a fraction of its height (negative = up). */
  scrollDiff(fraction: number): void;
  selectEntry(entry: NavEntry): void;
}

/** The diff pane's scroll container (the @pierre/diffs virtualizer root or a raw <pre>). */
export function diffScroller(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-diff-scroller]');
}

export const CONTEXT_STEP = 20;
export const DEFAULT_CONTEXT = 3;

/** Imperative UI commands shared by the keyboard handler and buttons. Stable identity. */
export function useCommands(model: AppModel, resolvedTheme: 'light' | 'dark'): Commands {
  const store = useUiStore();
  const review = useReviewMutation();
  const latest = useRef({ model, resolvedTheme, review });
  latest.current = { model, resolvedTheme, review };

  return useMemo<Commands>(() => {
    const select = (entry: NavEntry | null) => {
      if (entry) actions.select(store, toFileRef(entry.worktreeId, entry.file));
    };
    const currentWorktreeId = () => {
      const view = latest.current.model.view;
      return view.kind === 'worktree' ? view.worktreeId : null;
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
        const m = latest.current.model;
        const target = nextUnreviewed(m.globalEntries, m.selectedKey);
        if (!target) {
          actions.notice(store, 'No unreviewed files left in this scope.');
          return;
        }
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
      },
      toggleReviewed() {
        const m = latest.current.model;
        const entry = m.selectedEntry;
        if (!entry) return;
        latest.current.review.mutate({
          projectId: entry.projectId,
          scopeKind: m.scope.kind,
          path: entry.file.path,
          rawPath: entry.file.rawPath,
          patchHash: entry.file.patchHash,
          reviewed: !entry.file.reviewed,
        });
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
        store.setState((s) => ({ helpOpen: !s.helpOpen }));
      },
      scrollDiff(fraction) {
        const el = diffScroller();
        if (el) el.scrollTop += Math.round(el.clientHeight * fraction);
      },
      selectEntry(entry) {
        select(entry);
      },
    };
  }, [store]);
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

/** Global keyboard shortcuts (PLAN §4.2). */
export function useKeyboardShortcuts(commands: Commands, enabled: boolean) {
  const store = useUiStore();
  useEffect(() => {
    if (!enabled) return;
    let pendingG = 0;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      const state = store.getState();
      if (state.helpOpen && event.key !== '?' && event.key !== 'Escape') return;
      if (state.addProjectOpen) return;

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
          return;
        default:
          return;
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [commands, enabled, store]);
}

export const SHORTCUTS: { keys: string[]; description: string }[] = [
  { keys: ['j', 'k'], description: 'Next / previous file' },
  { keys: ['J', 'K'], description: 'Next / previous worktree (Inbox first)' },
  { keys: ['n'], description: 'Next unreviewed file anywhere' },
  { keys: ['r'], description: 'Toggle reviewed for the open file' },
  { keys: ['s'], description: 'Split / unified diff' },
  { keys: ['w'], description: 'Hide / show whitespace changes' },
  { keys: ['h'], description: 'Show / hide reviewed files' },
  { keys: ['e'], description: `Expand context (+${CONTEXT_STEP} lines)` },
  { keys: ['Space', '⇧ Space'], description: 'Scroll the diff down / up a page' },
  { keys: ['d', 'u'], description: 'Scroll the diff down / up half a page' },
  { keys: ['t'], description: 'Toggle light / dark theme' },
  { keys: ['/'], description: 'Filter worktrees' },
  { keys: ['g', 'i'], description: 'Go to the Inbox' },
  { keys: ['?'], description: 'Show / hide this help' },
  { keys: ['Esc'], description: 'Close dialogs, leave the filter' },
];
