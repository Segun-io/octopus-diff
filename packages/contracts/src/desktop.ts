/**
 * The desktop app's bridge (docs/DESKTOP.md §3.4): `window.octopusDesktop`, exposed by the
 * Electron app's sandboxed preload through `contextBridge`. It is **optional**: the browser build
 * has no bridge and must behave exactly as before, so the web UI feature-detects it
 * (`apps/web/src/lib/desktop.ts`) and never assumes it.
 *
 * Browser-safe: types and a few constants, no runtime dependency. The main process validates every
 * argument again (zod, `apps/desktop/src/ipc.ts`) and never trusts a path from the renderer: files
 * are named by `worktreeId` + a repo-relative path, resolved through the daemon's API and checked
 * to stay inside that worktree (symlinks included).
 */

export type DesktopPlatform = 'darwin' | 'win32' | 'linux';

/** Editors "Open in editor" can hand a file to, through their URL scheme only. */
export const DESKTOP_EDITORS = ['vscode', 'cursor', 'zed'] as const;
export type DesktopEditor = (typeof DESKTOP_EDITORS)[number];

export const DESKTOP_EDITOR_LABELS: Readonly<Record<DesktopEditor, string>> = {
  vscode: 'VS Code',
  cursor: 'Cursor',
  zed: 'Zed',
};

/** Why the main process did not do what the renderer asked. */
export type DesktopRefusal =
  /** The call did not come from the app's own UI (origin, frame or window). */
  | 'forbidden'
  /** The arguments did not validate. */
  | 'invalid'
  /** Not called during a user gesture (a click or a key press). */
  | 'no-user-gesture'
  /** The daemon is not ready (or not reachable) to resolve the worktree. */
  | 'not-ready'
  /** The daemon does not list this worktree. */
  | 'unknown-worktree'
  /** The worktree is gone from disk. */
  | 'missing-worktree'
  /** The path resolves (symlinks included) outside the worktree. */
  | 'outside-worktree'
  /** Nothing exists at the path. */
  | 'not-found'
  /** `openPath` would run a program (an executable, a script, an app bundle). */
  | 'unsafe-file'
  /** The OS call itself failed. */
  | 'failed';

export type DesktopActionResult =
  | { ok: true }
  | { ok: false; reason: DesktopRefusal; message: string };

export interface DesktopPickFolderOptions {
  title?: string;
  /** Where the dialog opens (an absolute path); a hint only. */
  defaultPath?: string;
}

export interface DesktopOpenInEditorOptions {
  /** Default `vscode`. */
  editor?: DesktopEditor;
  /** 1-based line to jump to. */
  line?: number;
}

/**
 * Menu commands the main process sends to the page (replacing phase A's synthetic key events,
 * DECISIONS #495). The page subscribes with `onCommand`; a page without a subscriber (an older web
 * build served by an attached daemon) still gets phase A's scripts.
 */
export const DESKTOP_COMMANDS = ['open-settings', 'refresh', 'undo'] as const;
export type DesktopCommand = (typeof DESKTOP_COMMANDS)[number];

export interface DesktopBridge {
  /** Bumped only on breaking changes to this interface. */
  readonly version: 1;
  /** The OS, for the title bar layout (`data-desktop-platform` on `<html>`). */
  readonly platform: DesktopPlatform;
  /** The native folder dialog: an absolute path, or null when cancelled. Needs a user gesture. */
  pickFolder(options?: DesktopPickFolderOptions): Promise<string | null>;
  /** Shows the file (or, without `relPath`, the worktree) in the file manager. */
  revealPath(worktreeId: string, relPath?: string): Promise<DesktopActionResult>;
  /** Opens the file (or the worktree folder) with the OS default app; never runs a program. */
  openPath(worktreeId: string, relPath?: string): Promise<DesktopActionResult>;
  /** Opens the file (or the worktree folder) in an editor through its URL scheme. */
  openInEditor(
    worktreeId: string,
    relPath?: string,
    options?: DesktopOpenInEditorOptions,
  ): Promise<DesktopActionResult>;
  /** The dock / taskbar / launcher badge: the unreviewed count (0 clears it). */
  setBadge(count: number): void;
  /** The filesystem path of a dropped file or folder (`webUtils.getPathForFile`), or null. */
  getPathForFile(file: File): string | null;
  /** Writes text to the clipboard (no clipboard permission needed). Needs a user gesture. */
  copyText(text: string): Promise<boolean>;
  /** Subscribes to menu commands; returns the unsubscribe function. */
  onCommand(listener: (command: DesktopCommand) => void): () => void;
}

declare global {
  interface Window {
    /** Present only inside the desktop app (feature-detect it). */
    octopusDesktop?: DesktopBridge;
  }
}
