import { TEST_IDS } from '@octopus-diff/contracts';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useSettingsSupport } from '../api/settings.ts';
import { rankBy } from '../lib/fuzzy.ts';
import { DIRECT_FOLDER_ID, worktreeLabel } from '../lib/model.ts';
import { SETTINGS_SECTIONS } from '../settings/registry.ts';
import { COMMANDS, GROUP_LABELS } from '../state/commandRegistry.ts';
import { useCommandsContext } from '../state/commandsContext.tsx';
import { useAppModel } from '../state/model.tsx';
import { actions, useUiStore } from '../state/ui.tsx';
import { selectTheme, THEMES } from '../theme/registry.ts';

interface PaletteItem {
  id: string;
  kind: 'go' | 'command' | 'settings' | 'theme' | 'review';
  label: string;
  hint?: string | undefined;
  keys?: string[] | undefined;
  run: () => void;
}

/**
 * Command palette (Ctrl/Cmd+K): jump to any folder / project / worktree, run any registered
 * command, open a Settings section, switch theme, mark all. Fuzzy, keyboard-only usable.
 */
export function CommandPalette() {
  const store = useUiStore();
  const model = useAppModel();
  const commands = useCommandsContext();
  const support = useSettingsSupport();
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const close = () => store.setState({ paletteOpen: false });

  const items = useMemo<PaletteItem[]>(() => {
    const out: PaletteItem[] = [];
    out.push({
      id: 'go:inbox',
      kind: 'go',
      label: 'Inbox',
      hint: `${model.inboxEntries.length} dirty worktrees`,
      run: () => actions.setView(store, { kind: 'inbox' }),
    });
    for (const node of model.sidebar.folders) {
      out.push({
        id: `go:folder:${node.id}`,
        kind: 'go',
        label: node.id === DIRECT_FOLDER_ID ? 'Added directly' : `Folder ${node.label}`,
        hint: `${node.stats.projects} repos · ${node.stats.dirty} dirty`,
        run: () => actions.setView(store, { kind: 'folder', scanRootId: node.id }),
      });
      for (const group of node.groups) {
        out.push({
          id: `go:project:${group.project.id}`,
          kind: 'go',
          label: `Project ${group.project.name}`,
          hint: `${group.allRows.length} worktrees`,
          run: () => actions.setView(store, { kind: 'project', projectId: group.project.id }),
        });
        for (const row of group.allRows) {
          out.push({
            id: `go:worktree:${row.worktree.id}`,
            kind: 'go',
            label: `${group.project.name} · ${worktreeLabel(row.worktree)}`,
            hint: row.unreviewed > 0 ? `${row.unreviewed} unreviewed` : row.worktree.path,
            run: () => actions.setView(store, { kind: 'worktree', worktreeId: row.worktree.id }),
          });
        }
      }
    }
    for (const c of COMMANDS) {
      if (c.hideInPalette) continue;
      if ((c.id === 'markAllVerified' || c.id === 'markAllUnreviewed') && support !== 'ready') {
        continue;
      }
      out.push({
        id: `cmd:${c.id}`,
        kind: c.group === 'review' ? 'review' : 'command',
        label: c.label,
        hint: GROUP_LABELS[c.group],
        keys: c.keys.length ? c.keys : undefined,
        run: () => c.run(commands),
      });
    }
    for (const s of SETTINGS_SECTIONS) {
      out.push({
        id: `settings:${s.id}`,
        kind: 'settings',
        label: `Settings: ${s.label}`,
        hint: s.description,
        run: () => actions.openSettings(store, s.id),
      });
    }
    for (const t of THEMES) {
      out.push({
        id: `theme:${t.id}`,
        kind: 'theme',
        label: `Theme: ${t.label}`,
        hint: t.kind,
        run: () => store.setState((s) => ({ theme: selectTheme(s.theme, t.id) })),
      });
    }
    return out;
  }, [model.sidebar.folders, model.inboxEntries.length, store, commands, support]);

  const results = useMemo(
    () => rankBy(query, items, (i) => `${i.label} ${i.hint ?? ''}`, 40),
    [query, items],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset the cursor when results change
  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previous?.focus?.();
  }, []);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    close();
    item.run();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes the palette
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled on the input
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        data-testid={TEST_IDS.commandPalette}
        className="od-overlay od-fade-in flex max-h-[64vh] w-[min(600px,92vw)] flex-col overflow-hidden rounded-lg"
      >
        <input
          ref={inputRef}
          data-testid={TEST_IDS.commandPaletteInput}
          role="combobox"
          aria-expanded="true"
          aria-controls={listId}
          aria-activedescendant={results[index] ? `${listId}-${index}` : undefined}
          aria-autocomplete="list"
          placeholder="Go to a worktree, run a command, open settings…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(results.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              run(results[index]?.item);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
          className="border-b border-line bg-transparent px-4 py-3 text-sm outline-none placeholder:text-faint"
        />
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Results"
          className="od-scroll min-h-0 flex-1 overflow-y-auto p-1"
        >
          {results.length === 0 && (
            <p className="px-3 py-4 text-center text-xs text-muted">Nothing matches.</p>
          )}
          {results.map(({ item }, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard handled by the combobox
            <div
              key={item.id}
              id={`${listId}-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === index}
              data-testid={TEST_IDS.commandPaletteItem}
              data-id={item.id}
              data-kind={item.kind}
              data-index={i}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(item)}
              className={`flex cursor-pointer items-center gap-3 rounded-md px-3 py-1.5 text-xs ${
                i === index ? 'bg-selected' : 'hover:bg-hover'
              }`}
            >
              <span className="w-14 shrink-0 text-[10px] tracking-wide text-faint uppercase">
                {item.kind === 'go' ? 'go to' : item.kind}
              </span>
              <span className="min-w-0 flex-1 truncate">{item.label}</span>
              {item.hint && (
                <span className="max-w-56 truncate text-[11px] text-faint">{item.hint}</span>
              )}
              {item.keys && (
                <span className="shrink-0">
                  {item.keys.map((k) => (
                    <kbd key={k} className="ml-1">
                      {k}
                    </kbd>
                  ))}
                </span>
              )}
            </div>
          ))}
        </div>
        <div className="flex gap-3 border-t border-line px-3 py-1.5 text-[10px] text-faint">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> run
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
