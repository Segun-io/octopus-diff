/**
 * The desktop shell's Electron-free modules (the supervisor, the security policy, menus, window
 * state, shell env). The app's entry is `src/main.ts` (built to `dist/main.js`, package `main`);
 * this index is for tests and scripts (`scripts/smoke-backend.mjs`) through the source condition.
 */
export * from './args.js';
export * from './backend.js';
export * from './backend-command.js';
export * from './badge.js';
export * from './bridge.js';
export * from './cli-shim.js';
export * from './cli-shim-fs.js';
export * from './cli-shim-ipc.js';
export * from './cli-shim-service.js';
export * from './daemon-api.js';
export * from './editor-url.js';
export * from './ipc.js';
export * from './menu.js';
export * from './open-safety.js';
export * from './page-actions.js';
export * from './page-commands.js';
export * from './path-guard.js';
export * from './policy.js';
export * from './screens.js';
export * from './shell-env.js';
export * from './window-state.js';
export * from './worktrees-api.js';
