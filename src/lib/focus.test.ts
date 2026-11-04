import { describe, expect, it } from "vitest";
import { focusNow, leftLabel, localStamp, minutesLeft, parseFocusEntry, pickedTasks, wrapUpLine } from "./focus";
import type { Task } from "./types";

const task = (id: number, title: string, done = false) => ({ id, title, done }) as unknown as Task;

describe("parseFocusEntry", () => {
  it("reads focus blocks typed in Calendar", () => {
    expect(parseFocusEntry("Focus")).toEqual({ title: null, minutes: null });
    expect(parseFocusEntry("focus for 90 min")).toEqual({ title: null, minutes: 90 });
    expect(parseFocusEntry("Focus: draft the brief")).toEqual({ title: "draft the brief", minutes: null });
    expect(parseFocusEntry("Focus · write for 2h")).toEqual({ title: "write", minutes: 120 });
  });

  it("leaves ordinary tasks alone", () => {
    expect(parseFocusEntry("Focus on the brief")).toBeNull();
    expect(parseFocusEntry("Focused review with Sam")).toBeNull();
    expect(parseFocusEntry("Call Maya")).toBeNull();
  });
});

describe("times", () => {
  it("writes and counts local stamps", () => {
    const now = new Date(2026, 10, 4, 9, 26, 40);
    expect(localStamp(now)).toBe("2026-11-04T09:26:00");
    expect(minutesLeft("2026-11-04T10:00:00", now)).toBe(34);
    expect(minutesLeft("2026-11-04T09:00:00", now)).toBe(0);
    expect(focusNow(now, 50)).toEqual({ start: "2026-11-04T09:26:00", end: "2026-11-04T10:16:00" });
  });

  it("says how long is left", () => {
    expect(leftLabel(34)).toBe("34 min left");
    expect(leftLabel(60)).toBe("1 hr left");
    expect(leftLabel(95)).toBe("1 hr 35 min left");
  });
});

describe("wrap-up", () => {
  it("lists picked tasks in order and counts what got done", () => {
    const all = [task(1, "Draft"), task(2, "Reply", true), task(3, "Plan")];
    const picked = pickedTasks([3, 2, 9], all);
    expect(picked.map((t) => t.id)).toEqual([3, 2]);
    expect(wrapUpLine(picked)).toBe("Nice work — 1 of 2 done");
    expect(wrapUpLine([task(2, "Reply", true)])).toBe("Nice work — done");
    expect(wrapUpLine([])).toBe("Focus block finished");
  });
});
