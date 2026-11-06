import { describe, expect, it } from "vitest";
import { ago, connectSteps, everyText, filterChannels, readsAnything, slackLine, toggleChannel, until } from "./slack";
import type { SlackRoutine, SlackStatus } from "./types";

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

describe("Slack Secretary's routine", () => {
  const base: SlackRoutine = { dms: true, group_dms: true, mentions: false, channels: [], priority: true, rules: "" };
  const launch = { id: "C01", name: "launch" };

  it("reads channels only when they're ticked", () => {
    expect(base.channels).toEqual([]);
    const on = toggleChannel(base, launch);
    expect(on.channels).toEqual([launch]);
    expect(toggleChannel(on, launch).channels).toEqual([]);
  });

  it("needs something to read", () => {
    expect(readsAnything(base)).toBe(true);
    const none = { ...base, dms: false, group_dms: false };
    expect(readsAnything(none)).toBe(false);
    expect(readsAnything(toggleChannel(none, launch))).toBe(true);
  });

  it("finds channels by name", () => {
    const list = [launch, { id: "C02", name: "Design-Reviews" }];
    expect(filterChannels(list, "#des").map((c) => c.id)).toEqual(["C02"]);
    expect(filterChannels(list, "  ")).toHaveLength(2);
  });

  it("says the timer plainly", () => {
    expect(everyText(5)).toBe("every 5 minutes");
    expect(everyText(60)).toBe("every hour");
  });
});
