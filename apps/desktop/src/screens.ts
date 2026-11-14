/**
 * The app's own pages: starting, the error screen (with the log path) and "git missing". Static
 * HTML loaded as a `data:` URL: no script (CSP `default-src 'none'`), every dynamic string escaped.
 * Actions are links to `octopus-diff-desktop:<action>`: the navigation guard (`will-navigate`)
 * denies them like any non-daemon URL, and `main.ts` maps them with `screenAction` (only while a
 * screen is shown). Fragment links would be simpler but a `data:` page emits no navigation event
 * for them (Electron 45). The same actions are in the Help menu.
 */

export type ScreenAction = 'retry' | 'show-log';

export const SCREEN_ACTION_SCHEME = 'octopus-diff-desktop:';

export interface Screen {
  title: string;
  /** Paragraphs (plain text, escaped). */
  body: readonly string[];
  /** Shown monospaced (e.g. the log path, a command). */
  code?: readonly string[];
  actions?: readonly { action: ScreenAction; label: string }[];
  /** A spinner instead of actions. */
  busy?: boolean;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
:root { color-scheme: light dark; --fg: #e6e8ee; --muted: #9aa3b2; --bg: #0b0d12; --card: #151922; --accent: #7aa2ff; }
@media (prefers-color-scheme: light) { :root { --fg: #1b1f27; --muted: #5b6474; --bg: #f6f7f9; --card: #fff; --accent: #2f5bd3; } }
html, body { height: 100%; margin: 0; background: var(--bg); color: var(--fg); font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 560px; margin: 0 auto; padding: 18vh 24px 24px; }
h1 { font-size: 20px; font-weight: 600; margin: 0 0 12px; }
p { margin: 0 0 10px; color: var(--muted); }
pre { background: var(--card); padding: 10px 12px; border-radius: 6px; overflow-x: auto; font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap; word-break: break-all; }
nav { margin-top: 18px; display: flex; gap: 10px; }
a { display: inline-block; padding: 6px 14px; border-radius: 6px; background: var(--card); color: var(--accent); text-decoration: none; }
a:first-child { background: var(--accent); color: var(--bg); }
.spin { width: 18px; height: 18px; border: 2px solid var(--muted); border-top-color: transparent; border-radius: 50%; animation: s 0.8s linear infinite; margin-top: 16px; }
@keyframes s { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
`;

export interface ScreenOptions {
  /**
   * macOS `hiddenInset` (#20): a drag strip where the title bar was, so the window can still be
   * moved while a screen shows (the web UI draws its own).
   */
  titleBarInset?: boolean;
}

const TITLE_BAR_STYLE =
  '.drag { position: fixed; top: 0; left: 0; right: 0; height: 32px; -webkit-app-region: drag; }';

export function screenHtml(screen: Screen, options: ScreenOptions = {}): string {
  const style = options.titleBarInset ? `${STYLE}${TITLE_BAR_STYLE}` : STYLE;
  const parts = [
    '<!doctype html><html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    `<title>${escapeHtml(screen.title)}</title><style>${style}</style></head><body>`,
    options.titleBarInset ? '<div class="drag"></div>' : '',
    '<main>',
    `<h1>${escapeHtml(screen.title)}</h1>`,
    ...screen.body.map((p) => `<p>${escapeHtml(p)}</p>`),
    ...(screen.code ?? []).map((c) => `<pre>${escapeHtml(c)}</pre>`),
  ];
  if (screen.busy) parts.push('<div class="spin" role="progressbar" aria-label="Working"></div>');
  if (screen.actions && screen.actions.length > 0) {
    parts.push(
      `<nav>${screen.actions.map((a) => `<a href="${SCREEN_ACTION_SCHEME}${a.action}">${escapeHtml(a.label)}</a>`).join('')}</nav>`,
    );
  }
  parts.push('</main></body></html>');
  return parts.join('');
}

export function screenUrl(screen: Screen, options: ScreenOptions = {}): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(screenHtml(screen, options))}`;
}

/** Whether the page showing is one of our screens (a `data:` page), not the web UI or anything else. */
export function isScreenPage(url: string): boolean {
  return url.startsWith('data:text/html');
}

/** The action a screen link navigates to (`octopus-diff-desktop:retry`), or null. */
export function screenAction(url: string): ScreenAction | null {
  if (!url.startsWith(SCREEN_ACTION_SCHEME)) return null;
  const action = url.slice(SCREEN_ACTION_SCHEME.length);
  return action === 'retry' || action === 'show-log' ? action : null;
}

export function startingScreen(appName: string): Screen {
  return { title: `Starting ${appName}…`, body: ['Starting the daemon.'], busy: true };
}

export function restartingScreen(reason: string, attempt: number, delayMs: number): Screen {
  return {
    title: 'Restarting the daemon…',
    body: [reason, `Attempt ${attempt} in ${Math.max(1, Math.round(delayMs / 1000))} s.`],
    busy: true,
  };
}

export function failedScreen(reason: string, failures: number, logPath: string): Screen {
  return {
    title: 'The daemon could not start',
    body: [
      `${reason} (${failures} attempt${failures === 1 ? '' : 's'}).`,
      'The daemon log has the details:',
    ],
    code: [logPath],
    actions: [
      { action: 'retry', label: 'Try again' },
      { action: 'show-log', label: 'Show the log' },
    ],
  };
}

/** Install instructions per platform (docs/DESKTOP.md §6: a screen, not an empty window). */
export function gitMissingScreen(platform: NodeJS.Platform, minVersion: string): Screen {
  const how: Record<string, { body: string; code: string[] }> = {
    darwin: {
      body: 'Install the Xcode command line tools, or git from Homebrew:',
      code: ['xcode-select --install', 'brew install git'],
    },
    win32: {
      body: 'Install Git for Windows (https://git-scm.com/download/win), for example with winget:',
      code: ['winget install --id Git.Git -e'],
    },
    linux: {
      body: "Install git with your distribution's package manager, for example:",
      code: ['sudo apt install git', 'sudo dnf install git'],
    },
  };
  const entry = how[platform] ?? how.linux ?? { body: '', code: [] };
  return {
    title: 'git is missing',
    body: [
      `octopus-diff reads your repositories with git ${minVersion} or newer, and the daemon could not find a usable git on its PATH.`,
      entry.body,
    ],
    code: entry.code,
    actions: [
      { action: 'retry', label: 'Try again' },
      { action: 'show-log', label: 'Show the log' },
    ],
  };
}

export function versionNoticeTitle(
  pageTitle: string,
  daemonVersion: string,
  appVersion: string,
): string {
  return `${pageTitle} — daemon ${daemonVersion} (app ${appVersion})`;
}
