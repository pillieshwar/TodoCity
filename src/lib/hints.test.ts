import { beforeEach, describe, expect, it } from "vitest";
import { hasDragged, markDragged, showDragHint } from "./hints";

// Tests run in Node: a small stand-in for the browser's storage.
const store = new Map<string, string>();
Object.assign(globalThis, {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    clear: () => store.clear(),
  },
});

describe("drag hints", () => {
  beforeEach(() => store.clear());
  it("show until the first drag, then only while dragging", () => {
    expect(showDragHint(false)).toBe(true);
    markDragged();
    expect(hasDragged()).toBe(true);
    expect(showDragHint(false)).toBe(false);
    expect(showDragHint(true)).toBe(true);
  });
});
