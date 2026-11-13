/**
 * Window-state persistence: a small JSON file in userData (`window-state.json`). Whatever is read
 * back is validated, and the bounds are clamped to a display that is connected now, so a window
 * last shown on an unplugged monitor comes back on a visible one.
 */
import { z } from 'zod';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const WINDOW_STATE_FILE = 'window-state.json';

const coordinate = z.number().int().min(-100_000).max(100_000);
const size = z.number().int().min(1).max(100_000);

export const WindowStateSchema = z.object({
  version: z.literal(1),
  bounds: z.object({ x: coordinate, y: coordinate, width: size, height: size }),
  maximized: z.boolean(),
  fullScreen: z.boolean().default(false),
});
export type WindowState = z.infer<typeof WindowStateSchema>;

/** Parses the saved file; null for anything missing, malformed or out of range. */
export function parseWindowState(text: string | null | undefined): WindowState | null {
  if (!text) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const result = WindowStateSchema.safeParse(json);
  return result.success ? result.data : null;
}

export function serializeWindowState(state: WindowState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function intersection(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** How much of the window must be on a display for it to count as visible there (px each way). */
export const MIN_VISIBLE = 64;

/**
 * Where to open the window: the saved bounds on the display they overlap most, shrunk to fit its
 * work area and moved inside it. With no saved state, or when it overlaps no display by at least
 * `MIN_VISIBLE` px in both directions, null (the caller centers a default-sized window).
 */
export function restoreBounds(
  saved: WindowState | null,
  workAreas: readonly Rect[],
  min: { width: number; height: number },
): Rect | null {
  if (!saved || workAreas.length === 0) return null;
  const b = saved.bounds;
  let best: Rect | null = null;
  let bestArea = 0;
  for (const area of workAreas) {
    const overlap = intersection(b, area);
    if (overlap > bestArea) {
      bestArea = overlap;
      best = area;
    }
  }
  if (!best) return null;
  const overlapW = Math.min(b.x + b.width, best.x + best.width) - Math.max(b.x, best.x);
  const overlapH = Math.min(b.y + b.height, best.y + best.height) - Math.max(b.y, best.y);
  if (overlapW < Math.min(MIN_VISIBLE, b.width) || overlapH < Math.min(MIN_VISIBLE, b.height)) {
    return null;
  }
  const width = Math.min(Math.max(b.width, min.width), best.width);
  const height = Math.min(Math.max(b.height, min.height), best.height);
  const x = Math.min(Math.max(b.x, best.x), best.x + best.width - width);
  const y = Math.min(Math.max(b.y, best.y), best.y + best.height - height);
  return { x, y, width, height };
}
