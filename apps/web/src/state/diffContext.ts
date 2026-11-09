/**
 * Context-line constants, in a leaf module: `commandRegistry.ts` needs `CONTEXT_STEP` at module
 * evaluation time, and importing it from `commands.ts` closed an import cycle that broke
 * `pnpm dev:mock` ("Cannot access 'CONTEXT_STEP' before initialization").
 */
export const CONTEXT_STEP = 20;
export const DEFAULT_CONTEXT = 3;
