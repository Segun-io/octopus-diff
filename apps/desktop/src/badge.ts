/**
 * The unreviewed badge (docs/DESKTOP.md §3.4, `setBadge`): the dock badge on macOS and the
 * launcher count on Linux (`app.setBadgeCount`; Unity-style launchers only), a taskbar overlay
 * icon on Windows (which has no count badge): an amber dot like the web favicon's, with the count
 * in its accessible description. Pure.
 */

export const BADGE_MAX = 99_999;

export type BadgePlan =
  | { kind: 'count'; count: number }
  | { kind: 'overlay'; description: string }
  | { kind: 'clear-overlay' };

export function badgePlan(platform: NodeJS.Platform, count: number): BadgePlan {
  const n = Math.max(0, Math.min(BADGE_MAX, Math.floor(count)));
  if (platform !== 'win32') return { kind: 'count', count: n };
  if (n === 0) return { kind: 'clear-overlay' };
  return { kind: 'overlay', description: `${n} unreviewed file${n === 1 ? '' : 's'}` };
}

/** A `size`×`size` amber (#e0ae52) dot, BGRA, for `nativeImage.createFromBitmap`. */
export function overlayDotBitmap(size = 16): Buffer {
  const out = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c);
      // Opaque inside, a one-pixel antialiased edge, transparent outside.
      const alpha = d <= r - 0.5 ? 255 : d >= r + 0.5 ? 0 : Math.round((r + 0.5 - d) * 255);
      if (alpha === 0) continue;
      const i = (y * size + x) * 4;
      // Premultiplied, as Skia's N32 bitmaps are.
      out[i] = Math.round((0x52 * alpha) / 255);
      out[i + 1] = Math.round((0xae * alpha) / 255);
      out[i + 2] = Math.round((0xe0 * alpha) / 255);
      out[i + 3] = alpha;
    }
  }
  return out;
}
