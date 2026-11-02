import { Component, type ErrorInfo, type ReactNode } from "react";
import { api } from "../lib/api";
import { RELOADED_KEY, shouldAutoReload } from "../lib/pageCheck";

function lastReload(): number | null {
  try {
    const v = sessionStorage.getItem(RELOADED_KEY);
    return v === null ? null : Number(v);
  } catch {
    return null;
  }
}

function markReload(now: number) {
  try {
    sessionStorage.setItem(RELOADED_KEY, String(now));
  } catch {
    // Without storage, the button below still works.
  }
}

/**
 * Keeps one drawing error from leaving a window empty: the error goes to the
 * app's log, the window reloads once by itself, and if it happens again a
 * small card offers a reload.
 */
export class ViewBoundary extends Component<{ view: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const message = `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n${info.componentStack ?? ""}`;
    void api.pageError(this.props.view, message).catch(() => undefined);
    const now = Date.now();
    if (shouldAutoReload(lastReload(), now)) {
      markReload(now);
      window.setTimeout(() => window.location.reload(), 200);
    }
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="view-fallback" role="alert">
        <p>Reload to see your tasks.</p>
        <button
          type="button"
          onClick={() => {
            markReload(Date.now());
            window.location.reload();
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}
