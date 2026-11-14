/**
 * Directory-tree layout for one worktree's changed files, built on @pierre/trees (a beta).
 * Isolated behind this component so it can be swapped; the flat virtualized `FileList` is the
 * default layout and the one that carries the TEST_IDS (the tree renders in a shadow root).
 */
import type { GitStatusEntry } from '@pierre/trees';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { useEffect, useMemo, useRef } from 'react';
import { type NavEntry, originTag } from '../lib/model.ts';
import { copyAndReport } from '../state/copy.ts';
import { useUiStore } from '../state/ui.tsx';
import { ContextMenu, type MenuItem } from './ContextMenu.tsx';
import { fileCopyItems } from './copyMenu.ts';
import { useDesktopMenu } from './desktopMenu.ts';

export interface FileTreeViewProps {
  entries: readonly NavEntry[];
  selectedKey: string | null;
  onSelect: (entry: NavEntry) => void;
  theme: 'light' | 'dark';
  /** The worktree root of an entry, for "Copy absolute path". */
  worktreePathOf?: (worktreeId: string) => string | undefined;
}

function gitStatus(entry: NavEntry): GitStatusEntry['status'] {
  switch (entry.file.status) {
    case 'added':
    case 'copied':
      return 'added';
    case 'untracked':
      return 'untracked';
    case 'deleted':
      return 'deleted';
    case 'renamed':
      return 'renamed';
    default:
      return 'modified';
  }
}

export function FileTreeView({
  entries,
  selectedKey,
  onSelect,
  theme,
  worktreePathOf,
}: FileTreeViewProps) {
  const store = useUiStore();
  const desktopItems = useDesktopMenu();
  const byPath = useMemo(() => new Map(entries.map((e) => [e.file.path, e])), [entries]);
  const latest = useRef({ byPath, onSelect, selectedKey });
  latest.current = { byPath, onSelect, selectedKey };
  const paths = useMemo(() => entries.map((e) => e.file.path), [entries]);

  const { model } = useFileTree({
    paths,
    initialExpansion: 'open',
    flattenEmptyDirectories: true,
    gitStatus: entries.map((e) => ({ path: e.file.path, status: gitStatus(e) })),
    onSelectionChange: (selected) => {
      const path = selected[selected.length - 1];
      const entry = path === undefined ? undefined : latest.current.byPath.get(path);
      if (entry && entry.key !== latest.current.selectedKey) latest.current.onSelect(entry);
    },
    renderRowDecoration: ({ item }) => {
      const entry = latest.current.byPath.get(item.path);
      if (!entry) return null;
      const { additions, deletions, reviewed } = entry.file;
      const parts = [];
      if (additions) parts.push({ text: `+${additions} `, color: 'var(--od-add)' });
      if (deletions) parts.push({ text: `−${deletions} `, color: 'var(--od-del)' });
      if (reviewed) parts.push({ text: '✓', color: 'var(--od-add)' });
      // `+main` on a mixed file, how a base file arrived (`merge`...): the tree cannot dim a row.
      const tag = originTag(entry.file);
      if (tag) parts.unshift({ text: `${tag} `, color: 'var(--od-faint)' });
      return parts.length ? { text: parts.map((p) => p.text).join(''), parts } : null;
    },
  });

  // Keep the tree in sync with refreshed data.
  const lastPaths = useRef(paths);
  useEffect(() => {
    if (lastPaths.current !== paths) {
      lastPaths.current = paths;
      model.resetPaths(paths);
    }
    model.setGitStatus(entries.map((e) => ({ path: e.file.path, status: gitStatus(e) })));
  }, [model, paths, entries]);

  // Mirror keyboard-driven selection into the tree.
  useEffect(() => {
    if (!selectedKey) return;
    const entry = entries.find((e) => e.key === selectedKey);
    if (!entry) return;
    const item = model.getItem(entry.file.path);
    if (item && !item.isSelected()) {
      for (const p of model.getSelectedPaths()) model.getItem(p)?.deselect();
      item.select();
      model.scrollToPath(entry.file.path, { focus: false });
    }
  }, [model, selectedKey, entries]);

  return (
    <FileTree
      model={model}
      renderContextMenu={(item, context) => {
        const entry = byPath.get(item.path);
        const at = { x: context.anchorRect.left, y: context.anchorRect.bottom + 2 };
        const root = entry
          ? worktreePathOf?.(entry.worktreeId)
          : worktreePathOf?.(entries[0]?.worktreeId ?? '');
        // A directory row copies its own path; a file row its path, old path, name, absolute path.
        const file = entry?.file ?? { path: item.path.replace(/\/$/, '') };
        const worktreeId = entry?.worktreeId ?? entries[0]?.worktreeId;
        const items: MenuItem[] = [
          ...fileCopyItems(
            file,
            root,
            (text, options) => void copyAndReport(store, text, options),
            at,
          ).filter((i) => item.kind === 'file' || i.id !== 'copy-name'),
          ...(worktreeId
            ? desktopItems({
                worktreeId,
                relPath: file.path,
                deleted: entry?.file.status === 'deleted',
              })
            : []),
        ];
        return (
          <ContextMenu
            items={items}
            position={at}
            onClose={() => context.close()}
            label="Copy"
            testId="file-tree-menu"
          />
        );
      }}
      aria-label="Changed files (tree)"
      className="block h-full"
      style={{
        height: '100%',
        colorScheme: theme,
        ['--trees-selected-bg-override' as string]: 'var(--od-selected)',
        ['--trees-fg-override' as string]: 'var(--od-fg)',
        ['--trees-border-color-override' as string]: 'var(--od-line)',
      }}
    />
  );
}
