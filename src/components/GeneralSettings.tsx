import { MayorAvatar, MayorFigure } from "./MayorAvatar";
import { newSeed, seedOr } from "../lib/avatar";
import { previewDone } from "../lib/doneSound";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { applyTheme } from "../lib/theme";
import type { AppSettings, Theme, BackupInfo, LookSettings, NotificationPermission, Status, UpdateStatus } from "../lib/types";
import { lookOf } from "../lib/look";
import { InfoTip } from "./InfoTip";

interface SettingsProps {
  settings: AppSettings | null;
  onSettings: (s: AppSettings) => void;
  onError: (message: string) => void;
}

function useSave({ settings, onSettings, onError }: SettingsProps) {
  return useCallback(
    async (change: (s: AppSettings) => AppSettings) => {
      if (!settings) return;
      try {
        onSettings(await api.setSettings(change(settings)));
      } catch (e) {
        onError(String(e));
      }
    },
    [settings, onSettings, onError],
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  info,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
  /** More about it, in an (i) tooltip beside the label. */
  info?: string;
  disabled?: boolean;
}) {
  return (
    <label className={disabled ? "toggle-row disabled" : "toggle-row"}>
      <span className="toggle-text">
        <span className="toggle-label">
          {label}
          {info && <InfoTip text={info} label={`About ${label}`} />}
        </span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="switch"
        aria-label={info ? label : undefined}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

export function updateText(u: UpdateStatus): string {
  switch (u.state) {
    case "checking":
      return "Checking for updates…";
    case "up_to_date":
      return "You have the latest version.";
    case "downloading":
      return `Downloading ${u.version}${u.percent !== null ? ` · ${u.percent}%` : "…"}`;
    case "ready":
      return `TodoCity ${u.version} is ready to install.`;
    case "failed":
      return "Can’t reach the update server right now. TodoCity checks again on its own.";
    default:
      return "";
  }
}

/** A choice from a short list, as one row of a card stack. */
function Choice<T extends string>({
  label,
  hint,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  hint?: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <label className={disabled ? "toggle-row disabled" : "toggle-row"}>
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
      <select className="email-select" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as T)}>
        {options.map(([v, t]) => (
          <option key={v} value={v}>
            {t}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A time of day, as one row of a card stack. */
function TimeRow({
  label,
  hint,
  value,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  disabled?: boolean;
  onChange: (v: string) => void;
}) {
  return (
    <label className={disabled ? "toggle-row disabled" : "toggle-row"}>
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
      <input type="time" className="time-input" value={value} disabled={disabled} onChange={(e) => e.target.value && onChange(e.target.value)} />
    </label>
  );
}

/** A plain row: a label and a button (or anything) on the right. */
export function ActionRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="toggle-row static">
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {hint && <span className="toggle-hint">{hint}</span>}
      </span>
      {children}
    </div>
  );
}

// ── General ────────────────────────────────────────────────────────────────

export function GeneralPage(props: SettingsProps & { status: Status | null; update: UpdateStatus }) {
  const { settings, status, update, onError } = props;
  const save = useSave(props);
  const [login, setLogin] = useState<boolean | null>(null);
  useEffect(() => {
    api
      .autostartEnabled()
      .then(setLogin)
      .catch(() => setLogin(null));
  }, []);
  async function setLoginItem(on: boolean) {
    try {
      setLogin(await api.setAutostart(on));
    } catch (e) {
      onError(String(e));
    }
  }
  const off = !settings;
  return (
    <>
      <section className="settings-section">
        <h2 className="settings-h">Opening</h2>
        <div className="card-stack">
          <Toggle label="Open at login" checked={!!login} disabled={login === null} onChange={(v) => void setLoginItem(v)} />
          <Toggle
            label="Show when my Mac wakes"
            hint="Once a day"
            checked={settings?.show_on_start ?? true}
            disabled={off}
            onChange={(v) => void save((s) => ({ ...s, show_on_start: v }))}
          />
          <Choice
            label="Open in"
            value={(settings?.open_full ?? true) ? "full" : "panel"}
            disabled={off}
            options={[
              ["full", "Full screen"],
              ["panel", "Side panel"],
            ]}
            onChange={(v) => void save((s) => ({ ...s, open_full: v === "full" }))}
          />
          <ActionRow label="Side panel position">
            <button type="button" className="ghost small" onClick={() => void api.snapPanelToEdge()}>
              Snap to right edge
            </button>
          </ActionRow>
        </div>
      </section>
      <section className="settings-section">
        <h2 className="settings-h">Tasks</h2>
        <div className="card-stack">
          <Choice
            label="Show where tasks came from"
            hint="Click “from Mail” or “from Slack” to open the email, message or page"
            value={lookOf(settings).show_source}
            disabled={off}
            options={[
              ["always", "Always"],
              ["hover", "On hover"],
              ["never", "Never"],
            ]}
            onChange={(v) => void save((s) => ({ ...s, look: { ...lookOf(s), show_source: v } }))}
          />
        </div>
      </section>
      <section className="settings-section">
        <h2 className="settings-h">Updates</h2>
        <div className="card-stack">
          <Toggle
            label="Update automatically"
            checked={settings?.auto_update ?? true}
            disabled={off}
            onChange={(v) => void save((s) => ({ ...s, auto_update: v }))}
          />
          <ActionRow label={`TodoCity ${status?.version ?? ""}`} hint={update.state !== "idle" ? updateText(update) : undefined}>
            {update.state === "ready" ? (
              <button type="button" className="primary small" onClick={() => void api.installUpdate().catch((e) => onError(String(e)))}>
                Restart to update
              </button>
            ) : (
              <button
                type="button"
                className="ghost small"
                disabled={update.state === "checking" || update.state === "downloading"}
                onClick={() => void api.checkForUpdates().catch((e) => onError(String(e)))}
              >
                Check now
              </button>
            )}
          </ActionRow>
        </div>
      </section>
    </>
  );
}

// ── Appearance ─────────────────────────────────────────────────────────────

const THEMES: { id: Theme; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "light", label: "Light" },
  { id: "system", label: "System" },
];

const ACCENTS: [LookSettings["accent"], string, string][] = [
  ["purple", "Purple", "#7d74f0"],
  ["blue", "Blue", "#4a86f0"],
  ["green", "Green", "#34b27a"],
  ["orange", "Orange", "#ef8a45"],
  ["pink", "Pink", "#e8679f"],
];

export function AppearancePage(props: SettingsProps) {
  const save = useSave(props);
  const look = lookOf(props.settings);
  const set = (patch: Partial<LookSettings>) => void save((s) => ({ ...s, look: { ...lookOf(s), ...patch } }));
  const current = props.settings?.theme ?? "dark";
  const off = !props.settings;
  function choose(theme: Theme) {
    applyTheme(theme); // right away; the other windows follow on save
    void save((s) => ({ ...s, theme }));
  }
  return (
    <>
      <section className="settings-section">
        <h2 className="settings-h">Theme</h2>
        <div className="theme-picker" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={current === t.id}
              className={current === t.id ? "theme-option on" : "theme-option"}
              disabled={off}
              onClick={() => choose(t.id)}
            >
              <span className={`theme-swatch ${t.id}`} aria-hidden>
                <span className="theme-swatch-bar" />
                <span className="theme-swatch-line" />
                <span className="theme-swatch-line short" />
              </span>
              <span className="theme-label">{t.label}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <h2 className="settings-h">Accent</h2>
        <div className="accent-picker" role="radiogroup" aria-label="Accent color">
          {ACCENTS.map(([id, name, color]) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={look.accent === id}
              aria-label={name}
              title={name}
              className={look.accent === id ? "accent-dot on" : "accent-dot"}
              style={{ background: color }}
              disabled={off}
              onClick={() => set({ accent: id })}
            />
          ))}
          <span className="accent-name">{ACCENTS.find((a) => a[0] === look.accent)?.[1]}</span>
        </div>
      </section>
      <section className="settings-section">
        <h2 className="settings-h">Lists</h2>
        <div className="card-stack">
          <Choice
            label="Open to"
            value={look.start_list}
            disabled={off}
            options={[
              ["last", "Where I left off"],
              ["today", "Today"],
              ["upcoming", "Calendar"],
              ["inbox", "Inbox"],
            ]}
            onChange={(v) => set({ start_list: v })}
          />
          <Toggle
            label="Show completed tasks"
            hint="Off: they move to Completed, with a “Show” link under each list."
            checked={look.show_done}
            disabled={off}
            onChange={(v) => set({ show_done: v })}
          />
          <Choice
            label="Week starts on"
            value={look.week_start}
            disabled={off}
            options={[
              ["auto", "Automatic"],
              ["sun", "Sunday"],
              ["mon", "Monday"],
              ["sat", "Saturday"],
            ]}
            onChange={(v) => set({ week_start: v })}
          />
          <Choice
            label="Clock"
            value={look.clock}
            disabled={off}
            options={[
              ["auto", "Automatic"],
              ["12", "12-hour"],
              ["24", "24-hour"],
            ]}
            onChange={(v) => set({ clock: v })}
          />
          <Toggle label="Show notes under tasks" hint="Full screen" checked={look.details} disabled={off} onChange={(v) => set({ details: v })} />
          <Toggle label="Compact rows" hint="Full screen" checked={look.compact} disabled={off} onChange={(v) => set({ compact: v })} />
        </div>
      </section>
    </>
  );
}

// ── Notifications ──────────────────────────────────────────────────────────

export function NotificationsPage(props: SettingsProps) {
  const { settings } = props;
  const save = useSave(props);
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  useEffect(() => {
    api
      .notificationPermission()
      .then(setPermission)
      .catch(() => setPermission(null));
  }, []);
  async function enable(on: boolean) {
    await save((s) => ({ ...s, notify: { ...s.notify, enabled: on } }));
    if (on && permission === "not_determined") {
      setPermission(await api.requestNotificationPermission().catch(() => null));
    }
  }
  const n = settings?.notify;
  return (
    <>
      {permission === "denied" && (
        <div className="rem-note error">
          <p>Notifications are off for TodoCity in System Settings.</p>
          <button type="button" className="ghost" onClick={() => void api.openNotificationSettings().catch(() => undefined)}>
            Open System Settings
          </button>
        </div>
      )}
      <section className="settings-section">
        <h2 className="settings-h">Reminders</h2>
        <div className="card-stack">
          <Toggle label="Remind me when tasks are due" checked={n?.enabled ?? true} disabled={!n} onChange={(v) => void enable(v)} />
          <TimeRow
            label="Tasks without a time"
            hint="Remind on the day at"
            value={n?.all_day_time ?? "09:00"}
            disabled={!n?.enabled}
            onChange={(t) => void save((s) => ({ ...s, notify: { ...s.notify, all_day_time: t } }))}
          />
          <Toggle
            label="One morning summary instead"
            hint="Timed tasks still remind on time"
            checked={n?.daily_summary ?? false}
            disabled={!n?.enabled}
            onChange={(v) => void save((s) => ({ ...s, notify: { ...s.notify, daily_summary: v } }))}
          />
          <ActionRow label="Test">
            {permission === "not_determined" ? (
              <button
                type="button"
                className="ghost small"
                onClick={() => void api.requestNotificationPermission().then(setPermission).catch(() => undefined)}
              >
                Allow notifications…
              </button>
            ) : (
              <button type="button" className="ghost small" onClick={() => void api.testNotification().catch(() => undefined)}>
                Send a test
              </button>
            )}
          </ActionRow>
        </div>
      </section>
      <section className="settings-section">
        <h2 className="settings-h">Sound</h2>
        <div className="card-stack">
          <Toggle
            label="Play a sound when a task is done"
            hint="A light switch and a warm chime, as a window lights up"
            checked={settings?.done_sound ?? true}
            disabled={!settings}
            onChange={(v) => void save((s) => ({ ...s, done_sound: v }))}
          />
          <ActionRow label="Hear it">
            <button type="button" className="ghost small" onClick={() => previewDone()}>
              Play
            </button>
          </ActionRow>
        </div>
      </section>
      <section className="settings-section">
        <h2 className="settings-h">Menu bar</h2>
        <div className="card-stack">
          <Toggle
            label="Open on a task when it's due"
            checked={settings?.due_spotlight ?? true}
            disabled={!settings}
            onChange={(v) => void save((s) => ({ ...s, due_spotlight: v }))}
          />
          <Toggle
            label="Daily check-in for undated tasks"
            checked={settings?.undated_nudge ?? true}
            disabled={!settings}
            onChange={(v) => void save((s) => ({ ...s, undated_nudge: v }))}
          />
          <TimeRow
            label="Check-in time"
            value={settings?.undated_time ?? "16:00"}
            disabled={!settings?.undated_nudge}
            onChange={(t) => void save((s) => ({ ...s, undated_time: t }))}
          />
        </div>
      </section>
    </>
  );
}

// ── Capture & shortcuts ────────────────────────────────────────────────────

export function CapturePage(props: SettingsProps & { shortcuts: ReactNode }) {
  const { settings } = props;
  const save = useSave(props);
  const off = !settings;
  return (
    <>
      <section className="settings-section">
        <h2 className="settings-h">Capture</h2>
        <div className="card-stack">
          <Toggle
            label="Press ⌘C twice to capture"
            checked={settings?.double_copy ?? true}
            disabled={off}
            onChange={(v) => void save((s) => ({ ...s, double_copy: v }))}
          />
          <Toggle
            label="Review captures in the menu bar"
            hint="Off: in the side panel"
            checked={settings?.capture_in_menu_bar ?? true}
            disabled={off}
            onChange={(v) => void save((s) => ({ ...s, capture_in_menu_bar: v }))}
          />
          <Toggle
            label="Remember where tasks came from"
            hint="The app and link"
            checked={settings?.remember_source ?? true}
            disabled={off}
            onChange={(v) => void save((s) => ({ ...s, remember_source: v }))}
          />
        </div>
      </section>
      <section className="settings-section">
        <h2 className="settings-h">Keyboard shortcuts</h2>
        {props.shortcuts}
      </section>
    </>
  );
}

// ── Your city ──────────────────────────────────────────────────────────────

export function CityPage(props: SettingsProps) {
  const { settings } = props;
  const save = useSave(props);
  const look = lookOf(settings);
  const set = (patch: Partial<LookSettings>) => void save((s) => ({ ...s, look: { ...lookOf(s), ...patch } }));
  const off = !settings;
  const [city, setCity] = useState(settings?.city_name ?? "");
  const [mayor, setMayor] = useState(settings?.mayor_name ?? "");
  useEffect(() => setCity(settings?.city_name ?? ""), [settings?.city_name]);
  useEffect(() => setMayor(settings?.mayor_name ?? ""), [settings?.mayor_name]);
  // The avatar: Next draws a new one (saved at once); Back returns to the one before.
  const [seed, setSeed] = useState(() => seedOr(look.avatar_seed));
  const [before, setBefore] = useState<string[]>([]);
  useEffect(() => setSeed(seedOr(look.avatar_seed)), [look.avatar_seed]);
  const pick = (next: string) => {
    setSeed(next);
    set({ avatar_seed: next });
  };
  return (
    <section className="settings-section">
      <div className="card-stack">
        <Toggle
          label="Show my city in the footer"
          checked={settings?.city_corner ?? true}
          disabled={off}
          onChange={(v) => void save((s) => ({ ...s, city_corner: v }))}
        />
        <ActionRow label="City name">
          <input
            className="settings-text"
            value={city}
            maxLength={40}
            placeholder="Name your city"
            aria-label="City name"
            disabled={off}
            onChange={(e) => setCity(e.target.value)}
            onBlur={() => city.trim() !== (settings?.city_name ?? "") && void save((s) => ({ ...s, city_name: city.trim() || null }))}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </ActionRow>
        <ActionRow label="Mayor">
          <input
            className="settings-text"
            value={mayor}
            maxLength={40}
            placeholder="Your name"
            aria-label="Mayor's name"
            disabled={off}
            onChange={(e) => setMayor(e.target.value)}
            onBlur={() => mayor.trim() !== (settings?.mayor_name ?? "") && void save((s) => ({ ...s, mayor_name: mayor.trim() || null }))}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </ActionRow>
        <div className="toggle-row static avatar-row">
          <span className="toggle-text">
            <span className="toggle-label">Your avatar</span>
            <span className="toggle-hint">Shown in the sidebar and your city. Press Next until you find one you like.</span>
          </span>
          <div className="avatar-pick">
            <MayorAvatar seed={seed} fallback={(mayor.trim()[0] ?? "M").toUpperCase()} size={64} />
            <div className="avatar-pick-buttons">
              <button
                type="button"
                className="ghost"
                disabled={off || !before.length}
                onClick={() => {
                  const prev = before[before.length - 1];
                  setBefore((b) => b.slice(0, -1));
                  if (prev) pick(prev);
                }}
              >
                Back
              </button>
              <button
                type="button"
                className="primary"
                disabled={off}
                onClick={() => {
                  setBefore((b) => [...b.slice(-19), seed]);
                  pick(newSeed());
                }}
              >
                Next
              </button>
            </div>
          </div>
        </div>
        <div className="toggle-row static mayor-pick-row">
          <span className="toggle-text">
            <span className="toggle-label">Mayor’s figure in the city</span>
          </span>
          <div className="mayor-pick" role="radiogroup" aria-label="Mayor’s figure">
            {(["man", "woman"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={look.mayor_look === m}
                className={look.mayor_look === m ? "mayor-pick-opt on" : "mayor-pick-opt"}
                disabled={off}
                onClick={() => set({ mayor_look: m })}
              >
                <MayorFigure look={m} fallback={m === "man" ? "M" : "W"} size={56} />
                <span>{m === "man" ? "Man" : "Woman"}</span>
              </button>
            ))}
          </div>
        </div>
        <Choice
          label="Sky"
          value={look.city_sky}
          disabled={off}
          options={[
            ["auto", "Follow theme"],
            ["night", "Night"],
            ["dusk", "Dusk"],
          ]}
          onChange={(v) => set({ city_sky: v })}
        />
        <Toggle label="Moving cars and blinking windows" checked={look.city_motion} disabled={off} onChange={(v) => set({ city_motion: v })} />
      </div>
    </section>
  );
}

// ── Help ───────────────────────────────────────────────────────────────────

export function HelpPage({ onTour, onKeys }: { onTour: () => void; onKeys: () => void }) {
  return (
    <section className="settings-section">
      <div className="card-stack">
        <ActionRow label="The tour">
          <button type="button" className="ghost small" onClick={onTour}>
            Take it again
          </button>
        </ActionRow>
        <ActionRow label="Keyboard shortcuts">
          <button type="button" className="ghost small" onClick={onKeys}>
            Show
          </button>
        </ActionRow>
        <ActionRow label="Log file" hint="Stays on this Mac">
          <button type="button" className="ghost small" onClick={() => void api.revealLogs().catch(() => undefined)}>
            Show
          </button>
        </ActionRow>
        <ActionRow label="Send feedback or ideas">
          <button type="button" className="ghost small" onClick={() => void api.openUrl("https://github.com/pillieshwar/TodoCity/issues").catch(() => undefined)}>
            Open GitHub
          </button>
        </ActionRow>
      </div>
    </section>
  );
}

export function DataSection({ onError }: { onError: (message: string) => void }) {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .listBackups()
      .then(setBackups)
      .catch(() => setBackups([]));
  }, []);
  useEffect(load, [load]);

  async function run(f: () => Promise<unknown>, done?: string) {
    try {
      await f();
      if (done) setNote(done);
      load();
    } catch (e) {
      onError(String(e));
    }
  }

  return (
    <section className="settings-section">
      <p className="settings-intro">A backup is kept for each of the last 7 days.</p>
      <div className="row-actions">
        <button type="button" className="ghost" onClick={() => void run(() => api.exportTasks("csv"), "Saved a CSV to Downloads.")}>
          Export CSV
        </button>
        <button type="button" className="ghost" onClick={() => void run(() => api.exportTasks("json"), "Saved JSON to Downloads.")}>
          Export JSON
        </button>
        <button type="button" className="ghost" onClick={() => void run(api.backupNow, "Backup saved.")}>
          Back up now
        </button>
      </div>
      {note && <p className="settings-note">{note}</p>}
      {backups.length > 0 && (
        <ul className="backup-list">
          {backups.map((b) => (
            <li key={b.name}>
              <span className="backup-name">
                {new Date(`${b.day}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                {b.name.includes("before-restore") && <span className="backup-tag">before restore</span>}
                {b.name.includes("before-import") && <span className="backup-tag">before import</span>}
                {b.name.includes("manual") && <span className="backup-tag">manual</span>}
              </span>
              <span className="backup-size">{Math.max(1, Math.round(b.size / 1024))} KB</span>
              {confirm === b.name ? (
                <span className="backup-confirm">
                  Replace your tasks?
                  <button
                    type="button"
                    className="danger small"
                    onClick={() => {
                      setConfirm(null);
                      void run(() => api.restoreBackup(b.name), "Restored. Your previous tasks were backed up first.");
                    }}
                  >
                    Restore
                  </button>
                  <button type="button" className="link-btn" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <button type="button" className="link-btn" onClick={() => setConfirm(b.name)}>
                  Restore…
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <span className="bk-links">
        <button type="button" className="link-btn" onClick={() => void api.revealBackups().catch(() => undefined)}>
          Show backups folder
        </button>
        <button
          type="button"
          className="link-btn"
          title="Where TodoCity keeps everything on this Mac: your tasks, backups, AI models and settings"
          onClick={() => void api.revealDataFolder().catch(() => undefined)}
        >
          Show data folder
        </button>
      </span>
    </section>
  );
}
