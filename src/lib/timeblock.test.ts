import { describe, expect, it } from "vitest";
import { blockFit, drawnLen, foldBlocks, durationLabel, endOf, layoutBlocks, minutesOf, parseDuration, snapMinute, takeDuration, timeOf } from "./timeblock";

describe("minutes and times", () => {
  it("round-trips any minute", () => {
    expect(minutesOf("09:07")).toBe(547);
    expect(timeOf(547)).toBe("09:07");
    expect(timeOf(-5)).toBe("00:00");
    expect(timeOf(24 * 60 + 30)).toBe("23:59");
  });
  it("ends a block", () => {
    expect(endOf("09:07", 7)).toBe("09:14");
    expect(endOf("23:30", 90)).toBe("23:59");
    expect(endOf("09:00", null)).toBeNull();
  });
});

describe("durationLabel", () => {
  it("says lengths plainly", () => {
    expect(durationLabel(7)).toBe("7 min");
    expect(durationLabel(60)).toBe("1 hr");
    expect(durationLabel(90)).toBe("1 hr 30 min");
    expect(durationLabel(1440)).toBe("1 day");
    expect(durationLabel(null)).toBeNull();
    expect(durationLabel(0)).toBeNull();
  });
});

describe("parseDuration", () => {
  it("takes any number of minutes", () => {
    expect(parseDuration("7")).toBe(7);
    expect(parseDuration("7m")).toBe(7);
    expect(parseDuration("7 min")).toBe(7);
    expect(parseDuration("45 mins")).toBe(45);
    expect(parseDuration("90 minutes")).toBe(90);
  });
  it("takes hours and mixes", () => {
    expect(parseDuration("1h")).toBe(60);
    expect(parseDuration("1.5 h")).toBe(90);
    expect(parseDuration("2 hours")).toBe(120);
    expect(parseDuration("1h30")).toBe(90);
    expect(parseDuration("1 hr 15 min")).toBe(75);
    expect(parseDuration("half an hour")).toBe(30);
  });
  it("caps at a day and refuses nonsense", () => {
    expect(parseDuration("48 hours")).toBe(1440);
    expect(parseDuration("0")).toBeNull();
    expect(parseDuration("soon")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });
});

describe("takeDuration", () => {
  it("finds 'for …' in a typed task", () => {
    expect(takeDuration("Stand-up tomorrow 9:07 for 7 min")).toEqual({ minutes: 7, rest: "Stand-up tomorrow 9:07" });
    expect(takeDuration("Deep work for 1h30 friday")).toEqual({ minutes: 90, rest: "Deep work friday" });
    expect(takeDuration("Walk for half an hour")).toEqual({ minutes: 30, rest: "Walk" });
  });
  it("leaves times and plain text alone", () => {
    expect(takeDuration("Call Maya in 30 min")).toEqual({ minutes: null, rest: "Call Maya in 30 min" });
    expect(takeDuration("Look for the receipts")).toEqual({ minutes: null, rest: "Look for the receipts" });
  });
});

describe("snapMinute", () => {
  it("snaps to 5 minutes inside the hour", () => {
    expect(snapMinute(0)).toBe(0);
    expect(snapMinute(0.12)).toBe(5);
    expect(snapMinute(0.62)).toBe(35);
    expect(snapMinute(0.999)).toBe(55);
    expect(snapMinute(Number.NaN)).toBe(0);
  });
});

describe("layoutBlocks", () => {
  it("puts overlapping blocks side by side", () => {
    const l = layoutBlocks([
      { key: "a", start: 540, len: 60 },
      { key: "b", start: 560, len: 30 },
      { key: "c", start: 600, len: 30 },
      { key: "d", start: 700, len: 15 },
    ]);
    expect(l.get("a")).toMatchObject({ col: 0, cols: 2 });
    expect(l.get("b")).toMatchObject({ col: 1, cols: 2 });
    expect(l.get("c")).toMatchObject({ col: 0, cols: 1 }); // a and b have ended by 10:00
    expect(l.get("d")).toMatchObject({ col: 0, cols: 1 });
    expect(l.get("c")?.run).not.toBe(l.get("a")?.run);
  });
  it("gives a lone block the whole width", () => {
    expect(layoutBlocks([{ key: "x", start: 0, len: 7 }]).get("x")).toEqual({ col: 0, cols: 1, run: 0 });
  });
});

describe("short blocks", () => {
  it("fit their label to their height", () => {
    expect(blockFit(22)).toBe("line");
    expect(blockFit(33)).toBe("line");
    expect(blockFit(40)).toBe("two");
    expect(blockFit(52)).toBe("full");
  });
  it("lay out at the height they're drawn, so a 5-minute task doesn't hide under the next", () => {
    const len = drawnLen(5, 52);
    expect(len).toBeGreaterThan(25);
    const l = layoutBlocks([
      { key: "a", start: 600, len },
      { key: "b", start: 615, len: drawnLen(30, 52) },
    ]);
    expect(l.get("a")?.cols).toBe(2);
    expect(drawnLen(60, 52)).toBe(60);
  });
  it("fold a crowded hour into +N instead of thin slivers", () => {
    const blocks = [
      { key: "a", start: 840, len: 30 },
      { key: "b", start: 840, len: 30 },
      { key: "c", start: 840, len: 30 },
      { key: "d", start: 845, len: 30 },
      { key: "e", start: 1000, len: 30 },
    ];
    const { shown, folds } = foldBlocks(blocks, layoutBlocks(blocks), 2);
    expect([...shown.keys()].sort()).toEqual(["a", "e"]);
    expect(shown.get("a")).toMatchObject({ col: 0, cols: 2 });
    expect(shown.get("e")).toMatchObject({ col: 0, cols: 1 });
    expect(folds).toEqual([{ start: 840, len: 35, keys: ["b", "c", "d"] }]);
  });
  it("keep two side by side", () => {
    const blocks = [
      { key: "a", start: 0, len: 30 },
      { key: "b", start: 0, len: 30 },
    ];
    const { shown, folds } = foldBlocks(blocks, layoutBlocks(blocks), 2);
    expect(shown.size).toBe(2);
    expect(folds).toEqual([]);
  });
});
