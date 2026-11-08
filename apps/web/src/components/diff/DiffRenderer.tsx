/**
 * Renders a raw unified patch with @pierre/diffs (lazy-loaded chunk: shiki and the diff
 * renderer are not needed for the first paint).
 */
import { type FileDiffMetadata, parsePatchFiles } from '@pierre/diffs';
import { FileDiff, Virtualizer } from '@pierre/diffs/react';
import { memo, useEffect, useMemo, useRef } from 'react';
import { DIFF_THEMES, DiffWorkerPoolProvider } from './DiffWorkerPool.tsx';

export interface DiffRendererProps {
  patch: string;
  /** Prefix for worker-pool cache keys (patchHash + view options). */
  cacheKey: string;
  mode: 'split' | 'unified';
  theme: 'light' | 'dark';
  /** Shiki theme name from the active app theme (`ThemeDefinition.diff.theme`). */
  diffTheme?: string;
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
}: DiffRendererProps) {
  const files = useMemo(() => parse(patch, cacheKey), [patch, cacheKey]);
  const wrapper = useRef<HTMLDivElement>(null);
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
      theme: diffTheme ? { dark: diffTheme, light: diffTheme } : DIFF_THEMES,
      themeType: theme,
      hunkSeparators: 'line-info' as const,
      lineDiffType: 'word-alt' as const,
      overflow: 'scroll' as const,
      disableFileHeader: true,
      tokenizeMaxLineLength: 1000,
      unsafeCSS: UNSAFE_CSS,
    }),
    [mode, theme, diffTheme],
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
      <div ref={wrapper} className="h-full">
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
              options={{ ...options, disableFileHeader: files.length === 1 }}
            />
          ))}
        </Virtualizer>
      </div>
    </DiffWorkerPoolProvider>
  );
});
