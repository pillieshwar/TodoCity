/**
 * Tasks as blocks of time: a start to the minute ("09:07") and a length in
 * minutes (any number, 1 to 1440). The Calendar draws each at its real start
 * and size; dragging snaps to 5 minutes.
 */

/** Dragging and dropping snaps to this many minutes. */
export const SNAP_MIN = 5;
/** How tall a task with no set length is drawn, in minutes. */
export const DEFAULT_BLOCK_MIN = 30;
/** The longest task: a whole day. */
export const MAX_DURATION_MIN = 1440;
/** Quick picks for a task's length. Any other number can be typed. */
export const DURATION_PRESETS = [5, 10, 15, 30, 45, 60, 90, 120];

const pad = (n: number) => String(n).padStart(2, "0");

/** "09:07" → 547. */
export function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** 547 → "09:07", kept within the day. */
export function timeOf(minutes: number): string {
  const m = Math.max(0, Math.min(24 * 60 - 1, Math.round(minutes)));
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** "7 min", "1 hr", "1 hr 30 min", "1 day". */
export function durationLabel(minutes: number | null | undefined): string | null {
  if (!minutes || minutes <= 0) return null;
  if (minutes >= MAX_DURATION_MIN) return "1 day";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h} hr ${m} min` : `${h} hr`;
}

/**
 * A length typed loosely: "7", "7m", "7 min", "45 mins", "1h", "1.5 h",
 * "1h30", "1 hr 15 min", "90 minutes", "2 hours". A bare number is minutes.
 * Returns minutes (1–1440), or null.
 */
export function parseDuration(text: string): number | null {
  const s = text.trim().toLowerCase().replace(/\s+/g, " ");
  if (!s) return null;
  const clamp = (n: number) => (n > 0 && Number.isFinite(n) ? Math.min(Math.round(n), MAX_DURATION_MIN) : null);
  let m = /^(\d+(?:\.\d+)?)$/.exec(s);
  if (m) return clamp(Number(m[1]));
  m = /^(\d+(?:\.\d+)?) ?(m|min|mins|minute|minutes)$/.exec(s);
  if (m) return clamp(Number(m[1]));
  m = /^(\d+(?:\.\d+)?) ?(h|hr|hrs|hour|hours)$/.exec(s);
  if (m) return clamp(Number(m[1]) * 60);
  m = /^(\d+) ?(?:h|hr|hrs|hour|hours) ?(?:and )?(\d+) ?(?:m|min|mins|minute|minutes)?$/.exec(s);
  if (m) return clamp(Number(m[1]) * 60 + Number(m[2]));
  if (s === "half an hour" || s === "half hour") return 30;
  if (s === "an hour" || s === "one hour") return 60;
  return null;
}

/**
 * A length at the end of a typed task: "Stand-up tomorrow 9:07 for 7 min".
 * Only after "for", so "call in 30 min" stays a time. Returns the minutes
 * and the text without it.
 */
export function takeDuration(text: string): { minutes: number | null; rest: string } {
  const re = /\s*\bfor (\d+(?:\.\d+)? ?(?:m|min|mins|minutes?|h|hrs?|hours?)(?: ?(?:and )?\d+ ?(?:m|min|mins|minutes?)?)?|half an hour|an hour)\b/i;
  const m = re.exec(text);
  if (!m) return { minutes: null, rest: text };
  const minutes = parseDuration(m[1]);
  if (!minutes) return { minutes: null, rest: text };
  const rest = `${text.slice(0, m.index)} ${text.slice(m.index + m[0].length)}`.replace(/\s+/g, " ").trim();
  return { minutes, rest };
}

/** When a block ends: "09:07" + 7 → "09:14" (past midnight it stops at 23:59). */
export function endOf(time: string, minutes: number | null | undefined): string | null {
  if (!minutes) return null;
  return timeOf(minutesOf(time) + minutes);
}

/** Where in an hour a point falls, snapped: 0.62 of the hour → 35. */
export function snapMinute(fraction: number, step = SNAP_MIN): number {
  if (!Number.isFinite(fraction)) return 0;
  const m = Math.round((Math.max(0, Math.min(1, fraction)) * 60) / step) * step;
  return Math.min(m, 60 - step);
}

export interface Block {
  key: string;
  /** Minutes from midnight. */
  start: number;
  /** Minutes long (as drawn). */
  len: number;
}

export interface Placed {
  /** Which side-by-side column it's in, and how many share its time. */
  col: number;
  cols: number;
  /** Which run of overlapping blocks it's in (0, 1, 2… down the day). */
  run?: number;
}

/**
 * Side by side when they overlap, like a calendar: each block takes the
 * first free column, and every block in a run of overlapping blocks shares
 * that run's column count.
 */
export function layoutBlocks(blocks: Block[]): Map<string, Placed> {
  const sorted = [...blocks].sort((a, b) => a.start - b.start || b.len - a.len || a.key.localeCompare(b.key));
  const out = new Map<string, Placed>();
  let run: { key: string; col: number }[] = [];
  let runEnd = -1;
  let ends: number[] = [];
  let runs = 0;
  const close = () => {
    if (!run.length) return;
    const cols = Math.max(1, ends.length);
    for (const r of run) out.set(r.key, { col: r.col, cols, run: runs });
    runs += 1;
    run = [];
    ends = [];
  };
  for (const b of sorted) {
    const end = b.start + Math.max(1, b.len);
    if (run.length && b.start >= runEnd) close();
    let col = ends.findIndex((e) => e <= b.start);
    if (col < 0) {
      col = ends.length;
      ends.push(end);
    } else ends[col] = end;
    run.push({ key: b.key, col });
    runEnd = Math.max(runEnd, end);
  }
  close();
  return out;
}

/** The shortest a block is drawn, in pixels: one readable line. */
export const MIN_BLOCK_PX = 22;

/**
 * How a block's label fits its height: one line (title, then the time if
 * there's room), two lines (title, then the time), or a title that wraps
 * over up to three lines with the time under it.
 */
export function blockFit(heightPx: number): "line" | "two" | "full" {
  if (heightPx < 34) return "line";
  if (heightPx < 50) return "two";
  return "full";
}

/** A block's length as laid out: never shorter than it's drawn, so short ones don't hide under the next. */
export function drawnLen(len: number, hourPx: number): number {
  return Math.max(len, (MIN_BLOCK_PX / hourPx) * 60);
}

export interface Fold {
  /** Where the "+N" sits: the first hidden block's start. */
  start: number;
  len: number;
  keys: string[];
}

/**
 * Side by side, but never too thin to read: a run of up to `max` columns
 * shows as is; a wider one shows its first `max - 1` columns and folds the
 * rest into one "+N" in the last slot. Returns where each shown block goes
 * (hidden ones are left out) and the folds.
 */
export function foldBlocks(blocks: Block[], placed: Map<string, Placed>, max = 2): { shown: Map<string, Placed>; folds: Fold[] } {
  const shown = new Map<string, Placed>();
  const byRun = new Map<number, Block[]>();
  for (const b of blocks) {
    const p = placed.get(b.key);
    if (!p) continue;
    if (p.cols <= max) {
      shown.set(b.key, p);
      continue;
    }
    if (p.col < max - 1) shown.set(b.key, { ...p, cols: max });
    else {
      const r = p.run ?? -1;
      byRun.set(r, [...(byRun.get(r) ?? []), b]);
    }
  }
  const folds: Fold[] = [];
  for (const hidden of byRun.values()) {
    hidden.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));
    const start = hidden[0].start;
    const end = Math.max(...hidden.map((b) => b.start + b.len));
    folds.push({ start, len: end - start, keys: hidden.map((b) => b.key) });
  }
  folds.sort((a, b) => a.start - b.start);
  return { shown, folds };
}
