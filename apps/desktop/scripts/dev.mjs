// `pnpm --filter @octopus-diff/desktop dev [-- <app options>]`: the desktop dev loop.
//
//   - esbuild watches src/ and rebuilds dist/main.js; each rebuild restarts Electron (SIGTERM: the
//     app quits normally and stops the daemon it started, then a new one starts).
//   - Electron runs with `--dev` (DevTools, page reload) and `--backend source`: the CLI from
//     apps/cli/src under tsx, run by Electron's Node, so dev matches the app. No CLI bundle needed,
//     but the daemon serves apps/web/dist (run `pnpm build` once), unless:
//   - UI work: `-- --renderer-url http://localhost:5173` loads the Vite dev server instead (start it
//     with `OCTOPUS_DIFF_API=http://127.0.0.1:<daemon port> pnpm --filter @octopus-diff/web dev`;
//     pass `--port <n>` here too so the port is known). Vite's HMR then works in the window.
//
// Other options are passed to the app (`--state-dir`, `--config-dir`, `--port`, `--app-data-dir`;
// see src/args.ts). Without `--state-dir` the app uses the normal state dir: it attaches to a
// running `octopus-diff serve`, or starts one.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMain, watchMain } from './build.mjs';
import { electronBinary } from './electron-binary.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const passThrough = process.argv.slice(2).filter((a) => a !== '--');

// The binary, downloading it on first use (that is what `require('electron')` does).
const binary =
  electronBinary() ?? createRequire(path.join(desktopRoot, 'package.json'))('electron');

let child = null;
let stopping = false;
let restartQueued = false;

function launch() {
  child = spawn(binary, [desktopRoot, '--dev', '--backend', 'source', ...passThrough], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
  });
  const current = child;
  current.on('exit', (code, signal) => {
    if (child === current) child = null;
    if (stopping) process.exit(0);
    if (restartQueued) {
      restartQueued = false;
      launch();
      return;
    }
    console.log(`[desktop-dev] Electron exited (${signal ?? code}); stopping the watcher`);
    process.exit(code ?? 0);
  });
}

function restart() {
  if (!child) return launch();
  restartQueued = true;
  child.kill('SIGTERM');
}

await buildMain();
let first = true;
const ctx = await watchMain(() => {
  if (first) {
    first = false;
    return;
  }
  console.log('[desktop-dev] main.js rebuilt: restarting Electron');
  restart();
});
launch();

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true;
    void ctx.dispose();
    if (child) child.kill('SIGTERM');
    else process.exit(0);
  });
}
