import { describe, expect, it } from "vitest";
import { buildCards, notFound, startable } from "./agentCards";
import type { AgentApp, AgentCliStatus } from "./types";

const app = (id: string, name: string, installed: boolean, connected = false): AgentApp =>
  ({ id, name, installed, connected, stale: false, restart_hint: "" }) as AgentApp;
const cli = (id: string, name: string, installed: boolean, more: Partial<AgentCliStatus> = {}): AgentCliStatus => ({ id, name, installed, ...more });

const APPS = [
  app("claude_code", "Claude Code", true, true),
  app("codex", "Codex", false),
  app("claude_desktop", "Claude Desktop", true),
  app("cursor", "Cursor", true),
  app("vscode", "VS Code", false),
];
const CLIS = [
  cli("claude", "Claude Code", true, { slack: true }),
  // Found through nvm, so its app wasn't.
  cli("codex", "Codex", true),
  cli("cursor", "Cursor Agent", false),
  cli("gemini", "Gemini CLI", false),
  cli("custom:aider", "Aider", true, { custom: true, path: "/x/aider" }),
];

describe("agent cards", () => {
  it("joins an app and its command-line agent into one card", () => {
    const cards = buildCards(APPS, CLIS, null);
    const ids = cards.map((c) => c.id);
    expect(ids).toEqual(["claude", "codex", "claude_desktop", "cursor", "custom:aider"]);
    const claude = cards[0];
    expect(claude.cli?.id).toBe("claude");
    expect(claude.app?.id).toBe("claude_code");
    expect(claude.connected).toBe(true);
    expect(claude.slack).toBe(true);
    // Codex wasn't found as an app, but its command was: it's listed.
    expect(cards[1].cli?.id).toBe("codex");
    expect(cards.find((c) => c.id === "cursor")?.kind).toBe("app");
    expect(cards.find((c) => c.id === "custom:aider")?.kind).toBe("custom");
  });

  it("puts the default first, then connected agents", () => {
    const cards = buildCards(APPS, CLIS, "custom:aider");
    expect(cards[0].id).toBe("custom:aider");
    expect(cards[0].isDefault).toBe(true);
    expect(cards[1].id).toBe("claude");
  });

  it("offers only agents that start in the panel as the default", () => {
    const ids = startable(buildCards(APPS, CLIS, null)).map((c) => c.id);
    expect(ids).toEqual(["claude", "codex", "custom:aider"]);
  });

  it("names the known agents that weren't found", () => {
    expect(notFound(APPS, CLIS)).toEqual(["VS Code"]);
  });

  it("keeps an added agent whose program moved, so it can be removed", () => {
    const cards = buildCards([], [cli("custom:gone", "Gone", false, { custom: true })], null);
    expect(cards.map((c) => c.id)).toEqual(["custom:gone"]);
    expect(startable(cards)).toEqual([]);
  });
});
