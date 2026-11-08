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
  /** URL that logs the browser in: `<url>/?token=<token>`. Print this one. */
  readonly authUrl: string;
  readonly token: string;
  readonly host: string;
  readonly port: number;
  readonly stateDir: string;
  readonly configDir: string;
  /** Stops watchers, timers and git processes, closes SQLite and the HTTP server. */
  close(): Promise<void>;
}
