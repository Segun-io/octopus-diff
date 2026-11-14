/**
 * The `window.octopusDesktop` object the preload exposes (docs/DESKTOP.md §3.4), as a factory over
 * injected `ipcRenderer`/`webUtils`/user-activation calls so it is unit tested without Electron.
 * `preload.cts` only wires it to Electron and `contextBridge`.
 *
 * Defence in depth: the actions that act on the OS (`pickFolder`, `revealPath`, `openPath`,
 * `openInEditor`, `copyText`) need a user gesture (`navigator.userActivation.isActive`, checked in
 * the preload's isolated world, which page scripts cannot reach). A script on the page that runs
 * without a click or key press gets `no-user-gesture`, and the main process is not even asked. The
 * main process still checks everything itself (`ipc.ts`). Nothing here throws to the page.
 */
import {
  DESKTOP_CLI_CHANNELS,
  DESKTOP_COMMANDS,
  type DesktopActionResult,
  type DesktopBridge,
  type DesktopCliInstallResult,
  type DesktopCliStatus,
  type DesktopCommand,
  type DesktopPlatform,
} from '@octopus-diff/contracts';
import { BRIDGE_CHANNELS, COMMAND_CHANNEL } from './ipc-channels.js';

export interface PreloadIpc {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  send(channel: string, ...args: unknown[]): void;
  on(channel: string, listener: (event: unknown, ...args: unknown[]) => void): void;
}

export interface BridgeEnv {
  ipc: PreloadIpc;
  /** `process.platform`. */
  platform: string;
  /** `navigator.userActivation.isActive`. */
  hasUserActivation(): boolean;
  /** `webUtils.getPathForFile`. */
  getPathForFile(file: File): string;
}

const NO_GESTURE: DesktopActionResult = {
  ok: false,
  reason: 'no-user-gesture',
  message: 'Only available from a click or a key press.',
};
const FAILED: DesktopActionResult = {
  ok: false,
  reason: 'failed',
  message: 'The desktop app did not answer.',
};

const CLI_UNANSWERED: DesktopCliStatus = {
  state: 'unavailable',
  reason: 'The desktop app did not answer.',
};

function isCliStatus(value: unknown): value is DesktopCliStatus {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { state?: unknown }).state === 'string'
  );
}

function isCliResult(value: unknown): value is DesktopCliInstallResult {
  const v = value as { outcome?: unknown; message?: unknown; status?: unknown };
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof v.outcome === 'string' &&
    typeof v.message === 'string' &&
    isCliStatus(v.status)
  );
}

function isResult(value: unknown): value is DesktopActionResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  );
}

export function createDesktopBridge(env: BridgeEnv): DesktopBridge {
  const platform: DesktopPlatform =
    env.platform === 'darwin' || env.platform === 'win32' ? env.platform : 'linux';
  const listeners = new Set<(command: DesktopCommand) => void>();
  let subscribed = false;

  const action = async (channel: string, args: unknown[]): Promise<DesktopActionResult> => {
    if (!env.hasUserActivation()) return NO_GESTURE;
    try {
      const result = await env.ipc.invoke(channel, ...args);
      return isResult(result) ? result : FAILED;
    } catch {
      return FAILED;
    }
  };

  return {
    version: 1,
    platform,
    async pickFolder(options) {
      if (!env.hasUserActivation()) return null;
      try {
        const result = await env.ipc.invoke(BRIDGE_CHANNELS.pickFolder, options);
        return typeof result === 'string' ? result : null;
      } catch {
        return null;
      }
    },
    revealPath: (worktreeId, relPath) => action(BRIDGE_CHANNELS.revealPath, [worktreeId, relPath]),
    openPath: (worktreeId, relPath) => action(BRIDGE_CHANNELS.openPath, [worktreeId, relPath]),
    openInEditor: (worktreeId, relPath, options) =>
      action(BRIDGE_CHANNELS.openInEditor, [worktreeId, relPath, options]),
    setBadge(count) {
      env.ipc.invoke(BRIDGE_CHANNELS.setBadge, count).catch(() => undefined);
    },
    getPathForFile(file) {
      try {
        const p = env.getPathForFile(file);
        return typeof p === 'string' && p !== '' ? p : null;
      } catch {
        return null;
      }
    },
    async cliStatus() {
      try {
        const result = await env.ipc.invoke(DESKTOP_CLI_CHANNELS.status);
        return isCliStatus(result) ? result : CLI_UNANSWERED;
      } catch {
        return CLI_UNANSWERED;
      }
    },
    async installCli() {
      const failed = (message: string): DesktopCliInstallResult => ({
        outcome: 'failed',
        status: CLI_UNANSWERED,
        message,
      });
      // Writes a file in the user's home: only from a click or key press, like the other actions.
      if (!env.hasUserActivation()) return failed('Only available from a click or a key press.');
      try {
        const result = await env.ipc.invoke(DESKTOP_CLI_CHANNELS.install);
        return isCliResult(result) ? result : failed('The desktop app did not answer.');
      } catch {
        return failed('The desktop app did not answer.');
      }
    },
    async copyText(text) {
      if (!env.hasUserActivation()) return false;
      try {
        return (await env.ipc.invoke(BRIDGE_CHANNELS.copyText, text)) === true;
      } catch {
        return false;
      }
    },
    onCommand(listener) {
      listeners.add(listener);
      if (!subscribed) {
        subscribed = true;
        env.ipc.on(COMMAND_CHANNEL, (_event, command) => {
          if (typeof command !== 'string') return;
          if (!(DESKTOP_COMMANDS as readonly string[]).includes(command)) return;
          for (const l of [...listeners]) {
            try {
              l(command as DesktopCommand);
            } catch {
              // One broken listener must not stop the others.
            }
          }
        });
        env.ipc.send(BRIDGE_CHANNELS.commandsReady);
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
