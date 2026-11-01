import { useEffect, useRef, useState } from "react";
import { APP_ACTIONS, assignKey, keyLabel, keyMap, usableKey, type AppAction } from "../lib/appKeys";
import type { ShortcutSettings } from "../lib/shortcuts";
import { ShortcutEditor } from "./ShortcutEditor";
import { Toggle } from "./GeneralSettings";

/**
 * Keyboard shortcuts, in one calm window: the ones that work anywhere on
 * the Mac (click a key to record a new one), then the keys inside TodoCity.
 */
export function KeysModal({
  keys,
  appKeys,
  onAppKeys,
  hideActions = [],
  shortcuts,
  onShortcuts,
  doubleCopy,
  onDoubleCopy,
  onClose,
}: {
  keys: [string, string][];
  /** Keys the person changed for actions in task lists. */
  appKeys: Record<string, string>;
  onAppKeys: (changed: Record<string, string>) => void;
  hideActions?: AppAction[];
  shortcuts: ShortcutSettings | null;
  onShortcuts: (s: ShortcutSettings) => void;
  doubleCopy: boolean;
  onDoubleCopy: (on: boolean) => void;
  onClose: () => void;
}) {
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    card.current?.focus();
    const esc = (e: KeyboardEvent) => {
      // A key being recorded takes Escape for itself.
      if (e.key === "Escape" && !document.querySelector(".keycap.recording")) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", esc, true);
    return () => window.removeEventListener("keydown", esc, true);
  }, [onClose]);

  return (
    <div className="km-scrim" onClick={onClose}>
      <div className="km-card" role="dialog" aria-modal="true" aria-labelledby="km-title" tabIndex={-1} ref={card} onClick={(e) => e.stopPropagation()}>
        <header className="km-head">
          <span className="km-icon" aria-hidden>
            <KeyboardIcon />
          </span>
          <div>
            <h2 id="km-title">Keyboard shortcuts</h2>
            <p>Click a key to pick your own.</p>
          </div>
          <button type="button" className="km-close" aria-label="Close" onClick={onClose}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
              <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
            </svg>
          </button>
        </header>

        <div className="km-body">
          <section aria-labelledby="km-anywhere">
            <h3 id="km-anywhere" className="km-label">
              Anywhere on your Mac
            </h3>
            <div className="card-stack km-stack">
              <ShortcutEditor shortcuts={shortcuts} onShortcuts={onShortcuts} />
              <Toggle label="Press ⌘C twice to capture" hint="Copy as usual, then ⌘C again." checked={doubleCopy} onChange={onDoubleCopy} />
            </div>
          </section>

          <section aria-labelledby="km-inside">
            <h3 id="km-inside" className="km-label">
              In TodoCity
            </h3>
            <AppKeys changed={appKeys} onChange={onAppKeys} hide={hideActions} />
            <dl className="km-keys km-fixed">
              {keys.map(([k, v]) => (
                <div key={k} className="km-key">
                  <dt>{v}</dt>
                  <dd>
                    {k.split(/ (?:·|\/|or) /).map((part, i) => (
                      <kbd key={i}>{part}</kbd>
                    ))}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
      </div>
    </div>
  );
}

export function KeyboardIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden>
      <rect x="1.5" y="3.5" width="13" height="9" rx="2" />
      <path d="M4 6.3h.01M6.4 6.3h.01M8.8 6.3h.01M11.2 6.3h.01M4 8.6h.01M6.4 8.6h.01M8.8 8.6h.01M11.2 8.6h.01M5.5 10.6h5" strokeWidth="1.6" />
    </svg>
  );
}

/** The changeable keys: click one, press the new key. A key in use swaps with it. */
function AppKeys({ changed, onChange, hide }: { changed: Record<string, string>; onChange: (c: Record<string, string>) => void; hide: AppAction[] }) {
  const [recording, setRecording] = useState<AppAction | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const map = keyMap(changed);
  const latest = useRef({ changed, onChange });
  latest.current = { changed, onChange };
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (["Shift", "Control", "Alt", "Meta", "CapsLock"].includes(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        return;
      }
      const k = e.key.toLowerCase();
      if (e.metaKey || e.ctrlKey || e.altKey || !usableKey(k)) {
        setNote("Pick a letter, a digit, or one of , . ; ' [ ] - =");
        return;
      }
      const r = assignKey(latest.current.changed, recording, k);
      latest.current.onChange(r.changed);
      const label = (id: AppAction) => APP_ACTIONS.find((a) => a.id === id)!.label;
      setNote(r.swapped ? `${label(r.swapped)} is on ${keyLabel(keyMap(r.changed)[r.swapped])} now.` : null);
      setRecording(null);
    };
    const blur = () => setRecording(null);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", blur);
    };
  }, [recording]);
  const anyChanged = Object.keys(changed).length > 0;
  return (
    <>
      <dl className="km-keys km-mine">
        {APP_ACTIONS.filter((a) => !hide.includes(a.id)).map((a) => (
          <div key={a.id} className="km-key">
            <dt>{a.label}</dt>
            <dd>
              {a.also && <kbd>{a.also}</kbd>}
              <button
                type="button"
                className={recording === a.id ? "keycap km-cap recording" : map[a.id] !== a.key ? "keycap km-cap changed" : "keycap km-cap"}
                aria-label={recording === a.id ? `Press the new key for ${a.label}, or Esc` : `${a.label}: ${keyLabel(map[a.id])}. Change key`}
                onClick={() => {
                  setNote(null);
                  setRecording(recording === a.id ? null : a.id);
                }}
              >
                {recording === a.id ? "Press a key" : keyLabel(map[a.id])}
              </button>
            </dd>
          </div>
        ))}
      </dl>
      <div className="km-mine-foot" aria-live="polite">
        <span>{note}</span>
        {anyChanged && (
          <button
            type="button"
            className="km-reset"
            onClick={() => {
              onChange({});
              setNote(null);
            }}
          >
            Use the usual keys
          </button>
        )}
      </div>
    </>
  );
}
