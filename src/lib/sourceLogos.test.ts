import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OFFICIAL } from "./agentIcons";
import { fileLogo, logoFor, logoKey, siteFile } from "./sourceLogos";

const t = (source_app: string | null, source_bundle: string | null = null, source_url: string | null = null) => ({
  source_app,
  source_bundle,
  source_url,
});

describe("logoKey", () => {
  it("uses the official logo for synced and imported apps", () => {
    expect(logoKey(t("Todoist"))).toEqual({ file: "todoist" });
    expect(logoKey(t("Things 3"))).toEqual({ file: "things" });
    expect(logoKey(t(null, "com.culturedcode.ThingsMac"))).toEqual({ file: "things" });
    expect(logoKey(t("Slack"))).toEqual({ file: "slack" });
  });
  it("uses the app's logo for captured tasks", () => {
    expect(logoKey(t("Slack", "com.tinyspeck.slackmacgap"))).toEqual({ file: "slack" });
    expect(logoKey(t("Microsoft Outlook", "com.microsoft.Outlook"))).toEqual({ file: "outlook" });
    expect(logoKey(t("Google Chrome", "com.google.Chrome"))).toEqual({ file: "chrome" });
    expect(logoKey(t("zoom.us", "us.zoom.xos"))).toEqual({ file: "zoom" });
  });
  it("prefers the site a page came from over the browser", () => {
    expect(logoKey(t("Google Chrome", "com.google.Chrome", "https://mail.google.com/mail/u/0/#inbox/abc"))).toEqual({ file: "gmail", site: true });
    expect(logoKey(t("Safari", "com.apple.Safari", "https://www.reddit.com/r/TodoCity"))).toEqual({ file: "reddit", site: true });
    expect(logoKey(t("Arc", "company.thebrowser.Browser", "https://sam.substack.com/p/notes"))).toEqual({ file: "substack", site: true });
    // A site without a logo keeps the browser's.
    expect(logoKey(t("Google Chrome", "com.google.Chrome", "https://example.com/a"))).toEqual({ file: "chrome" });
  });
  it("uses the agent's logo for tasks an AI agent added", () => {
    expect(logoKey(t("Claude Code"))).toEqual({ agent: "claude" });
    expect(logoKey(t("Codex"))).toEqual({ agent: "codex" });
    expect(logoKey(t("Kiro"))).toEqual({ file: "kiro" });
    expect(logoKey(t("Grok"))).toEqual({ file: "grok" });
  });
  it("falls back to the Mac app's own icon", () => {
    expect(logoKey(t("Notes", "com.apple.Notes"))).toEqual({ bundle: "com.apple.Notes" });
  });
  it("has nothing for a task typed in TodoCity", () => {
    expect(logoKey(t(null))).toBeNull();
    expect(logoKey(t("Some app nobody knows"))).toBeNull();
  });
});

describe("siteFile", () => {
  it("matches a host and its subdomains, never a look-alike", () => {
    expect(siteFile("https://github.com/pillieshwar/TodoCity")).toBe("github");
    expect(siteFile("https://gist.github.com/x")).toBe("github");
    expect(siteFile("https://notgithub.com/x")).toBeNull();
    expect(siteFile("https://github.com.evil.example/x")).toBeNull();
    expect(siteFile("file:///Users/sam/notes.md")).toBeNull();
    expect(siteFile("not a url")).toBeNull();
  });
});

describe("logos", () => {
  it("every logo the rules name ships in src/assets/logos", () => {
    const ids = ["todoist", "things", "claude", "chrome", "safari", "slack", "outlook", "zoom", "notion", "obsidian", "linear", "github", "openai", "cursor", "gmail", "google_calendar", "gemini", "reddit", "substack", "grok", "kiro", "antigravity"];
    for (const id of ids) expect(OFFICIAL[id], id).toBeTruthy();
  });
  it("every file in the folder is a logo TodoCity can show", () => {
    const files = readdirSync(new URL("../assets/logos", import.meta.url)).filter((f) => /\.(svg|png)$/.test(f));
    for (const f of files) expect(OFFICIAL[f.replace(/\.(svg|png)$/, "")], f).toBeTruthy();
  });
  it("light-only logos go on the dark tile", () => {
    expect(fileLogo("cursor")?.dark).toBe(true);
    expect(fileLogo("openai")?.dark).toBe(true);
    expect(fileLogo("slack")?.dark).toBe(false);
    expect(logoFor({ agent: "codex" }, {}, {})?.dark).toBe(true);
  });
  it("uses a bundle's icon once the Mac has sent it", () => {
    expect(logoFor({ bundle: "com.apple.Notes" }, {}, {})).toBeNull();
    expect(logoFor({ bundle: "com.apple.Notes" }, {}, { "com.apple.Notes": "data:image/png;base64,AA" })?.src).toBe("data:image/png;base64,AA");
  });
});
