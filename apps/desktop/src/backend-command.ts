/**
 * Which program and arguments run `serve` (docs/DESKTOP.md §3.1, §7 "Dev loop"):
 *
 * - `bundle`: `<electron> <app>/dist/cli/index.js serve …` (the CLI bundle from
 *   `apps/cli/scripts/bundle.mjs`, copied by `scripts/build.mjs`).
 * - `source` (dev): `<electron> --import <tsx/esm> --conditions=@octopus-diff/source
 *   <repo>/apps/cli/src/index.ts serve …`: the CLI from sources, still under Electron's Node so
 *   dev matches the app. tsx is loaded as a hook (not its CLI wrapper, which would start a second
 *   process and not pass fd 3 on).
 *
 * Both run with `ELECTRON_RUN_AS_NODE=1` (added by the supervisor).
 */
import path from 'node:path';
import { serveArgs } from './backend.js';

export interface BackendCommandInput {
  mode: 'bundle' | 'source';
  execPath: string;
  /** The directory of the built `main.js` (`apps/desktop/dist`, or inside the asar later). */
  distDir: string;
  /** `tsx/esm` as a file URL (source mode only). */
  tsxEsm?: string | undefined;
  extra: readonly string[];
}

export interface BackendCommand {
  command: string;
  args: string[];
  cwd: string | undefined;
  entry: string;
}

export function cliBundleEntry(distDir: string): string {
  return path.join(distDir, 'cli', 'index.js');
}

export function cliSourceEntry(distDir: string): string {
  return path.resolve(distDir, '..', '..', 'cli', 'src', 'index.ts');
}

export function backendCommand(input: BackendCommandInput): BackendCommand {
  if (input.mode === 'bundle') {
    const entry = cliBundleEntry(input.distDir);
    return {
      command: input.execPath,
      args: [entry, ...serveArgs(input.extra)],
      cwd: undefined,
      entry,
    };
  }
  if (!input.tsxEsm) throw new Error('source mode needs tsx (run from the repository checkout)');
  const entry = cliSourceEntry(input.distDir);
  return {
    command: input.execPath,
    args: [
      '--import',
      input.tsxEsm,
      '--conditions=@octopus-diff/source',
      entry,
      ...serveArgs(input.extra),
    ],
    cwd: path.resolve(input.distDir, '..', '..', '..'),
    entry,
  };
}
