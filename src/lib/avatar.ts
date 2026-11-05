import { useEffect, useState, useSyncExternalStore } from "react";
import type { Style } from "../vendor/dicebear/core/Style";
import type { StyleDefinition } from "../vendor/dicebear/core/StyleDefinition";

/**
 * The mayor's avatar: a DiceBear "Notionists" portrait on the "Sunrise"
 * background (a peach-to-pink gradient), drawn on the Mac from a seed. The
 * seed is all that's saved; "Next" in Settings picks a new one.
 */
export const SUNRISE = {
  backgroundColor: ["ffd9b0", "ffa8bf"],
  backgroundColorFill: "linear",
  backgroundColorAngle: 135,
} as const;

/** The seed before anyone has picked one. */
export const DEFAULT_SEED = "todocity";

export const seedOr = (seed: string | null | undefined) => (seed && seed.trim() ? seed.trim() : DEFAULT_SEED);

/** A fresh random seed, for "Next". */
export function newSeed(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 10);
}

type Core = typeof import("../vendor/dicebear/core/lite");
let loading: Promise<{ core: Core; style: Style<StyleDefinition> }> | null = null;

/** The style (a large drawing set) loads once, on first use, off the first paint. */
export function loadAvatars() {
  loading ??= Promise.all([import("../vendor/dicebear/core/lite"), import("../vendor/dicebear/notionists.json")]).then(([core, def]) => ({
    core,
    style: new core.Style(def.default as unknown as StyleDefinition),
  }));
  return loading;
}

/** The SVG for a seed. */
export function avatarSvg(core: Core, style: Style<StyleDefinition>, seed: string): string {
  return new core.Avatar(style, { seed, ...SUNRISE, backgroundColor: [...SUNRISE.backgroundColor] }).toString();
}

const urls = new Map<string, string>();

/** A data URL for the seed's avatar; null while the style is loading. */
export function useAvatarUrl(seed: string): string | null {
  const [url, setUrl] = useState(() => urls.get(seed) ?? null);
  useEffect(() => {
    const known = urls.get(seed);
    if (known) {
      setUrl(known);
      return;
    }
    let live = true;
    loadAvatars()
      .then(({ core, style }) => {
        const u = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(avatarSvg(core, style, seed))}`;
        urls.set(seed, u);
        if (live) setUrl(u);
      })
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
    };
  }, [seed]);
  return url;
}

// The seed in effect for this window (set from Settings by applyLook).
let current = DEFAULT_SEED;
const listeners = new Set<() => void>();
export function setAvatarSeed(seed: string | null | undefined) {
  const next = seedOr(seed);
  if (next === current) return;
  current = next;
  for (const l of listeners) l();
}
export function useAvatarSeed(): string {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    () => current,
  );
}
