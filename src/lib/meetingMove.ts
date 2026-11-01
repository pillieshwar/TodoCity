import type { CalendarEvent } from "./types";

/** Meetings move in 5-minute steps, like tasks. */
export const MEETING_SNAP = 5;
const MIN_LEN = 5;
const MAX_LEN = 24 * 60;

/** Can this meeting be dragged in the Calendar? Timed, on one day, and allowed by Calendar. */
export function canMove(e: CalendarEvent): boolean {
  return (e.movable === "yes" || e.movable === "everyone") && !e.all_day && e.start.slice(0, 10) === e.end.slice(0, 10);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DDTHH:MM:SS` local, plus `minutes`. */
export function addMinutes(local: string, minutes: number): string {
  const [d, t] = local.split("T");
  const [y, mo, da] = d.split("-").map(Number);
  const [h, mi] = t.split(":").map(Number);
  const x = new Date(y, mo - 1, da, h, mi + minutes, 0);
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}:00`;
}

/** Minutes between two local times. */
export function minutesBetween(a: string, b: string): number {
  const at = (s: string) => {
    const [d, t] = s.split("T");
    const [y, mo, da] = d.split("-").map(Number);
    const [h, mi] = t.split(":").map(Number);
    return new Date(y, mo - 1, da, h, mi).getTime();
  };
  return Math.round((at(b) - at(a)) / 60_000);
}

const snap = (m: number) => Math.round(m / MEETING_SNAP) * MEETING_SNAP;

/** Dragged by `days` and `minutes` (snapped): same length, new start. */
export function moved(e: CalendarEvent, days: number, minutes: number): CalendarEvent {
  const by = days * 24 * 60 + snap(minutes);
  return { ...e, start: addMinutes(e.start, by), end: addMinutes(e.end, by) };
}

/** Bottom edge dragged by `minutes` (snapped): 5 minutes to a day long. */
export function stretched(e: CalendarEvent, minutes: number): CalendarEvent {
  const len = Math.max(MIN_LEN, Math.min(MAX_LEN, minutesBetween(e.start, e.end) + snap(minutes)));
  return { ...e, end: addMinutes(e.start, len) };
}

/** Same time as before (nothing to save). */
export function sameTime(a: CalendarEvent, b: CalendarEvent): boolean {
  return a.start.slice(0, 16) === b.start.slice(0, 16) && a.end.slice(0, 16) === b.end.slice(0, 16);
}

/** One occurrence of a meeting: its id plus where it starts (repeating meetings share an id). */
export function occurrenceKey(e: Pick<CalendarEvent, "id" | "start">): string {
  return `${e.id}${e.start}`;
}
