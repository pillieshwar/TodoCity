import { type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { playDone } from "../lib/doneSound";
import { api, onCalendarChanged } from "../lib/api";
import { useProjectColors } from "../lib/colors";
import { addDays, parseISODate, relativeLabel, toISODate } from "../lib/dates";
import { holidaysByDay } from "../lib/holidays";
import { eventsForDay, hourLabel, planFor } from "../lib/plan";
import { timeLabel } from "../lib/schedule";
import type { TaskActions } from "../lib/taskActions";
import type { TaskDrag } from "../lib/useTaskDrag";
import type { CalendarEvent, NewTask, Task } from "../lib/types";
import { daysForDrag, isSideways, swipeDays } from "../lib/weekSlide";
import { DEFAULT_BLOCK_MIN, MIN_BLOCK_PX, SNAP_MIN, blockFit, drawnLen, durationLabel, endOf, foldBlocks, layoutBlocks, minutesOf, takeDuration, timeOf } from "../lib/timeblock";

/** One hour of the Calendar, in pixels (matches `--wg-hour` in styles.css). */
const HOUR_PX = 52;
/** Any time shows this many a day before "+N more". */
const ANY_SHOWN = 2;
import { NewTaskField } from "./DayPlan";
import { canMove, moved, occurrenceKey, sameTime, stretched } from "../lib/meetingMove";

interface Props {
  tasks: Task[];
  /** The first of the seven days shown. */
  day: string;
  today: string;
  now: Date;
  locale: string;
  actions: TaskActions;
  drag: TaskDrag;
  onAdd: (task: NewTask) => Promise<void>;
  onOpen: (task: Task) => void;
  openId: number | null;
  /** Slide the week by whole days (drag the dates, or swipe sideways). */
  onSlide?: (days: number) => void;
  /** "Moved Design review to 10:30", with Undo. */
  onToast?: (text: string, action?: { label: string; run: () => void }) => void;
  onError?: (text: string) => void;
}

/** Seven days from `day` on: Upcoming looks ahead from today, not back to the week's start. */
export function sevenDays(day: string): string[] {
  const d = parseISODate(day);
  return Array.from({ length: 7 }, (_, i) => toISODate(addDays(d, i)));
}

/** Where the inline new-task field is: a day and an hour, or the day's Any time. */
type AddAt = { iso: string; hour: number | "any"; minute?: number } | null;

/**
 * Full screen's Calendar: the whole week as a calendar. Tasks sit in the
 * hour of their time beside calendar events; untimed ones in Any time. Drag
 * a task to another day or hour, click an empty hour to add one there.
 */
export function WeekGrid({ tasks, day, today, now, locale, actions, drag, onAdd, onOpen, openId, onSlide, onToast, onError }: Props) {
  const colors = useProjectColors();
  const days = sevenDays(day);
  const from = days[0];
  const to = days[6];
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [eventsKey, setEventsKey] = useState(0);
  const [addAt, setAddAt] = useState<AddAt>(null);
  const [completing, setCompleting] = useState<Set<number>>(new Set());
  // Dragging a task's bottom edge: its length so far, in minutes.
  const [resizing, setResizing] = useState<{ id: number; y: number; from: number; to: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // Hovering a block a moment shows its whole title, time and length.
  const [peek, setPeek] = useState<{ t: Task; x: number; y: number; below: boolean } | null>(null);
  const peekTimer = useRef(0);
  const peekOn = (t: Task, el: HTMLElement) => {
    window.clearTimeout(peekTimer.current);
    peekTimer.current = window.setTimeout(() => {
      const r = el.getBoundingClientRect();
      const below = r.bottom + 120 < window.innerHeight;
      setPeek({ t, x: Math.min(r.left, window.innerWidth - 300), y: below ? r.bottom + 6 : r.top - 6, below });
    }, 350);
  };
  const peekOff = () => {
    window.clearTimeout(peekTimer.current);
    setPeek(null);
  };
  useEffect(() => () => window.clearTimeout(peekTimer.current), []);
  // Any time shows two a day until it's opened up.
  const [anyOpen, setAnyOpen] = useState(false);
  const over = drag.drag?.over;
  // Sliding the week a day at a time keeps the hours where they are.
  const slid = useRef(false);
  const [sliding, setSliding] = useState(false);
  const slide = useRef<{ x: number; moved: number; width: number } | null>(null);
  const onSlideRef = useRef(onSlide);
  onSlideRef.current = onSlide;
  const move = (n: number) => {
    if (!n || !onSlideRef.current) return;
    slid.current = true;
    onSlideRef.current(n);
  };

  // A two-finger sideways swipe slides the week too.
  useEffect(() => {
    const el = gridRef.current;
    if (!el) return;
    let gathered = 0;
    let idle = 0;
    const wheel = (e: WheelEvent) => {
      if (!onSlideRef.current || !isSideways(e.deltaX, e.deltaY)) return;
      window.clearTimeout(idle);
      idle = window.setTimeout(() => (gathered = 0), 250);
      const r = swipeDays(gathered, e.deltaX, 70);
      gathered = r.left;
      move(r.days);
    };
    el.addEventListener("wheel", wheel, { passive: true });
    return () => {
      el.removeEventListener("wheel", wheel);
      window.clearTimeout(idle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let live = true;
    api
      .calendarEvents(from, to)
      .then((e) => live && setEvents(e))
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [from, to, eventsKey]);
  useEffect(() => {
    const sub = onCalendarChanged(() => setEventsKey((k) => k + 1));
    return () => void sub.then((u) => u());
  }, []);

  // Dragging a meeting (to another time or day) or its bottom edge (its length).
  const [evDrag, setEvDrag] = useState<{ ev: CalendarEvent; mode: "move" | "stretch"; x: number; y: number; colW: number; preview: CalendarEvent } | null>(null);
  // A meeting with guests waits for "Move for everyone?".
  const [askMove, setAskMove] = useState<{ from: CalendarEvent; to: CalendarEvent } | null>(null);
  const replaceEvent = (from: CalendarEvent, to: CalendarEvent) =>
    setEvents((es) => es.map((e) => (occurrenceKey(e) === occurrenceKey(from) ? to : e)));
  const moveLabel = (e: CalendarEvent) =>
    `${e.start.slice(0, 10) === today ? "" : `${weekdayLong.format(parseISODate(e.start.slice(0, 10)))} `}${timeLabel(e.start.slice(11, 16), locale)}`;
  /** Save a meeting's new time in Calendar; Undo puts it back. */
  const saveMove = (from: CalendarEvent, to: CalendarEvent, undoable = true) => {
    replaceEvent(from, to);
    void api
      .calendarMoveEvent({ id: from.id, at: from.start, start: to.start, end: to.end, everyone: from.movable === "everyone" })
      .then((saved) => {
        replaceEvent(to, saved);
        if (undoable)
          onToast?.(`Moved “${from.title || "Busy"}” to ${moveLabel(saved)}`, { label: "Undo", run: () => saveMove(saved, from, false) });
      })
      .catch((err) => {
        replaceEvent(to, from);
        onError?.(String(err));
      });
  };
  useEffect(() => {
    if (!evDrag) return;
    const moveTo = (e: PointerEvent) => {
      const mins = ((e.clientY - evDrag.y) / HOUR_PX) * 60;
      let preview: CalendarEvent;
      if (evDrag.mode === "stretch") preview = stretched(evDrag.ev, mins);
      else {
        // Stays within the week on screen.
        const at = days.indexOf(evDrag.ev.start.slice(0, 10));
        const want = Math.round((e.clientX - evDrag.x) / evDrag.colW);
        preview = moved(evDrag.ev, at < 0 ? 0 : Math.max(-at, Math.min(6 - at, want)), mins);
      }
      setEvDrag((d) => (d && !sameTime(d.preview, preview) ? { ...d, preview } : d));
    };
    const drop = () => {
      const d = evDrag;
      setEvDrag(null);
      if (sameTime(d.ev, d.preview)) return;
      if (d.ev.movable === "everyone") setAskMove({ from: d.ev, to: d.preview });
      else saveMove(d.ev, d.preview);
    };
    const cancel = () => setEvDrag(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && cancel();
    window.addEventListener("pointermove", moveTo);
    window.addEventListener("pointerup", drop);
    window.addEventListener("pointercancel", cancel);
    window.addEventListener("keydown", key);
    return () => {
      window.removeEventListener("pointermove", moveTo);
      window.removeEventListener("pointerup", drop);
      window.removeEventListener("pointercancel", cancel);
      window.removeEventListener("keydown", key);
    };
    // Re-bound only when a drag starts or ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [evDrag?.ev, evDrag?.mode]);
  const startEvDrag = (e: ReactPointerEvent<HTMLElement>, ev: CalendarEvent, mode: "move" | "stretch") => {
    if (e.button !== 0 || !canMove(ev)) return;
    e.preventDefault();
    e.stopPropagation();
    const lane = (e.currentTarget.closest(".wg-lane") as HTMLElement | null) ?? e.currentTarget;
    setEvDrag({ ev, mode, x: e.clientX, y: e.clientY, colW: lane.getBoundingClientRect().width || 1, preview: ev });
  };
  const shownEvents = useMemo(
    () => (evDrag ? events.map((e) => (occurrenceKey(e) === occurrenceKey(evDrag.ev) ? evDrag.preview : e)) : events),
    [events, evDrag],
  );

  const cols = useMemo(
    () => days.map((iso) => ({ iso, plan: planFor(tasks, iso, today), evs: eventsForDay(shownEvents, iso) })),
    // `days` is derived from `from`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, shownEvents, from, today],
  );
  const holidays = useMemo(() => holidaysByDay(events, from, to), [events, from, to]);
  // The whole day, midnight to 11 PM: scrolling never runs out of hours, so
  // the calendar always reaches the bottom of the window.
  const hours = useMemo(() => Array.from({ length: 24 }, (_, i) => i), []);

  // Open on the morning (or now, this week).
  useEffect(() => {
    const box = bodyRef.current;
    if (!box) return;
    setAddAt(null);
    if (slid.current) {
      slid.current = false;
      return;
    }
    const target = days.includes(today) ? Math.max(now.getHours() - 2, hours[0]) : Math.max(8, hours[0]);
    const row = box.querySelector<HTMLElement>(`[data-row="${target}"]`);
    box.scrollTop = row ? row.offsetTop : 0;
    // Only when the week changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from]);

  const weekday = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "short" }), [locale]);
  const weekdayLong = useMemo(() => new Intl.DateTimeFormat(locale, { weekday: "long" }), [locale]);

  function complete(t: Task) {
    playDone(t.id);
    setCompleting((s) => new Set(s).add(t.id));
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => {
      void actions.setDone(t, true).finally(() =>
        setCompleting((s) => {
          const n = new Set(s);
          n.delete(t.id);
          return n;
        }),
      );
    }, reduce ? 0 : 380);
  }

  const chip = (t: Task, iso: string) => {
    const late = t.due_date !== iso;
    const odd = t.due_time && !t.due_time.endsWith(":00");
    return (
      <div
        key={t.id}
        className={[
          "wg-task",
          late ? "late" : "",
          t.deadline && t.deadline <= iso ? "deadline" : "",
          completing.has(t.id) ? "completing" : "",
          openId === t.id ? "picked" : "",
          drag.drag?.task.id === t.id ? "lifted" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={t.project && colors[t.project] ? ({ "--pc": colors[t.project] } as CSSProperties) : undefined}
        onPointerDown={(e) => drag.start(e, t)}
      >
        <button type="button" className="plan-check" data-nodrag onClick={() => complete(t)} aria-label={`Mark “${t.title}” done`}>
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6">
            <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button type="button" className="wg-title" onClick={() => !drag.wasDrag() && onOpen(t)} title={`${t.title}\nDrag to another hour or day`}>
          {odd && <span className="wg-time">{timeLabel(t.due_time!, locale)} </span>}
          {t.title}
          {late && t.due_date && <span className="wg-late"> · {relativeLabel(t.due_date, now, locale)}</span>}
        </button>
      </div>
    );
  };

  /** A task at its real time and length in the hours; its label fits its height. */
  const taskBlock = (t: Task, iso: string, top: number, height: number, left: string, width: string) => {
    const end = endOf(t.due_time!, t.duration);
    const span = `${timeLabel(t.due_time!, locale)}${end ? ` – ${timeLabel(end, locale)}` : ""}`;
    const fit = blockFit(height);
    return (
      <div
        key={t.id}
        className={[
          "wg-task",
          "wg-block",
          `fit-${fit}`,
          fit === "line" ? "tiny" : "",
          t.deadline && t.deadline <= iso ? "deadline" : "",
          completing.has(t.id) ? "completing" : "",
          openId === t.id ? "picked" : "",
          drag.drag?.task.id === t.id ? "lifted" : "",
          resizing?.id === t.id ? "resizing" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{ top, height, left, width, ...(t.project && colors[t.project] ? { "--pc": colors[t.project] } : {}) } as CSSProperties}
        onPointerDown={(e) => {
          peekOff();
          drag.start(e, t);
        }}
        onMouseEnter={(e) => peekOn(t, e.currentTarget)}
        onMouseLeave={peekOff}
      >
        <button type="button" className="plan-check" data-nodrag onClick={() => complete(t)} aria-label={`Mark “${t.title}” done`}>
          <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6">
            <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          className="wg-title"
          onClick={() => !drag.wasDrag() && onOpen(t)}
          aria-label={`${t.title}, ${span}${t.duration ? `, ${durationLabel(t.duration)}` : ""}`}
        >
          {fit === "line" ? (
            // One line: the title fades out, the time shows if there's room.
            <>
              <span className="wg-t">{t.title}</span>
              <span className="wg-at">{timeLabel(t.due_time!, locale)}</span>
            </>
          ) : (
            <>
              <span className="wg-t">{t.title}</span>
              <span className="wg-span">{span}</span>
            </>
          )}
        </button>
        <span
          className="wg-resize"
          data-nodrag
          aria-hidden
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            setResizing({ id: t.id, y: e.clientY, from: t.duration ?? DEFAULT_BLOCK_MIN, to: t.duration ?? DEFAULT_BLOCK_MIN });
          }}
          onPointerMove={(e) => {
            if (!resizing || resizing.id !== t.id) return;
            const raw = resizing.from + ((e.clientY - resizing.y) / HOUR_PX) * 60;
            const max = 24 * 60 - minutesOf(t.due_time!);
            const to = Math.max(SNAP_MIN, Math.min(max, Math.round(raw / SNAP_MIN) * SNAP_MIN));
            if (to !== resizing.to) setResizing({ ...resizing, to });
          }}
          onPointerUp={() => {
            if (resizing && resizing.id === t.id && resizing.to !== t.duration) void actions.update(t, { duration: resizing.to });
            setResizing(null);
          }}
          onPointerCancel={() => setResizing(null)}
        />
      </div>
    );
  };

  /** A calendar event at its real time and length in the hours. Yours (and ones you organize) drag to a new time. */
  const eventBlock = (e: CalendarEvent, iso: string, top: number, height: number, left: string, width: string) => {
    const movable = canMove(e);
    const lifted = !!evDrag && occurrenceKey(evDrag.preview) === occurrenceKey(e);
    const span = `${e.start.slice(0, 10) < iso ? "until " : ""}${timeLabel(e.start.slice(11, 16), locale)} – ${timeLabel(e.end.slice(11, 16), locale)}`;
    return (
      <div
        key={occurrenceKey(e)}
        className={["wg-event", "wg-block", height < 34 ? "tiny" : "", movable ? "movable" : "", lifted ? "lifted" : ""].filter(Boolean).join(" ")}
        style={{ top, height, left, width, "--ev": e.color ?? "var(--faint)" } as CSSProperties}
        title={`${e.title || "Busy"} · ${span} · ${e.calendar}${movable ? (e.movable === "everyone" ? "\nDrag to move it for everyone" : "\nDrag to move it") : ""}`}
        onPointerDown={movable ? (ev) => startEvDrag(ev, e, "move") : undefined}
      >
        <span className="wg-event-title">{e.title || "Busy"}</span>
        {(height >= 34 || lifted) && <span className="wg-event-time">{span}</span>}
        {movable && <span className="wg-resize" aria-hidden onPointerDown={(ev) => startEvDrag(ev, e, "stretch")} />}
      </div>
    );
  };

  /** Everything timed on one day, placed: tasks and events side by side where they overlap. */
  const lane = (iso: string, tasksAt: Task[], eventsAt: CalendarEvent[]) => {
    const dayStart = `${iso}T00:00`;
    const nextDay = toISODate(addDays(parseISODate(iso), 1));
    const items: { key: string; start: number; len: number; draw: (top: number, h: number, l: string, w: string) => ReactNode }[] = [];
    for (const t of tasksAt) {
      const start = minutesOf(t.due_time!);
      const shown = resizing?.id === t.id ? resizing.to : (t.duration ?? DEFAULT_BLOCK_MIN);
      items.push({ key: `t${t.id}`, start, len: Math.min(shown, 24 * 60 - start), draw: (top, h, l, w) => taskBlock(t, iso, top, h, l, w) });
    }
    for (const e of eventsAt) {
      const s = e.start.slice(0, 16);
      const en = e.end.slice(0, 16);
      const start = s < dayStart ? 0 : minutesOf(s.slice(11, 16));
      const end = en.slice(0, 10) >= nextDay ? 24 * 60 : minutesOf(en.slice(11, 16));
      items.push({ key: `e${e.id}${e.start}`, start, len: Math.max(end - start, 15), draw: (top, h, l, w) => eventBlock(e, iso, top, h, l, w) });
    }
    // Laid out at the height they're drawn, so short ones don't hide under the next.
    const blocks = items.map((it) => ({ key: it.key, start: it.start, len: drawnLen(it.len, HOUR_PX) }));
    const { shown, folds } = foldBlocks(blocks, layoutBlocks(blocks), 2);
    const drawn: ReactNode[] = items.flatMap((it) => {
      const p = shown.get(it.key);
      if (!p) return [];
      const top = (it.start / 60) * HOUR_PX + 1;
      const height = Math.max((it.len / 60) * HOUR_PX - 2, MIN_BLOCK_PX);
      const w = 100 / p.cols;
      return [it.draw(top, height, `calc(${p.col * w}% + 3px)`, `calc(${w}% - 6px)`)];
    });
    // A crowded hour: the rest as "+N", which opens the first of them.
    for (const f of folds) {
      const hidden = f.keys.flatMap((k) => tasksAt.filter((t) => `t${t.id}` === k));
      const names = f.keys
        .map((k) => tasksAt.find((t) => `t${t.id}` === k)?.title ?? eventsAt.find((e) => `e${e.id}${e.start}` === k)?.title)
        .filter(Boolean)
        .join("\n");
      drawn.push(
        <button
          key={`fold${f.start}`}
          type="button"
          className="wg-fold wg-block"
          style={{ top: (f.start / 60) * HOUR_PX + 1, height: MIN_BLOCK_PX, left: "calc(50% + 3px)", width: "calc(50% - 6px)" }}
          title={names}
          aria-label={`${f.keys.length} more: ${names.replace(/\n/g, ", ")}`}
          onClick={() => hidden[0] && onOpen(hidden[0])}
        >
          +{f.keys.length}
        </button>,
      );
    }
    return drawn;
  };

  const eventChip = (e: CalendarEvent, iso: string) => {
    const at = e.all_day
      ? null
      : e.start.slice(0, 10) < iso
        ? `until ${timeLabel(e.end.slice(11, 16), locale)}`
        : `${timeLabel(e.start.slice(11, 16), locale)} – ${timeLabel(e.end.slice(11, 16), locale)}`;
    return (
      <div
        key={`${e.id}${e.start}`}
        className="wg-event"
        style={{ "--ev": e.color ?? "var(--faint)" } as CSSProperties}
        title={`${e.title || "Busy"}${at ? ` · ${at}` : ""} · ${e.calendar}`}
      >
        <span className="wg-event-title">{e.title || "Busy"}</span>
        {at && <span className="wg-event-time">{at}</span>}
      </div>
    );
  };

  const field = (iso: string, hour: number | "any", minute = 0) => {
    const at = hour === "any" ? null : timeOf(hour * 60 + minute);
    return (
      <NewTaskField
        placeholder={at === null ? "New task…" : `New task at ${timeLabel(at, locale)}…`}
        onDone={async (typed) => {
          setAddAt(null);
          // "Stand-up for 7 min": the length comes off the title.
          const { minutes, rest } = takeDuration(typed ?? "");
          const title = rest || typed;
          if (!title) return;
          await onAdd({
            title,
            due_date: iso,
            due_time: at,
            duration: at === null ? null : minutes,
            source_text: null,
          });
        }}
      />
    );
  };

  const nowHour = now.getHours();
  return (
    <div className={evDrag ? "week-grid moving-event" : "week-grid"} ref={gridRef}>
      {askMove && (
        <MoveForEveryone
          title={askMove.from.title || "Busy"}
          when={moveLabel(askMove.to)}
          onCancel={() => setAskMove(null)}
          onMove={() => {
            saveMove(askMove.from, askMove.to);
            setAskMove(null);
          }}
        />
      )}
      {peek && (
        <div className={peek.below ? "wg-peek" : "wg-peek above"} role="tooltip" style={{ left: peek.x, top: peek.y }}>
          <b>{peek.t.title}</b>
          <span>
            {relativeLabel(peek.t.due_date ?? today, now, locale)} · {timeLabel(peek.t.due_time!, locale)}
            {peek.t.duration ? ` – ${timeLabel(endOf(peek.t.due_time!, peek.t.duration)!, locale)} · ${durationLabel(peek.t.duration)}` : ""}
          </span>
          {peek.t.project && <span>{peek.t.heading ? `${peek.t.project} · ${peek.t.heading}` : peek.t.project}</span>}
        </div>
      )}
      <div
        className={["wg-row wg-days", onSlide ? "slidable" : "", sliding ? "sliding" : ""].filter(Boolean).join(" ")}
        title={onSlide ? "Drag the dates sideways to move a day at a time" : undefined}
        onPointerDown={(e) => {
          if (!onSlide || e.button !== 0 || drag.drag) return;
          const row = e.currentTarget.getBoundingClientRect();
          const gutter = (e.currentTarget.firstElementChild as HTMLElement | null)?.getBoundingClientRect().width ?? 0;
          slide.current = { x: e.clientX, moved: 0, width: (row.width - gutter) / 7 };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const s = slide.current;
          if (!s) return;
          const want = daysForDrag(e.clientX - s.x, s.width);
          if (want !== s.moved) {
            setSliding(true);
            move(want - s.moved);
            s.moved = want;
          }
        }}
        onPointerUp={() => {
          slide.current = null;
          setSliding(false);
        }}
        onPointerCancel={() => {
          slide.current = null;
          setSliding(false);
        }}
      >
        <span />
        {cols.map(({ iso }) => {
          const d = parseISODate(iso);
          const hol = holidays.get(iso);
          return (
            <div
              key={iso}
              className={["wg-day", iso === today ? "today" : "", iso < today ? "past" : "", over?.iso === iso && over.hour === undefined ? "drop" : ""]
                .filter(Boolean)
                .join(" ")}
              data-iso={iso}
              title={hol?.join(", ")}
            >
              <span className="wg-dow">{weekday.format(d)}</span>
              <span className="wg-num">{d.getDate()}</span>
              {hol && <span className="wg-hol" aria-label={hol.join(", ")} />}
            </div>
          );
        })}
      </div>
      <div className="wg-row wg-any">
        <span className="wg-hour">Any time</span>
        {cols.map(({ iso, plan, evs }) => (
          <div
            key={iso}
            className={["wg-cell", iso === today ? "today" : "", over?.iso === iso && over.hour === null ? "drop" : ""].filter(Boolean).join(" ")}
            data-iso={iso}
            data-hour="any"
            onClick={(e) => {
              if (e.target === e.currentTarget && !addAt) setAddAt({ iso, hour: "any" });
            }}
          >
            {(() => {
              // Two a day, then "+N more", so the hours stay in view.
              const all = [...evs.allDay.map((e) => eventChip(e, iso)), ...plan.anytime.map((t) => chip(t, iso))];
              const extra = all.length - ANY_SHOWN;
              if (anyOpen || extra <= 1) return all;
              return [
                ...all.slice(0, ANY_SHOWN),
                <button key="more" type="button" className="wg-more" onClick={() => setAnyOpen(true)}>
                  +{extra} more
                </button>,
              ];
            })()}
            {anyOpen && iso === days[0] && cols.some((c) => c.evs.allDay.length + c.plan.anytime.length > ANY_SHOWN + 1) && (
              <button type="button" className="wg-more" onClick={() => setAnyOpen(false)}>
                Show less
              </button>
            )}
            {addAt?.iso === iso && addAt.hour === "any" && field(iso, "any")}
          </div>
        ))}
      </div>
      <div className="wg-body" ref={bodyRef} data-autoscroll>
        <div className="wg-hours">
          {hours.map((h) => (
            <div key={h} className="wg-row" data-row={h}>
              <span className="wg-hour">{hourLabel(h, locale)}</span>
              {cols.map(({ iso }) => {
                const isToday = iso === today;
                const past = iso < today || (isToday && h < nowHour);
                const dropHere = over?.iso === iso && over.hour === h;
                return (
                  <div
                    key={iso}
                    className={["wg-cell", isToday ? "today" : "", past ? "past" : "", dropHere ? "drop" : ""].filter(Boolean).join(" ")}
                    data-iso={iso}
                    data-hour={h}
                    data-minutes
                    onClick={(e) => {
                      if (e.target !== e.currentTarget || addAt) return;
                      // Where in the hour you clicked, to the nearest 5 minutes.
                      const r = e.currentTarget.getBoundingClientRect();
                      const m = Math.min(55, Math.round((((e.clientY - r.top) / r.height) * 60) / SNAP_MIN) * SNAP_MIN);
                      setAddAt({ iso, hour: h, minute: m });
                    }}
                  >
                    {dropHere && over?.minute !== undefined && (
                      <span className="wg-drop-at" style={{ top: `${(over.minute / 60) * 100}%` }}>
                        {timeLabel(timeOf(h * 60 + over.minute), locale)}
                      </span>
                    )}
                    {addAt?.iso === iso && addAt.hour === h && field(iso, h, addAt.minute)}
                    {isToday && h === nowHour && <span className="plan-now" style={{ top: `${(now.getMinutes() / 60) * 100}%` }} aria-hidden />}
                  </div>
                );
              })}
            </div>
          ))}
          <div className="wg-layer" aria-hidden={false}>
            <span />
            {cols.map(({ iso, plan, evs }) => (
              <div key={iso} className="wg-lane">
                {lane(
                  iso,
                  [...plan.byHour.values()].flat(),
                  [...evs.byHour.values()].flat(),
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** A meeting with guests: moving it sends them the new time. */
function MoveForEveryone({ title, when, onCancel, onMove }: { title: string; when: string; onCancel: () => void; onMove: () => void }) {
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    go.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onCancel]);
  return (
    <div className="who-scrim" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="who-dialog move-dialog" role="dialog" aria-modal="true" aria-labelledby="move-dialog-title">
        <h2 id="move-dialog-title">Move “{title}” for everyone?</h2>
        <p>It moves to {when}, and Calendar sends your guests the new time.</p>
        <div className="who-dialog-actions">
          <button type="button" className="ghost" onClick={onCancel}>
            Keep the time
          </button>
          <button type="button" className="primary" ref={go} onClick={onMove}>
            Move for everyone
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Beside the week: tasks with no date yet, to drag onto a day or an hour,
 * and the deadlines coming up this week.
 */
export function WeekSide({
  tasks,
  days,
  today,
  now,
  locale,
  drag,
  onOpen,
  month,
}: {
  tasks: Task[];
  days: string[];
  today: string;
  now: Date;
  locale: string;
  drag: TaskDrag;
  onOpen: (task: Task) => void;
  /** The month at a glance, above the rest. */
  month?: ReactNode;
}) {
  const undated = tasks.filter((t) => !t.done && !t.due_date && !t.someday && !t.paused);
  const deadlines = tasks
    .filter((t) => !t.done && t.deadline && t.deadline >= days[0] && t.deadline <= days[6])
    .sort((a, b) => (a.deadline ?? "").localeCompare(b.deadline ?? ""));
  return (
    <aside className="side-pane week-side" aria-label="Not planned yet">
      {month}
      <div className="sp-head">
        <span className="sp-title">No date yet</span>
        <span className="sp-count">{undated.length}</span>
      </div>
      <div className="sp-body" data-autoscroll>
        <p className="sp-hint">Drag onto a day or an hour to plan it.</p>
        {undated.length === 0 && <p className="sp-empty">Everything has a day.</p>}
        {undated.map((t) => (
          <div
            key={t.id}
            className={drag.drag?.task.id === t.id ? "ws-card lifted" : "ws-card"}
            onPointerDown={(e) => drag.start(e, t)}
          >
            <button type="button" className="ws-title" onClick={() => !drag.wasDrag() && onOpen(t)}>
              {t.title}
            </button>
            {t.project && <span className="ws-meta">{t.project}</span>}
          </div>
        ))}
        {deadlines.length > 0 && (
          <>
            <h3 className="sp-sub">Deadlines this week</h3>
            {deadlines.map((t) => (
              <button key={t.id} type="button" className="ws-deadline" onClick={() => onOpen(t)}>
                <span>{t.title}</span>
                <span className={t.deadline! <= today ? "late" : ""}>{relativeLabel(t.deadline!, now, locale)}</span>
              </button>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}
