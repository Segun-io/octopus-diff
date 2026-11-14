/**
 * The WSL part of the desktop bridge (docs/DESKTOP.md §11; roadmap #22): on Windows the app can run
 * its backend inside a WSL distro. The web's Settings lists the distros and stores the choice in the
 * **app's own config** (never in the daemon's registry) through these two methods. Types and schemas
 * only (browser-safe); the main process (`apps/desktop/src/wsl-ipc.ts`) validates every argument.
 *
 * Additive (DECISIONS #611): a new file, and `DesktopBridge` gains the two methods as optional ones
 * (an older app has none, so the web feature-detects them).
 */
import { z } from 'zod';

export const DESKTOP_WSL_CHANNELS = {
  status: 'octopus-diff:wsl-status',
  set: 'octopus-diff:wsl-set',
} as const;

export const DesktopWslDistroSchema = z.object({
  name: z.string().min(1),
  /** `other`: a state `wsl.exe` printed that is not Running/Stopped (or a localized one). */
  state: z.enum(['running', 'stopped', 'other']),
  version: z.union([z.literal(1), z.literal(2)]),
  /** The default distro (`*` in `wsl.exe -l -v`). */
  isDefault: z.boolean(),
  /** A distro that tools run for themselves (docker-desktop, rancher-desktop, podman): not offered. */
  system: z.boolean(),
});
export type DesktopWslDistro = z.infer<typeof DesktopWslDistroSchema>;

export const DesktopWslStatusSchema = z.object({
  /** False off Windows, or when WSL is missing or lists nothing; `reason` says why. */
  available: z.boolean(),
  reason: z.string().optional(),
  distros: z.array(DesktopWslDistroSchema),
  /** The distro the app's config names (null: the Windows backend). */
  selected: z.string().nullable(),
  /** The distro the running backend uses (null: the Windows backend, or none yet). */
  active: z.string().nullable(),
});
export type DesktopWslStatus = z.infer<typeof DesktopWslStatusSchema>;

export const DesktopWslSetResultSchema = z.object({
  ok: z.boolean(),
  /** A sentence for the user (what happens next, or why nothing changed). */
  message: z.string(),
  status: DesktopWslStatusSchema,
});
export type DesktopWslSetResult = z.infer<typeof DesktopWslSetResultSchema>;

/** `window.octopusDesktop.wslStatus()` / `.setWslDistro()` (Windows app only). */
export interface DesktopWslBridge {
  wslStatus(): Promise<DesktopWslStatus>;
  /** A distro name from `wslStatus().distros`, or null for the Windows backend. Needs a user gesture. */
  setWslDistro(distro: string | null): Promise<DesktopWslSetResult>;
}
