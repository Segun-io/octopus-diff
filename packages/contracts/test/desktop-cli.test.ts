/** #21: the CLI-shim bridge contracts (additive, `desktop-cli.ts`). */
import { describe, expect, it } from 'vitest';
import {
  DESKTOP_CLI_CHANNELS,
  DesktopCliInstallResultSchema,
  DesktopCliStatusSchema,
} from '../src/index.js';

describe('desktop CLI shim contracts', () => {
  it('parses each state of the status', () => {
    for (const status of [
      { state: 'unavailable', reason: 'Dev runs cannot install the command.' },
      { state: 'not-installed', path: '/home/a/.local/bin/octopus-diff', onPath: false },
      { state: 'current', path: '/home/a/.local/bin/octopus-diff', onPath: true },
      { state: 'outdated', path: 'C:\\x\\octopus-diff.cmd', onPath: true },
      {
        state: 'conflict',
        path: '/home/a/.local/bin/octopus-diff',
        onPath: true,
        conflict: { kind: 'on-path', path: '/usr/local/bin/octopus-diff' },
      },
    ]) {
      expect(DesktopCliStatusSchema.parse(status)).toEqual(status);
    }
  });

  it('rejects an unknown state, outcome or conflict kind', () => {
    expect(DesktopCliStatusSchema.safeParse({ state: 'installed' }).success).toBe(false);
    expect(
      DesktopCliStatusSchema.safeParse({
        state: 'conflict',
        conflict: { kind: 'elsewhere', path: '/x' },
      }).success,
    ).toBe(false);
    expect(
      DesktopCliInstallResultSchema.safeParse({
        outcome: 'overwritten',
        status: { state: 'current' },
        message: 'x',
      }).success,
    ).toBe(false);
  });

  it('parses an install result', () => {
    const result = {
      outcome: 'installed',
      status: { state: 'current', path: '/p/octopus-diff', onPath: true },
      message: 'Installed.',
    };
    expect(DesktopCliInstallResultSchema.parse(result)).toEqual(result);
  });

  it('keeps the channel names stable (the preload and main must agree)', () => {
    expect(DESKTOP_CLI_CHANNELS).toEqual({
      status: 'octopus-diff:cli-status',
      install: 'octopus-diff:cli-install',
    });
  });
});
