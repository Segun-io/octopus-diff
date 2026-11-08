import { TEST_IDS } from '@octopus-diff/contracts';
import { useCallback, useEffect, useId, useRef } from 'react';
import { useHealthQuery, useSettingsSupport } from '../../api/settings.ts';
import { useEscapeToClose } from '../../lib/useEscape.ts';
import {
  APPEARANCE_ITEMS,
  GENERAL_ITEMS,
  type PrefItem,
  SETTINGS_SECTIONS,
  type SettingsSectionId,
} from '../../settings/registry.ts';
import { COMMANDS, GROUP_LABELS, SHORTCUTS } from '../../state/commandRegistry.ts';
import type { Prefs } from '../../state/prefs.ts';
import { actions, useUi, useUiStore } from '../../state/ui.tsx';
import { selectTheme, THEMES } from '../../theme/registry.ts';
import { useTheme } from '../../theme/useTheme.ts';
import { CloseIcon } from '../bits.tsx';
import { Mark, Wordmark } from '../Mark.tsx';
import { Select, SettingRow, Switch, Where } from './controls.tsx';
import { FoldersSection } from './FoldersSection.tsx';
import { ReviewSection } from './ReviewSection.tsx';

/** Settings screen: section nav on the left, one panel on the right. Opened with `,`. */
export function SettingsDialog() {
  const store = useUiStore();
  const section = useUi((s) => s.settingsSection);
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[data-section][aria-current="true"]')?.focus();
    return () => previous?.focus?.();
  }, []);

  const close = useCallback(() => store.setState({ settingsOpen: false }), [store]);
  useEscapeToClose(true, close);
  const setSection = (id: SettingsSectionId) => store.setState({ settingsSection: id });

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'Tab' || !ref.current) return;
    const focusable = [
      ...ref.current.querySelectorAll<HTMLElement>(
        'input, button, select, textarea, a[href], [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((el) => !el.hasAttribute('disabled'));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onNavKey = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = SETTINGS_SECTIONS.findIndex((s) => s.id === section);
    const next =
      SETTINGS_SECTIONS[
        (index + (event.key === 'ArrowDown' ? 1 : -1) + SETTINGS_SECTIONS.length) %
          SETTINGS_SECTIONS.length
      ];
    if (next) {
      setSection(next.id);
      ref.current?.querySelector<HTMLElement>(`[data-section="${next.id}"]`)?.focus();
    }
  };

  const current = SETTINGS_SECTIONS.find((s) => s.id === section) ?? SETTINGS_SECTIONS[0];

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes the dialog
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on the dialog itself
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[8vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={TEST_IDS.settingsDialog}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="od-overlay od-fade-in flex h-[min(640px,84vh)] w-[min(860px,94vw)] overflow-hidden rounded-lg"
      >
        <nav
          aria-label="Settings sections"
          className="flex w-44 shrink-0 flex-col border-r border-line bg-surface p-2"
          onKeyDown={onNavKey}
        >
          <h2 id={titleId} className="px-2 pt-1 pb-2 text-sm font-semibold">
            Settings
          </h2>
          {SETTINGS_SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              data-testid={TEST_IDS.settingsSection}
              data-section={s.id}
              aria-current={s.id === section ? 'true' : undefined}
              onClick={() => setSection(s.id)}
              className={`rounded-md px-2 py-1.5 text-left text-xs ${
                s.id === section
                  ? 'bg-selected font-medium text-fg'
                  : 'text-muted hover:bg-hover hover:text-fg'
              }`}
            >
              {s.label}
            </button>
          ))}
          <div className="mt-auto px-2 pb-1 text-[10px] text-faint">
            <kbd>,</kbd> opens · <kbd>Esc</kbd> closes
          </div>
        </nav>
        <div className="od-scroll min-w-0 flex-1 overflow-y-auto bg-overlay p-5">
          <div className="mb-3 flex items-center">
            <div>
              <h3 className="text-sm font-semibold">{current?.label}</h3>
              <p className="text-[11px] text-muted">{current?.description}</p>
            </div>
            <button
              type="button"
              onClick={close}
              aria-label="Close settings"
              className="ml-auto flex items-center rounded-md p-1 text-muted hover:bg-hover hover:text-fg"
            >
              <CloseIcon />
            </button>
          </div>
          {section === 'general' && <PrefsPanel items={GENERAL_ITEMS} />}
          {section === 'review' && <ReviewSection />}
          {section === 'appearance' && <AppearancePanel />}
          {section === 'folders' && <FoldersSection />}
          {section === 'keyboard' && <KeyboardPanel />}
          {section === 'about' && <AboutPanel />}
        </div>
      </div>
    </div>
  );
}

function PrefsPanel({ items }: { items: readonly PrefItem[] }) {
  return (
    <div>
      <Where kind="device" />
      <div className="mt-2">
        {items.map((item) => (
          <PrefControl key={item.key} item={item} />
        ))}
      </div>
    </div>
  );
}

function PrefControl({ item }: { item: PrefItem }) {
  const store = useUiStore();
  const value = useUi((s) => s[item.key]);
  const id = useId();
  if (item.kind === 'toggle') {
    return (
      <SettingRow label={item.label} description={item.description} htmlFor={id}>
        <Switch
          id={id}
          label={item.label}
          checked={value === true}
          onChange={(next) => store.setState({ [item.key]: next } as Partial<Prefs>)}
        />
      </SettingRow>
    );
  }
  return (
    <SettingRow label={item.label} description={item.description} htmlFor={id}>
      <Select
        id={id}
        label={item.label}
        value={String(value)}
        options={item.options}
        onChange={(next) => store.setState({ [item.key]: next } as Partial<Prefs>)}
      />
    </SettingRow>
  );
}

function AppearancePanel() {
  const store = useUiStore();
  const prefs = useUi((s) => s.theme);
  const active = useTheme();
  const modeId = useId();
  return (
    <div>
      <Where kind="device" />
      <SettingRow
        label="Mode"
        description="System follows the OS; t toggles between light and dark."
        htmlFor={modeId}
      >
        <Select
          id={modeId}
          label="Theme mode"
          value={prefs.mode}
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          onChange={(mode) => store.setState({ theme: { ...prefs, mode } })}
        />
      </SettingRow>
      <div className="py-2.5">
        <p className="text-xs font-medium">Theme</p>
        <p className="mt-0.5 text-[11px] text-muted">
          One light and one dark slot; picking a theme switches to it.
        </p>
        <fieldset
          data-testid={TEST_IDS.themePicker}
          aria-label="Theme"
          className="mt-2 grid grid-cols-3 gap-2 border-0 p-0"
        >
          {THEMES.map((theme) => {
            const inSlot = prefs[theme.kind] === theme.id;
            const isActive = active.id === theme.id;
            return (
              <button
                key={theme.id}
                type="button"
                aria-pressed={isActive}
                data-testid={TEST_IDS.themeOption}
                data-theme-id={theme.id}
                onClick={() => store.setState({ theme: selectTheme(prefs, theme.id) })}
                className={`rounded-md border p-2 text-left ${
                  isActive
                    ? 'border-accent bg-accent-soft'
                    : inSlot
                      ? 'border-line-strong'
                      : 'border-line hover:bg-hover'
                }`}
              >
                <div
                  className="flex h-10 items-end gap-1 rounded-sm border p-1"
                  style={{ background: theme.colors.canvas, borderColor: theme.colors.line }}
                  aria-hidden="true"
                >
                  <span
                    className="h-6 w-6 rounded-sm"
                    style={{ background: theme.colors.surface }}
                  />
                  <span
                    className="h-4 flex-1 rounded-sm"
                    style={{ background: theme.colors.selected }}
                  />
                  <span
                    className="h-2 w-4 rounded-sm"
                    style={{ background: theme.colors.accent }}
                  />
                  <span className="h-2 w-2 rounded-sm" style={{ background: theme.colors.add }} />
                  <span className="h-2 w-2 rounded-sm" style={{ background: theme.colors.del }} />
                </div>
                <div className="mt-1.5 text-xs font-medium">{theme.label}</div>
                <div className="text-[10px] text-muted">
                  {theme.kind} · {inSlot ? 'in slot' : theme.description}
                </div>
              </button>
            );
          })}
        </fieldset>
      </div>
      {APPEARANCE_ITEMS.map((item) => (
        <PrefControl key={item.key} item={item} />
      ))}
    </div>
  );
}

function KeyboardPanel() {
  const groups = Array.from(new Set(COMMANDS.map((c) => c.group)));
  return (
    <div>
      <p className="text-[11px] text-muted">
        Generated from the command registry. Shortcuts never fire while typing. Rebinding is a later
        round.
      </p>
      {groups.map((group) => {
        const rows = SHORTCUTS.filter((s) => COMMANDS.find((c) => c.id === s.id)?.group === group);
        if (rows.length === 0) return null;
        return (
          <section key={group} className="mt-3">
            <h4 className="od-heading mb-1">{GROUP_LABELS[group]}</h4>
            <table className="w-full text-xs">
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id} className="border-b border-line last:border-0">
                    <td className="w-40 py-1 pr-4 whitespace-nowrap">
                      {s.keys.map((k, i) => (
                        <span key={k}>
                          {i > 0 && (
                            <span className="px-1 text-faint">{s.chord ? 'then' : '/'}</span>
                          )}
                          <kbd>{k}</kbd>
                        </span>
                      ))}
                    </td>
                    <td className="py-1 text-muted">{s.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      })}
    </div>
  );
}

function AboutPanel() {
  const health = useHealthQuery();
  const support = useSettingsSupport();
  const h = health.data;
  return (
    <div className="text-xs">
      <div className="mb-4 flex items-center gap-3">
        <Mark size={40} className="text-accent" />
        <div>
          <Wordmark size={18} />
          <p className="mt-0.5 text-[11px] text-muted">
            Read-only, diff-first git UI for many projects and worktrees.
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-[140px_1fr] gap-y-1.5">
        <dt className="text-muted">Daemon version</dt>
        <dd className="font-mono">{h ? h.version : health.isError ? 'unreachable' : '…'}</dd>
        <dt className="text-muted">API version</dt>
        <dd className="font-mono">{h ? h.apiVersion : '…'}</dd>
        <dt className="text-muted">git</dt>
        <dd className="font-mono">
          {h ? `${h.git.version ?? 'not found'}${h.git.supported ? '' : ' (unsupported)'}` : '…'}
        </dd>
        <dt className="text-muted">Watcher</dt>
        <dd>
          <span className="font-mono">{h ? h.watcher.mode : '…'}</span>
          {h && h.watcher.warnings.length > 0 && (
            <ul className="mt-1 text-warn">
              {h.watcher.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
        </dd>
        <dt className="text-muted">Uptime</dt>
        <dd className="font-mono">{h ? formatUptime(h.uptimeMs) : '…'}</dd>
        <dt className="text-muted">Settings API</dt>
        <dd>
          {support === 'ready'
            ? 'available'
            : support === 'loading'
              ? '…'
              : 'not available on this daemon (review policy and bulk marks are hidden)'}
        </dd>
      </dl>
      <p className="mt-4 text-[11px] text-faint">
        Everything octopus-diff does to a repository is a read. Marks and settings live in the
        daemon's own state directory. Design notes: docs/design/.
      </p>
    </div>
  );
}

function formatUptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const hrs = Math.floor(m / 60);
  return `${hrs}h ${m % 60}m`;
}

export { actions };
