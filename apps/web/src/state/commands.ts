import type { BulkReviewTarget, DiffResponse } from '@octopus-diff/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef } from 'react';
import { useReviewMutation } from '../api/hooks.ts';
import { type DiffQueryData, queryKeys, useApi } from '../api/queries.ts';
import { type BulkPlan, planBulk, planBulkForTarget } from '../lib/bulk.ts';
import { branchCopyText, fileCopyTexts } from '../lib/copyFormat.ts';
import { fileRefKey, toFileRef } from '../lib/fileRef.ts';
import { eyeApplies, type NavEntry, nextUnreviewed, stepFile, stepWorktree } from '../lib/model.ts';
import { escapeSuspicious, hasSuspicious } from '../lib/unicode.ts';
import type { SettingsSectionId } from '../settings/registry.ts';
import { type BulkActions, hasUndoableToast, useBulkActions } from './bulk.ts';
import { copyAndReport } from './copy.ts';
import { DEFAULT_CONTEXT, isFullContext, nextContext, patchShowsWholeFile } from './diffContext.ts';
import type { AppModel } from './model.tsx';
import { actions, useUiStore } from './ui.tsx';

/** What the palette's Copy commands copy (docs/COPY-TOOLS.md §4 step 2). */
export type CopyCommand = 'branch' | 'worktreePath' | 'filePath' | 'fileName' | 'absolutePath';

/** The worktree the copy commands act on: the open one, else the selected file's. */
export function copyWorktreeId(model: Pick<AppModel, 'view' | 'selectedEntry'>): string | null {
  if (model.view.kind === 'worktree') return model.view.worktreeId;
  return model.selectedEntry?.worktreeId ?? null;
}

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
  /** The "From main" chip: list only the files a merge, rebase or update brought. */
  toggleFromMain(): void;
  /** Expands or collapses the "from main" group of the open worktree. */
  toggleOriginGroup(): void;
  toggleTheme(): void;
  toggleTreeLayout(): void;
  expandContext(): void;
  focusFilter(): void;
  toggleHelp(): void;
  openSettings(section?: SettingsSectionId): void;
  togglePalette(): void;
  refreshNow(): void;
  /** Copies a name or path of the open worktree / file (palette commands). */
  copy(what: CopyCommand): void;
  /** Bulk mark for what is on screen (the open worktree, "show reviewed" respected). */
  markAll(reviewed: boolean): void;
  /**
   * Bulk mark for every worktree of the list (sidebar filters and "show reviewed" respected;
   * unfiltered it is one `all` request).
   */
  markEvery(reviewed: boolean): void;
  /** Bulk mark for a sidebar node, ignoring UI filters. */
  markAllFor(target: BulkReviewTarget, reviewed: boolean, worktreeIds: readonly string[]): void;
  confirmBulk(): void;
  cancelBulk(): void;
  undoBulk(): void;
  /** Scrolls the diff by a fraction of its height (negative = up). */
  scrollDiff(fraction: number): void;
  selectEntry(entry: NavEntry): void;
  /** The plan `markAll` (or `markEvery`) would run right now (for button and palette counts). */
  currentPlan(reviewed: boolean, every?: boolean): BulkPlan;
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
      // `n` skips the files of a collapsed "from main" group, like `j`/`k`.
      const eligible = (e: NavEntry) =>
        !m.disabledWorktrees.has(e.worktreeId) && m.originVisible(e);
      const target = nextUnreviewed(m.globalEntries, m.selectedKey, eligible);
      if (!target) return false;
      const ref = toFileRef(target.worktreeId, target.file);
      if (m.view.kind === 'worktree' && m.view.worktreeId !== target.worktreeId) {
        store.setState({
          view: { kind: 'worktree', worktreeId: target.worktreeId },
          selected: ref,
        });
      } else if (m.view.kind !== 'worktree' && !m.entries.some((e) => e.key === target.key)) {
        // From an Overview (or nothing open yet): open the target's worktree.
        store.setState({
          view: { kind: 'worktree', worktreeId: target.worktreeId },
          selected: ref,
        });
      } else {
        actions.select(store, ref);
      }
      return true;
    };
    const plan = (reviewed: boolean, every = false): BulkPlan => {
      const m = latest.current.model;
      // The hashes come from the same snapshot as the files and counts: the review data's rows for
      // every worktree (its file query refreshes on its own and may be newer), the open file
      // list's own state for the open worktree. A worktree the list does not show is not marked.
      const shown = every || m.viewListed;
      return planBulk({
        scope: m.scope,
        reviewed,
        groups: every ? m.allGroups : shown ? m.groups : [],
        entries: every ? m.allEntries : shown ? m.entries : [],
        visible: m.visible,
        stateHashes: every ? m.inboxStateHashes : m.stateHashes,
        disabled: m.disabledWorktrees,
        allUnfiltered: every && m.allUnfiltered,
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
        if (!m.viewListed) return;
        select(stepFile(m.entries, m.selectedKey, 1, m.visible));
      },
      prevFile() {
        const m = latest.current.model;
        if (!m.viewListed) return;
        select(stepFile(m.entries, m.selectedKey, -1, m.visible));
      },
      nextWorktree() {
        const next = stepWorktree(latest.current.model.sidebar.order, currentWorktreeId(), 1);
        if (next.changed && next.worktreeId) {
          actions.setView(store, { kind: 'worktree', worktreeId: next.worktreeId });
        }
      },
      prevWorktree() {
        const next = stepWorktree(latest.current.model.sidebar.order, currentWorktreeId(), -1);
        if (next.changed && next.worktreeId) {
          actions.setView(store, { kind: 'worktree', worktreeId: next.worktreeId });
        }
      },
      nextUnreviewed() {
        if (!goNextUnreviewed()) actions.notice(store, 'No unreviewed files left in this scope.');
      },
      toggleReviewed() {
        const m = latest.current.model;
        const entry = m.selectedEntry;
        const selected = store.getState().selected;
        if (!entry || !selected || !m.viewListed) return;
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
        // All on branch and To review have no eye (`eyeApplies`): nothing to toggle there.
        if (!eyeApplies(store.getState().scope.kind)) return;
        store.setState((s) => ({ showReviewed: !s.showReviewed }));
      },
      toggleFromMain() {
        store.setState((s) => ({ fromMainOnly: !s.fromMainOnly }));
      },
      toggleOriginGroup() {
        const m = latest.current.model;
        const withBase = m.groups
          .map((g) => g.worktree.id)
          .filter((id) => (m.originStats.get(id)?.base ?? 0) > 0);
        if (withBase.length === 0)
          return actions.notice(store, 'No files from the default branch.');
        const open = store.getState().originOpen;
        // One open group closes them all; none open expands them all.
        const expand = !withBase.some((id) => open.includes(id));
        for (const id of withBase) actions.toggleOriginGroup(store, id, expand);
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
        const state = store.getState();
        const current = state.fileOptions[m.selectedKey] ?? {};
        const selected = state.selected;
        if (!selected) return;
        // Same rules as the More context button: wait for the current view to load (repeated
        // presses would stack requests for patches nobody sees), and stop once the whole file
        // is shown or the API's maximum is reached.
        const shown = queryClient.getQueryData<DiffQueryData>(
          queryKeys.diff(selected, m.scope, {
            ignoreWhitespace: state.ignoreWhitespace,
            context: current.context,
            full: current.full,
          }),
        );
        if (!shown?.diff.patch) return;
        if (
          isFullContext(current.context) ||
          // A truncated patch can look like the whole file (cut inside its first hunk).
          (!shown.diff.truncated &&
            patchShowsWholeFile(shown.diff.patch, current.context ?? DEFAULT_CONTEXT))
        ) {
          actions.notice(store, 'The whole file is already shown.');
          return;
        }
        actions.setFileOptions(store, m.selectedKey, {
          ...current,
          context: nextContext(current.context),
        });
      },
      focusFilter() {
        // The filter is a dropdown with a search field: open it; it focuses its own search.
        const input = document.querySelector<HTMLInputElement>('[data-filter-input]');
        if (input) {
          input.focus();
          input.select();
        } else store.setState({ filterOpen: true });
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
      copy(what) {
        const m = latest.current.model;
        const id = copyWorktreeId(m);
        const row = id ? m.sidebar.byId.get(id) : undefined;
        const report = (text: string, label: string, escaped = false) =>
          void copyAndReport(store, text, { what: label, escaped });
        if (what === 'branch' || what === 'worktreePath') {
          if (!row) return actions.notice(store, 'No worktree selected.');
          if (what === 'worktreePath') {
            return report(
              escapeSuspicious(row.worktree.path),
              'worktree path',
              hasSuspicious(row.worktree.path),
            );
          }
          const branch = branchCopyText(row.worktree);
          if (branch === null) return actions.notice(store, 'Detached HEAD: no branch name.');
          return report(branch, 'branch name', hasSuspicious(row.worktree.branch ?? ''));
        }
        const entry = m.selectedEntry;
        if (!entry) return actions.notice(store, 'No file selected.');
        const root = m.sidebar.byId.get(entry.worktreeId)?.worktree.path ?? '';
        const t = fileCopyTexts(entry.file, root);
        if (what === 'filePath') return report(t.relative, 'path', t.escaped);
        if (what === 'fileName') return report(t.name, 'file name', t.escaped);
        if (!root) return actions.notice(store, 'Unknown worktree path.');
        return report(t.absolute, 'absolute path', t.escaped);
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
      markEvery(reviewed) {
        runPlan(plan(reviewed, true), reviewed);
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
      currentPlan(reviewed, every) {
        return plan(reviewed, every);
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

/** Global keyboard shortcuts (PLAN §4.2 plus UX round 1). */
export function useKeyboardShortcuts(commands: Commands, enabled: boolean) {
  const store = useUiStore();
  useEffect(() => {
    if (!enabled) return;
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
        case 'm':
          return run(commands.toggleFromMain);
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
