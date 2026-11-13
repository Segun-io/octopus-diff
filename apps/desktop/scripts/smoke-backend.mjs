// Smoke test of the backend supervisor (src/backend.ts) against the REAL built CLI, run by the real
// Electron binary in Node mode (`ELECTRON_RUN_AS_NODE=1`), the way the app runs it. No window and
// no display needed:
//
//   pnpm --filter @octopus-diff/desktop smoke:backend          (after `pnpm build`)
//   node apps/desktop/scripts/smoke-backend.mjs [--node]       (--node: plain Node if no Electron)
//
// Scenarios: started (status sees it, stdin EOF stops it, daemon.json removed) · attached (pid of
// the running daemon; stopping the app leaves it up) · the attached daemon goes away (serve runs
// again and starts one) · restart after the daemon is SIGKILLed · no orphan after the PARENT is
// SIGKILLed (EOF on stdin) · git missing (health says unsupported).
//
// Skips (exit 0) without the Electron binary or without `dist/cli` (run `pnpm build`). Only temp
// dirs (state, config, one scratch repo with its own git config); never the user's daemon.
import { execFileSync, spawn } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { electronBinary } from './electron-binary.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliEntry = path.join(desktopRoot, 'dist', 'cli', 'index.js');
const posix = process.platform !== 'win32';

let execPath = electronBinary();
if (!execPath && process.argv.includes('--node')) execPath = process.execPath;
if (!execPath) {
  console.log(
    'smoke-backend: skipped (no Electron binary; `pnpm --filter @octopus-diff/desktop exec install-electron`, or pass --node)',
  );
  process.exit(0);
}
if (!existsSync(cliEntry)) {
  console.log(
    `smoke-backend: skipped (${path.relative(process.cwd(), cliEntry)} missing; run \`pnpm build\`)`,
  );
  process.exit(0);
}

const root = mkdtempSync(path.join(os.tmpdir(), 'octopus-diff-desktop-smoke-'));
const gitConfig = path.join(root, '.gitconfig');
writeFileSync(
  gitConfig,
  '[user]\n\tname = Smoke\n\temail = smoke@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n[commit]\n\tgpgsign = false\n',
);
const baseEnv = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
delete baseEnv.ELECTRON_RUN_AS_NODE;
const leftovers = new Set();
let failures = 0;
const log = (line) => console.log(`smoke-backend: ${line}`);
const check = (ok, what) => {
  if (ok) log(`ok   ${what}`);
  else {
    failures++;
    console.error(`smoke-backend: FAIL ${what}`);
  }
};

// The supervisor and the daemon client, bundled from sources (contracts and zod inlined).
const modulePath = path.join(root, 'supervisor.mjs');
await build({
  stdin: {
    contents: "export * from './src/index.ts';\n",
    resolveDir: desktopRoot,
    loader: 'ts',
  },
  outfile: modulePath,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  conditions: ['@octopus-diff/source'],
  logLevel: 'warning',
});
const { BackendSupervisor, serveArgs, fetchHealth, tokenFromAuthUrl } = await import(modulePath);

const timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  now: () => Date.now(),
};
const policy = {
  backoffMs: [200, 400, 800],
  attachedPollMs: 300,
  attachedMisses: 2,
  readyTimeoutMs: 30_000,
};

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/** pid → ppid of every process (POSIX `ps`). */
function processTable() {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  const table = new Map();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (m) table.set(Number(m[1]), Number(m[2]));
  }
  return table;
}

function descendants(pid) {
  if (!posix) return [];
  const table = processTable();
  const out = [];
  const queue = [pid];
  while (queue.length > 0) {
    const p = queue.shift();
    for (const [child, parent] of table) {
      if (parent === p) {
        out.push(child);
        queue.push(child);
      }
    }
  }
  return out;
}

async function until(condition, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}

function dirs(name) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return { dir, stateDir: path.join(dir, 'state'), configDir: path.join(dir, 'config') };
}

const openFds = [];
/** The daemon's stdout/stderr go to a log file's fd, as in the app (src/log-file.ts). */
function logFd(d) {
  const fd = openSync(path.join(d.dir, 'daemon.log'), 'a');
  openFds.push(fd);
  return fd;
}

function dirArgs(d) {
  return ['--state-dir', d.stateDir, '--config-dir', d.configDir, '--port', '0'];
}

function supervisor(d, { env = baseEnv, repos = [] } = {}) {
  const states = [];
  const notes = [];
  const sup = new BackendSupervisor({
    spawn: (cmd, args, options) => spawn(cmd, args, options),
    command: execPath,
    args: [cliEntry, ...serveArgs([...dirArgs(d), ...(repos.length ? ['--', ...repos] : [])])],
    env,
    appVersion: '0.0.0',
    log: { output: () => undefined, note: (line) => notes.push(line) },
    outputFd: logFd(d),
    timers,
    probe: async (url) => (await fetchHealth(url, null)) !== null,
    onState: (s) => states.push(s),
    policy,
  });
  const ready = (mode, after = 0) =>
    until(
      () =>
        states.slice(after).find((s) => s.kind === 'ready' && (!mode || s.ready.mode === mode))
          ?.ready,
      30_000,
      `a ${mode ?? ''} ready line`,
    );
  return { sup, states, notes, ready };
}

/**
 * `octopus-diff status --json` for these dirs (the same CLI bundle, as Node): `{ running, url,
 * projects }` (its output holds the token in `authUrl`: never printed).
 */
function status(d) {
  try {
    const out = execFileSync(
      execPath,
      [cliEntry, 'status', '--json', '--state-dir', d.stateDir, '--config-dir', d.configDir],
      {
        env: { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const json = JSON.parse(out);
    return { running: true, url: json.url, projects: json.projects };
  } catch {
    return { running: false };
  }
}

/** The pid recorded in daemon.json. */
function recordedPid(d) {
  try {
    return JSON.parse(readFileSync(path.join(d.stateDir, 'daemon.json'), 'utf8')).pid;
  } catch {
    return undefined;
  }
}

/** A plain `octopus-diff serve` (what a user runs in a terminal), not supervised by the app. */
async function externalServe(d) {
  const child = spawn(execPath, [cliEntry, 'serve', '--no-open', ...dirArgs(d)], {
    env: { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  leftovers.add(child.pid);
  const runtime = path.join(d.stateDir, 'daemon.json');
  await until(() => existsSync(runtime) && status(d).running, 20_000, 'the external daemon');
  return child;
}

async function scenario(name, fn) {
  const started = Date.now();
  try {
    await fn();
    log(`---- ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failures++;
    console.error(`smoke-backend: FAIL ${name}: ${error.stack ?? error}`);
  }
}

function makeRepo() {
  const repo = path.join(root, 'repo');
  const git = (...args) => execFileSync('git', args, { cwd: root, env: baseEnv, stdio: 'pipe' });
  git('init', '-q', repo);
  writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('-C', repo, 'add', '.');
  git('-C', repo, 'commit', '-q', '-m', 'init');
  writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
  return repo;
}

log(`binary ${execPath} (${execPath === process.execPath ? 'plain Node' : 'Electron as Node'})`);

await scenario('started: owned, seen by status, stopped by stdin EOF', async () => {
  const d = dirs('started');
  const repo = makeRepo();
  const s = supervisor(d, { repos: [repo] });
  s.sup.start();
  const r = await s.ready('started');
  leftovers.add(r.pid);
  check(r.pid === s.sup.childPid, `ready line pid ${r.pid} is the supervised child`);
  check(
    !s.notes.join('\n').includes(tokenFromAuthUrl(r.authUrl)),
    'the token is not in the supervisor log',
  );
  const st = status(d);
  check(
    st.running && st.url === r.url && recordedPid(d) === r.pid,
    `octopus-diff status sees the app's daemon (${st.url}, ${st.projects} project, daemon.json pid ${recordedPid(d)})`,
  );
  const projects = await fetch(`${r.url}/api/projects`, {
    headers: { authorization: `Bearer ${tokenFromAuthUrl(r.authUrl)}` },
  }).then((res) => res.json());
  check(
    Array.isArray(projects.projects) && projects.projects.length === 1,
    'the daemon serves the registered project',
  );
  const before = descendants(r.pid);
  const t0 = Date.now();
  await s.sup.stop();
  check(!alive(r.pid), `the daemon exited after stdin EOF (${Date.now() - t0} ms)`);
  check(
    !s.notes.some((n) => n.includes('SIGTERM') || n.includes('SIGKILL')),
    'no signal was needed',
  );
  check(
    !existsSync(path.join(d.stateDir, 'daemon.json')),
    'daemon.json removed (graceful shutdown)',
  );
  // The helpers (git helper, watch host) see their parent go and exit right after it.
  const t1 = Date.now();
  await until(() => before.every((p) => !alive(p)), 5_000, 'the helper processes to exit');
  check(
    true,
    `its ${before.length} helper process(es) are gone (${Date.now() - t1} ms after the daemon)`,
  );
  check(!status(d).running, 'status no longer sees a daemon');
});

await scenario('attached: the running daemon is used and left running', async () => {
  const d = dirs('attached');
  const external = await externalServe(d);
  const daemonPid = recordedPid(d);
  const s = supervisor(d);
  s.sup.start();
  const r = await s.ready('attached');
  check(r.pid === daemonPid, `attached to the running daemon (pid ${r.pid})`);
  await until(() => s.sup.childPid === undefined, 5_000, 'the attach run to exit');
  check(!s.sup.ownsDaemon, 'the app does not own it');
  await s.sup.stop();
  check(alive(daemonPid), 'quitting the app leaves the daemon running');
  check((await fetchHealth(r.url, null)) !== null, 'and it still answers');
  external.kill('SIGTERM');
  await until(() => !alive(daemonPid), 10_000, 'the external daemon to stop');
});

await scenario('attached daemon goes away: serve runs again and starts one', async () => {
  const d = dirs('attached-gone');
  const external = await externalServe(d);
  const s = supervisor(d);
  s.sup.start();
  const first = await s.ready('attached');
  const mark = s.states.length;
  external.kill('SIGTERM');
  await until(() => !alive(first.pid), 10_000, 'the external daemon to stop');
  const r = await s.ready('started', mark);
  leftovers.add(r.pid);
  check(
    r.pid !== first.pid && s.sup.ownsDaemon,
    `a new daemon started (pid ${r.pid}) and the app owns it`,
  );
  await s.sup.stop();
  check(!alive(r.pid), 'and quitting stops it');
});

await scenario('restart: a SIGKILLed daemon is started again', async () => {
  const d = dirs('restart');
  const s = supervisor(d);
  s.sup.start();
  const r1 = await s.ready('started');
  leftovers.add(r1.pid);
  const mark = s.states.length;
  process.kill(r1.pid, 'SIGKILL');
  const r2 = await s.ready('started', mark);
  leftovers.add(r2.pid);
  const between = s.states.slice(mark).map((x) => x.kind);
  check(between.includes('restarting'), `states after the kill: ${between.join(' → ')}`);
  check(r2.pid !== r1.pid, `restarted with a new pid (${r1.pid} → ${r2.pid})`);
  check(status(d).running && recordedPid(d) === r2.pid, 'status sees the new daemon');
  await s.sup.stop();
  check(!alive(r2.pid), 'stopped');
});

if (posix) {
  await scenario('no orphan: SIGKILL of the parent stops the daemon (stdin EOF)', async () => {
    const d = dirs('orphan');
    const parentScript = path.join(root, 'parent.mjs');
    writeFileSync(
      parentScript,
      `import { spawn } from 'node:child_process';
import { BackendSupervisor, serveArgs } from ${JSON.stringify(modulePath)};
import { openSync } from 'node:fs';
const [execPath, entry, logFile, ...extra] = process.argv.slice(2);
const sup = new BackendSupervisor({
  spawn: (c, a, o) => spawn(c, a, o), command: execPath, args: [entry, ...serveArgs(extra)],
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, appVersion: '0.0.0',
  log: { output() {}, note() {} }, outputFd: openSync(logFile, 'a'),
  timers: { setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (h) => clearTimeout(h), now: () => Date.now() },
  probe: async () => true,
  onState: (s) => { if (s.kind === 'ready') process.stdout.write(JSON.stringify({ pid: s.ready.pid, mode: s.ready.mode }) + '\\n'); },
});
sup.start();
`,
    );
    const parent = spawn(
      execPath,
      [parentScript, execPath, cliEntry, path.join(d.dir, 'daemon.log'), ...dirArgs(d)],
      {
        env: { ...baseEnv, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'inherit'],
      },
    );
    leftovers.add(parent.pid);
    let out = '';
    parent.stdout.on('data', (c) => {
      out += c;
    });
    const line = await until(
      () => out.split('\n').find((l) => l.startsWith('{')),
      30_000,
      'the parent ready',
    );
    const { pid, mode } = JSON.parse(line);
    leftovers.add(pid);
    check(mode === 'started', `the parent's supervisor started daemon ${pid}`);
    const tree = descendants(pid);
    parent.kill('SIGKILL');
    const t0 = Date.now();
    await until(() => !alive(pid), 15_000, `daemon ${pid} to exit after its parent died`);
    check(true, `the daemon exited ${Date.now() - t0} ms after the parent was SIGKILLed`);
    await until(() => tree.every((p) => !alive(p)), 10_000, 'the helper processes to exit');
    check(true, `its ${tree.length} helper process(es) are gone too`);
    check(
      !existsSync(path.join(d.stateDir, 'daemon.json')),
      'daemon.json removed (it shut down gracefully)',
    );
    const log = readFileSync(path.join(d.dir, 'daemon.log'), 'utf8');
    check(
      log.includes('shutting down'),
      'its shutdown output reached daemon.log after the parent died',
    );
    // The next launch on the same state dir starts normally.
    const s = supervisor(d);
    s.sup.start();
    const r = await s.ready('started');
    leftovers.add(r.pid);
    check(r.pid !== pid, 'the next launch starts a fresh daemon');
    await s.sup.stop();
  });
}

await scenario('git missing: the daemon reports no usable git', async () => {
  const d = dirs('nogit');
  const empty = path.join(root, 'empty-bin');
  const s = supervisor(d, { env: { ...baseEnv, PATH: empty } });
  s.sup.start();
  const r = await s.ready('started');
  leftovers.add(r.pid);
  const health = await fetchHealth(r.url, tokenFromAuthUrl(r.authUrl));
  check(health && health.git.supported === false, `health: git ${JSON.stringify(health?.git)}`);
  await s.sup.stop();
  check(!alive(r.pid), 'stopped');
});

for (const pid of leftovers) {
  if (pid && alive(pid)) {
    console.error(`smoke-backend: FAIL process ${pid} still running; killing it`);
    failures++;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}
for (const fd of openFds) closeSync(fd);
rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.error(`smoke-backend: ${failures} failure(s)`);
  process.exit(1);
}
log('all scenarios passed');
