import { DESKTOP_CLI_CHANNELS } from '@octopus-diff/contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { type BridgeEnv, createDesktopBridge } from '../src/bridge.js';
import { BRIDGE_CHANNELS, COMMAND_CHANNEL } from '../src/ipc-channels.js';

interface Recorded {
  invoked: [string, unknown[]][];
  sent: [string, unknown[]][];
}

let rec: Recorded;
let active: boolean;
let listeners: Map<string, (event: unknown, ...args: unknown[]) => void>;

function env(overrides: Partial<BridgeEnv> = {}): BridgeEnv {
  return {
    platform: 'darwin',
    hasUserActivation: () => active,
    getPathForFile: (file) => (file as unknown as { fakePath: string }).fakePath,
    ipc: {
      invoke: async (channel, ...args) => {
        rec.invoked.push([channel, args]);
        if (channel === BRIDGE_CHANNELS.pickFolder) return '/picked';
        if (channel === BRIDGE_CHANNELS.copyText) return true;
        return { ok: true };
      },
      send: (channel, ...args) => rec.sent.push([channel, args]),
      on: (channel, listener) => listeners.set(channel, listener),
    },
    ...overrides,
  };
}

beforeEach(() => {
  rec = { invoked: [], sent: [] };
  active = true;
  listeners = new Map();
});

describe('createDesktopBridge (the preload API)', () => {
  it('reports the platform and version', () => {
    const b = createDesktopBridge(env());
    expect(b.version).toBe(1);
    expect(b.platform).toBe('darwin');
    expect(createDesktopBridge(env({ platform: 'win32' })).platform).toBe('win32');
    expect(createDesktopBridge(env({ platform: 'freebsd' })).platform).toBe('linux');
  });

  it('forwards each action to its channel', async () => {
    const b = createDesktopBridge(env());
    expect(await b.pickFolder({ title: 'Add' })).toBe('/picked');
    expect(await b.revealPath('0123456789abcdef', 'a.ts')).toEqual({ ok: true });
    expect(await b.openPath('0123456789abcdef')).toEqual({ ok: true });
    expect(await b.openInEditor('0123456789abcdef', 'a.ts', { line: 3 })).toEqual({ ok: true });
    expect(await b.copyText('x')).toBe(true);
    b.setBadge(4);
    expect(rec.invoked.map(([c, a]) => [c, a])).toEqual([
      [BRIDGE_CHANNELS.pickFolder, [{ title: 'Add' }]],
      [BRIDGE_CHANNELS.revealPath, ['0123456789abcdef', 'a.ts']],
      [BRIDGE_CHANNELS.openPath, ['0123456789abcdef', undefined]],
      [BRIDGE_CHANNELS.openInEditor, ['0123456789abcdef', 'a.ts', { line: 3 }]],
      [BRIDGE_CHANNELS.copyText, ['x']],
      [BRIDGE_CHANNELS.setBadge, [4]],
    ]);
  });

  it('refuses gesture-only actions outside a user gesture, without asking the main process', async () => {
    active = false;
    const b = createDesktopBridge(env());
    expect(await b.pickFolder()).toBeNull();
    for (const result of [
      await b.revealPath('0123456789abcdef', 'a.ts'),
      await b.openPath('0123456789abcdef', 'a.ts'),
      await b.openInEditor('0123456789abcdef', 'a.ts'),
    ]) {
      expect(result).toMatchObject({ ok: false, reason: 'no-user-gesture' });
    }
    expect(await b.copyText('x')).toBe(false);
    expect(rec.invoked).toEqual([]);
    // The badge needs no gesture: it follows the data.
    b.setBadge(2);
    expect(rec.invoked).toEqual([[BRIDGE_CHANNELS.setBadge, [2]]]);
  });

  it('a rejected IPC call resolves to a refusal, never a throw', async () => {
    const b = createDesktopBridge(
      env({
        ipc: {
          invoke: async () => {
            throw new Error('Error invoking remote method');
          },
          send: () => undefined,
          on: () => undefined,
        },
      }),
    );
    expect(await b.revealPath('0123456789abcdef')).toMatchObject({ ok: false, reason: 'failed' });
    expect(await b.pickFolder()).toBeNull();
    expect(await b.copyText('x')).toBe(false);
    expect(() => b.setBadge(1)).not.toThrow();
  });

  it('getPathForFile returns the path, or null for an empty one', () => {
    const b = createDesktopBridge(env());
    expect(b.getPathForFile({ fakePath: '/home/me/repo' } as unknown as File)).toBe(
      '/home/me/repo',
    );
    expect(b.getPathForFile({ fakePath: '' } as unknown as File)).toBeNull();
    const throwing = createDesktopBridge(
      env({
        getPathForFile: () => {
          throw new TypeError('not a File');
        },
      }),
    );
    expect(throwing.getPathForFile({} as File)).toBeNull();
  });

  it('onCommand: tells the main process once, delivers known commands only, unsubscribes', () => {
    const b = createDesktopBridge(env());
    const got: string[] = [];
    const off = b.onCommand((c) => got.push(c));
    const second: string[] = [];
    b.onCommand((c) => second.push(c));
    expect(rec.sent).toEqual([[BRIDGE_CHANNELS.commandsReady, []]]);
    const deliver = listeners.get(COMMAND_CHANNEL);
    expect(deliver).toBeDefined();
    deliver?.({}, 'open-settings');
    deliver?.({}, 'rm -rf');
    deliver?.({}, { command: 'refresh' });
    off();
    deliver?.({}, 'refresh');
    expect(got).toEqual(['open-settings']);
    expect(second).toEqual(['open-settings', 'refresh']);
  });

  it('a throwing listener does not stop the others', () => {
    const b = createDesktopBridge(env());
    const got: string[] = [];
    b.onCommand(() => {
      throw new Error('boom');
    });
    b.onCommand((c) => got.push(c));
    listeners.get(COMMAND_CHANNEL)?.({}, 'undo');
    expect(got).toEqual(['undo']);
  });

  describe('the command installer (#21)', () => {
    const status = {
      state: 'not-installed',
      path: '/home/a/.local/bin/octopus-diff',
      onPath: true,
    };
    const installed = { outcome: 'installed', status, message: 'Installed.' };

    it('asks the main process for the status and the install, on their channels', async () => {
      const b = createDesktopBridge(
        env({
          ipc: {
            invoke: async (channel) => {
              rec.invoked.push([channel, []]);
              return channel === DESKTOP_CLI_CHANNELS.status ? status : installed;
            },
            send: () => undefined,
            on: () => undefined,
          },
        }),
      );
      expect(await b.cliStatus()).toEqual(status);
      expect(await b.installCli()).toEqual(installed);
      expect(rec.invoked.map(([c]) => c)).toEqual([
        DESKTOP_CLI_CHANNELS.status,
        DESKTOP_CLI_CHANNELS.install,
      ]);
    });

    it('does not install without a click or key press (and does not even ask)', async () => {
      active = false;
      const b = createDesktopBridge(env());
      const result = await b.installCli();
      expect(result.outcome).toBe('failed');
      expect(rec.invoked).toEqual([]);
    });

    it('answers with a value, never a throw, when the main process fails or sends junk', async () => {
      const bad = (invoke: BridgeEnv['ipc']['invoke']) =>
        createDesktopBridge(env({ ipc: { invoke, send: () => undefined, on: () => undefined } }));
      const rejecting = bad(async () => {
        throw new Error('boom');
      });
      expect((await rejecting.cliStatus()).state).toBe('unavailable');
      expect((await rejecting.installCli()).outcome).toBe('failed');
      const junk = bad(async () => 42);
      expect((await junk.cliStatus()).state).toBe('unavailable');
      expect((await junk.installCli()).outcome).toBe('failed');
    });
  });
});
