import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopArgsError, parseDesktopArgs, serveExtraArgs } from '../src/args.js';
import { backendCommand, cliBundleEntry, cliSourceEntry } from '../src/backend-command.js';
import {
  addProject,
  addScanRoot,
  fetchHealth,
  gitStatus,
  tokenFromAuthUrl,
  windowUrl,
} from '../src/daemon-api.js';
import { formatNote, openLogFile, rotateIfLarge } from '../src/log-file.js';
import { refreshScript, settingsScript, undoScript } from '../src/page-actions.js';
import {
  escapeHtml,
  failedScreen,
  gitMissingScreen,
  isScreenPage,
  screenAction,
  screenHtml,
  screenUrl,
  startingScreen,
} from '../src/screens.js';
import { TOKEN } from './fakes.js';

const DEV = { isPackaged: false, platform: 'linux' } as const;

describe('parseDesktopArgs', () => {
  it('defaults', () => {
    expect(parseDesktopArgs(['/app'], '/cwd', DEV)).toEqual({
      dev: false,
      backend: 'bundle',
      rendererUrl: null,
      stateDir: null,
      configDir: null,
      port: null,
      appDataDir: null,
    });
  });

  it('reads its options (both forms), ignores Electron/Chromium switches and other args', () => {
    const args = parseDesktopArgs(
      [
        '.',
        '--no-sandbox',
        '--dev',
        '--backend',
        'source',
        '--renderer-url=http://localhost:5173/some/path',
        '--state-dir',
        'state',
        '--config-dir=/abs/config',
        '--port',
        '0',
        '--app-data-dir',
        '/tmp/x',
        '--enable-logging',
      ],
      '/cwd',
      DEV,
    );
    expect(args).toEqual({
      dev: true,
      backend: 'source',
      rendererUrl: 'http://localhost:5173',
      stateDir: '/cwd/state',
      configDir: '/abs/config',
      port: 0,
      appDataDir: '/tmp/x',
    });
    expect(serveExtraArgs(args)).toEqual([
      '--state-dir',
      '/cwd/state',
      '--config-dir',
      '/abs/config',
      '--port',
      '0',
      '--allowed-host',
      'localhost',
    ]);
  });

  it('rejects bad values', () => {
    for (const argv of [
      ['--backend', 'other'],
      ['--renderer-url', 'file:///x'],
      ['--port', '70000'],
      ['--port', '-1'],
      ['--state-dir'],
      ['--state-dir', '--dev'],
      ['--port='],
    ]) {
      expect(() => parseDesktopArgs(argv, '/', DEV), argv.join(' ')).toThrow(DesktopArgsError);
    }
  });
});

describe('backendCommand', () => {
  it('bundle: the CLI bundle next to main.js', () => {
    const cmd = backendCommand({
      mode: 'bundle',
      execPath: '/E',
      distDir: '/r/apps/desktop/dist',
      extra: [],
    });
    expect(cmd).toEqual({
      command: '/E',
      args: [
        '/r/apps/desktop/dist/cli/index.js',
        'serve',
        '--ready-fd',
        '3',
        '--exit-with-stdin',
        '--no-open',
      ],
      cwd: undefined,
      entry: cliBundleEntry('/r/apps/desktop/dist'),
    });
  });

  it('source: the CLI sources under tsx (as a hook, not its CLI), from the repo root', () => {
    const cmd = backendCommand({
      mode: 'source',
      execPath: '/E',
      distDir: '/r/apps/desktop/dist',
      tsxEsm: 'file:///r/node_modules/tsx/dist/esm/index.mjs',
      extra: ['--port', '0'],
    });
    expect(cmd.args).toEqual([
      '--import',
      'file:///r/node_modules/tsx/dist/esm/index.mjs',
      '--conditions=@octopus-diff/source',
      '/r/apps/cli/src/index.ts',
      'serve',
      '--ready-fd',
      '3',
      '--exit-with-stdin',
      '--no-open',
      '--port',
      '0',
    ]);
    expect(cmd.cwd).toBe('/r');
    expect(cliSourceEntry('/r/apps/desktop/dist')).toBe('/r/apps/cli/src/index.ts');
    expect(() =>
      backendCommand({ mode: 'source', execPath: '/E', distDir: '/d', extra: [] }),
    ).toThrow();
  });
});

describe('daemon-api', () => {
  it('tokenFromAuthUrl', () => {
    expect(tokenFromAuthUrl(`http://127.0.0.1:7428/#token=${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromAuthUrl('http://127.0.0.1:7428/')).toBeNull();
    expect(tokenFromAuthUrl('http://127.0.0.1:7428/#token=')).toBeNull();
    expect(tokenFromAuthUrl('nope')).toBeNull();
  });

  it('windowUrl: the auth URL, or its fragment on the Vite origin', () => {
    const auth = `http://127.0.0.1:7428/#token=${TOKEN}`;
    expect(windowUrl(auth, null)).toBe(auth);
    expect(windowUrl(auth, 'http://localhost:5173')).toBe(`http://localhost:5173/#token=${TOKEN}`);
  });

  const health = (supported: boolean) => ({
    ok: true,
    name: 'octopus-diff',
    version: '0.0.0',
    apiVersion: 1,
    git: { version: supported ? '2.53.0' : null, supported },
    watcher: { mode: 'native', warnings: [] },
    startedAt: '2026-11-13T00:00:00.000Z',
    uptimeMs: 5,
  });

  it('fetchHealth + gitStatus', async () => {
    const seen: { url: string; auth: string | null }[] = [];
    const fetchOk = async (url: string, init?: RequestInit) => {
      seen.push({ url, auth: new Headers(init?.headers).get('authorization') });
      return Response.json(health(true));
    };
    const h = await fetchHealth('http://127.0.0.1:7428', TOKEN, fetchOk);
    expect(gitStatus(h)).toBe('ok');
    expect(seen[0]?.url).toBe('http://127.0.0.1:7428/api/health');
    expect(seen[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(
      gitStatus(await fetchHealth('http://x', null, async () => Response.json(health(false)))),
    ).toBe('missing');
    const down = await fetchHealth('http://x', null, async () => {
      throw new TypeError('fetch failed');
    });
    expect(down).toBeNull();
    expect(gitStatus(down)).toBe('unknown');
  });

  it('addProject maps not_a_repository; addScanRoot uses the default depth', async () => {
    const bodies: unknown[] = [];
    const notRepo = async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(
        { error: { code: 'not_a_repository', message: 'not a git repository' } },
        { status: 422 },
      );
    };
    expect(await addProject('http://x', TOKEN, '/home/u/notes', notRepo)).toEqual({
      kind: 'not-a-repository',
      message: 'not a git repository',
    });
    expect(bodies[0]).toEqual({ path: '/home/u/notes' });
    const failing = async () =>
      Response.json({ error: { code: 'internal', message: 'boom' } }, { status: 500 });
    expect(await addProject('http://x', TOKEN, '/p', failing)).toMatchObject({ kind: 'error' });
    const scanBodies: unknown[] = [];
    const scan = async (_url: string, init?: RequestInit) => {
      scanBodies.push(JSON.parse(String(init?.body)));
      return Response.json(
        {
          scanRoot: {
            id: '0123456789abcdef',
            path: '/home/u/code',
            depth: 3,
            addedAt: '2026-11-13T00:00:00.000Z',
            lastScannedAt: null,
            projectCount: 0,
          },
          created: true,
        },
        { status: 201 },
      );
    };
    const result = await addScanRoot('http://x', TOKEN, '/home/u/code', scan);
    expect(scanBodies[0]).toMatchObject({ path: '/home/u/code' });
    expect(typeof (scanBodies[0] as { depth: unknown }).depth).toBe('number');
    expect(result).toEqual({ kind: 'scan-root', created: true });
  });
});

describe('screens', () => {
  it('escapes every dynamic string and runs no script', () => {
    const html = screenHtml(failedScreen('<img src=x onerror=alert(1)>', 2, '/logs/"daemon".log'));
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('/logs/&quot;daemon&quot;.log');
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'"`);
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('actions are octopus-diff-desktop: links that map back to actions', () => {
    const html = screenHtml(gitMissingScreen('darwin', '2.31'));
    expect(html).toContain('href="octopus-diff-desktop:retry"');
    expect(html).toContain('href="octopus-diff-desktop:show-log"');
    expect(html).toContain('brew install git');
    expect(screenAction('octopus-diff-desktop:retry')).toBe('retry');
    expect(screenAction('octopus-diff-desktop:show-log')).toBe('show-log');
    expect(screenAction('octopus-diff-desktop:quit')).toBeNull();
    expect(screenAction('octopus-diff-desktop:retry/x')).toBeNull();
    expect(screenAction(`${screenUrl(startingScreen('x'))}#retry`)).toBeNull();
    expect(screenAction('http://127.0.0.1:7428/#retry')).toBeNull();
    expect(screenAction('http://octopus-diff-desktop:retry')).toBeNull();
    // Same length as the scheme, then an action name: still not ours.
    expect(screenAction('https://evil.example/retry')).toBeNull();
    expect(screenAction('javascript:alert(1)//show-log')).toBeNull();
  });

  it('git-missing instructions per platform', () => {
    expect(screenHtml(gitMissingScreen('win32', '2.31'))).toContain(
      'winget install --id Git.Git -e',
    );
    expect(screenHtml(gitMissingScreen('linux', '2.31'))).toContain('sudo apt install git');
    expect(screenHtml(gitMissingScreen('freebsd', '2.31'))).toContain('package manager');
  });
});

describe('page actions (scripts run in the web UI)', () => {
  class FakeElement {
    clicked = 0;
    tagName = 'DIV';
    isContentEditable = false;
    type = '';
    events: { key: string; target: string }[] = [];
    click() {
      this.clicked++;
    }
    dispatchEvent(e: { key: string }) {
      this.events.push({ key: e.key, target: 'element' });
      return true;
    }
  }
  class FakeKeyboardEvent {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    constructor(_type: string, init: { key: string; metaKey?: boolean; ctrlKey?: boolean }) {
      this.key = init.key;
      this.metaKey = init.metaKey ?? false;
      this.ctrlKey = init.ctrlKey ?? false;
    }
  }

  function context(found: FakeElement | null, active: FakeElement | null = null) {
    const windowEvents: FakeKeyboardEvent[] = [];
    const commands: string[] = [];
    const selectors: string[] = [];
    const ctx = {
      HTMLElement: FakeElement,
      KeyboardEvent: FakeKeyboardEvent,
      window: { dispatchEvent: (e: FakeKeyboardEvent) => windowEvents.push(e) },
      document: {
        activeElement: active,
        querySelector: (s: string) => {
          selectors.push(s);
          return found;
        },
        execCommand: (c: string) => commands.push(c),
      },
    };
    return { ctx, windowEvents, commands, selectors };
  }

  it('refresh clicks the refresh indicator when there is one (no-op otherwise)', () => {
    const button = new FakeElement();
    const c = context(button);
    expect(runInNewContext(refreshScript(), c.ctx)).toBe(true);
    expect(button.clicked).toBe(1);
    expect(c.selectors).toEqual(['[data-testid="refresh-indicator"]']);
    expect(runInNewContext(refreshScript(), context(null).ctx)).toBe(false);
  });

  it('settings sends the web UI its "," shortcut on window', () => {
    const c = context(null);
    runInNewContext(settingsScript('linux'), c.ctx);
    expect(c.windowEvents.map((e) => [e.key, e.ctrlKey, e.metaKey])).toEqual([[',', false, false]]);
  });

  it('undo: text undo in a field, the web UI Cmd/Ctrl+Z elsewhere', () => {
    const input = new FakeElement();
    input.tagName = 'INPUT';
    input.type = 'text';
    const inField = context(null, input);
    expect(runInNewContext(undoScript('darwin'), inField.ctx)).toBe('text');
    expect(inField.commands).toEqual(['undo']);
    const body = new FakeElement();
    const outside = context(null, body);
    expect(runInNewContext(undoScript('darwin'), outside.ctx)).toBe('app');
    expect(body.events).toEqual([{ key: 'z', target: 'element' }]);
    const checkbox = new FakeElement();
    checkbox.tagName = 'INPUT';
    checkbox.type = 'checkbox';
    expect(runInNewContext(undoScript('linux'), context(null, checkbox).ctx)).toBe('app');
    const none = context(null, null);
    expect(runInNewContext(undoScript('linux'), none.ctx)).toBe('app');
    expect(none.windowEvents.map((e) => [e.key, e.ctrlKey, e.metaKey])).toEqual([
      ['z', true, false],
    ]);
  });
});

describe('log file', () => {
  let dir: string;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('appends output and notes; rotates a big file once', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'octopus-diff-'));
    const file = path.join(dir, 'daemon.log');
    await writeFile(file, 'x'.repeat(100));
    expect(rotateIfLarge(file, 50)).toBe(true);
    expect(await readFile(`${file}.1`, 'utf8')).toHaveLength(100);
    expect(rotateIfLarge(file, 50)).toBe(false);
    const log = openLogFile(dir, () => new Date('2026-11-13T00:00:00.000Z'));
    log.output('daemon says hi\n');
    log.note('ready');
    expect(typeof log.fd).toBe('number');
    log.close();
    log.note('after close is ignored');
    expect(await readFile(file, 'utf8')).toBe(
      'daemon says hi\n[desktop 2026-11-13T00:00:00.000Z] ready\n',
    );
    expect(formatNote('x', new Date(0))).toBe('[desktop 1970-01-01T00:00:00.000Z] x\n');
  });
});

describe('isScreenPage (PR #108 review: a screen button only counts on our own screen)', () => {
  it('is true for a screen data page and false for the UI or anything else', () => {
    expect(isScreenPage(screenUrl(startingScreen('octopus-diff')))).toBe(true);
    for (const url of [
      'http://127.0.0.1:7428/',
      'about:blank',
      'file:///etc/passwd',
      'data:application/json,{}',
      '',
    ]) {
      expect(isScreenPage(url)).toBe(false);
    }
  });
});
