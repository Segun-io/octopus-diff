import { describe, expect, it } from 'vitest';
import { badgePlan, overlayDotBitmap } from '../src/badge.js';
import { PageCommands } from '../src/page-commands.js';

describe('badgePlan', () => {
  it('macOS and Linux use the app badge count (0 clears it)', () => {
    expect(badgePlan('darwin', 12)).toEqual({ kind: 'count', count: 12 });
    expect(badgePlan('linux', 0)).toEqual({ kind: 'count', count: 0 });
  });

  it('Windows uses a taskbar overlay with a description, none at 0', () => {
    expect(badgePlan('win32', 3)).toEqual({ kind: 'overlay', description: '3 unreviewed files' });
    expect(badgePlan('win32', 1)).toEqual({ kind: 'overlay', description: '1 unreviewed file' });
    expect(badgePlan('win32', 0)).toEqual({ kind: 'clear-overlay' });
  });

  it('caps absurd counts', () => {
    expect(badgePlan('darwin', 5_000_000)).toEqual({ kind: 'count', count: 99_999 });
  });
});

describe('overlayDotBitmap', () => {
  it('is a 16x16 BGRA dot: opaque centre, transparent corners', () => {
    const size = 16;
    const bitmap = overlayDotBitmap(size);
    expect(bitmap.length).toBe(size * size * 4);
    const px = (x: number, y: number) =>
      bitmap.subarray((y * size + x) * 4, (y * size + x) * 4 + 4);
    expect(px(8, 8)[3]).toBe(255);
    expect(px(0, 0)[3]).toBe(0);
    expect(px(15, 15)[3]).toBe(0);
    // Amber (#e0ae52) in BGRA order.
    expect([...px(8, 8)]).toEqual([0x52, 0xae, 0xe0, 255]);
  });
});

describe('PageCommands (menu hooks, DECISIONS #495)', () => {
  it('uses the fallback script until the page subscribed', () => {
    const p = new PageCommands();
    expect(p.route(7, 'refresh', 'script()')).toEqual({ kind: 'script', script: 'script()' });
    p.markReady(7);
    expect(p.route(7, 'refresh', 'script()')).toEqual({ kind: 'send', command: 'refresh' });
    expect(p.route(8, 'refresh', 'script()')).toEqual({ kind: 'script', script: 'script()' });
  });

  it('forgets the subscription when the page navigates or the window goes', () => {
    const p = new PageCommands();
    p.markReady(7);
    p.reset(7);
    expect(p.route(7, 'undo', 'u()')).toEqual({ kind: 'script', script: 'u()' });
  });
});
