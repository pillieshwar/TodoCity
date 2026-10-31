import { describe, expect, it } from "vitest";
import { PRESETS, alignStart, describe as words, nextDay, parseRepeat, repeatBrief, toStored, upcoming } from "./repeat";

const rule = (s: string) => {
  const r = parseRepeat(s);
  if (!r) throw new Error(`not a rule: ${s}`);
  return r;
};

describe("repeat rules", () => {
  it("keep the presets' names, so older versions read them", () => {
    for (const p of PRESETS) expect(toStored(rule(p))).toBe(p);
    expect(toStored(rule("rrule:FREQ=WEEKLY;INTERVAL=2"))).toBe("biweekly");
    expect(parseRepeat("hourly")).toBeNull();
    expect(parseRepeat("rrule:FREQ=HOURLY")).toBeNull();
    expect(parseRepeat("rrule:FREQ=DAILY;INTERVAL=0")).toBeNull();
  });

  it("write custom rules exactly as the app does", () => {
    for (const s of [
      "rrule:FREQ=DAILY;INTERVAL=3",
      "rrule:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
      "rrule:FREQ=MONTHLY;BYDAY=2TU;COUNT=6",
      "rrule:FREQ=MONTHLY;BYDAY=-1FR",
      "rrule:FREQ=MONTHLY;BYMONTHDAY=-1",
      "rrule:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15;UNTIL=20271231",
      "rrule:FREQ=WEEKLY;FROM=DONE",
    ])
      expect(toStored(rule(s))).toBe(s);
  });

  it("every other Monday and Wednesday, up to a deadline", () => {
    const r = rule("rrule:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE");
    expect(nextDay(r, "2026-11-02", "2026-11-02")).toBe("2026-11-04");
    expect(nextDay(r, "2026-11-04", "2026-11-04")).toBe("2026-11-16");
    const days = upcoming(r, "2026-11-02", "2026-12-18");
    expect(days).toEqual(["2026-11-02", "2026-11-04", "2026-11-16", "2026-11-18", "2026-11-30", "2026-12-02", "2026-12-14", "2026-12-16"]);
  });

  it("months: the 2nd Tuesday, the last Friday, the last day", () => {
    expect(upcoming(rule("rrule:FREQ=MONTHLY;BYDAY=2TU;COUNT=6"), "2026-11-10", null)).toEqual([
      "2026-11-10",
      "2026-12-08",
      "2027-01-12",
      "2027-02-09",
      "2027-03-09",
      "2027-04-13",
    ]);
    expect(nextDay(rule("rrule:FREQ=MONTHLY;BYDAY=-1FR"), "2026-10-30", "2026-10-30")).toBe("2026-11-27");
    const last = rule("rrule:FREQ=MONTHLY;BYMONTHDAY=-1");
    expect(nextDay(last, "2027-01-31", "2027-01-31")).toBe("2027-02-28");
    expect(nextDay(last, "2027-02-28", "2027-02-28")).toBe("2027-03-31");
  });

  it("stays on the schedule when finished late or early, unless it counts from the finish", () => {
    const r = rule("rrule:FREQ=DAILY;INTERVAL=3");
    expect(nextDay(r, "2026-10-01", "2026-10-14")).toBe("2026-10-16");
    expect(nextDay(rule("rrule:FREQ=WEEKLY;INTERVAL=2;FROM=DONE"), "2026-10-01", "2026-10-14", "2026-10-14")).toBe("2026-10-28");
  });

  it("matches the presets' old steps", () => {
    expect(nextDay(rule("weekdays"), "2026-10-16", "2026-10-16")).toBe("2026-10-19");
    expect(nextDay(rule("monthly"), "2026-10-14", "2026-10-14")).toBe("2026-11-14");
    expect(nextDay(rule("yearly"), "2026-10-14", "2026-10-14")).toBe("2027-10-14");
    expect(nextDay(rule("weekly"), "2026-10-05", "2026-10-14")).toBe("2026-10-19");
  });

  it("moves a task onto the first day the rule names", () => {
    // Saturday, Oct 31 with "Mon and Wed": Monday, Nov 2.
    expect(alignStart(rule("rrule:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE"), "2026-10-31")).toBe("2026-11-02");
    expect(alignStart(rule("rrule:FREQ=WEEKLY;BYDAY=SA"), "2026-10-31")).toBe("2026-10-31");
    expect(alignStart(rule("rrule:FREQ=MONTHLY;BYDAY=2TU"), "2026-10-31")).toBe("2026-11-10");
    expect(alignStart(rule("weekly"), "2026-10-31")).toBe("2026-10-31");
  });

  it("ends on its date", () => {
    const r = rule("rrule:FREQ=WEEKLY;UNTIL=20261115");
    expect(nextDay(r, "2026-11-07", "2026-11-07")).toBe("2026-11-14");
    expect(nextDay(r, "2026-11-14", "2026-11-14")).toBeNull();
  });

  it("says it in plain words", () => {
    expect(words(rule("rrule:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE"))).toBe("Every 2 weeks on Monday, Wednesday");
    expect(words(rule("rrule:FREQ=MONTHLY;BYDAY=2TU;COUNT=6"))).toBe("Every month on the 2nd Tuesday · 6 times");
    expect(words(rule("rrule:FREQ=MONTHLY;BYMONTHDAY=-1"))).toBe("Every month on the last day");
    expect(words(rule("weekly"))).toBe("Every week");
    expect(repeatBrief("weekly", "2026-10-31")).toBe("Saturdays");
    expect(repeatBrief("rrule:FREQ=MONTHLY;BYMONTHDAY=1", "2026-10-31")).toBe("Monthly · 1st");
    expect(repeatBrief("rrule:FREQ=DAILY;INTERVAL=3", "2026-10-31")).toBe("Every 3 days");
  });
});
