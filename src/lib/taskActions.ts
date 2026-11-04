import { api } from "./api";
import { playDone } from "./doneSound";
import { relativeLabel } from "./dates";
import { placeLabel } from "./lists";
import { timeLabel } from "./schedule";
import type { Task, TaskPatch } from "./types";
import type { Toast } from "../components/Toasts";

import { snoozePlan, type SnoozeKind } from "./snooze";

export type { SnoozeKind };

type Show = (text: string, action?: Toast["action"], tone?: Toast["tone"]) => number;

function plural(n: number): string {
  return n === 1 ? "1 task" : `${n} tasks`;
}

function short(title: string): string {
  return title.length > 34 ? `${title.slice(0, 33)}…` : title;
}

/**
 * Task changes that come with an Undo toast. Used by the panel and the
 * menu-bar popover so both behave the same.
 */
export function taskActions(show: Show, locale: string) {
  const fail = (e: unknown): void => {
    show(String(e), undefined, "error");
  };

  async function setDone(task: Task, done: boolean) {
    if (done && !task.done) playDone(task.id);
    try {
      await api.updateTask(task.id, { done });
      if (!done) return;
      const next = task.recurrence ? " — next one is scheduled" : "";
      show(`Completed “${short(task.title)}”${next}`, {
        label: "Undo",
        run: () => api.updateTask(task.id, { done: false }).then(() => undefined, fail),
      }, "done");
    } catch (e) {
      fail(e);
    }
  }

  async function remove(task: Task) {
    try {
      await api.deleteTask(task.id);
      show(`Deleted “${short(task.title)}”`, {
        label: "Undo",
        run: () => api.restoreTask(task).then(() => undefined, fail),
      });
    } catch (e) {
      fail(e);
    }
  }

  /** Change a task's date, time or repeat. `quiet`: no "Moved to…" toast (the Calendar shows the move itself). */
  async function reschedule(task: Task, patch: TaskPatch, opts: { quiet?: boolean } = {}) {
    const before: TaskPatch = {
      due_date: task.due_date,
      due_time: task.due_time,
      recurrence: task.recurrence,
    };
    try {
      const t = await api.updateTask(task.id, patch);
      if (opts.quiet) return;
      const dayMoved = patch.due_date !== undefined && patch.due_date !== task.due_date;
      const timeMoved = patch.due_time !== undefined && patch.due_time !== task.due_time;
      const parts: string[] = [];
      if (dayMoved && t.due_date) parts.push(relativeLabel(t.due_date, new Date(), locale).toLowerCase());
      if (timeMoved) parts.push(t.due_time ? timeLabel(t.due_time, locale) : "any time");
      const text = !t.due_date ? "Date removed" : parts.length ? `Moved to ${parts.join(", ")}` : "Updated";
      show(`${text} · “${short(task.title)}”`, {
        label: "Undo",
        run: () => api.updateTask(task.id, before).then(() => undefined, fail),
      });
    } catch (e) {
      fail(e);
    }
  }

  /** Put a task in a project, or in one of its sections. */
  async function place(task: Task, patch: TaskPatch) {
    const before: TaskPatch = { project: task.project, heading: task.heading };
    try {
      const t = await api.updateTask(task.id, patch);
      show(`Moved to ${placeLabel(task, t)} · “${short(task.title)}”`, {
        label: "Undo",
        run: () => api.updateTask(task.id, before).then(() => undefined, fail),
      });
    } catch (e) {
      fail(e);
    }
  }

  /** Move several tasks to one day (e.g. all overdue → today). */
  async function moveAll(tasks: Task[], day: string) {
    const before = tasks.map((t) => ({ id: t.id, due_date: t.due_date }));
    try {
      for (const t of tasks) await api.updateTask(t.id, { due_date: day });
      show(`Moved ${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} to ${relativeLabel(day, new Date(), locale).toLowerCase()}`, {
        label: "Undo",
        run: async () => {
          try {
            for (const b of before) await api.updateTask(b.id, { due_date: b.due_date });
          } catch (e) {
            fail(e);
          }
        },
      });
    } catch (e) {
      fail(e);
    }
  }

  /** Move to later today (the task's time changes), or to tomorrow / next week. */
  async function snooze(task: Task, kind: SnoozeKind) {
    const before: TaskPatch = { due_date: task.due_date, due_time: task.due_time, snoozed_until: task.snoozed_until };
    const { patch, text } = snoozePlan(task, kind, new Date(), locale);
    try {
      await api.updateTask(task.id, patch);
      show(`${text} · “${short(task.title)}”`, {
        label: "Undo",
        run: () => api.updateTask(task.id, before).then(() => undefined, fail),
      });
    } catch (e) {
      fail(e);
    }
  }

  async function update(task: Task, patch: TaskPatch) {
    try {
      await api.updateTask(task.id, patch);
    } catch (e) {
      fail(e);
    }
  }

  /** Skip one occurrence of a repeating task (it moves to the next day in the series). */
  async function skip(task: Task) {
    const before: TaskPatch = { due_date: task.due_date, deadline: task.deadline };
    try {
      const t = await api.skipOccurrence(task.id);
      const when = t.due_date ? relativeLabel(t.due_date, new Date(), locale).toLowerCase() : "later";
      show(`Skipped — next one is ${when}`, {
        label: "Undo",
        run: () => api.updateTask(task.id, before).then(() => undefined, fail),
      });
    } catch (e) {
      fail(e);
    }
  }

  /** Pause or resume a repeating task. Resuming a paused one that's fallen behind skips ahead to its next day. */
  async function pause(task: Task, paused: boolean) {
    try {
      await api.updateTask(task.id, { paused });
      const today = new Date();
      const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
      if (!paused && task.due_date && task.due_date < iso) await api.skipOccurrence(task.id);
      show(paused ? `Paused “${short(task.title)}” — no reminders until you resume it` : `Resumed “${short(task.title)}”`, {
        label: "Undo",
        run: () =>
          api.updateTask(task.id, { paused: !paused, due_date: task.due_date, deadline: task.deadline }).then(() => undefined, fail),
      });
    } catch (e) {
      fail(e);
    }
  }

  /**
   * One change to several tasks, with one Undo. `patch` may depend on the
   * task; `undo` says which fields to put back.
   */
  async function batch(tasks: Task[], patch: TaskPatch | ((t: Task) => TaskPatch), message: string) {
    const changed: { task: Task; before: TaskPatch }[] = [];
    try {
      for (const t of tasks) {
        const p = typeof patch === "function" ? patch(t) : patch;
        const before: TaskPatch = {};
        for (const k of Object.keys(p) as (keyof TaskPatch)[]) {
          if (k === "only_this") continue;
          (before as Record<string, unknown>)[k] = (t as unknown as Record<string, unknown>)[k];
        }
        await api.updateTask(t.id, p);
        changed.push({ task: t, before });
      }
      show(message, {
        label: "Undo",
        run: async () => {
          try {
            for (const c of changed.reverse()) await api.updateTask(c.task.id, c.before);
          } catch (e) {
            fail(e);
          }
        },
      });
    } catch (e) {
      fail(e);
    }
  }

  async function completeMany(tasks: Task[]) {
    const open = tasks.filter((t) => !t.done);
    if (open.length) playDone();
    try {
      for (const t of open) await api.updateTask(t.id, { done: true });
      show(`Completed ${plural(open.length)}`, {
        label: "Undo",
        run: async () => {
          try {
            for (const t of open) await api.updateTask(t.id, { done: false });
          } catch (e) {
            fail(e);
          }
        },
      }, "done");
    } catch (e) {
      fail(e);
    }
  }

  async function removeMany(tasks: Task[]) {
    const gone: Task[] = [];
    try {
      for (const t of tasks) {
        await api.deleteTask(t.id);
        gone.push(t);
      }
      show(`Deleted ${plural(gone.length)}`, {
        label: "Undo",
        run: async () => {
          try {
            for (const t of gone) await api.restoreTask(t);
          } catch (e) {
            fail(e);
          }
        },
      });
    } catch (e) {
      fail(e);
    }
  }

  /** A copy of a task, with its sub-tasks unticked, right where it is. */
  async function duplicate(task: Task) {
    try {
      const copy = await api.addTask(
        {
          title: task.title,
          due_date: task.due_date,
          due_time: task.due_time,
          recurrence: task.recurrence,
          source_text: task.source_text,
          source_app: task.source_app,
          source_bundle: task.source_bundle,
          source_url: task.source_url,
          notes: task.notes,
          deadline: task.deadline,
          evening: task.evening,
          someday: task.someday,
          project: task.project,
          heading: task.heading,
          checklist: (task.checklist ?? []).map((c) => ({ text: c.text, done: false })),
          priority: task.priority ?? 0,
        },
        true,
      );
      show(`Duplicated “${short(task.title)}”`, {
        label: "Undo",
        run: () => api.deleteTask(copy.id).then(() => undefined, fail),
      });
    } catch (e) {
      fail(e);
    }
  }

  return { setDone, remove, reschedule, place, moveAll, snooze, update, fail, skip, pause, batch, completeMany, removeMany, duplicate };
}

export type TaskActions = ReturnType<typeof taskActions>;
