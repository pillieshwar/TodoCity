/**
 * TodoCity's motion: three durations and one easing, so everything that
 * moves feels like the same app (the CSS twins are `--dur-*` and `--ease`
 * in styles.css). Everything turns off with macOS's "Reduce motion".
 */

/** Small things (a menu, a press), opening and closing, changing views. */
export const DUR = { quick: 120, open: 200, view: 280 } as const;
/** Quick out, gentle in. */
export const EASE = "cubic-bezier(0.2, 0, 0, 1)";
/** A little overshoot, for things that land. */
export const SPRING = "cubic-bezier(0.34, 1.36, 0.64, 1)";

/** macOS's "Reduce motion" is on. */
export function reducedMotion(): boolean {
  try {
    return !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export interface Spot {
  x: number;
  y: number;
}

/**
 * What changed between two layouts of a list, by item id: the items that
 * moved (and by how much) and the ones that arrived. Jumps further than
 * `far` px aren't animated (a reorder that big reads better as a cut).
 */
export function flipDeltas(
  before: Map<string, Spot>,
  after: Map<string, Spot>,
  far = 600,
): { moved: { id: string; dx: number; dy: number }[]; entered: string[] } {
  const moved: { id: string; dx: number; dy: number }[] = [];
  const entered: string[] = [];
  for (const [id, now] of after) {
    const was = before.get(id);
    if (!was) {
      entered.push(id);
      continue;
    }
    const dx = was.x - now.x;
    const dy = was.y - now.y;
    if ((Math.abs(dx) >= 1 || Math.abs(dy) >= 1) && Math.abs(dx) <= far && Math.abs(dy) <= far) moved.push({ id, dx, dy });
  }
  return { moved, entered };
}

/** Arrivals get a soft entrance only when a few join a list already on screen (not a new list). */
export function shouldGreet(before: number, entered: number): boolean {
  return before > 0 && entered > 0 && entered <= 3;
}

/** Which way a count rolls: up when it grows, down when it shrinks. */
export function tickDirection(prev: number | null | undefined, next: number | null | undefined): "up" | "down" | null {
  const a = prev ?? 0;
  const b = next ?? 0;
  if (prev === undefined || a === b) return null;
  return b > a ? "up" : "down";
}

/** Where a tooltip goes: centred under the element, kept inside the window, above it when there's no room below. */
export function tipPlace(
  target: { left: number; top: number; width: number; height: number },
  tip: { width: number; height: number },
  view: { width: number; height: number },
  gap = 6,
): { left: number; top: number; above: boolean } {
  let left = target.left + target.width / 2 - tip.width / 2;
  left = Math.max(6, Math.min(left, view.width - tip.width - 6));
  const below = target.top + target.height + gap;
  const above = below + tip.height > view.height - 6;
  const top = above ? Math.max(6, target.top - tip.height - gap) : below;
  return { left, top, above };
}
