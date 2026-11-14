/**
 * #22 review LOW 3: in WSL mode the window sends nothing to the daemon's origin from the moment
 * the backend leaves `ready` until `verifyDaemon` passed again (a restarted, or squatted, port must
 * not get the page's `Authorization: Bearer`). Inert in every other mode.
 */
import { describe, expect, it } from 'vitest';
import { UiRequestGate } from '../src/ui-request-gate.js';

function setup() {
  const installs: ('on' | 'off')[] = [];
  let listener: ((url: string) => boolean) | null = null;
  const blocked: string[] = [];
  const gate = new UiRequestGate({
    install: (l) => {
      installs.push(l ? 'on' : 'off');
      listener = l;
    },
    blocked: (origin) => blocked.push(origin),
  });
  const cancels = (url: string) => listener?.(url) ?? false;
  return { gate, installs, cancels, blocked };
}

const UI = 'http://127.0.0.1:7428/api/inbox';

describe('UiRequestGate', () => {
  it('inert unless enabled (the Windows/macOS/Linux backend): no listener at all', () => {
    const t = setup();
    t.gate.backendState('restarting');
    t.gate.backendState('ready');
    expect(t.installs).toEqual([]);
    expect(t.gate.shouldCancel(UI)).toBe(false);
  });

  it('enabled: closed until verified, then open; leaving ready closes it again', () => {
    const t = setup();
    t.gate.enable();
    expect(t.installs).toEqual(['on']);
    expect(t.cancels(UI)).toBe(true);
    t.gate.backendState('ready');
    // `ready` alone does not open it: only the proof does.
    expect(t.cancels(UI)).toBe(true);
    t.gate.verified();
    expect(t.cancels(UI)).toBe(false);
    for (const kind of [
      'restarting',
      'starting',
      'failed',
      'stopping',
      'stopped',
      'idle',
    ] as const) {
      t.gate.verified();
      t.gate.backendState(kind);
      expect(t.cancels(UI), kind).toBe(true);
    }
    t.gate.backendState('ready');
    expect(t.cancels(UI)).toBe(true);
    t.gate.verified();
    expect(t.cancels(UI)).toBe(false);
  });

  it('blocks http(s) only (screens are data: pages), and reports the first block per closed spell', () => {
    const t = setup();
    t.gate.enable();
    expect(t.cancels('data:text/html,x')).toBe(false);
    expect(t.cancels('devtools://devtools/x')).toBe(false);
    expect(t.cancels('http://127.0.0.1:7428/api/events')).toBe(true);
    expect(t.cancels('https://127.0.0.1:7428/')).toBe(true);
    expect(t.blocked).toEqual(['http://127.0.0.1:7428']);
    t.gate.verified();
    t.gate.close();
    t.cancels(UI);
    expect(t.blocked).toHaveLength(2);
  });

  it('disable() removes the listener (back to the Windows backend) and leaves it inert', () => {
    const t = setup();
    t.gate.enable();
    t.gate.enable();
    expect(t.installs).toEqual(['on']);
    t.gate.disable();
    expect(t.installs).toEqual(['on', 'off']);
    expect(t.gate.shouldCancel(UI)).toBe(false);
    t.gate.backendState('restarting');
    expect(t.gate.shouldCancel(UI)).toBe(false);
  });
});
