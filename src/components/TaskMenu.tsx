import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { TaskActions } from "../lib/taskActions";
import type { Task } from "../lib/types";

type At = { task: Task; x: number; y: number };
const hosts = new Set<(at: At) => void>();

/**
 * Right-click on a task: a small menu at the pointer (Open, Done, Duplicate,
 * Delete). Text fields keep the Mac's own menu (copy, paste…).
 */
export function openTaskMenu(e: ReactMouseEvent, task: Task) {
  const el = e.target as HTMLElement | null;
  if (el?.closest("input, textarea, [contenteditable='true'], a")) return;
  if (!hosts.size) return;
  e.preventDefault();
  e.stopPropagation();
  for (const show of hosts) show({ task, x: e.clientX, y: e.clientY });
}

/** Where the menu goes: at the pointer, kept inside the window. */
export function menuPlace(x: number, y: number, w: number, h: number, vw: number, vh: number, margin = 8) {
  return {
    left: Math.max(margin, x + w + margin > vw ? x - w : x),
    top: Math.max(margin, y + h + margin > vh ? y - h : y),
  };
}

/** Draws the right-click menu; one per window. */
export function TaskMenuHost({ actions, onOpen }: { actions: TaskActions; onOpen?: (task: Task) => void }) {
  const [at, setAt] = useState<At | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const show = (a: At) => {
      setPos(null);
      setAt(a);
    };
    hosts.add(show);
    return () => void hosts.delete(show);
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!at || !el) return;
    const r = el.getBoundingClientRect();
    setPos(menuPlace(at.x, at.y, r.width, r.height, window.innerWidth, window.innerHeight));
    el.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus({ preventScroll: true });
  }, [at]);

  useEffect(() => {
    if (!at) return;
    const close = () => setAt(null);
    const away = (e: Event) => {
      if (ref.current?.contains(e.target as Node)) return;
      close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      e.preventDefault();
      e.stopPropagation();
      const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? [])];
      const i = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("contextmenu", away, true);
    document.addEventListener("keydown", key, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    window.addEventListener("wheel", close, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("contextmenu", away, true);
      document.removeEventListener("keydown", key, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
      window.removeEventListener("wheel", close);
    };
  }, [at]);

  if (!at) return null;
  const t = at.task;
  const run = (fn: () => unknown) => () => {
    setAt(null);
    void fn();
  };
  return (
    <div
      ref={ref}
      className="task-menu"
      role="menu"
      aria-label={`“${t.title}”`}
      style={pos ? { left: pos.left, top: pos.top } : { left: at.x, top: at.y, visibility: "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {onOpen && (
        <button type="button" role="menuitem" onClick={run(() => onOpen(t))}>
          Open
        </button>
      )}
      <button type="button" role="menuitem" onClick={run(() => actions.setDone(t, !t.done))}>
        {t.done ? "Mark as not done" : "Mark as done"}
      </button>
      <button type="button" role="menuitem" onClick={run(() => actions.duplicate(t))}>
        Duplicate
      </button>
      <span className="task-menu-sep" role="separator" />
      <button type="button" role="menuitem" className="danger" onClick={run(() => actions.remove(t))}>
        Delete
      </button>
    </div>
  );
}
