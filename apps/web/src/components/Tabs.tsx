import type { KeyboardEvent, ReactNode } from 'react';
import { useRef } from 'react';

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  /** Shown after the label in `faint` tabular figures. */
  count?: number | null;
  /** Accessible name when the label alone is ambiguous. */
  ariaLabel?: string;
}

/**
 * A segmented tab list (`.od-seg`) with the WAI-ARIA tabs keyboard model: one tab stop for the
 * whole list (roving `tabIndex`), ←/→ move and select (automatic activation), Home/End jump.
 * Each tab controls the panel `${idPrefix}-panel-${id}`; render that panel with `tabPanelProps`.
 */
export function SegmentedTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
  testId,
}: {
  tabs: ReadonlyArray<TabItem<T>>;
  value: T;
  onChange: (id: T) => void;
  label: string;
  idPrefix: string;
  /** `data-testid` on every tab (each also gets `data-tab`). */
  testId?: string;
}) {
  const refs = useRef(new Map<T, HTMLButtonElement>());
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    if (next === null) return;
    event.preventDefault();
    const tab = tabs[next];
    if (!tab) return;
    onChange(tab.id);
    refs.current.get(tab.id)?.focus();
  };
  return (
    <span className="od-seg" role="tablist" aria-label={label}>
      {tabs.map((t, index) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              if (el) refs.current.set(t.id, el);
              else refs.current.delete(t.id);
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${t.id}`}
            aria-controls={`${idPrefix}-panel-${t.id}`}
            aria-selected={selected}
            aria-label={t.ariaLabel}
            tabIndex={selected ? 0 : -1}
            data-testid={testId}
            data-tab={t.id}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, index)}
          >
            {t.label}
            {t.count !== undefined && t.count !== null && (
              <span className="text-faint tabular-nums">{t.count}</span>
            )}
          </button>
        );
      })}
    </span>
  );
}

/** Props for the panel a `SegmentedTabs` tab controls. */
export function tabPanelProps(idPrefix: string, id: string) {
  return {
    role: 'tabpanel' as const,
    id: `${idPrefix}-panel-${id}`,
    'aria-labelledby': `${idPrefix}-tab-${id}`,
  };
}
