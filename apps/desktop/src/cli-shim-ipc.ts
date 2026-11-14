/**
 * The main-process side of the bridge's `installCli()` / `cliStatus()` (docs/DESKTOP.md §3.4, §5;
 * roadmap #21). Built on the bridge's guard (`createGuard` in `ipc.ts`, DECISIONS #547), so these
 * channels get exactly the checks of every other one: our window's `webContents`, its main frame,
 * the UI's origin while the UI shows (nothing while a screen is up), no arguments. Results must
 * pass the contract's schema; a refusal, a broken result or a failing shim is a value in the
 * contract's shape (`unavailable` / `failed`), never a throw across IPC, and is logged with its
 * reason only. Nothing here runs git.
 */
import {
  DESKTOP_CLI_CHANNELS,
  type DesktopCliInstallResult,
  DesktopCliInstallResultSchema,
  type DesktopCliOutcome,
  type DesktopCliStatus,
  DesktopCliStatusSchema,
} from '@octopus-diff/contracts';
import { z } from 'zod';
import type { CliShim } from './cli-shim-service.js';
import { createGuard, type InvokeHandler, type TrustedSender } from './ipc.js';
import { type Refusal, refuse } from './path-guard.js';

const NoArgs = z.tuple([]);

function refusedStatus(refusal: Refusal): DesktopCliStatus {
  return { state: 'unavailable', reason: refusal.message };
}

function refusedInstall(refusal: Refusal): DesktopCliInstallResult {
  return { outcome: 'failed', status: refusedStatus(refusal), message: refusal.message };
}

/** The two handlers, keyed by channel, for `ipcMain.handle` (`bridge-main.ts` registers them). */
export function createCliShimHandlers(options: {
  shim: CliShim;
  trusted(): TrustedSender;
  log(note: string): void;
}): Record<string, InvokeHandler> {
  const guard = createGuard(options);
  const failed = (method: string) =>
    guard.note(method, refuse('failed', 'The command installer did not answer.'));
  return {
    [DESKTOP_CLI_CHANNELS.status]: guard.handler('cliStatus', NoArgs, refusedStatus, async () => {
      try {
        const parsed = DesktopCliStatusSchema.safeParse(await options.shim.status());
        return parsed.success ? parsed.data : refusedStatus(failed('cliStatus'));
      } catch {
        return refusedStatus(failed('cliStatus'));
      }
    }),
    [DESKTOP_CLI_CHANNELS.install]: guard.handler(
      'installCli',
      NoArgs,
      refusedInstall,
      async () => {
        try {
          const parsed = DesktopCliInstallResultSchema.safeParse(await options.shim.install());
          return parsed.success ? parsed.data : refusedInstall(failed('installCli'));
        } catch {
          return refusedInstall(failed('installCli'));
        }
      },
    ),
  };
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
