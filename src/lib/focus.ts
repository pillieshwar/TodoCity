import { takeDuration } from "./timeblock";
import type { FocusStatus, Task } from "./types";

/** Blocks can't be shorter (mirrors `todocity_core::focus::MIN_BLOCK_MIN`). */
export const MIN_FOCUS_MIN = 5;
/** Lengths offered for "Focus now". */
export const FOCUS_LENGTHS = [25, 50, 90];

/**
 * A new focus block typed in Calendar's "New task…" field: "Focus",
 * "Focus for 90 min", "Focus: draft the brief", "focus · write for 2h".
 * Anything else (including "Focus on the brief") is an ordinary task.
 */
export function parseFocusEntry(typed: string): { title: string | null; minutes: number | null } | null {
  const text = typed.trim();
  const m = /^focus(?:\s*(?:[:·—–-])\s*(.*)|\s+(for\b.*))?$/i.exec(text);
  if (!m) return null;
  const tail = (m[1] ?? m[2] ?? "").trim();
  const { minutes, rest } = takeDuration(tail);
  const title = rest.trim();
  return { title: title || null, minutes };
}

/** Local `YYYY-MM-DDTHH:MM:00`. */
export function localStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00`;
}

/** A local `YYYY-MM-DDTHH:MM[:SS]` as a Date. */
export function parseStamp(s: string): Date {
  const [day, time = "00:00"] = s.split("T");
  const [y, mo, d] = day.split("-").map(Number);
  const [h, mi, se = 0] = time.split(":").map(Number);
  return new Date(y, mo - 1, d, h, mi, se);
}

/** Whole minutes from `now` until `end` (never below 0). */
export function minutesLeft(end: string, now: Date): number {
  return Math.max(0, Math.ceil((parseStamp(end).getTime() - now.getTime()) / 60000));
}

/** "34 min left", "1 hr 20 min left". */
export function leftLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min left`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} hr ${m} min left` : `${h} hr left`;
}

/** The picked tasks that still exist, in order. */
export function pickedTasks(ids: number[], tasks: Task[]): Task[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return ids.map((id) => byId.get(id)).filter((t): t is Task => !!t);
}

/** "Nice work — 2 of 3 done", or a plain line when no tasks were picked. */
export function wrapUpLine(picked: Task[]): string {
  if (!picked.length) return "Focus block finished";
  const done = picked.filter((t) => t.done).length;
  if (done === picked.length) return picked.length === 1 ? "Nice work — done" : `Nice work — all ${done} done`;
  return done ? `Nice work — ${done} of ${picked.length} done` : "Focus block finished";
}

/** A wrap-up card's id, so dismissing one doesn't hide the next. */
export function wrapUpId(last: NonNullable<FocusStatus["last"]>): string {
  return `${last.keys.join(",")}|${last.at}`;
}

/** Start and end for "Focus now" for `minutes`, from this minute. */
export function focusNow(now: Date, minutes: number): { start: string; end: string } {
  const start = new Date(now);
  start.setSeconds(0, 0);
  const end = new Date(start.getTime() + Math.max(MIN_FOCUS_MIN, minutes) * 60000);
  return { start: localStamp(start), end: localStamp(end) };
}
