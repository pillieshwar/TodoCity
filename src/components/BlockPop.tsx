import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { popPlace, type PopAt } from "../lib/blockPop";

/**
 * A task's details in the Calendar, opened beside its block (`[data-block-id]`)
 * like Outlook's, instead of in a side pane. It follows the block as the week
 * scrolls; a click anywhere else, or Esc, closes it.
 */
export function BlockPop({ id, onClose, children }: { id: number; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<PopAt | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const place = () => {
    const pop = ref.current;
    if (!pop) return;
    const block = document.querySelector<HTMLElement>(`[data-block-id="${id}"]`);
    const r = block?.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const next = popPlace(
      r && r.height > 0 ? { left: r.left, top: r.top, width: r.width, height: r.height } : null,
      { width: p.width, height: p.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    setAt((a) => (a && a.left === next.left && a.top === next.top && a.side === next.side ? a : next));
  };
  const placeRef = useRef(place);
  placeRef.current = place;

  // Before paint, every render: the block may have moved (a new time, a new week).
  useLayoutEffect(() => placeRef.current());

  useEffect(() => {
    const again = () => placeRef.current();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(again) : null;
    if (ref.current) ro?.observe(ref.current);
    window.addEventListener("scroll", again, true);
    window.addEventListener("resize", again);
    const away = (e: PointerEvent) => {
      const el = e.target as Element | null;
      if (!el || ref.current?.contains(el)) return;
      // Its own block toggles nothing; a dialog or tooltip on top isn't "away".
      if (el.closest(`[data-block-id="${id}"], .who-scrim, .tt, .toasts`)) return;
      // Whatever is being typed saves on blur, before the details close.
      (document.activeElement as HTMLElement | null)?.blur?.();
      closeRef.current();
    };
    document.addEventListener("pointerdown", away, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("scroll", again, true);
      window.removeEventListener("resize", again);
      document.removeEventListener("pointerdown", away, true);
    };
  }, [id]);

  return (
    <div
      ref={ref}
      className={`block-pop ${at?.side ?? "over"}`}
      role="dialog"
      aria-label="Task details"
      style={at ? { left: at.left, top: at.top } : { left: -9999, top: 0, visibility: "hidden" }}
    >
      {children}
    </div>
  );
}
