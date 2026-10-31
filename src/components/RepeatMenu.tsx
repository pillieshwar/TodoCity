import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from "react";
import { LineIcon } from "./LineIcon";
import { parseISODate, toISODate } from "../lib/dates";
import { alignStart, describe, ordinal, parseRepeat, presetRule, toStored, upcoming, type Freq, type RepeatRule } from "../lib/repeat";
import type { TaskPatch } from "../lib/types";
import type { FieldValues } from "./TaskFields";

const QUICK: { id: string; label: string }[] = [
  { id: "daily", label: "Every day" },
  { id: "weekdays", label: "Every weekday" },
  { id: "weekly", label: "Every week" },
  { id: "biweekly", label: "Every 2 weeks" },
  { id: "monthly", label: "Every month" },
  { id: "yearly", label: "Every year" },
];

/**
 * Keep a menu on screen: open it above its button when there's more room
 * there, and let it scroll when neither side has room for all of it.
 */
function useFit(ref: RefObject<HTMLDivElement | null>, key: unknown): CSSProperties {
  const [style, setStyle] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    const el = ref.current;
    const anchor = el?.parentElement;
    if (!el || !anchor) return;
    el.style.maxHeight = "";
    const menu = el.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const below = window.innerHeight - a.bottom - 14;
    const above = a.top - 14;
    if (menu.height <= below) setStyle({});
    else if (above > below) setStyle({ top: "auto", bottom: "calc(100% + 6px)", maxHeight: Math.max(160, above), overflowY: "auto" });
    else setStyle({ maxHeight: Math.max(160, below), overflowY: "auto" });
    // Measure again when what's inside changes size.
  }, [ref, key]);
  return style;
}

const fmtDay = (iso: string, locale: string) => parseISODate(iso).toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" });

/**
 * The repeat menu, under the repeat icon: quick picks, "After I finish",
 * Custom…, how it ends (the deadline always ends it), and skip, pause or
 * stop for a saved series.
 */
export function RepeatMenu({
  value,
  now,
  locale,
  series,
  onChange,
  onClose,
}: {
  value: FieldValues;
  now: Date;
  locale: string;
  series?: { onSkip: () => void; onPause: (paused: boolean) => void };
  onChange: (patch: TaskPatch) => void;
  onClose: () => void;
}) {
  const today = toISODate(now);
  const start = value.date ?? today;
  const current = parseRepeat(value.repeat);
  const [custom, setCustom] = useState<false | "custom" | "after">(false);
  const box = useRef<HTMLDivElement>(null);
  const fit = useFit(box, custom);
  const weekday = parseISODate(start).toLocaleDateString(locale, { weekday: "long" });
  const hint: Record<string, string> = {
    weekdays: "Mon–Fri",
    weekly: `on ${weekday}`,
    biweekly: `on ${weekday}`,
    monthly: `on the ${ordinal(parseISODate(start).getDate())}`,
    yearly: `on ${parseISODate(start).toLocaleDateString(locale, { month: "short", day: "numeric" })}`,
  };
  // Picking a repeat on a task with no day starts it on its first day (today, or the next one it lands on).
  const set = (r: RepeatRule | null) => {
    if (!r) onChange({ recurrence: null });
    else {
      // On the first day the rule names ("Mon, Wed" moves a Saturday task to Monday).
      onChange({ due_date: alignStart(r, start), recurrence: toStored(r) });
    }
    onClose();
  };

  if (custom) {
    const initial = custom === "after" && !current?.afterDone ? { ...presetRule("weekly"), afterDone: true } : current;
    return <RepeatEditor value={value} start={start} locale={locale} initial={initial} onCancel={() => setCustom(false)} onDone={set} />;
  }

  const stored = value.repeat;
  return (
    <div className="tf-menu right" role="menu" aria-label="Repeat" ref={box} style={fit}>
      <div className="tf-head">Repeat</div>
      {QUICK.map((r) => (
        <button
          key={r.id}
          type="button"
          role="menuitemradio"
          aria-checked={stored === r.id}
          className={stored === r.id ? "tf-opt sel" : "tf-opt"}
          onClick={() => set(presetRule(r.id as Parameters<typeof presetRule>[0]))}
        >
          {r.label}
          {hint[r.id] && <em>{hint[r.id]}</em>}
        </button>
      ))}
      <button
        type="button"
        role="menuitemradio"
        aria-checked={!!current?.afterDone}
        className={current?.afterDone ? "tf-opt sel" : "tf-opt"}
        onClick={() => setCustom("after")}
      >
        After I finish…
        {current?.afterDone && <em>{describe(current, locale, { ends: false }).replace(/^Every /, "").replace(/ after it's done$/, "")}</em>}
      </button>
      {current && !current.afterDone && !QUICK.some((q) => q.id === stored) ? (
        <button type="button" role="menuitemradio" aria-checked className="tf-opt sel" onClick={() => setCustom("custom")}>
          {describe(current, locale)}
          <em>Edit</em>
        </button>
      ) : (
        <button type="button" role="menuitem" className="tf-opt" onClick={() => setCustom("custom")}>
          Custom…
        </button>
      )}
      {current && <EndsNote rule={current} start={start} deadline={value.deadline} locale={locale} />}
      {current && (
        <div className="tf-trio">
          {series && (
            <button
              type="button"
              onClick={() => {
                series.onSkip();
                onClose();
              }}
            >
              Skip next
            </button>
          )}
          {series && (
            <button
              type="button"
              onClick={() => {
                series.onPause(!value.paused);
                onClose();
              }}
            >
              {value.paused ? "Resume" : "Pause"}
            </button>
          )}
          <button type="button" title="Stop repeating" onClick={() => set(null)}>
            Stop
          </button>
        </div>
      )}
    </div>
  );
}

/** How a series ends, in words: "6 more times, last one Sat, Dec 12. Ends by the deadline, Dec 18." */
export function EndsNote({ rule, start, deadline, locale }: { rule: RepeatRule; start: string; deadline: string | null; locale: string }) {
  const days = upcoming(rule, start, deadline, 400);
  const ends = deadline !== null || rule.until !== null || rule.count !== null;
  if (!ends) return null;
  const more = days.length - 1;
  const last = days[days.length - 1];
  const by = deadline ? `Ends by the deadline, ${fmtDay(deadline, locale)}.` : rule.until ? `Ends ${fmtDay(rule.until, locale)}.` : "";
  return (
    <div className="tf-note calm">
      <LineIcon name="target" size={15} />
      <span>
        {more === 0 ? "This is the last one." : more === 1 ? `1 more, on ${fmtDay(last, locale)}.` : `${more} more times, last one ${fmtDay(last, locale)}.`} {by}
      </span>
    </div>
  );
}

const UNIT_WORDS: [Freq, string, string][] = [
  ["day", "day", "days"],
  ["week", "week", "weeks"],
  ["month", "month", "months"],
  ["year", "year", "years"],
];
const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const NTH_WORDS: [number, string][] = [
  [1, "1st"],
  [2, "2nd"],
  [3, "3rd"],
  [4, "4th"],
  [-1, "last"],
];

/**
 * Custom…: every N days, weeks, months or years; which weekdays; which day
 * of the month; from the schedule or from when it's finished; and how it
 * ends. A deadline always ends it, so "Never" isn't offered then.
 */
export function RepeatEditor({
  value,
  start,
  locale,
  initial,
  onCancel,
  onDone,
}: {
  value: FieldValues;
  start: string;
  locale: string;
  initial: RepeatRule | null;
  onCancel: () => void;
  onDone: (r: RepeatRule) => void;
}) {
  const startDay = parseISODate(start);
  const [r, setR] = useState<RepeatRule>(() => {
    const base = initial ?? presetRule("weekly");
    // Show the weekday it's on, so the choice is visible.
    return base.freq === "week" && !base.days.length ? { ...base, days: [startDay.getDay()] } : base;
  });
  const [ends, setEnds] = useState<"never" | "date" | "count">(r.count !== null ? "count" : r.until ? "date" : "never");
  const patch = (p: Partial<RepeatRule>) => setR((x) => ({ ...x, ...p }));
  const weekdayName = (d: number, style: "long" | "short" = "long") => new Date(2026, 10, 1 + d).toLocaleDateString(locale, { weekday: style });
  const nthOfStart = Math.min(4, Math.ceil(startDay.getDate() / 7));
  const final: RepeatRule = {
    ...r,
    days: r.freq === "week" && !r.afterDone ? r.days : [],
    monthBy: (r.freq === "month" || r.freq === "year") && !r.afterDone ? r.monthBy : null,
    until: ends === "date" ? (r.until ?? value.deadline ?? start) : null,
    count: ends === "count" ? (r.count ?? 10) : null,
  };
  const preview = upcoming(final, alignStart(final, start), value.deadline, 8);
  const box = useRef<HTMLDivElement>(null);
  const fit = useFit(box, `${r.freq}${r.afterDone}${ends}`);

  return (
    <div className="tf-menu right wide rep-edit" role="dialog" aria-label="Custom repeat" ref={box} style={fit}>
      <div className="tf-head">Repeat</div>
      <div className="rep-line">
        <span className="rep-k">Every</span>
        <input
          className="rep-num"
          type="number"
          min={1}
          max={99}
          value={r.interval}
          aria-label="How many"
          onChange={(e) => patch({ interval: Math.max(1, Math.min(99, Math.round(Number(e.target.value) || 1))) })}
        />
        <select aria-label="Unit" value={r.freq} onChange={(e) => patch({ freq: e.target.value as Freq, days: e.target.value === "week" ? [startDay.getDay()] : [], monthBy: null })}>
          {UNIT_WORDS.map(([f, one, many]) => (
            <option key={f} value={f}>
              {r.interval === 1 ? one : many}
            </option>
          ))}
        </select>
      </div>

      <div className="rep-line">
        <span className="rep-k">Next one</span>
        <span className="rep-seg" role="radiogroup" aria-label="Next one">
          <button type="button" role="radio" aria-checked={!r.afterDone} className={!r.afterDone ? "on" : ""} onClick={() => patch({ afterDone: false })}>
            On schedule
          </button>
          <button type="button" role="radio" aria-checked={r.afterDone} className={r.afterDone ? "on" : ""} onClick={() => patch({ afterDone: true })}>
            After I finish
          </button>
        </span>
      </div>

      {r.freq === "week" && !r.afterDone && (
        <div className="rep-line">
          <span className="rep-k">On</span>
          <span className="rep-days">
            {[0, 1, 2, 3, 4, 5, 6].map((d) => {
              const on = r.days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  aria-label={weekdayName(d)}
                  className={on ? "on" : ""}
                  onClick={() => {
                    const days = on ? r.days.filter((x) => x !== d) : [...r.days, d];
                    if (days.length) patch({ days });
                  }}
                >
                  {DAY_LETTERS[d]}
                </button>
              );
            })}
          </span>
        </div>
      )}

      {(r.freq === "month" || r.freq === "year") && !r.afterDone && (
        <div className="rep-line top">
          <span className="rep-k">On</span>
          <span className="rep-col">
            <label className="rep-radio">
              <input type="radio" name="rep-on" checked={!r.monthBy || ("day" in r.monthBy && r.monthBy.day > 0)} onChange={() => patch({ monthBy: null })} />
              The {ordinal(r.monthBy && "day" in r.monthBy && r.monthBy.day > 0 ? r.monthBy.day : startDay.getDate())}
            </label>
            <label className="rep-radio">
              <input
                type="radio"
                name="rep-on"
                checked={!!r.monthBy && "nth" in r.monthBy}
                onChange={() => patch({ monthBy: { nth: nthOfStart, weekday: startDay.getDay() } })}
              />
              The
              <select
                aria-label="Which one"
                value={r.monthBy && "nth" in r.monthBy ? r.monthBy.nth : nthOfStart}
                onChange={(e) => patch({ monthBy: { nth: Number(e.target.value), weekday: r.monthBy && "nth" in r.monthBy ? r.monthBy.weekday : startDay.getDay() } })}
              >
                {NTH_WORDS.map(([n, w]) => (
                  <option key={n} value={n}>
                    {w}
                  </option>
                ))}
              </select>
              <select
                aria-label="Weekday"
                value={r.monthBy && "nth" in r.monthBy ? r.monthBy.weekday : startDay.getDay()}
                onChange={(e) => patch({ monthBy: { nth: r.monthBy && "nth" in r.monthBy ? r.monthBy.nth : nthOfStart, weekday: Number(e.target.value) } })}
              >
                {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                  <option key={d} value={d}>
                    {weekdayName(d)}
                  </option>
                ))}
              </select>
            </label>
            <label className="rep-radio">
              <input type="radio" name="rep-on" checked={!!r.monthBy && "day" in r.monthBy && r.monthBy.day < 0} onChange={() => patch({ monthBy: { day: -1 } })} />
              The last day
            </label>
          </span>
        </div>
      )}

      <div className="rep-line top">
        <span className="rep-k">Ends</span>
        <span className="rep-col">
          {value.deadline ? (
            <label className="rep-radio">
              <input type="radio" name="rep-ends" checked={ends === "never"} onChange={() => setEnds("never")} />
              At the deadline <b className="rep-dl">{fmtDay(value.deadline, locale)}</b>
            </label>
          ) : (
            <label className="rep-radio">
              <input type="radio" name="rep-ends" checked={ends === "never"} onChange={() => setEnds("never")} />
              Never
            </label>
          )}
          <label className="rep-radio">
            <input type="radio" name="rep-ends" checked={ends === "date"} onChange={() => setEnds("date")} />
            On
            <input
              type="date"
              className="rep-date"
              aria-label="End date"
              min={start}
              max={value.deadline ?? undefined}
              value={final.until ?? ""}
              onFocus={() => setEnds("date")}
              onChange={(e) => e.target.value && patch({ until: e.target.value })}
            />
          </label>
          <label className="rep-radio">
            <input type="radio" name="rep-ends" checked={ends === "count"} onChange={() => setEnds("count")} />
            After
            <input
              className="rep-num"
              type="number"
              min={1}
              max={999}
              aria-label="How many times"
              value={final.count ?? 10}
              onFocus={() => setEnds("count")}
              onChange={(e) => patch({ count: Math.max(1, Math.min(999, Math.round(Number(e.target.value) || 1))) })}
            />
            times
          </label>
        </span>
      </div>

      <div className="rep-preview" aria-label="Next days">
        <span className="rep-sum">{describe(final, locale)}</span>
        <span className="rep-pills">
          {preview.map((d, i) => (
            <span key={d} className={i === preview.length - 1 && (value.deadline || final.until || final.count) ? "last" : ""}>
              {fmtDay(d, locale)}
            </span>
          ))}
        </span>
      </div>
      <EndsNote rule={final} start={alignStart(final, start)} deadline={value.deadline} locale={locale} />

      <div className="rep-actions">
        <button type="button" className="ghost small" onClick={onCancel}>
          Back
        </button>
        <button type="button" className="primary small" onClick={() => onDone(final)}>
          Done
        </button>
      </div>
    </div>
  );
}
