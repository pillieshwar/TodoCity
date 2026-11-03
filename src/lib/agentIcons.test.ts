import { describe, expect, it } from "vitest";
import { OFFICIAL, iconFor } from "./agentIcons";

describe("agent icons", () => {
  it("uses an installed app's icon when there's no official file", () => {
    const installed = { cursor: "data:image/png;base64,BBB", codex: "data:image/png;base64,CCC" };
    expect(iconFor("cursor", installed)).toBe("data:image/png;base64,BBB");
    expect(iconFor("codex", installed)).toBe("data:image/png;base64,CCC");
  });

  it("prefers the official file, shared across ids for one product", () => {
    const installed = { claude: "data:image/png;base64,AAA" };
    expect(OFFICIAL.claude).toBeTruthy();
    expect(iconFor("claude", installed)).toBe(OFFICIAL.claude);
    expect(iconFor("claude_code", installed)).toBe(OFFICIAL.claude);
    expect(iconFor("claude_desktop", installed)).toBe(OFFICIAL.claude);
  });

  it("falls back to a lettered tile when nothing is known", () => {
    expect(iconFor("gemini_cli", {})).toBeNull();
    expect(iconFor(null, { claude: "x" })).toBeNull();
  });
});
