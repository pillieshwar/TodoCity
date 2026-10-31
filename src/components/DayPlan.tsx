import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { playDone } from "../lib/doneSound";
import { eventsForDay, hourLabel, hourRange, planFor } from "../lib/plan";
import { relativeLabel } from "../lib/dates";
import { timeLabel } from "../lib/schedule";
import type { TaskActions } from "../lib/taskActions";
import type { TaskDrag } from "../lib/useTaskDrag";
import type { CalendarEvent, NewTask, Task } from "../lib/types";
import { useProjectColors } from "../lib/colors";

interface Props {
  tasks: Task[];
  day: string;
  today: string;
  now: Date;
  locale: string;
  events: CalendarEvent[];
  actions: TaskActions;
  drag: TaskDrag;
  onAdd: (task: NewTask) => Promise<void>;
  /** Clicking a task's title. */
  onOpen: (task: Task) => void;
  compact?: boolean;
  /** Just the hours: the list beside it shows the untimed tasks. */
  hoursOnly?: boolean;
}

/** Where the inline "new task" field is: an hour, or Anytime. */
type AddAt = number | "any" | null;

/**
 * One day in hour blocks. Tasks sit in the block of their time; untimed ones
 * (and, on today, overdue ones) wait in Anytime. Drag a task to another block,
 * to Anytime, or onto a day; click an empty block to add a task there; tick
 * a task and it leaves the plan.
 */
export function DayPlan({ tasks, day, today, now, locale, events, actions, drag, onAdd, onOpen, compact, hoursOnly }: Props) {
  const colors = useProjectColors();
  const plan = useMemo(() => planFor(tasks, day, today), [tasks, day, today]);
  const evs = useMemo(() => eventsForDay(events, day), [events, day]);
  const hours = useMemo(() => hourRange(plan, evs), [plan, evs]);
  const [addAt, setAddAt] = useState<AddAt>(null);
  const [completing, setCompleting] = useState<Set<number>>(new Set());
  const hoursRef = useRef<HTMLDivElement>(null);
  const isToday = day === today;
  const over = drag.drag?.over;

  // Open on the part of the day that matters: now, or the first block in use.
  useEffect(() => {
    const box = hoursRef.current;
    if (!box) return;
    const first = [...plan.byHour.keys(), ...evs.byHour.keys()].sort((a, b) => a - b)[0];
    const target = isToday ? now.getHours() - 1 : (first ?? 9) - 1;
    const row = box.querySelector<HTMLElement>(`[data-hour="${Math.max(target, hours[0])}"]`);
    box.scrollTop = row ? row.offsetTop : 0;
    setAddAt(null);
    // Only when the day changes, not on every refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day]);

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

  const chip = (t: Task) => {
    const late = t.due_date !== day;
    const odd = t.due_time && !t.due_time.endsWith(":00");
    return (
      <div
        key={t.id}
        className={[
          "plan-task",
          late ? "late" : "",
          completing.has(t.id) ? "completing" : "",
          drag.drag?.task.id === t.id ? "lifted" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={t.project && colors[t.project] ? ({ "--pc": colors[t.project] } as CSSProperties) : undefined}
        onPointerDown={(e) => drag.start(e, t)}
      >
        <button
          type="button"
          className="plan-check"
          data-nodrag
          onClick={() => complete(t)}
          aria-label={`Mark “${t.title}” done`}
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6">
            <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          className="plan-title"
          onClick={() => !drag.wasDrag() && onOpen(t)}
          title={`${t.title}\nDrag to another hour or day`}
        >
          {t.title}
        </button>
        {late && t.due_date && <span className="plan-when late">{relativeLabel(t.due_date, now, locale)}</span>}
        {!late && odd && <span className="plan-when">{timeLabel(t.due_time!, locale)}</span>}
      </div>
    );
  };

  const eventChip = (e: CalendarEvent) => {
    const at = e.all_day
      ? null
      : e.start.slice(0, 10) < day
        ? `until ${timeLabel(e.end.slice(11, 16), locale)}`
        : `${timeLabel(e.start.slice(11, 16), locale)} – ${timeLabel(e.end.slice(11, 16), locale)}`;
    return (
      <div key={`${e.id}${e.start}`} className="plan-event" title={`${e.title || "Busy"}${at ? ` · ${at}` : ""} · ${e.calendar}`}>
        <span className="plan-event-bar" style={{ background: e.color ?? "var(--faint)" }} aria-hidden />
        <span className="plan-event-title">{e.title || "Busy"}</span>
        {at && <span className="plan-event-time">{at}</span>}
      </div>
    );
  };

  const field = (at: Exclude<AddAt, null>) => (
    <NewTaskField
      placeholder={at === "any" ? "Add a task for any time…" : `Add a task at ${hourLabel(at, locale)}…`}
      onDone={async (title) => {
        setAddAt(null);
        if (!title) return;
        await onAdd({
          title,
          due_date: day,
          due_time: at === "any" ? null : `${String(at).padStart(2, "0")}:00`,
          source_text: null,
        });
      }}
    />
  );

  const nowHour = now.getHours();
  return (
    <div className={compact ? "plan compact" : "plan"}>
      {!hoursOnly && (
        <div
          className={["plan-any", over?.iso === day && over.hour === null ? "drop" : ""].filter(Boolean).join(" ")}
          data-iso={day}
          data-hour="any"
        >
          <div className="plan-any-head">
            <span className="plan-label">All day</span>
            {addAt !== "any" && (
              <button type="button" className="plan-add-any" onClick={() => setAddAt("any")} aria-label="Add a task for any time">
                +
              </button>
            )}
          </div>
          {evs.allDay.map(eventChip)}
          {plan.anytime.map(chip)}
          {addAt === "any" && field("any")}
          {plan.anytime.length === 0 && evs.allDay.length === 0 && addAt !== "any" && (
            <p className="plan-hint">{drag.drag ? "Drop here to do it any time" : "Untimed tasks show here"}</p>
          )}
        </div>
      )}
      {hoursOnly && evs.allDay.length > 0 && <div className="plan-any slim">{evs.allDay.map(eventChip)}</div>}

      <div className="plan-hours" ref={hoursRef} data-autoscroll>
        {hours.map((h) => {
          const items = plan.byHour.get(h) ?? [];
          const hEvents = evs.byHour.get(h) ?? [];
          const dropHere = over?.iso === day && over.hour === h;
          const past = day < today || (isToday && h < nowHour);
          return (
            <div
              key={h}
              className={["plan-slot", dropHere ? "drop" : "", past ? "past" : "", isToday && h === nowHour ? "now" : ""]
                .filter(Boolean)
                .join(" ")}
              data-iso={day}
              data-hour={h}
            >
              <span className="plan-hour">{hourLabel(h, locale)}</span>
              <div
                className="plan-cell"
                onClick={(e) => {
                  if (e.target === e.currentTarget && addAt === null) setAddAt(h);
                }}
              >
                {hEvents.map(eventChip)}
                {items.map(chip)}
                {addAt === h ? (
                  field(h)
                ) : (
                  <button
                    type="button"
                    className="plan-add"
                    onClick={() => setAddAt(h)}
                    aria-label={`Add a task at ${hourLabel(h, locale)}`}
                    title={`Add a task at ${hourLabel(h, locale)}`}
                  >
                    +
                  </button>
                )}
              </div>
              {isToday && h === nowHour && (
                <span className="plan-now" style={{ top: `${(now.getMinutes() / 60) * 100}%` }} aria-hidden />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The inline field for a new task: Enter adds, Esc cancels, clicking away keeps what was typed. */
export function NewTaskField({ placeholder, onDone }: { placeholder: string; onDone: (title: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const done = useRef(false);
  const finish = (title: string) => {
    if (done.current) return;
    done.current = true;
    void onDone(title.trim()).catch(() => undefined);
  };
  return (
    <input
      className="plan-input"
      autoFocus
      value={text}
      maxLength={200}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(text);
        if (e.key === "Escape") {
          e.preventDefault();
          finish("");
        }
      }}
      onBlur={() => finish(text)}
    />
  );
}

