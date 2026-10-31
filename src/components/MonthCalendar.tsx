import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { monthGrid, monthLabel, shiftMonth, weekdayLabels } from "../lib/calendar";
import { parseISODate } from "../lib/dates";
import { useProjectColors } from "../lib/colors";
import type { TaskDrag } from "../lib/useTaskDrag";
import { showDragHint } from "../lib/hints";
import type { Task } from "../lib/types";

/**
 * A month at a glance: date numbers, a dot under days that have tasks, and
 * every day a drop target — drag a task onto a date to plan it there (its
 * time stays). Click a date to pick it.
 */
export function MonthCalendar({
  tasks,
  today,
  selected,
  locale,
  weekStart,
  drag,
  onSelect,
  scope,
  weekOnly,
}: {
  tasks: Task[];
  today: string;
  /** The day picked (shown below the calendar). */
  selected: string;
  locale: string;
  weekStart: number;
  drag: TaskDrag;
  onSelect: (iso: string) => void;
  /** Showing one project's (or floor's) tasks only: named in a small chip. */
  scope?: { label: string; color?: string } | null;
  /** Just the picked day's week (Today shows its list beside it). */
  weekOnly?: boolean;
}) {
  const colors = useProjectColors();
  const sel = parseISODate(selected);
  const [ym, setYm] = useState({ year: sel.getFullYear(), month: sel.getMonth() });
  // Follow the picked day into its month.
  useEffect(() => {
    const d = parseISODate(selected);
    setYm((v) => (v.year === d.getFullYear() && v.month === d.getMonth() ? v : { year: d.getFullYear(), month: d.getMonth() }));
  }, [selected]);
  const month = useMemo(() => monthGrid(ym.year, ym.month, weekStart), [ym, weekStart]);
  // Week only: the row with the picked day.
  const cells = useMemo(() => {
    if (!weekOnly) return month;
    const i = month.findIndex((c) => c.iso === selected);
    const row = i < 0 ? 0 : Math.floor(i / 7);
    return month.slice(row * 7, row * 7 + 7);
  }, [month, weekOnly, selected]);
  const labels = useMemo(() => weekdayLabels(locale, weekStart), [locale, weekStart]);
  // Open tasks per day (planned day, or deadline), and whether any is late.
  const byDay = useMemo(() => {
    const m = new Map<string, { n: number; late: boolean; color?: string }>();
    for (const t of tasks) {
      if (t.done || t.someday || t.paused) continue;
      for (const d of new Set([t.due_date, t.deadline].filter((x): x is string => !!x))) {
        const v = m.get(d) ?? { n: 0, late: false };
        v.n += 1;
        if (!v.color && t.project && colors[t.project]) v.color = colors[t.project];
        if (d < today) v.late = true;
        m.set(d, v);
      }
    }
    return m;
  }, [tasks, today, colors]);
  const over = drag.drag?.over;

  return (
    <div className={weekOnly ? "mcal week-only" : "mcal"} aria-label={weekOnly ? "Week" : "Month"} style={scope?.color ? ({ "--pc": scope.color } as CSSProperties) : undefined}>
      {scope && (
        <p className="mcal-scope" title="The calendar and hours here show only this project's tasks">
          <i aria-hidden />
          <span>Only {scope.label}</span>
        </p>
      )}
      <div className="mcal-head">
        <span className="mcal-title">{monthLabel(locale, ym.year, ym.month)}</span>
        {!weekOnly && (
          <button type="button" className="mcal-nav" onClick={() => setYm((v) => shiftMonth(v.year, v.month, -1))} aria-label="Previous month">
            ‹
          </button>
        )}
        <button
          type="button"
          className="mcal-today"
          onClick={() => {
            const d = parseISODate(today);
            setYm({ year: d.getFullYear(), month: d.getMonth() });
            onSelect(today);
          }}
        >
          Today
        </button>
        {!weekOnly && (
          <button type="button" className="mcal-nav" onClick={() => setYm((v) => shiftMonth(v.year, v.month, 1))} aria-label="Next month">
            ›
          </button>
        )}
      </div>
      <div className="mcal-grid" role="grid">
        {labels.map((l, i) => (
          <span key={`w${i}`} className="mcal-dow" aria-hidden>
            {l}
          </span>
        ))}
        {cells.map((c) => {
          const info = byDay.get(c.iso);
          const cls = [
            "mcal-day",
            c.inMonth ? "" : "out",
            c.iso === today ? "today" : "",
            c.iso === selected ? "sel" : "",
            c.iso < today ? "past" : "",
            over?.iso === c.iso && over.hour === undefined ? "drop" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <button
              key={c.iso}
              type="button"
              className={cls}
              data-iso={c.iso}
              onClick={() => onSelect(c.iso)}
              aria-label={`${parseISODate(c.iso).toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" })}${info ? `, ${info.n} ${info.n === 1 ? "task" : "tasks"}` : ""}`}
              aria-pressed={c.iso === selected}
            >
              <span className="mcal-num">{c.day}</span>
              <span
                className={info ? (info.late ? "mcal-dot late" : "mcal-dot") : "mcal-dot none"}
                style={info?.color && !info.late ? { background: info.color } : undefined}
                aria-hidden
              />
            </button>
          );
        })}
      </div>
      {showDragHint(!!drag.drag) && <p className="mcal-hint">Drag a task onto a date to plan it</p>}
    </div>
  );
}
