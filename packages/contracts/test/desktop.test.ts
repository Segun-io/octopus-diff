import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  DESKTOP_COMMANDS,
  DESKTOP_EDITOR_LABELS,
  DESKTOP_EDITORS,
  type DesktopActionResult,
  type DesktopBridge,
} from '../src/index.js';

describe('desktop bridge contract', () => {
  it('lists the allowlisted editors, each with a label', () => {
    expect(DESKTOP_EDITORS).toEqual(['vscode', 'cursor', 'zed']);
    for (const editor of DESKTOP_EDITORS) expect(DESKTOP_EDITOR_LABELS[editor]).toBeTruthy();
  });

  it('lists the menu commands the page can subscribe to', () => {
    expect(DESKTOP_COMMANDS).toEqual(['open-settings', 'refresh', 'undo']);
  });

  it('declares window.octopusDesktop as optional', () => {
    expectTypeOf<Window['octopusDesktop']>().toEqualTypeOf<DesktopBridge | undefined>();
    expectTypeOf<DesktopActionResult>().toExtend<{ ok: boolean }>();
  });
});
