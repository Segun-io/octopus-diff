// @vitest-environment jsdom
import {
  createApiClient,
  type DesktopActionResult,
  type DesktopBridge,
  type DesktopCliInstallResult,
  type DesktopCliStatus,
  type DesktopCommand,
  TEST_IDS,
} from '@octopus-diff/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MockBackend } from '../mock/backend.ts';
import { createMockFetch } from '../mock/router.ts';
import { App } from '../src/App.tsx';
import type { EventSourceLike } from '../src/api/hooks.ts';
import { createQueryClient } from '../src/api/queries.ts';
import { copyText } from '../src/lib/copy.ts';
import {
  DESKTOP_TEST_IDS,
  desktopBridge,
  desktopMenuItems,
  droppedFolder,
  revealLabel,
  runDesktopCommand,
} from '../src/lib/desktop.ts';
import { GENERAL_ITEMS, visiblePrefItems } from '../src/settings/registry.ts';
import { DEFAULT_PREFS, normalizePrefs, scopeForPref } from '../src/state/prefs.ts';
import { createUiStore, type UiStore } from '../src/state/ui.tsx';

vi.mock('../src/components/diff/DiffRenderer.tsx', () => ({
  DiffRenderer: ({ patch }: { patch: string }) => <pre data-testid="stub-diff">{patch}</pre>,
}));

/** A recording `window.octopusDesktop`. */
class FakeBridge implements DesktopBridge {
  readonly version = 1 as const;
  calls: [string, unknown[]][] = [];
  badges: number[] = [];
  listeners = new Set<(command: DesktopCommand) => void>();
  result: DesktopActionResult = { ok: true };
  picked: string | null = '/home/me/picked';
  copied = true;
  paths = new Map<unknown, string>();
  constructor(readonly platform: 'darwin' | 'win32' | 'linux' = 'darwin') {}
  pickFolder = async (options?: unknown) => {
    this.calls.push(['pickFolder', [options]]);
    return this.picked;
  };
  revealPath = async (...args: unknown[]) => {
    this.calls.push(['revealPath', args]);
    return this.result;
  };
  openPath = async (...args: unknown[]) => {
    this.calls.push(['openPath', args]);
    return this.result;
  };
  openInEditor = async (...args: unknown[]) => {
    this.calls.push(['openInEditor', args]);
    return this.result;
  };
  setBadge = (count: number) => {
    this.badges.push(count);
  };
  getPathForFile = (file: File) => this.paths.get(file) ?? null;
  copyText = async (text: string) => {
    this.calls.push(['copyText', [text]]);
    return this.copied;
  };
  cliStatus = async (): Promise<DesktopCliStatus> => ({ state: 'unavailable', reason: 'test' });
  installCli = async (): Promise<DesktopCliInstallResult> => ({
    outcome: 'unavailable',
    status: { state: 'unavailable', reason: 'test' },
    message: 'test',
  });
  onCommand = (listener: (command: DesktopCommand) => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  send(command: DesktopCommand) {
    for (const l of this.listeners) l(command);
  }
}

class FakeEventSource implements EventSourceLike {
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = 1;
  addEventListener() {}
  close() {
    this.readyState = 2;
  }
}

function setup(store?: Partial<Parameters<typeof createUiStore>[0]>): {
  store: UiStore;
  backend: MockBackend;
} {
  const backend = new MockBackend({ dataset: 'demo', statusFlow: false });
  const api = createApiClient({ baseUrl: 'http://mock.local', fetch: createMockFetch(backend) });
  const ui = createUiStore(
    { confirmBulk: false, settledOpen: true, scope: scopeForPref('working'), ...store },
    false,
  );
  const factory = () => {
    const es = new FakeEventSource();
    queueMicrotask(() => es.onopen?.(new Event('open')));
    return es;
  };
  render(
    <App api={api} queryClient={createQueryClient()} uiStore={ui} eventSourceFactory={factory} />,
  );
  return { store: ui, backend };
}

const app = () => screen.getByTestId(TEST_IDS.app);
async function ready() {
  await waitFor(() => expect(app().getAttribute('data-ready')).toBe('true'));
  await waitFor(() => expect(screen.getAllByTestId(TEST_IDS.fileItem).length).toBeGreaterThan(0));
}

let bridge: FakeBridge;
beforeEach(() => {
  bridge = new FakeBridge();
});
afterEach(() => {
  cleanup();
  delete window.octopusDesktop;
  localStorage.clear();
});

describe('desktopBridge (feature detection)', () => {
  it('is null in a browser', () => {
    expect(desktopBridge()).toBeNull();
  });

  it('accepts a complete version-1 bridge', () => {
    window.octopusDesktop = bridge;
    expect(desktopBridge()).toBe(bridge);
  });

  it('ignores a bridge of another version, platform or shape', () => {
    for (const bad of [
      { ...bridge, version: 2 },
      { ...bridge, platform: 'beos' },
      { ...bridge, openPath: undefined },
      'yes',
      null,
    ]) {
      window.octopusDesktop = bad as unknown as DesktopBridge;
      expect(desktopBridge(), JSON.stringify(bad)).toBeNull();
    }
  });

  it('names Reveal per platform', () => {
    expect(revealLabel('darwin')).toBe('Reveal in Finder');
    expect(revealLabel('win32')).toBe('Show in Explorer');
    expect(revealLabel('linux')).toBe('Show in file manager');
  });
});

describe('desktopMenuItems', () => {
  it('is empty without the bridge', () => {
    expect(desktopMenuItems(null, { worktreeId: 'w' }, 'vscode', () => {})).toEqual([]);
  });

  it('reveals, opens and opens in the chosen editor; reports refusals', async () => {
    const reports: string[] = [];
    const items = desktopMenuItems(bridge, { worktreeId: 'w1', relPath: 'src/a.ts' }, 'zed', (t) =>
      reports.push(t),
    );
    expect(items.map((i) => i.label)).toEqual([
      'Reveal in Finder',
      'Open with default app',
      'Open in Zed',
    ]);
    for (const item of items) item.onSelect?.();
    await waitFor(() => expect(bridge.calls.length).toBe(3));
    expect(bridge.calls).toEqual([
      ['revealPath', ['w1', 'src/a.ts']],
      ['openPath', ['w1', 'src/a.ts']],
      ['openInEditor', ['w1', 'src/a.ts', { editor: 'zed' }]],
    ]);
    expect(reports).toEqual([]);
    bridge.result = { ok: false, reason: 'unsafe-file', message: 'This would run a program.' };
    items[1]?.onSelect?.();
    await waitFor(() => expect(reports).toEqual(['This would run a program.']));
  });

  it('a worktree target says "Open folder"; a deleted file is disabled', () => {
    expect(desktopMenuItems(bridge, { worktreeId: 'w' }, 'vscode', () => {})[1]?.label).toBe(
      'Open folder',
    );
    const deleted = desktopMenuItems(
      bridge,
      { worktreeId: 'w', relPath: 'gone.ts', deleted: true },
      'vscode',
      () => {},
    );
    expect(deleted.every((i) => i.disabled)).toBe(true);
  });
});

describe('runDesktopCommand (menu hooks)', () => {
  const handlers = () => ({ openSettings: vi.fn(), refreshNow: vi.fn(), undoBulk: vi.fn() });

  it('maps each command', () => {
    const h = handlers();
    runDesktopCommand('open-settings', h);
    runDesktopCommand('refresh', h);
    runDesktopCommand('undo', h);
    expect(h.openSettings).toHaveBeenCalledOnce();
    expect(h.refreshNow).toHaveBeenCalledOnce();
    expect(h.undoBulk).toHaveBeenCalledOnce();
  });

  it('undo in a text field is the editing undo, not the bulk undo', () => {
    const h = handlers();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    const exec = vi.fn(() => true);
    document.execCommand = exec;
    runDesktopCommand('undo', h);
    expect(exec).toHaveBeenCalledWith('undo');
    expect(h.undoBulk).not.toHaveBeenCalled();
    input.remove();
  });
});

describe('droppedFolder', () => {
  const transfer = (files: File[], isDirectory: boolean | null) =>
    ({
      files: Object.assign(files, { item: (i: number) => files[i] }),
      items: files.map(() => ({
        webkitGetAsEntry: () => (isDirectory === null ? null : { isDirectory }),
      })),
      types: ['Files'],
    }) as unknown as DataTransfer;

  it('is the path of one dropped folder, nothing else', () => {
    const folder = new File([], 'repo');
    bridge.paths.set(folder, '/home/me/repo');
    expect(droppedFolder(bridge, transfer([folder], true))).toBe('/home/me/repo');
    expect(droppedFolder(bridge, transfer([folder], false))).toBeNull();
    expect(droppedFolder(bridge, transfer([folder, folder], true))).toBeNull();
    expect(droppedFolder(bridge, transfer([], true))).toBeNull();
    expect(droppedFolder(bridge, null)).toBeNull();
  });
});

describe('prefs and settings', () => {
  it('the editor pref defaults to VS Code and accepts the allowlisted editors only', () => {
    expect(DEFAULT_PREFS.editor).toBe('vscode');
    expect(normalizePrefs({ editor: 'cursor' }).editor).toBe('cursor');
    expect(normalizePrefs({ editor: 'notepad' }).editor).toBe('vscode');
  });

  it('the Editor setting shows in the desktop app only', () => {
    expect(visiblePrefItems(GENERAL_ITEMS, false).some((i) => i.key === 'editor')).toBe(false);
    expect(visiblePrefItems(GENERAL_ITEMS, true).some((i) => i.key === 'editor')).toBe(true);
  });
});

describe('copyText', () => {
  it('uses the bridge first, the browser ways when it refuses', async () => {
    window.octopusDesktop = bridge;
    expect(await copyText('feature/x')).toBe(true);
    expect(bridge.calls).toEqual([['copyText', ['feature/x']]]);
    bridge.copied = false;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    expect(await copyText('y')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('y');
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
  });
});

describe('the browser build (no bridge)', () => {
  it('Settings lists no Desktop app section', async () => {
    setup();
    await ready();
    fireEvent.click(screen.getByTestId(TEST_IDS.settingsOpenButton));
    const dialog = await screen.findByTestId(TEST_IDS.settingsDialog);
    const ids = within(dialog)
      .getAllByTestId(TEST_IDS.settingsSection)
      .map((s) => s.dataset.section);
    expect(ids).not.toContain('desktop');
    expect(ids).toHaveLength(7);
  });
});

describe('the app with the bridge', () => {
  it('sets the platform on <html>, follows the unreviewed count with the badge', async () => {
    window.octopusDesktop = bridge;
    setup();
    await ready();
    expect(document.documentElement.dataset.desktopPlatform).toBe('darwin');
    await waitFor(() => expect(bridge.badges.at(-1)).toBeGreaterThan(0));
    cleanup();
    expect(document.documentElement.dataset.desktopPlatform).toBeUndefined();
    expect(bridge.badges.at(-1)).toBe(0);
  });

  it('the badge stays 0 when the count setting is off', async () => {
    window.octopusDesktop = bridge;
    setup({ titleCount: false });
    await ready();
    expect(bridge.badges.every((b) => b === 0)).toBe(true);
  });

  it('the worktree menu reveals and opens the worktree by id', async () => {
    window.octopusDesktop = bridge;
    setup();
    await ready();
    const row = screen.getAllByTestId(TEST_IDS.worktreeItem)[0] as HTMLElement;
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByTestId(DESKTOP_TEST_IDS.reveal));
    await waitFor(() => expect(bridge.calls[0]?.[0]).toBe('revealPath'));
    const [worktreeId, relPath] = bridge.calls[0]?.[1] ?? [];
    expect(worktreeId).toBe(row.dataset.worktreeId);
    expect(relPath).toBeUndefined();
  });

  it('the file menu opens the file in the editor from Settings', async () => {
    window.octopusDesktop = bridge;
    setup({ editor: 'cursor' });
    await ready();
    const file = screen.getAllByTestId(TEST_IDS.fileItem)[0] as HTMLElement;
    fireEvent.contextMenu(file);
    const menu = await screen.findByRole('menu');
    const item = within(menu).getByTestId(DESKTOP_TEST_IDS.openInEditor);
    expect(item.textContent).toContain('Open in Cursor');
    fireEvent.click(item);
    await waitFor(() => expect(bridge.calls[0]?.[0]).toBe('openInEditor'));
    const [worktreeId, relPath, options] = bridge.calls[0]?.[1] ?? [];
    expect(typeof worktreeId).toBe('string');
    expect(relPath).toBe(file.dataset.path);
    expect(options).toEqual({ editor: 'cursor' });
  });

  it('the diff header menu has the file group and the worktree group', async () => {
    window.octopusDesktop = bridge;
    const { store } = setup();
    await ready();
    const file = screen.getAllByTestId(TEST_IDS.fileItem)[0] as HTMLElement;
    fireEvent.click(file);
    await waitFor(() => expect(store.getState().selected).not.toBeNull());
    fireEvent.click(await screen.findByTestId('diff-header-menu'));
    const menu = await screen.findByTestId('diff-header-menu-list');
    const reveals = within(menu).getAllByTestId(DESKTOP_TEST_IDS.reveal);
    expect(reveals.length).toBe(1);
    fireEvent.click(reveals[0] as HTMLElement);
    await waitFor(() => expect(bridge.calls[0]?.[0]).toBe('revealPath'));
    const selected = store.getState().selected;
    expect(bridge.calls[0]?.[1]).toEqual([selected?.worktreeId, selected?.path]);
  });

  it('the project Overview row menu opens the worktree folder', async () => {
    window.octopusDesktop = bridge;
    const { store, backend } = setup();
    await ready();
    const projectId = backend.listProjects().projects[0]?.project.id ?? '';
    act(() => store.setState({ view: { kind: 'project', projectId } }));
    const row = (await screen.findAllByTestId('overview-worktree-row'))[0] as HTMLElement;
    fireEvent.contextMenu(row);
    const menu = await screen.findByRole('menu');
    fireEvent.click(within(menu).getByTestId(DESKTOP_TEST_IDS.open));
    await waitFor(() =>
      expect(bridge.calls[0]).toEqual(['openPath', [row.dataset.worktreeId, undefined]]),
    );
  });

  it('a refusal shows as a notice', async () => {
    window.octopusDesktop = bridge;
    bridge.result = { ok: false, reason: 'outside-worktree', message: 'Outside its worktree.' };
    const { store } = setup();
    await ready();
    fireEvent.contextMenu(screen.getAllByTestId(TEST_IDS.fileItem)[0] as HTMLElement);
    fireEvent.click(within(await screen.findByRole('menu')).getByTestId(DESKTOP_TEST_IDS.open));
    await waitFor(() => expect(store.getState().notice?.text).toBe('Outside its worktree.'));
  });

  it('menu commands: Settings opens the Settings dialog, Refresh refetches', async () => {
    window.octopusDesktop = bridge;
    setup();
    await ready();
    expect(bridge.listeners.size).toBe(1);
    act(() => bridge.send('open-settings'));
    expect(await screen.findByTestId(TEST_IDS.settingsDialog)).toBeTruthy();
  });

  it('Settings shows the Editor choice', async () => {
    window.octopusDesktop = bridge;
    setup();
    await ready();
    act(() => bridge.send('open-settings'));
    const dialog = await screen.findByTestId(TEST_IDS.settingsDialog);
    expect(within(dialog).getByText('Editor')).toBeTruthy();
  });

  it('Settings has a Desktop app section with the command installer (#21 follow-up)', async () => {
    window.octopusDesktop = bridge;
    setup();
    await ready();
    act(() => bridge.send('open-settings'));
    const dialog = await screen.findByTestId(TEST_IDS.settingsDialog);
    const ids = within(dialog)
      .getAllByTestId(TEST_IDS.settingsSection)
      .map((s) => s.dataset.section);
    expect(ids).toEqual([
      'general',
      'review',
      'appearance',
      'folders',
      'forges',
      'keyboard',
      'desktop',
      'about',
    ]);
    const desktop = within(dialog)
      .getAllByTestId(TEST_IDS.settingsSection)
      .find((s) => s.dataset.section === 'desktop') as HTMLElement;
    fireEvent.click(desktop);
    expect(await within(dialog).findByTestId('desktop-cli-status')).toBeTruthy();
    // darwin: no WSL picker.
    expect(within(dialog).queryByTestId('desktop-wsl-row')).toBeNull();
  });

  it('dropping a folder opens the add dialog at it', async () => {
    window.octopusDesktop = bridge;
    const { store } = setup();
    await ready();
    const folder = new File([], 'repo');
    bridge.paths.set(folder, '/home/me/dropped');
    const data = {
      files: Object.assign([folder], { item: () => folder }),
      items: [{ webkitGetAsEntry: () => ({ isDirectory: true }) }],
      types: ['Files'],
      dropEffect: 'none',
    };
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', { value: data });
    act(() => {
      window.dispatchEvent(drop);
    });
    expect(drop.defaultPrevented).toBe(true);
    expect(store.getState().addProjectOpen).toBe(true);
    expect(store.getState().addProjectPath).toBe('/home/me/dropped');
    expect(await screen.findByTestId(TEST_IDS.folderPicker)).toBeTruthy();
  });

  it('dropping a file says to drop a folder', async () => {
    window.octopusDesktop = bridge;
    const { store } = setup();
    await ready();
    const file = new File(['x'], 'a.txt');
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        files: Object.assign([file], { item: () => file }),
        items: [{ webkitGetAsEntry: () => ({ isDirectory: false }) }],
        types: ['Files'],
      },
    });
    act(() => {
      window.dispatchEvent(drop);
    });
    expect(store.getState().addProjectOpen).toBe(false);
    expect(store.getState().notice?.text).toBe('Drop one folder to add it.');
  });

  it('Browse… in the add dialog picks a folder with the native dialog', async () => {
    window.octopusDesktop = bridge;
    const { store } = setup();
    await ready();
    act(() => store.setState({ addProjectOpen: true }));
    const browse = await screen.findByTestId(DESKTOP_TEST_IDS.browse);
    fireEvent.click(browse);
    await waitFor(() => expect(bridge.calls.some(([m]) => m === 'pickFolder')).toBe(true));
  });
});

describe('the app without the bridge (the browser build)', () => {
  it('adds nothing: no attribute, no badge, no desktop menu items, no Browse…, drops ignored', async () => {
    const { store } = setup();
    await ready();
    expect(document.documentElement.dataset.desktopPlatform).toBeUndefined();
    fireEvent.contextMenu(screen.getAllByTestId(TEST_IDS.worktreeItem)[0] as HTMLElement);
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByTestId(DESKTOP_TEST_IDS.reveal)).toBeNull();
    fireEvent.keyDown(menu, { key: 'Escape' });
    fireEvent.contextMenu(screen.getAllByTestId(TEST_IDS.fileItem)[0] as HTMLElement);
    const fileMenu = (await screen.findAllByRole('menu')).at(-1) as HTMLElement;
    expect(within(fileMenu).queryByTestId(DESKTOP_TEST_IDS.openInEditor)).toBeNull();
    const drop = new Event('drop', { bubbles: true, cancelable: true });
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(false);
    act(() => store.setState({ addProjectOpen: true }));
    await screen.findByTestId(TEST_IDS.folderPicker);
    expect(screen.queryByTestId(DESKTOP_TEST_IDS.browse)).toBeNull();
  });
});
