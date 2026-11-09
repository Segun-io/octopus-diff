/**
 * Renders a raw unified patch with @pierre/diffs (lazy-loaded chunk: shiki and the diff
 * renderer are not needed for the first paint).
 *
 * Line selection (docs/COPY-TOOLS.md §4 step 3): press on a line number (or the gutter's copy
 * button) and drag; the Copy bar appears where the pointer was released. Esc, the bar's close
 * button or another file clears it; a new patch (`cacheKey`) drops it, since its line numbers may
 * no longer match what the reader saw. Ctrl/⌘ C with a line selection and no text selection
 * copies the selected code.
 */
import { type FileDiffMetadata, parsePatchFiles, type SelectedLineRange } from '@pierre/diffs';
import { FileDiff, Virtualizer } from '@pierre/diffs/react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildSelectionCopy,
  type SelectionCopyMeta,
  selectedDiffLines,
} from '../../lib/copyFormat.ts';
import { copyAndReport } from '../../state/copy.ts';
import { useUiStore } from '../../state/ui.tsx';
import { type BarPlacement, CopySelectionBar } from './CopySelectionBar.tsx';
import { DIFF_THEMES, DiffWorkerPoolProvider } from './DiffWorkerPool.tsx';

export interface DiffRendererProps {
  patch: string;
  /** Prefix for worker-pool cache keys (patchHash + view options). */
  cacheKey: string;
  mode: 'split' | 'unified';
  theme: 'light' | 'dark';
  /** Shiki theme name from the active app theme (`ThemeDefinition.diff.theme`). */
  diffTheme?: string;
  /** Where the code lives, for "Copy as Markdown"; without it line selection is off. */
  copyMeta?: SelectionCopyMeta;
  /** The patch had invisible / bidirectional characters (copies carry the ⟨U+…⟩ escapes). */
  suspicious?: boolean;
}

interface LineSelection {
  /** Which FileDiff of the patch (a typechange has two). */
  index: number;
  range: SelectedLineRange;
}

/**
 * True when the user has a non-empty text selection (then Ctrl/⌘ C keeps its native meaning).
 * A selection inside the diff's shadow root is retargeted: `isCollapsed` is true there, but
 * `type` and `toString()` still report it (DECISIONS #106).
 */
function hasTextSelection(): boolean {
  const selection = document.getSelection();
  return selection !== null && selection.type === 'Range' && selection.toString() !== '';
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))
  );
}

/** Overrides so the diff surface follows the app palette. */
const UNSAFE_CSS = `
:host, [data-diff], [data-file] {
  --diffs-font-family: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
  --diffs-font-size: 12px;
  --diffs-line-height: 19px;
}
`;

function parse(patch: string, cacheKey: string): FileDiffMetadata[] | null {
  try {
    return parsePatchFiles(patch, { cacheKeyPrefix: cacheKey }).flatMap((p) => p.files);
  } catch {
    return null;
  }
}

export const DiffRenderer = memo(function DiffRenderer({
  patch,
  cacheKey,
  mode,
  theme,
  diffTheme,
  copyMeta,
  suspicious = false,
}: DiffRendererProps) {
  const files = useMemo(() => parse(patch, cacheKey), [patch, cacheKey]);
  const wrapper = useRef<HTMLDivElement>(null);
  const store = useUiStore();
  const selectable = copyMeta !== undefined;

  // --- line selection ------------------------------------------------------------------------
  const [selection, setSelection] = useState<LineSelection | null>(null);
  const [placement, setPlacement] = useState<BarPlacement | null>(null);
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  // A new patch drops the selection (reset during render, not in an effect).
  const [selectionKey, setSelectionKey] = useState(cacheKey);
  if (selectionKey !== cacheKey) {
    setSelectionKey(cacheKey);
    setSelection(null);
    setPlacement(null);
  }
  const lastPointer = useRef<{ x: number; y: number } | null>(null);
  const clear = useCallback(() => {
    setSelection(null);
    setPlacement(null);
  }, []);
  const showBar = useCallback(() => {
    const el = wrapper.current;
    const pointer = lastPointer.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setBounds({ width: rect.width, height: rect.height });
    setPlacement(
      pointer
        ? { kind: 'pointer', x: pointer.x - rect.left, y: pointer.y - rect.top }
        : { kind: 'docked' },
    );
  }, []);
  // Stable callbacks for the per-file options (new functions would re-render every diff).
  const handlers = useRef({
    change: (_index: number, _range: SelectedLineRange | null) => {},
    end: (_index: number, _range: SelectedLineRange | null) => {},
  });
  handlers.current = {
    change: (index, range) => {
      if (range) {
        // The last gesture wins: a line selection replaces an earlier text selection.
        if (hasTextSelection()) document.getSelection()?.removeAllRanges();
        setSelection({ index, range });
      }
      setPlacement(null);
    },
    end: (index, range) => {
      if (!range) return clear();
      setSelection({ index, range });
      showBar();
    },
  };

  const copyMetaRef = useRef(copyMeta);
  copyMetaRef.current = copyMeta;
  const selectionText = useCallback(
    (format: 'plain' | 'markdown', current: LineSelection | null = selection) => {
      const meta = copyMetaRef.current;
      const fileDiff = current ? files?.[current.index] : undefined;
      if (!current || !fileDiff || !meta) return null;
      return (
        buildSelectionCopy({ fileDiff, range: current.range, mode, meta, format })?.text ?? null
      );
    },
    [files, mode, selection],
  );
  const lineCount = useMemo(() => {
    const fileDiff = selection ? files?.[selection.index] : undefined;
    return selection && fileDiff ? selectedDiffLines(fileDiff, selection.range, mode).length : 0;
  }, [files, selection, mode]);

  // Pointer position for the bar; capture phase so it is recorded before the library's handlers.
  useEffect(() => {
    if (!selectable) return;
    const record = (e: PointerEvent) => {
      lastPointer.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('pointerdown', record, true);
    window.addEventListener('pointerup', record, true);
    return () => {
      window.removeEventListener('pointerdown', record, true);
      window.removeEventListener('pointerup', record, true);
    };
  }, [selectable]);

  // Esc clears; Ctrl/⌘ C with no text selection copies the selected lines as plain code; a
  // scroll docks the bar in the corner (its pointer position no longer points at the lines).
  useEffect(() => {
    if (!selection) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clear();
        return;
      }
      const copyKey =
        (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c';
      if (!copyKey || isEditable(e.target) || hasTextSelection()) return;
      const text = selectionText('plain', selection);
      if (text === null) return;
      e.preventDefault();
      void copyAndReport(store, text, {
        what: `${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`,
        escaped: suspicious,
      });
    };
    const scroller = wrapper.current?.firstElementChild;
    const onScroll = () =>
      setPlacement((p) => (p && p.kind === 'pointer' ? { kind: 'docked' } : p));
    document.addEventListener('keydown', onKey);
    scroller?.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      document.removeEventListener('keydown', onKey);
      scroller?.removeEventListener('scroll', onScroll);
    };
  }, [selection, selectionText, clear, store, lineCount, suspicious]);

  // The virtualizer owns its scroll element; make it keyboard-focusable and findable for the
  // Space / d / u scroll shortcuts.
  useEffect(() => {
    const scroller = wrapper.current?.firstElementChild;
    if (!(scroller instanceof HTMLElement)) return;
    scroller.tabIndex = 0;
    scroller.setAttribute('data-diff-scroller', '');
    scroller.setAttribute('role', 'region');
    scroller.setAttribute('aria-label', 'Diff content');
  });
  const options = useMemo(
    () => ({
      diffStyle: mode,
      // A press on a line number (or the gutter button) selects lines; a drag on the code still
      // selects text natively.
      enableLineSelection: selectable,
      enableGutterUtility: selectable,
      theme: diffTheme ? { dark: diffTheme, light: diffTheme } : DIFF_THEMES,
      themeType: theme,
      hunkSeparators: 'line-info' as const,
      lineDiffType: 'word-alt' as const,
      overflow: 'scroll' as const,
      disableFileHeader: true,
      tokenizeMaxLineLength: 1000,
      unsafeCSS: UNSAFE_CSS,
    }),
    [mode, theme, diffTheme, selectable],
  );
  const fileOptions = useMemo(
    () =>
      (files ?? []).map((_, index) => ({
        ...options,
        disableFileHeader: (files?.length ?? 0) === 1,
        ...(selectable
          ? {
              onLineSelectionChange: (range: SelectedLineRange | null) =>
                handlers.current.change(index, range),
              onLineSelectionEnd: (range: SelectedLineRange | null) =>
                handlers.current.end(index, range),
              onGutterUtilityClick: (range: SelectedLineRange) =>
                handlers.current.end(index, range),
            }
          : {}),
      })),
    [files, options, selectable],
  );

  if (!files || files.length === 0) {
    return (
      <pre className="od-scroll h-full overflow-auto p-3 font-mono text-xs whitespace-pre">
        {patch}
      </pre>
    );
  }

  return (
    <DiffWorkerPoolProvider>
      <div
        ref={wrapper}
        className="relative h-full"
        data-line-selection={
          selection
            ? `${selection.range.side ?? ''}:${selection.range.start}-${selection.range.endSide ?? selection.range.side ?? ''}:${selection.range.end}`
            : ''
        }
      >
        <Virtualizer
          className="od-scroll h-full overflow-auto"
          contentClassName="flex flex-col gap-3 pb-8"
        >
          {files.map((file, index) => (
            <FileDiff
              // Typechanges produce two sections (delete + add) for the same path, so the
              // position is part of the identity; the list never reorders.
              // biome-ignore lint/suspicious/noArrayIndexKey: stable order, duplicate names possible
              key={`${index}:${file.prevName ?? ''}:${file.name}`}
              fileDiff={file}
              options={fileOptions[index]}
              {...(selectable
                ? { selectedLines: selection?.index === index ? selection.range : null }
                : {})}
            />
          ))}
        </Virtualizer>
        {selection && placement && lineCount > 0 && (
          <CopySelectionBar
            range={selection.range}
            lines={lineCount}
            placement={placement}
            bounds={bounds}
            getText={(format) => selectionText(format)}
            escaped={suspicious}
            onDismiss={clear}
          />
        )}
      </div>
    </DiffWorkerPoolProvider>
  );
});
