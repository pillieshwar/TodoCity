import type { SlackChannel, SlackRoutine, SlackStatus } from "./types";

/** Minutes between `a` and `b` (local `YYYY-MM-DDTHH:MM:SS`, or a Date). */
function minutesBetween(from: string | Date, to: Date): number {
  const t = typeof from === "string" ? new Date(from) : from;
  return Math.round((to.getTime() - t.getTime()) / 60_000);
}

/** "just now", "4 min ago", "2 h ago", "yesterday", "3 days ago". */
export function ago(at: string | null, now: Date): string | null {
  if (!at) return null;
  const m = minutesBetween(at, now);
  if (Number.isNaN(m)) return null;
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** "in 3 min", "in a moment". */
export function until(at: string | null, now: Date): string | null {
  if (!at) return null;
  const m = -minutesBetween(at, now);
  if (Number.isNaN(m)) return null;
  if (m <= 0) return "in a moment";
  if (m < 60) return `in ${m} min`;
  const h = Math.round(m / 60);
  return `in ${h} h`;
}

/** The one line under the Slack card's name. */
export function slackLine(s: SlackStatus | null, now: Date): string {
  if (!s || !s.enabled) return "Slack messages that need you, as tasks in your Inbox.";
  const who = s.agent_name ?? "your agent";
  switch (s.phase) {
    case "checking":
      return `${who} is checking your Slack…`;
    case "needs_slack":
      return `Connect Slack to ${who} to finish.`;
    case "stalled":
      return "Check again to finish setting up.";
    case "ready": {
      if (s.secretary?.on) {
        if (s.secretary.behind) return `Slack Secretary is catching up on ${s.secretary.behind}…`;
        const at = ago(s.secretary.last_checked, now);
        return at ? `Slack Secretary · checked ${at}` : "Slack Secretary checks every 5 minutes";
      }
      if (s.scanning) return `${who} is looking at Slack now…`;
      const last = ago(s.last_checked, now);
      return last ? `Read by ${who} · checked ${last}` : `Read by ${who}`;
    }
    default:
      return "Slack messages that need you, as tasks in your Inbox.";
  }
}

/** What to do when the agent can't read Slack yet, for that agent. */
export function connectSteps(agent: string | null, reason: SlackStatus["reason"]): string[] {
  const steps: string[] = [];
  if (reason === "cant_read") steps.push("Make sure the agent is signed in to Slack and can open your direct messages.");
  if (reason === "no_read_tools") steps.push("Give the agent a Slack server or connector that can read and search messages.");
  switch (agent) {
    case "claude":
      steps.push("Add Slack's MCP server to Claude Code, or connect Slack under Connectors on claude.ai with the account Claude Code uses.");
      break;
    case "codex":
      steps.push("Add a Slack MCP server to Codex in ~/.codex/config.toml, under [mcp_servers].");
      break;
    case "cursor":
      steps.push("Add a Slack MCP server in Cursor → Settings → MCP.");
      break;
    default:
      steps.push("Add a Slack MCP server to your agent.");
  }
  steps.push("Then choose Check again. TodoCity picks up from there.");
  return steps;
}

/** The first message for "Ask the agent to help connect Slack". */
export function helpConnectPrompt(): string {
  return "I want you to be able to read my Slack messages through an MCP server or connector, so TodoCity's Slack connector can use you. Check whether you already have Slack tools; if not, walk me through adding Slack (prefer Slack's official MCP server) step by step. Don't send anything in Slack.";
}

/** Whether a routine reads anything at all (it needs one source to run). */
export function readsAnything(r: SlackRoutine): boolean {
  return r.dms || r.group_dms || r.mentions || r.channels.length > 0;
}

/** The routine with `c` ticked or unticked. */
export function toggleChannel(r: SlackRoutine, c: SlackChannel): SlackRoutine {
  const has = r.channels.some((x) => x.id === c.id);
  return { ...r, channels: has ? r.channels.filter((x) => x.id !== c.id) : [...r.channels, c] };
}

/** Channels whose name has `q` in it (any case, with or without #). */
export function filterChannels(list: SlackChannel[], q: string): SlackChannel[] {
  const t = q.trim().replace(/^#/, "").toLowerCase();
  return t ? list.filter((c) => c.name.toLowerCase().includes(t)) : list;
}

/** "every 5 minutes", "every hour". */
export function everyText(min: number): string {
  return min === 60 ? "every hour" : `every ${min} minutes`;
}
