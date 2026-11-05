/**
 * Where a task's details open in the Calendar: beside the block, like
 * Outlook's — to its right when there's room, else its left, else over it —
 * top-aligned with the block and kept inside the window.
 */
export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}
export interface Size {
  width: number;
  height: number;
}
export interface PopAt {
  left: number;
  top: number;
  side: "right" | "left" | "over";
}

export function popPlace(anchor: Box | null, pop: Size, view: Size, gap = 8, margin = 10): PopAt {
  const clampTop = (t: number) => Math.max(margin, Math.min(t, view.height - margin - pop.height));
  if (!anchor) {
    return { left: Math.max(margin, (view.width - pop.width) / 2), top: Math.max(margin, (view.height - pop.height) / 3), side: "over" };
  }
  const top = clampTop(anchor.top - 6);
  const right = anchor.left + anchor.width + gap;
  if (right + pop.width <= view.width - margin) return { left: right, top, side: "right" };
  const left = anchor.left - gap - pop.width;
  if (left >= margin) return { left, top, side: "left" };
  return { left: Math.max(margin, Math.min(anchor.left, view.width - margin - pop.width)), top, side: "over" };
}
