/**
 * The application menu (docs/DESKTOP.md §6): App (macOS) / File / Edit / View / Window / Help.
 *
 * Rule: no accelerator is ever a bare key. The web UI owns single keys (`j/k/n/r/s/…`, `,`, `/`),
 * so every accelerator here has Cmd/Ctrl (or is a function key such as F11). `isAllowedAccelerator`
 * checks it and the tests run it over every item, roles included (`ROLE_ACCELERATORS`).
 *
 * Pure: returns Electron menu templates whose clicks call `MenuActions`; `main.ts` builds the menu.
 */
import type { MenuItemConstructorOptions } from 'electron';

export interface MenuActions {
  addFolder(): void;
  openSettings(): void;
  refresh(): void;
  undo(): void;
  showLog(): void;
  retryBackend(): void;
}

export interface MenuInput {
  platform: NodeJS.Platform;
  appName: string;
  /** DevTools and page reload items (dev runs only). */
  dev: boolean;
  actions: MenuActions;
}

const MODIFIERS = new Set([
  'command',
  'cmd',
  'control',
  'ctrl',
  'commandorcontrol',
  'cmdorctrl',
  'alt',
  'option',
  'altgr',
  'shift',
  'super',
  'meta',
]);
/** Modifiers that make a key safe from the web UI's single-key shortcuts (Shift alone is not). */
const COMMAND_MODIFIERS = new Set([
  'command',
  'cmd',
  'control',
  'ctrl',
  'commandorcontrol',
  'cmdorctrl',
  'super',
  'meta',
]);

/**
 * True when the accelerator cannot collide with the web UI's single-key shortcuts: it has a
 * Cmd/Ctrl-class modifier, or it is a function key (F1–F24). Shift or Alt alone is not enough
 * (`Shift+R` is the web's "review all").
 */
export function isAllowedAccelerator(accelerator: string): boolean {
  const parts = accelerator.split('+').map((p) => p.trim().toLowerCase());
  if (parts.some((p) => p === '')) return false;
  const key = parts[parts.length - 1] ?? '';
  const modifiers = parts.slice(0, -1);
  if (MODIFIERS.has(key)) return false;
  if (!modifiers.every((m) => MODIFIERS.has(m))) return false;
  if (modifiers.some((m) => COMMAND_MODIFIERS.has(m))) return true;
  return /^f(?:[1-9]|1\d|2[0-4])$/.test(key);
}

/**
 * The accelerators Electron gives the roles used here (per its docs; `null` = none). The tests
 * check these too, since a role brings its accelerator without us writing it.
 */
export const ROLE_ACCELERATORS: Readonly<Record<string, string | null>> = {
  about: null,
  services: null,
  hide: 'Command+H',
  hideOthers: 'Command+Alt+H',
  unhide: null,
  quit: 'CommandOrControl+Q',
  close: 'CommandOrControl+W',
  redo: 'Shift+CommandOrControl+Z',
  cut: 'CommandOrControl+X',
  copy: 'CommandOrControl+C',
  paste: 'CommandOrControl+V',
  pasteAndMatchStyle: 'Shift+CommandOrControl+V',
  selectAll: 'CommandOrControl+A',
  resetZoom: 'CommandOrControl+0',
  zoomIn: 'CommandOrControl+Plus',
  zoomOut: 'CommandOrControl+-',
  togglefullscreen: 'F11',
  toggleDevTools: 'CommandOrControl+Shift+I',
  forceReload: 'Shift+CommandOrControl+R',
  minimize: 'CommandOrControl+M',
  zoom: null,
  front: null,
  window: null,
  windowMenu: null,
};

export function buildMenuTemplate(input: MenuInput): MenuItemConstructorOptions[] {
  const mac = input.platform === 'darwin';
  const a = input.actions;
  const settings: MenuItemConstructorOptions = {
    label: mac ? 'Settings…' : 'Settings',
    accelerator: 'CommandOrControl+,',
    click: () => a.openSettings(),
  };

  const appMenu: MenuItemConstructorOptions = {
    label: input.appName,
    submenu: [
      { role: 'about' },
      { type: 'separator' },
      settings,
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide' },
      { role: 'hideOthers' },
      { role: 'unhide' },
      { type: 'separator' },
      { role: 'quit' },
    ],
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      { label: 'Add Folder…', accelerator: 'CommandOrControl+O', click: () => a.addFolder() },
      ...(mac
        ? ([{ type: 'separator' }, { role: 'close' }] as MenuItemConstructorOptions[])
        : ([
            { type: 'separator' },
            settings,
            { type: 'separator' },
            { role: 'quit' },
          ] as MenuItemConstructorOptions[])),
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      // Not `role: 'undo'`: Cmd/Ctrl+Z is also the web UI's "undo the last bulk mark" outside text
      // fields, which the role would swallow. `undo` does text undo in a field, the web's otherwise.
      { label: 'Undo', accelerator: 'CommandOrControl+Z', click: () => a.undo() },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(mac ? ([{ role: 'pasteAndMatchStyle' }] as MenuItemConstructorOptions[]) : []),
      { role: 'selectAll' },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      // Data, not the page (`role: 'reload'` would reload the page on Cmd/Ctrl+R).
      { label: 'Refresh', accelerator: 'CommandOrControl+R', click: () => a.refresh() },
      ...(input.dev
        ? ([
            { role: 'forceReload', label: 'Reload Page' },
            { role: 'toggleDevTools' },
          ] as MenuItemConstructorOptions[])
        : []),
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: mac
      ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'close' }],
  };

  const helpMenu: MenuItemConstructorOptions = {
    label: 'Help',
    submenu: [
      { label: 'Show Daemon Log', click: () => a.showLog() },
      { label: 'Restart Daemon Connection', click: () => a.retryBackend() },
    ],
  };

  return [...(mac ? [appMenu] : []), fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
}

/** Every item of a template, depth first (tests and the accelerator check). */
export function flattenMenu(
  items: readonly MenuItemConstructorOptions[],
): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = [];
  for (const item of items) {
    out.push(item);
    if (Array.isArray(item.submenu)) out.push(...flattenMenu(item.submenu));
  }
  return out;
}

/** The accelerator an item ends up with: its own, else its role's default. */
export function effectiveAccelerator(item: MenuItemConstructorOptions): string | null {
  if (typeof item.accelerator === 'string') return item.accelerator;
  if (item.role) return ROLE_ACCELERATORS[item.role] ?? null;
  return null;
}
