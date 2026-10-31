/**
 * Repeat rules, mirroring `todocity_core::recurrence::Repeat`: the six
 * presets keep their old names ("weekly"), anything else is stored as
 * `rrule:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE`. The app's own copy decides
 * the real next day; this one draws menus, labels and previews.
 */

export type Freq = "day" | "week" | "month" | "year";

/** Monthly / yearly: a day of the month (-1: the last), or the nth weekday (-1: the last). */
export type MonthBy = { day: number } | { nth: number; weekday: number };

export interface RepeatRule {
  freq: Freq;
  /** 1–99. */
  interval: number;
  /** Weekly: JS weekdays (0 Sunday … 6 Saturday); empty means the start's own day. */
  days: number[];
  monthBy: MonthBy | null;
  /** The next one counts from when it's finished. */
  afterDone: boolean;
  /** `YYYY-MM-DD`: no occurrences after it. */
  until: string | null;
  /** How many are left, this one included. */
  count: number | null;
}

export const PRESETS = ["daily", "weekdays", "weekly", "biweekly", "monthly", "yearly"] as const;
export type Preset = (typeof PRESETS)[number];

const CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

const base = (freq: Freq, interval = 1): RepeatRule => ({ freq, interval, days: [], monthBy: null, afterDone: false, until: null, count: null });

export function presetRule(p: Preset): RepeatRule {
  switch (p) {
    case "daily":
      return base("day");
    case "weekdays":
      return { ...base("week"), days: [1, 2, 3, 4, 5] };
    case "weekly":
      return base("week");
    case "biweekly":
      return base("week", 2);
    case "monthly":
      return base("month");
    case "yearly":
      return base("year");
  }
}

function same(a: RepeatRule, b: RepeatRule): boolean {
  const ds = (r: RepeatRule) => [...r.days].sort().join(",");
  return (
    a.freq === b.freq &&
    a.interval === b.interval &&
    ds(a) === ds(b) &&
    JSON.stringify(a.monthBy) === JSON.stringify(b.monthBy) &&
    a.afterDone === b.afterDone &&
    a.until === b.until &&
    a.count === b.count
  );
}

/** The preset this rule is exactly, if any. */
export function asPreset(r: RepeatRule): Preset | null {
  return PRESETS.find((p) => same(presetRule(p), r)) ?? null;
}

/** A stored rule, or null when it isn't one this version reads. */
export function parseRepeat(s: string | null | undefined): RepeatRule | null {
  if (!s) return null;
  if ((PRESETS as readonly string[]).includes(s)) return presetRule(s as Preset);
  if (!s.startsWith("rrule:")) return null;
  const r = base("day");
  let freq: Freq | null = null;
  let byday: string | null = null;
  let bymonthday: number | null = null;
  for (const part of s.slice(6).split(";").filter(Boolean)) {
    const [k, v] = part.split("=");
    if (v === undefined) return null;
    if (k === "FREQ") {
      freq = ({ DAILY: "day", WEEKLY: "week", MONTHLY: "month", YEARLY: "year" } as Record<string, Freq>)[v] ?? null;
      if (!freq) return null;
    } else if (k === "INTERVAL") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 99) return null;
      r.interval = n;
    } else if (k === "BYDAY") byday = v;
    else if (k === "BYMONTHDAY") {
      const n = Number(v);
      if (!Number.isInteger(n) || !((n >= 1 && n <= 31) || n === -1)) return null;
      bymonthday = n;
    } else if (k === "UNTIL") {
      if (!/^\d{8}$/.test(v)) return null;
      r.until = `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}`;
    } else if (k === "COUNT") {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 999) return null;
      r.count = n;
    } else if (k === "FROM") r.afterDone = v === "DONE";
  }
  if (!freq) return null;
  r.freq = freq;
  if (byday) {
    if (freq === "week") {
      for (const c of byday.split(",")) {
        const w = CODES.indexOf(c);
        if (w < 0) return null;
        r.days.push(w);
      }
    } else if (freq === "month" || freq === "year") {
      const m = /^(-1|[1-4])([A-Z]{2})$/.exec(byday);
      const w = m ? CODES.indexOf(m[2]) : -1;
      if (!m || w < 0) return null;
      r.monthBy = { nth: Number(m[1]), weekday: w };
    }
  }
  if (bymonthday !== null && (freq === "month" || freq === "year")) r.monthBy = { day: bymonthday };
  return r;
}

/** Stored form: the preset's name when it is one. Same output as the app. */
export function toStored(r: RepeatRule): string {
  const p = asPreset(r);
  if (p) return p;
  let out = `rrule:FREQ=${{ day: "DAILY", week: "WEEKLY", month: "MONTHLY", year: "YEARLY" }[r.freq]}`;
  if (r.interval !== 1) out += `;INTERVAL=${r.interval}`;
  if (r.freq === "week" && r.days.length) {
    // Monday first, as the app writes it.
    const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => r.days.includes(d));
    out += `;BYDAY=${order.map((d) => CODES[d]).join(",")}`;
  }
  if ((r.freq === "month" || r.freq === "year") && r.monthBy) {
    out += "day" in r.monthBy ? `;BYMONTHDAY=${r.monthBy.day}` : `;BYDAY=${r.monthBy.nth}${CODES[r.monthBy.weekday]}`;
  }
  if (r.afterDone) out += ";FROM=DONE";
  if (r.until) out += `;UNTIL=${r.until.replace(/-/g, "")}`;
  if (r.count !== null) out += `;COUNT=${r.count}`;
  return out;
}

// ── Days, as numbers (no time zones, no daylight saving) ────────────────────

const toNum = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return Date.UTC(y, m - 1, d) / 86_400_000;
};
const toIso = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
const weekdayOf = (n: number) => (((n + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
const lastDay = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
const ymd = (n: number) => {
  const d = new Date(n * 86_400_000);
  return { y: d.getUTCFullYear(), m0: d.getUTCMonth(), d: d.getUTCDate() };
};
const dayNum = (y: number, m0: number, d: number) => Date.UTC(y, m0, d) / 86_400_000;

function addMonths(n: number, months: number, anchorDay: number): number {
  const { y, m0 } = ymd(n);
  const total = y * 12 + m0 + months;
  const yy = Math.floor(total / 12);
  const mm = total - yy * 12;
  return dayNum(yy, mm, Math.min(anchorDay, lastDay(yy, mm)));
}

function inMonth(r: RepeatRule, y: number, m0: number, anchor: number): number {
  const last = lastDay(y, m0);
  const mb = r.monthBy;
  if (!mb) return dayNum(y, m0, Math.min(ymd(anchor).d, last));
  if ("day" in mb) return dayNum(y, m0, mb.day < 0 ? last : Math.min(mb.day, last));
  if (mb.nth < 0) {
    const end = dayNum(y, m0, last);
    return end - ((weekdayOf(end) - mb.weekday + 7) % 7);
  }
  const first = dayNum(y, m0, 1);
  return first + ((mb.weekday - weekdayOf(first) + 7) % 7) + 7 * (mb.nth - 1);
}

/**
 * The next day after `after` (and after `anchor`, this one's day), or
 * counted from `doneOn` for "after I finish". Null past `until`.
 */
export function nextDay(r: RepeatRule, anchor: string, after: string, doneOn: string = after): string | null {
  const n = Math.max(1, r.interval);
  const a = toNum(anchor);
  let next: number | null = null;
  if (r.afterDone) {
    const done = toNum(doneOn);
    next =
      r.freq === "day" ? done + n : r.freq === "week" ? done + 7 * n : addMonths(done, r.freq === "month" ? n : 12 * n, ymd(done).d);
  } else {
    const from = Math.max(toNum(after), a);
    if (r.freq === "day") next = a + (Math.floor((from - a) / n) + 1) * n;
    else if (r.freq === "week") {
      const days = r.days.length ? r.days : [weekdayOf(a)];
      const monday = (x: number) => x - ((weekdayOf(x) + 6) % 7);
      const baseWeek = monday(a) / 7;
      for (let d = from + 1; d <= from + 7 * 100 + 7; d++) {
        const weeks = Math.round(monday(d) / 7 - baseWeek);
        if (((weeks % n) + n) % n === 0 && days.includes(weekdayOf(d))) {
          next = d;
          break;
        }
      }
    } else {
      const step = r.freq === "month" ? n : 12 * n;
      const { y, m0 } = ymd(a);
      const start = y * 12 + m0;
      for (let k = 0; k < 1200; k++) {
        const total = start + k * step;
        const yy = Math.floor(total / 12);
        const d = inMonth(r, yy, total - yy * 12, a);
        if (d > from) {
          next = d;
          break;
        }
      }
    }
  }
  if (next === null) return null;
  const iso = toIso(next);
  return r.until && iso > r.until ? null : iso;
}

/**
 * The first day on or after `iso` that the rule lands on, for rules that
 * name their days (weekdays, "the 2nd Tuesday", "the last day"); others
 * start where they are.
 */
export function alignStart(r: RepeatRule, iso: string): string {
  const named = (r.freq === "week" && r.days.length > 0) || ((r.freq === "month" || r.freq === "year") && r.monthBy !== null);
  if (!named || r.afterDone) return iso;
  const before = toIso(toNum(iso) - 1);
  // Every week (or month) here: the rhythm starts from the day it lands on.
  return nextDay({ ...r, interval: 1, until: null, count: null }, before, before) ?? iso;
}

/** Up to `max` days it lands on from `start` (included), stopping at its end, a count or `end` (a deadline). */
export function upcoming(r: RepeatRule, start: string, end: string | null, max = 120): string[] {
  const out = [start];
  let rule = r;
  let d = start;
  while (out.length < max && !(rule.count !== null && rule.count <= 1)) {
    const next = nextDay(rule, d, d, d);
    if (!next || (end && next > end)) break;
    out.push(next);
    rule = { ...rule, count: rule.count === null ? null : rule.count - 1 };
    d = next;
  }
  return out;
}

// ── Words ───────────────────────────────────────────────────────────────────

const ORD = ["", "1st", "2nd", "3rd", "4th"];
export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${s}`;
}

function dayNames(days: number[], locale: string, style: "short" | "long"): string {
  // Monday first.
  const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d));
  const name = (d: number) => new Date(Date.UTC(2026, 10, 1 + d)).toLocaleDateString(locale, { weekday: style, timeZone: "UTC" });
  return order.map(name).join(", ");
}

const UNIT: Record<Freq, [string, string]> = { day: ["day", "days"], week: ["week", "weeks"], month: ["month", "months"], year: ["year", "years"] };

/** "Every 2 weeks on Mon, Wed", "Every month on the 2nd Tuesday", "Every 3 days". */
export function describe(r: RepeatRule, locale = "en-US", opts: { ends?: boolean } = {}): string {
  const p = asPreset(r);
  const presetWords: Record<Preset, string> = {
    daily: "Every day",
    weekdays: "Every weekday",
    weekly: "Every week",
    biweekly: "Every 2 weeks",
    monthly: "Every month",
    yearly: "Every year",
  };
  let out: string;
  if (p) out = presetWords[p];
  else {
    const [one, many] = UNIT[r.freq];
    out = r.interval === 1 ? `Every ${one}` : `Every ${r.interval} ${many}`;
    if (r.freq === "week" && r.days.length) {
      const wk = [1, 2, 3, 4, 5];
      out =
        r.interval === 1 && r.days.length === 5 && wk.every((d) => r.days.includes(d))
          ? "Every weekday"
          : `${out} on ${dayNames(r.days, locale, r.days.length > 2 ? "short" : "long")}`;
    }
    const mb = r.monthBy;
    if ((r.freq === "month" || r.freq === "year") && mb) {
      if ("day" in mb) out += mb.day < 0 ? " on the last day" : ` on the ${ordinal(mb.day)}`;
      else out += ` on the ${mb.nth < 0 ? "last" : ORD[mb.nth]} ${dayNames([mb.weekday], locale, "long")}`;
    }
    if (r.afterDone) out += " after it's done";
  }
  if (opts.ends !== false) {
    if (r.count !== null) out += r.count === 1 ? " · last one" : ` · ${r.count} times`;
    else if (r.until) out += ` · until ${new Date(`${r.until}T12:00:00`).toLocaleDateString(locale, { month: "short", day: "numeric" })}`;
  }
  return out;
}

/** The label for a stored rule, or null. */
export function repeatText(s: string | null | undefined, locale = "en-US"): string | null {
  const r = parseRepeat(s);
  return r ? describe(r, locale) : null;
}

/** A few words for a small button: "Saturdays", "Monthly · 1st", "Every 3 days". */
export function repeatBrief(s: string | null | undefined, start: string, locale = "en-US"): string | null {
  const r = parseRepeat(s);
  if (!r) return null;
  const startDay = weekdayOf(toNum(start));
  if (r.freq === "day") return r.interval === 1 ? "Daily" : `Every ${r.interval} days`;
  if (r.freq === "week") {
    const days = r.days.length ? r.days : [startDay];
    if (r.interval === 1 && days.length === 5 && [1, 2, 3, 4, 5].every((d) => days.includes(d))) return "Weekdays";
    const names = dayNames(days, locale, days.length > 1 ? "short" : "long");
    return r.interval === 1 ? (days.length > 1 ? names : `${names}s`) : `Every ${r.interval} wks · ${names}`;
  }
  const word = r.freq === "month" ? (r.interval === 1 ? "Monthly" : `Every ${r.interval} mo`) : r.interval === 1 ? "Yearly" : `Every ${r.interval} yrs`;
  const mb = r.monthBy;
  if (!mb) return word;
  if ("day" in mb) return `${word} · ${mb.day < 0 ? "last day" : ordinal(mb.day)}`;
  return `${word} · ${mb.nth < 0 ? "last" : ORD[mb.nth]} ${dayNames([mb.weekday], locale, "short")}`;
}
