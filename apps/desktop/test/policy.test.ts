import { describe, expect, it } from 'vitest';
import {
  httpOrigin,
  MIN_HEIGHT,
  MIN_WIDTH,
  navigationPolicy,
  permissionPolicy,
  webPreferences,
  windowOpenPolicy,
  windowOptions,
} from '../src/policy.js';

const DAEMON = 'http://127.0.0.1:7428';

describe('navigationPolicy (will-navigate / will-redirect)', () => {
  it('allows pages of the daemon origin only', () => {
    expect(navigationPolicy('http://127.0.0.1:7428/', DAEMON)).toBe('allow');
    expect(navigationPolicy('http://127.0.0.1:7428/?w=abc#token=x', DAEMON)).toBe('allow');
    expect(navigationPolicy('http://127.0.0.1:7428/some/deep/path', DAEMON)).toBe('allow');
  });

  it('denies every other origin, scheme or malformed URL', () => {
    for (const url of [
      'http://127.0.0.1:7429/',
      'http://localhost:7428/',
      'https://127.0.0.1:7428/',
      'http://127.0.0.1/',
      'http://127.0.0.1:7428.evil.com/',
      'http://127.0.0.1:7428@evil.com/',
      'https://github.com/',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'javascript:alert(1)',
      'about:blank',
      'chrome://settings',
      'devtools://devtools/bundled/inspector.html',
      'vscode://file/etc/passwd',
      '',
      'not a url',
    ]) {
      expect(navigationPolicy(url, DAEMON), url).toBe('deny');
    }
  });

  it('denies everything before a UI is loaded (no origin)', () => {
    expect(navigationPolicy('http://127.0.0.1:7428/', null)).toBe('deny');
  });

  it('the Vite dev origin works the same way', () => {
    expect(navigationPolicy('http://localhost:5173/x', 'http://localhost:5173')).toBe('allow');
    expect(navigationPolicy('http://127.0.0.1:7428/', 'http://localhost:5173')).toBe('deny');
  });
});

describe('httpOrigin', () => {
  it('is the origin of http(s) URLs only', () => {
    expect(httpOrigin('http://127.0.0.1:7428/a#b')).toBe('http://127.0.0.1:7428');
    expect(httpOrigin('https://example.com/x')).toBe('https://example.com');
    expect(httpOrigin('file:///x')).toBeNull();
    expect(httpOrigin('ftp://x')).toBeNull();
    expect(httpOrigin('nope')).toBeNull();
  });
});

describe('windowOpenPolicy (setWindowOpenHandler)', () => {
  it('never opens an Electron window; http(s) goes to the browser', () => {
    expect(windowOpenPolicy('https://github.com/o/r/pull/1')).toEqual({
      action: 'deny',
      openExternally: 'https://github.com/o/r/pull/1',
    });
    expect(windowOpenPolicy('http://127.0.0.1:7428/')).toEqual({
      action: 'deny',
      openExternally: 'http://127.0.0.1:7428/',
    });
  });

  it('drops every other scheme (no shell.openExternal for file:, custom protocols, …)', () => {
    for (const url of [
      'file:///Applications/Calculator.app',
      'javascript:alert(1)',
      'data:text/html,x',
      'smb://host/share',
      'ms-msdt:/id',
      'vscode://file/x',
      'mailto:a@b.c',
      '',
    ]) {
      expect(windowOpenPolicy(url), url).toEqual({ action: 'deny', openExternally: null });
    }
  });
});

describe('permissionPolicy', () => {
  it('denies every permission', () => {
    for (const permission of [
      'media',
      'geolocation',
      'notifications',
      'clipboard-read',
      'clipboard-sanitized-write',
      'fullscreen',
      'openExternal',
      'pointerLock',
      'midi',
      'midiSysex',
      'hid',
      'serial',
      'usb',
      'display-capture',
      'idle-detection',
      'window-management',
      'storage-access',
      'fileSystem',
      'unknown',
    ]) {
      expect(permissionPolicy(permission), permission).toBe(false);
    }
  });
});

describe('webPreferences / windowOptions (DESKTOP §5)', () => {
  it('isolates and sandboxes the renderer, no Node, web security on, no webview', () => {
    for (const devTools of [true, false]) {
      const prefs = webPreferences(devTools);
      expect(prefs.contextIsolation).toBe(true);
      expect(prefs.sandbox).toBe(true);
      expect(prefs.nodeIntegration).toBe(false);
      expect(prefs.nodeIntegrationInWorker).toBe(false);
      expect(prefs.nodeIntegrationInSubFrames).toBe(false);
      expect(prefs.webSecurity).toBe(true);
      expect(prefs.allowRunningInsecureContent).toBe(false);
      expect(prefs.webviewTag).toBe(false);
      expect(prefs.experimentalFeatures).toBe(false);
      expect(prefs.navigateOnDragDrop).toBe(false);
      expect(prefs.devTools).toBe(devTools);
      expect(prefs).not.toHaveProperty('preload');
    }
  });

  it('builds the window: hidden until ready, minimum size, saved bounds when given', () => {
    const fresh = windowOptions({ bounds: null, devTools: false, title: 'octopus-diff' });
    expect(fresh).toMatchObject({ show: false, minWidth: MIN_WIDTH, minHeight: MIN_HEIGHT });
    expect(fresh).not.toHaveProperty('x');
    expect(fresh.webPreferences).toEqual(webPreferences(false));
    const restored = windowOptions({
      bounds: { x: 10, y: 20, width: 1000, height: 700 },
      devTools: true,
      title: 't',
    });
    expect(restored).toMatchObject({ x: 10, y: 20, width: 1000, height: 700, title: 't' });
    expect(restored.webPreferences.devTools).toBe(true);
    expect(restored.webPreferences.sandbox).toBe(true);
  });
});
