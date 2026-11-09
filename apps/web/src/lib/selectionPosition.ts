/**
 * Placement of the floating Copy bar, after T3 Code's `resolveSelectionActionPosition` (MIT,
 * Copyright (c) 2026 T3 Tools Inc., apps/web/src/lib/selectionActions.ts).
 */

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
