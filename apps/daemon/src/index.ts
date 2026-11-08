/**
 * @octopus-diff/daemon — HTTP + SSE API, project registry, watcher, review store (PLAN §5, WS2).
 *
 * The CLI uses `startDaemon` (the `StartDaemon` contract). The other exports exist for tests,
 * benchmarks and tooling.
 */
export { type AppDeps, createApp } from './app.js';
export { type CoreOptions, DaemonCore } from './core.js';
export { type Daemon, type DaemonInternals, type DaemonOptions, startDaemon } from './daemon.js';
export { ApiError, toApiError } from './errors.js';
export { EventHub } from './events.js';
export { hashId } from './ids.js';
export { createLogger } from './logger.js';
export { resolveDirs } from './paths.js';
export { isHostAllowed, isLoopbackHost, isOriginAllowed } from './security.js';
export { Store } from './store.js';
export { isValidToken, loadOrCreateToken, tokensEqual } from './token.js';
export { DEFAULT_WORKTREE_IGNORES, WatcherService } from './watcher.js';
