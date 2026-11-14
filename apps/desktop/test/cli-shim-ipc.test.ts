/**
 * The bridge's main-process side for `installCli()` / `cliStatus()` (docs/DESKTOP.md §3.4, §5):
 * the sender must be the daemon's origin, no arguments are accepted, results match the contract.
 * (The preload and `window.octopusDesktop` come with #20; this is what they will invoke.)
 */
import {
  DESKTOP_CLI_CHANNELS,
  type DesktopCliInstallResult,
  type DesktopCliStatus,
} from '@octopus-diff/contracts';
import { describe, expect, it, vi } from 'vitest';
import { isTrustedSender, outcomeTitle, registerCliShimIpc } from '../src/cli-shim-ipc.js';
import type { CliShim } from '../src/cli-shim-service.js';

const status: DesktopCliStatus = { state: 'current', path: '/p/octopus-diff', onPath: true };
const installed: DesktopCliInstallResult = { outcome: 'installed', status, message: 'ok' };

function fakeShim(): CliShim & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    status: async () => {
      calls.push('status');
      return status;
    },
    install: async () => {
      calls.push('install');
      return installed;
    },
    refresh: async () => 'skipped',
  };
}

type Handler = (event: { senderFrame?: { url: string } | null }, ...args: unknown[]) => unknown;
function setup(origin: string | null = 'http://127.0.0.1:7428') {
  const handlers = new Map<string, Handler>();
  const notes: string[] = [];
  const shim = fakeShim();
  registerCliShimIpc({
    ipcMain: { handle: (channel, handler) => void handlers.set(channel, handler as Handler) },
    shim,
    uiOrigin: () => origin,
    log: (t) => notes.push(t),
  });
  const call = (channel: string, url: string | null, ...args: unknown[]) =>
    handlers.get(channel)?.({ senderFrame: url === null ? null : { url } }, ...args);
  return { handlers, shim, notes, call };
}

describe('isTrustedSender', () => {
  it('only the daemon origin (any path), never null or another origin', () => {
    expect(isTrustedSender('http://127.0.0.1:7428/#/x', 'http://127.0.0.1:7428')).toBe(true);
    expect(isTrustedSender('http://127.0.0.1:7429/', 'http://127.0.0.1:7428')).toBe(false);
    expect(isTrustedSender('https://example.com/', 'http://127.0.0.1:7428')).toBe(false);
    expect(isTrustedSender('http://127.0.0.1:7428/', null)).toBe(false);
    expect(isTrustedSender(undefined, 'http://127.0.0.1:7428')).toBe(false);
    expect(isTrustedSender('data:text/html,hi', 'http://127.0.0.1:7428')).toBe(false);
  });
});

describe('registerCliShimIpc', () => {
  it('registers exactly the two channels of the contract', () => {
    expect([...setup().handlers.keys()].sort()).toEqual(
      [DESKTOP_CLI_CHANNELS.install, DESKTOP_CLI_CHANNELS.status].sort(),
    );
  });

  it('answers a trusted sender with schema-valid results', async () => {
    const { call, shim } = setup();
    expect(await call(DESKTOP_CLI_CHANNELS.status, 'http://127.0.0.1:7428/')).toEqual(status);
    expect(await call(DESKTOP_CLI_CHANNELS.install, 'http://127.0.0.1:7428/')).toEqual(installed);
    expect(shim.calls).toEqual(['status', 'install']);
  });

  it('rejects another origin, a screen, no frame and no UI origin without running anything', async () => {
    for (const [origin, url] of [
      ['http://127.0.0.1:7428', 'https://evil.example/'],
      ['http://127.0.0.1:7428', 'data:text/html,x'],
      ['http://127.0.0.1:7428', null],
      [null, 'http://127.0.0.1:7428/'],
    ] as const) {
      const { call, shim, notes } = setup(origin);
      for (const channel of Object.values(DESKTOP_CLI_CHANNELS)) {
        await expect(Promise.resolve().then(() => call(channel, url))).rejects.toThrow(/untrusted/);
      }
      expect(shim.calls).toEqual([]);
      expect(notes.length).toBeGreaterThan(0);
    }
  });

  it('accepts no arguments', async () => {
    const { call, shim } = setup();
    for (const channel of Object.values(DESKTOP_CLI_CHANNELS)) {
      await expect(
        Promise.resolve().then(() => call(channel, 'http://127.0.0.1:7428/', '--force')),
      ).rejects.toThrow(/arguments/);
    }
    expect(shim.calls).toEqual([]);
  });

  it('a result that breaks the contract is an error, not sent to the page', async () => {
    const handlers = new Map<string, Handler>();
    registerCliShimIpc({
      ipcMain: { handle: (c, h) => void handlers.set(c, h as Handler) },
      shim: {
        status: async () => ({ state: 'weird' }) as unknown as DesktopCliStatus,
        install: vi.fn(),
        refresh: vi.fn(),
      },
      uiOrigin: () => 'http://127.0.0.1:7428',
      log: () => undefined,
    });
    await expect(
      Promise.resolve().then(() =>
        handlers.get(DESKTOP_CLI_CHANNELS.status)?.({
          senderFrame: { url: 'http://127.0.0.1:7428/' },
        }),
      ),
    ).rejects.toThrow();
  });
});

describe('outcomeTitle', () => {
  it('has a plain title for every outcome', () => {
    for (const outcome of [
      'installed',
      'updated',
      'unchanged',
      'refused',
      'unavailable',
      'failed',
    ] as const) {
      expect(outcomeTitle(outcome)).toMatch(/\S/);
    }
    expect(outcomeTitle('installed')).toMatch(/installed/i);
    expect(outcomeTitle('refused')).toMatch(/not installed|already/i);
  });
});
