import { describe, expect, it } from "vitest";
import { flipDeltas, shouldGreet, tickDirection, tipPlace } from "./motion";

const m = (o: Record<string, [number, number]>) => new Map(Object.entries(o).map(([k, [x, y]]) => [k, { x, y }]));

describe("flipDeltas", () => {
  it("finds rows that moved and rows that arrived", () => {
    const r = flipDeltas(m({ a: [0, 0], b: [0, 40], c: [0, 80] }), m({ a: [0, 0], c: [0, 40], d: [0, 80] }));
    expect(r.moved).toEqual([{ id: "c", dx: 0, dy: 40 }]);
    expect(r.entered).toEqual(["d"]);
  });
  it("leaves still rows and huge jumps alone", () => {
    const r = flipDeltas(m({ a: [0, 0], b: [0, 0.4], c: [0, 0] }), m({ a: [0, 0], b: [0, 0], c: [0, 900] }));
    expect(r.moved).toEqual([]);
  });
});

describe("shouldGreet", () => {
  it("greets a few new rows in a list already showing", () => {
    expect(shouldGreet(5, 1)).toBe(true);
    expect(shouldGreet(5, 3)).toBe(true);
  });
  it("doesn't greet a whole new list", () => {
    expect(shouldGreet(0, 4)).toBe(false);
    expect(shouldGreet(5, 12)).toBe(false);
    expect(shouldGreet(5, 0)).toBe(false);
  });
});

describe("tickDirection", () => {
  it("rolls with the change, and not on first show", () => {
    expect(tickDirection(8, 7)).toBe("down");
    expect(tickDirection(0, 1)).toBe("up");
    expect(tickDirection(null, 2)).toBe("up");
    expect(tickDirection(3, 3)).toBeNull();
    expect(tickDirection(undefined, 3)).toBeNull();
  });
});

describe("tipPlace", () => {
  const view = { width: 800, height: 600 };
  it("centres under the element", () => {
    expect(tipPlace({ left: 100, top: 100, width: 40, height: 20 }, { width: 60, height: 24 }, view)).toEqual({ left: 90, top: 126, above: false });
  });
  it("stays inside the window and flips above near the bottom", () => {
    const r = tipPlace({ left: 780, top: 580, width: 20, height: 16 }, { width: 120, height: 24 }, view);
    expect(r.left).toBe(674);
    expect(r.above).toBe(true);
    expect(r.top).toBe(550);
  });
});
