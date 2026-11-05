import { describe, expect, it } from "vitest";
import { inkOn, parseColor } from "./blockColor";

describe("block colors", () => {
  it("reads hex and rgb colors", () => {
    expect(parseColor("#fff")).toEqual([255, 255, 255]);
    expect(parseColor("#D6247A")).toEqual([214, 36, 122]);
    expect(parseColor("#d6247aff")).toEqual([214, 36, 122]);
    expect(parseColor("rgb(10, 20, 30)")).toEqual([10, 20, 30]);
    expect(parseColor("var(--teal)")).toBeNull();
    expect(parseColor(null)).toBeNull();
  });
  it("puts white text on strong colors and dark text on light ones", () => {
    expect(inkOn("#d6247a")).toBe("#fff");
    expect(inkOn("#2f6fdf")).toBe("#fff");
    expect(inkOn("#7c5cff")).toBe("#fff");
    expect(inkOn("#3b82f6")).toBe("#fff");
    expect(inkOn("#16a34a")).toBe("#fff");
    expect(inkOn("#f5c518")).toBe("#1d1d1f");
    expect(inkOn("#9be7c4")).toBe("#1d1d1f");
    expect(inkOn("#ffffff")).toBe("#1d1d1f");
    // Unknown: white on the app's own accent.
    expect(inkOn(undefined)).toBe("#fff");
  });
});
