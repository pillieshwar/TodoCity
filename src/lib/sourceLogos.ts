import { useEffect, useState } from "react";
import { agentIdOf } from "./agents";
import { api } from "./api";
import { DARK_TILE, OFFICIAL, needsDarkTile, iconFor, useAppIcons } from "./agentIcons";
import type { Task } from "./types";

/**
 * The logo for where a task came from. In order:
 *
 * 1. The site it was captured from (Gmail, GitHub, Reddit…), when it kept a
 *    web link: the site says more than the browser it was read in.
 * 2. The Mac app it came from, by bundle id (Slack, Outlook, Chrome…).
 * 3. The name it records, for synced and imported tasks with no bundle
 *    (Todoist, Things 3) and the Slack connection.
 * 4. The AI agent that added it ("Claude Code", "Cursor").
 * 5. The Mac app's own icon, read from the app (`source_icons`).
 *
 * Official files live in src/assets/logos (see its README).
 */
export type LogoKey =
  | { file: string; site?: boolean }
  | { agent: string }
  | { bundle: string };

/** Sites with a logo, by host (the host itself or any subdomain). */
const SITE_FILES: [string, string][] = [
  ["mail.google.com", "gmail"],
  ["calendar.google.com", "google_calendar"],
  ["gemini.google.com", "gemini"],
  ["github.com", "github"],
  ["reddit.com", "reddit"],
  ["substack.com", "substack"],
  ["linear.app", "linear"],
  ["notion.so", "notion"],
  ["notion.site", "notion"],
  ["slack.com", "slack"],
  ["outlook.office.com", "outlook"],
  ["outlook.office365.com", "outlook"],
  ["outlook.live.com", "outlook"],
  ["zoom.us", "zoom"],
  ["todoist.com", "todoist"],
  ["claude.ai", "claude"],
  ["chatgpt.com", "openai"],
  ["grok.com", "grok"],
  ["cursor.com", "cursor"],
  ["kiro.dev", "kiro"],
  ["obsidian.md", "obsidian"],
];

/** Mac apps with a logo, by bundle id. */
const BUNDLE_FILES: Record<string, string> = {
  "com.todoist.mac.Todoist": "todoist",
  "com.culturedcode.ThingsMac": "things",
  "com.culturedcode.ThingsMac3": "things",
  "com.anthropic.claudefordesktop": "claude",
  "com.google.Chrome": "chrome",
  "com.google.Chrome.beta": "chrome",
  "com.google.Chrome.canary": "chrome",
  "com.apple.Safari": "safari",
  "com.apple.SafariTechnologyPreview": "safari",
  "com.tinyspeck.slackmacgap": "slack",
  "com.microsoft.Outlook": "outlook",
  "us.zoom.xos": "zoom",
  "notion.id": "notion",
  "md.obsidian": "obsidian",
  "com.linear": "linear",
  "com.github.GitHubClient": "github",
  "com.openai.chat": "openai",
  "com.openai.codex": "openai",
  "com.todesktop.230313mzl4w4u92": "cursor",
};

/** …and by the name a task records. */
const NAME_FILES: [RegExp, string][] = [
  [/^todoist$/i, "todoist"],
  [/^things( 3)?$/i, "things"],
  [/^slack$/i, "slack"],
  [/^gmail$/i, "gmail"],
  [/^(microsoft )?outlook$/i, "outlook"],
  [/^google calendar$/i, "google_calendar"],
  [/^(google )?chrome$/i, "chrome"],
  [/^safari$/i, "safari"],
  [/^notion$/i, "notion"],
  [/^obsidian$/i, "obsidian"],
  [/^linear$/i, "linear"],
  [/^zoom( workplace)?$/i, "zoom"],
  [/^github( desktop)?$/i, "github"],
  [/^reddit$/i, "reddit"],
  [/^substack$/i, "substack"],
  [/\bkiro\b/i, "kiro"],
  [/\bgrok\b/i, "grok"],
];

/** Agents whose logo comes through `iconFor` rather than the tables above. */
const AGENT_FILES = ["claude", "openai", "gemini", "cursor", "antigravity"];

/** Every logo id something here can show (the logos folder's README lists them). */
export const KNOWN_LOGOS = new Set<string>([
  ...SITE_FILES.map(([, id]) => id),
  ...Object.values(BUNDLE_FILES),
  ...NAME_FILES.map(([, id]) => id),
  ...AGENT_FILES,
  // Meetings' accounts (`calendar::account_logo`).
  "google_calendar",
  "outlook",
]);

type Source = Pick<Task, "source_app" | "source_bundle"> & Partial<Pick<Task, "source_url">>;

/** The logo for a site, from a page's address. */
export function siteFile(url: string | null | undefined): string | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
  for (const [site, id] of SITE_FILES) if (host === site || host.endsWith(`.${site}`)) return id;
  return null;
}

export function logoKey(task: Source): LogoKey | null {
  const bundle = task.source_bundle ?? "";
  const app = (task.source_app ?? "").trim();
  const site = siteFile(task.source_url);
  if (site) return { file: site, site: true };
  if (bundle && BUNDLE_FILES[bundle]) return { file: BUNDLE_FILES[bundle] };
  for (const [re, id] of NAME_FILES) if (re.test(app)) return { file: id };
  const agent = app ? agentIdOf(app) : null;
  if (agent) return { agent };
  if (bundle) return { bundle };
  return null;
}

/** A logo ready to draw: its URL, and whether it goes on the dark tile. */
export interface Logo {
  src: string;
  dark: boolean;
  /** It stands for the site the task came from, so the site's name can go. */
  site: boolean;
}

/** The file for a logo id, as a Logo. */
export function fileLogo(id: string | null | undefined): Logo | null {
  const src = id ? OFFICIAL[id] : null;
  return src ? { src, dark: DARK_TILE.has(id!), site: false } : null;
}

// ── Mac app icons by bundle id, fetched in small batches and kept ───────────

const byBundle: Record<string, string | null> = {};
const asked = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function want(bundle: string) {
  if (bundle in byBundle || asked.has(bundle)) return;
  asked.add(bundle);
  if (timer === null) timer = setTimeout(flush, 40);
}

async function flush() {
  timer = null;
  const list = [...asked].filter((b) => !(b in byBundle));
  if (!list.length) return;
  const got = await api.sourceIcons(list).catch(() => ({}) as Record<string, string>);
  for (const b of list) byBundle[b] = got[b] ?? null;
  listeners.forEach((l) => l());
}

/** The logo for `key`, if there is one yet. */
export function logoFor(key: LogoKey | null, installed: Record<string, string>, bundles: Record<string, string | null>): Logo | null {
  if (!key) return null;
  if ("file" in key) {
    const l = fileLogo(key.file);
    return l ? { ...l, site: !!key.site } : null;
  }
  if ("agent" in key) {
    const src = iconFor(key.agent, installed);
    return src ? { src, dark: needsDarkTile(key.agent), site: false } : null;
  }
  const src = bundles[key.bundle];
  return src ? { src, dark: false, site: false } : null;
}

/** The logo for where `task` came from, or null (the chip keeps its glyph). */
export function useSourceLogo(task: Source): Logo | null {
  const installed = useAppIcons();
  const [, setTick] = useState(0);
  const key = logoKey(task);
  const bundle = key && "bundle" in key ? key.bundle : null;
  useEffect(() => {
    const l = () => setTick((n) => n + 1);
    listeners.add(l);
    if (bundle) want(bundle);
    return () => {
      listeners.delete(l);
    };
  }, [bundle]);
  return logoFor(key, installed, byBundle);
}
