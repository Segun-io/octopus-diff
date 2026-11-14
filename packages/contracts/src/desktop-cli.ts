/**
 * The CLI-shim part of the desktop bridge (docs/DESKTOP.md §3.2, §3.4; roadmap #21): the app installs
 * an `octopus-diff` command that runs its bundled CLI. Types and schemas only (browser-safe): the
 * installer lives in `apps/desktop/src/cli-shim*.ts`, the web build feature-detects
 * `window.octopusDesktop?.installCli` (the `DesktopBridge` type itself belongs to #20's `desktop.ts`,
 * which extends `DesktopCliBridge`).
 *
 * Additive (DECISIONS #560): a new file, nothing existing changes.
 */
import { z } from 'zod';

/** IPC channels (`ipcRenderer.invoke` in the preload, `ipcMain.handle` in the main process). */
export const DESKTOP_CLI_CHANNELS = {
  status: 'octopus-diff:cli-status',
  install: 'octopus-diff:cli-install',
} as const;

/**
 * Where the command stands:
 * - `unavailable`: this run cannot install one (a dev run, or the app sits where it will not stay,
 *   e.g. a mounted dmg); `reason` says why.
 * - `not-installed`: no launcher yet and nothing in the way.
 * - `current`: the app's launcher is installed and points at this app.
 * - `outdated`: the app's launcher is installed but points elsewhere (the app moved or updated);
 *   installing rewrites it.
 * - `conflict`: another `octopus-diff` (an npm install, say) is in the way; nothing is overwritten
 *   and `conflict` names it.
 */
export const DesktopCliStateSchema = z.enum([
  'unavailable',
  'not-installed',
  'current',
  'outdated',
  'conflict',
]);
export type DesktopCliState = z.infer<typeof DesktopCliStateSchema>;

export const DesktopCliConflictSchema = z.object({
  /** `at-target`: a file we did not write sits where the launcher goes; `on-path`: elsewhere on PATH. */
  kind: z.enum(['at-target', 'on-path']),
  path: z.string(),
});
export type DesktopCliConflict = z.infer<typeof DesktopCliConflictSchema>;

export const DesktopCliStatusSchema = z.object({
  state: DesktopCliStateSchema,
  /** The launcher's file (existing or to be written); absent when `unavailable`. */
  path: z.string().optional(),
  /** Its directory is on PATH, so a new terminal finds the command. Absent when `unavailable`. */
  onPath: z.boolean().optional(),
  conflict: DesktopCliConflictSchema.optional(),
  /** `unavailable` only: a sentence for the user. */
  reason: z.string().optional(),
});
export type DesktopCliStatus = z.infer<typeof DesktopCliStatusSchema>;

export const DesktopCliOutcomeSchema = z.enum([
  /** A new launcher was written. */
  'installed',
  /** The app's own launcher was rewritten (it pointed elsewhere). */
  'updated',
  /** It was already correct; nothing was written. */
  'unchanged',
  /** Another `octopus-diff` is in the way; nothing was written. */
  'refused',
  /** Not possible in this run (see `status.reason`). */
  'unavailable',
  /** Writing failed (permissions, disk); nothing is left half written. */
  'failed',
]);
export type DesktopCliOutcome = z.infer<typeof DesktopCliOutcomeSchema>;

export const DesktopCliInstallResultSchema = z.object({
  outcome: DesktopCliOutcomeSchema,
  /** The status after the attempt. */
  status: DesktopCliStatusSchema,
  /** What to tell the user (one or two sentences, including the "not on your PATH" hint). */
  message: z.string(),
});
export type DesktopCliInstallResult = z.infer<typeof DesktopCliInstallResultSchema>;

/** The two bridge methods (`window.octopusDesktop.installCli()` / `.cliStatus()`). */
export interface DesktopCliBridge {
  installCli(): Promise<DesktopCliInstallResult>;
  cliStatus(): Promise<DesktopCliStatus>;
}
