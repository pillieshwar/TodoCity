import { describe, expect, it } from "vitest";
import { addMinutes, canMove, minutesBetween, moved, sameTime, stretched } from "./meetingMove";
import type { CalendarEvent } from "./types";

const ev = (extra: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: "e1",
  title: "Design review",
  start: "2026-11-02T10:00:00",
  end: "2026-11-02T11:00:00",
  all_day: false,
  calendar: "Work",
  color: null,
  movable: "yes",
  ...extra,
});

describe("which meetings move", () => {
  it("moves your own and organized meetings, not invites or all-day ones", () => {
    expect(canMove(ev())).toBe(true);
    expect(canMove(ev({ movable: "everyone" }))).toBe(true);
    expect(canMove(ev({ movable: "no" }))).toBe(false);
    expect(canMove(ev({ movable: undefined }))).toBe(false);
    expect(canMove(ev({ all_day: true }))).toBe(false);
    expect(canMove(ev({ end: "2026-11-03T01:00:00" }))).toBe(false);
  });
});

describe("moving a meeting", () => {
  it("keeps its length and snaps to 5 minutes", () => {
    const m = moved(ev(), 0, 32);
    expect(m.start).toBe("2026-11-02T10:30:00");
    expect(m.end).toBe("2026-11-02T11:30:00");
  });
  it("moves across days", () => {
    const m = moved(ev(), 2, -60);
    expect(m.start).toBe("2026-11-04T09:00:00");
    expect(m.end).toBe("2026-11-04T10:00:00");
  });
  it("stretches between 5 minutes and a day", () => {
    expect(stretched(ev(), 28).end).toBe("2026-11-02T11:30:00");
    expect(stretched(ev(), -200).end).toBe("2026-11-02T10:05:00");
    expect(minutesBetween(ev().start, stretched(ev(), 5000).end)).toBe(1440);
  });
  it("crosses midnight and month ends", () => {
    expect(addMinutes("2026-10-31T23:30:00", 45)).toBe("2026-11-01T00:15:00");
  });
  it("knows when nothing changed", () => {
    expect(sameTime(ev(), moved(ev(), 0, 2))).toBe(true);
    expect(sameTime(ev(), moved(ev(), 0, 5))).toBe(false);
  });
});
