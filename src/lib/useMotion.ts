import { useLayoutEffect, useRef, type RefObject } from "react";
import { DUR, EASE, flipDeltas, reducedMotion, shouldGreet, type Spot } from "./motion";

/** How far a running glide has an item moved from its place right now (its transform). */
function shiftOf(el: HTMLElement): { x: number; y: number } {
  // Only our own glides: a row's CSS animations (finishing, arriving) don't count.
  if (typeof el.getAnimations !== "function" || !el.getAnimations().some((a) => a.id === "flip")) return { x: 0, y: 0 };
  const t = getComputedStyle(el).transform;
  if (!t || t === "none" || typeof DOMMatrixReadOnly !== "function") return { x: 0, y: 0 };
  const m = new DOMMatrixReadOnly(t);
  return { x: m.m41, y: m.m42 };
}

/**
 * Where each `[data-flip]` item in `root` sits in the layout, relative to
 * `root` — without any glide under way, so a change in the middle of one
 * measures true places — and how far each is shifted by its glide right now.
 */
function spots(root: HTMLElement): { at: Map<string, Spot>; shift: Map<string, { x: number; y: number }>; els: Map<string, HTMLElement> } {
  const base = root.getBoundingClientRect();
  const at = new Map<string, Spot>();
  const shift = new Map<string, { x: number; y: number }>();
  const els = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>("[data-flip]").forEach((el) => {
    const id = el.dataset.flip;
    if (!id) return;
    const r = el.getBoundingClientRect();
    const s = shiftOf(el);
    at.set(id, { x: r.left - s.x - base.left, y: r.top - s.y - base.top });
    shift.set(id, s);
    els.set(id, el);
  });
  return { at, shift, els };
}

/**
 * Rows glide to their new place when the list changes (a task finished,
 * moved or deleted) instead of jumping, and a few new ones arrive softly.
 * Items carry `data-flip="<id>"` — rows and the headers between them, so
 * they move together. A change mid-glide carries on from where each item
 * is on screen. Remount the list (a new `key`) to start without animating.
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
    last.current = now.at;
    if (!before || reducedMotion() || typeof el.animate !== "function") return;
    const { moved, entered } = flipDeltas(before, now.at);
    for (const m of moved) {
      const item = now.els.get(m.id);
      if (!item) continue;
      // From where it is on screen (its old place, plus any glide still running).
      const s = now.shift.get(m.id) ?? { x: 0, y: 0 };
      for (const a of item.getAnimations?.() ?? []) if (a.id === "flip") a.cancel();
      const anim = item.animate([{ transform: `translate(${m.dx + s.x}px, ${m.dy + s.y}px)` }, { transform: "none" }], { duration: DUR.open, easing: EASE });
      anim.id = "flip";
    }
    // Headers just glide; only tasks get the soft arrival.
    const arrivals = entered.filter((id) => !id.startsWith("g:"));
    if (opts.greet && shouldGreet(before.size, arrivals.length)) {
      for (const id of arrivals) {
        const item = now.els.get(id);
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
