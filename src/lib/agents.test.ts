import { describe, expect, it } from "vitest";
import { agentCounts, agentsBy, byAgent, filterWho, latestBatch, latestByTask, markLabel, agentIdOf } from "./agents";
import type { AgentChange, Task } from "./types";

const NOW = new Date("2026-11-02T10:00:00Z");
const task = (id: number, agent: string | null, agentAt: string | null = "2026-11-02T08:00:00Z") =>
  ({ id, title: `T${id}`, agent, agent_at: agent ? agentAt : null }) as unknown as Task;
const change = (id: number, task_id: number, extra: Partial<AgentChange> = {}): AgentChange => ({
  id,
  at: "2026-11-02T09:58:00Z",
  agent: "Claude",
  batch: "b1",
  task_id,
  kind: "scheduled",
  title: `T${task_id}`,
  summary: "",
  undone: false,
  ...extra,
});

describe("who made a task", () => {
  it("marks agent tasks for 7 days", () => {
    expect(byAgent(task(1, "claude-ai"), NOW)).toBe(true);
    expect(byAgent(task(2, "claude-ai", "2026-10-20T00:00:00Z"), NOW)).toBe(false);
    expect(byAgent(task(3, null), NOW)).toBe(false);
  });
  it("filters You, All and Agents", () => {
    const ts = [task(1, "claude-ai"), task(2, null), task(3, "cursor")];
    expect(filterWho(ts, "all", NOW).map((t) => t.id)).toEqual([1, 2, 3]);
    expect(filterWho(ts, "agents", NOW).map((t) => t.id)).toEqual([1, 3]);
    expect(filterWho(ts, "you", NOW).map((t) => t.id)).toEqual([2]);
  });
});

describe("agent labels", () => {
  it("says who did what", () => {
    expect(markLabel({ agent: "Claude", kind: "scheduled" })).toBe("Scheduled by Claude");
    expect(markLabel({ agent: "Cursor", kind: "weird" })).toBe("Changed by Cursor");
  });
  it("finds the icon for an agent's name", () => {
    expect(agentIdOf("Claude Code")).toBe("claude");
    expect(agentIdOf("claude-desktop")).toBe("claude");
    expect(agentIdOf("Codex")).toBe("codex");
    expect(agentIdOf("Cursor")).toBe("cursor");
    expect(agentIdOf("My script")).toBeNull();
  });
  it("uses each task's latest change that still stands", () => {
    const m = latestByTask([change(1, 7), change(3, 7, { kind: "moved" }), change(4, 8, { undone: true })]);
    expect(m.get(7)?.kind).toBe("moved");
    expect(m.has(8)).toBe(false);
  });
  it("counts by agent", () => {
    const m = latestByTask([change(1, 1), change(2, 2), change(3, 3, { agent: "Cursor" })]);
    expect(agentCounts([1, 2, 3], m)).toBe("Claude 2, Cursor 1");
    expect(agentsBy("Claude 2, Cursor 1")).toBe("Claude 2, Cursor 1");
    expect(agentsBy("Claude 3")).toBe("by Claude");
  });
});

describe("the menu bar's note", () => {
  it("sums up the newest batch from the last day", () => {
    const n = latestBatch(
      [change(1, 1), change(2, 2), change(3, 3, { kind: "moved" }), change(0, 9, { batch: "old", at: "2026-10-30T00:00:00Z" })],
      NOW,
    );
    expect(n).toMatchObject({ batch: "b1", agent: "Claude", count: 3 });
    expect(n?.summary).toBe("Timed 2 tasks, moved 1 task.");
    expect(latestBatch([change(0, 9, { at: "2026-10-30T00:00:00Z" })], NOW)).toBeNull();
  });
});
