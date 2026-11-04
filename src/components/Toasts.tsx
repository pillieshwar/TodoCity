import { useCallback, useEffect, useRef, useState } from "react";
import { DUR, reducedMotion } from "../lib/motion";
import { useFlip } from "../lib/useMotion";

export interface Toast {
  id: number;
  text: string;
  /** Undo, or another single follow-up action. */
  action?: { label: string; run: () => void | Promise<void> };
  /** "done": a finished task, in green with a check. */
  tone?: "info" | "error" | "done";
  /** On its way out (fading), then removed. */
  leaving?: boolean;
}

const LIFETIME = 5500;

/**
 * A small queue of toasts. `undoLast` runs the newest toast's action (⌘Z),
 * so every undoable change gets a keyboard undo for free.
 */
export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) window.clearTimeout(timer);
    timers.current.delete(id);
    if (reducedMotion()) {
      setToasts((ts) => ts.filter((t) => t.id !== id));
      return;
    }
    // Fade out first, then go.
    setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    window.setTimeout(() => setToasts((ts) => ts.filter((t) => t.id !== id)), DUR.open);
  }, []);

  const show = useCallback(
    (text: string, action?: Toast["action"], tone: Toast["tone"] = "info") => {
      const id = ++seq.current;
      // Keep at most three on screen (ones already leaving don't count).
      setToasts((ts) => {
        const staying = ts.filter((t) => !t.leaving);
        const keep = new Set(staying.slice(-2).map((t) => t.id));
        return [...ts.filter((t) => t.leaving || keep.has(t.id)), { id, text, action, tone }];
      });
      timers.current.set(
        id,
        window.setTimeout(() => dismiss(id), LIFETIME),
      );
      return id;
    },
    [dismiss],
  );

  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;

  const undoLast = useCallback(() => {
    const last = [...toastsRef.current].reverse().find((t) => t.action && !t.leaving);
    if (!last?.action) return false;
    dismiss(last.id);
    void last.action.run();
    return true;
  }, [dismiss]);

  useEffect(() => {
    const all = timers.current;
    return () => all.forEach((t) => window.clearTimeout(t));
  }, []);

  return { toasts, show, dismiss, undoLast };
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  // The stack closes the gap smoothly when one leaves.
  const box = useRef<HTMLDivElement>(null);
  useFlip(box);
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite" ref={box}>
      {toasts.map((t) => (
        <div
          key={t.id}
          data-flip={t.id}
          className={["toast", t.tone === "error" ? "error" : t.tone === "done" ? "done" : "", t.leaving ? "leaving" : ""].filter(Boolean).join(" ")}
        >
          {t.tone === "done" && (
            <span className="toast-check" aria-hidden>
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 6.2 5 8.6 9.6 3.6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
          )}
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <button
              type="button"
              className="toast-action"
              onClick={() => {
                onDismiss(t.id);
                void t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button type="button" className="toast-close" aria-label="Dismiss" onClick={() => onDismiss(t.id)}>
            ×
          </button>
          {/* How long Undo stays: a line that runs down. */}
          {t.action && !t.leaving && <span className="toast-timer" style={{ animationDuration: `${LIFETIME}ms` }} aria-hidden />}
        </div>
      ))}
    </div>
  );
}
