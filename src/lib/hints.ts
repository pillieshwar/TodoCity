/**
 * One-time hints. "Drag a task onto a date" shows until the person has
 * dragged a task somewhere once, then only while dragging.
 */
const DRAGGED = "todocity.hint.dragged";

export function hasDragged(): boolean {
  try {
    return localStorage.getItem(DRAGGED) === "1";
  } catch {
    return false;
  }
}

export function markDragged() {
  try {
    localStorage.setItem(DRAGGED, "1");
  } catch {
    // Storage off: the hint stays, which is harmless.
  }
}

/** Show a drag hint: while a drag is on, or until the first drag. */
export function showDragHint(dragging: boolean): boolean {
  return dragging || !hasDragged();
}
