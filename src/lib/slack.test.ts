import { describe, expect, it } from "vitest";
import { ago, connectSteps, slackLine, until } from "./slack";
import type { SlackStatus } from "./types";

const NOW = new Date(2026, 10, 5, 10, 0, 0);

function status(over: Partial<SlackStatus>): SlackStatus {
  return {
    enabled: true,
    phase: "ready",
    reason: null,
    detail: null,
    agent: "claude",
    agent_name: "Claude Code",
    scanning: false,
    last_checked: null,
    next_check: null,
    covered_until: null,
    last_error: null,
    added: 0,
    activity: [],
    ...over,
  };
}

describe("Slack connector text", () => {
  it("says how long ago and how soon", () => {
    expect(ago("2026-11-05T09:59:40", NOW)).toBe("just now");
    expect(ago("2026-11-05T09:56:00", NOW)).toBe("4 min ago");
    expect(ago("2026-11-05T07:00:00", NOW)).toBe("3 h ago");
    expect(ago("2026-11-04T09:00:00", NOW)).toBe("yesterday");
    expect(ago(null, NOW)).toBeNull();
    expect(until("2026-11-05T10:03:00", NOW)).toBe("in 3 min");
    expect(until("2026-11-05T09:59:00", NOW)).toBe("in a moment");
  });

  it("describes each phase without alarm", () => {
    expect(slackLine(null, NOW)).toContain("Inbox");
    expect(slackLine(status({ enabled: false, phase: "off" }), NOW)).toContain("Inbox");
    expect(slackLine(status({ phase: "checking" }), NOW)).toBe("Claude Code is checking your Slack…");
    expect(slackLine(status({ phase: "needs_slack" }), NOW)).toBe("Connect Slack to Claude Code to finish.");
    expect(slackLine(status({ scanning: true }), NOW)).toContain("looking at Slack now");
    expect(slackLine(status({ last_checked: "2026-11-05T09:58:00" }), NOW)).toBe("Read by Claude Code · checked 2 min ago");
    const sec = { on: true, installed: true, last_checked: "2026-11-05T09:57:00", behind: null, last_error: null, found: 2 };
    expect(slackLine(status({ secretary: sec }), NOW)).toBe("Slack Secretary · checked 3 min ago");
    expect(slackLine(status({ secretary: { ...sec, behind: "9 h 20 min" } }), NOW)).toBe("Slack Secretary is catching up on 9 h 20 min…");
    expect(slackLine(status({ secretary: { ...sec, last_checked: null } }), NOW)).toBe("Slack Secretary checks every 5 minutes");
  });

  it("gives steps for the agent in use", () => {
    expect(connectSteps("claude", "no_slack").join(" ")).toContain("Claude Code");
    expect(connectSteps("codex", "no_slack").join(" ")).toContain("config.toml");
    const read = connectSteps("cursor", "cant_read");
    expect(read[0]).toContain("signed in to Slack");
    expect(read[read.length - 1]).toContain("Check again");
  });
});
