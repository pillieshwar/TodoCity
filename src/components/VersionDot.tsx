import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import type { UpdateStatus } from "../lib/types";
import { LineIcon } from "./LineIcon";
import whatsNew from "../whats-new.json";

const REPO = "https://github.com/pillieshwar/TodoCity";
/** A few plain lines per version, newest first (also used for the release notes). */
const WHATS_NEW: Record<string, string[]> = whatsNew;

/**
 * Full screen's footer, right side: nothing while TodoCity is up to date
 * (the version lives in Settings → General → Updates). When a new version
 * has downloaded, one quiet "Update ready" pill; click it for what's new and
 * Update, which restarts into it. No banner, no badge elsewhere.
 */
export function VersionDot({ update, version, onError }: { update: UpdateStatus; version: string | null; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  // Update was pressed while the new version was still downloading.
  const [wanted, setWanted] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const newer = update.state === "ready" || update.state === "downloading";
  const tone = newer ? "ready" : update.state === "failed" ? "gray" : "green";
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const install = () => {
    setBusy(true);
    api.installUpdate().catch((e) => {
      setBusy(false);
      onError(String(e));
    });
  };
  // Once it's downloaded, finish what Update started.
  useEffect(() => {
    if (wanted && update.state === "ready") {
      setWanted(false);
      install();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, update.state]);

  const label =
    update.state === "ready"
      ? `TodoCity ${update.version} is out`
      : update.state === "downloading"
        ? `Getting TodoCity ${update.version}${update.percent !== null ? ` · ${update.percent}%` : "…"}`
        : update.state === "checking"
          ? "Checking for updates…"
          : update.state === "failed"
            ? "TodoCity checks for updates on its own"
            : "You're up to date";
  // What's new: in the version that's ready, or the one running.
  const nextNotes =
    update.state === "ready" && update.notes
      ? update.notes
          .split(/\n+/)
          .map((l) => l.replace(/^[-•*]\s*/, "").trim())
          .filter((l) => l && !/^TodoCity v?\d/.test(l))
      : [];
  const notesFor = update.state === "ready" && nextNotes.length ? update.version : version;
  const notes = update.state === "ready" && nextNotes.length ? nextNotes : version ? (WHATS_NEW[version] ?? []) : [];

  // Quiet until there's something to do.
  if (update.state !== "ready" && !busy && !wanted && !open) return null;
  return (
    <div className={open ? "vdot-wrap open" : "vdot-wrap"} ref={ref}>
      <button type="button" className={`vdot ${tone}`} aria-expanded={open} title={label} onClick={() => setOpen((o) => !o)}>
        <span className="vdot-dot" aria-hidden />
        {busy ? "Updating…" : "Update ready"}
      </button>
      {open && (
        <div className="vdot-pop" role="dialog" aria-label="Version">
          <p className="vdot-now">
            <span className={`vdot-dot ${tone}`} aria-hidden /> {label}
          </p>
          <p className="vdot-ver">TodoCity {version ?? ""} · checks every day at 12:00 PM</p>
          {notes.length > 0 && (
            <>
              <p className="vdot-cap">What's new in {notesFor}</p>
              <ul className="vdot-notes">
                {notes.slice(0, 6).map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </>
          )}
          {newer ? (
            <button
              type="button"
              className="primary small vdot-btn"
              disabled={busy || wanted}
              onClick={() => (update.state === "ready" ? install() : setWanted(true))}
            >
              {busy ? "Restarting…" : wanted ? "Updating when it's ready…" : "Update"}
            </button>
          ) : (
            <button
              type="button"
              className="ghost small vdot-btn"
              disabled={update.state === "checking"}
              onClick={() => void api.checkForUpdates().catch((e) => onError(String(e)))}
            >
              Check now
            </button>
          )}
          <div className="vdot-links">
            <button type="button" onClick={() => void api.openUrl(`${REPO}/releases`).catch((e) => onError(String(e)))}>
              <LineIcon name="external" size={14} /> All release notes
            </button>
            <button type="button" onClick={() => void api.openUrl(REPO).catch((e) => onError(String(e)))}>
              <LineIcon name="star" size={14} /> Star on GitHub
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
