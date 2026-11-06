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
import type { FloorSummary, ProjectSummary } from "../lib/types";
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

// `name` is an item's key: a project's name, or "<project>␟<section>".
type Drag =
  | { kind: "bar"; name: string; mode: "move" | "start" | "end"; x0: number; base: Span; by: number; moved: boolean }
  | { kind: "draw"; name: string; a: number; b: number; x0: number; moved: boolean };

const SEP = "\u001f";
/** A row on the Timeline: a project, or one of its sections given its own bar. */
interface Item {
  key: string;
  project: string;
  section: string | null;
  color: string | null;
  open: number;
  done: number;
  saved: Span | null;
}
const savedSpan = (x: { plan_start?: string | null; plan_end?: string | null }): Span | null =>
  x.plan_start && x.plan_end ? { start: x.plan_start, end: x.plan_end } : null;

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
  sections = [],
  today,
  locale,
  onOpen,
  onPlan,
  onPlanSection,
  onColor,
}: {
  projects: ProjectSummary[];
  /** Every section, to pick from; those with a span get their own bar under their project. */
  sections?: FloorSummary[];
  today: string;
  locale: string;
  onOpen: (name: string) => void;
  onPlan: (name: string, span: Span | null) => Promise<void>;
  onPlanSection: (project: string, section: string, span: Span | null) => Promise<void>;
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

  // Every row: projects, and the sections given their own bars.
  const items = useMemo(() => {
    const out = new Map<string, Item>();
    for (const p of projects) out.set(p.name, { key: p.name, project: p.name, section: null, color: p.color ?? null, open: p.open, done: p.done, saved: savedSpan(p) });
    for (const f of sections) {
      const key = `${f.project}${SEP}${f.name}`;
      out.set(key, { key, project: f.project, section: f.name, color: out.get(f.project)?.color ?? null, open: f.open, done: f.done, saved: savedSpan(f) });
    }
    return out;
  }, [projects, sections]);

  // Changes shown at once, before the saved ones come back.
  const [pending, setPending] = useState<Map<string, Span | null>>(new Map());
  useEffect(() => {
    setPending((m) => {
      if (!m.size) return m;
      const n = new Map(m);
      for (const [key, s] of m) {
        const it = items.get(key);
        const now = it?.saved ?? null;
        if (!it || (now?.start === s?.start && now?.end === s?.end)) n.delete(key);
      }
      return n.size === m.size ? m : n;
    });
  }, [items]);
  const plan = (key: string, s: Span | null) => {
    const it = items.get(key);
    if (!it) return;
    setPending((m) => new Map(m).set(key, s));
    const saving = it.section === null ? onPlan(it.project, s) : onPlanSection(it.project, it.section, s);
    void saving.catch(() =>
      setPending((m) => {
        const n = new Map(m);
        n.delete(key);
        return n;
      }),
    );
  };
  const spanOf = (it: Item): Span | null => (pending.has(it.key) ? pending.get(it.key)! : it.saved);
  const openItem = (key: string) => {
    const it = items.get(key);
    if (it) onOpen(it.project);
  };

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
        if (!d.moved) openItem(d.name);
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
  // The + beside a project: which of its sections get their own bars.
  const [menu, setMenu] = useState<{ name: string; x: number; y: number; kind: "item" | "sections" } | null>(null);
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
  const menuAt = (el: Element, name: string, kind: "item" | "sections") => {
    const r = el.getBoundingClientRect();
    setMenu({ name, x: r.left, y: r.bottom + 6, kind });
  };

  // A project's sections, and those on the Timeline (by when they start).
  const sectionsOf = (project: string) => sections.filter((f) => f.project === project).map((f) => items.get(`${f.project}${SEP}${f.name}`)!);
  const shownSections = (project: string) =>
    sectionsOf(project)
      .filter((it) => spanOf(it))
      .sort((a, b) => spanOf(a)!.start.localeCompare(spanOf(b)!.start) || a.section!.localeCompare(b.section!));
  /** Where a section's bar starts when it's first added: its project's span, or four weeks from today. */
  const firstSpan = (project: string): Span => {
    const p = items.get(project);
    return (p && spanOf(p)) ?? clickSpan(Math.max(dayNum(today), Math.floor(from)));
  };

  const projectItems = projects.map((p) => items.get(p.name)!);
  const planned = projectItems.filter((p) => spanOf(p)).sort((a, b) => spanOf(a)!.start.localeCompare(spanOf(b)!.start) || a.project.localeCompare(b.project));
  const unplanned = projectItems.filter((p) => !spanOf(p)).sort((a, b) => a.project.localeCompare(b.project));
  const groups = [
    { id: "planned", label: "On the timeline", items: planned },
    { id: "unplanned", label: "Not planned yet", items: unplanned },
  ].filter((g) => g.items.length);

  const months = useMemo(() => monthsIn(from, days), [from, days]);
  const todayN = dayNum(today);
  const x = (n: number) => (n - from) * ppd;
  const monthFmt = useMemo(() => new Intl.DateTimeFormat(locale, { month: "short" }), [locale]);

  const bar = (it: Item) => {
    const base = spanOf(it);
    const label = it.section ?? it.project;
    const live = drag?.kind === "bar" && drag.name === it.key ? dragSpan(drag.base, drag.mode, drag.by) : drag?.kind === "draw" && drag.name === it.key && drag.moved ? drawnSpan(drag.a, drag.b) : base;
    if (!live) return null;
    const at = barPlace(live, from, days, width);
    if (!at.visible) {
      // Off to one side: an arrow that brings it into view.
      const after = dayNum(live.start) >= from + days;
      return (
        <button type="button" className={after ? "tl-off after pastel" : "tl-off before pastel"} style={{ "--fill": it.color ?? undefined } as CSSProperties} onClick={() => goTo(dayNum(live.start) - Math.round(days / 6))} title={`${label}: ${spanLabel(live, today, locale)}`}>
          {after ? "›" : "‹"}
        </button>
      );
    }
    const dragging = drag?.name === it.key && (drag.kind === "draw" || drag.moved);
    const narrow = at.width < (it.section ? 100 : 120);
    const start = (mode: "move" | "start" | "end") => (e: ReactPointerEvent) => {
      if (e.button !== 0 || !base) return;
      e.preventDefault();
      e.stopPropagation();
      cancelAnimationFrame(glide.current);
      setMenu(null);
      setDrag({ kind: "bar", name: it.key, mode, x0: e.clientX, base, by: 0, moved: false });
    };
    return (
      <div
        className={["tl-item pastel", it.section !== null ? "section" : "", at.cutStart ? "cut-start" : "", at.cutEnd ? "cut-end" : "", narrow ? "narrow" : "", dragging ? "dragging" : ""].filter(Boolean).join(" ")}
        style={{ left: at.left, width: Math.max(at.width, 6), "--fill": it.color ?? undefined } as CSSProperties}
        data-project={it.section === null ? it.project : undefined}
        data-section={it.section ?? undefined}
        role="button"
        tabIndex={0}
        aria-label={`${it.section ? `${it.project}: ${it.section}` : it.project}, ${spanLabel(live, today, locale)}. Enter opens it; arrows move it, Option-arrows change its end.`}
        onPointerDown={start("move")}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ name: it.key, x: e.clientX, y: e.clientY, kind: "item" });
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") openItem(it.key);
          if (base && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
            e.preventDefault();
            const by = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 7 : 1);
            plan(it.key, dragSpan(base, e.altKey ? "end" : "move", by));
          }
        }}
      >
        <span className="tl-grip start" onPointerDown={start("start")} aria-hidden />
        <span className="tl-label">
          <Ring done={it.done} total={it.open + it.done} />
          <span className="tl-name">{label}</span>
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

  const due = (it: Item, s: Span) => {
    const late = s.end < today && it.open > 0;
    return (
      <span className={late ? "tl-due late" : "tl-due"} title={`Ends ${spanLabel({ start: s.end, end: s.end }, today, locale)}`}>
        <LineIcon name={late ? "flagFilled" : "flag"} size={13} />
        {fromToday(s.end, today)}
      </span>
    );
  };

  const sectionRow = (it: Item) => {
    const s = spanOf(it)!;
    return (
      <div className="tl-row section" key={it.key}>
        <div className="tl-left">
          <span className="tl-branch pastel" style={{ "--fill": it.color ?? undefined } as CSSProperties} aria-hidden />
          <button type="button" className="tl-open" onClick={() => onOpen(it.project)} title={`Open ${it.project}`}>
            {it.section}
          </button>
          {due(it, s)}
        </div>
        <div className="tl-lane">{bar(it)}</div>
      </div>
    );
  };

  const row = (it: Item) => {
    const s = spanOf(it);
    const subs = shownSections(it.project);
    const picked = subs.length;
    return (
      <div className="tl-family" key={it.key}>
        <div className={s ? "tl-row" : "tl-row unplanned"}>
          <div className="tl-left">
            <button type="button" className="tl-dot pastel" style={{ "--fill": it.color ?? undefined } as CSSProperties} aria-label={`${it.project}'s color`} title="Color" onClick={(e) => menuAt(e.currentTarget, it.key, "item")} />
            <button type="button" className="tl-open" onClick={() => onOpen(it.project)} title={`Open ${it.project}`}>
              {it.project}
            </button>
            <button
              type="button"
              className={picked ? "tl-add has" : "tl-add"}
              aria-label={`Sections of ${it.project} on the timeline`}
              title="Add sections to the timeline"
              onClick={(e) => menuAt(e.currentTarget, it.key, "sections")}
            >
              {picked ? <span className="tl-add-count">{picked}</span> : <LineIcon name="plus" size={13} />}
            </button>
            {s ? due(it, s) : <span className="tl-due hint">Drag to plan</span>}
          </div>
          <div
            className="tl-lane"
            onPointerDown={(e) => {
              if (e.button !== 0 || s || e.target !== e.currentTarget) return;
              e.preventDefault();
              const a = dayAt(e.clientX, e.currentTarget);
              setDrag({ kind: "draw", name: it.key, a, b: a, x0: e.clientX, moved: false });
            }}
          >
            {bar(it)}
          </div>
        </div>
        {subs.map(sectionRow)}
      </div>
    );
  };

  const menuFor = menu ? items.get(menu.name) : null;
  const menuStyle = menu ? { left: Math.min(menu.x, window.innerWidth - 250), top: Math.min(menu.y, window.innerHeight - 260) } : undefined;
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
        <span className="tl-help">Drag a bar to move it, its ends to stretch it. Click to open. + adds sections.</span>
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
      {menu && menuFor && menu.kind === "sections" && (
        <div className="tl-menu tl-sections" role="dialog" aria-label={`Sections of ${menuFor.project}`} style={menuStyle}>
          <p className="tl-menu-label">Sections on the timeline</p>
          {sectionsOf(menuFor.project).length ? (
            sectionsOf(menuFor.project).map((f) => {
              const on = !!spanOf(f);
              return (
                <label key={f.key} className="tl-check">
                  <input type="checkbox" checked={on} onChange={() => plan(f.key, on ? null : firstSpan(f.project))} />
                  <span className="tl-check-name">{f.section}</span>
                  {on && <span className="tl-check-span">{spanLabel(spanOf(f)!, today, locale)}</span>}
                </label>
              );
            })
          ) : (
            <p className="tl-menu-note">Sections you add to {menuFor.project} show up here, ready to plan.</p>
          )}
        </div>
      )}
      {menu && menuFor && menu.kind === "item" && (
        <div className="tl-menu" role="menu" style={menuStyle}>
          {menuFor.section === null && (
            <>
              <p className="tl-menu-label">Color</p>
              <div className="tl-swatches" role="radiogroup" aria-label={`${menuFor.project}'s color`}>
                <button type="button" role="radio" aria-checked={!menuFor.color} aria-label="Default color" className={!menuFor.color ? "tl-swatch pastel on" : "tl-swatch pastel"} onClick={() => onColor(menuFor.project, null)} />
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
                    onClick={() => onColor(menuFor.project, c)}
                  />
                ))}
              </div>
            </>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenu(null);
              onOpen(menuFor.project);
            }}
          >
            Open project
          </button>
          {spanOf(menuFor) ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                plan(menuFor.key, null);
              }}
            >
              Take off the timeline
            </button>
          ) : (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setMenu(null);
                plan(menuFor.key, clickSpan(Math.max(todayN, Math.floor(from))));
              }}
            >
              Plan from today
            </button>
          )}
        </div>
      )}
    </div>
  );
}
