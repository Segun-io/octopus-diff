// Smoke test of the REAL desktop app (dist/main.js in Electron, with a window). Needs the Electron
// binary, `pnpm build`, and a display (macOS, Windows, or Linux with DISPLAY / WAYLAND_DISPLAY; on
// WSL, WSLg's `DISPLAY=:0`). Skips (exit 0) when any is missing.
//
//   node apps/desktop/scripts/smoke-app.mjs [--screenshot <file.png>]
//
// Runs the app with temp `--state-dir` / `--config-dir` / `--app-data-dir` and a free port, plus
// Chromium's `--remote-debugging-port` so the page can be inspected over CDP (plain WebSocket, no
// dependency). Checks: the window shows the web UI from the daemon's origin with the project added
// by `octopus-diff add` (the CLI talks to the app's daemon); no Node in the renderer; navigation
// and window.open locked; permissions denied; the menu's Settings/Refresh scripts work on the
// real web UI; `status` sees the app's daemon; quitting (SIGTERM) stops it; a second launch exits
// (single instance); the window state is saved; SIGKILL of Electron leaves no daemon; with a
// running `serve` the app attaches and quitting leaves that daemon up.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { electronBinary } from './electron-binary.mjs';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliEntry = path.join(desktopRoot, 'dist', 'cli', 'index.js');
const mainEntry = path.join(desktopRoot, 'dist', 'main.js');
const screenshotArg = process.argv.indexOf('--screenshot');
const screenshotFile = screenshotArg === -1 ? null : path.resolve(process.argv[screenshotArg + 1]);

const binary = electronBinary();
const hasDisplay =
  process.platform === 'darwin' ||
  process.platform === 'win32' ||
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
const skip = !binary
  ? 'no Electron binary'
  : !existsSync(mainEntry) || !existsSync(cliEntry)
    ? 'dist/ missing (run `pnpm build`)'
    : !hasDisplay
      ? 'no display (set DISPLAY; on WSL try DISPLAY=:0)'
      : null;
if (skip) {
  console.log(`smoke-app: skipped (${skip})`);
  process.exit(0);
}

const root = mkdtempSync(path.join(os.tmpdir(), 'octopus-diff-desktop-app-'));
const gitConfig = path.join(root, '.gitconfig');
writeFileSync(
  gitConfig,
  '[user]\n\tname = Smoke\n\temail = smoke@example.com\n[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n[commit]\n\tgpgsign = false\n',
);
const env = { ...process.env, GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const nodeEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' };
const pids = new Set();
let failures = 0;
const log = (line) => console.log(`smoke-app: ${line}`);
const check = (ok, what) => {
  if (ok) log(`ok   ${what}`);
  else {
    failures++;
    console.error(`smoke-app: FAIL ${what}`);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(condition, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await sleep(100);
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function dirs(name) {
  const dir = path.join(root, name);
  mkdirSync(dir, { recursive: true });
  return {
    dir,
    stateDir: path.join(dir, 'state'),
    configDir: path.join(dir, 'config'),
    appData: path.join(dir, 'appdata'),
  };
}
const cli = (d, ...args) =>
  execFileSync(
    binary,
    [cliEntry, ...args, '--state-dir', d.stateDir, '--config-dir', d.configDir],
    {
      env: nodeEnv,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
function recordedPid(d) {
  try {
    return JSON.parse(readFileSync(path.join(d.stateDir, 'daemon.json'), 'utf8')).pid;
  } catch {
    return undefined;
  }
}
function daemonLog(d) {
  try {
    return readFileSync(path.join(d.appData, 'logs', 'daemon.log'), 'utf8');
  } catch {
    return '';
  }
}

async function launchApp(d, extra = [], appEnv = env) {
  const debugPort = await freePort();
  const child = spawn(
    binary,
    [
      desktopRoot,
      '--state-dir',
      d.stateDir,
      '--config-dir',
      d.configDir,
      '--app-data-dir',
      d.appData,
      '--port',
      '0',
      `--remote-debugging-port=${debugPort}`,
      ...extra,
    ],
    { env: appEnv, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  pids.add(child.pid);
  let output = '';
  child.stdout.on('data', (c) => {
    output += c;
  });
  child.stderr.on('data', (c) => {
    output += c;
  });
  const exited = new Promise((resolve) =>
    child.on('exit', (code, signal) => resolve({ code, signal })),
  );
  return { child, debugPort, exited, output: () => output };
}

/** A tiny CDP client for the first page whose URL matches. */
async function cdp(debugPort, match) {
  const target = await until(
    async () => {
      try {
        const list = await fetch(`http://127.0.0.1:${debugPort}/json/list`).then((r) => r.json());
        return list.find((t) => t.type === 'page' && match(t.url));
      } catch {
        return undefined;
      }
    },
    30_000,
    'the page over CDP',
  );
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const n = ++id;
      waiting.set(n, resolve);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression, { userGesture = false } = {}) => {
    const res = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture,
    });
    if (res.result?.exceptionDetails) throw new Error(res.result.exceptionDetails.text);
    return res.result?.result?.value;
  };
  return { send, evaluate, close: () => ws.close(), url: target.url };
}

async function scenario(name, fn) {
  const started = Date.now();
  try {
    await fn();
    log(`---- ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failures++;
    console.error(`smoke-app: FAIL ${name}: ${error.stack ?? error}`);
  }
}

function makeRepo(name) {
  const repo = path.join(root, name);
  const git = (...args) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  git('init', '-q', repo);
  writeFileSync(path.join(repo, 'hello.txt'), 'one\n');
  git('-C', repo, 'add', '.');
  git('-C', repo, 'commit', '-q', '-m', 'init');
  writeFileSync(path.join(repo, 'hello.txt'), 'one\ntwo\n');
  return repo;
}

/**
 * The window.octopusDesktop bridge (#20) in the real window. Only refusals and invisible calls:
 * a successful reveal/open/editor/pick/copy would act on this machine's desktop.
 */
async function bridgeChecks(page, d, repo) {
  writeFileSync(path.join(repo, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  execFileSync('ln', ['-s', root, path.join(repo, 'link-out')]);
  const shape = await page.evaluate(
    'JSON.stringify({ t: typeof window.octopusDesktop, v: window.octopusDesktop?.version, p: window.octopusDesktop?.platform, frozen: Object.isFrozen(window.octopusDesktop), m: Object.keys(window.octopusDesktop ?? {}).sort() })',
  );
  const bridge = JSON.parse(shape);
  check(
    bridge.t === 'object' && bridge.v === 1 && bridge.p === process.platform,
    `the bridge is there (version 1, platform ${bridge.p})`,
  );
  check(
    bridge.m.join(',') ===
      'cliStatus,copyText,getPathForFile,installCli,onCommand,openInEditor,openPath,pickFolder,platform,revealPath,setBadge,version',
    `and has exactly the contract's members (${bridge.m.join(', ')})`,
  );
  check(
    (await page.evaluate('typeof require + "/" + typeof process')) === 'undefined/undefined',
    'still no Node.js in the page',
  );
  check(
    (await page.evaluate('document.documentElement.dataset.desktopPlatform')) === process.platform,
    'the web UI set data-desktop-platform on <html>',
  );
  const id = await page.evaluate(
    `fetch('/api/projects', { headers: { authorization: 'Bearer ' + localStorage.getItem('octopus-diff.token') } }).then((r) => r.json()).then((j) => j.projects.flatMap((p) => p.worktrees).find((w) => w.worktree.path.endsWith('smoke-project'))?.worktree.id ?? null)`,
  );
  check(typeof id === 'string', `the project's worktree id (${id})`);
  const call = (expr, userGesture = true) =>
    page.evaluate(`window.octopusDesktop.${expr}.then((r) => JSON.stringify(r))`, { userGesture });
  const reason = async (expr, userGesture = true) =>
    JSON.parse(await call(expr, userGesture))?.reason;
  check(
    (await reason(`revealPath(${JSON.stringify(id)}, 'hello.txt')`, false)) === 'no-user-gesture',
    'without a user gesture the preload refuses (and does not ask the main process)',
  );
  check(
    (await call('copyText("x")', false)) === 'false' &&
      (await call('pickFolder()', false)) === 'null',
    'copyText and pickFolder need a gesture too',
  );
  // Before any call with a gesture: a gesture's activation lasts a few seconds.
  const install = JSON.parse(await call('installCli()', false));
  check(
    install?.outcome === 'failed' && /click or a key press/.test(install?.message ?? ''),
    'installCli without a user gesture is refused in the preload (nothing reaches the shim)',
  );
  check(
    (await reason(`openPath(${JSON.stringify(id)}, 'link-out')`)) === 'outside-worktree',
    'openPath: a symlink out of the worktree is refused (realpath check)',
  );
  check(
    (await reason(`revealPath(${JSON.stringify(id)}, 'link-out/.gitconfig')`)) ===
      'outside-worktree',
    'revealPath: a path through that symlink is refused',
  );
  check(
    (await reason(`openPath(${JSON.stringify(id)}, 'run.sh')`)) === 'unsafe-file',
    'openPath: an executable is refused',
  );
  check(
    (await reason(`openPath(${JSON.stringify(id)}, '../outside')`)) === 'invalid',
    'openPath: ".." is refused by validation',
  );
  check(
    (await reason(`openInEditor(${JSON.stringify(id)}, 'hello.txt', { editor: 'javascript' })`)) ===
      'invalid',
    'openInEditor: an editor outside the allowlist is refused',
  );
  check(
    (await reason(`revealPath('ffffffffffffffff', 'hello.txt')`)) === 'unknown-worktree',
    'an id the daemon does not list is refused',
  );
  check(
    (await reason(`openPath(${JSON.stringify(id)}, 'nope.txt')`)) === 'not-found',
    'a missing file is reported',
  );
  // The command installer's channels run on the bridge's guard (DECISIONS #547): the page gets
  // the shim's own status in the contract's shape (read-only; a development run is `unavailable`).
  const cli = JSON.parse(await call('cliStatus()'));
  check(
    typeof cli?.state === 'string' && cli.reason !== 'Not available from this page.',
    `cliStatus answers the UI through the guard (${cli?.state}: ${cli?.reason ?? ''})`,
  );
  await page.evaluate('window.octopusDesktop.setBadge(3); true');
  await sleep(300);
  const logText = daemonLog(d);
  check(
    logText.includes('bridge: openPath refused (outside-worktree)') &&
      logText.includes('bridge: openPath refused (unsafe-file)'),
    'the refusals are logged with their reason',
  );
  check(
    logText
      .split('\n')
      .filter((l) => l.includes('bridge:'))
      .every((l) => !l.includes(root) && !l.includes('link-out')) && !logText.includes('#token='),
    'and without the paths or the token',
  );
}

// The exact scripts the menu runs (src/page-actions.ts), bundled from sources.
const pageActions = path.join(root, 'page-actions.mjs');
await build({
  entryPoints: [path.join(desktopRoot, 'src', 'page-actions.ts')],
  outfile: pageActions,
  bundle: true,
  platform: 'node',
  format: 'esm',
  conditions: ['@octopus-diff/source'],
  logLevel: 'warning',
});
const { settingsScript, refreshScript } = await import(pageActions);

log(`binary ${binary}`);

await scenario('started: the window shows the projects; quit stops the daemon', async () => {
  const d = dirs('started');
  const repo = makeRepo('smoke-project');
  const app = await launchApp(d);
  await until(() => daemonLog(d).includes('backend ready: started'), 30_000, 'the backend');
  const daemonPid = recordedPid(d);
  pids.add(daemonPid);
  const status = JSON.parse(cli(d, 'status', '--json'));
  check(
    Boolean(status.url),
    `octopus-diff status sees the app's daemon at ${status.url} (pid ${daemonPid})`,
  );
  const added = cli(d, 'add', repo);
  check(added.includes('added'), `octopus-diff add talks to the app's daemon: ${added.trim()}`);
  const origin = new URL(status.url).origin;
  const page = await cdp(app.debugPort, (u) => u.startsWith(origin));
  check(page.url.startsWith(origin), `the window loaded the daemon origin ${origin}`);
  await until(
    () => page.evaluate('document.body.innerText.includes("smoke-project")').catch(() => false),
    20_000,
    'the project in the UI',
  );
  check(true, 'the web UI lists the project');
  check(
    (await page.evaluate('location.hash')) === '',
    'the token fragment was moved out of the URL by the web app',
  );
  check(
    (await page.evaluate('typeof require + "/" + typeof process + "/" + typeof module')) ===
      'undefined/undefined/undefined',
    'no Node.js in the renderer',
  );
  await bridgeChecks(page, d, repo);
  check(
    (await page.evaluate('window.open("file:///etc/passwd") === null')) === true,
    'window.open is denied',
  );
  await page.evaluate('location.href = "http://example.invalid/"; true');
  await sleep(500);
  check(
    (await page.evaluate('location.origin')) === origin,
    'navigation to another origin is blocked',
  );
  check(
    daemonLog(d).includes('blocked a navigation to http://example.invalid'),
    'and logged (origin only)',
  );
  check(
    (await page.evaluate('Notification.requestPermission()')) === 'denied',
    'permission requests are denied (notifications)',
  );
  check(
    (await page.evaluate(
      'navigator.permissions.query({ name: "geolocation" }).then((p) => p.state)',
    )) === 'denied',
    'permission checks are denied (geolocation)',
  );
  // The menu's Settings action, on the real web UI.
  await page.evaluate(settingsScript(process.platform));
  const settingsOpen = await until(
    () => page.evaluate('Boolean(document.querySelector("[role=dialog]"))'),
    5_000,
    'the Settings dialog',
  ).catch(() => false);
  check(settingsOpen, 'Cmd/Ctrl+, (Settings) opens the web Settings dialog');
  await page.evaluate(
    'window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); true',
  );
  await sleep(300);
  const refreshed = await page.evaluate(refreshScript());
  log(
    `info refresh script found the refresh button: ${refreshed} (it exists once a worktree is open)`,
  );
  if (screenshotFile) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(screenshotFile, Buffer.from(shot.result.data, 'base64'));
    log(`info screenshot: ${screenshotFile}`);
    // The macOS title bar strip (#20), forced on this platform to see its layout (no traffic
    // lights here: only the web's 32 px drag strip and the padded UI below it).
    await page.evaluate("document.documentElement.dataset.desktopPlatform = 'darwin'; true");
    await sleep(200);
    const mac = await page.send('Page.captureScreenshot', { format: 'png' });
    const macFile = `${screenshotFile.replace(/\.png$/, '')}-darwin-strip.png`;
    writeFileSync(macFile, Buffer.from(mac.result.data, 'base64'));
    await page.evaluate(
      `document.documentElement.dataset.desktopPlatform = ${JSON.stringify(process.platform)}; true`,
    );
    log(`info screenshot with the macOS strip forced: ${macFile}`);
  }
  page.close();

  // A second launch with the same app data exits and leaves the first one running.
  const logBefore = daemonLog(d);
  const second = await launchApp(d);
  const result = await Promise.race([second.exited, sleep(15_000).then(() => 'timeout')]);
  check(
    result !== 'timeout' && result.code === 0,
    `a second instance exits (${JSON.stringify(result)})`,
  );
  check(alive(app.child.pid), 'the first instance keeps running');
  check(daemonLog(d) === logBefore, "the second instance did not touch the first one's log");

  app.child.kill('SIGTERM');
  const exit = await Promise.race([app.exited, sleep(20_000).then(() => 'timeout')]);
  check(exit !== 'timeout', `SIGTERM quits the app (${JSON.stringify(exit)})`);
  await until(() => !alive(daemonPid), 10_000, 'the daemon to stop');
  check(true, 'quitting stopped the app-started daemon');
  check(!existsSync(path.join(d.stateDir, 'daemon.json')), 'daemon.json removed');
  const state = JSON.parse(readFileSync(path.join(d.appData, 'window-state.json'), 'utf8'));
  check(
    state.version === 1 && state.bounds.width > 0,
    `window state saved (${JSON.stringify(state.bounds)})`,
  );
  check(!daemonLog(d).includes('#token='), 'daemon.log has no token');
});

await scenario('SIGKILL of Electron leaves no daemon', async () => {
  const d = dirs('killed');
  const app = await launchApp(d);
  await until(() => daemonLog(d).includes('backend ready: started'), 30_000, 'the backend');
  const daemonPid = recordedPid(d);
  pids.add(daemonPid);
  app.child.kill('SIGKILL');
  await app.exited;
  const t0 = Date.now();
  await until(() => !alive(daemonPid), 15_000, 'the daemon to exit');
  check(true, `the daemon exited ${Date.now() - t0} ms after Electron was SIGKILLed`);
  check(
    !existsSync(path.join(d.stateDir, 'daemon.json')),
    'and shut down gracefully (daemon.json removed)',
  );
});

await scenario('attached: quitting the app leaves the running serve up', async () => {
  const d = dirs('attached');
  const serve = spawn(
    binary,
    [
      cliEntry,
      'serve',
      '--no-open',
      '--port',
      '0',
      '--state-dir',
      d.stateDir,
      '--config-dir',
      d.configDir,
    ],
    {
      env: nodeEnv,
      stdio: 'ignore',
    },
  );
  pids.add(serve.pid);
  await until(() => recordedPid(d), 20_000, 'serve');
  const app = await launchApp(d);
  await until(() => daemonLog(d).includes('backend ready: attached'), 30_000, 'the attach');
  check(daemonLog(d).includes(`daemon pid ${serve.pid}`), `attached to serve (pid ${serve.pid})`);
  const status = JSON.parse(cli(d, 'status', '--json'));
  const page = await cdp(app.debugPort, (u) => u.startsWith(new URL(status.url).origin));
  check(true, 'the window loaded the attached daemon');
  page.close();
  app.child.kill('SIGTERM');
  await app.exited;
  await sleep(500);
  check(alive(serve.pid), 'serve still runs after the app quit');
  check(Boolean(JSON.parse(cli(d, 'status', '--json')).url), 'and status still sees it');
  serve.kill('SIGTERM');
  await until(() => !alive(serve.pid), 10_000, 'serve to stop');
});

await scenario('git missing: a screen with install instructions, not an empty window', async () => {
  const d = dirs('nogit');
  const emptyBin = path.join(d.dir, 'bin');
  mkdirSync(emptyBin);
  // No git on PATH, and no login shell to find one.
  const app = await launchApp(d, ['--port', '0'], { ...env, PATH: emptyBin, SHELL: '' });
  await until(() => daemonLog(d).includes('git-missing screen'), 30_000, 'the git check');
  const page = await cdp(app.debugPort, (u) => u.startsWith('data:'));
  const text = await until(
    async () => {
      // The page may still be loading (no body yet: the evaluation throws); look again.
      const t = await page.evaluate('document.body.innerText').catch(() => '');
      return t.includes('git is missing') ? t : undefined;
    },
    10_000,
    'the screen text',
  );
  check(text.includes('Try again') && text.includes('install'), 'the git-missing screen is shown');
  check((await page.evaluate('document.scripts.length')) === 0, 'the screen runs no script');
  page.close();
  app.child.kill('SIGTERM');
  await app.exited;
});

await scenario('repeated failures: the error screen with the log path', async () => {
  const d = dirs('failing');
  // Port 1 needs privileges: every `serve` exits with "not allowed to listen".
  const app = await launchApp(d, ['--port', '1']);
  await until(() => daemonLog(d).includes('giving up after'), 40_000, 'the supervisor to give up');
  const page = await cdp(app.debugPort, (u) => u.startsWith('data:'));
  const text = await until(
    async () => {
      const t = await page.evaluate('document.body.innerText').catch(() => '');
      return t.includes('could not start') ? t : undefined;
    },
    10_000,
    'the screen text',
  );
  check(
    text.includes(path.join(d.appData, 'logs', 'daemon.log')),
    'the error screen shows the log path',
  );
  // "Try again" (an octopus-diff-desktop: link): the app starts a new series of attempts.
  const before = (daemonLog(d).match(/started the backend/g) ?? []).length;
  // The failed screen can still be swapping in when its text first matches: retry the click
  // until the link is there (a click on a page being replaced throws; seen once in 5 runs).
  await until(
    () =>
      page
        .evaluate(
          '(() => { const a = document.querySelector(\'a[href="octopus-diff-desktop:retry"]\'); if (!a) return false; a.click(); return true; })()',
        )
        .catch(() => false),
    10_000,
    'the Try again link',
  );
  await until(
    () => (daemonLog(d).match(/started the backend/g) ?? []).length > before,
    10_000,
    'a new attempt after Try again',
  );
  check(true, 'Try again starts the backend again');
  page.close();
  app.child.kill('SIGTERM');
  await app.exited;
});

for (const pid of pids) {
  if (pid && alive(pid)) {
    console.error(`smoke-app: FAIL process ${pid} still running; killing it`);
    failures++;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
}
rmSync(root, { recursive: true, force: true });
if (failures > 0) {
  console.error(`smoke-app: ${failures} failure(s)`);
  process.exit(1);
}
log('all scenarios passed');
