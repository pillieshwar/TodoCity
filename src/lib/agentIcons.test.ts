import { describe, expect, it } from "vitest";
import { OFFICIAL, iconFor, needsDarkTile } from "./agentIcons";

describe("agent icons", () => {
  it("uses an installed app's icon when there's no official file", () => {
    const installed = { vscode: "data:image/png;base64,BBB", windsurf: "data:image/png;base64,CCC" };
    expect(iconFor("vscode", installed)).toBe("data:image/png;base64,BBB");
    expect(iconFor("windsurf", installed)).toBe("data:image/png;base64,CCC");
  });

  it("prefers the official file, shared across ids for one product", () => {
    const installed = { claude: "data:image/png;base64,AAA", codex: "data:image/png;base64,DDD" };
    expect(OFFICIAL.claude).toBeTruthy();
    expect(iconFor("claude", installed)).toBe(OFFICIAL.claude);
    expect(iconFor("claude_code", installed)).toBe(OFFICIAL.claude);
    expect(iconFor("claude_desktop", installed)).toBe(OFFICIAL.claude);
    expect(iconFor("codex", installed)).toBe(OFFICIAL.openai);
    expect(iconFor("gemini_cli", {})).toBe(OFFICIAL.gemini);
    expect(iconFor("cursor", {})).toBe(OFFICIAL.cursor);
  });

  it("puts light-only logos on the dark tile", () => {
    expect(needsDarkTile("codex")).toBe(true);
    expect(needsDarkTile("cursor")).toBe(true);
    expect(needsDarkTile("claude")).toBe(false);
  });

  it("falls back to a lettered tile when nothing is known", () => {
    expect(iconFor("lm_studio", {})).toBeNull();
    expect(iconFor(null, { claude: "x" })).toBeNull();
  });
});
