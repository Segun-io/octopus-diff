// @vitest-environment jsdom
/**
 * Settings → Desktop app (#21's follow-up and #22): the "Install `octopus-diff` command" button over
 * `installCli()` / `cliStatus()`, and (Windows only) the WSL distro picker over `wslStatus()` /
 * `setWslDistro()`. The browser build has no bridge and no such section.
 */
import type {
  DesktopBridge,
  DesktopCliInstallResult,
  DesktopCliStatus,
  DesktopWslSetResult,
  DesktopWslStatus,
} from '@octopus-diff/contracts';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DesktopSection,
  DESKTOP_SECTION_TEST_IDS as IDS,
} from '../src/components/settings/DesktopSection.tsx';
import { SETTINGS_SECTIONS, visibleSections } from '../src/settings/registry.ts';

afterEach(() => {
  cleanup();
});

const NOT_INSTALLED: DesktopCliStatus = {
  state: 'not-installed',
  path: '/home/me/.local/bin/octopus-diff',
  onPath: true,
};

function fakeBridge(
  over: {
    platform?: DesktopBridge['platform'];
    status?: DesktopCliStatus;
    install?: DesktopCliInstallResult;
    wsl?: DesktopWslStatus | null;
    set?: (distro: string | null) => DesktopWslSetResult;
  } = {},
) {
  const calls: [string, unknown[]][] = [];
  const wsl = over.wsl === undefined ? null : over.wsl;
  const bridge = {
    version: 1,
    platform: over.platform ?? 'linux',
    cliStatus: async () => {
      calls.push(['cliStatus', []]);
      return over.status ?? NOT_INSTALLED;
    },
    installCli: async () => {
      calls.push(['installCli', []]);
      return (
        over.install ?? {
          outcome: 'installed',
          status: { ...NOT_INSTALLED, state: 'current' },
          message: 'Installed /home/me/.local/bin/octopus-diff.',
        }
      );
    },
    ...(wsl
      ? {
          wslStatus: async () => {
            calls.push(['wslStatus', []]);
            return wsl;
          },
          setWslDistro: async (distro: string | null) => {
            calls.push(['setWslDistro', [distro]]);
            return (
              over.set?.(distro) ?? {
                ok: true,
                message: `Switching to ${distro ?? 'Windows'}…`,
                status: { ...wsl, selected: distro },
              }
            );
          },
        }
      : {}),
  } as unknown as DesktopBridge;
  return { bridge, calls };
}

const WSL: DesktopWslStatus = {
  available: true,
  distros: [
    { name: 'Ubuntu', state: 'running', version: 2, isDefault: true, system: false },
    { name: 'My Distro', state: 'stopped', version: 1, isDefault: false, system: false },
    { name: 'docker-desktop', state: 'stopped', version: 2, isDefault: false, system: true },
  ],
  selected: null,
  active: null,
};

describe('the Desktop app section', () => {
  it('is listed only inside the desktop app', () => {
    expect(visibleSections(false).map((s) => s.id)).not.toContain('desktop');
    expect(visibleSections(true).map((s) => s.id)).toContain('desktop');
    // The browser keeps exactly the sections it had (the e2e list).
    expect(visibleSections(false)).toEqual(SETTINGS_SECTIONS);
    expect(visibleSections(false).map((s) => s.id)).toEqual([
      'general',
      'review',
      'appearance',
      'folders',
      'forges',
      'keyboard',
      'about',
    ]);
  });
});

describe('Install `octopus-diff` command', () => {
  it('shows where it goes, installs on click and shows the result', async () => {
    const { bridge, calls } = fakeBridge();
    render(<DesktopSection bridge={bridge} />);
    const status = await screen.findByTestId(IDS.cliStatus);
    await waitFor(() => expect(status.textContent).toContain('/home/me/.local/bin/octopus-diff'));
    expect(status.dataset.state).toBe('not-installed');
    const button = screen.getByTestId(IDS.cliInstall) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(calls.map(([m]) => m)).toEqual(['cliStatus', 'installCli']);
    const message = await screen.findByTestId(IDS.cliMessage);
    expect(message.textContent).toBe('Installed /home/me/.local/bin/octopus-diff.');
    expect(message.dataset.tone).toBe('ok');
    expect(screen.getByTestId(IDS.cliStatus).dataset.state).toBe('current');
  });

  it('a conflict says what is in the way and offers no install', async () => {
    const { bridge, calls } = fakeBridge({
      status: {
        state: 'conflict',
        path: '/home/me/.local/bin/octopus-diff',
        onPath: true,
        conflict: { kind: 'on-path', path: '/usr/local/bin/octopus-diff' },
      },
    });
    render(<DesktopSection bridge={bridge} />);
    const status = await screen.findByTestId(IDS.cliStatus);
    await waitFor(() => expect(status.textContent).toContain('/usr/local/bin/octopus-diff'));
    expect(status.textContent).toMatch(/nothing is overwritten/i);
    expect((screen.getByTestId(IDS.cliInstall) as HTMLButtonElement).disabled).toBe(true);
    expect(calls.map(([m]) => m)).toEqual(['cliStatus']);
  });

  it('a refusal or a failure from the installer is shown as a warning', async () => {
    const { bridge } = fakeBridge({
      install: {
        outcome: 'refused',
        status: {
          state: 'conflict',
          path: '/p',
          onPath: true,
          conflict: { kind: 'at-target', path: '/p' },
        },
        message: 'Another octopus-diff is at /p; it was left alone.',
      },
    });
    render(<DesktopSection bridge={bridge} />);
    await waitFor(() =>
      expect((screen.getByTestId(IDS.cliInstall) as HTMLButtonElement).disabled).toBe(false),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId(IDS.cliInstall));
    });
    const message = await screen.findByTestId(IDS.cliMessage);
    expect(message.textContent).toBe('Another octopus-diff is at /p; it was left alone.');
    expect(message.dataset.tone).toBe('warn');
  });

  it('unavailable (a dev run, a dmg): the reason, no button', async () => {
    const { bridge } = fakeBridge({
      status: { state: 'unavailable', reason: 'Development runs cannot install the command.' },
    });
    render(<DesktopSection bridge={bridge} />);
    const status = await screen.findByTestId(IDS.cliStatus);
    await waitFor(() =>
      expect(status.textContent).toContain('Development runs cannot install the command.'),
    );
    expect((screen.getByTestId(IDS.cliInstall) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a bridge without the installer (an older app): no command row', () => {
    const { bridge } = fakeBridge();
    const old = {
      ...bridge,
      cliStatus: undefined,
      installCli: undefined,
    } as unknown as DesktopBridge;
    render(<DesktopSection bridge={old} />);
    expect(screen.queryByTestId(IDS.cliStatus)).toBeNull();
  });
});

describe('the WSL backend picker (Windows only)', () => {
  it('is not shown off Windows, even if the bridge has the methods', async () => {
    const { bridge, calls } = fakeBridge({ platform: 'linux', wsl: WSL });
    render(<DesktopSection bridge={bridge} />);
    await screen.findByTestId(IDS.cliStatus);
    expect(screen.queryByTestId(IDS.wslPicker)).toBeNull();
    expect(calls.some(([m]) => m === 'wslStatus')).toBe(false);
  });

  it('on Windows lists the user distros (not docker-desktop) after "This PC", and switches', async () => {
    const { bridge, calls } = fakeBridge({ platform: 'win32', wsl: WSL });
    render(<DesktopSection bridge={bridge} />);
    const picker = (await screen.findByTestId(IDS.wslPicker)) as HTMLSelectElement;
    await waitFor(() => expect(picker.options.length).toBe(3));
    expect([...picker.options].map((o) => [o.value, o.textContent])).toEqual([
      ['', 'This PC (Windows)'],
      ['Ubuntu', 'Ubuntu (default) · WSL 2'],
      ['My Distro', 'My Distro · WSL 1'],
    ]);
    expect(picker.value).toBe('');
    await act(async () => {
      fireEvent.change(picker, { target: { value: 'My Distro' } });
    });
    expect(calls.filter(([m]) => m === 'setWslDistro')).toEqual([['setWslDistro', ['My Distro']]]);
    const message = await screen.findByTestId(IDS.wslMessage);
    expect(message.textContent).toBe('Switching to My Distro…');
    await act(async () => {
      fireEvent.change(picker, { target: { value: '' } });
    });
    expect(calls.filter(([m]) => m === 'setWslDistro').at(-1)).toEqual(['setWslDistro', [null]]);
  });

  it('a refused switch shows the reason and keeps the stored choice', async () => {
    const { bridge } = fakeBridge({
      platform: 'win32',
      wsl: { ...WSL, selected: 'Ubuntu' },
      set: () => ({
        ok: false,
        message: '"Gone" is not a WSL distro.',
        status: { ...WSL, selected: 'Ubuntu' },
      }),
    });
    render(<DesktopSection bridge={bridge} />);
    const picker = (await screen.findByTestId(IDS.wslPicker)) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe('Ubuntu'));
    await act(async () => {
      fireEvent.change(picker, { target: { value: 'My Distro' } });
    });
    const message = await screen.findByTestId(IDS.wslMessage);
    expect(message.textContent).toBe('"Gone" is not a WSL distro.');
    expect(message.dataset.tone).toBe('warn');
    expect(picker.value).toBe('Ubuntu');
  });

  it('a stored distro that is gone stays visible as such', async () => {
    const { bridge } = fakeBridge({ platform: 'win32', wsl: { ...WSL, selected: 'Old Distro' } });
    render(<DesktopSection bridge={bridge} />);
    const picker = (await screen.findByTestId(IDS.wslPicker)) as HTMLSelectElement;
    await waitFor(() => expect(picker.value).toBe('Old Distro'));
    expect(within(picker).getByText('Old Distro (not installed)')).toBeTruthy();
  });

  it('WSL unavailable: the reason, no picker', async () => {
    const { bridge } = fakeBridge({
      platform: 'win32',
      wsl: {
        available: false,
        reason: 'WSL is not installed.',
        distros: [],
        selected: null,
        active: null,
      },
    });
    render(<DesktopSection bridge={bridge} />);
    const row = await screen.findByTestId(IDS.wslRow);
    await waitFor(() => expect(row.textContent).toContain('WSL is not installed.'));
    expect(screen.queryByTestId(IDS.wslPicker)).toBeNull();
  });
});
