/**
 * The desktop app's optional bridge (`window.octopusDesktop`, docs/DESKTOP.md §3.4). The browser
 * build has no bridge: every hook here is a no-op then and every helper returns nothing, so the web
 * UI behaves exactly as before. Inside the app the bridge adds: Reveal / Open / Open in editor in
 * the file and worktree menus, a Browse… button and folder drops for adding, the dock/taskbar badge,
 * the macOS title bar (`data-desktop-platform` on `<html>`), the menu commands, and the clipboard.
 *
 * The bridge never takes a filesystem path for a file: the web names files by worktree id + repo
 * path, and the app checks them (DECISIONS #530).
 */
import {
  DESKTOP_EDITOR_LABELS,
  type DesktopBridge,
  type DesktopCommand,
  type DesktopEditor,
  type DesktopPlatform,
} from '@octopus-diff/contracts';
import { useEffect, useRef } from 'react';
import type { MenuItem } from '../components/ContextMenu.tsx';

export const DESKTOP_TEST_IDS = {
  reveal: 'desktop-reveal',
  open: 'desktop-open',
  openInEditor: 'desktop-open-in-editor',
  browse: 'add-browse',
  dropHint: 'desktop-drop-hint',
} as const;

const METHODS = [
  'pickFolder',
  'revealPath',
  'openPath',
  'openInEditor',
  'setBadge',
  'getPathForFile',
  'copyText',
  'onCommand',
] as const;

/**
 * The bridge, or null in a browser (or with a bridge of another major version, or a malformed
 * one): feature detection, not a platform sniff.
 */
export function desktopBridge(
  win: (Window & typeof globalThis) | undefined = typeof window === 'undefined'
    ? undefined
    : window,
): DesktopBridge | null {
  const bridge = win?.octopusDesktop;
  if (typeof bridge !== 'object' || bridge === null) return null;
  if (bridge.version !== 1) return null;
  if (!['darwin', 'win32', 'linux'].includes(bridge.platform)) return null;
  for (const method of METHODS) if (typeof bridge[method] !== 'function') return null;
  return bridge;
}

/** The bridge for components (read once per render; it never changes while the page lives). */
export function useDesktop(): DesktopBridge | null {
  return desktopBridge();
}

export function revealLabel(platform: DesktopPlatform): string {
  if (platform === 'darwin') return 'Reveal in Finder';
  if (platform === 'win32') return 'Show in Explorer';
  return 'Show in file manager';
}

export interface DesktopTarget {
  worktreeId: string;
  /** Repo-relative path; omitted for the worktree itself. */
  relPath?: string;
  /** Deleted in this scope: there is nothing on disk to show or open. */
  deleted?: boolean;
}

/**
 * Reveal / Open / Open in editor for a file or a worktree. Empty without the bridge. `report`
 * shows a refusal (outside the worktree, a program, a missing editor…).
 */
export function desktopMenuItems(
  bridge: DesktopBridge | null,
  target: DesktopTarget,
  editor: DesktopEditor,
  report: (message: string) => void,
): MenuItem[] {
  if (!bridge) return [];
  const { worktreeId, relPath } = target;
  const disabled = target.deleted === true;
  const title = disabled ? 'Deleted: not on disk' : undefined;
  const run = (action: () => Promise<{ ok: boolean; message?: string }>) => () => {
    void action().then(
      (result) => {
        if (!result.ok) report(result.message ?? 'The desktop app refused.');
      },
      () => report('The desktop app did not answer.'),
    );
  };
  return [
    {
      id: 'desktop-reveal',
      label: revealLabel(bridge.platform),
      testId: DESKTOP_TEST_IDS.reveal,
      disabled,
      title,
      onSelect: run(() => bridge.revealPath(worktreeId, relPath)),
    },
    {
      id: 'desktop-open',
      label: relPath === undefined ? 'Open folder' : 'Open with default app',
      testId: DESKTOP_TEST_IDS.open,
      disabled,
      title,
      onSelect: run(() => bridge.openPath(worktreeId, relPath)),
    },
    {
      id: 'desktop-open-in-editor',
      label: `Open in ${DESKTOP_EDITOR_LABELS[editor]}`,
      testId: DESKTOP_TEST_IDS.openInEditor,
      disabled,
      title,
      onSelect: run(() => bridge.openInEditor(worktreeId, relPath, { editor })),
    },
  ];
}

/** Sets `data-desktop-platform` on `<html>` (the macOS title bar strip in styles.css). */
export function useDesktopPlatform(bridge: DesktopBridge | null): void {
  useEffect(() => {
    if (!bridge || typeof document === 'undefined') return;
    const root = document.documentElement;
    root.dataset.desktopPlatform = bridge.platform;
    return () => {
      delete root.dataset.desktopPlatform;
    };
  }, [bridge]);
}

/** The dock / taskbar badge follows the unreviewed count (0 clears it). */
export function useDesktopBadge(bridge: DesktopBridge | null, count: number): void {
  useEffect(() => {
    bridge?.setBadge(Math.max(0, Math.floor(count)));
  }, [bridge, count]);
  // Leaving (a test unmount, a page that stops showing the count) clears it.
  useEffect(() => () => bridge?.setBadge(0), [bridge]);
}

export interface DesktopCommandHandlers {
  openSettings(): void;
  refreshNow(): void;
  undoBulk(): void;
}

function isEditable(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  return (
    el.tagName === 'INPUT' &&
    !['checkbox', 'radio', 'button', 'submit', 'reset'].includes((el as HTMLInputElement).type)
  );
}

/** Runs one menu command (DECISIONS #495's hooks). */
export function runDesktopCommand(command: DesktopCommand, handlers: DesktopCommandHandlers): void {
  if (command === 'open-settings') handlers.openSettings();
  else if (command === 'refresh') handlers.refreshNow();
  else if (command === 'undo') {
    // In a text field the editing undo; elsewhere the web's "undo the last bulk mark".
    if (isEditable(document.activeElement)) document.execCommand('undo');
    else handlers.undoBulk();
  }
}

/** Subscribes to the app menu's commands while mounted. */
export function useDesktopCommands(
  bridge: DesktopBridge | null,
  handlers: DesktopCommandHandlers,
): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    if (!bridge) return;
    return bridge.onCommand((command) => runDesktopCommand(command, latest.current));
  }, [bridge]);
}

/** The folder of a drop, when the drop is one folder (a file or several items are not). */
export function droppedFolder(bridge: DesktopBridge, data: DataTransfer | null): string | null {
  if (data?.files.length !== 1) return null;
  const item = data.items?.[0];
  const entry =
    item && typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null;
  if (entry && !entry.isDirectory) return null;
  const file = data.files[0];
  return file ? bridge.getPathForFile(file) : null;
}

function carriesFiles(event: DragEvent): boolean {
  return event.dataTransfer?.types.includes('Files') === true;
}

/**
 * Dropping a folder on the window opens the add flow at it (`onFolder`); anything else dropped is
 * ignored (the app never navigates on a drop: `navigateOnDragDrop` is off). `onRefused` says why a
 * drop did nothing.
 */
export function useFolderDrop(
  bridge: DesktopBridge | null,
  onFolder: (path: string) => void,
  onRefused: (message: string) => void,
): void {
  const latest = useRef({ onFolder, onRefused });
  latest.current = { onFolder, onRefused };
  useEffect(() => {
    if (!bridge) return;
    const over = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    };
    const drop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      const folder = droppedFolder(bridge, event.dataTransfer);
      if (folder) latest.current.onFolder(folder);
      else latest.current.onRefused('Drop one folder to add it.');
    };
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [bridge]);
}
