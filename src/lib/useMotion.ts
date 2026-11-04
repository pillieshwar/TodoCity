import { useLayoutEffect, useRef, type RefObject } from "react";
import { DUR, EASE, flipDeltas, reducedMotion, shouldGreet, type Spot } from "./motion";

/** Where each `[data-flip]` item in `root` is, relative to `root`. */
function spots(root: HTMLElement): Map<string, Spot> {
  const base = root.getBoundingClientRect();
  const out = new Map<string, Spot>();
  root.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => {
    const id = el.dataset.flip;
    if (!id) return;
    const r = el.getBoundingClientRect();
    out.set(id, { x: r.left - base.left, y: r.top - base.top });
  });
  return out;
}

/**
 * Rows glide to their new place when the list changes (a task finished,
 * moved or deleted) instead of jumping, and a few new ones arrive softly.
 * Items carry `data-flip="<id>"`. Remount the list (a new `key`) to start a
 * new list without animating.
 */
export function useFlip(root: RefObject<HTMLElement | null>, opts: { greet?: boolean; paused?: boolean } = {}) {
  const last = useRef<Map<string, Spot> | null>(null);
  useLayoutEffect(() => {
    // Paused (a drag under way): keep the layout from before, so the drop glides.
    if (opts.paused) return;
    const el = root.current;
    if (!el) {
      last.current = null;
      return;
    }
    const now = spots(el);
    const before = last.current;
    last.current = now;
    if (!before || reducedMotion() || typeof el.animate !== "function") return;
    const { moved, entered } = flipDeltas(before, now);
    const find = (id: string) => el.querySelector<HTMLElement>(`[data-flip="${CSS.escape(id)}"]`);
    for (const m of moved) {
      find(m.id)?.animate([{ transform: `translate(${m.dx}px, ${m.dy}px)` }, { transform: "none" }], { duration: DUR.open, easing: EASE });
    }
    if (opts.greet && shouldGreet(before.size, entered.length)) {
      for (const id of entered) {
        const item = find(id);
        if (!item) continue;
        item.animate([{ opacity: 0, transform: "translateY(-4px)" }, { opacity: 1, transform: "none" }], { duration: DUR.open, easing: EASE });
        item.classList.add("arrived");
        window.setTimeout(() => item.classList.remove("arrived"), 1600);
      }
    }
  });
}

/**
 * Marks a scroll box with `data-scrolled` (scrolled down from the top) and
 * `data-more` (more below), for a hairline shadow under the header and a
 * soft fade at the bottom edge. Set straight on the element: no re-render.
 */
export function useScrollEdges(box: RefObject<HTMLElement | null>, key?: unknown) {
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const mark = () => {
      const scrolled = el.scrollTop > 2;
      const more = el.scrollHeight - el.clientHeight - el.scrollTop > 2;
      if (scrolled) el.dataset.scrolled = "";
      else delete el.dataset.scrolled;
      if (more) el.dataset.more = "";
      else delete el.dataset.more;
    };
    mark();
    el.addEventListener("scroll", mark, { passive: true });
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(mark) : null;
    ro?.observe(el);
    if (el.firstElementChild) ro?.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", mark);
      ro?.disconnect();
    };
  }, [box, key]);
}
