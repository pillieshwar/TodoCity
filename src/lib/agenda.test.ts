import { describe, expect, it } from "vitest";
import { agendaFor, agendaHeading, dayMarks, overdueLabel, overdueTaskLabel, undatedCount, weekRows } from "./agenda";
import type { Task } from "./types";

const TODAY = "2026-10-14"; // Wednesday
let id = 0;
const task = (title: string, due: string | null, extra: Partial<Task> = {}): Task => ({
  id: ++id,
  title,
  due_date: due,
  source_text: null,
  done: false,
  created_at: `2026-10-01T0${id % 10}:00:00Z`,
  created_tz: null,
  completed_at: null,
    due_time: null,
    recurrence: null,
    source_app: null,
    source_bundle: null,
    source_url: null,
    snoozed_until: null,
    notified_at: null,
    next_id: null,
    notes: null,
    deadline: null,
    evening: false,
    someday: false,
    project: null,
    heading: null,
    checklist: [],
    series_date: null,
    paused: false,
  ...extra,
});

describe("weekRows", () => {
  it("starts on the week containing the anchor", () => {
    const rows = weekRows(TODAY, 0, 2);
    expect(rows.length).toBe(14);
    expect(rows[0].iso).toBe("2026-10-11");
    expect(rows[13].iso).toBe("2026-10-24");
  });

  it("respects Monday starts and dims the next month", () => {
    const rows = weekRows("2026-10-28", 1, 2);
    expect(rows[0].iso).toBe("2026-10-26");
    expect(rows[6]).toEqual({ iso: "2026-11-01", day: 1, inMonth: false });
  });
});

describe("dayMarks", () => {
  it("counts open tasks per day and flags past days", () => {
    const m = dayMarks(
      [
        task("a", "2026-10-14"),
        task("b", "2026-10-14"),
        task("c", "2026-10-10"),
        task("d", "2026-10-15", { done: true }),
        task("e", null),
      ],
      TODAY,
    );
    expect(m.get("2026-10-14")).toEqual({ open: 2, overdue: false });
    expect(m.get("2026-10-10")).toEqual({ open: 1, overdue: true });
    expect(m.has("2026-10-15")).toBe(false);
  });
});

describe("agendaFor", () => {
  const tasks = [
    task("today 1", TODAY),
    task("late", "2026-10-12"),
    task("later", "2026-10-20"),
    task("finished", TODAY, { done: true, completed_at: "2026-10-14T10:00:00Z" }),
    task("someday", null),
  ];

  it("shows overdue only on today", () => {
    const a = agendaFor(tasks, TODAY, TODAY);
    expect(a.overdue.map((t) => t.title)).toEqual(["late"]);
    expect(a.due.map((t) => t.title)).toEqual(["today 1"]);
    expect(a.done.map((t) => t.title)).toEqual(["finished"]);
  });

  it("shows only that day elsewhere", () => {
    const a = agendaFor(tasks, "2026-10-20", TODAY);
    expect(a.overdue).toEqual([]);
    expect(a.due.map((t) => t.title)).toEqual(["later"]);
  });

  it("counts undated tasks", () => {
    expect(undatedCount(tasks)).toBe(1);
  });
});

describe("labels", () => {
  it("headings", () => {
    expect(agendaHeading(TODAY, TODAY, "en-US")).toEqual({ lead: "Today", date: "Wednesday, October 14" });
    expect(agendaHeading("2026-10-15", TODAY, "en-US").lead).toBe("Tomorrow");
    expect(agendaHeading("2026-10-20", TODAY, "en-US").lead).toBe(null);
  });

  it("overdue labels", () => {
    expect(overdueLabel("2026-10-13", TODAY)).toBe("Yesterday");
    expect(overdueLabel("2026-10-11", TODAY)).toBe("3 days overdue");
  });

  it("labels every task the overdue list holds, including ones overdue by their deadline", () => {
    const noDay = task("Send the lease", null, { deadline: "2026-10-11" });
    const later = task("Pay rent", "2026-10-20", { deadline: "2026-10-13" });
    const late = task("Call Sam", "2026-10-11");
    const { overdue } = agendaFor([noDay, later, late], TODAY, TODAY);
    expect(overdue.map((t) => t.title).sort()).toEqual(["Call Sam", "Pay rent", "Send the lease"]);
    expect(overdueTaskLabel(noDay, TODAY)).toBe("Deadline · 3 days overdue");
    expect(overdueTaskLabel(later, TODAY)).toBe("Deadline · yesterday");
    expect(overdueTaskLabel(late, TODAY)).toBe("3 days overdue");
  });
});
