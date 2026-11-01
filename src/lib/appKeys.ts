/**
 * Single keys for actions in task lists, changeable in the Keyboard shortcuts
 * sheet. Mirrors `todocity_core::app_keys` (same ids, defaults and rules);
 * settings keep only the keys the person changed.
 */

export type AppAction =
  | "complete"
  | "edit"
  | "date"
  | "today"
  | "tomorrow"
  | "next_week"
  | "source"
  | "snooze"
  | "notes"
  | "steps"
  | "project"
  | "add"
  | "today_inbox"
  | "view"
  | "next"
  | "previous";

/** In the order the sheet lists them, with the key that also always works. */
export const APP_ACTIONS: { id: AppAction; label: string; key: string; also?: string }[] = [
  { id: "complete", label: "Complete", key: "x", also: "Space" },
  { id: "edit", label: "Edit title", key: "e", also: "↵" },
  { id: "date", label: "Date, time and repeat", key: "d" },
  { id: "today", label: "Today", key: "t" },
  { id: "tomorrow", label: "Tomorrow", key: "m" },
  { id: "next_week", label: "Next week", key: "w" },
  { id: "source", label: "Open where it came from", key: "o" },
  { id: "snooze", label: "Snooze", key: "s" },
  { id: "notes", label: "Description", key: "n" },
  { id: "steps", label: "Sub-tasks (checklist)", key: "c" },
  { id: "project", label: "Move to a project", key: "p" },
  { id: "add", label: "Add a task", key: "a" },
  { id: "today_inbox", label: "Today ↔ Inbox", key: "f" },
  { id: "view", label: "Today as a list or in hours", key: "v" },
  { id: "next", label: "Next task", key: "j", also: "↓" },
  { id: "previous", label: "Previous task", key: "k", also: "↑" },
];

const RESERVED = ["?", "/", " "];

/** A key a person can pick: one letter, digit or simple punctuation mark. */
export function usableKey(k: string): boolean {
  return k.length === 1 && !RESERVED.includes(k) && /^[a-z0-9,.;'[\]\-=`\\]$/.test(k);
}

/** The key each action uses now. */
export function keyMap(changed: Record<string, string> | undefined): Record<AppAction, string> {
  const out = {} as Record<AppAction, string>;
  for (const a of APP_ACTIONS) out[a.id] = a.key;
  for (const a of APP_ACTIONS) {
    const k = changed?.[a.id]?.toLowerCase();
    if (k && usableKey(k)) out[a.id] = k;
  }
  return out;
}

/** Which action a pressed key runs, if any (`key` as `KeyboardEvent.key`). */
export function actionFor(key: string, map: Record<AppAction, string>): AppAction | null {
  const k = key.toLowerCase();
  for (const a of APP_ACTIONS) if (map[a.id] === k) return a.id;
  return null;
}

/**
 * Give `action` the key `key`. If another action has it, the two swap keys,
 * so every key still does one thing. Returns the changed keys to save, and
 * which action swapped (for "S is now Snooze's old key").
 */
export function assignKey(
  changed: Record<string, string> | undefined,
  action: AppAction,
  key: string,
): { changed: Record<string, string>; swapped: AppAction | null } {
  const k = key.toLowerCase();
  const map = keyMap(changed);
  const next: Record<AppAction, string> = { ...map };
  const other = APP_ACTIONS.find((a) => a.id !== action && map[a.id] === k)?.id ?? null;
  if (other) next[other] = map[action];
  next[action] = k;
  return { changed: onlyChanged(next), swapped: other };
}

/** Keys that differ from the defaults (what settings store). */
export function onlyChanged(map: Record<AppAction, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of APP_ACTIONS) if (map[a.id] !== a.key) out[a.id] = map[a.id];
  return out;
}

/** How a key looks on a keycap: letters in capitals. */
export function keyLabel(k: string): string {
  return k.length === 1 ? k.toUpperCase() : k;
}
