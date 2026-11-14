/**
 * The main-process side of `wslStatus()` / `setWslDistro()` (#22; docs/DESKTOP.md §11). Built on
 * the bridge's guard (`createGuard`, DECISIONS #547): our window's main frame on the UI's origin,
 * zod on the exact argument tuple. Then:
 *
 * - Windows only: elsewhere the status is `available: false` and `wsl.exe` is never run.
 * - A distro must be one that `wsl.exe -l -v` lists right now, pass `isSafeDistroName`, and not
 *   belong to a tool (docker-desktop…); null means the Windows backend.
 * - The choice is stored in the **app's own** settings file (`desktop-settings.ts`), never in the
 *   daemon's registry; only after it is saved is it applied (the backend restarts).
 * - Refusals are values in the contract's shape; logged with the reason only.
 */
import {
  DESKTOP_WSL_CHANNELS,
  type DesktopWslDistro,
  type DesktopWslSetResult,
  type DesktopWslStatus,
} from '@octopus-diff/contracts';
import { z } from 'zod';
import type { DesktopSettings } from './desktop-settings.js';
import { createGuard, type InvokeHandler, type TrustedSender } from './ipc.js';
import type { Refusal } from './path-guard.js';
import { isSafeDistroName } from './wsl.js';
import type { WslList } from './wsl-backend.js';

export interface WslHandlerDeps {
  platform: NodeJS.Platform;
  trusted(): TrustedSender;
  log(note: string): void;
  /** `wsl.exe -l -v`, parsed. */
  list(): Promise<WslList>;
  settings(): DesktopSettings;
  save(next: DesktopSettings): Promise<void>;
  /** The distro the running backend uses (null: Windows, or none yet). */
  active(): string | null;
  /** Switch the backend to this choice (after it was saved). */
  apply(distro: string | null): void;
}

const NoArgs = z.tuple([]);
const SetArgs = z.tuple([z.string().min(1).max(64).nullable()]);

const ONLY_WINDOWS = 'Only the Windows app can run its backend in WSL.';

function contractDistros(list: readonly DesktopWslDistro[]): DesktopWslDistro[] {
  return list.map(({ name, state, version, isDefault, system }) => ({
    name,
    state,
    version,
    isDefault,
    system,
  }));
}

export function createWslHandlers(deps: WslHandlerDeps): Record<string, InvokeHandler> {
  const guard = createGuard(deps);

  const base = (): Pick<DesktopWslStatus, 'selected' | 'active'> => ({
    selected: deps.settings().wslDistro,
    active: deps.active(),
  });
  const unavailable = (reason: string): DesktopWslStatus => ({
    available: false,
    reason,
    distros: [],
    ...base(),
  });

  async function status(): Promise<{ status: DesktopWslStatus; list: WslList | null }> {
    if (deps.platform !== 'win32') return { status: unavailable(ONLY_WINDOWS), list: null };
    let list: WslList;
    try {
      list = await deps.list();
    } catch {
      list = { ok: false, reason: 'wsl.exe did not answer.' };
    }
    if (!list.ok) return { status: unavailable(list.reason), list };
    return {
      status: { available: true, distros: contractDistros(list.distros), ...base() },
      list,
    };
  }

  const refusedStatus = (refusal: Refusal): DesktopWslStatus => unavailable(refusal.message);
  const refusedSet = (refusal: Refusal): DesktopWslSetResult => ({
    ok: false,
    message: refusal.message,
    status: unavailable(refusal.message),
  });

  return {
    [DESKTOP_WSL_CHANNELS.status]: guard.handler('wslStatus', NoArgs, refusedStatus, async () => {
      return (await status()).status;
    }),
    [DESKTOP_WSL_CHANNELS.set]: guard.handler(
      'setWslDistro',
      SetArgs,
      refusedSet,
      async ([distro]) => {
        const now = await status();
        const refuse = (message: string): DesktopWslSetResult => {
          deps.log('bridge: setWslDistro refused (invalid)');
          return { ok: false, message, status: now.status };
        };
        if (deps.platform !== 'win32') return refuse(ONLY_WINDOWS);
        if (distro !== null) {
          if (!isSafeDistroName(distro)) return refuse('That is not a WSL distro name.');
          if (!now.list?.ok) return refuse(now.status.reason ?? 'WSL is not available.');
          const found = now.list.distros.find((d) => d.name === distro);
          if (!found) return refuse(`"${distro}" is not a WSL distro on this machine.`);
          if (found.system) return refuse(`"${distro}" belongs to another tool.`);
        }
        const current = deps.settings();
        if (current.wslDistro === distro) {
          return { ok: true, message: 'Nothing changed.', status: now.status };
        }
        try {
          await deps.save({ ...current, wslDistro: distro });
        } catch {
          deps.log('bridge: setWslDistro failed (the settings file could not be written)');
          return {
            ok: false,
            message: 'The choice could not be saved (the app settings file is not writable).',
            status: now.status,
          };
        }
        deps.apply(distro);
        return {
          ok: true,
          message:
            distro === null
              ? 'Switching to the backend that runs on Windows…'
              : `Switching to the backend in WSL ("${distro}")…`,
          status: { ...now.status, ...base(), selected: distro },
        };
      },
    ),
  };
}
