import { describe, expect, it } from 'vitest';
import {
  parseWindowState,
  restoreBounds,
  serializeWindowState,
  type WindowState,
} from '../src/window-state.js';

const MIN = { width: 720, height: 480 };
const LAPTOP = { x: 0, y: 0, width: 1440, height: 875 };
const EXTERNAL = { x: 1440, y: -200, width: 2560, height: 1415 };

function state(bounds: WindowState['bounds'], maximized = false): WindowState {
  return { version: 1, bounds, maximized, fullScreen: false };
}

describe('parseWindowState', () => {
  it('round-trips a saved state', () => {
    const s = state({ x: 10, y: 20, width: 1000, height: 700 }, true);
    expect(parseWindowState(serializeWindowState(s))).toEqual(s);
  });

  it('defaults fullScreen for older files', () => {
    expect(
      parseWindowState(
        JSON.stringify({
          version: 1,
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          maximized: false,
        }),
      ),
    ).toMatchObject({ fullScreen: false });
  });

  it('rejects anything malformed or out of range', () => {
    for (const text of [
      null,
      '',
      '{',
      '[]',
      JSON.stringify({
        version: 2,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        maximized: false,
      }),
      JSON.stringify({
        version: 1,
        bounds: { x: 0, y: 0, width: 0, height: 600 },
        maximized: false,
      }),
      JSON.stringify({
        version: 1,
        bounds: { x: 0.5, y: 0, width: 800, height: 600 },
        maximized: false,
      }),
      JSON.stringify({
        version: 1,
        bounds: { x: 1e9, y: 0, width: 800, height: 600 },
        maximized: false,
      }),
      JSON.stringify({ version: 1, bounds: { x: 0, y: 0, width: 800 }, maximized: false }),
      JSON.stringify({
        version: 1,
        bounds: { x: 0, y: 0, width: 800, height: 600 },
        maximized: 'yes',
      }),
    ]) {
      expect(parseWindowState(text), String(text)).toBeNull();
    }
  });
});

describe('restoreBounds', () => {
  it('keeps bounds that fit a display', () => {
    const b = { x: 100, y: 50, width: 1200, height: 800 };
    expect(restoreBounds(state(b), [LAPTOP], MIN)).toEqual(b);
  });

  it('nothing saved, or no display: null (centered default)', () => {
    expect(restoreBounds(null, [LAPTOP], MIN)).toBeNull();
    expect(restoreBounds(state({ x: 0, y: 0, width: 800, height: 600 }), [], MIN)).toBeNull();
  });

  it('a window on an unplugged monitor is not restored there', () => {
    expect(
      restoreBounds(state({ x: 2000, y: 100, width: 1200, height: 800 }), [LAPTOP], MIN),
    ).toBeNull();
    expect(
      restoreBounds(state({ x: -5000, y: -5000, width: 800, height: 600 }), [LAPTOP], MIN),
    ).toBeNull();
  });

  it('a sliver on screen (under MIN_VISIBLE px) does not count', () => {
    expect(
      restoreBounds(state({ x: 1400, y: 100, width: 1000, height: 600 }), [LAPTOP], MIN),
    ).toBeNull();
  });

  it('moves a partly off-screen window inside the display it overlaps most', () => {
    expect(
      restoreBounds(state({ x: 1000, y: 500, width: 1000, height: 700 }), [LAPTOP], MIN),
    ).toEqual({
      x: 440,
      y: 175,
      width: 1000,
      height: 700,
    });
  });

  it('shrinks a window bigger than its display, never below the minimum size', () => {
    expect(restoreBounds(state({ x: 0, y: 0, width: 3000, height: 2000 }), [LAPTOP], MIN)).toEqual(
      LAPTOP,
    );
    expect(restoreBounds(state({ x: 10, y: 10, width: 100, height: 100 }), [LAPTOP], MIN)).toEqual({
      x: 10,
      y: 10,
      width: 720,
      height: 480,
    });
  });

  it('picks the display with the largest overlap (negative coordinates included)', () => {
    const b = { x: 1500, y: -150, width: 1600, height: 1000 };
    expect(restoreBounds(state(b), [LAPTOP, EXTERNAL], MIN)).toEqual(b);
  });
});
