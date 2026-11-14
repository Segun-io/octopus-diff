/**
 * The main-process side of the bridge's `installCli()` / `cliStatus()` (docs/DESKTOP.md §3.4, §5;
 * roadmap #21). The preload and `window.octopusDesktop` belong to #20 and only have to
 * `ipcRenderer.invoke(DESKTOP_CLI_CHANNELS.install | .status)`.
 *
 * Every handler checks the sender's frame is on the daemon's origin (a screen, another site or a
 * missing frame is refused), accepts no arguments, and returns a value that passed the contract's
 * schema. Nothing here runs git.
 */
import {
  DESKTOP_CLI_CHANNELS,
  DesktopCliInstallResultSchema,
  type DesktopCliOutcome,
  DesktopCliStatusSchema,
} from '@octopus-diff/contracts';
import type { CliShim } from './cli-shim-service.js';
import { httpOrigin } from './policy.js';

export interface CliIpcEvent {
  senderFrame?: { url: string } | null;
}

export interface IpcMainLike {
  handle(channel: string, listener: (event: CliIpcEvent, ...args: unknown[]) => unknown): void;
}

/** True when the sending frame's URL is on the daemon's (UI's) origin. */
export function isTrustedSender(senderUrl: string | undefined, uiOrigin: string | null): boolean {
  if (uiOrigin === null || senderUrl === undefined) return false;
  return httpOrigin(senderUrl) === uiOrigin;
}

export function registerCliShimIpc(options: {
  ipcMain: IpcMainLike;
  shim: CliShim;
  /** The origin the window shows (null while a screen is up). */
  uiOrigin(): string | null;
  log(note: string): void;
}): void {
  const guarded =
    (channel: string, run: () => Promise<unknown>) =>
    async (event: CliIpcEvent, ...args: unknown[]): Promise<unknown> => {
      if (!isTrustedSender(event.senderFrame?.url, options.uiOrigin())) {
        options.log(`refused ${channel} from an untrusted sender`);
        throw new Error('untrusted sender');
      }
      if (args.length > 0) throw new Error(`${channel} takes no arguments`);
      return run();
    };
  options.ipcMain.handle(
    DESKTOP_CLI_CHANNELS.status,
    guarded(DESKTOP_CLI_CHANNELS.status, async () =>
      DesktopCliStatusSchema.parse(await options.shim.status()),
    ),
  );
  options.ipcMain.handle(
    DESKTOP_CLI_CHANNELS.install,
    guarded(DESKTOP_CLI_CHANNELS.install, async () =>
      DesktopCliInstallResultSchema.parse(await options.shim.install()),
    ),
  );
}

/** The title of the dialog (or toast) that shows an install result. */
export function outcomeTitle(outcome: DesktopCliOutcome): string {
  switch (outcome) {
    case 'installed':
      return "The 'octopus-diff' command is installed.";
    case 'updated':
      return "The 'octopus-diff' command was updated.";
    case 'unchanged':
      return "The 'octopus-diff' command is already installed.";
    case 'refused':
      return "The 'octopus-diff' command was not installed: another one is already there.";
    case 'unavailable':
      return "The 'octopus-diff' command cannot be installed from here.";
    case 'failed':
      return "The 'octopus-diff' command could not be installed.";
  }
}
