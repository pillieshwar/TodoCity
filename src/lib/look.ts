import { weekStartForLocale } from "./calendar";
import { setClock } from "./schedule";
import { setAvatarSeed } from "./avatar";
import type { AppSettings, LookSettings } from "./types";

/** How TodoCity looks before (or without) any choices: the Mac's own calendar and clock. */
export const DEFAULT_LOOK: LookSettings = {
  week_start: "auto",
  clock: "auto",
  start_list: "last",
  details: true,
  accent: "purple",
  city_sky: "auto",
  city_motion: true,
  compact: true,
  mayor_look: "man",
  avatar_seed: "",
  side_width: 0,
  side_open: true,
  show_done: false,
  list_views: {},
  show_source: "always",
};

export const lookOf = (s: AppSettings | null | undefined): LookSettings => ({ ...DEFAULT_LOOK, ...(s?.look ?? {}) });

/** First day of the week: the user's pick, or the region's. */
export function weekStartOf(look: LookSettings, locale: string): number {
  return look.week_start === "sun" ? 0 : look.week_start === "mon" ? 1 : look.week_start === "sat" ? 6 : weekStartForLocale(locale);
}

/**
 * Put the choices into effect for this window: the clock for every time
 * label, the accent color, and the city's sky and motion (read by the 3D
 * scene from the page).
 */
export function applyLook(look: LookSettings) {
  setClock(look.clock);
  const root = document.documentElement;
  root.dataset.accent = look.accent;
  root.dataset.citySky = look.city_sky;
  root.dataset.cityMotion = look.city_motion ? "on" : "off";
  root.dataset.mayorLook = look.mayor_look;
  setAvatarSeed(look.avatar_seed);
}
