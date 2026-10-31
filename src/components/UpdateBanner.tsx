import { useState } from "react";
import { api } from "../lib/api";
import type { UpdateStatus } from "../lib/types";

/**
 * A small note at the top of the panel when a new version is on its way or
 * ready: "Update now" restarts into it, "Later" hides it until the next
 * launch (or a newer version).
 */
export function UpdateBanner({ update, onError }: { update: UpdateStatus; onError: (message: string) => void }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Downloading happens quietly; the note shows once it's ready.
  if (update.state !== "ready" || dismissed === update.version) return null;

  return (
    <div className="update-banner" role="status">
      <UpdateIcon />
      <p>
        <strong>TodoCity {update.version}</strong> is ready. Update to get the latest — your tasks stay as they are.
      </p>
      <div className="update-banner-actions">
        <button type="button" className="link-btn" onClick={() => setDismissed(update.version)}>
          Later
        </button>
        <button
          type="button"
          className="primary small"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            api.installUpdate().catch((e) => {
              setBusy(false);
              onError(String(e));
            });
          }}
        >
          {busy ? "Updating…" : "Update now"}
        </button>
      </div>
    </div>
  );
}

function UpdateIcon() {
  return (
    <svg className="update-banner-icon" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.5v6M5.4 8.2 8 10.8l2.6-2.6" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
