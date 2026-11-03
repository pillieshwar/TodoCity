import { useEffect, useState } from "react";
import { api } from "./api";

/** Official logo files dropped into src/assets/logos (see its README), by id. */
export const OFFICIAL: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob("../assets/logos/*.{svg,png}", { eager: true, query: "?url", import: "default" }) as Record<string, string>).map(
    ([path, url]) => [path.replace(/^.*\//, "").replace(/\.(svg|png)$/, ""), url],
  ),
);

/** Connector ids that share an agent's logo. */
const SAME_AS: Record<string, string> = {
  claude_code: "claude",
  claude_desktop: "claude",
  gemini_cli: "gemini",
  codex: "openai",
};

/** Logos drawn light for dark backgrounds: always shown on a small dark tile. */
export const DARK_TILE = new Set(["cursor", "grok", "openai"]);

/** The official file used for an agent or connector id, if there is one. */
export function officialIdFor(id: string | null): string | null {
  if (!id) return null;
  if (OFFICIAL[id]) return id;
  const base = SAME_AS[id] ?? id;
  return OFFICIAL[base] ? base : null;
}

/** The logo for an agent or connector id: an official file, else the installed app's icon. */
export function iconFor(id: string | null, installed: Record<string, string>): string | null {
  if (!id) return null;
  const official = officialIdFor(id);
  if (official) return OFFICIAL[official];
  const base = SAME_AS[id] ?? id;
  return installed[id] ?? installed[base] ?? null;
}

/** Whether an agent's logo needs the dark tile. */
export const needsDarkTile = (id: string | null) => DARK_TILE.has(officialIdFor(id) ?? "");

let cached: Record<string, string> | null = null;
let loading: Promise<Record<string, string>> | null = null;
const listeners = new Set<(icons: Record<string, string>) => void>();

function load(): Promise<Record<string, string>> {
  if (!loading) {
    loading = api
      .appIcons()
      .catch(() => ({}))
      .then((icons) => {
        cached = icons ?? {};
        listeners.forEach((l) => l(cached!));
        return cached;
      });
  }
  return loading;
}

/** Installed apps' icons (loaded once, shared by every tile). */
export function useAppIcons(): Record<string, string> {
  const [icons, setIcons] = useState<Record<string, string>>(() => cached ?? {});
  useEffect(() => {
    listeners.add(setIcons);
    void load();
    return () => {
      listeners.delete(setIcons);
    };
  }, []);
  return icons;
}
