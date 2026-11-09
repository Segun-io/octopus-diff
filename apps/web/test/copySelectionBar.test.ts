import { describe, expect, it } from 'vitest';
import { resolveBarPosition } from '../src/components/diff/CopySelectionBar.tsx';

describe('resolveBarPosition', () => {
  const bounds = { width: 800, height: 600 };
  const bar = { width: 260, height: 30 };

  it('goes below-right of the pointer', () => {
    expect(resolveBarPosition({ pointer: { x: 100, y: 100 }, bounds, bar })).toEqual({
      left: 108,
      top: 112,
    });
  });

  it('stays inside the right edge', () => {
    expect(resolveBarPosition({ pointer: { x: 790, y: 100 }, bounds, bar }).left).toBe(532);
  });

  it('flips above the pointer near the bottom', () => {
    expect(resolveBarPosition({ pointer: { x: 100, y: 580 }, bounds, bar }).top).toBe(538);
  });

  it('never leaves the top-left corner', () => {
    expect(resolveBarPosition({ pointer: { x: -50, y: -50 }, bounds, bar })).toEqual({
      left: 8,
      top: 8,
    });
  });
});
