import { useEffect, useRef, useState } from "react";
import type { Who } from "../lib/agents";

export type Layout = "list" | "board";

const WHO: { id: Who; label: string }[] = [
  { id: "all", label: "Everything" },
  { id: "you", label: "Only mine" },
  { id: "agents", label: "Changed by agents" },
];

/** What a "who" filter is called on its chip. */
export function whoLabel(who: Who): string {
  return WHO.find((w) => w.id === who)?.label ?? "Everything";
}

const Check = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 8.5l3.2 3L13 4.5" />
  </svg>
);

export const ViewIcon = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
    <path d="M2 4h7M12 4h2M2 8h2M7 8h7M2 12h9M14 12h0" />
    <circle cx="10.5" cy="4" r="1.5" />
    <circle cx="5.5" cy="8" r="1.5" />
    <circle cx="12.5" cy="12" r="1.5" />
  </svg>
);

/**
 * The header's View button: how the list on screen looks. Whose tasks it
 * shows (with AI agents on) and, where a list has one, list or board.
 */
export function ViewMenu({
  who,
  onWho,
  agentsOn,
  agentCount,
  layout,
  onLayout,
}: {
  who: Who;
  onWho: (w: Who) => void;
  agentsOn: boolean;
  agentCount: number;
  /** Only for lists that can be a board. */
  layout?: Layout;
  onLayout?: (l: Layout) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key, true);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", key, true);
    };
  }, [open]);
  if (!agentsOn && !layout) return null;
  const filtered = agentsOn && who !== "all";
  const pick = (run: () => void) => {
    run();
    setOpen(false);
  };
  return (
    <div className="view-menu-box" ref={box}>
      <button
        type="button"
        className={open || filtered ? "icon on" : "icon"}
        aria-label="View options"
        aria-haspopup="menu"
        aria-expanded={open}
        title="View options"
        onClick={() => setOpen((o) => !o)}
      >
        <ViewIcon />
      </button>
      {open && (
        <div className="view-menu" role="menu" aria-label="View options">
          {agentsOn && (
            <>
              <div className="view-menu-head">Show tasks</div>
              {WHO.map((w) => (
                <button key={w.id} type="button" role="menuitemradio" aria-checked={who === w.id} className={who === w.id ? "sel" : ""} onClick={() => pick(() => onWho(w.id))}>
                  <span className="view-menu-check">{who === w.id && <Check />}</span>
                  {w.label}
                  {w.id === "agents" && agentCount > 0 && <span className="view-menu-note">{agentCount}</span>}
                </button>
              ))}
            </>
          )}
          {agentsOn && layout && <div className="view-menu-sep" role="separator" />}
          {layout && onLayout && (
            <>
              <div className="view-menu-head">Layout</div>
              {(["list", "board"] as const).map((l) => (
                <button key={l} type="button" role="menuitemradio" aria-checked={layout === l} className={layout === l ? "sel" : ""} onClick={() => pick(() => onLayout(l))}>
                  <span className="view-menu-check">{layout === l && <Check />}</span>
                  {l === "list" ? "List" : "Board"}
                </button>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
