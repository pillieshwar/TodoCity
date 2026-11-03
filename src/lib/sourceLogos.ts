import { useEffect, useState } from "react";
import { agentIdOf } from "./agents";
import { api } from "./api";
import { OFFICIAL, iconFor, useAppIcons } from "./agentIcons";
import type { Task } from "./types";

/**
 * The logo for where a task came from: an official file in
 * src/assets/logos (Todoist, Things, Claude…), an AI agent's logo, or the
 * Mac app's own icon, found by its bundle id.
 */
export type LogoKey = { file: string } | { agent: string } | { bundle: string };

/** Apps TodoCity keeps an official logo for, by bundle id. */
const BUNDLE_FILES: Record<string, string> = {
  "com.todoist.mac.Todoist": "todoist",
  "com.culturedcode.ThingsMac": "things",
  "com.culturedcode.ThingsMac3": "things",
  "com.anthropic.claudefordesktop": "claude",
};

/** …and by the name a task records (synced and imported tasks have no bundle). */
const NAME_FILES: [RegExp, string][] = [
  [/^todoist$/i, "todoist"],
  [/^things( 3)?$/i, "things"],
];

type Source = Pick<Task, "source_app" | "source_bundle">;

export function logoKey(task: Source): LogoKey | null {
  const bundle = task.source_bundle ?? "";
  const app = (task.source_app ?? "").trim();
  if (bundle && BUNDLE_FILES[bundle]) return { file: BUNDLE_FILES[bundle] };
  for (const [re, id] of NAME_FILES) if (re.test(app)) return { file: id };
  // Tasks an AI agent added record the agent's name ("Claude Code", "Cursor").
  const agent = app ? agentIdOf(app) : null;
  if (agent) return { agent };
  if (bundle) return { bundle };
  return null;
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

/** The logo's URL for `key`, if there is one yet. */
export function logoUrl(key: LogoKey | null, installed: Record<string, string>, bundles: Record<string, string | null>): string | null {
  if (!key) return null;
  if ("file" in key) return OFFICIAL[key.file] ?? null;
  if ("agent" in key) return iconFor(key.agent, installed);
  return bundles[key.bundle] ?? null;
}

/** The logo for where `task` came from, or null (the chip keeps its glyph). */
export function useSourceLogo(task: Source): string | null {
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
  return logoUrl(key, installed, byBundle);
}
