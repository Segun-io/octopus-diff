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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  app,
  BrowserWindow,
  dialog,
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
  type TimersLike,
} from './backend.js';
import { backendCommand } from './backend-command.js';
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
  loadFailureNote,
  MIN_HEIGHT,
  MIN_WIDTH,
  navigationPolicy,
  netErrorName,
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
import { LoadSequence, UiLoad, uiWanted, urlForLog } from './ui-load.js';
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
let showing:
  | { kind: 'none' }
  | { kind: 'screen'; url: string; title: string }
  | { kind: 'ui'; authUrl: string } = { kind: 'none' };
/** Every load of the window (screens and the UI) takes a ticket: the newest is the wanted one. */
const loads = new LoadSequence();
/** The UI load in progress (attempts, the commit watchdog), if any. */
let uiLoad: UiLoad | null = null;
const timers: TimersLike = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
  now: () => Date.now(),
};
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
if (primary) {
  // Not logged: the smoke test checks that a second launch leaves the shared log as it was.
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
  log.note('window: created');
  w.once('ready-to-show', () => {
    log.note('window: ready to show');
    if (saved?.maximized && bounds) w.maximize();
    if (saved?.fullScreen && bounds) w.setFullScreen(true);
    w.show();
  });
  // The first show only: a second launch focuses (shows) the window, and must not touch the log.
  w.once('show', () => log.note('window: shown'));
  watchPage(w);
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
    log.note('window: closed');
    if (win === w) win = null;
    showing = { kind: 'none' };
    uiLoad?.cancel();
    uiLoad = null;
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

/**
 * The window's page lifecycle in the log (DECISIONS #592): what a stuck window was doing. Origins and
 * error names only: never a URL (the UI's fragment holds the token).
 */
function watchPage(w: BrowserWindow): void {
  const contents = w.webContents;
  contents.on('did-navigate', (_event, url, httpResponseCode) => {
    const code = httpResponseCode > 0 ? ` (HTTP ${httpResponseCode})` : '';
    log.note(`window: navigated to ${urlForLog(url)}${code}`);
    if (win === w && uiOrigin !== null && httpOrigin(url) === uiOrigin) uiLoad?.committed();
  });
  contents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    const name = netErrorName(errorDescription);
    log.note(
      `window: loading ${urlForLog(validatedURL)} failed (${errorCode}${name ? ` ${name}` : ''})`,
    );
  });
  contents.on('did-finish-load', () => log.note(`window: ${pageForLog(w)} finished loading`));
  contents.on('render-process-gone', (_event, details) =>
    log.note(`window: the page's process is gone (${details.reason}, exit ${details.exitCode})`),
  );
  contents.on('unresponsive', () => log.note('window: the page is not responding'));
  contents.on('responsive', () => log.note('window: the page responds again'));
}

/** The page on show, for the log: the screen's title, else `urlForLog`. */
function pageForLog(w: BrowserWindow): string {
  if (w.isDestroyed()) return 'a closed window';
  const url = w.webContents.getURL();
  if (showing.kind === 'screen' && url === showing.url) return `the screen "${showing.title}"`;
  return urlForLog(url);
}

function showScreen(s: Screen): void {
  if (!win) return;
  uiLoad?.cancel();
  uiLoad = null;
  uiOrigin = null;
  const url = screenUrl(s);
  showing = { kind: 'screen', url, title: s.title };
  const ticket = loads.begin();
  log.note(`window: showing the screen "${s.title}"`);
  void win.loadURL(url).catch((error: unknown) => {
    if (loads.isCurrent(ticket)) {
      log.note(`window: the screen "${s.title}" did not load (${loadFailureNote(error)})`);
    }
  });
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
  if (!win) {
    log.note('window: the daemon is ready, no window open');
    return;
  }
  const asked = Date.now();
  const health = await fetchHealth(r.url, tokenFromAuthUrl(r.authUrl));
  const git = gitStatus(health);
  log.note(
    `window: daemon health ${health ? 'answered' : 'unavailable'} in ${Date.now() - asked} ms (git ${git})`,
  );
  // The daemon may have left `ready` while the health request was out (a restart or failure screen
  // is up then): this answer is for a daemon that is gone, and must not load over that screen.
  if (ready !== r || !win || !isReadyFor(backend?.state, r)) {
    log.note('window: the daemon left ready during the health check; the UI is not loaded');
    return;
  }
  if (git === 'missing') {
    log.note('the daemon has no usable git: showing the git-missing screen');
    showScreen(gitMissingScreen(process.platform, MIN_GIT));
    return;
  }
  // The same daemon came back (a restart on the same port and token): the page reconnects itself.
  if (!force && showing.kind === 'ui' && showing.authUrl === r.authUrl) {
    log.note('window: the same daemon is back; the page reconnects itself');
    return;
  }
  const target = windowUrl(r.authUrl, args.rendererUrl);
  uiOrigin = httpOrigin(target);
  showing = { kind: 'ui', authUrl: r.authUrl };
  if (notice) win.setTitle(versionNoticeTitle(APP_NAME, notice.daemon, notice.app));
  const w = win;
  uiLoad?.cancel();
  // Attempts, a commit watchdog and "superseded" by load sequence, not by error code (ui-load.ts).
  // The page never loading (the daemon died after its ready line, the dev server is not up yet)
  // ends on the failure screen, whose "Try again" reloads. Only error codes are logged: the
  // message holds the URL, and the URL the token.
  const load: UiLoad = new UiLoad(target, {
    load: (url) => w.loadURL(url),
    loads,
    timers,
    note: (line) => log.note(line),
    wanted: () => uiWanted({ quitting, current: win, window: w, destroyed: w.isDestroyed() }),
    describe: () =>
      w.isDestroyed()
        ? 'the window is closed'
        : `window ${w.isVisible() ? 'visible' : 'not visible'}, ` +
          `${w.webContents.isLoading() ? 'loading' : 'not loading'}, on ${pageForLog(w)}`,
    giveUp: (note, attempts) => {
      if (uiLoad === load) uiLoad = null;
      log.note(`the window could not load the UI: ${note}`);
      showScreen(failedScreen(`The window could not load the UI (${note})`, attempts, log.path));
    },
  });
  uiLoad = load;
  log.note(`window: loading the UI from ${urlForLog(target)}`);
  load.start();
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
    },
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- lifecycle ----------------------------------------------------------------------------------

async function main(): Promise<void> {
  lockDownSession();
  installMenu();
  createWindow();

  const resolved = await resolveShellPath({
    platform: process.platform,
    env: process.env,
    run: defaultRunShell,
  });
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
    timers,
    probe: async (url) => (await fetchHealth(url, null)) !== null,
    onState: render,
  });
  backend.start();
}

app.on('window-all-closed', () => {
  // macOS keeps the app (and its daemon) until Quit; elsewhere closing the window quits.
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  log.note(`app: activate (window ${win ? 'open' : 'closed'})`);
  if (!win && app.isReady()) createWindow();
});

app.on('before-quit', (event) => {
  quitRequested = true;
  if (backendStopped || !backend) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  // No more UI load attempts: the daemon is being stopped and the window hidden (PR #112 review).
  uiLoad?.cancel();
  uiLoad = null;
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
