/** #22: the WSL backend contracts (additive: `desktop-wsl.ts`, the stdout ready frame in `daemon.ts`). */
import { describe, expect, it } from 'vitest';
import {
  DESKTOP_WSL_CHANNELS,
  DesktopWslSetResultSchema,
  DesktopWslStatusSchema,
  formatServeReadyFrame,
  SERVE_READY_FRAME_PREFIX,
  ServeReadyNonceSchema,
} from '../src/index.js';

const ready = {
  mode: 'started' as const,
  url: 'http://127.0.0.1:7428',
  authUrl: 'http://127.0.0.1:7428/#token=abc',
  pid: 42,
  version: '0.1.0',
};

describe('the stdout ready frame', () => {
  it('starts on a line of its own, with the record separator, the nonce and one JSON line', () => {
    const nonce = 'a'.repeat(32);
    const frame = formatServeReadyFrame(nonce, ready);
    expect(frame.startsWith(`\n${SERVE_READY_FRAME_PREFIX}${nonce} {`)).toBe(true);
    expect(frame.endsWith('}\n')).toBe(true);
    expect(frame.slice(1, -1)).not.toContain('\n');
    expect(SERVE_READY_FRAME_PREFIX.charCodeAt(0)).toBe(0x1e);
    expect(JSON.parse(frame.slice(1 + SERVE_READY_FRAME_PREFIX.length + nonce.length + 1))).toEqual(
      ready,
    );
  });

  it('accepts nonces of 16-128 URL-safe characters only', () => {
    for (const ok of ['a'.repeat(16), 'Az09_-'.repeat(4), 'x'.repeat(128)]) {
      expect(ServeReadyNonceSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of [
      '',
      'a'.repeat(15),
      'x'.repeat(129),
      `${'a'.repeat(16)} `,
      'a\nb'.repeat(8),
    ]) {
      expect(ServeReadyNonceSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('desktop WSL contracts', () => {
  it('has its own channel names', () => {
    expect(DESKTOP_WSL_CHANNELS).toEqual({
      status: 'octopus-diff:wsl-status',
      set: 'octopus-diff:wsl-set',
    });
  });

  it('parses a status with distros and rejects an unknown state', () => {
    const status = {
      available: true,
      distros: [
        { name: 'Ubuntu', state: 'running', version: 2, isDefault: true, system: false },
        { name: 'docker-desktop', state: 'stopped', version: 2, isDefault: false, system: true },
      ],
      selected: 'Ubuntu',
      active: null,
    };
    expect(DesktopWslStatusSchema.parse(status)).toEqual(status);
    expect(
      DesktopWslStatusSchema.safeParse({
        ...status,
        distros: [{ ...status.distros[0], state: 'paused' }],
      }).success,
    ).toBe(false);
    expect(
      DesktopWslStatusSchema.safeParse({
        ...status,
        distros: [{ ...status.distros[0], version: 3 }],
      }).success,
    ).toBe(false);
  });

  it('parses a set result', () => {
    const result = {
      ok: false,
      message: 'Not a distro on this machine.',
      status: { available: false, reason: 'x', distros: [], selected: null, active: null },
    };
    expect(DesktopWslSetResultSchema.parse(result)).toEqual(result);
  });
});

describe('ServeReady.host (#22 review)', () => {
  it('is optional (older CLIs) and a non-empty string when present', async () => {
    const { ServeReadySchema } = await import('../src/index.js');
    expect(ServeReadySchema.parse(ready)).toEqual(ready);
    expect(ServeReadySchema.parse({ ...ready, host: '0.0.0.0' })).toMatchObject({
      host: '0.0.0.0',
    });
    expect(ServeReadySchema.safeParse({ ...ready, host: '' }).success).toBe(false);
    expect(ServeReadySchema.safeParse({ ...ready, host: 7 }).success).toBe(false);
  });
});
