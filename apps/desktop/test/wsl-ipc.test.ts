/**
 * #22: `wslStatus()` / `setWslDistro()` in the main process: the bridge's guard, zod, Windows
 * only, a distro must be one `wsl.exe -l -v` lists (and not a tool's own), stored in the app's own
 * settings, and refusals as values.
 */
import {
  DESKTOP_WSL_CHANNELS,
  DesktopWslSetResultSchema,
  DesktopWslStatusSchema,
} from '@octopus-diff/contracts';
import { describe, expect, it } from 'vitest';
import type { DesktopSettings } from '../src/desktop-settings.js';
import type { IpcEventLike, TrustedSender } from '../src/ipc.js';
import { WSL_CHANNELS } from '../src/ipc-channels.js';
import type { WslList } from '../src/wsl-backend.js';
import { createWslHandlers, type WslHandlerDeps } from '../src/wsl-ipc.js';

const ORIGIN = 'http://127.0.0.1:7428';
const WC = 7;

const LIST: WslList = {
  ok: true,
  distros: [
    {
      name: 'Ubuntu',
      state: 'running',
      stateText: 'Running',
      version: 2,
      isDefault: true,
      system: false,
    },
    {
      name: 'My Distro',
      state: 'stopped',
      stateText: 'Stopped',
      version: 2,
      isDefault: false,
      system: false,
    },
    {
      name: 'docker-desktop',
      state: 'stopped',
      stateText: 'Stopped',
      version: 2,
      isDefault: false,
      system: true,
    },
  ],
};

function event(url: string | null = `${ORIGIN}/`, options: { id?: number; sub?: boolean } = {}) {
  return {
    sender: { id: options.id ?? WC },
    senderFrame: url === null ? null : { url, parent: options.sub ? {} : null },
  } satisfies IpcEventLike;
}

function setup(over: Partial<WslHandlerDeps> = {}) {
  const notes: string[] = [];
  let settings: DesktopSettings = { version: 1, wslDistro: null };
  const saved: DesktopSettings[] = [];
  const applied: (string | null)[] = [];
  let lists = 0;
  const deps: WslHandlerDeps = {
    platform: 'win32',
    trusted: (): TrustedSender => ({ webContentsId: WC, origin: ORIGIN }),
    log: (t) => notes.push(t),
    list: async () => {
      lists++;
      return LIST;
    },
    settings: () => settings,
    save: async (next) => {
      saved.push(next);
      settings = next;
    },
    active: () => null,
    apply: (distro) => applied.push(distro),
    ...over,
  };
  const handlers = createWslHandlers(deps);
  const call = (channel: string, e: IpcEventLike, ...args: unknown[]) => {
    const h = handlers[channel];
    if (!h) throw new Error(`no handler for ${channel}`);
    return h(e, ...args);
  };
  return { notes, saved, applied, call, lists: () => lists, settings: () => settings };
}

describe('the WSL channels', () => {
  it('the preload copy equals the contract', () => {
    expect(WSL_CHANNELS).toEqual(DESKTOP_WSL_CHANNELS);
  });
});

describe('wslStatus', () => {
  it('lists the distros with the stored choice, in the contract shape', async () => {
    const t = setup({
      active: () => 'Ubuntu',
      settings: () => ({ version: 1, wslDistro: 'Ubuntu' }),
    });
    const status = await t.call(DESKTOP_WSL_CHANNELS.status, event());
    expect(DesktopWslStatusSchema.parse(status)).toEqual({
      available: true,
      distros: [
        { name: 'Ubuntu', state: 'running', version: 2, isDefault: true, system: false },
        { name: 'My Distro', state: 'stopped', version: 2, isDefault: false, system: false },
        { name: 'docker-desktop', state: 'stopped', version: 2, isDefault: false, system: true },
      ],
      selected: 'Ubuntu',
      active: 'Ubuntu',
    });
  });

  it('off Windows: unavailable, and wsl.exe is never run', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const t = setup({ platform });
      expect(await t.call(DESKTOP_WSL_CHANNELS.status, event())).toMatchObject({
        available: false,
        distros: [],
        reason: expect.stringMatching(/Windows/),
      });
      expect(t.lists()).toBe(0);
    }
  });

  it('WSL missing: unavailable with the reason', async () => {
    const t = setup({ list: async () => ({ ok: false, reason: 'WSL is not installed.' }) });
    expect(await t.call(DESKTOP_WSL_CHANNELS.status, event())).toMatchObject({
      available: false,
      reason: 'WSL is not installed.',
    });
  });

  it('a foreign sender, a subframe, a screen or arguments: refused (unavailable), never listed', async () => {
    const t = setup({ trusted: () => ({ webContentsId: WC, origin: null }) });
    expect(await t.call(DESKTOP_WSL_CHANNELS.status, event())).toMatchObject({ available: false });
    const u = setup();
    expect(await u.call(DESKTOP_WSL_CHANNELS.status, event('https://evil.example/'))).toMatchObject(
      {
        available: false,
      },
    );
    expect(
      await u.call(DESKTOP_WSL_CHANNELS.status, event(undefined, { sub: true })),
    ).toMatchObject({
      available: false,
    });
    expect(await u.call(DESKTOP_WSL_CHANNELS.status, event(undefined, { id: 99 }))).toMatchObject({
      available: false,
    });
    expect(await u.call(DESKTOP_WSL_CHANNELS.status, event(), 'x')).toMatchObject({
      available: false,
    });
    expect(t.lists() + u.lists()).toBe(0);
    expect(u.notes.join('\n')).toContain('bridge: wslStatus refused (forbidden)');
  });
});

describe('setWslDistro', () => {
  it('a listed distro: saved in the app settings, applied, and reported', async () => {
    const t = setup();
    const r = await t.call(DESKTOP_WSL_CHANNELS.set, event(), 'My Distro');
    expect(DesktopWslSetResultSchema.parse(r)).toMatchObject({
      ok: true,
      message: expect.stringMatching(/My Distro/),
      status: { selected: 'My Distro' },
    });
    expect(t.saved).toEqual([{ version: 1, wslDistro: 'My Distro' }]);
    expect(t.applied).toEqual(['My Distro']);
  });

  it('null goes back to the Windows backend', async () => {
    const t = setup({ settings: () => ({ version: 1, wslDistro: 'Ubuntu' }) });
    const r = await t.call(DESKTOP_WSL_CHANNELS.set, event(), null);
    expect(r).toMatchObject({ ok: true });
    expect(t.saved).toEqual([{ version: 1, wslDistro: null }]);
    expect(t.applied).toEqual([null]);
  });

  it('the same choice again changes nothing', async () => {
    const t = setup({ settings: () => ({ version: 1, wslDistro: 'Ubuntu' }) });
    expect(await t.call(DESKTOP_WSL_CHANNELS.set, event(), 'Ubuntu')).toMatchObject({ ok: true });
    expect(t.saved).toEqual([]);
    expect(t.applied).toEqual([]);
  });

  it('not listed, a system distro, hostile or malformed values: refused, nothing saved', async () => {
    for (const value of [
      'Gone',
      'docker-desktop',
      '--exec',
      'a"b',
      'x'.repeat(65),
      42,
      {},
      undefined,
    ]) {
      const t = setup();
      const r = await t.call(DESKTOP_WSL_CHANNELS.set, event(), value);
      expect(r, JSON.stringify(value)).toMatchObject({ ok: false });
      expect(t.saved, JSON.stringify(value)).toEqual([]);
      expect(t.applied, JSON.stringify(value)).toEqual([]);
    }
    const extra = setup();
    expect(await extra.call(DESKTOP_WSL_CHANNELS.set, event(), 'Ubuntu', 'x')).toMatchObject({
      ok: false,
    });
    expect(extra.saved).toEqual([]);
  });

  it('off Windows or from a foreign sender: refused, nothing saved', async () => {
    const linux = setup({ platform: 'linux' });
    expect(await linux.call(DESKTOP_WSL_CHANNELS.set, event(), 'Ubuntu')).toMatchObject({
      ok: false,
    });
    const evil = setup();
    expect(
      await evil.call(DESKTOP_WSL_CHANNELS.set, event('https://evil.example/'), 'Ubuntu'),
    ).toMatchObject({
      ok: false,
    });
    expect([...linux.saved, ...evil.saved]).toEqual([]);
  });

  it('a save that fails: not applied, a failed result', async () => {
    const t = setup({
      save: async () => {
        throw new Error('EACCES');
      },
    });
    expect(await t.call(DESKTOP_WSL_CHANNELS.set, event(), 'Ubuntu')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/could not be saved/),
    });
    expect(t.applied).toEqual([]);
  });
});
