import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { DUR, reducedMotion, tickDirection } from "../lib/motion";

/**
 * Slides its content open and closed (height and fade), like the sidebar in
 * Stripe's docs. Closed, the content is unmounted once the slide is over.
 * Open on first show: no slide.
 */
export function Collapse({ open, children, className }: { open: boolean; children: ReactNode; className?: string }) {
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  // Overflow is clipped only while sliding, so menus inside can spill out.
  const [settled, setSettled] = useState(open);
  const first = useRef(true);
  // Before paint, so a change never flashes the wrong state.
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const reduce = reducedMotion();
    setSettled(false);
    if (open) {
      setMounted(true);
      if (reduce) {
        setShown(true);
        setSettled(true);
        return;
      }
      // Mounted closed first, then opened on the next frame, so it slides.
      let f2 = 0;
      const f1 = requestAnimationFrame(() => {
        f2 = requestAnimationFrame(() => setShown(true));
      });
      const t = window.setTimeout(() => setSettled(true), DUR.open + 60);
      return () => {
        cancelAnimationFrame(f1);
        cancelAnimationFrame(f2);
        window.clearTimeout(t);
      };
    }
    setShown(false);
    if (reduce) {
      setMounted(false);
      return;
    }
    const t = window.setTimeout(() => setMounted(false), DUR.open + 40);
    return () => window.clearTimeout(t);
  }, [open]);
  if (!mounted) return null;
  const cls = ["collapse", shown ? "open" : "", settled && shown ? "settled" : "", className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={cls} aria-hidden={!open || undefined}>
      <div className="collapse-inner">{children}</div>
    </div>
  );
}

/** A count that rolls to its new number (up when it grows, down when it shrinks). Empty for 0. */
export function Tick({ value, className }: { value: number | null | undefined; className?: string }) {
  // The direction lasts until the number changes again, so a re-render mid-roll doesn't cut it short.
  const seen = useRef<{ value: number; dir: "up" | "down" | null } | null>(null);
  const v = value ?? 0;
  if (seen.current === null) seen.current = { value: v, dir: null };
  else if (seen.current.value !== v) seen.current = { value: v, dir: tickDirection(seen.current.value, v) };
  const dir = seen.current.dir;
  const text = value ? String(value) : "";
  return (
    <span className={className}>
      <span key={text} className={dir ? `tick tick-${dir}` : "tick"}>
        {text}
      </span>
    </span>
  );
}
