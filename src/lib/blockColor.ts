/**
 * Calendar blocks are filled with their color (a project's, or a meeting's
 * calendar), as in Outlook. The text on them is white or near-black,
 * whichever reads better on that color.
 */

/** A meeting whose calendar has no color. */
export const EVENT_FALLBACK = "#8e8e93";

/** "#rgb", "#rrggbb" or "rgb(r, g, b)" → [r, g, b] (0–255), or null. */
export function parseColor(color: string | null | undefined): [number, number, number] | null {
  if (!color) return null;
  const c = color.trim().toLowerCase();
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(c);
  if (m) return [m[1], m[2], m[3]].map((x) => parseInt(x + x, 16)) as [number, number, number];
  m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})(?:[0-9a-f]{2})?$/.exec(c);
  if (m) return [m[1], m[2], m[3]].map((x) => parseInt(x, 16)) as [number, number, number];
  m = /^rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/.exec(c);
  if (m) return [m[1], m[2], m[3]].map((x) => Math.min(255, Number(x))) as [number, number, number];
  return null;
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance([r, g, b]: [number, number, number]): number {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The text color for a block filled with `color`: white, or near-black on light colors. */
export function inkOn(color: string | null | undefined): "#fff" | "#1d1d1f" {
  const rgb = parseColor(color);
  if (!rgb) return "#fff";
  const l = luminance(rgb);
  // Whichever has more contrast (white's is 1.05 / (l + 0.05), black's (l + 0.05) / 0.05).
  return 1.05 / (l + 0.05) >= (l + 0.05) / 0.0625 ? "#fff" : "#1d1d1f";
}
