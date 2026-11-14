/**
 * The bridge's main-process side for `installCli()` / `cliStatus()` (docs/DESKTOP.md §3.4, §5):
 * the same guard as every bridge channel (our window, its main frame, the UI origin while the UI
 * shows; no arguments), results that match the contract, refusals as values (DECISIONS #547).
 */
import {
  DESKTOP_CLI_CHANNELS,
  type DesktopCliInstallResult,
  DesktopCliInstallResultSchema,
  type DesktopCliStatus,
  DesktopCliStatusSchema,
} from '@octopus-diff/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createCliShimHandlers, outcomeTitle } from '../src/cli-shim-ipc.js';
import type { CliShim } from '../src/cli-shim-service.js';
import type { IpcEventLike, TrustedSender } from '../src/ipc.js';

const ORIGIN = 'http://127.0.0.1:7428';
const WC = 7;
const status: DesktopCliStatus = { state: 'current', path: '/p/octopus-diff', onPath: true };
const installed: DesktopCliInstallResult = { outcome: 'installed', status, message: 'ok' };

function fakeShim(overrides: Partial<CliShim> = {}): CliShim & { calls: string[] } {
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
    ...overrides,
  };
}

function event(url: string | null = `${ORIGIN}/`, options: { id?: number; sub?: boolean } = {}) {
  return {
    sender: { id: options.id ?? WC },
    senderFrame: url === null ? null : { url, parent: options.sub ? {} : null },
  } satisfies IpcEventLike;
}

function setup(trusted: TrustedSender = { webContentsId: WC, origin: ORIGIN }, shim = fakeShim()) {
  const notes: string[] = [];
  const handlers = createCliShimHandlers({
    shim,
    trusted: () => trusted,
    log: (t) => notes.push(t),
  });
  const call = (channel: string, e: IpcEventLike, ...args: unknown[]) => {
    const h = handlers[channel];
    if (!h) throw new Error(`no handler for ${channel}`);
    return h(e, ...args);
  };
  return { handlers, shim, notes, call };
}

/** A status or install result that says "refused", in the contract's shape. */
function expectRefusal(channel: string, value: unknown) {
  if (channel === DESKTOP_CLI_CHANNELS.status) {
    expect(DesktopCliStatusSchema.parse(value).state).toBe('unavailable');
  } else {
    const r = DesktopCliInstallResultSchema.parse(value);
    expect(r.outcome).toBe('failed');
    expect(r.status.state).toBe('unavailable');
  }
}

describe('createCliShimHandlers (the bridge guard, #547)', () => {
  it('has exactly the two channels of the contract', () => {
    expect(Object.keys(setup().handlers).sort()).toEqual(
      [DESKTOP_CLI_CHANNELS.install, DESKTOP_CLI_CHANNELS.status].sort(),
    );
  });

  it("answers our window's main frame on the UI origin with schema-valid results", async () => {
    const { call, shim } = setup();
    expect(await call(DESKTOP_CLI_CHANNELS.status, event())).toEqual(status);
    expect(await call(DESKTOP_CLI_CHANNELS.install, event())).toEqual(installed);
    expect(shim.calls).toEqual(['status', 'install']);
  });

  for (const [name, e, trusted] of [
    ['another origin', event('https://evil.example/'), undefined],
    ['a data: page', event('data:text/html,x'), undefined],
    ['a destroyed frame', event(null), undefined],
    ['a subframe on the UI origin', event(`${ORIGIN}/`, { sub: true }), undefined],
    ['another window on the UI origin', event(`${ORIGIN}/`, { id: 99 }), undefined],
    ['a screen (no UI origin)', event(), { webContentsId: WC, origin: null }],
    ['no window', event(), { webContentsId: null, origin: ORIGIN }],
  ] as const) {
    it(`refuses ${name} with a value, never a throw, and runs nothing`, async () => {
      const { call, shim, notes } = setup(trusted ?? undefined);
      for (const channel of Object.values(DESKTOP_CLI_CHANNELS)) {
        expectRefusal(channel, await call(channel, e));
      }
      expect(shim.calls).toEqual([]);
      expect(notes.filter((n) => n.includes('refused (forbidden)')).length).toBe(2);
    });
  }

  it('refuses arguments (both channels take none)', async () => {
    const { call, shim, notes } = setup();
    for (const channel of Object.values(DESKTOP_CLI_CHANNELS)) {
      expectRefusal(channel, await call(channel, event(), '--force'));
    }
    expect(shim.calls).toEqual([]);
    expect(notes.filter((n) => n.includes('refused (invalid)')).length).toBe(2);
  });

  it('a result that breaks the contract, or a shim that throws, becomes a refusal value', async () => {
    const broken = setup(
      undefined,
      fakeShim({
        status: async () => ({ state: 'weird' }) as unknown as DesktopCliStatus,
        install: async () =>
          ({ outcome: 'overwritten', status, message: 'x' }) as unknown as DesktopCliInstallResult,
      }),
    );
    for (const channel of Object.values(DESKTOP_CLI_CHANNELS)) {
      expectRefusal(channel, await broken.call(channel, event()));
    }
    const throwing = setup(
      undefined,
      fakeShim({
        status: vi.fn(async () => {
          throw new Error('EACCES /home/me/.local/bin');
        }),
        install: vi.fn(async () => {
          throw new Error('EACCES /home/me/.local/bin');
        }),
      }),
    );
    for (const channel of Object.values(DESKTOP_CLI_CHANNELS)) {
      expectRefusal(channel, await throwing.call(channel, event()));
    }
    expect(throwing.notes.join('\n')).not.toContain('/home/me');
    expect(throwing.notes.filter((n) => n.includes('refused (failed)')).length).toBe(2);
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
