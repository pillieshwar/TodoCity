import { describe, expect, it } from "vitest";
import { findSchedule, resolveCaptured, resolveSchedule, takeRepeat, takeTime } from "./schedule";

// Tuesday, 13 October 2026, 3:30 pm local time.
const TUE = new Date(2026, 9, 13, 15, 30);

describe("takeTime", () => {
  it("reads 12- and 24-hour times", () => {
    expect(takeTime("friday 5pm")).toEqual({ time: "17:00", rest: "friday" });
    expect(takeTime("friday at 5:30 p.m.").time).toBe("17:30");
    expect(takeTime("12am").time).toBe("00:00");
    expect(takeTime("12pm").time).toBe("12:00");
    expect(takeTime("oct 20 at 09:15").time).toBe("09:15");
    expect(takeTime("tomorrow at 5").time).toBe("17:00");
    expect(takeTime("tomorrow at 9").time).toBe("09:00");
    expect(takeTime("tomorrow noon").time).toBe("12:00");
    expect(takeTime("tomorrow morning")).toEqual({ time: "09:00", rest: "tomorrow" });
    expect(takeTime("friday eod").time).toBe("17:00");
  });

  it("knows 'tonight' is today", () => {
    expect(takeTime("tonight")).toEqual({ time: "20:00", rest: "today" });
  });

  it("leaves dates alone", () => {
    expect(takeTime("oct 20").time).toBeNull();
    expect(takeTime("10/20").time).toBeNull();
    expect(takeTime("13pm").time).toBeNull();
  });
});

describe("takeRepeat", () => {
  it("reads common repeats", () => {
    expect(takeRepeat("every day").repeat).toBe("daily");
    expect(takeRepeat("daily").repeat).toBe("daily");
    expect(takeRepeat("every weekday").repeat).toBe("weekdays");
    expect(takeRepeat("every other week").repeat).toBe("biweekly");
    expect(takeRepeat("weekly").repeat).toBe("weekly");
    expect(takeRepeat("every month").repeat).toBe("monthly");
    expect(takeRepeat("annually").repeat).toBe("yearly");
  });

  it("reads weekdays and days of the month", () => {
    expect(takeRepeat("every monday")).toMatchObject({ repeat: "weekly", weekday: 1, rest: "" });
    expect(takeRepeat("fridays at 4pm")).toMatchObject({ repeat: "weekly", weekday: 5, rest: "at 4pm" });
    expect(takeRepeat("on the 1st of every month")).toMatchObject({ repeat: "monthly", monthDay: 1 });
    expect(takeRepeat("every month on the 15th")).toMatchObject({ repeat: "monthly", monthDay: 15 });
  });

  it("reads custom repeats", () => {
    expect(takeRepeat("every other tuesday").repeat).toBe("rrule:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU");
    expect(takeRepeat("every mon and wed").repeat).toBe("rrule:FREQ=WEEKLY;BYDAY=MO,WE");
    expect(takeRepeat("every 3 days").repeat).toBe("rrule:FREQ=DAILY;INTERVAL=3");
    expect(takeRepeat("every 2 weeks").repeat).toBe("biweekly");
    expect(takeRepeat("the 2nd tuesday of every month").repeat).toBe("rrule:FREQ=MONTHLY;BYDAY=2TU");
    expect(takeRepeat("every last friday").repeat).toBe("rrule:FREQ=MONTHLY;BYDAY=-1FR");
    expect(takeRepeat("last day of every month").repeat).toBe("rrule:FREQ=MONTHLY;BYMONTHDAY=-1");
    expect(takeRepeat("every weekday until dec 18")).toMatchObject({ repeat: "weekdays", untilText: "dec 18" });
  });

  it("keeps a time hidden in 'every morning'", () => {
    const r = takeRepeat("every morning");
    expect(r.repeat).toBe("daily");
    expect(takeTime(r.rest).time).toBe("09:00");
  });
});

describe("custom repeats in a phrase", () => {
  it("start on the first day they land on, and end on 'until'", () => {
    const tue = resolveSchedule("every other tuesday", TUE);
    expect(tue).toMatchObject({ date: "2026-10-13", repeat: "rrule:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU" });
    expect(resolveSchedule("the 2nd tuesday of every month", TUE).date).toBe("2026-10-13");
    expect(resolveSchedule("last day of every month", TUE).date).toBe("2026-10-31");
    expect(resolveSchedule("every weekday until dec 18", TUE)).toMatchObject({
      repeat: "rrule:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;UNTIL=20261218",
      leftover: false,
    });
  });
});

describe("resolveSchedule", () => {
  it("combines day, time and repeat", () => {
    expect(resolveSchedule("by Friday 3pm", TUE)).toMatchObject({
      date: "2026-10-16",
      time: "15:00",
      repeat: null,
      confident: true,
      leftover: false,
    });
    expect(resolveSchedule("every Monday at 9", TUE)).toMatchObject({
      date: "2026-10-19",
      time: "09:00",
      repeat: "weekly",
    });
    expect(resolveSchedule("on the 1st of every month", TUE)).toMatchObject({
      date: "2026-11-01",
      repeat: "monthly",
    });
    expect(resolveSchedule("every day", TUE)).toMatchObject({ date: "2026-10-13", repeat: "daily" });
  });

  it("puts a bare time today, or tomorrow once it has passed", () => {
    expect(resolveSchedule("5pm", TUE)).toMatchObject({ date: "2026-10-13", time: "17:00" });
    expect(resolveSchedule("9am", TUE)).toMatchObject({ date: "2026-10-14", time: "09:00" });
  });

  it("flags words it didn't understand", () => {
    expect(resolveSchedule("call mom at 5pm", TUE).leftover).toBe(true);
    expect(resolveSchedule("soon", TUE)).toMatchObject({ date: null, leftover: true });
  });
});

describe("findSchedule", () => {
  const f = (text: string) => findSchedule(text, TUE);

  it("splits a typed task into title and schedule", () => {
    expect(f("pay rent friday 5pm #home")).toMatchObject({
      title: "pay rent #home",
      date: "2026-10-16",
      time: "17:00",
      matched: "friday 5pm",
    });
    expect(f("Send the deck to Priya by tomorrow")).toMatchObject({
      title: "Send the deck to Priya",
      date: "2026-10-14",
      time: null,
    });
    expect(f("call mom at 5pm")).toMatchObject({ title: "call mom", date: "2026-10-13", time: "17:00" });
    expect(f("Water the plants every Monday morning")).toMatchObject({
      title: "Water the plants",
      repeat: "weekly",
      date: "2026-10-19",
      time: "09:00",
    });
    expect(f("submit expenses eod")).toMatchObject({ title: "submit expenses", time: "17:00" });
  });

  it("doesn't mistake ordinary words for dates", () => {
    expect(f("Buy sun screen")).toMatchObject({ title: "Buy sun screen", date: null });
    expect(f("I may call later")).toMatchObject({ date: null });
    expect(f("Read chapter 3-4")).toMatchObject({ date: null });
    expect(f("Review today's notes")).toMatchObject({ date: null });
  });

  it("accepts short words after a preposition", () => {
    expect(f("Dentist on sat")).toMatchObject({ title: "Dentist", date: "2026-10-17" });
  });

  it("returns the text untouched when there's no schedule", () => {
    expect(f("  Email Sam  ")).toMatchObject({ title: "Email Sam", matched: null, date: null });
  });
});

describe("resolveCaptured", () => {
  it("keeps times and repeats from the model's phrase", () => {
    expect(resolveCaptured("by Friday 3pm", "high", TUE)).toMatchObject({
      date: "2026-10-16",
      time: "15:00",
      mustAsk: false,
    });
    expect(resolveCaptured("every Monday", "high", TUE)).toMatchObject({ repeat: "weekly", date: "2026-10-19" });
  });

  it("asks when the model or the phrase is unsure", () => {
    expect(resolveCaptured("next week", "low", TUE).mustAsk).toBe(true);
    expect(resolveCaptured(null, "none", TUE)).toMatchObject({ date: null, mustAsk: true });
    expect(resolveCaptured("Friday-ish", "high", TUE).mustAsk).toBe(true);
  });
});
