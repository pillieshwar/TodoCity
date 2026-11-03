import type { DayCell } from "./calendar";
import { addDays, parseISODate, toISODate } from "./dates";
import { effectiveDay } from "./lists";
import type { Task } from "./types";

/**
 * `rows` weeks starting with the week that contains `anchor`. Cells are
 * "in month" when they share the anchor's month, so the strip dims days that
 * spill into the next month.
 */
export function weekRows(anchor: string, weekStart: number, rows: number): DayCell[] {
  const a = parseISODate(anchor);
  const lead = (a.getDay() - weekStart + 7) % 7;
  const start = addDays(a, -lead);
  return Array.from({ length: rows * 7 }, (_, i) => {
    const d = addDays(start, i);
    return { iso: toISODate(d), day: d.getDate(), inMonth: d.getMonth() === a.getMonth() };
  });
}

export interface DayMark {
  /** Open tasks due that day. */
  open: number;
  /** Open tasks due that day, and the day has passed. */
  overdue: boolean;
}

/** Per-day marks for the calendar dots. */
export function dayMarks(tasks: Task[], today: string): Map<string, DayMark> {
  const marks = new Map<string, DayMark>();
  for (const t of tasks) {
    if (t.done || !t.due_date || t.paused) continue;
    const m = marks.get(t.due_date) ?? { open: 0, overdue: false };
    m.open += 1;
    m.overdue = t.due_date < today;
    marks.set(t.due_date, m);
  }
  return marks;
}

export interface Agenda {
  /** Open tasks from earlier days — shown only on today's agenda. */
  overdue: Task[];
  /** Open tasks due on the selected day. */
  due: Task[];
  /** Tasks due on the selected day that are already done. */
  done: Task[];
}

const byCreated = (a: Task, b: Task) => a.created_at.localeCompare(b.created_at);

export function agendaFor(tasks: Task[], selected: string, today: string): Agenda {
  // A deadline that has come pulls a later-planned task to today.
  const day = (t: Task) => (t.paused ? null : effectiveDay(t, today));
  const overdue =
    selected === today
      ? tasks
          .filter((t) => {
            const d = day(t);
            return !t.done && d !== null && d < today;
          })
          .sort((a, b) => (day(a) ?? "").localeCompare(day(b) ?? "") || byCreated(a, b))
      : [];
  // Evening tasks after the rest of the day.
  const due = tasks
    .filter((t) => !t.done && day(t) === selected)
    .sort((a, b) => Number(!!a.evening) - Number(!!b.evening) || byCreated(a, b));
  const done = tasks
    .filter((t) => t.done && t.due_date === selected)
    .sort((a, b) => (a.completed_at ?? "").localeCompare(b.completed_at ?? ""));
  return { overdue, due, done };
}

/** Open tasks with no date (they never appear on the calendar). */
export function undatedCount(tasks: Task[]): number {
  return tasks.filter((t) => !t.done && !t.due_date).length;
}

/** "Today · Wednesday, October 14" / "Tomorrow · …" / "Friday, October 16". */
export function agendaHeading(selected: string, today: string, locale: string): { lead: string | null; date: string } {
  const d = parseISODate(selected);
  const date = d.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" });
  const diff = Math.round((d.getTime() - parseISODate(today).getTime()) / 86_400_000);
  const lead = diff === 0 ? "Today" : diff === 1 ? "Tomorrow" : diff === -1 ? "Yesterday" : null;
  return { lead, date };
}

/** "2 days overdue", "Overdue since Mon" — short label for an overdue task. */
export function overdueLabel(due: string, today: string): string {
  const days = Math.round((parseISODate(today).getTime() - parseISODate(due).getTime()) / 86_400_000);
  if (days <= 1) return "Yesterday";
  return `${days} days overdue`;
}

/**
 * The label for a task in the overdue list. A task can be there because its
 * deadline passed, with no day set (or a later one), so it counts from the
 * same day the list does.
 */
export function overdueTaskLabel(t: Task, today: string): string {
  const day = effectiveDay(t, today) ?? today;
  const label = overdueLabel(day, today);
  return day === t.deadline && day !== t.due_date ? `Deadline · ${label.toLowerCase()}` : label;
}
