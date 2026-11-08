#!/usr/bin/env node
/**
 * `octopus-diff` command-line entry point (bin: `dist/index.js`). See `cli.ts` for the commands.
 * Importing this module has no side effects unless it is the process's main module.
 */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { run } from './cli.js';
import { defaultDeps } from './deps.js';

export { helpText, run, USAGE } from './cli.js';
export type { CliDeps } from './deps.js';
export { defaultDeps } from './deps.js';

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    // npm/pnpm bin shims are symlinks: compare real paths.
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  run(process.argv.slice(2), defaultDeps()).then(
    (code) => {
      process.exitCode = code;
      // Normally the event loop is empty now and Node exits by itself (flushing stdout). If
      // something still holds it open (e.g. a handle the daemon forgot to close), exit anyway.
      setTimeout(() => process.exit(code), 2_000).unref();
    },
    (error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
