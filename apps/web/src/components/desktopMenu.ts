/**
 * The desktop group of the file and worktree menus (Reveal / Open / Open in editor), for the
 * components that build those menus (sidebar, Overview, file list, tree, diff header). Nothing in
 * a browser: `desktopMenuItems` returns no items without the bridge.
 */
import { useCallback } from 'react';
import { type DesktopTarget, desktopMenuItems, useDesktop } from '../lib/desktop.ts';
import { actions, useUi, useUiStore } from '../state/ui.tsx';
import type { MenuItem } from './ContextMenu.tsx';
import { separated } from './copyMenu.ts';

/** `(target) => items`, the group starting with a separator; `[]` outside the desktop app. */
export function useDesktopMenu(): (target: DesktopTarget) => MenuItem[] {
  const bridge = useDesktop();
  const editor = useUi((s) => s.editor);
  const store = useUiStore();
  return useCallback(
    (target: DesktopTarget) =>
      separated(desktopMenuItems(bridge, target, editor, (text) => actions.notice(store, text))),
    [bridge, editor, store],
  );
}
