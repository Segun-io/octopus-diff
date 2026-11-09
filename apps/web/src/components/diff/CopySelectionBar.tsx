/**
 * The floating Copy / Copy as Markdown bar shown after selecting diff lines in the gutter
 * (docs/COPY-TOOLS.md §4 step 3). It never takes focus (mousedown is prevented), so `j` / `k`
 * keep working; Esc and the close button dismiss it.
 *
 * Placement follows T3 Code's `resolveSelectionActionPosition` (MIT, Copyright (c) 2026 T3 Tools
 * Inc., apps/web/src/lib/selectionActions.ts): next to the pointer, kept inside the diff area.
 */
import type { SelectedLineRange } from '@pierre/diffs';
import { CheckIcon, CloseIcon, CopyIcon } from '../bits.tsx';
import { useCopyFeedback } from '../CopyButton.tsx';
import { COPY_TEST_IDS } from '../copyMenu.ts';

export type BarPlacement = { kind: 'pointer'; x: number; y: number } | { kind: 'docked' };

/** Where the bar goes inside `bounds` (wrapper-relative), preferring just below-right of the pointer. */
export function resolveBarPosition(options: {
  pointer: { x: number; y: number };
  bounds: { width: number; height: number };
  bar: { width: number; height: number };
}): { left: number; top: number } {
  const { pointer, bounds, bar } = options;
  const left = Math.max(8, Math.min(pointer.x + 8, bounds.width - bar.width - 8));
  const below = pointer.y + 12;
  const top = below + bar.height + 8 <= bounds.height ? below : pointer.y - bar.height - 12;
  return { left, top: Math.max(8, Math.min(top, bounds.height - bar.height - 8)) };
}

const BAR_SIZE = { width: 260, height: 30 };

export function CopySelectionBar({
  range,
  lines,
  placement,
  bounds,
  getText,
  escaped,
  onDismiss,
}: {
  range: SelectedLineRange;
  lines: number;
  placement: BarPlacement;
  bounds: { width: number; height: number };
  getText: (format: 'plain' | 'markdown') => string | null;
  escaped: boolean;
  onDismiss: () => void;
}) {
  const plain = useCopyFeedback();
  const markdown = useCopyFeedback();
  const style =
    placement.kind === 'pointer'
      ? resolveBarPosition({ pointer: placement, bounds, bar: BAR_SIZE })
      : { right: 16, bottom: 16 };
  const run = (format: 'plain' | 'markdown', target: HTMLElement) => {
    const text = getText(format);
    if (text === null) return;
    const rect = target.getBoundingClientRect();
    const feedback = format === 'plain' ? plain : markdown;
    void feedback.copy(text, {
      what: `${lines} ${lines === 1 ? 'line' : 'lines'}${format === 'markdown' ? ' as Markdown' : ''}`,
      escaped,
      at: { x: rect.left + rect.width / 2, y: rect.top },
    });
  };
  return (
    <div
      role="toolbar"
      aria-label="Copy selected lines"
      data-testid={COPY_TEST_IDS.selectionBar}
      data-start={range.start}
      data-end={range.end}
      data-side={range.side ?? ''}
      data-end-side={range.endSide ?? range.side ?? ''}
      data-lines={lines}
      onMouseDown={(e) => e.preventDefault()}
      style={{ position: 'absolute', zIndex: 30, ...style }}
      className="od-overlay od-fade-in flex items-center gap-0.5 rounded-md p-0.5 text-xs"
    >
      <span className="px-1.5 text-[11px] text-muted tabular-nums">
        {lines} {lines === 1 ? 'line' : 'lines'}
      </span>
      <button
        type="button"
        tabIndex={-1}
        data-testid={COPY_TEST_IDS.selectionCopy}
        data-copied={plain.copied ? 'true' : undefined}
        title="Copy the selected code (Ctrl/⌘ C)"
        onClick={(e) => run('plain', e.currentTarget)}
        className={`od-btn od-btn-ghost gap-1 ${plain.copied ? 'text-add' : 'text-fg'}`}
      >
        {plain.copied ? <CheckIcon /> : <CopyIcon size={12} />}
        {plain.copied ? 'Copied' : 'Copy'}
      </button>
      <button
        type="button"
        tabIndex={-1}
        data-testid={COPY_TEST_IDS.selectionMarkdown}
        data-copied={markdown.copied ? 'true' : undefined}
        title="Copy as Markdown, with the file, lines, branch and worktree"
        onClick={(e) => run('markdown', e.currentTarget)}
        className={`od-btn od-btn-ghost gap-1 ${markdown.copied ? 'text-add' : 'text-fg'}`}
      >
        {markdown.copied ? <CheckIcon /> : <CopyIcon size={12} />}
        {markdown.copied ? 'Copied' : 'Copy as Markdown'}
      </button>
      <button
        type="button"
        tabIndex={-1}
        aria-label="Clear the selection (Esc)"
        title="Clear the selection (Esc)"
        onClick={onDismiss}
        className="od-btn od-btn-ghost text-muted"
      >
        <CloseIcon size={12} />
      </button>
    </div>
  );
}
