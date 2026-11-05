import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { PROJECT_COLORS } from "../lib/colors";
import { reducedMotion } from "../lib/motion";
import {
  ZOOMS,
  barPlace,
  clickSpan,
  dayNum,
  dragSpan,
  drawnSpan,
  fromToday,
  homeFrom,
  lengthLabel,
  monthsIn,
  spanLabel,
  type Span,
  type ZoomId,
} from "../lib/timeline";
import type { ProjectSummary } from "../lib/types";
import { LineIcon } from "./LineIcon";

const LEFT_W = 260;
const ZOOM_KEY = "todocity.timeline.zoom";
const FOLD_KEY = "todocity.timeline.folded";

const saved = <T extends string>(key: string, ok: readonly T[], d: T): T => {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && ok.includes(v) ? v : d;
  } catch {
    return d;
  }
};

type Drag =
  | { kind: "bar"; name: string; mode: "move" | "start" | "end"; x0: number; base: Span; by: number; moved: boolean }
  | { kind: "draw"; name: string; a: number; b: number; x0: number; moved: boolean };

/** A small ring for how much of a project is done. */
function Ring({ done, total }: { done: number; total: number }) {
  const f = total ? done / total : 0;
  const r = 6;
  const c = 2 * Math.PI * r;
  return (
    <svg className="tl-ring" width="16" height="16" viewBox="0 0 16 16" aria-hidden>
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeOpacity=".28" strokeWidth="2" />
      <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray={`${f * c} ${c}`} transform="rotate(-90 8 8)" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The Timeline: every project as a bar from its first to its last day, on
 * months that pan freely. Drag a bar to move it, its ends to stretch it,
 * drag across an empty row to plan a project, click a bar to open it, and
 * right-click for its color. Pastel throughout.
 */
export function Timeline({
  projects,
  today,
  locale,
  onOpen,
  onPlan,
  onColor,
}: {
  projects: ProjectSummary[];
  today: string;
  locale: string;
  onOpen: (name: string) => void;
  onPlan: (name: string, span: Span | null) => Promise<void>;
  onColor: (name: string, color: string | null) => void;
}) {
  const [zoom, setZoomRaw] = useState<ZoomId>(() => saved(ZOOM_KEY, ZOOMS.map((z) => z.id), "year"));
  const days = ZOOMS.find((z) => z.id === zoom)!.days;
  const [from, setFrom] = useState(() => homeFrom(today, zoom));
  const [folded, setFolded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(FOLD_KEY) ?? "[]") as string[]);
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify([...folded]));
    } catch {
      // Not remembered; fine.
    }
  }, [folded]);
  const setZoom = (z: ZoomId) => {
    setZoomRaw(z);
    try {
      localStorage.setItem(ZOOM_KEY, z);
    } catch {
      // Not remembered; fine.
    }
    // Keep the middle of what's in view in the middle.
    const mid = from + days / 2;
    const next = ZOOMS.find((x) => x.id === z)!.days;
    setFrom(Math.round(mid - next / 2));
  };

  // The lanes' width, for pixels per day.
  const headRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  useLayoutEffect(() => {
    const el = headRef.current;
    if (!el) return;
    const measure = () => setWidth(Math.max(200, el.getBoundingClientRect().width));
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  const ppd = width / days;

  // Glide the window to a new place (‹ › and Today).
  const glide = useRef(0);
  const goTo = useCallback(
    (target: number) => {
      cancelAnimationFrame(glide.current);
      if (reducedMotion()) {
        setFrom(target);
        return;
      }
      const start = performance.now();
      let begin: number | null = null;
      const step = (t: number) => {
        setFrom((f) => {
          if (begin === null) begin = f;
          const k = Math.min(1, (t - start) / 260);
          const e = 1 - Math.pow(1 - k, 3);
          return begin + (target - begin) * e;
        });
        if (t - start < 260) glide.current = requestAnimationFrame(step);
      };
      glide.current = requestAnimationFrame(step);
    },
    [],
  );
  useEffect(() => () => cancelAnimationFrame(glide.current), []);
  const monthStep = Math.max(1, Math.round(days / 92)) * 30.44;

  // Two-finger swipes (or Shift + wheel) pan the months.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
      if (!dx) return;
      e.preventDefault();
      cancelAnimationFrame(glide.current);
      setFrom((f) => f + dx / ppd);
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [ppd]);

  // Changes shown at once, before the saved ones come back.
  const [pending, setPending] = useState<Map<string, Span | null>>(new Map());
  useEffect(() => {
    setPending((m) => {
      if (!m.size) return m;
      const n = new Map(m);
      for (const [name, s] of m) {
        const p = projects.find((x) => x.name === name);
        const now = p?.plan_start && p.plan_end ? { start: p.plan_start, end: p.plan_end } : null;
        if (!p || (now?.start === s?.start && now?.end === s?.end)) n.delete(name);
      }
      return n;
    });
  }, [projects]);
  const plan = (name: string, s: Span | null) => {
    setPending((m) => new Map(m).set(name, s));
    void onPlan(name, s).catch(() =>
      setPending((m) => {
        const n = new Map(m);
        n.delete(name);
        return n;
      }),
    );
  };
  const spanOf = (p: ProjectSummary): Span | null =>
    pending.has(p.name) ? pending.get(p.name)! : p.plan_start && p.plan_end ? { start: p.plan_start, end: p.plan_end } : null;

  // Dragging a bar, or drawing a new one across an empty row.
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  useEffect(() => {
    if (!drag) return;
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const dx = e.clientX - d.x0;
      const moved = d.moved || Math.abs(dx) > 3;
      if (d.kind === "bar") {
        const by = Math.round(dx / ppd);
        if (by !== d.by || moved !== d.moved) setDrag({ ...d, by, moved });
      } else {
        const b = d.a + Math.round(dx / ppd);
        if (b !== d.b || moved !== d.moved) setDrag({ ...d, b, moved });
      }
    };
    const up = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      if (d.kind === "bar") {
        if (!d.moved) onOpen(d.name);
        else if (d.by) plan(d.name, dragSpan(d.base, d.mode, d.by));
      } else plan(d.name, d.moved ? drawnSpan(d.a, d.b) : clickSpan(d.a));
    };
    const cancel = () => setDrag(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && cancel();
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
    };
    // Bound while a drag lasts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.kind, drag?.name, ppd]);
  const dayAt = (clientX: number, lane: HTMLElement) => Math.floor(from + (clientX - lane.getBoundingClientRect().left) / ppd);

  // Right-click (or the color dot): color, open, take off the Timeline.
  const [menu, setMenu] = useState<{ name: string; x: number; y: number } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => !(e.target as HTMLElement).closest(".tl-menu") && setMenu(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setMenu(null);
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", key);
    };
  }, [menu]);

  const planned = projects.filter((p) => spanOf(p)).sort((a, b) => spanOf(a)!.start.localeCompare(spanOf(b)!.start) || a.name.localeCompare(b.name));
  const unplanned = projects.filter((p) => !spanOf(p)).sort((a, b) => a.name.localeCompare(b.name));
  const groups = [
    { id: "planned", label: "On the timeline", items: planned },
    { id: "unplanned", label: "Not planned yet", items: unplanned },
  ].filter((g) => g.items.length);

  const months = useMemo(() => monthsIn(from, days), [from, days]);
  const todayN = dayNum(today);
  const x = (n: number) => (n - from) * ppd;
  const monthFmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short" }), [locale]);

  const bar = (p: ProjectSummary) => {
    const base = spanOf(p);
    const live = drag?.kind === "bar" && drag.name === p.name ? dragSpan(drag.base, drag.mode, drag.by) : drag?.kind === "draw" && drag.name === p.name && drag.moved ? drawnSpan(drag.a, drag.b) : base;
    if (!live) return null;
    const at = barPlace(live, from, days, width);
    if (!at.visible) {
      // Off to one side: an arrow that brings it into view.
      const after = dayNum(live.start) >= from + days;
      return (
        <button type="button" className={after ? "tl-off after" : "tl-off before"} style={{ "--fill": p.color ?? undefined } as CSSProperties} onClick={() => goTo(dayNum(live.start) - Math.round(days / 6))} title={`${p.name}: ${spanLabel(live, today, locale)}`}>
          {after ? "›" : "‹"}
        </button>
      );
    }
    const dragging = drag?.name === p.name && (drag.kind === "draw" || drag.moved);
    const narrow = at.width < 120;
    const start = (mode: "move" | "start" | "end") => (e: ReactPointerEvent) => {
      if (e.button !== 0 || !base) return;
      e.preventDefault();
      e.stopPropagation();
      cancelAnimationFrame(glide.current);
      setMenu(null);
      setDrag({ kind: "bar", name: p.name, mode, x0: e.clientX, base, by: 0, moved: false });
    };
    return (
      <div
        className={["tl-item pastel", at.cutStart ? "cut-start" : "", at.cutEnd ? "cut-end" : "", narrow ? "narrow" : "", dragging ? "dragging" : ""].filter(Boolean).join(" ")}
        style={{ left: at.left, width: Math.max(at.width, 6), "--fill": p.color ?? undefined } as CSSProperties}
        data-project={p.name}
        role="button"
        tabIndex={0}
        aria-label={`${p.name}, ${spanLabel(live, today, locale)}. Enter opens it; arrows move it, Option-arrows change its end.`}
        onPointerDown={start("move")}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ name: p.name, x: e.clientX, y: e.clientY });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") onOpen(p.name);
          if (base && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
            e.preventDefault();
            const by = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 7 : 1);
            plan(p.name, dragSpan(base, e.altKey ? "end" : "move", by));
          }
        }}
      >
        <span className="tl-grip start" onPointerDown={start("start")} aria-hidden />
        <span className="tl-label">
          <Ring done={p.done} total={p.open + p.done} />
          <span className="tl-name">{p.name}</span>
        </span>
        <span className="tl-grip end" onPointerDown={start("end")} aria-hidden />
        {dragging && (
          <span className="tl-tip" role="status">
            {spanLabel(live, today, locale)} · {lengthLabel(live)}
          </span>
        )}
      </div>
    );
  };

  const row = (p: ProjectSummary) => {
    const s = spanOf(p);
    const late = !!s && s.end < today && p.open > 0;
    return (
      <div className={s ? "tl-row" : "tl-row unplanned"} key={p.name}>
        <div className="tl-left">
          <button
            type="button"
            className="tl-dot pastel"
            style={{ "--fill": p.color ?? undefined } as CSSProperties}
            aria-label={`${p.name}'s color`}
            title="Color"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setMenu({ name: p.name, x: r.left, y: r.bottom + 6 });
            }}
          />
          <button type="button" className="tl-open" onClick={() => onOpen(p.name)} title={`Open ${p.name}`}>
            {p.name}
          </button>
          {s ? (
            <span className={late ? "tl-due late" : "tl-due"} title={`Ends ${spanLabel({ start: s.end, end: s.end }, today, locale)}`}>
              <LineIcon name={late ? "flagFilled" : "flag"} size={13} />
              {fromToday(s.end, today)}
            </span>
          ) : (
            <span className="tl-due hint">Drag to plan</span>
          )}
        </div>
        <div
          className="tl-lane"
          onPointerDown={(e) => {
            if (e.button !== 0 || s || e.target !== e.currentTarget) return;
            e.preventDefault();
            const a = dayAt(e.clientX, e.currentTarget);
            setDrag({ kind: "draw", name: p.name, a, b: a, x0: e.clientX, moved: false });
          }}
        >
          {bar(p)}
        </div>
      </div>
    );
  };

  const menuFor = menu ? projects.find((p) => p.name === menu.name) : null;
  return (
    <div className={drag ? "timeline dragging" : "timeline"}>
      <div className="tl-toolbar">
        <div className="tl-zoom" role="radiogroup" aria-label="Zoom">
          {ZOOMS.map((z) => (
            <button key={z.id} type="button" role="radio" aria-checked={zoom === z.id} className={zoom === z.id ? "on" : ""} onClick={() => setZoom(z.id)}>
              {z.label}
            </button>
          ))}
        </div>
        <div className="tl-nav">
          <button type="button" className="icon" aria-label="Earlier" title="Earlier" onClick={() => goTo(from - monthStep)}>
            ‹
          </button>
          <button type="button" className="tl-today" onClick={() => goTo(homeFrom(today, zoom))}>
            Today
          </button>
          <button type="button" className="icon" aria-label="Later" title="Later" onClick={() => goTo(from + monthStep)}>
            ›
          </button>
        </div>
        <span className="tl-help">Drag a bar to move it, its ends to stretch it. Click to open.</span>
      </div>
      <div className="tl-body" ref={bodyRef}>
        <div className="tl-head">
          <div className="tl-left tl-head-left">Projects</div>
          <div className="tl-months" ref={headRef}>
            {months.map((m) => (
              <span key={m.iso} className={m.iso.endsWith("-01-01") ? "tl-month year" : "tl-month"} style={{ left: Math.max(x(m.start), 0) }}>
                {m.iso.endsWith("-01-01") || m === months[0] ? `${monthFmt.format(new Date(`${m.iso}T12:00:00`))} ${m.iso.slice(0, 4)}` : monthFmt.format(new Date(`${m.iso}T12:00:00`))}
              </span>
            ))}
          </div>
        </div>
        <div className="tl-rows">
          <div className="tl-lines" aria-hidden style={{ left: LEFT_W }}>
            {months.map((m) => (
              <span key={m.iso} className="tl-line" style={{ left: x(m.start) }} />
            ))}
            {todayN >= from && todayN < from + days && <span className="tl-now" style={{ left: x(todayN + 0.5) }} />}
          </div>
          {projects.length === 0 && <p className="tl-empty">Add a project in the sidebar, then drag across its row here to plan it.</p>}
          {groups.map((g) => {
            const shut = folded.has(g.id);
            return (
              <section key={g.id} className="tl-group">
                <button
                  type="button"
                  className="tl-group-head"
                  aria-expanded={!shut}
                  onClick={() =>
                    setFolded((f) => {
                      const n = new Set(f);
                      if (n.has(g.id)) n.delete(g.id);
                      else n.add(g.id);
                      return n;
                    })
                  }
                >
                  <span>{g.label}</span>
                  <span className="tl-count">{g.items.length}</span>
                  <LineIcon name={shut ? "chevronRight" : "chevronDown"} size={14} />
                </button>
                {!shut && g.items.map(row)}
              </section>
            );
          })}
        </div>
      </div>
      {menu && menuFor && (
        <div className="tl-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 230), top: Math.min(menu.y, window.innerHeight - 200) }}>
          <p className="tl-menu-label">Color</p>
          <div className="tl-swatches" role="radiogroup" aria-label={`${menu.name}'s color`}>
            <button type="button" role="radio" aria-checked={!menuFor.color} aria-label="Default color" className={!menuFor.color ? "tl-swatch pastel on" : "tl-swatch pastel"} onClick={() => onColor(menu.name, null)} />
            {PROJECT_COLORS.map(([c, label]) => (
              <button
                key={c}
                type="button"
                role="radio"
                aria-checked={menuFor.color === c}
                aria-label={label}
                title={label}
                className={menuFor.color === c ? "tl-swatch pastel on" : "tl-swatch pastel"}
                style={{ "--fill": c } as CSSProperties}
                onClick={() => onColor(menu.name, c)}
              />
            ))}
          </div>
          <button type="button" role="menuitem" onClick={() => {
              setMenu(null);
              onOpen(menu.name);
            }}>
            Open project
          </button>
          {spanOf(menuFor) ? (
            <button type="button" role="menuitem" onClick={() => {
                setMenu(null);
                plan(menu.name, null);
              }}>
              Take off the timeline
            </button>
          ) : (
            <button type="button" role="menuitem" onClick={() => {
                setMenu(null);
                plan(menu.name, clickSpan(Math.max(todayN, Math.floor(from))));
              }}>
              Plan from today
            </button>
          )}
        </div>
      )}
    </div>
  );
}
