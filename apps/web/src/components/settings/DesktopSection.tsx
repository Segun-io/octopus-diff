/**
 * Settings → Desktop app: only inside the desktop app (`window.octopusDesktop`; the browser build
 * never lists this section, `visibleSections`).
 *
 * - **The `octopus-diff` command** (#21's follow-up): where the app's launcher goes and whether it
 *   is there, over `cliStatus()`; the button calls `installCli()` (the app never overwrites another
 *   `octopus-diff`, and says so). Hidden when the bridge has no installer (an older app).
 * - **Where the backend runs** (#22, Windows only): this PC, or a WSL distro, over `wslStatus()` /
 *   `setWslDistro()`. The choice is kept by the desktop app (not the daemon); the app checks the
 *   distro and explains what is missing there.
 */
import type {
  DesktopBridge,
  DesktopCliStatus,
  DesktopWslDistro,
  DesktopWslStatus,
} from '@octopus-diff/contracts';
import { useEffect, useId, useState } from 'react';
import { SettingRow, SmallButton } from './controls.tsx';

export const DESKTOP_SECTION_TEST_IDS = {
  cliStatus: 'desktop-cli-status',
  cliInstall: 'desktop-cli-install',
  cliMessage: 'desktop-cli-message',
  wslRow: 'desktop-wsl-row',
  wslPicker: 'desktop-wsl-picker',
  wslMessage: 'desktop-wsl-message',
} as const;
const IDS = DESKTOP_SECTION_TEST_IDS;

type Tone = 'ok' | 'warn';

function Message({ testId, text, tone }: { testId: string; text: string; tone: Tone }) {
  return (
    <p
      data-testid={testId}
      data-tone={tone}
      role="status"
      className={`mt-1 text-[11px] ${tone === 'ok' ? 'text-muted' : 'text-warn'}`}
    >
      {text}
    </p>
  );
}

export function DesktopSection({ bridge }: { bridge: DesktopBridge }) {
  const hasInstaller =
    typeof bridge.cliStatus === 'function' && typeof bridge.installCli === 'function';
  const hasWsl =
    bridge.platform === 'win32' &&
    typeof bridge.wslStatus === 'function' &&
    typeof bridge.setWslDistro === 'function';
  return (
    <div>
      <span className="od-chip">Saved by the desktop app</span>
      <div className="mt-2">
        {hasInstaller && <CliCommandRow bridge={bridge} />}
        {hasWsl && <WslBackendRow bridge={bridge} />}
        {!hasInstaller && !hasWsl && (
          <p className="py-2.5 text-xs text-muted">This version of the app has no settings here.</p>
        )}
      </div>
    </div>
  );
}

/** One sentence about the command's state. */
export function describeCliStatus(status: DesktopCliStatus): string {
  const notOnPath =
    status.onPath === false
      ? ' Its folder is not on your PATH yet: add it, then open a new terminal.'
      : '';
  switch (status.state) {
    case 'unavailable':
      return status.reason ?? 'The command cannot be installed from this copy of the app.';
    case 'not-installed':
      return `Not installed. It goes to ${status.path ?? 'your user bin folder'}.${notOnPath}`;
    case 'current':
      return `Installed at ${status.path ?? '?'}.${notOnPath}`;
    case 'outdated':
      return `Installed at ${status.path ?? '?'} for another copy of the app: installing points it here.${notOnPath}`;
    case 'conflict':
      return `Another octopus-diff is in the way (${status.conflict?.path ?? status.path ?? '?'}); nothing is overwritten. Remove it first, or keep using it.`;
  }
}

function CliCommandRow({ bridge }: { bridge: DesktopBridge }) {
  const [status, setStatus] = useState<DesktopCliStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: Tone } | null>(null);

  useEffect(() => {
    let live = true;
    void bridge.cliStatus?.().then(
      (s) => {
        if (live) setStatus(s);
      },
      () => {
        if (live) setStatus({ state: 'unavailable', reason: 'The desktop app did not answer.' });
      },
    );
    return () => {
      live = false;
    };
  }, [bridge]);

  const canInstall = status?.state === 'not-installed' || status?.state === 'outdated';
  const install = async () => {
    setBusy(true);
    try {
      const result = await bridge.installCli();
      setStatus(result.status);
      const ok =
        result.outcome === 'installed' ||
        result.outcome === 'updated' ||
        result.outcome === 'unchanged';
      setMessage({ text: result.message, tone: ok ? 'ok' : 'warn' });
    } catch {
      setMessage({ text: 'The desktop app did not answer.', tone: 'warn' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow
      label="The octopus-diff command"
      description="A terminal command that runs this app's copy of the CLI and talks to its daemon."
    >
      <div className="flex max-w-xs flex-col items-end text-right">
        <SmallButton
          testId={IDS.cliInstall}
          disabled={!canInstall || busy}
          onClick={() => void install()}
        >
          {status?.state === 'outdated' ? 'Update command' : 'Install command'}
        </SmallButton>
        <p
          data-testid={IDS.cliStatus}
          data-state={status?.state ?? 'loading'}
          className="mt-1 text-[11px] text-muted"
        >
          {status ? describeCliStatus(status) : 'Checking…'}
        </p>
        {message && <Message testId={IDS.cliMessage} text={message.text} tone={message.tone} />}
      </div>
    </SettingRow>
  );
}

function distroLabel(d: DesktopWslDistro): string {
  return `${d.name}${d.isDefault ? ' (default)' : ''} · WSL ${d.version}`;
}

function WslBackendRow({ bridge }: { bridge: DesktopBridge }) {
  const id = useId();
  const [status, setStatus] = useState<DesktopWslStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; tone: Tone } | null>(null);

  useEffect(() => {
    let live = true;
    void bridge.wslStatus?.().then(
      (s) => {
        if (live) setStatus(s);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [bridge]);

  const choose = async (value: string) => {
    if (!bridge.setWslDistro) return;
    setBusy(true);
    try {
      const result = await bridge.setWslDistro(value === '' ? null : value);
      setMessage({ text: result.message, tone: result.ok ? 'ok' : 'warn' });
      // A refusal keeps what is stored (and on show); a switch shows the new choice.
      if (result.ok) setStatus(result.status);
    } catch {
      setMessage({ text: 'The desktop app did not answer.', tone: 'warn' });
    } finally {
      setBusy(false);
    }
  };

  const distros = status?.distros.filter((d) => !d.system) ?? [];
  const selected = status?.selected ?? null;
  const options = [
    { value: '', label: 'This PC (Windows)' },
    ...distros.map((d) => ({ value: d.name, label: distroLabel(d) })),
    ...(selected !== null && !distros.some((d) => d.name === selected)
      ? [{ value: selected, label: `${selected} (not installed)` }]
      : []),
  ];

  return (
    <div data-testid={IDS.wslRow}>
      <SettingRow
        label="Where the backend runs"
        description="On this PC, or inside a WSL distro: there the daemon sees your Linux repositories with live updates (git over \\wsl$ is slow and cannot be watched). The distro needs the octopus-diff command, Node.js 24 and git; the app checks and tells you what is missing. Switching restarts the backend."
        htmlFor={id}
      >
        <div className="flex max-w-xs flex-col items-end text-right">
          {status === null ? (
            <p className="text-[11px] text-muted">Checking WSL…</p>
          ) : status.available ? (
            <select
              id={id}
              data-testid={IDS.wslPicker}
              aria-label="Where the backend runs"
              className="od-input"
              value={selected ?? ''}
              disabled={busy}
              onChange={(e) => void choose(e.target.value)}
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <p className="text-[11px] text-muted">
              {status.reason ?? 'WSL is not available.'} The backend runs on this PC.
            </p>
          )}
          {message && <Message testId={IDS.wslMessage} text={message.text} tone={message.tone} />}
        </div>
      </SettingRow>
    </div>
  );
}
