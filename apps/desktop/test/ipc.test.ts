import { beforeEach, describe, expect, it } from 'vitest';
import {
  BRIDGE_CHANNELS,
  type BridgeDeps,
  createBridgeHandlers,
  type IpcEventLike,
  senderAllowed,
} from '../src/ipc.js';
import type { TargetFs, WorktreeRecord } from '../src/path-guard.js';

const ORIGIN = 'http://127.0.0.1:7428';
const WC = 7;
const ID = '0123456789abcdef';

/** A filesystem double: these paths exist (files unless they end with `/`), `links` map to targets. */
function fakeFs(entries: string[], links: Record<string, string> = {}): TargetFs {
  const dirs = new Set(entries.filter((e) => e.endsWith('/')).map((e) => e.slice(0, -1)));
  const files = new Set(entries.filter((e) => !e.endsWith('/')));
  const exists = (p: string) => dirs.has(p) || files.has(p);
  return {
    realpath: async (p) => {
      const target = links[p] ?? p;
      if (!exists(target)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return target;
    },
    stat: async (p) => {
      if (!exists(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { isDirectory: () => dirs.has(p), isFile: () => files.has(p), mode: 0o644 };
    },
  };
}

function event(url: string | null = `${ORIGIN}/`, options: { id?: number; sub?: boolean } = {}) {
  return {
    sender: { id: options.id ?? WC },
    senderFrame: url === null ? null : { url, parent: options.sub ? {} : null },
  } satisfies IpcEventLike;
}

interface Calls {
  revealed: string[];
  opened: string[];
  external: string[];
  picked: unknown[];
  badges: number[];
  clipboard: string[];
  ready: number[];
  logs: string[];
}

let calls: Calls;
let worktrees: WorktreeRecord[] | null;
let openPathResult: string;
let externalFails: boolean;

function deps(overrides: Partial<BridgeDeps> = {}): BridgeDeps {
  return {
    platform: 'linux',
    trusted: () => ({ webContentsId: WC, origin: ORIGIN }),
    listWorktrees: async () => worktrees,
    fs: fakeFs(['/r/', '/r/a.ts', '/r/src/', '/r/img.png', '/r/x.exe', '/out/', '/out/secret'], {
      '/r/link': '/out/secret',
    }),
    showItemInFolder: (p) => calls.revealed.push(p),
    openPath: async (p) => {
      calls.opened.push(p);
      return openPathResult;
    },
    openExternal: async (url) => {
      if (externalFails) throw new Error('no handler');
      calls.external.push(url);
    },
    pickFolder: async (options) => {
      calls.picked.push(options);
      return '/home/me/code';
    },
    setBadge: (count) => calls.badges.push(count),
    writeClipboard: (text) => calls.clipboard.push(text),
    commandsReady: (id) => calls.ready.push(id),
    log: (line) => calls.logs.push(line),
    ...overrides,
  };
}

beforeEach(() => {
  calls = {
    revealed: [],
    opened: [],
    external: [],
    picked: [],
    badges: [],
    clipboard: [],
    ready: [],
    logs: [],
  };
  worktrees = [{ id: ID, path: '/r', missing: false, bare: false }];
  openPathResult = '';
  externalFails = false;
});

const nothingHappened = () => {
  expect(calls.revealed).toEqual([]);
  expect(calls.opened).toEqual([]);
  expect(calls.external).toEqual([]);
  expect(calls.picked).toEqual([]);
  expect(calls.badges).toEqual([]);
  expect(calls.clipboard).toEqual([]);
  expect(calls.ready).toEqual([]);
};

describe('senderAllowed (event.senderFrame against the UI origin)', () => {
  const trusted = { webContentsId: WC, origin: ORIGIN };

  it("accepts the main frame of our window on the UI's origin", () => {
    expect(senderAllowed(event(), trusted)).toBe(true);
    expect(senderAllowed(event(`${ORIGIN}/?w=abc`), trusted)).toBe(true);
  });

  it('refuses other origins, other windows, subframes, gone frames, and no UI', () => {
    for (const url of [
      'http://127.0.0.1:7429/',
      'http://localhost:7428/',
      'https://127.0.0.1:7428/',
      'http://127.0.0.1:7428.evil.com/',
      'data:text/html,x',
      'file:///etc/passwd',
      'about:blank',
      'not a url',
    ]) {
      expect(senderAllowed(event(url), trusted), url).toBe(false);
    }
    expect(senderAllowed(event(`${ORIGIN}/`, { id: WC + 1 }), trusted)).toBe(false);
    expect(senderAllowed(event(`${ORIGIN}/`, { sub: true }), trusted)).toBe(false);
    expect(senderAllowed(event(null), trusted)).toBe(false);
    expect(senderAllowed(event(), { webContentsId: WC, origin: null })).toBe(false);
    expect(senderAllowed(event(), { webContentsId: null, origin: ORIGIN })).toBe(false);
  });
});

describe('bridge handlers: every channel refuses a bad sender', () => {
  const invokeArgs: Record<string, unknown[]> = {
    [BRIDGE_CHANNELS.pickFolder]: [{}],
    [BRIDGE_CHANNELS.revealPath]: [ID, 'a.ts'],
    [BRIDGE_CHANNELS.openPath]: [ID, 'a.ts'],
    [BRIDGE_CHANNELS.openInEditor]: [ID, 'a.ts', { line: 1 }],
    [BRIDGE_CHANNELS.setBadge]: [3],
    [BRIDGE_CHANNELS.copyText]: ['hello'],
  };

  it('lists a handler for each channel', () => {
    const h = createBridgeHandlers(deps());
    expect(Object.keys(h.invoke).sort()).toEqual(Object.keys(invokeArgs).sort());
    expect(Object.keys(h.on)).toEqual([BRIDGE_CHANNELS.commandsReady]);
  });

  for (const [name, bad] of [
    ['another origin', event('http://evil.example/')],
    ['a subframe', event(`${ORIGIN}/`, { sub: true })],
    ['another window', event(`${ORIGIN}/`, { id: 99 })],
    ['a destroyed frame', event(null)],
  ] as const) {
    it(`from ${name}`, async () => {
      const h = createBridgeHandlers(deps());
      for (const [channel, args] of Object.entries(invokeArgs)) {
        const handler = h.invoke[channel];
        expect(handler, channel).toBeDefined();
        const result = await handler?.(bad, ...args);
        if (channel === BRIDGE_CHANNELS.pickFolder) expect(result, channel).toBeNull();
        else if (channel === BRIDGE_CHANNELS.copyText) expect(result, channel).toBe(false);
        else expect(result, channel).toMatchObject({ ok: false, reason: 'forbidden' });
      }
      h.on[BRIDGE_CHANNELS.commandsReady]?.(bad);
      nothingHappened();
      expect(calls.logs.some((l) => l.includes('forbidden'))).toBe(true);
    });
  }

  it('while a screen (no UI origin) is showing', async () => {
    const h = createBridgeHandlers(deps({ trusted: () => ({ webContentsId: WC, origin: null }) }));
    expect(await h.invoke[BRIDGE_CHANNELS.revealPath]?.(event(), ID)).toMatchObject({
      reason: 'forbidden',
    });
    nothingHappened();
  });
});

describe('bridge handlers: arguments are validated', () => {
  it('refuses bad worktree ids, paths and options', async () => {
    const h = createBridgeHandlers(deps());
    const reveal = h.invoke[BRIDGE_CHANNELS.revealPath];
    const open = h.invoke[BRIDGE_CHANNELS.openPath];
    const editor = h.invoke[BRIDGE_CHANNELS.openInEditor];
    const bad: unknown[][] = [
      [],
      ['NOT-AN-ID'],
      [ID.toUpperCase()],
      [42],
      [ID, '../x'],
      [ID, '/etc/passwd'],
      [ID, ''],
      [ID, 7],
      [ID, 'a.ts', 'extra'],
      [{ id: ID }],
    ];
    for (const args of bad) {
      expect(await reveal?.(event(), ...args), JSON.stringify(args)).toMatchObject({
        ok: false,
        reason: 'invalid',
      });
      expect(await open?.(event(), ...args), JSON.stringify(args)).toMatchObject({
        reason: 'invalid',
      });
    }
    for (const options of [
      { editor: 'vim' },
      { editor: 'javascript' },
      { line: 0 },
      { line: 1.5 },
      { line: -1 },
      { line: '3' },
      { url: 'vscode://x' },
      'vscode',
    ]) {
      expect(await editor?.(event(), ID, 'a.ts', options), JSON.stringify(options)).toMatchObject({
        reason: 'invalid',
      });
    }
    for (const count of [-1, 1.5, '3', Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(await h.invoke[BRIDGE_CHANNELS.setBadge]?.(event(), count)).toMatchObject({
        reason: 'invalid',
      });
    }
    for (const options of [{ title: 1 }, { defaultPath: 'relative/dir' }, { extra: true }, 'x']) {
      expect(await h.invoke[BRIDGE_CHANNELS.pickFolder]?.(event(), options)).toBeNull();
    }
    for (const text of [42, null, { text: 'x' }]) {
      expect(await h.invoke[BRIDGE_CHANNELS.copyText]?.(event(), text)).toBe(false);
    }
    nothingHappened();
  });
});

describe('revealPath / openPath / openInEditor', () => {
  it('reveal: the checked realpath goes to the file manager', async () => {
    const h = createBridgeHandlers(deps());
    expect(await h.invoke[BRIDGE_CHANNELS.revealPath]?.(event(), ID, 'a.ts')).toEqual({ ok: true });
    expect(await h.invoke[BRIDGE_CHANNELS.revealPath]?.(event(), ID)).toEqual({ ok: true });
    expect(calls.revealed).toEqual(['/r/a.ts', '/r']);
  });

  it('open: documents and folders open, executables do not', async () => {
    const h = createBridgeHandlers(deps());
    const open = h.invoke[BRIDGE_CHANNELS.openPath];
    expect(await open?.(event(), ID, 'img.png')).toEqual({ ok: true });
    expect(await open?.(event(), ID, 'src')).toEqual({ ok: true });
    expect(await open?.(event(), ID, 'x.exe')).toMatchObject({ ok: false, reason: 'unsafe-file' });
    expect(calls.opened).toEqual(['/r/img.png', '/r/src']);
  });

  it('open: an OS error is reported as failed', async () => {
    openPathResult = 'No application knows how to open this';
    const h = createBridgeHandlers(deps());
    expect(await h.invoke[BRIDGE_CHANNELS.openPath]?.(event(), ID, 'img.png')).toMatchObject({
      ok: false,
      reason: 'failed',
    });
  });

  it('editor: an allowlisted URL with the line', async () => {
    const h = createBridgeHandlers(deps());
    const editor = h.invoke[BRIDGE_CHANNELS.openInEditor];
    expect(await editor?.(event(), ID, 'a.ts', { line: 4 })).toEqual({ ok: true });
    expect(await editor?.(event(), ID, 'a.ts', { editor: 'zed' })).toEqual({ ok: true });
    expect(await editor?.(event(), ID)).toEqual({ ok: true });
    expect(calls.external).toEqual([
      'vscode://file/r/a.ts:4',
      'zed://file/r/a.ts',
      'vscode://file/r',
    ]);
  });

  it('editor: a missing editor is reported as failed', async () => {
    externalFails = true;
    const h = createBridgeHandlers(deps());
    expect(await h.invoke[BRIDGE_CHANNELS.openInEditor]?.(event(), ID, 'a.ts')).toMatchObject({
      ok: false,
      reason: 'failed',
    });
  });

  it('every action refuses an escape, an unknown worktree, or no daemon', async () => {
    const h = createBridgeHandlers(deps());
    for (const channel of [
      BRIDGE_CHANNELS.revealPath,
      BRIDGE_CHANNELS.openPath,
      BRIDGE_CHANNELS.openInEditor,
    ]) {
      const handler = h.invoke[channel];
      expect(await handler?.(event(), ID, 'link'), channel).toMatchObject({
        reason: 'outside-worktree',
      });
      expect(await handler?.(event(), 'ffffffffffffffff', 'a.ts'), channel).toMatchObject({
        reason: 'unknown-worktree',
      });
      expect(await handler?.(event(), ID, 'gone.ts'), channel).toMatchObject({
        reason: 'not-found',
      });
    }
    worktrees = null;
    expect(await h.invoke[BRIDGE_CHANNELS.revealPath]?.(event(), ID, 'a.ts')).toMatchObject({
      reason: 'not-ready',
    });
    nothingHappened();
  });

  it('an editor URL that fails the allowlist is never opened', async () => {
    // A worktree whose realpath is not absolute cannot produce a valid `<scheme>://file/` URL.
    const h = createBridgeHandlers(
      deps({
        fs: fakeFs(['relative/', 'relative/a.ts']),
        listWorktrees: async () => [{ id: ID, path: 'relative', missing: false, bare: false }],
      }),
    );
    expect(await h.invoke[BRIDGE_CHANNELS.openInEditor]?.(event(), ID, 'a.ts')).toMatchObject({
      ok: false,
    });
    expect(calls.external).toEqual([]);
  });

  it('the allowlist is checked in front of openExternal (a URL with an empty path)', async () => {
    // The filesystem root as a worktree: `vscode://file/` has no path, so it fails the allowlist.
    const h = createBridgeHandlers(
      deps({
        fs: {
          realpath: async (p) => p,
          stat: async () => ({ isDirectory: () => true, isFile: () => false, mode: 0o755 }),
        },
        listWorktrees: async () => [{ id: ID, path: '/', missing: false, bare: false }],
      }),
    );
    expect(await h.invoke[BRIDGE_CHANNELS.openInEditor]?.(event(), ID)).toMatchObject({
      ok: false,
      reason: 'failed',
    });
    expect(calls.external).toEqual([]);
  });

  it('logs the refusal reason, never the path', async () => {
    const h = createBridgeHandlers(deps());
    await h.invoke[BRIDGE_CHANNELS.openPath]?.(event(), ID, 'link');
    expect(calls.logs.join('\n')).toContain('outside-worktree');
    expect(calls.logs.join('\n')).not.toContain('/out');
    expect(calls.logs.join('\n')).not.toContain('link');
  });
});

describe('pickFolder / setBadge / copyText / commands-ready', () => {
  it('pickFolder passes the options and returns the path', async () => {
    const h = createBridgeHandlers(deps());
    expect(
      await h.invoke[BRIDGE_CHANNELS.pickFolder]?.(event(), { title: 'Add', defaultPath: '/r' }),
    ).toBe('/home/me/code');
    expect(await h.invoke[BRIDGE_CHANNELS.pickFolder]?.(event())).toBe('/home/me/code');
    expect(calls.picked).toEqual([{ title: 'Add', defaultPath: '/r' }, {}]);
  });

  it('pickFolder drops a defaultPath that is not an existing directory', async () => {
    const h = createBridgeHandlers(deps());
    for (const defaultPath of ['/nope', '/r/a.ts']) {
      expect(
        await h.invoke[BRIDGE_CHANNELS.pickFolder]?.(event(), { title: 'Add', defaultPath }),
      ).toBe('/home/me/code');
    }
    expect(calls.picked).toEqual([{ title: 'Add' }, { title: 'Add' }]);
  });

  it('pickFolder on Windows: a UNC or device defaultPath is never touched (no SMB connection)', async () => {
    const touched: string[] = [];
    const fs = {
      realpath: async (p: string) => p,
      stat: async (p: string) => {
        touched.push(p);
        return { isDirectory: () => true, isFile: () => false, mode: 0o755 };
      },
    };
    const h = createBridgeHandlers(deps({ platform: 'win32', fs }));
    const pick = h.invoke[BRIDGE_CHANNELS.pickFolder];
    for (const defaultPath of ['//attacker.example/share', '/attacker', '//?/C:/x']) {
      expect(await pick?.(event(), { defaultPath }), defaultPath).toBe('/home/me/code');
    }
    // `\\host\share` and `\\?\C:\x` are not absolute paths at all: the call is invalid.
    for (const defaultPath of ['\\\\attacker.example\\share', '\\\\?\\C:\\x']) {
      expect(await pick?.(event(), { defaultPath }), defaultPath).toBeNull();
    }
    expect(touched).toEqual([]);
    expect(calls.picked).toEqual([{}, {}, {}]);
    expect(await pick?.(event(), { defaultPath: 'C:\\Users\\me' })).toBe('/home/me/code');
    expect(await pick?.(event(), { defaultPath: 'D:/code' })).toBe('/home/me/code');
    expect(touched).toEqual(['C:\\Users\\me', 'D:/code']);
    expect(calls.picked.slice(3)).toEqual([
      { defaultPath: 'C:\\Users\\me' },
      { defaultPath: 'D:/code' },
    ]);
  });

  it('pickFolder on Linux/macOS: a // defaultPath is dropped without a stat', async () => {
    const touched: string[] = [];
    const fs = {
      realpath: async (p: string) => p,
      stat: async (p: string) => {
        touched.push(p);
        return { isDirectory: () => true, isFile: () => false, mode: 0o755 };
      },
    };
    for (const platform of ['linux', 'darwin'] as const) {
      const h = createBridgeHandlers(deps({ platform, fs }));
      expect(
        await h.invoke[BRIDGE_CHANNELS.pickFolder]?.(event(), { defaultPath: '//host/share' }),
      ).toBe('/home/me/code');
    }
    expect(touched).toEqual([]);
    expect(calls.picked).toEqual([{}, {}]);
  });

  it('pickFolder: a title over 200 characters is invalid', async () => {
    const h = createBridgeHandlers(deps());
    const pick = h.invoke[BRIDGE_CHANNELS.pickFolder];
    expect(await pick?.(event(), { title: 'x'.repeat(200) })).toBe('/home/me/code');
    expect(await pick?.(event(), { title: 'x'.repeat(201) })).toBeNull();
    expect(calls.picked).toEqual([{ title: 'x'.repeat(200) }]);
  });

  it('copyText takes at most 32 MiB', async () => {
    const h = createBridgeHandlers(deps());
    const copy = h.invoke[BRIDGE_CHANNELS.copyText];
    const max = 32 * 1024 * 1024;
    expect(await copy?.(event(), 'x'.repeat(max))).toBe(true);
    expect(await copy?.(event(), 'x'.repeat(max + 1))).toBe(false);
    expect(calls.clipboard.length).toBe(1);
  });

  it('openPath: a rejected shell.openPath is a refusal value, logged', async () => {
    const h = createBridgeHandlers(
      deps({
        openPath: async () => {
          throw new Error('spawn failed /r/img.png');
        },
      }),
    );
    expect(await h.invoke[BRIDGE_CHANNELS.openPath]?.(event(), ID, 'img.png')).toMatchObject({
      ok: false,
      reason: 'failed',
    });
    expect(calls.logs).toContain('bridge: openPath refused (failed)');
    expect(calls.logs.join('\n')).not.toContain('/r/img.png');
  });

  it('setBadge takes a non-negative integer', async () => {
    const h = createBridgeHandlers(deps());
    expect(await h.invoke[BRIDGE_CHANNELS.setBadge]?.(event(), 12)).toEqual({ ok: true });
    expect(await h.invoke[BRIDGE_CHANNELS.setBadge]?.(event(), 0)).toEqual({ ok: true });
    expect(calls.badges).toEqual([12, 0]);
  });

  it('copyText writes the clipboard', async () => {
    const h = createBridgeHandlers(deps());
    expect(await h.invoke[BRIDGE_CHANNELS.copyText]?.(event(), 'feature/x')).toBe(true);
    expect(calls.clipboard).toEqual(['feature/x']);
  });

  it('commands-ready records our page', () => {
    const h = createBridgeHandlers(deps());
    h.on[BRIDGE_CHANNELS.commandsReady]?.(event());
    expect(calls.ready).toEqual([WC]);
  });
});
