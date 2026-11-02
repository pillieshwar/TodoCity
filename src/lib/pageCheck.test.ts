import { describe, expect, it } from "vitest";
import { pageDrawn, RELOAD_WINDOW_MS, shouldAutoReload } from "./pageCheck";

describe("pageDrawn", () => {
  it("is false for an empty or missing root", () => {
    expect(pageDrawn(null)).toBe(false);
    expect(pageDrawn({ childElementCount: 0 })).toBe(false);
  });
  it("is true once something is drawn", () => {
    expect(pageDrawn({ childElementCount: 1 })).toBe(true);
  });
});

describe("shouldAutoReload", () => {
  it("reloads the first time", () => {
    expect(shouldAutoReload(null, 1_000_000)).toBe(true);
  });
  it("doesn't reload again straight away", () => {
    expect(shouldAutoReload(1_000_000, 1_000_000 + 5_000)).toBe(false);
  });
  it("reloads again after a while", () => {
    expect(shouldAutoReload(1_000_000, 1_000_000 + RELOAD_WINDOW_MS + 1)).toBe(true);
  });
  it("treats a garbled stamp as none", () => {
    expect(shouldAutoReload(Number.NaN, 5)).toBe(true);
  });
});
