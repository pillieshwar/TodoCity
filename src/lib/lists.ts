import { addDays, daysBetween, parseISODate, relativeLabel, toISODate } from "./dates";
import type { DayGroup } from "./grouping";
import type { Task } from "./types";

/**
 * Which tasks a list shows: Today, the Calendar, Inbox (tasks in no
 * project), Overdue, Completed (`logbook`), or one project. "all" (Anytime)
 * and "someday" are older lists; they open Inbox now.
 */
export type ListId = "all" | "today" | "upcoming" | "timeline" | "overdue" | "someday" | "logbook" | "inbox" | "agents" | `project:${string}`;

/** Lists that were folded into Inbox (Anytime, Someday). */
export const normalizeList = (id: ListId): ListId => (id === "all" || id === "someday" ? "inbox" : id);

/** A list's name as its title. */
export function listTitle(id: ListId): string {
  return (
    projectOf(id) ??
    { all: "Inbox", inbox: "Inbox", today: "Today", upcoming: "Calendar", timeline: "Timeline", overdue: "Overdue", someday: "Inbox", logbook: "Completed", agents: "With agents" }[id as "all"]
  );
}

export const projectList = (name: string): ListId => `project:${name}`;
export const projectOf = (id: ListId): string | null => (id.startsWith("project:") ? id.slice(8) : null);

/**
 * The day a task counts as due for the list: its planned day — or, when a
 * deadline has come (or passed) before that, the deadline. So a task planned
 * for next week but due today shows up today.
 */
export function effectiveDay(t: Task, today: string): string | null {
  if (t.deadline && t.deadline <= today && (!t.due_date || t.due_date > t.deadline)) return t.deadline;
  return t.due_date;
}

/**
 * Overdue: open tasks whose day or deadline has passed — and today's timed
 * ones whose time has come (`nowTime`, "HH:MM").
 */
export function isOverdue(t: Task, today: string, nowTime?: string): boolean {
  if (t.done || t.someday || t.paused) return false;
  if (t.deadline && t.deadline < today) return true;
  if (!t.due_date) return false;
  if (t.due_date < today) return true;
  return t.due_date === today && !!t.due_time && !!nowTime && t.due_time <= nowTime;
}

/** Tasks for a list (Logbook is loaded separately). */
export function tasksForList(tasks: Task[], list: ListId, today: string, nowTime?: string): Task[] {
  const project = projectOf(list);
  if (project !== null) return tasks.filter((t) => t.project === project);
  if (list === "inbox") return tasks.filter((t) => !t.project);
  if (list === "overdue") return tasks.filter((t) => isOverdue(t, today, nowTime));
  if (list === "someday") return tasks.filter((t) => !t.done && (t.someday || t.paused));
  // With agents: open tasks; the app keeps the ones handed to an agent.
  if (list === "agents") return tasks.filter((t) => !t.done);
  // Someday and paused tasks stay out of the way everywhere else.
  const active = tasks.filter((t) => (!t.someday && !t.paused) || t.done);
  if (list === "today") {
    return active.filter((t) => {
      const d = effectiveDay(t, today);
      return d !== null && d <= today;
    });
  }
  return active;
}

/** "Due Fri" chip for a deadline, toned by how close it is. */
export function deadlineChip(t: Task, now: Date, locale?: string): { label: string; tone: "overdue" | "soon" | "later" } | null {
  if (!t.deadline || t.done) return null;
  const days = daysBetween(now, parseISODate(t.deadline));
  const label = days < 0 ? `Was due ${relativeLabel(t.deadline, now, locale)}` : days === 0 ? "Due today" : `Due ${relativeLabel(t.deadline, now, locale)}`;
  return { label, tone: days <= 0 ? "overdue" : days <= 2 ? "soon" : "later" };
}

/**
 * A project's tasks by heading: tasks without a heading first, then each
 * heading in the order it was first used; completed ones at the end — or,
 * with `doneInPlace`, under their own heading after its open ones.
 */
export function groupByHeading(tasks: Task[], doneInPlace = false): DayGroup[] {
  const open = tasks.filter((t) => !t.done).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const done = tasks.filter((t) => t.done).sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
  const sections = new Map<string, Task[]>();
  for (const t of doneInPlace ? [...open, ...done] : open) {
    const k = t.heading ?? "";
    sections.set(k, [...(sections.get(k) ?? []), t]);
  }
  const groups: DayGroup[] = [];
  const loose = sections.get("");
  if (loose) groups.push({ key: "h:", label: "Tasks", tone: "upcoming", tasks: loose });
  for (const [k, list] of sections) {
    if (k) groups.push({ key: `h:${k}`, label: k, tone: "upcoming", tasks: list });
  }
  if (done.length && !doneInPlace) groups.push({ key: "done", label: "Done", tone: "done", tasks: done });
  return groups;
}

/**
 * A project's list with every section showing, even ones with no tasks yet,
 * so a task can be dragged into any of them: General ("h:") first, then the
 * sections A–Z, like Slack channels and the sidebar.
 */
export function withEmptySections(groups: DayGroup[], sections: string[]): DayGroup[] {
  const byKey = new Map(groups.map((g) => [g.key, g]));
  const out: DayGroup[] = [];
  const take = (key: string, label: string) => {
    out.push(byKey.get(key) ?? { key, label, tone: "upcoming", tasks: [] });
    byKey.delete(key);
  };
  take("h:", "Tasks");
  const names = new Set(sections.filter(Boolean));
  for (const g of groups) if (g.key.startsWith("h:") && g.key !== "h:") names.add(g.key.slice(2));
  for (const name of [...names].sort(sectionOrder)) take(`h:${name}`, name);
  for (const g of groups) if (byKey.has(g.key)) out.push(g);
  return out;
}

const sectionOrder = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true });

/** Sidebar order for a project's sections: General (no name) first, then A–Z. */
export function bySection(a: { name: string | null }, b: { name: string | null }): number {
  if (a.name === null) return b.name === null ? 0 : -1;
  if (b.name === null) return 1;
  return sectionOrder(a.name, b.name);
}

/** Where a moved task went, for its toast: "Offsite › Travel", or "Offsite › General" within one project. */
export function placeLabel(from: { project: string | null }, to: { project: string | null; heading: string | null }): string {
  if (!to.project) return "no project";
  if (to.heading) return `${to.project} › ${to.heading}`;
  return from.project === to.project ? `${to.project} › General` : to.project;
}

/** Headings used in a project, in first-use order. */
export function headingsOf(tasks: Task[], project: string): string[] {
  const seen: string[] = [];
  for (const t of [...tasks].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    if (t.project === project && t.heading && !seen.includes(t.heading)) seen.push(t.heading);
  }
  return seen;
}

/** Steps typed or pasted as lines ("- milk", "• eggs", "1. bread") → checklist texts. */
export function linesToSteps(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•◦▪‣–—]|\[[ xX]?\]|\d{1,2}[.)])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 50);
}

/**
 * Bulleted or numbered lines in a selection (two or more), offered as a
 * checklist when it becomes a task.
 */
export function bulletSteps(text: string | null): string[] {
  if (!text) return [];
  const bullets = text
    .split(/\r?\n/)
    .filter((l) => /^\s*(?:[-*•◦▪‣]|\[[ xX]?\]|\d{1,2}[.)])\s+\S/.test(l));
  return bullets.length >= 2 ? linesToSteps(bullets.join("\n")) : [];
}

/** "by Friday", "before 5pm", "due Monday", "no later than…" — a deadline, not just a day. */
export function isDeadlinePhrase(text: string | null | undefined): boolean {
  return !!text && /^\s*(by|before|due|no later than|until|deadline)\b/i.test(text);
}

/**
 * Inbox (tasks in no project) by when: Today (with anything late), Tomorrow,
 * Next 7 days, Later, and Someday for tasks with no date (parked or not,
 * and paused repeats). Finished tasks come last.
 */
export function groupInbox(tasks: Task[], reference: Date): DayGroup[] {
  const today = toISODate(reference);
  const tomorrow = toISODate(addDays(reference, 1));
  const week = toISODate(addDays(reference, 7));
  const cols: Record<InboxColumn, Task[]> = { today: [], tomorrow: [], week: [], later: [], someday: [] };
  const done: Task[] = [];
  for (const t of tasks) {
    if (t.done) {
      done.push(t);
      continue;
    }
    const day = t.paused || t.someday ? null : effectiveDay(t, today);
    if (!day) cols.someday.push(t);
    else if (day <= today) cols.today.push(t);
    else if (day === tomorrow) cols.tomorrow.push(t);
    else if (day <= week) cols.week.push(t);
    else cols.later.push(t);
  }
  const byWhen = (a: Task, b: Task) =>
    (effectiveDay(a, today) ?? "").localeCompare(effectiveDay(b, today) ?? "") ||
    Number(a.evening) - Number(b.evening) ||
    (a.due_time ?? "99").localeCompare(b.due_time ?? "99") ||
    a.created_at.localeCompare(b.created_at);
  const groups: DayGroup[] = INBOX_COLUMNS.map(([key, label]) => ({
    key: `in:${key}`,
    label,
    tone: key === "today" ? "today" : key === "someday" ? "someday" : "upcoming",
    tasks: cols[key].sort(byWhen),
  }));
  if (done.length) {
    done.sort((a, b) => (b.completed_at ?? "").localeCompare(a.completed_at ?? ""));
    groups.push({ key: "done", label: "Completed", tone: "done", tasks: done });
  }
  return groups;
}

export type InboxColumn = "today" | "tomorrow" | "week" | "later" | "someday";
export const INBOX_COLUMNS: [InboxColumn, string][] = [
  ["today", "Today"],
  ["tomorrow", "Tomorrow"],
  ["week", "Next 7 days"],
  ["later", "Later"],
  ["someday", "Someday"],
];

/** The day a task dropped on an Inbox column gets (null: no date). */
export function inboxColumnDay(col: InboxColumn, reference: Date): string | null {
  const days = { today: 0, tomorrow: 1, week: 2, later: 8, someday: null }[col];
  return days === null ? null : toISODate(addDays(reference, days));
}
