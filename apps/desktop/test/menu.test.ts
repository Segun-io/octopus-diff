import type { MenuItemConstructorOptions } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import {
  buildMenuTemplate,
  effectiveAccelerator,
  flattenMenu,
  isAllowedAccelerator,
  type MenuActions,
  ROLE_ACCELERATORS,
} from '../src/menu.js';

function actions(): MenuActions {
  return {
    addFolder: vi.fn(),
    openSettings: vi.fn(),
    refresh: vi.fn(),
    undo: vi.fn(),
    showLog: vi.fn(),
    retryBackend: vi.fn(),
  };
}

const PLATFORMS = ['darwin', 'linux', 'win32'] as const;

function items(platform: NodeJS.Platform, dev: boolean, a = actions()) {
  return flattenMenu(buildMenuTemplate({ platform, appName: 'octopus-diff', dev, actions: a }));
}

function clickItem(item: MenuItemConstructorOptions | undefined): void {
  if (!item?.click) throw new Error(`no clickable item ${item?.label ?? ''}`);
  (item.click as () => void)();
}

function byAccelerator(list: MenuItemConstructorOptions[], accelerator: string) {
  return list.filter((i) => effectiveAccelerator(i) === accelerator);
}

describe('isAllowedAccelerator', () => {
  it('needs Cmd/Ctrl (or a function key)', () => {
    for (const ok of [
      'CommandOrControl+O',
      'CmdOrCtrl+,',
      'Command+H',
      'Ctrl+Shift+I',
      'Shift+CommandOrControl+Z',
      'Alt+Cmd+I',
      'F11',
      'F5',
      'F24',
      'Super+K',
    ]) {
      expect(isAllowedAccelerator(ok), ok).toBe(true);
    }
  });

  it('rejects bare keys, Shift/Alt-only combinations and malformed strings', () => {
    for (const bad of [
      'j',
      'k',
      'n',
      'r',
      's',
      ',',
      '/',
      'Space',
      'Escape',
      'Shift+R',
      'Alt+R',
      'Shift+Alt+J',
      'F25',
      'F0',
      'CommandOrControl',
      'CommandOrControl+',
      '+',
      'Hyper+K',
    ]) {
      expect(isAllowedAccelerator(bad), bad).toBe(false);
    }
  });
});

describe('the menu template', () => {
  it('every accelerator, roles included, follows the rule (all platforms, dev or not)', () => {
    for (const platform of PLATFORMS) {
      for (const dev of [true, false]) {
        for (const item of items(platform, dev)) {
          if (item.role) {
            expect(Object.keys(ROLE_ACCELERATORS), `role ${item.role}`).toContain(item.role);
          }
          const acc = effectiveAccelerator(item);
          if (acc !== null)
            expect(
              isAllowedAccelerator(acc),
              `${platform} ${item.label ?? item.role}: ${acc}`,
            ).toBe(true);
        }
      }
    }
  });

  it('has App (macOS only), File, Edit, View, Window and Help', () => {
    const top = (p: NodeJS.Platform) =>
      buildMenuTemplate({
        platform: p,
        appName: 'octopus-diff',
        dev: false,
        actions: actions(),
      }).map((m) => m.label);
    expect(top('darwin')).toEqual(['octopus-diff', 'File', 'Edit', 'View', 'Window', 'Help']);
    expect(top('linux')).toEqual(['File', 'Edit', 'View', 'Window', 'Help']);
    expect(top('win32')).toEqual(['File', 'Edit', 'View', 'Window', 'Help']);
  });

  it('Cmd/Ctrl+O adds a folder, Cmd/Ctrl+, opens Settings, Cmd/Ctrl+R refreshes data', () => {
    for (const platform of PLATFORMS) {
      const a = actions();
      const list = items(platform, false, a);
      const click = (acc: string) => {
        const found = byAccelerator(list, acc);
        expect(found, `${platform} ${acc}`).toHaveLength(1);
        clickItem(found[0]);
      };
      click('CommandOrControl+O');
      expect(a.addFolder).toHaveBeenCalledOnce();
      click('CommandOrControl+,');
      expect(a.openSettings).toHaveBeenCalledOnce();
      click('CommandOrControl+R');
      expect(a.refresh).toHaveBeenCalledOnce();
      click('CommandOrControl+Z');
      expect(a.undo).toHaveBeenCalledOnce();
    }
  });

  it('Cmd/Ctrl+R is never a page reload, and Cmd/Ctrl+Z is not the undo role', () => {
    for (const platform of PLATFORMS) {
      for (const dev of [true, false]) {
        const list = items(platform, dev);
        expect(list.some((i) => i.role === 'reload')).toBe(false);
        expect(byAccelerator(list, 'CommandOrControl+R').every((i) => !i.role)).toBe(true);
        expect(list.some((i) => i.role === 'undo')).toBe(false);
      }
    }
  });

  it('DevTools and page reload only in dev runs', () => {
    for (const platform of PLATFORMS) {
      const prod = items(platform, false);
      expect(prod.some((i) => i.role === 'toggleDevTools' || i.role === 'forceReload')).toBe(false);
      const dev = items(platform, true);
      expect(dev.some((i) => i.role === 'toggleDevTools')).toBe(true);
      expect(dev.some((i) => i.role === 'forceReload')).toBe(true);
    }
  });

  it('no two items share an accelerator', () => {
    for (const platform of PLATFORMS) {
      const accs = items(platform, true)
        .map(effectiveAccelerator)
        .filter((a): a is string => a !== null)
        .map((a) => a.toLowerCase());
      // Settings is in two menus on no platform; Quit and Close once each.
      expect(new Set(accs).size, platform).toBe(accs.length);
    }
  });

  it('Help has the log and the retry action', () => {
    const a = actions();
    const list = items('linux', false, a);
    clickItem(list.find((i) => i.label === 'Show Daemon Log'));
    clickItem(list.find((i) => i.label === 'Restart Daemon Connection'));
    expect(a.showLog).toHaveBeenCalledOnce();
    expect(a.retryBackend).toHaveBeenCalledOnce();
  });
});
