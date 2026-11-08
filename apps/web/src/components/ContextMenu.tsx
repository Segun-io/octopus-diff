import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon } from './bits.tsx';

export interface MenuItem {
  id: string;
  label: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Section heading (not selectable). */
  heading?: boolean;
  /** Draw a separator before this item. */
  separator?: boolean;
  /** Radio-like state shown at the right. */
  checked?: boolean;
  testId?: string;
  data?: Record<string, string>;
}

export interface MenuPosition {
  x: number;
  y: number;
}

/**
 * Right-click / "⋯" menu. Keyboard: arrows move, Enter/Space select, Escape closes, focus
 * returns to the opener. Positioned at the pointer, kept inside the viewport.
 */
export function ContextMenu({
  items,
  position,
  onClose,
  label,
  testId,
}: {
  items: MenuItem[];
  position: MenuPosition;
  onClose: () => void;
  label: string;
  testId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(position);
  const selectable = items.filter((i) => !i.heading && !i.disabled);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const el = ref.current;
    if (el) {
      const rect = el.getBoundingClientRect();
      const x = Math.min(position.x, window.innerWidth - rect.width - 8);
      const y = Math.min(position.y, window.innerHeight - rect.height - 8);
      setPos({ x: Math.max(4, x), y: Math.max(4, y) });
      el.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus();
    }
    const onDown = (e: MouseEvent) => {
      if (el && !el.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      previous?.focus?.();
    };
  }, [position, onClose]);

  const move = (delta: 1 | -1) => {
    const buttons = [
      ...(ref.current?.querySelectorAll<HTMLElement>(
        '[role^="menuitem"]:not([aria-disabled="true"])',
      ) ?? []),
    ];
    const index = buttons.indexOf(document.activeElement as HTMLElement);
    const next = buttons[(index + delta + buttons.length) % buttons.length];
    next?.focus();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      data-testid={testId}
      style={{ position: 'fixed', left: pos.x, top: pos.y }}
      className="od-overlay od-fade-in z-50 min-w-52 rounded-md p-1 text-xs"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onClose();
        } else if (e.key === 'ArrowDown') {
          e.preventDefault();
          move(1);
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          move(-1);
        }
      }}
    >
      {items.map((item) =>
        item.heading ? (
          <div key={item.id} className="od-heading px-2 pt-2 pb-1 first:pt-1">
            {item.label}
          </div>
        ) : (
          <button
            key={item.id}
            type="button"
            {...(item.checked === undefined
              ? { role: 'menuitem' as const }
              : { role: 'menuitemradio' as const, 'aria-checked': item.checked })}
            aria-disabled={item.disabled ? 'true' : undefined}
            data-testid={item.testId}
            {...item.data}
            onClick={() => {
              if (item.disabled) return;
              item.onSelect?.();
              onClose();
            }}
            className={`flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left ${
              item.separator ? 'mt-1 border-t border-line pt-1.5' : ''
            } ${
              item.disabled
                ? 'text-faint'
                : item.danger
                  ? 'text-danger hover:bg-del-soft'
                  : 'text-fg hover:bg-hover'
            } ${item.checked ? 'bg-selected' : ''}`}
          >
            <span className="flex-1">{item.label}</span>
            {item.checked && <CheckIcon className="shrink-0 text-fg" />}
          </button>
        ),
      )}
      {selectable.length === 0 && <p className="px-2 py-1 text-faint">Nothing to do here.</p>}
    </div>
  );
}

/** Tracks an open menu and its anchor position; use `open(event)` from contextmenu or a button. */
export function useContextMenu<T>() {
  const [state, setState] = useState<{ target: T; position: MenuPosition } | null>(null);
  const open = useCallback((event: React.MouseEvent | React.KeyboardEvent, target: T) => {
    event.preventDefault();
    event.stopPropagation();
    let position: MenuPosition;
    if ('clientX' in event && (event.clientX !== 0 || event.clientY !== 0)) {
      position = { x: event.clientX, y: event.clientY };
    } else {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      position = { x: rect.left, y: rect.bottom + 2 };
    }
    setState({ target, position });
  }, []);
  const close = useCallback(() => setState(null), []);
  return { state, open, close };
}
