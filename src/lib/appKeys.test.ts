import { describe, expect, it } from "vitest";
import { APP_ACTIONS, actionFor, assignKey, keyLabel, keyMap, usableKey } from "./appKeys";

describe("keys for actions in task lists", () => {
  it("starts on the usual keys", () => {
    const map = keyMap(undefined);
    expect(actionFor("t", map)).toBe("today");
    expect(actionFor("D", map)).toBe("date");
    expect(actionFor("q", map)).toBeNull();
  });
  it("defaults are distinct and usable", () => {
    const keys = APP_ACTIONS.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every(usableKey)).toBe(true);
  });
  it("uses changed keys and ignores ones that can't be used", () => {
    const map = keyMap({ today: "Y", date: "?", notes: "ab" });
    expect(actionFor("y", map)).toBe("today");
    expect(actionFor("t", map)).toBeNull();
    expect(map.date).toBe("d");
    expect(map.notes).toBe("n");
  });
  it("swaps when a key is already used", () => {
    const r = assignKey({}, "today", "d");
    expect(r.swapped).toBe("date");
    expect(r.changed).toEqual({ date: "t", today: "d" });
    const map = keyMap(r.changed);
    expect(actionFor("d", map)).toBe("today");
    expect(actionFor("t", map)).toBe("date");
  });
  it("stores only changes, so going back to the default clears it", () => {
    const r = assignKey({ today: "y" }, "today", "t");
    expect(r.changed).toEqual({});
    expect(r.swapped).toBeNull();
  });
  it("shows letters in capitals", () => {
    expect(keyLabel("t")).toBe("T");
    expect(keyLabel(",")).toBe(",");
  });
});
