/**
 * The Electron main process (docs/DESKTOP.md §3): single-instance lock, the window and its saved
 * state, the security policy of §5, menus, and the backend supervisor that runs the CLI's `serve`.
 * The policies live in pure modules (`policy.ts`, `menu.ts`, `window-state.ts`, `backend.ts`, …);
 * this file wires them to Electron and is not unit tested (scripts/smoke-backend.mjs and a real
 * launch cover it).
 *
 * Read-only guarantee: nothing here runs git or touches a repository. The daemon does all git
 * work; "Add Folder…" sends the path to the daemon's API like `octopus-diff add`.
 */
import { spawn } from 'node:child_process';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  type MessageBoxOptions,
  screen,
  session,
  shell,
} from 'electron';
import {
  DesktopArgsError,
  parseDesktopArgs,
  REFUSED_PACKAGED_SWITCHES,
  serveExtraArgs,
} from './args.js';
import {
  type BackendState,
  BackendSupervisor,
  type ChildLike,
  isReadyFor,
  type ReadyInfo,
} from './backend.js';
import { backendCommand, cliBundleEntry } from './backend-command.js';
import { createNodeShimFs, createWindowsUserPath } from './cli-shim-fs.js';
import { outcomeTitle, registerCliShimIpc } from './cli-shim-ipc.js';
import { createCliShim } from './cli-shim-service.js';
import {
  addProject,
  addScanRoot,
  fetchHealth,
  gitStatus,
  tokenFromAuthUrl,
  windowUrl,
} from './daemon-api.js';
import { noLogFile, openLogFile } from './log-file.js';
import { buildMenuTemplate } from './menu.js';
import { refreshScript, settingsScript, undoScript } from './page-actions.js';
import {
  httpOrigin,
  isSupersededLoad,
  loadFailureNote,
  MIN_HEIGHT,
  MIN_WIDTH,
  navigationPolicy,
  permissionPolicy,
  windowOpenPolicy,
  windowOptions,
} from './policy.js';
import {
  failedScreen,
  gitMissingScreen,
  isScreenPage,
  restartingScreen,
  type Screen,
  type ScreenAction,
  screenAction,
  screenUrl,
  startingScreen,
  versionNoticeTitle,
} from './screens.js';
import { defaultRunShell, resolveShellPath } from './shell-env.js';
import {
  parseWindowState,
  restoreBounds,
  serializeWindowState,
  WINDOW_STATE_FILE,
  type WindowState,
} from './window-state.js';

declare const __OCTOPUS_CLI_VERSION__: string;

const APP_NAME = 'octopus-diff';
/** git-core's MIN_GIT_VERSION, for the git-missing screen's text. */
const MIN_GIT = '2.31';
const distDir = path.dirname(fileURLToPath(import.meta.url));
const cliVersion = typeof __OCTOPUS_CLI_VERSION__ === 'string' ? __OCTOPUS_CLI_VERSION__ : '0.0.0';

let args: ReturnType<typeof parseDesktopArgs>;
try {
  // An installed build refuses the dev options and the debugger switches (args.ts). Chromium's
  // own parser is asked too, in case it reads a spelling `parseDesktopArgs` does not.
  args = parseDesktopArgs(process.argv.slice(1), process.cwd(), { isPackaged: app.isPackaged });
  const refused = app.isPackaged
    ? REFUSED_PACKAGED_SWITCHES.find((name) => app.commandLine.hasSwitch(name))
    : undefined;
  if (refused) throw new DesktopArgsError(`--${refused} is not available in an installed build`);
} catch (error) {
  process.stderr.write(`${APP_NAME}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

app.setName(APP_NAME);
// Not ~/.config/octopus-diff: that is the CLI's config dir (XDG), Chromium's profile stays apart.
const userData = args.appDataDir ?? path.join(app.getPath('appData'), `${APP_NAME}-desktop`);
app.setPath('userData', userData);
if (args.appDataDir) app.setAppLogsPath(path.join(userData, 'logs'));
else app.setAppLogsPath();

let win: BrowserWindow | null = null;
let backend: BackendSupervisor | null = null;
let ready: ReadyInfo | null = null;
/** The origin the window may navigate within (the daemon's, or the Vite server's); null on screens. */
let uiOrigin: string | null = null;
let showing: { kind: 'none' } | { kind: 'screen'; url: string } | { kind: 'ui'; authUrl: string } =
  { kind: 'none' };
let backendStopped = false;
let quitting = false;
/** Set by any quit request, also one before the backend exists (main() checks it). */
let quitRequested = false;

// Another instance runs for this userData: the lock request told it to focus its window
// (`second-instance`); this one leaves before it opens (or rotates) the shared log.
const primary = app.requestSingleInstanceLock();
if (!primary) app.exit(0);

const log = primary ? openLogFile(app.getPath('logs')) : noLogFile();
if (primary && app.isPackaged && app.commandLine.hasSwitch('no-sandbox')) {
  // The AppImage's AppRun adds this itself when unprivileged user namespaces are unavailable
  // (Ubuntu 23.10+ by default); say so, once, where a bug report will have it (PR #109 review).
  log.note(
    "WARNING: running without Chromium's OS sandbox (--no-sandbox); the renderer is still " +
      'sandboxed from Node. Prefer the .deb on systems that restrict user namespaces.',
  );
}

/**
 * The PATH a terminal has, for the `octopus-diff` command installer (is ~/.local/bin on it, is an
 * npm install on it): the login shell's once it resolves (main() below), the inherited one until then.
 */
let terminalPath: Promise<string> = Promise.resolve(process.env.PATH ?? process.env.Path ?? '');

/** The `octopus-diff` command (docs/DESKTOP.md §3.2, roadmap #21): only the installed app offers it. */
const cliShim = createCliShim({
  platform: process.platform,
  env: process.env,
  homedir: homedir(),
  execPath: process.execPath,
  entry: cliBundleEntry(distDir),
  isPackaged: app.isPackaged && args.backend === 'bundle',
  fs: createNodeShimFs(),
  pathValue: () => terminalPath,
  ...(process.platform === 'win32'
    ? { userPath: createWindowsUserPath({ env: process.env }) }
    : {}),
  log: (text) => log.note(text),
});

if (primary) {
  app.on('second-instance', () => focusWindow());
  void app.whenReady().then(main);
}

function focusWindow(): void {
  // A second launch while the app is quitting must not bring the dying window back.
  if (quitting) return;
  if (!win) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

// --- security policy (DESKTOP §5) ---------------------------------------------------------------

app.on('web-contents-created', (_event, contents) => {
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (navigationPolicy(url, uiOrigin) === 'deny') {
      event.preventDefault();
      log.note(`blocked a navigation to ${httpOrigin(url) ?? 'a non-http URL'}`);
    }
  };
  // `will-frame-navigate` (any frame) comes before `will-navigate` (main frame): both get the same
  // handler, so whichever runs first decides. A screen's buttons are `octopus-diff-desktop:`
  // links: denied like any other URL, then acted on (only on our own screen, main frame).
  const onNavigate = (event: { preventDefault(): void; url: string; isMainFrame?: boolean }) => {
    const action = screenAction(event.url);
    if (
      action &&
      event.isMainFrame !== false &&
      showing.kind === 'screen' &&
      win &&
      contents.id === win.webContents.id &&
      // Our screen is on show, not the page it is replacing (the swap has a gap).
      isScreenPage(contents.getURL())
    ) {
      event.preventDefault();
      void onScreenAction(action);
      return;
    }
    guard(event, event.url);
  };
  contents.on('will-frame-navigate', onNavigate);
  contents.on('will-navigate', onNavigate);
  contents.on('will-redirect', (event) => guard(event, event.url));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    const decision = windowOpenPolicy(url);
    if (decision.openExternally) void shell.openExternal(decision.openExternally);
    return { action: decision.action };
  });
});

function lockDownSession(): void {
  const s = session.defaultSession;
  s.setPermissionRequestHandler((_contents, permission, callback) =>
    callback(permissionPolicy(permission)),
  );
  s.setPermissionCheckHandler((_contents, permission) => permissionPolicy(permission));
  s.setDevicePermissionHandler(() => false);
}

// --- window -------------------------------------------------------------------------------------

const windowStateFile = () => path.join(app.getPath('userData'), WINDOW_STATE_FILE);

function readWindowState(): WindowState | null {
  try {
    return parseWindowState(readFileSync(windowStateFile(), 'utf8'));
  } catch {
    return null;
  }
}

function saveWindowState(): void {
  if (!win || win.isDestroyed()) return;
  const b = win.getNormalBounds();
  const state: WindowState = {
    version: 1,
    bounds: {
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.width),
      height: Math.round(b.height),
    },
    maximized: win.isMaximized(),
    fullScreen: win.isFullScreen(),
  };
  try {
    const file = windowStateFile();
    writeFileSync(`${file}.tmp`, serializeWindowState(state));
    renameSync(`${file}.tmp`, file);
  } catch (error) {
    log.note(`could not save the window state: ${String(error)}`);
  }
}

let notice: { daemon: string; app: string } | null = null;

function createWindow(): BrowserWindow {
  const saved = readWindowState();
  const bounds = restoreBounds(
    saved,
    screen.getAllDisplays().map((d) => d.workArea),
    { width: MIN_WIDTH, height: MIN_HEIGHT },
  );
  const w = new BrowserWindow(windowOptions({ bounds, devTools: args.dev, title: APP_NAME }));
  win = w;
  w.once('ready-to-show', () => {
    if (saved?.maximized && bounds) w.maximize();
    if (saved?.fullScreen && bounds) w.setFullScreen(true);
    w.show();
  });
  let saveTimer: NodeJS.Timeout | null = null;
  const saveSoon = () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWindowState, 500);
  };
  w.on('resize', saveSoon);
  w.on('move', saveSoon);
  w.on('close', () => {
    if (saveTimer) clearTimeout(saveTimer);
    saveWindowState();
  });
  w.on('closed', () => {
    if (win === w) win = null;
    showing = { kind: 'none' };
  });
  w.on('page-title-updated', (event, title) => {
    if (!notice || showing.kind !== 'ui') return;
    event.preventDefault();
    w.setTitle(versionNoticeTitle(title, notice.daemon, notice.app));
  });
  // Show whatever the backend is doing now (a reopened window on macOS, or the first one).
  render(backend?.state ?? { kind: 'idle' });
  return w;
}

function showScreen(s: Screen): void {
  if (!win) return;
  uiOrigin = null;
  const url = screenUrl(s);
  showing = { kind: 'screen', url };
  void win.loadURL(url).catch(() => undefined);
}

async function onScreenAction(action: ScreenAction): Promise<void> {
  log.note(`screen action: ${action}`);
  if (action === 'show-log') {
    await shell.openPath(log.path);
    return;
  }
  retryBackend();
}

function retryBackend(): void {
  if (!backend) return;
  const state = backend.state;
  if (state.kind === 'failed' || state.kind === 'restarting') {
    backend.retry();
    return;
  }
  if (state.kind === 'ready') void showReady(state.ready, true);
}

async function showReady(r: ReadyInfo, force = false): Promise<void> {
  ready = r;
  notice = r.versionMismatch ? { daemon: r.version, app: cliVersion } : null;
  if (!win) return;
  const health = await fetchHealth(r.url, tokenFromAuthUrl(r.authUrl));
  // The daemon may have left `ready` while the health request was out (a restart or failure screen
  // is up then): this answer is for a daemon that is gone, and must not load over that screen.
  if (ready !== r || !win || !isReadyFor(backend?.state, r)) return;
  if (gitStatus(health) === 'missing') {
    log.note('the daemon has no usable git: showing the git-missing screen');
    showScreen(gitMissingScreen(process.platform, MIN_GIT));
    return;
  }
  // The same daemon came back (a restart on the same port and token): the page reconnects itself.
  if (!force && showing.kind === 'ui' && showing.authUrl === r.authUrl) return;
  const target = windowUrl(r.authUrl, args.rendererUrl);
  uiOrigin = httpOrigin(target);
  showing = { kind: 'ui', authUrl: r.authUrl };
  if (notice) win.setTitle(versionNoticeTitle(APP_NAME, notice.daemon, notice.app));
  const w = win;
  await w.loadURL(target).catch((error: unknown) => {
    if (isSupersededLoad(error) || win !== w) return;
    // The page never loaded (the daemon died after its ready line, the dev server is not up yet):
    // nothing would reconnect, so say so and let "Try again" reload. Only the code is logged: the
    // message holds the URL, and the URL the token.
    const note = loadFailureNote(error);
    log.note(`the window could not load the UI: ${note}`);
    showScreen(failedScreen(`The window could not load the UI (${note})`, 1, log.path));
  });
}

function render(state: BackendState): void {
  switch (state.kind) {
    case 'idle':
    case 'starting':
      if (showing.kind !== 'ui') showScreen(startingScreen(APP_NAME));
      return;
    case 'restarting':
      // With the UI up, the web shows "offline" itself and reconnects; no screen in between.
      if (showing.kind !== 'ui') {
        showScreen(restartingScreen(state.reason, state.attempt, state.delayMs));
      }
      return;
    case 'ready':
      void showReady(state.ready);
      return;
    case 'failed':
      showScreen(failedScreen(state.reason, state.failures, log.path));
      return;
    case 'stopping':
    case 'stopped':
      return;
  }
}

// --- menu actions -------------------------------------------------------------------------------

function runInPage(script: string): void {
  if (!win || showing.kind !== 'ui') return;
  win.webContents.executeJavaScript(script, true).catch(() => undefined);
}

async function message(options: MessageBoxOptions): Promise<number> {
  const result = win
    ? await dialog.showMessageBox(win, options)
    : await dialog.showMessageBox(options);
  return result.response;
}

async function addFolder(): Promise<void> {
  if (!win) return;
  const r = ready;
  const token = r ? tokenFromAuthUrl(r.authUrl) : null;
  if (!r || !token || showing.kind !== 'ui') {
    await message({ type: 'info', message: 'The daemon is not ready yet.', buttons: ['OK'] });
    return;
  }
  const picked = await dialog.showOpenDialog(win, {
    title: 'Add a folder',
    buttonLabel: 'Add',
    properties: ['openDirectory', 'createDirectory'],
  });
  const folder = picked.canceled ? undefined : picked.filePaths[0];
  if (!folder) return;
  const result = await addProject(r.url, token, folder);
  if (result.kind === 'project') return; // the UI shows it (SSE)
  if (result.kind === 'not-a-repository') {
    const choice = await message({
      type: 'question',
      message: `${path.basename(folder)} is not a git repository.`,
      detail:
        'Scan it for repositories inside instead? New repositories found there are added too.',
      buttons: ['Scan for Repositories', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
    });
    if (choice !== 0) return;
    const scan = await addScanRoot(r.url, token, folder);
    if (scan.kind === 'error') {
      await message({ type: 'error', message: 'Could not add the folder.', detail: scan.message });
    }
    return;
  }
  await message({ type: 'error', message: 'Could not add the folder.', detail: result.message });
}

async function installCommand(): Promise<void> {
  const result = await cliShim.install();
  const ok =
    result.outcome === 'installed' ||
    result.outcome === 'updated' ||
    result.outcome === 'unchanged';
  await message({
    type: ok ? 'info' : result.outcome === 'failed' ? 'error' : 'warning',
    message: outcomeTitle(result.outcome),
    detail: result.message,
    buttons: ['OK'],
  });
}

function installMenu(): void {
  const template = buildMenuTemplate({
    platform: process.platform,
    appName: APP_NAME,
    dev: args.dev,
    actions: {
      addFolder: () => void addFolder(),
      openSettings: () => runInPage(settingsScript(process.platform)),
      refresh: () => runInPage(refreshScript()),
      undo: () => runInPage(undoScript(process.platform)),
      showLog: () => void shell.openPath(log.path),
      retryBackend,
      installCommand: () => void installCommand(),
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- lifecycle ----------------------------------------------------------------------------------

async function main(): Promise<void> {
  lockDownSession();
  installMenu();
  // The window's own IPC for the command installer (the preload that calls it comes with #20).
  registerCliShimIpc({
    ipcMain,
    shim: cliShim,
    uiOrigin: () => uiOrigin,
    log: (text) => log.note(text),
  });
  createWindow();

  const shellPath = resolveShellPath({
    platform: process.platform,
    env: process.env,
    run: defaultRunShell,
  });
  terminalPath = shellPath.then((r) => r.path);
  const resolved = await shellPath;
  log.note(
    resolved.source === 'login-shell'
      ? `PATH from the login shell (${resolved.shell})`
      : `PATH inherited (${resolved.reason})`,
  );
  // Quit while the shell was answering: start nothing.
  if (quitRequested) return;

  let tsxEsm: string | undefined;
  if (args.backend === 'source') {
    try {
      tsxEsm = import.meta.resolve('tsx/esm');
    } catch {
      tsxEsm = undefined;
    }
  }
  const command = backendCommand({
    mode: args.backend,
    execPath: process.execPath,
    distDir,
    tsxEsm,
    extra: serveExtraArgs(args),
  });

  backend = new BackendSupervisor({
    spawn: (cmd, argv, options) => spawn(cmd, argv, options) as unknown as ChildLike,
    command: command.command,
    args: command.args,
    env: { ...process.env, PATH: resolved.path },
    ...(command.cwd ? { cwd: command.cwd } : {}),
    appVersion: cliVersion,
    log,
    outputFd: log.fd,
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
      now: () => Date.now(),
    },
    probe: async (url) => (await fetchHealth(url, null)) !== null,
    onState: render,
  });
  backend.start();
  // After an update moved the app, point our own launcher (never another file) at it again.
  void cliShim.refresh();
}

app.on('window-all-closed', () => {
  // macOS keeps the app (and its daemon) until Quit; elsewhere closing the window quits.
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (!win && app.isReady()) createWindow();
});

app.on('before-quit', (event) => {
  quitRequested = true;
  if (backendStopped || !backend) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  saveWindowState();
  win?.hide();
  void backend.stop().finally(() => {
    backendStopped = true;
    log.close();
    app.quit();
  });
});

// A terminal's Ctrl+C or `kill` quits like the menu does (the daemon is stopped first).
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => app.quit());
}
