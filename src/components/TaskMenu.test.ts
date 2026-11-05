import { describe, expect, it } from "vitest";
import { menuPlace } from "./TaskMenu";

describe("menuPlace", () => {
  it("opens at the pointer", () => {
    expect(menuPlace(100, 120, 180, 140, 1200, 800)).toEqual({ left: 100, top: 120 });
  });
  it("flips left and up near the window's edges", () => {
    expect(menuPlace(1150, 760, 180, 140, 1200, 800)).toEqual({ left: 970, top: 620 });
  });
  it("never leaves the window", () => {
    expect(menuPlace(50, 60, 180, 140, 200, 150)).toEqual({ left: 8, top: 8 });
  });
});
