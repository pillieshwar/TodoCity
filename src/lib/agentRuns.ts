import type { DayGroup } from "./grouping";
import type { AgentRun, RunStatus, Task } from "./types";

/** How a run shows on its task: the words, and a tone for its colour. */
export function runText(run: Pick<AgentRun, "status" | "agent_name">): { label: string; tone: RunStatus } {
  const name = run.agent_name || "The agent";
  switch (run.status) {
    case "working":
      return { label: `${name} is working`, tone: "working" };
    case "needs_you":
      return { label: `${name} needs you`, tone: "needs_you" };
    case "ready":
      return { label: "Ready to review", tone: "ready" };
    default:
      return { label: `${name} paused`, tone: "paused" };
  }
}

/** Each task's run (the newest, if a task somehow has two). */
export function runsByTask(runs: AgentRun[]): Map<number, AgentRun> {
  const out = new Map<number, AgentRun>();
  for (const r of runs) {
    const had = out.get(r.task_id);
    if (!had || had.id < r.id) out.set(r.task_id, r);
  }
  return out;
}

/** "With agents": what needs you first, then what's ready, working, paused. */
const RUN_GROUPS: { status: RunStatus; label: string; tone: DayGroup["tone"] }[] = [
  { status: "needs_you", label: "Needs you", tone: "overdue" },
  { status: "ready", label: "Ready to review", tone: "today" },
  { status: "working", label: "Working", tone: "upcoming" },
  { status: "paused", label: "Paused", tone: "someday" },
];

/** Open tasks handed to agents, grouped by where each one is; newest news first. */
export function groupByRun(tasks: Task[], runs: Map<number, AgentRun>): DayGroup[] {
  const out: DayGroup[] = [];
  for (const g of RUN_GROUPS) {
    const these = tasks
      .filter((t) => !t.done && runs.get(t.id)?.status === g.status)
      .sort((a, b) => (runs.get(b.id)!.updated_at).localeCompare(runs.get(a.id)!.updated_at));
    if (these.length) out.push({ key: `run:${g.status}`, label: g.label, tone: g.tone, tasks: these });
  }
  return out;
}

/** How many delegated tasks wait for the person (they need you, or are ready to review). */
export function waitingCount(runs: AgentRun[]): number {
  return runs.filter((r) => r.status === "needs_you" || r.status === "ready").length;
}

/** A small lettered tile for an agent (never its logo). */
export function monogram(agent: string | null): { letters: string; color: string } {
  switch (agent) {
    case "claude":
      return { letters: "CC", color: "#A9512F" };
    case "codex":
      return { letters: "CX", color: "#262523" };
    case "gemini":
      return { letters: "G", color: "#2E5BBA" };
    case "cursor":
      return { letters: "CA", color: "#4B4F58" };
    case "antigravity":
      return { letters: "AG", color: "#1A73E8" };
    default: {
      // Agents the person added: the first letter or two of their id.
      if (agent?.startsWith("custom:")) {
        const words = agent.slice(7).split("-").filter(Boolean);
        const letters = (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "A").slice(0, 2)).toUpperCase();
        return { letters, color: "#5B4FB0" };
      }
      return { letters: "", color: "#3A3936" };
    }
  }
}

/** A folder with the home folder written as ~. */
export function shortFolder(path: string, home: string): string {
  if (!home) return path;
  const h = home.replace(/\/+$/, "");
  if (path === h) return "~";
  return path.startsWith(`${h}/`) ? `~${path.slice(h.length)}` : path;
}

/** Folders remembered per project, and the last one used. */
export interface FolderMemory {
  byProject: Record<string, string>;
  last?: string;
}

/** Where an agent works on a task: its project's folder, else the last one, else home. */
export function folderFor(mem: FolderMemory, project: string | null, home: string): string {
  return (project && mem.byProject[project]) || mem.last || home;
}

export function rememberFolder(mem: FolderMemory, project: string | null, folder: string): FolderMemory {
  const byProject = { ...mem.byProject };
  if (project) byProject[project] = folder;
  return { byProject, last: folder };
}

const FOLDERS_KEY = "todocity.agentFolders";
const AGENT_KEY = "todocity.agentLast";

export function loadFolders(): FolderMemory {
  try {
    const v = JSON.parse(localStorage.getItem(FOLDERS_KEY) ?? "null") as FolderMemory | null;
    if (v && typeof v === "object" && v.byProject && typeof v.byProject === "object") return v;
  } catch {
    /* nothing saved, or storage is off */
  }
  return { byProject: {} };
}

export function saveFolders(mem: FolderMemory) {
  try {
    localStorage.setItem(FOLDERS_KEY, JSON.stringify(mem));
  } catch {
    /* storage is off: it's only a convenience */
  }
}

export function lastAgent(): string | null {
  try {
    return localStorage.getItem(AGENT_KEY);
  } catch {
    return null;
  }
}

export function saveLastAgent(id: string) {
  try {
    localStorage.setItem(AGENT_KEY, id);
  } catch {
    /* only a convenience */
  }
}

/** The agent to offer first: the last one used if it's installed, else the first installed. */
/** The agent to preselect: the default agent if it's here, else the last one used, else the first. */
export function defaultAgent(installed: string[], last: string | null, preferred: string | null = null): string | null {
  if (preferred && installed.includes(preferred)) return preferred;
  if (last && installed.includes(last)) return last;
  return installed[0] ?? null;
}

/** What "Continue" adds when a paused run starts again. */
export function continueNote(run: Pick<AgentRun, "summary">): string {
  const said = run.summary?.trim();
  return said ? `Pick up where you left off. Last time you reported: ${said}` : "Pick up where you left off.";
}

/** Ready-made requests in the agent panel. They ask before changing anything. */
export const PANEL_PROMPTS: { label: string; text: string }[] = [
  {
    label: "Plan my day",
    text: "Use TodoCity to plan my day: fit today's tasks around my meetings, most urgent first. Show me the plan, and only change tasks after I say yes.",
  },
  {
    label: "Tidy my Inbox",
    text: "Use TodoCity to tidy my Inbox: suggest a project and section for each task as a short table, and only move them after I say yes.",
  },
  {
    label: "Weekly review",
    text: "Use TodoCity to do my weekly review: what I finished in the last 7 days, what slipped, and what you'd move or drop. Ask before changing anything.",
  },
];
