/**
 * The Timeline: each project as a bar from its first to its last day
 * (`plan_start`, `plan_end`), on a window of months that pans freely.
 * Days are counted as whole numbers (days since 1970-01-01, by the
 * calendar date, never the clock), so the math is exact.
 */

export interface Span {
  start: string;
  end: string;
}

/** "2026-11-05" → its day number. */
export function dayNum(iso: string): number {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.round(Date.UTC(y, (m || 1) - 1, d || 1) / 86_400_000);
}

/** A day number → "YYYY-MM-DD". */
export function isoOf(n: number): string {
  const d = new Date(Math.round(n) * 86_400_000);
  const p = (x: number) => String(x).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/** The first day of the month `iso` is in, moved by `months`. */
export function monthStart(iso: string, months = 0): string {
  const [y, m] = iso.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return isoOf(Math.round(d.getTime() / 86_400_000));
}

/** Every month that shows in the window `[from, from + days)`, with where it starts and ends. */
export function monthsIn(from: number, days: number): { iso: string; start: number; end: number }[] {
  const out: { iso: string; start: number; end: number }[] = [];
  let m = monthStart(isoOf(Math.floor(from)));
  while (dayNum(m) < from + days) {
    const next = monthStart(m, 1);
    out.push({ iso: m, start: dayNum(m), end: dayNum(next) });
    m = next;
  }
  return out;
}

/** How long a span is, in days (both ends count). */
export const spanDays = (s: Span) => dayNum(s.end) - dayNum(s.start) + 1;

/**
 * A bar dragged by `by` days: moved whole, or its start or end edge moved
 * (never past the other edge: a span is at least one day).
 */
export function dragSpan(s: Span, mode: "move" | "start" | "end", by: number): Span {
  const a = dayNum(s.start);
  const b = dayNum(s.end);
  if (mode === "move") return { start: isoOf(a + by), end: isoOf(b + by) };
  if (mode === "start") return { start: isoOf(Math.min(a + by, b)), end: s.end };
  return { start: s.start, end: isoOf(Math.max(b + by, a)) };
}

/** A span drawn from one day to another, in either direction. */
export function drawnSpan(a: number, b: number): Span {
  return { start: isoOf(Math.min(a, b)), end: isoOf(Math.max(a, b)) };
}

/** A project put on the Timeline with a click: four weeks from that day. */
export const clickSpan = (day: number): Span => ({ start: isoOf(day), end: isoOf(day + 27) });

/** "2d", "3w", "4m", "1y": how far a day is from today, minus when past. "Today" for today. */
export function fromToday(iso: string, today: string): string {
  const d = dayNum(iso) - dayNum(today);
  if (d === 0) return "Today";
  const a = Math.abs(d);
  const sign = d < 0 ? "-" : "";
  if (a < 14) return `${sign}${a}d`;
  if (a < 60) return `${sign}${Math.round(a / 7)}w`;
  if (a < 548) return `${sign}${Math.round(a / 30.44)}m`;
  return `${sign}${Math.round(a / 365.25)}y`;
}

/** "6 days", "3 weeks", "4 months": a span's length in words. */
export function lengthLabel(s: Span): string {
  const n = spanDays(s);
  if (n < 14) return n === 1 ? "1 day" : `${n} days`;
  if (n < 63) return `${Math.round(n / 7)} weeks`;
  const m = Math.round(n / 30.44);
  return m === 1 ? "1 month" : `${m} months`;
}

/** "Nov 3 – Dec 15" (the year only where it isn't this year). */
export function spanLabel(s: Span, today: string, locale?: string): string {
  const year = today.slice(0, 4);
  const f = (iso: string) => {
    const d = new Date(`${iso}T12:00:00`);
    const opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", ...(iso.slice(0, 4) !== year ? { year: "numeric" } : {}) };
    return d.toLocaleDateString(locale, opts);
  };
  return s.start === s.end ? f(s.start) : `${f(s.start)} – ${f(s.end)}`;
}

/** Zoom: how many days the window shows. */
export const ZOOMS = [
  { id: "quarter", label: "3 months", days: 92 },
  { id: "half", label: "6 months", days: 183 },
  { id: "year", label: "Year", days: 365 },
] as const;
export type ZoomId = (typeof ZOOMS)[number]["id"];

/** Where the window starts so today sits near its left: the start of last month (or of this one, zoomed in). */
export function homeFrom(today: string, zoom: ZoomId): number {
  return dayNum(monthStart(today, zoom === "quarter" ? 0 : -1));
}

/** A bar's place in the window, in pixels; `cutStart`/`cutEnd` when it runs past an edge. */
export function barPlace(s: Span, from: number, days: number, width: number) {
  const ppd = width / days;
  const a = dayNum(s.start) - from;
  const b = dayNum(s.end) + 1 - from;
  const left = Math.max(a, 0) * ppd;
  const right = Math.min(b, days) * ppd;
  return { left, width: Math.max(right - left, 0), visible: b > 0 && a < days, cutStart: a < 0, cutEnd: b > days };
}
