import type { ReactNode } from 'react';

/** A labelled row: label + description on the left, the control on the right. */
export function SettingRow({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 border-b border-line py-2.5 last:border-0">
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="block text-xs font-medium text-fg">
          {label}
        </label>
        {description && <p className="mt-0.5 text-[11px] text-muted">{description}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  id,
  label,
  testId,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  id?: string;
  label: string;
  testId?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-label={label}
      data-testid={testId}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${
        checked ? 'border-accent bg-accent' : 'border-line-strong bg-raised'
      }`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-3.5 w-3.5 rounded-full transition-transform ${
          checked ? 'translate-x-4 bg-accent-fg' : 'translate-x-0.5 bg-muted'
        }`}
      />
    </button>
  );
}

export function Select<T extends string>({
  value,
  onChange,
  options,
  id,
  label,
}: {
  value: T;
  onChange: (next: T) => void;
  options: readonly { value: T; label: string }[];
  id?: string;
  label: string;
}) {
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="od-input"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** Where a setting lives (COORDINATION §2.3). */
export function Where({ kind }: { kind: 'device' | 'daemon' }) {
  return (
    <span className="od-chip">
      {kind === 'device' ? 'Saved on this device' : 'Shared by the daemon'}
    </span>
  );
}

export function SmallButton({
  onClick,
  children,
  title,
  danger,
  disabled,
  testId,
}: {
  onClick: () => void;
  children: ReactNode;
  title?: string;
  danger?: boolean;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      disabled={disabled}
      data-testid={testId}
      className={`od-btn ${danger ? 'od-btn-danger' : ''}`}
    >
      {children}
    </button>
  );
}
