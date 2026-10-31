/**
 * Plain-words scheduling: times of day, repeats, and finding a date phrase
 * inside free text ("pay rent friday 5pm #home" → "pay rent #home", Friday,
 * 17:00).
 *
 * Builds on `resolveDatePhrase` (days only) and stays deterministic: the
 * same words always give the same answer, and nothing leaves the Mac.
 */

import { addDays, type DayOrder, resolveDatePhrase, startOfDay, toISODate } from "./dates";
import { describe, nextDay, parseRepeat, repeatText, toStored, upcoming, type RepeatRule } from "./repeat";

export type Repeat = "daily" | "weekdays" | "weekly" | "biweekly" | "monthly" | "yearly";

export const REPEATS: { id: Repeat; label: string }[] = [
  { id: "daily", label: "Every day" },
  { id: "weekdays", label: "Every weekday" },
  { id: "weekly", label: "Every week" },
  { id: "biweekly", label: "Every 2 weeks" },
  { id: "monthly", label: "Every month" },
  { id: "yearly", label: "Every year" },
];

/** "Every week", or a custom rule in words ("Every 2 weeks on Monday, Wednesday"). */
export function repeatLabel(r: string | null | undefined): string | null {
  return REPEATS.find((x) => x.id === r)?.label ?? repeatText(r);
}

const SHORT: Record<Repeat, string> = {
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  monthly: "Monthly",
  yearly: "Yearly",
};

/** Compact label for list rows: "Weekly", "Weekdays", or a custom rule in words. */
export function repeatShort(r: string | null | undefined): string | null {
  if (r && r in SHORT) return SHORT[r as Repeat];
  const rule = parseRepeat(r);
  return rule ? describe(rule, "en-US", { ends: false }) : null;
}

export interface Schedule {
  /** `YYYY-MM-DD` or null. */
  date: string | null;
  /** `HH:MM` (24-hour) or null. */
  time: string | null;
  /** A preset ("weekly") or a custom rule (`rrule:…`). */
  repeat: string | null;
  /** Other plausible days, most likely first. */
  alternatives: string[];
  /** The phrase named a specific day without ambiguity. */
  confident: boolean;
}

const WEEKDAY: Record<string, number> = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5, sat: 6, saturday: 6,
};
const WEEKDAY_WORDS = Object.keys(WEEKDAY).join("|");

const pad = (n: number) => String(n).padStart(2, "0");
const hhmm = (h: number, m: number) => `${pad(h)}:${pad(m)}`;

function clean(s: string): string {
  return s.replace(/\s+/g, " ").replace(/^[\s,;:-]+|[\s,;:.!?-]+$/g, "").trim();
}

// ── Time of day ─────────────────────────────────────────────────────────────

/** Pull a time of day out of `phrase` (lowercase). */
export function takeTime(phrase: string): { time: string | null; rest: string } {
  const rules: [RegExp, (m: RegExpMatchArray) => string | null][] = [
    // 5pm, 5:30 pm, at 11am, @ 9 a.m.
    [
      /(?:^|\s)(?:at|@|by|around)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)(?=\s|$)/,
      (m) => {
        let h = Number(m[1]);
        const min = Number(m[2] ?? 0);
        if (h < 1 || h > 12 || min > 59) return null;
        const pm = m[3].startsWith("p");
        if (h === 12) h = pm ? 12 : 0;
        else if (pm) h += 12;
        return hhmm(h, min);
      },
    ],
    // 17:00, at 9:30
    [
      /(?:^|\s)(?:at|@|by|around)?\s*([01]?\d|2[0-3]):([0-5]\d)(?=\s|$)/,
      (m) => hhmm(Number(m[1]), Number(m[2])),
    ],
    // "at 5" → 5 pm (people rarely mean 5 am); "at 9" → 9 am.
    [
      /(?:^|\s)(?:at|@)\s*(\d{1,2})(?=\s|$)/,
      (m) => {
        const h = Number(m[1]);
        if (h > 23) return null;
        if (h >= 1 && h <= 7) return hhmm(h + 12, 0);
        return hhmm(h, 0);
      },
    ],
    [/(?:^|\s)(?:at\s+)?(?:noon|midday|lunchtime)(?=\s|$)/, () => "12:00"],
    [/(?:^|\s)(?:eod|cob|eob|end of (?:the )?(?:business )?day|close of business)(?=\s|$)/, () => "17:00"],
    [/(?:^|\s)(?:in the |this )?morning(?=\s|$)/, () => "09:00"],
    [/(?:^|\s)(?:in the |this )?afternoon(?=\s|$)/, () => "14:00"],
    [/(?:^|\s)(?:in the |this )?evening(?=\s|$)/, () => "18:00"],
    [/(?:^|\s)tonight(?=\s|$)/, () => "20:00"],
  ];
  for (const [re, f] of rules) {
    const m = phrase.match(re);
    if (!m) continue;
    const time = f(m);
    if (!time) continue;
    let rest = phrase.slice(0, m.index) + " " + phrase.slice((m.index ?? 0) + m[0].length);
    // "tonight" and "this morning" also say which day.
    if (/tonight|this (morning|afternoon|evening)/.test(m[0])) rest += " today";
    return { time, rest: clean(rest) };
  }
  return { time: null, rest: phrase };
}

// ── Repeats ─────────────────────────────────────────────────────────────────

interface RepeatMatch {
  /** A preset name or a custom `rrule:…`. */
  repeat: string | null;
  weekday: number | null;
  monthDay: number | null;
  rest: string;
  /** A custom rule: its first day is worked out from the rule itself. */
  custom?: boolean;
  /** "until dec 18": the end, still to be read as a date. */
  untilText?: string;
}

const NTH: Record<string, number> = { "1st": 1, first: 1, "2nd": 2, second: 2, "3rd": 3, third: 3, "4th": 4, fourth: 4, last: -1 };
const UNITS: Record<string, RepeatRule["freq"]> = { day: "day", days: "day", week: "week", weeks: "week", month: "month", months: "month", year: "year", years: "year" };
const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const blank = (freq: RepeatRule["freq"], interval = 1): RepeatRule => ({ freq, interval, days: [], monthBy: null, afterDone: false, until: null, count: null });

/** Custom repeats in plain words: "every other tuesday", "every mon and wed", "every 3 days", "the 2nd tuesday of every month", "the last day of every month". */
function takeCustom(phrase: string): { rule: RepeatRule; m: RegExpMatchArray } | null {
  const wd = `(?:${WEEKDAY_WORDS})s?`;
  let m = phrase.match(new RegExp(`(?:^|\\s)(?:every|each) other (${WEEKDAY_WORDS})s?(?=\\s|$)`));
  if (m) return { rule: { ...blank("week", 2), days: [WEEKDAY[m[1]]] }, m };
  m = phrase.match(new RegExp(`(?:^|\\s)(?:every|each|on) (${wd}(?:(?:,? and |, ?| & )${wd})+)(?=\\s|$)`));
  if (m) {
    const days = [...new Set(m[1].split(/,? and |, ?| & /).map((w) => WEEKDAY[w.trim().replace(/s$/, "")] ?? WEEKDAY[w.trim()]))];
    if (days.every((d) => d !== undefined)) return { rule: { ...blank("week"), days: days.sort() }, m };
  }
  m = phrase.match(/(?:^|\s)(?:every|each) (\d{1,2}|two|three|four|five|six|seven|eight|nine|ten) (days?|weeks?|months?|years?)(?=\s|$)/);
  if (m) {
    const n = NUMBER_WORDS[m[1]] ?? Number(m[1]);
    if (n >= 1 && n <= 99) return { rule: blank(UNITS[m[2]], n), m };
  }
  m = phrase.match(new RegExp(`(?:^|\\s)(?:on )?(?:the |every |each )?(1st|2nd|3rd|4th|first|second|third|fourth|last) (${WEEKDAY_WORDS}) (?:of )?(?:every|each|the) month(?=\\s|$)`));
  if (!m) m = phrase.match(new RegExp(`(?:^|\\s)(?:every|each) (1st|2nd|3rd|4th|first|second|third|fourth|last) (${WEEKDAY_WORDS})(?=\\s|$)`));
  if (m) return { rule: { ...blank("month"), monthBy: { nth: NTH[m[1]], weekday: WEEKDAY[m[2]] } }, m };
  m = phrase.match(/(?:^|\s)(?:on )?(?:the )?last day of (?:every|each|the) month(?=\s|$)|(?:^|\s)(?:every|each) month on the last day(?=\s|$)/);
  if (m) return { rule: { ...blank("month"), monthBy: { day: -1 } }, m };
  return null;
}

/** Pull a repeat rule out of `phrase` (lowercase). */
export function takeRepeat(phrase: string): RepeatMatch {
  // "… until dec 18": the end of the series, read separately.
  const u = phrase.match(/(?:^|\s)(?:until|till|through) (.+)$/);
  if (u && /(?:^|\s)(?:every|each|daily|weekly|monthly|yearly|weekdays|annually|fortnightly)(?=\s|$)/.test(phrase.slice(0, u.index))) {
    const inner = takeRepeat(clean(phrase.slice(0, u.index)));
    if (inner.repeat) return { ...inner, untilText: u[1].trim() };
  }
  const none: RepeatMatch = { repeat: null, weekday: null, monthDay: null, rest: phrase };
  const cut = (m: RegExpMatchArray) =>
    clean(phrase.slice(0, m.index) + " " + phrase.slice((m.index ?? 0) + m[0].length));

  const custom = takeCustom(phrase);
  if (custom) {
    const stored = toStored(custom.rule);
    // "every 2 weeks" is just the preset.
    return { repeat: stored, weekday: null, monthDay: null, rest: cut(custom.m), custom: !stored.startsWith("rrule:") ? undefined : true };
  }

  let m = phrase.match(new RegExp(`(?:^|\\s)(?:every|each)\\s+(${WEEKDAY_WORDS})s?(?=\\s|$)`));
  if (!m) m = phrase.match(/(?:^|\s)(mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)(?=\s|$)/);
  if (m) {
    const word = m[1].replace(/s$/, "");
    const wd = WEEKDAY[word] ?? WEEKDAY[m[1]];
    if (wd !== undefined) return { repeat: "weekly", weekday: wd, monthDay: null, rest: cut(m) };
  }

  m = phrase.match(/(?:^|\s)(?:on )?(?:the )?(\d{1,2})(?:st|nd|rd|th)? (?:of )?(?:every|each) month(?=\s|$)/);
  if (!m) m = phrase.match(/(?:^|\s)(?:every|each) month on the (\d{1,2})(?:st|nd|rd|th)?(?=\s|$)/);
  if (!m) m = phrase.match(/(?:^|\s)monthly on the (\d{1,2})(?:st|nd|rd|th)?(?=\s|$)/);
  if (m) {
    const day = Number(m[1]);
    if (day >= 1 && day <= 31) return { repeat: "monthly", weekday: null, monthDay: day, rest: cut(m) };
  }

  const simple: [RegExp, Repeat][] = [
    [/(?:^|\s)(?:every|each) ?(?:week ?day|work ?day)s?(?=\s|$)|(?:^|\s)weekdays(?=\s|$)/, "weekdays"],
    [/(?:^|\s)(?:every other week|every (?:2|two) weeks|bi-?weekly|fortnightly)(?=\s|$)/, "biweekly"],
    [/(?:^|\s)(?:every day|each day|daily|every morning|every evening|every night)(?=\s|$)/, "daily"],
    [/(?:^|\s)(?:every week|each week|weekly)(?=\s|$)/, "weekly"],
    [/(?:^|\s)(?:every month|each month|monthly)(?=\s|$)/, "monthly"],
    [/(?:^|\s)(?:every year|each year|yearly|annually)(?=\s|$)/, "yearly"],
  ];
  for (const [re, repeat] of simple) {
    m = phrase.match(re);
    if (m) {
      let rest = cut(m);
      // "every morning" also carries a time.
      const t = m[0].match(/morning|evening|night/);
      if (t) rest += t[0] === "morning" ? " morning" : t[0] === "evening" ? " evening" : " tonight";
      return { repeat, weekday: null, monthDay: null, rest: clean(rest) };
    }
  }
  return none;
}

// ── Whole phrases ───────────────────────────────────────────────────────────

const LEADING_FILLER = new Set(["by", "on", "at", "due", "before", "until", "till", "starting", "from", "the", "of", "and"]);
const TRAILING_FILLER = new Set(["on", "at", "by", "the", "of", "and"]);

function stripFiller(s: string): string {
  const words = clean(s).split(" ").filter(Boolean);
  while (words.length && LEADING_FILLER.has(words[0])) words.shift();
  while (words.length && TRAILING_FILLER.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

/**
 * Resolve a whole date phrase, including time and repeats. `leftover` is
 * true when some words weren't understood.
 */
export function resolveSchedule(
  phrase: string,
  reference: Date,
  order: DayOrder = "MDY",
): Schedule & { leftover: boolean } {
  const today = startOfDay(reference);
  const lower = phrase.toLowerCase().trim();
  const rep = takeRepeat(lower);
  const { time, rest: afterTime } = takeTime(rep.rest);
  const rest = stripFiller(afterTime);

  let date: string | null = null;
  let alternatives: string[] = [];
  let confident = false;
  let leftover = false;
  if (rest) {
    const r = resolveDatePhrase(rest, reference, order);
    if (r.date) {
      ({ date, alternatives, confident } = r);
    } else {
      leftover = true;
    }
  }

  let repeat = rep.repeat;
  if (repeat && rep.untilText) {
    const end = resolveDatePhrase(stripFiller(rep.untilText), reference, order).date;
    const rule = parseRepeat(repeat);
    if (end && rule) repeat = toStored({ ...rule, until: end });
    else leftover = true;
  }
  if (rep.custom && !date) {
    // The first day the rule lands on, today included.
    const rule = parseRepeat(repeat);
    const yesterday = toISODate(addDays(today, -1));
    if (rule) date = nextDay({ ...rule, until: null, count: null }, yesterday, yesterday);
  }
  if (rep.repeat) {
    if (rep.weekday !== null) {
      date = toISODate(addDays(today, (rep.weekday - today.getDay() + 7) % 7));
    } else if (rep.monthDay !== null) {
      let d = new Date(today.getFullYear(), today.getMonth(), rep.monthDay);
      if (d.getDate() !== rep.monthDay || d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, rep.monthDay);
      date = toISODate(d);
    }
    date ??= toISODate(today);
    confident = true;
  }

  if (time && !date) {
    // "5pm" alone: today if it's still ahead, otherwise tomorrow.
    const [h, m] = time.split(":").map(Number);
    const at = new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m);
    date = toISODate(at > reference ? today : addDays(today, 1));
    confident = true;
  }

  return { date, time, repeat, alternatives, confident, leftover };
}

// ── Finding a schedule inside text ──────────────────────────────────────────

export interface Found extends Schedule {
  /** The text without the schedule words. */
  title: string;
  /** The words that were read as the schedule, as typed. */
  matched: string | null;
}

const PREPOSITIONS = new Set(["by", "on", "at", "due", "before", "until", "till", "every", "next", "this", "from", "@"]);
const WEAK_SINGLE = /^(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat|may|march)$/;

function bare(token: string): string {
  return token.toLowerCase().replace(/^[("'[]+|[)"'\],.;:!?]+$/g, "");
}

/**
 * Find the longest run of words in `text` that reads as a schedule. Short
 * or easily mistaken words ("sun", "may", "3-4") only count after "by",
 * "on", "at" and similar.
 */
export function findSchedule(text: string, reference: Date, order: DayOrder = "MDY"): Found {
  const tokens = text.split(/\s+/).filter(Boolean);
  const empty: Found = {
    title: text.trim(),
    matched: null,
    date: null,
    time: null,
    repeat: null,
    alternatives: [],
    confident: false,
  };
  let best: { i: number; j: number; s: Schedule } | null = null;

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].startsWith("#")) continue;
    for (let j = Math.min(tokens.length, i + 8); j > i; j--) {
      if (best && j - i < best.j - best.i) break;
      const words = tokens.slice(i, j).map(bare);
      if (words.some((w) => !w || w.startsWith("#"))) continue;
      const phrase = words.join(" ");
      const s = resolveSchedule(phrase, reference, order);
      if (s.leftover || !(s.date || s.time || s.repeat)) continue;
      const prev = i > 0 ? bare(tokens[i - 1]) : "";
      const guarded = PREPOSITIONS.has(prev) || PREPOSITIONS.has(words[0]);
      if (words.length === 1 && WEAK_SINGLE.test(words[0]) && !guarded) continue;
      if (words.length === 1 && /^\d{1,2}[-.]\d{1,2}$/.test(words[0]) && !guarded) continue;
      if (!best || j - i > best.j - best.i || (j - i === best.j - best.i && i > best.i)) {
        best = { i, j, s };
      }
      break;
    }
  }
  if (!best) return empty;

  let start = best.i;
  // Drop a dangling "by"/"on"/"due" left in front of the phrase.
  if (start > 0 && PREPOSITIONS.has(bare(tokens[start - 1])) && bare(tokens[start - 1]) !== "every") start -= 1;
  const title = clean([...tokens.slice(0, start), ...tokens.slice(best.j)].join(" "));
  return {
    ...best.s,
    title,
    matched: tokens.slice(start, best.j).join(" "),
  };
}

/** "5:00 PM" in the user's locale (12/24-hour as they prefer). */
/** The clock the user picked: 12- or 24-hour, or undefined for the Mac's own. */
let hour12: boolean | undefined;
export function setClock(clock: "auto" | "12" | "24") {
  hour12 = clock === "12" ? true : clock === "24" ? false : undefined;
}
export const clockHour12 = () => hour12;

export function timeLabel(time: string, locale?: string): string {
  const [h, m] = time.split(":").map(Number);
  const d = new Date(2000, 0, 1, h, m);
  try {
    return d.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit", hour12 });
  } catch {
    return time;
  }
}

/**
 * Read the model's date phrase for a captured task. `mustAsk` is true when
 * the phrase was vague, so the card asks before saving.
 */
export function resolveCaptured(
  dateText: string | null,
  confidence: "high" | "low" | "none",
  reference: Date,
  order: DayOrder = "MDY",
): Schedule & { mustAsk: boolean } {
  if (!dateText || confidence === "none") {
    return { date: null, time: null, repeat: null, alternatives: [], confident: false, mustAsk: true };
  }
  let s: Schedule & { leftover?: boolean } = resolveSchedule(dateText, reference, order);
  if (s.leftover && !s.date) {
    // Fall back to the day-only reader, which ignores trailing noise.
    const r = resolveDatePhrase(dateText, reference, order);
    s = { ...s, date: r.date, alternatives: r.alternatives, confident: r.confident };
  }
  const confident = s.confident && confidence === "high" && !!s.date;
  return {
    date: s.date,
    time: s.time,
    repeat: s.repeat,
    alternatives: s.alternatives,
    confident,
    mustAsk: !confident,
  };
}

/**
 * The days a repeating task lands on from `start` (inclusive) up to and
 * including `until`, at most `max` of them. Mirrors the app's own rules
 * (`todocity_core::recurrence`): a month or year keeps the start's day of
 * the month where it can (Jan 31 → Feb 28 → Mar 31).
 */
export function repeatDates(start: string, rule: string, until: string, max = 120): string[] {
  const r = parseRepeat(rule);
  if (!r || start > until) return start <= until ? [start] : [];
  return upcoming(r, start, until, max);
}
