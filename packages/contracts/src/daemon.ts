import { z } from 'zod';
import type { Logger } from './common.js';
import type { GitCore, GitCoreOptions } from './git-core.js';

/**
 * The seam between `apps/cli` and `apps/daemon`. `@octopus-diff/daemon` exports
 * `startDaemon(options: StartDaemonOptions): Promise<DaemonHandle>`.
 */
export type StartDaemon = (options?: StartDaemonOptions) => Promise<DaemonHandle>;

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export interface WatchOptions {
  /** Default true. When false, only polling and manual refresh update summaries. */
  enabled?: boolean;
  /** Extra directory names / globs to ignore in working trees (added to the defaults). */
  ignore?: string[];
  /** Per-worktree debounce in ms (default 200, valid 150–300 per PLAN §5.6). */
  debounceMs?: number;
  /** Fallback poll interval for the focused worktree (default 30 000). */
  pollFocusedMs?: number;
  /** Fallback poll interval for all other worktrees (default 300 000). */
  pollIdleMs?: number;
  /** Skip native watchers entirely and poll (useful on WSL /mnt/* or NFS). */
  forcePolling?: boolean;
}

export interface StartDaemonOptions {
  /** Bind address (default 127.0.0.1). */
  host?: string;
  /** Port (default DEFAULT_PORT); 0 picks a free port. */
  port?: number;
  /** Required to bind anything other than a loopback address. */
  allowNonLoopback?: boolean;
  /** Extra values accepted in the `Host` header (loopback names are always accepted). */
  allowedHosts?: string[];
  /** Auth token. Default: read or create `<stateDir>/token` (mode 0600). */
  token?: string;
  /** Default `$XDG_STATE_HOME/octopus-diff` (`~/.local/state/octopus-diff`). */
  stateDir?: string;
  /** Default `$XDG_CONFIG_HOME/octopus-diff` (`~/.config/octopus-diff`). */
  configDir?: string;
  /** Directory with the built web UI (`apps/web/dist`) to serve at `/`; null = API only. */
  webRoot?: string | null;
  /** Repository paths to register at startup (idempotent). */
  projects?: string[];
  /** Scan roots to register at startup (idempotent). */
  scanRoots?: Array<{ path: string; depth?: number }>;
  watch?: WatchOptions;
  git?: GitCoreOptions;
  /** Inject a GitCore implementation (tests, benchmarks). Default: `createGitCore(git)`. */
  gitCore?: GitCore;
  /** Version reported by /api/health (the CLI passes its package version). */
  version?: string;
  logger?: Logger;
  logLevel?: LogLevel;
}

export interface DaemonHandle {
  /** Base URL without credentials, e.g. `http://127.0.0.1:7428`. */
  readonly url: string;
  /** URL that logs the browser in: `<url>/#token=<token>` (fragment, see common.ts). Print this one. */
  readonly authUrl: string;
  readonly token: string;
  readonly host: string;
  readonly port: number;
  readonly stateDir: string;
  readonly configDir: string;
  /** Stops watchers, timers and git processes, closes SQLite and the HTTP server. */
  close(): Promise<void>;
}

/**
 * The one JSON line `octopus-diff serve --ready-fd <n>` writes to file descriptor `n` once a daemon
 * is serving for the state directory (the desktop app and other supervisors read it).
 *
 * - `started`: this process started the daemon and keeps serving (it owns it).
 * - `attached`: a verified daemon was already running for the state directory; this process wrote
 *   the line and exits 0 (it does not own that daemon). `pid` and `version` are the running
 *   daemon's, so a supervisor can notice a version difference.
 *
 * `authUrl` is `<url>/#token=<token>`: it holds the access token, so the reader must never log it
 * or put it on a command line. The line is the only place `serve --ready-fd` writes the token.
 */
export const ServeReadySchema = z.object({
  mode: z.enum(['started', 'attached']),
  /** Base URL without credentials, e.g. `http://127.0.0.1:7428`. */
  url: z.url(),
  /** `<url>/#token=<token>` (see `DaemonHandle.authUrl`). Secret. */
  authUrl: z.url(),
  pid: z.number().int().positive(),
  version: z.string().min(1),
});
export type ServeReady = z.infer<typeof ServeReadySchema>;

/**
 * `serve --ready-stdout <nonce>` (desktop phase D, #22): the same ready line, framed on **stdout**
 * for a supervisor that cannot pass an extra descriptor (`wsl.exe` drops every fd above 2). The frame
 * is `"\n" + SERVE_READY_FRAME_PREFIX + nonce + " " + JSON + "\n"`: it starts on a line of its own
 * (the leading newline ends any partial line before it), its first byte is ASCII RS (0x1E, which
 * none of the CLI's text output contains), and it carries the nonce the supervisor chose for this
 * run, so a line with the prefix but another nonce (echoed output, a stray copy) is not the ready
 * line. The JSON is a `ServeReady`; it holds the token, so the reader must not log the frame.
 */
export const SERVE_READY_FRAME_PREFIX = '\u001eoctopus-diff-ready ';

/** The supervisor's per-run nonce: 16-128 URL-safe characters (it travels on a command line). */
export const ServeReadyNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);

export function formatServeReadyFrame(nonce: string, ready: ServeReady): string {
  return `\n${SERVE_READY_FRAME_PREFIX}${nonce} ${JSON.stringify(ready)}\n`;
}
