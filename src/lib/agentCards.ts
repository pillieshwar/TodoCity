import type { AgentApp, AgentCliStatus } from "./types";

/**
 * The connector (Settings → Agents app) each command-line agent uses.
 * Mirrors `connector` in `todocity_core::agent_runs::CLIS`.
 */
export const CONNECTOR: Record<string, string> = {
  claude: "claude_code",
  codex: "codex",
  antigravity: "antigravity",
  gemini: "gemini_cli",
  cursor: "cursor",
};

/** One agent on the Agents page: an app, a command-line agent, or both. */
export interface AgentCard {
  /** The command-line id when it has one (it starts in the panel), else the app's. */
  id: string;
  name: string;
  /** Its MCP settings (Connect / Disconnect), if TodoCity edits them. */
  app: AgentApp | null;
  /** It starts in the agent panel. */
  cli: AgentCliStatus | null;
  kind: "cli" | "app" | "both" | "custom";
  connected: boolean;
  /** Connected to a TodoCity that has moved. */
  stale: boolean;
  slack: boolean;
  isDefault: boolean;
}

/** "Command line", "App", "App and command line", "Added by you". */
export function kindLabel(kind: AgentCard["kind"]): string {
  switch (kind) {
    case "cli":
      return "Command line";
    case "app":
      return "App";
    case "both":
      return "App and command line";
    case "custom":
      return "Added by you";
  }
}

/**
 * Every agent found on this Mac, as one card each: apps and the
 * command-line agents that go with them are one card. The default comes
 * first, then connected ones, then the rest as found.
 */
export function buildCards(apps: AgentApp[], clis: AgentCliStatus[], defaultId: string | null): AgentCard[] {
  const cards: AgentCard[] = [];
  const used = new Set<string>();
  for (const app of apps) {
    const cli = clis.find((c) => !c.custom && CONNECTOR[c.id] === app.id && c.installed) ?? null;
    if (!app.installed && !cli) continue;
    if (cli) used.add(cli.id);
    const id = cli?.id ?? app.id;
    cards.push({
      id,
      // Cursor the app and Cursor Agent share a card under the app's name.
      name: app.name,
      app,
      cli,
      kind: cli ? (app.id === "claude_code" || app.id === "codex" || app.id === "gemini_cli" || app.id === "antigravity" ? "cli" : "both") : "app",
      connected: app.connected && !app.stale,
      stale: app.stale,
      slack: !!cli?.slack,
      isDefault: !!cli && cli.id === defaultId,
    });
  }
  for (const c of clis) {
    if (used.has(c.id) || !c.installed) continue;
    if (!c.custom && CONNECTOR[c.id] && apps.some((a) => a.id === CONNECTOR[c.id])) continue;
    cards.push({
      id: c.id,
      name: c.name,
      app: null,
      cli: c,
      kind: c.custom ? "custom" : "cli",
      connected: false,
      stale: false,
      slack: !!c.slack,
      isDefault: c.id === defaultId,
    });
  }
  // Agents someone added stay listed even if their program moved, so they can be removed.
  for (const c of clis) {
    if (c.custom && !c.installed && !cards.some((k) => k.id === c.id)) {
      cards.push({ id: c.id, name: c.name, app: null, cli: c, kind: "custom", connected: false, stale: false, slack: false, isDefault: c.id === defaultId });
    }
  }
  const rank = (k: AgentCard) => (k.isDefault ? 0 : k.connected ? 1 : 2);
  return cards
    .map((k, i) => ({ k, i }))
    .sort((a, b) => rank(a.k) - rank(b.k) || a.i - b.i)
    .map(({ k }) => k);
}

/** Agents that can be the default: ones that start in the agent panel. */
export function startable(cards: AgentCard[]): AgentCard[] {
  return cards.filter((k) => k.cli && k.cli.installed);
}

/** Known agents not found on this Mac, by name. */
export function notFound(apps: AgentApp[], clis: AgentCliStatus[]): string[] {
  const names: string[] = [];
  for (const a of apps) {
    const cli = clis.find((c) => !c.custom && CONNECTOR[c.id] === a.id);
    if (!a.installed && !cli?.installed) names.push(a.name);
  }
  return names;
}
