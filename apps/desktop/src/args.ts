/**
 * The app's own command-line options (after Electron's). Unknown arguments are ignored: Electron
 * and Chromium switches, and the paths macOS/Linux launchers append, share argv.
 *
 * A packaged build (`app.isPackaged`) refuses the dev-only options and the debugging switches
 * (DECISIONS #502, #507, #509): `--dev`, `--backend source`, `--renderer-url`, and any switch that
 * opens a debugger on a TCP port (`--remote-debugging-port`, `--inspect*`), which any local user
 * or a web page (DNS rebinding) could reach. `--renderer-url` takes loopback hosts only, packaged
 * or not: the window must never load the UI, and hand the daemon's token, to another machine.
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

export interface ParseOptions {
  /** `app.isPackaged`: an installed build, not `electron .` from the checkout. */
  isPackaged: boolean;
  /** Windows: Chromium also reads `/switch` and matches switch names case-insensitively. */
  platform?: NodeJS.Platform;
}

/**
 * Switches (Chromium's and Node's) that a packaged build refuses: each opens a debugger that
 * listens on a TCP port. `--remote-debugging-pipe` is not refused: it talks over inherited
 * descriptors, only to the process that launched the app, which (with the `RunAsNode` fuse on)
 * could run any code as the user anyway. The packaged-app smoke test uses it (DECISIONS #510).
 */
export const REFUSED_PACKAGED_SWITCHES = [
  'remote-debugging-port',
  'remote-debugging-address',
  'inspect',
  'inspect-brk',
  'inspect-port',
  'inspect-brk-node',
  'inspect-publish-uid',
  'debug',
  'debug-brk',
] as const;

/**
 * The name of a command-line switch the way Chromium reads it (`--x`, `-x`, and on Windows `/x`,
 * lowercased there), without its `=value`; null for a non-switch.
 */
export function switchName(arg: string, platform: NodeJS.Platform): string | null {
  const prefix = /^--?/.exec(arg) ?? (platform === 'win32' ? /^\//.exec(arg) : null);
  if (!prefix) return null;
  const rest = arg.slice(prefix[0].length);
  if (rest === '') return null;
  const eq = rest.indexOf('=');
  const name = eq === -1 ? rest : rest.slice(0, eq);
  return platform === 'win32' ? name.toLowerCase() : name;
}

/** Whether a packaged build refuses this switch (any `inspect…` name counts, for future ones). */
export function isRefusedPackagedSwitch(name: string): boolean {
  return (
    (REFUSED_PACKAGED_SWITCHES as readonly string[]).includes(name) || name.startsWith('inspect')
  );
}

/** A loopback host (`localhost`, 127.0.0.0/8, `[::1]`) as `URL.hostname` spells it. */
export function isLoopbackHost(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  const parts = hostname.split('.');
  return (
    parts.length === 4 &&
    parts[0] === '127' &&
    parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
  );
}

const VALUE_OPTIONS = [
  '--backend',
  '--renderer-url',
  '--state-dir',
  '--config-dir',
  '--port',
  '--app-data-dir',
] as const;

export function parseDesktopArgs(
  argv: readonly string[],
  cwd: string,
  options: ParseOptions,
): DesktopArgs {
  // Chromium reads every argv element as a possible switch, also one our parser takes as an
  // option's value (`--state-dir -remote-debugging-port=9222`): check them all first.
  if (options.isPackaged) {
    const platform = options.platform ?? process.platform;
    for (const arg of argv) {
      const name = switchName(arg, platform);
      if (name !== null && isRefusedPackagedSwitch(name)) {
        throw new DesktopArgsError(`--${name} is not available in an installed build`);
      }
    }
  }
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
      if (options.isPackaged) {
        throw new DesktopArgsError('--dev is not available in an installed build');
      }
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
        if (value === 'source' && options.isPackaged) {
          throw new DesktopArgsError('--backend source is not available in an installed build');
        }
        out.backend = value;
        break;
      case '--renderer-url': {
        if (options.isPackaged) {
          throw new DesktopArgsError('--renderer-url is not available in an installed build');
        }
        const origin = httpOrigin(value);
        if (!origin) throw new DesktopArgsError('--renderer-url must be an http(s) URL');
        if (!isLoopbackHost(new URL(origin).hostname)) {
          throw new DesktopArgsError(
            '--renderer-url must be a loopback URL (localhost, 127.x, [::1])',
          );
        }
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
