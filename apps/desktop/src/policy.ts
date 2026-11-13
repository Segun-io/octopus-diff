/**
 * The security baseline of docs/DESKTOP.md §5 as pure functions, so unit tests assert it without
 * Electron. `main.ts` only wires them to Electron's events.
 */
import type { Rect } from './window-state.js';

/** The origin (`scheme://host:port`) of an http(s) URL, or null for anything else. */
export function httpOrigin(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  return parsed.origin;
}

/**
 * `will-navigate` / `will-redirect` / `will-frame-navigate`: only pages of the UI's own origin (the
 * daemon's, or the Vite dev server's in UI dev mode). Anything else, including other ports, `file:`,
 * `data:` and `javascript:`, is denied. With no origin yet (the start screen) nothing is allowed.
 */
export function navigationPolicy(url: string, allowedOrigin: string | null): 'allow' | 'deny' {
  if (allowedOrigin === null) return 'deny';
  const origin = httpOrigin(url);
  return origin !== null && origin === allowedOrigin ? 'allow' : 'deny';
}

/**
 * `setWindowOpenHandler`: never a new Electron window. http(s) links go to the user's browser
 * (`shell.openExternal`); every other scheme (`file:`, `javascript:`, custom protocols that could
 * launch programs) is dropped.
 */
export function windowOpenPolicy(url: string): { action: 'deny'; openExternally: string | null } {
  return { action: 'deny', openExternally: httpOrigin(url) === null ? null : url };
}

/** Permission request and check handlers: every permission is denied (§5). */
export function permissionPolicy(_permission: string): false {
  return false;
}

/** The `webPreferences` every window gets. `devTools` only in dev runs (`--dev`). */
export function webPreferences(devTools: boolean) {
  return {
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    experimentalFeatures: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    spellcheck: false,
    devTools,
  } as const;
}

export interface WindowOptionsInput {
  bounds: Rect | null;
  devTools: boolean;
  title: string;
  backgroundColor?: string;
}

export const MIN_WIDTH = 720;
export const MIN_HEIGHT = 480;
export const DEFAULT_WIDTH = 1400;
export const DEFAULT_HEIGHT = 900;

/**
 * `BrowserWindow` options. No preload in phase A (the `window.octopusDesktop` bridge is #20). The
 * native frame on every platform: macOS `hiddenInset` needs a drag region in the web header first
 * (WS3, phase C), or the window could not be moved.
 */
export function windowOptions(input: WindowOptionsInput) {
  const bounds = input.bounds;
  return {
    title: input.title,
    width: bounds?.width ?? DEFAULT_WIDTH,
    height: bounds?.height ?? DEFAULT_HEIGHT,
    ...(bounds ? { x: bounds.x, y: bounds.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: input.backgroundColor ?? '#0b0d12',
    autoHideMenuBar: false,
    webPreferences: webPreferences(input.devTools),
  };
}

/**
 * What may be logged about a failed `loadURL`: the error code only. Electron's message carries the
 * URL that failed (`ERR_CONNECTION_REFUSED (-102) loading 'http://…/#token=…'`), which holds the
 * daemon token, so the message is never logged (PR #108 review).
 */
export function loadFailureNote(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,60}$/.test(code) ? code : 'unknown error';
}

/** A load that a newer navigation replaced (a screen swap, a reload): not a failure to report. */
export function isSupersededLoad(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ERR_ABORTED';
}
