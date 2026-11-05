import { describe, expect, it } from "vitest";
import { popPlace } from "./blockPop";

const view = { width: 1400, height: 900 };
const pop = { width: 380, height: 420 };

describe("popPlace", () => {
  it("opens to the right of the block, top-aligned", () => {
    expect(popPlace({ left: 300, top: 200, width: 150, height: 72 }, pop, view)).toEqual({ left: 458, top: 194, side: "right" });
  });
  it("opens to the left near the right edge", () => {
    expect(popPlace({ left: 1200, top: 200, width: 150, height: 72 }, pop, view)).toEqual({ left: 812, top: 194, side: "left" });
  });
  it("stays inside the window at the bottom", () => {
    expect(popPlace({ left: 300, top: 820, width: 150, height: 40 }, pop, view).top).toBe(900 - 10 - 420);
  });
  it("goes over the block when neither side has room", () => {
    const at = popPlace({ left: 100, top: 100, width: 500, height: 40 }, pop, { width: 700, height: 900 });
    expect(at.side).toBe("over");
    expect(at.left).toBe(100);
  });
  it("centers when the block isn't on screen", () => {
    expect(popPlace(null, pop, view)).toEqual({ left: 510, top: 160, side: "over" });
  });
});
