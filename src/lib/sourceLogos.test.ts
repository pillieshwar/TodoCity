import { describe, expect, it } from "vitest";
import { logoKey, logoUrl } from "./sourceLogos";

const t = (source_app: string | null, source_bundle: string | null = null) => ({ source_app, source_bundle });

describe("logoKey", () => {
  it("uses the official logo for synced and imported apps", () => {
    expect(logoKey(t("Todoist"))).toEqual({ file: "todoist" });
    expect(logoKey(t("Things 3"))).toEqual({ file: "things" });
    expect(logoKey(t(null, "com.culturedcode.ThingsMac"))).toEqual({ file: "things" });
  });
  it("uses the agent's logo for tasks an AI agent added", () => {
    expect(logoKey(t("Claude Code"))).toEqual({ agent: "claude" });
    expect(logoKey(t("Cursor"))).toEqual({ agent: "cursor" });
  });
  it("uses the Mac app's icon for captured tasks", () => {
    expect(logoKey(t("Slack", "com.tinyspeck.slackmacgap"))).toEqual({ bundle: "com.tinyspeck.slackmacgap" });
    expect(logoKey(t("Google Chrome", "com.google.Chrome"))).toEqual({ bundle: "com.google.Chrome" });
  });
  it("has nothing for a task typed in TodoCity", () => {
    expect(logoKey(t(null))).toBeNull();
    expect(logoKey(t("Notes app nobody knows"))).toBeNull();
  });
});

describe("logoUrl", () => {
  it("finds the official files that ship with the app", () => {
    for (const id of ["todoist", "things", "claude"]) expect(logoUrl({ file: id }, {}, {})).toBeTruthy();
  });
  it("uses a bundle's icon once the Mac has sent it", () => {
    expect(logoUrl({ bundle: "com.google.Chrome" }, {}, {})).toBeNull();
    expect(logoUrl({ bundle: "com.google.Chrome" }, {}, { "com.google.Chrome": "data:image/png;base64,AA" })).toBe("data:image/png;base64,AA");
  });
});
