/**
 * Wires the `window.octopusDesktop` bridge (#20) to Electron: registers `ipc.ts`'s handlers with
 * `ipcMain`, gives them the shell, dialog, clipboard and badge calls, and routes menu commands to
 * the page (`page-commands.ts`). Kept out of `main.ts` so that file only calls `installBridge`.
 * Not unit tested (the rules are in the pure modules); the smoke tests drive it in a real window.
 *
 * Read-only guarantee: nothing here runs git or writes to a repository. Paths are never logged.
 */
import { realpath, stat } from 'node:fs/promises';
import type { DesktopCommand } from '@octopus-diff/contracts';
import { app, type BrowserWindow, clipboard, dialog, ipcMain, nativeImage, shell } from 'electron';
import { badgePlan, overlayDotBitmap } from './badge.js';
import { createCliShimHandlers } from './cli-shim-ipc.js';
import type { CliShim } from './cli-shim-service.js';
import { COMMAND_CHANNEL, createBridgeHandlers } from './ipc.js';
import { PageCommands } from './page-commands.js';
import { listWorktrees } from './worktrees-api.js';
import { createWslHandlers, type WslHandlerDeps } from './wsl-ipc.js';

export interface BridgeHost {
  window(): BrowserWindow | null;
  /** The UI's origin while the web UI is showing; null on our screens. */
  uiOrigin(): string | null;
  /** The daemon to resolve worktrees with (from the ready line); null when not ready. */
  daemon(): { url: string; token: string } | null;
  /** Runs one of phase A's constant scripts in the page (the fallback for older web builds). */
  runScript(script: string): void;
  log(line: string): void;
  /** The command installer (#21): its two channels get the bridge's guard. */
  cliShim: CliShim;
  /** The WSL backend choice (#22): its two channels get the bridge's guard too. */
  wsl: Omit<WslHandlerDeps, 'platform' | 'trusted' | 'log'>;
}

export interface InstalledBridge {
  /** A menu command: over IPC to a page that subscribed, else the fallback script. */
  command(command: DesktopCommand, fallbackScript: string): void;
  /** Clears the badge (a screen replaced the UI, so the count is stale). */
  clearBadge(): void;
}

export function installBridge(host: BridgeHost): InstalledBridge {
  const pages = new PageCommands();
  let badge = 0;
  let overlay: Electron.NativeImage | null = null;

  const applyBadge = (count: number) => {
    if (count === badge) return;
    badge = count;
    const plan = badgePlan(process.platform, count);
    if (plan.kind === 'count') {
      app.setBadgeCount(plan.count);
      return;
    }
    const win = host.window();
    if (!win) return;
    if (plan.kind === 'clear-overlay') {
      win.setOverlayIcon(null, '');
      return;
    }
    overlay ??= nativeImage.createFromBitmap(overlayDotBitmap(16), { width: 16, height: 16 });
    win.setOverlayIcon(overlay, plan.description);
  };

  const trusted = () => ({
    webContentsId: host.window()?.webContents.id ?? null,
    origin: host.uiOrigin(),
  });
  const handlers = createBridgeHandlers({
    platform: process.platform,
    trusted,
    listWorktrees: async () => {
      const d = host.daemon();
      return d ? listWorktrees(d.url, d.token) : null;
    },
    fs: { realpath, stat },
    showItemInFolder: (p) => shell.showItemInFolder(p),
    openPath: (p) => shell.openPath(p),
    openExternal: (url) => shell.openExternal(url),
    pickFolder: async (options) => {
      const win = host.window();
      if (!win) return null;
      const picked = await dialog.showOpenDialog(win, {
        title: options.title ?? 'Choose a folder',
        ...(options.defaultPath ? { defaultPath: options.defaultPath } : {}),
        properties: ['openDirectory', 'createDirectory'],
      });
      return picked.canceled ? null : (picked.filePaths[0] ?? null);
    },
    setBadge: applyBadge,
    writeClipboard: (text) => clipboard.writeText(text),
    commandsReady: (id) => pages.markReady(id),
    log: host.log,
  });
  const cliHandlers = createCliShimHandlers({ shim: host.cliShim, trusted, log: host.log });
  const wslHandlers = createWslHandlers({
    ...host.wsl,
    platform: process.platform,
    trusted,
    log: host.log,
  });
  for (const [channel, handler] of Object.entries({
    ...handlers.invoke,
    ...cliHandlers,
    ...wslHandlers,
  })) {
    ipcMain.handle(channel, (event, ...args) => handler(event, ...args));
  }
  for (const [channel, handler] of Object.entries(handlers.on)) {
    ipcMain.on(channel, (event, ...args) => handler(event, ...args));
  }

  // A page that navigates (a reload, a screen, another daemon) must subscribe again.
  app.on('web-contents-created', (_event, contents) => {
    const id = contents.id;
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) pages.reset(id);
    });
    contents.once('destroyed', () => pages.reset(id));
  });

  return {
    command(command, fallbackScript) {
      const win = host.window();
      if (!win || host.uiOrigin() === null) return;
      const route = pages.route(win.webContents.id, command, fallbackScript);
      if (route.kind === 'send') win.webContents.send(COMMAND_CHANNEL, route.command);
      else host.runScript(route.script);
    },
    clearBadge: () => applyBadge(0),
  };
}
