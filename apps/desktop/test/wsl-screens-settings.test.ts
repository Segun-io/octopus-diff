/** #22: the app's own settings file (the WSL distro) and the WSL screens. */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DESKTOP_SETTINGS,
  DESKTOP_SETTINGS_FILE,
  parseDesktopSettings,
  SettingsStore,
  serializeDesktopSettings,
  wslDistroToUse,
} from '../src/desktop-settings.js';
import {
  screenAction,
  screenHtml,
  wslFailedScreen,
  wslStartingScreen,
  wslUnreachableScreen,
} from '../src/screens.js';

describe('desktop-settings.json', () => {
  it('round-trips and defaults to the Windows backend', () => {
    expect(DESKTOP_SETTINGS_FILE).toBe('desktop-settings.json');
    expect(DEFAULT_DESKTOP_SETTINGS).toEqual({ version: 1, wslDistro: null });
    const s = { version: 1 as const, wslDistro: 'My Distro' };
    expect(parseDesktopSettings(serializeDesktopSettings(s))).toEqual(s);
  });

  it('anything missing, malformed, unknown or hostile is the default', () => {
    for (const text of [
      null,
      '',
      'not json',
      '[]',
      '{"version":2,"wslDistro":"Ubuntu"}',
      '{"version":1,"wslDistro":"--exec"}',
      '{"version":1,"wslDistro":"a\\"b"}',
      '{"version":1,"wslDistro":42}',
      '{"version":1,"wslDistro":"Ubuntu","extra":true}',
    ]) {
      expect(parseDesktopSettings(text), String(text)).toEqual(DEFAULT_DESKTOP_SETTINGS);
    }
  });

  it('the distro is used on Windows only (everywhere else WSL is inert)', () => {
    const s = { version: 1 as const, wslDistro: 'Ubuntu' };
    expect(wslDistroToUse(s, 'win32')).toBe('Ubuntu');
    expect(wslDistroToUse(s, 'linux')).toBeNull();
    expect(wslDistroToUse(s, 'darwin')).toBeNull();
    expect(wslDistroToUse(DEFAULT_DESKTOP_SETTINGS, 'win32')).toBeNull();
  });
});

describe('WSL screens', () => {
  it('missing prerequisites: what, the commands to copy, and a way back to the Windows backend', () => {
    const html = screenHtml(
      wslFailedScreen('Ubuntu <b>', {
        ok: false,
        kind: 'prerequisites',
        reason: '"Ubuntu" is missing what the app needs.',
        problems: [
          {
            kind: 'node-missing',
            text: 'Node.js 24 or newer is needed',
            commands: ['nvm install 24'],
          },
          { kind: 'git-missing', text: 'git is needed', commands: ['sudo apt install git'] },
        ],
      }),
    );
    expect(html).toContain('Ubuntu &lt;b&gt;');
    expect(html).toContain('<pre>nvm install 24</pre>');
    expect(html).toContain('<pre>sudo apt install git</pre>');
    expect(html).toContain('nothing is installed for you');
    expect(html).toContain('href="octopus-diff-desktop:retry"');
    expect(html).toContain('href="octopus-diff-desktop:use-windows"');
    expect(html).not.toMatch(/<script/i);
    expect(screenAction('octopus-diff-desktop:use-windows')).toBe('use-windows');
  });

  it('no WSL, no distro, a failed probe: the reason, retry and the way back', () => {
    for (const kind of ['no-wsl', 'no-distro', 'probe-failed'] as const) {
      const html = screenHtml(
        wslFailedScreen('Ubuntu', { ok: false, kind, reason: `reason ${kind}` }),
      );
      expect(html).toContain(`reason ${kind}`);
      expect(html).toContain('octopus-diff-desktop:use-windows');
    }
  });

  it('unreachable from Windows: explains mirrored vs NAT forwarding, without the token', () => {
    const html = screenHtml(wslUnreachableScreen('Ubuntu', 'http://127.0.0.1:7428'));
    expect(html).toContain('http://127.0.0.1:7428');
    expect(html).toContain('localhostForwarding=true');
    expect(html).toContain('networkingMode=mirrored');
    expect(html).toContain('octopus-diff-desktop:use-windows');
    expect(html).not.toContain('token');
  });

  it('starting in WSL names the distro', () => {
    expect(wslStartingScreen('Ubuntu')).toMatchObject({
      title: 'Starting octopus-diff in WSL…',
      busy: true,
    });
    expect(screenHtml(wslStartingScreen('Ubuntu'))).toContain('Ubuntu');
  });
});

describe('SettingsStore: saves one at a time, unique temp files (review LOW 4)', () => {
  function fakeFs() {
    const files = new Map<string, string>();
    const log: string[] = [];
    const gates: (() => void)[] = [];
    let hold = false;
    return {
      files,
      log,
      hold: (v: boolean) => {
        hold = v;
      },
      release: () => {
        for (const g of gates.splice(0)) g();
      },
      fs: {
        writeFile: async (file: string, data: string) => {
          log.push(`write ${file}`);
          if (hold) await new Promise<void>((resolve) => gates.push(resolve));
          files.set(file, data);
        },
        rename: async (from: string, to: string) => {
          log.push(`rename ${from}`);
          const data = files.get(from);
          if (data === undefined) throw new Error(`ENOENT ${from}`);
          files.delete(from);
          files.set(to, data);
        },
      },
    };
  }
  const A = { version: 1 as const, wslDistro: 'Ubuntu' };
  // Neither equals the default (wslDistro: null): a store that never updates `current` fails.
  const B = { version: 1 as const, wslDistro: 'Debian' };

  it('a second save waits for the first: memory and file end on the last choice', async () => {
    const f = fakeFs();
    const store = new SettingsStore('/u/desktop-settings.json', DEFAULT_DESKTOP_SETTINGS, f.fs);
    f.hold(true);
    const first = store.save(A);
    const second = store.save(B);
    await new Promise((r) => setTimeout(r, 0));
    // Only the first write has started.
    expect(f.log.filter((l) => l.startsWith('write'))).toHaveLength(1);
    f.hold(false);
    f.release();
    await Promise.all([first, second]);
    expect(store.current).toEqual(B);
    expect(parseDesktopSettings(f.files.get('/u/desktop-settings.json'))).toEqual(B);
    const tmps = f.log.filter((l) => l.startsWith('write')).map((l) => l.slice(6));
    expect(new Set(tmps).size).toBe(2);
    expect(tmps.every((t) => t.startsWith('/u/desktop-settings.json.') && t.endsWith('.tmp'))).toBe(
      true,
    );
    expect([...f.files.keys()]).toEqual(['/u/desktop-settings.json']);
  });

  it('a failed save leaves memory as it was and does not block the next one', async () => {
    const f = fakeFs();
    let fail = true;
    const store = new SettingsStore('/u/s.json', DEFAULT_DESKTOP_SETTINGS, {
      ...f.fs,
      rename: async (from, to) => {
        if (fail) throw new Error('EACCES');
        return f.fs.rename(from, to);
      },
    });
    await expect(store.save(A)).rejects.toThrow('EACCES');
    expect(store.current).toEqual(DEFAULT_DESKTOP_SETTINGS);
    fail = false;
    await store.save(B);
    expect(store.current).toEqual(B);
  });
});
