/**
 * Context-line constants and helpers, in a leaf module: `commandRegistry.ts` needs `CONTEXT_STEP`
 * at module evaluation time, and importing it from `commands.ts` closed an import cycle that broke
 * `pnpm dev:mock` ("Cannot access 'CONTEXT_STEP' before initialization").
 */
import { DIFF_CONTEXT_MAX } from '@octopus-diff/contracts';

export const CONTEXT_STEP = 20;
export const DEFAULT_CONTEXT = 3;
/**
 * "Expand all": the API's maximum (`-U1000000`), which shows every line of any realistic file.
 * Nothing ever asks for more: the API rejects larger values ("expected number to be <= 1000000").
 */
export const FULL_CONTEXT = DIFF_CONTEXT_MAX;

/** Clamps a context value to what the API accepts (0…FULL_CONTEXT, an integer). */
export function clampContext(context: number): number {
  if (!Number.isFinite(context)) return context > 0 ? FULL_CONTEXT : 0;
  return Math.min(FULL_CONTEXT, Math.max(0, Math.round(context)));
}

/** The context after one "More context" step, never above the API's maximum. */
export function nextContext(current: number | undefined): number {
  return clampContext((current ?? DEFAULT_CONTEXT) + CONTEXT_STEP);
}

export function isFullContext(context: number | undefined): boolean {
  return (context ?? DEFAULT_CONTEXT) >= FULL_CONTEXT;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * True when a unified patch fetched with `context` lines already shows every line of the file, so
 * more context cannot change it. Each file section must have at most one hunk that starts at the
 * first line and ends with fewer trailing context lines than asked for (it reached the end of the
 * file). Added and deleted files are whole by definition. A patch without hunks (binary, mode
 * only) is not "whole": there is nothing to expand, and callers hide the controls for it.
 */
export function patchShowsWholeFile(patch: string, context: number): boolean {
  let hunks = 0;
  let anyHunk = false;
  let sawHunk = false;
  let whole = true;
  let trailing = 0;
  let oneSided = false;
  const closeSection = () => {
    if (!sawHunk) return;
    if (hunks > 1) whole = false;
    else if (!oneSided && trailing >= context) whole = false;
  };
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      closeSection();
      hunks = 0;
      sawHunk = false;
      trailing = 0;
      oneSided = false;
      continue;
    }
    const header = HUNK_HEADER.exec(line);
    if (header) {
      sawHunk = true;
      anyHunk = true;
      hunks += 1;
      trailing = 0;
      const oldStart = Number(header[1]);
      const oldCount = header[2] === undefined ? 1 : Number(header[2]);
      const newStart = Number(header[3]);
      const newCount = header[4] === undefined ? 1 : Number(header[4]);
      oneSided = oldCount === 0 || newCount === 0;
      if (!oneSided && (oldStart > 1 || newStart > 1)) whole = false;
      continue;
    }
    if (!sawHunk) continue;
    if (line.startsWith(' ')) trailing += 1;
    else if (line.startsWith('+') || line.startsWith('-')) trailing = 0;
  }
  closeSection();
  return anyHunk && whole;
}
