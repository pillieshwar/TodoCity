/**
 * The menu-bar popover is asked to answer each time it opens (see
 * `src-tauri/src/popover.rs`): it's there, and whether it has anything
 * drawn. An empty page gets reloaded.
 */

/** Something is drawn in the page's root. */
export function pageDrawn(root: { childElementCount: number } | null): boolean {
  return !!root && root.childElementCount > 0;
}

/** sessionStorage key for the last automatic reload after an error. */
export const RELOADED_KEY = "todocity.reloadedAfterError";
/** At most one automatic reload in this long. */
export const RELOAD_WINDOW_MS = 60_000;

/** Reload by itself after an error, unless it just did. */
export function shouldAutoReload(lastReloadMs: number | null, nowMs: number): boolean {
  return lastReloadMs === null || !Number.isFinite(lastReloadMs) || nowMs - lastReloadMs > RELOAD_WINDOW_MS;
}
