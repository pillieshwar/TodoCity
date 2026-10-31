import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { DropTarget } from "./plan";
import type { Task } from "./types";
import { snapMinute } from "./timeblock";
import { markDragged } from "./hints";

export interface DragState {
  task: Task;
  x: number;
  y: number;
  /** What's under the pointer, if it's somewhere a task can go. */
  over: DropTarget | null;
}

/**
 * Read a drop target from `data-iso` (+ optional `data-hour`: "any" or 0–23),
 * or a place from `data-drop-project` (+ optional `data-drop-floor`: a
 * floor's name, "" for the ground floor).
 */
function targetAt(x: number, y: number): DropTarget | null {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const pl = el?.closest<HTMLElement>("[data-drop-project]");
  if (pl?.dataset.dropProject) {
    const f = pl.dataset.dropFloor;
    return { place: { project: pl.dataset.dropProject, ...(f === undefined ? {} : { heading: f || null }) } };
  }
  if (el?.closest("[data-drop-nodate]")) return { nodate: true };
  const t = el?.closest<HTMLElement>("[data-iso]");
  if (!t?.dataset.iso) return null;
  const h = t.dataset.hour;
  if (h === undefined) return { iso: t.dataset.iso };
  if (h === "any") return { iso: t.dataset.iso, hour: null };
  // An hour that takes minutes (the Calendar): where in it, snapped to 5.
  if (t.dataset.minutes !== undefined) {
    const r = t.getBoundingClientRect();
    return { iso: t.dataset.iso, hour: Number(h), minute: snapMinute((y - r.top) / r.height) };
  }
  return { iso: t.dataset.iso, hour: Number(h) };
}

export function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  return (
    a?.iso === b?.iso &&
    a?.nodate === b?.nodate &&
    a?.hour === b?.hour &&
    a?.minute === b?.minute &&
    a?.place?.project === b?.place?.project &&
    a?.place?.heading === b?.place?.heading
  );
}

/** Scroll `[data-autoscroll]` boxes while dragging near their top or bottom edge. */
function autoScroll(x: number, y: number) {
  for (const box of document.querySelectorAll<HTMLElement>("[data-autoscroll]")) {
    const r = box.getBoundingClientRect();
    if (x < r.left || x > r.right) continue;
    const edge = 36;
    if (y < r.top + edge && y > r.top - 60) box.scrollBy(0, -Math.ceil((r.top + edge - y) / 4));
    else if (y > r.bottom - edge && y < r.bottom + 60) box.scrollBy(0, Math.ceil((y - (r.bottom - edge)) / 4));
  }
}

/**
 * Drag tasks with the pointer (HTML drag-and-drop is taken by the window for
 * file drops). Press on a task, move a few pixels, and drop on anything with
 * `data-iso` — a day — or `data-iso` + `data-hour` — a block in a day.
 */
export function useTaskDrag(onDrop: (task: Task, to: DropTarget) => void) {
  const [drag, setDrag] = useState<DragState | null>(null);
  const pressed = useRef<{ task: Task; x: number; y: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const moved = useRef(false);
  const dropRef = useRef(onDrop);
  dropRef.current = onDrop;

  const start = useCallback((e: ReactPointerEvent, task: Task) => {
    if (e.button !== 0 || task.done) return;
    if ((e.target as HTMLElement).closest("[data-nodrag], input, textarea, a")) return;
    pressed.current = { task, x: e.clientX, y: e.clientY };
    moved.current = false;
  }, []);

  useEffect(() => {
    let timer = 0;
    const move = (e: PointerEvent) => {
      const p = pressed.current;
      if (!p) return;
      if (!moved.current && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6) return;
      moved.current = true;
      dragRef.current = { task: p.task, x: e.clientX, y: e.clientY, over: targetAt(e.clientX, e.clientY) };
      setDrag(dragRef.current);
      if (!timer) {
        timer = window.setInterval(() => {
          const d = dragRef.current;
          if (!d) return;
          autoScroll(d.x, d.y);
          // What's under the pointer changes as the box scrolls.
          const over = targetAt(d.x, d.y);
          if (!sameTarget(over, d.over)) {
            dragRef.current = { ...d, over };
            setDrag(dragRef.current);
          }
        }, 30);
      }
    };
    const up = () => {
      const d = dragRef.current;
      pressed.current = null;
      dragRef.current = null;
      window.clearInterval(timer);
      timer = 0;
      setDrag(null);
      // The click that ends a drag fires before this timeout; later clicks count.
      if (moved.current) window.setTimeout(() => (moved.current = false), 0);
      if (d?.over) {
        markDragged();
        dropRef.current(d.task, d.over);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  /** True once right after a drag, so the click that ends it is ignored. */
  const wasDrag = useCallback(() => {
    if (!moved.current) return false;
    moved.current = false;
    return true;
  }, []);

  return { drag, start, wasDrag };
}

export type TaskDrag = ReturnType<typeof useTaskDrag>;
