import type { AgentChange, Task } from "./types";

/** Whose tasks the lists show: yours, everyone's, or what agents did. */
export type Who = "you" | "all" | "agents";

/** Agent changes stay marked this long (matches `agent_log::KEEP_DAYS`). */
export const AGENT_DAYS = 7;

/** An agent added or changed it in the last 7 days, and you haven't changed it since. */
export function byAgent(t: Task, now: Date): boolean {
  if (!t.agent || !t.agent_at) return false;
  const at = Date.parse(t.agent_at);
  return Number.isFinite(at) && now.getTime() - at < AGENT_DAYS * 86_400_000;
}

/** The tasks a view shows for "You", "All" or "Agents". */
export function filterWho(tasks: Task[], who: Who, now: Date): Task[] {
  if (who === "all") return tasks;
  return tasks.filter((t) => byAgent(t, now) === (who === "agents"));
}

const VERBS: Record<string, string> = {
  added: "added",
  scheduled: "scheduled",
  moved: "moved",
  filed: "filed",
  completed: "completed",
  reopened: "reopened",
  changed: "changed",
  deleted: "deleted",
};

/** "Scheduled by Claude", "Added by Cursor". */
export function markLabel(c: Pick<AgentChange, "agent" | "kind">): string {
  const verb = VERBS[c.kind] ?? "changed";
  return `${verb[0].toUpperCase()}${verb.slice(1)} by ${c.agent}`;
}

/** The agent id behind a name an agent gave ("Claude Code" → "claude"), for its icon. */
export function agentIdOf(name: string): string | null {
  const n = name.toLowerCase();
  if (n.includes("codex") || n.includes("chatgpt") || n.includes("openai")) return "codex";
  if (n.includes("claude")) return "claude";
  if (n.includes("cursor")) return "cursor";
  if (n.includes("antigravity")) return "antigravity";
  if (n.includes("gemini")) return "gemini";
  return null;
}

/** Each task's latest change that isn't undone. */
export function latestByTask(changes: AgentChange[]): Map<number, AgentChange> {
  const out = new Map<number, AgentChange>();
  for (const c of changes) {
    if (c.undone) continue;
    const had = out.get(c.task_id);
    if (!had || c.id > had.id) out.set(c.task_id, c);
  }
  return out;
}

/** "Claude 5, Cursor 1", most first. */
export function agentCounts(ids: number[], latest: Map<number, AgentChange>): string {
  const counts = new Map<string, number>();
  for (const id of ids) {
    const c = latest.get(id);
    if (c) counts.set(c.agent, (counts.get(c.agent) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([a, n]) => `${a} ${n}`)
    .join(", ");
}

/** "by Claude" for one agent, else the counts ("Claude 5, Cursor 1"). */
export function agentsBy(counts: string): string {
  const parts = counts.split(", ").filter(Boolean);
  return parts.length === 1 ? `by ${parts[0].replace(/ \d+$/, "")}` : counts;
}

/** The latest agent call (batch) still standing, for the menu bar's note. */
export interface BatchNote {
  batch: string;
  agent: string;
  at: string;
  count: number;
  summary: string;
}

/** The newest batch from the last `hours`, if any, with a one-line summary. */
export function latestBatch(changes: AgentChange[], now: Date, hours = 24): BatchNote | null {
  const live = changes.filter((c) => !c.undone && now.getTime() - Date.parse(c.at) < hours * 3_600_000);
  if (!live.length) return null;
  const newest = live.reduce((a, b) => (b.id > a.id ? b : a));
  const mine = live.filter((c) => c.batch === newest.batch);
  const kinds = new Map<string, number>();
  for (const c of mine) kinds.set(c.kind, (kinds.get(c.kind) ?? 0) + 1);
  const words: Record<string, [string, string]> = {
    scheduled: ["timed", "timed"],
    moved: ["moved", "moved"],
    added: ["added", "added"],
    filed: ["filed", "filed"],
    completed: ["completed", "completed"],
    deleted: ["deleted", "deleted"],
  };
  const parts = [...kinds.entries()].map(([k, n]) => `${words[k]?.[0] ?? "changed"} ${n} ${n === 1 ? "task" : "tasks"}`);
  const summary = parts.length ? parts.join(", ").replace(/^./, (x) => x.toUpperCase()) + "." : "";
  return { batch: newest.batch, agent: newest.agent, at: newest.at, count: mine.length, summary };
}
