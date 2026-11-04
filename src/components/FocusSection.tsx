import { useEffect, useState } from "react";
import { api, onFocusChanged } from "../lib/api";
import type { CalendarInfo, FocusStatus } from "../lib/types";
import { Toggle } from "./GeneralSettings";
import { InfoTip } from "./InfoTip";

/** How to make the shortcut in the Shortcuts app, step by step. */
function ShortcutSteps({ name }: { name: string }) {
  return (
    <ol className="focus-steps">
      <li>
        In Shortcuts, make a new shortcut called <strong>{name}</strong>.
      </li>
      <li>
        Add <strong>Get Text from Input</strong> (Shortcut Input).
      </li>
      <li>
        Add <strong>If</strong> Text <em>is</em> <code>off</code> → <strong>Set Focus</strong>: turn your Focus <em>Off</em>.
      </li>
      <li>
        In <strong>Otherwise</strong>: <strong>Get Dates from Input</strong> (Text), then <strong>Set Focus</strong>: turn your Focus <em>On</em>,
        Until <em>Time</em> → Dates.
      </li>
    </ol>
  );
}

/**
 * Settings → Focus Blocks: events on a Focus calendar turn the Mac's Focus
 * on when they start, and macOS turns it off when they end.
 */
export function FocusSection() {
  const [status, setStatus] = useState<FocusStatus | null>(null);
  const [calendars, setCalendars] = useState<CalendarInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const [name, setName] = useState("");

  const refresh = () => {
    api
      .focusStatus()
      .then((s) => {
        setStatus(s);
        setName((n) => n || s.shortcut);
      })
      .catch(() => undefined);
  };
  useEffect(() => {
    refresh();
    const sub = onFocusChanged(refresh);
    return () => void sub.then((u) => u());
  }, []);
  useEffect(() => {
    if (status?.calendar_access !== "full") return;
    api
      .calendarCalendars()
      .then(setCalendars)
      .catch(() => setCalendars([]));
  }, [status?.calendar_access, status?.calendar]);

  if (!status) return null;
  if (!status.supported) {
    return (
      <section className="settings-section">
        <p className="settings-lead">Focus Blocks work on macOS.</p>
      </section>
    );
  }

  async function run(f: () => Promise<FocusStatus | void>) {
    setError(null);
    setBusy(true);
    try {
      const s = await f();
      if (s) setStatus(s);
      else refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const ready = !!status.calendar && status.calendar_access === "full" && status.shortcut_ready;
  const dot = (ok: boolean) => <span className={ok ? "dot ok" : "dot warn"} aria-hidden />;

  return (
    <section className="settings-section focus-settings">
      <p className="settings-lead">
        Put a focus block on your calendar and your Mac's Focus turns on when it starts and off when it ends — in TodoCity's Calendar or in Apple Calendar.
        While it runs, TodoCity shows only the tasks you picked for it.
      </p>
      <div className="card-stack">
        <Toggle
          label="Turn Focus on for focus blocks"
          hint={ready ? "Blocks on your Focus calendar start Focus on time, even after your Mac wakes." : "Finish the steps below, then switch this on."}
          checked={status.enabled}
          disabled={busy || (!status.enabled && !ready)}
          onChange={(v) => void run(() => api.focusSet({ enabled: v }))}
        />
      </div>

      <h4 className="connector-subhead">Set up</h4>
      <div className="card-stack">
        <div className="setting-line">
          {dot(status.calendar_access === "full" && !!status.calendar)}
          <span className="setting-line-text">
            <strong>Focus calendar</strong>
            {status.calendar_access !== "full" ? " · Allow TodoCity to use Calendar first." : status.calendar ? ` · ${status.calendar}` : " · Make one, or pick a calendar below."}
          </span>
          {!status.calendar && (
            <button type="button" className="ghost small" disabled={busy} onClick={() => void run(api.focusMakeCalendar)}>
              Make a Focus calendar
            </button>
          )}
        </div>
        {status.calendar_access === "full" && calendars.length > 0 && (
          <label className="toggle-row">
            <span className="toggle-text">
              <span className="toggle-label">
                Calendar for focus blocks
                <InfoTip text="Every timed event on this calendar is a focus block. Pick one that holds only focus time — On My Mac keeps it on this Mac; an account calendar also shows you as busy to teammates." />
              </span>
            </span>
            <select
              className="email-select"
              value={status.calendar ?? ""}
              onChange={(e) => void run(() => api.focusSet({ calendar: e.target.value }))}
              aria-label="Calendar for focus blocks"
            >
              {!status.calendar && <option value="">Choose…</option>}
              {status.calendar && !calendars.some((c) => c.key === status.calendar) && <option value={status.calendar}>{status.calendar}</option>}
              {calendars.map((c) => (
                <option key={c.key} value={c.key}>
                  {c.key}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="setting-line">
          {dot(status.shortcut_ready)}
          <span className="setting-line-text">
            <strong>Shortcut</strong>
            {status.shortcut_ready ? ` · “${status.shortcut}” is ready` : ` · Add “${status.shortcut}” to Shortcuts`}
            <InfoTip wide label="How to make the shortcut" text={<ShortcutSteps name={status.shortcut} />} />
          </span>
          <button type="button" className="ghost small" disabled={busy} onClick={() => void run(api.focusOpenShortcuts)}>
            {status.shortcut_link ? "Add shortcut" : "Open Shortcuts"}
          </button>
          <button type="button" className="ghost small" disabled={busy} onClick={refresh}>
            Check again
          </button>
        </div>
        {!status.shortcut_ready && !status.shortcut_link && <ShortcutSteps name={status.shortcut} />}
        <label className="toggle-row">
          <span className="toggle-text">
            <span className="toggle-label">Shortcut name</span>
            <span className="toggle-hint">The shortcut TodoCity runs to set Focus.</span>
          </span>
          <input
            className="email-select"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name.trim() !== status.shortcut && void run(() => api.focusSet({ shortcut: name.trim() }))}
            aria-label="Shortcut name"
          />
        </label>

        <div className="setting-line">
          {dot(tried)}
          <span className="setting-line-text">
            <strong>Try it</strong> · Turns Focus on for one minute. The first time, macOS asks to let TodoCity run the shortcut.
          </span>
          <button
            type="button"
            className="ghost small"
            disabled={busy || !status.shortcut_ready}
            onClick={() =>
              void run(async () => {
                await api.focusTry();
                setTried(true);
              })
            }
          >
            Try it
          </button>
        </div>

        <div className="setting-line">
          <span className="dot ok" aria-hidden />
          <span className="setting-line-text">
            <strong>Let the right things through</strong> · In that Focus, allow Calendar and TodoCity so meeting alerts and your wrap-up still arrive.
          </span>
          <button type="button" className="ghost small" onClick={() => void run(api.focusOpenSystemSettings)}>
            Open Focus settings
          </button>
        </div>

        <div className="setting-line">
          {dot(status.login_item)}
          <span className="setting-line-text">
            <strong>Open at login</strong>
            {status.login_item ? " · On, so blocks start on time." : " · Turn on Open at login in General so blocks start on time."}
          </span>
        </div>
      </div>

      <h4 className="connector-subhead">New blocks</h4>
      <div className="card-stack">
        <label className="toggle-row">
          <span className="toggle-text">
            <span className="toggle-label">Length</span>
            <span className="toggle-hint">For “Focus now”. In Calendar, type “Focus” or “Focus: draft the brief for 90 min” in an hour.</span>
          </span>
          <select
            className="email-select"
            value={status.minutes}
            onChange={(e) => void run(() => api.focusSet({ minutes: Number(e.target.value) }))}
            aria-label="Length of a new focus block"
          >
            {[25, 30, 45, 50, 60, 90, 120].map((m) => (
              <option key={m} value={m}>
                {m} min
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && <p className="setting-line error-text">{error}</p>}
    </section>
  );
}
