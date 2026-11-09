#!/usr/bin/env node
// `pnpm dev`: one command for hot-reload development.
//
//   [daemon]  `tsx watch` runs apps/cli/src/index.ts `serve` from sources; it restarts on any edit to
//             a file the daemon imported (apps/cli, apps/daemon, packages/* sources).
//   [web]     Vite serves apps/web with hot module reload and proxies /api (SSE included) to it.
//
// Both listen on the LAN by default (reachable as odino / odino.local); `--loopback` keeps them on
// 127.0.0.1. The daemon keeps its own state dir, apart from the production server's. Children run
// from argv arrays (never a shell), each in its own process group so teardown reaches the
// grandchildren (the daemon under tsx, esbuild under Vite). See `pnpm dev --help`.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import { homedir, networkInterfaces } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import {
  createDaemonOutputFilter,
  DevUsageError,
  daemonServeArgs,
  lanIPv4Addresses,
  parseDevArgs,
  USAGE,
  webAuthUrls,
  webEnv,
} from './lib/dev-options.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDir = path.join(repoRoot, 'apps/web');
/** How long children get to exit after SIGTERM before SIGKILL (tsx itself force-kills at 5 s). */
const STOP_TIMEOUT_MS = 8000;

const log = (line) => process.stdout.write(`[dev]    ${line}\n`);
const fail = (message) => {
  process.stderr.write(`[dev]    error: ${message}\n`);
  process.exit(1);
};

let opts;
try {
  opts = parseDevArgs(process.argv.slice(2), process.env, {
    repoRoot,
    home: process.env.HOME || homedir(),
    cwd: process.env.INIT_CWD || process.cwd(),
    lanAddresses: lanIPv4Addresses(networkInterfaces()),
  });
} catch (error) {
  if (error instanceof DevUsageError) fail(`${error.message}\n\n${USAGE}`);
  throw error;
}
if (opts.help) {
  process.stdout.write(`${USAGE}\n`);
  process.exit(0);
}

function resolveBin(fromDir, pkg, bin) {
  const require = createRequire(path.join(fromDir, 'package.json'));
  const manifestPath = require.resolve(`${pkg}/package.json`);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const rel = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[bin];
  if (!rel) throw new Error(`${pkg} has no "${bin}" bin`);
  return path.join(path.dirname(manifestPath), rel);
}

/** Fails early with a clear message instead of a crash loop under `tsx watch`. */
function assertPortFree(port, host, what) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (error) => {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      fail(
        code === 'EADDRINUSE'
          ? `${what} port ${port} is already in use (another \`pnpm dev\`?). Stop it, or pass ` +
              `--${what}-port <n>.`
          : `cannot listen on ${host}:${port} for the ${what}: ${error.message}`,
      );
    });
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve()));
  });
}

const bindHost = opts.lan ? '::' : '127.0.0.1';
await assertPortFree(opts.daemonPort, bindHost, 'daemon');
await assertPortFree(opts.webPort, bindHost, 'web');

const tsxCli = resolveBin(repoRoot, 'tsx', 'tsx');
const viteCli = resolveBin(webDir, 'vite', 'vite');
const baseEnv = { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' };

/** @type {Map<string, import('node:child_process').ChildProcess>} */
const children = new Map();
let stopping = false;
let exitCode = 0;
let daemonRestarts = -1;
let bannerToken;

/** `filter(line)` returns `{ show }` plus whatever `onLine` needs. */
function start(name, args, cwd, env, filter = () => ({ show: true }), onLine = () => {}) {
  const label = `[${name}]`.padEnd(8);
  const child = spawn(process.execPath, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  children.set(name, child);
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY }).on('line', (line) => {
      const result = filter(line);
      if (result.show) process.stdout.write(`${label} ${line}\n`);
      onLine(result);
    });
  }
  child.on('error', (error) => {
    log(`${name} could not start: ${error.message}`);
    exitCode = 1;
    stopAll();
  });
  child.on('exit', (code, signal) => {
    children.delete(name);
    if (!stopping) {
      log(`${name} exited (${signal ?? `code ${code}`}); stopping the rest`);
      exitCode = 1;
      stopAll();
    }
    if (children.size === 0) process.exit(exitCode);
  });
  return child;
}

function signal(child, name, group) {
  if (child.pid === undefined) return;
  try {
    process.kill(group ? -child.pid : child.pid, name);
  } catch {
    // Already gone.
  }
}
const signalGroup = (child, name) => signal(child, name, true);

function stopAll() {
  if (stopping) return;
  stopping = true;
  // SIGTERM to the child only: `tsx watch` relays it to the daemon, which shuts down cleanly on the
  // first SIGTERM but skips the clean shutdown on a second one. SIGKILL goes to the whole group.
  for (const child of children.values()) signal(child, 'SIGTERM', false);
  setTimeout(() => {
    for (const [name, child] of children) {
      log(`${name} did not stop within ${STOP_TIMEOUT_MS / 1000} s; killing it`);
      signalGroup(child, 'SIGKILL');
    }
  }, STOP_TIMEOUT_MS).unref();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (stopping) return;
    log(`received ${signal}, stopping`);
    stopAll();
  });
}
// Last resort (an uncaught error here): don't leave the process groups running.
process.on('exit', () => {
  for (const child of children.values()) signalGroup(child, 'SIGKILL');
});

function printBanner(token) {
  const urls = webAuthUrls(opts, token);
  const tokenFile = path.join(opts.stateDir, 'token');
  const width = Math.max(...urls.map((u) => u.label.length));
  log('');
  log(
    `octopus-diff dev: web UI with hot reload on :${opts.webPort}, daemon from sources on :${opts.daemonPort}`,
  );
  log('');
  for (const { label, url } of urls) log(`  ${`${label}:`.padEnd(width + 2)}${url}`);
  log('');
  if (!token) log(`  Add #token=<the token in ${tokenFile}> to open the UI.`);
  log(`  API:   http://127.0.0.1:${opts.daemonPort} (proxied as /api by Vite)`);
  log(`  State: ${opts.stateDir} (token file: ${tokenFile})`);
  log(`  Repos: ${opts.repos.join(', ')}`);
  if (token) log('  The URLs contain the access token; treat them like passwords.');
  if (opts.lan) log('  LAN traffic is plain HTTP: use it only on networks you trust.');
  log('  Edits reload the UI (Vite HMR) or restart the daemon (tsx watch). Ctrl+C stops both.');
  log('');
}

start(
  'daemon',
  [
    tsxCli,
    'watch',
    '--clear-screen=false',
    '--conditions=@octopus-diff/source',
    path.join('apps', 'cli', 'src', 'index.ts'),
    ...daemonServeArgs(opts),
  ],
  repoRoot,
  baseEnv,
  createDaemonOutputFilter(),
  (result) => {
    if (result.alreadyRunning) {
      log(
        `another daemon already uses the state dir ${opts.stateDir}; stop it or pass --state-dir`,
      );
      exitCode = 1;
      stopAll();
      return;
    }
    if (!result.ready) return;
    daemonRestarts++;
    if (result.token !== bannerToken) {
      bannerToken = result.token;
      printBanner(result.token);
    } else {
      log(`daemon restarted (#${daemonRestarts}); open pages reconnect on their own`);
    }
  },
);

start('web', [viteCli, '--clearScreen', 'false'], webDir, { ...baseEnv, ...webEnv(opts) });
