/**
 * The app's own command-line options (after Electron's). Unknown arguments are ignored: Electron
 * and Chromium switches, and the paths macOS/Linux launchers append, share argv.
 *
 *   --dev                     dev run: DevTools and the page reload item (`pnpm dev` passes it)
 *   --backend bundle|source   run the bundled CLI (default) or apps/cli/src under tsx (dev)
 *   --renderer-url <url>      load the UI from this http(s) origin (the Vite dev server)
 *   --state-dir <dir>         passed to `serve` (and so to the daemon), like the CLI option
 *   --config-dir <dir>        passed to `serve`
 *   --port <n>                passed to `serve`
 *   --app-data-dir <dir>      Electron's userData (window state, logs, Chromium profile, lock)
 */
import path from 'node:path';
import { httpOrigin } from './policy.js';

export interface DesktopArgs {
  dev: boolean;
  backend: 'bundle' | 'source';
  rendererUrl: string | null;
  stateDir: string | null;
  configDir: string | null;
  port: number | null;
  appDataDir: string | null;
}

export class DesktopArgsError extends Error {}

const VALUE_OPTIONS = [
  '--backend',
  '--renderer-url',
  '--state-dir',
  '--config-dir',
  '--port',
  '--app-data-dir',
] as const;

export function parseDesktopArgs(argv: readonly string[], cwd: string): DesktopArgs {
  const out: DesktopArgs = {
    dev: false,
    backend: 'bundle',
    rendererUrl: null,
    stateDir: null,
    configDir: null,
    port: null,
    appDataDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--dev') {
      out.dev = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (!(VALUE_OPTIONS as readonly string[]).includes(name)) continue;
    let value: string | undefined;
    if (eq !== -1) value = arg.slice(eq + 1);
    else {
      value = argv[i + 1];
      i++;
    }
    if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) {
      throw new DesktopArgsError(`${name} needs a value`);
    }
    switch (name) {
      case '--backend':
        if (value !== 'bundle' && value !== 'source') {
          throw new DesktopArgsError('--backend must be bundle or source');
        }
        out.backend = value;
        break;
      case '--renderer-url': {
        const origin = httpOrigin(value);
        if (!origin) throw new DesktopArgsError('--renderer-url must be an http(s) URL');
        out.rendererUrl = origin;
        break;
      }
      case '--state-dir':
        out.stateDir = path.resolve(cwd, value);
        break;
      case '--config-dir':
        out.configDir = path.resolve(cwd, value);
        break;
      case '--app-data-dir':
        out.appDataDir = path.resolve(cwd, value);
        break;
      case '--port': {
        if (!/^\d+$/.test(value) || Number(value) > 65_535) {
          throw new DesktopArgsError('--port must be an integer from 0 to 65535');
        }
        out.port = Number(value);
        break;
      }
    }
  }
  return out;
}

/** The `serve` options that follow from the desktop arguments. */
export function serveExtraArgs(args: DesktopArgs): string[] {
  const extra: string[] = [];
  if (args.stateDir) extra.push('--state-dir', args.stateDir);
  if (args.configDir) extra.push('--config-dir', args.configDir);
  if (args.port !== null) extra.push('--port', String(args.port));
  // The Vite dev server proxies /api with its own Host (`changeOrigin: false`).
  if (args.rendererUrl) extra.push('--allowed-host', new URL(args.rendererUrl).hostname);
  return extra;
}
