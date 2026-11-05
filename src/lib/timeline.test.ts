import { describe, expect, it } from "vitest";
import { barPlace, clickSpan, dayNum, dragSpan, drawnSpan, fromToday, homeFrom, isoOf, lengthLabel, monthStart, monthsIn, spanDays } from "./timeline";

describe("timeline days", () => {
  it("counts calendar days exactly, across months, leap days and years", () => {
    expect(isoOf(dayNum("2026-11-05"))).toBe("2026-11-05");
    expect(dayNum("2028-03-01") - dayNum("2028-02-28")).toBe(2);
    expect(dayNum("2027-01-01") - dayNum("2026-12-31")).toBe(1);
    expect(monthStart("2026-11-05")).toBe("2026-11-01");
    expect(monthStart("2026-11-05", 2)).toBe("2027-01-01");
    expect(monthStart("2026-01-31", -1)).toBe("2025-12-01");
  });
  it("lists the months in a window", () => {
    const ms = monthsIn(dayNum("2026-10-01"), 92);
    expect(ms.map((m) => m.iso)).toEqual(["2026-10-01", "2026-11-01", "2026-12-01"]);
    expect(ms[0].end - ms[0].start).toBe(31);
    // A window that starts mid-month includes that month.
    expect(monthsIn(dayNum("2026-10-15"), 20)[0].iso).toBe("2026-10-01");
  });
});

describe("dragging a bar", () => {
  const s = { start: "2026-11-02", end: "2026-11-29" };
  it("moves it whole, keeping its length", () => {
    const m = dragSpan(s, "move", 10);
    expect(m).toEqual({ start: "2026-11-12", end: "2026-12-09" });
    expect(spanDays(m)).toBe(spanDays(s));
  });
  it("stretches either edge, never past the other", () => {
    expect(dragSpan(s, "end", 33)).toEqual({ start: "2026-11-02", end: "2027-01-01" });
    expect(dragSpan(s, "start", -2)).toEqual({ start: "2026-10-31", end: "2026-11-29" });
    expect(dragSpan(s, "start", 100)).toEqual({ start: "2026-11-29", end: "2026-11-29" });
    expect(dragSpan(s, "end", -100)).toEqual({ start: "2026-11-02", end: "2026-11-02" });
  });
  it("draws a new one in either direction, or four weeks with a click", () => {
    expect(drawnSpan(dayNum("2026-12-10"), dayNum("2026-11-20"))).toEqual({ start: "2026-11-20", end: "2026-12-10" });
    expect(spanDays(clickSpan(dayNum("2026-11-05")))).toBe(28);
  });
});

describe("labels and places", () => {
  it("says how far from today", () => {
    expect(fromToday("2026-11-05", "2026-11-05")).toBe("Today");
    expect(fromToday("2026-11-08", "2026-11-05")).toBe("3d");
    expect(fromToday("2026-11-26", "2026-11-05")).toBe("3w");
    expect(fromToday("2026-07-05", "2026-11-05")).toBe("-4m");
    expect(fromToday("2028-11-05", "2026-11-05")).toBe("2y");
    expect(lengthLabel({ start: "2026-11-01", end: "2026-11-21" })).toBe("3 weeks");
    expect(lengthLabel({ start: "2026-11-01", end: "2027-01-31" })).toBe("3 months");
  });
  it("places bars in the window and marks the cut ends", () => {
    const from = dayNum("2026-11-01");
    const p = barPlace({ start: "2026-11-11", end: "2026-11-20" }, from, 100, 1000);
    expect(p).toMatchObject({ left: 100, width: 100, visible: true, cutStart: false, cutEnd: false });
    const cut = barPlace({ start: "2026-10-01", end: "2026-11-10" }, from, 100, 1000);
    expect(cut).toMatchObject({ left: 0, width: 100, cutStart: true });
    expect(barPlace({ start: "2026-09-01", end: "2026-09-30" }, from, 100, 1000).visible).toBe(false);
    expect(homeFrom("2026-11-05", "year")).toBe(dayNum("2026-10-01"));
    expect(homeFrom("2026-11-05", "quarter")).toBe(dayNum("2026-11-01"));
  });
});
