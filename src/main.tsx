import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { api, onSettingsChanged } from "./lib/api";
import { applyTheme, cachedTheme } from "./lib/theme";
import { setDoneSound } from "./lib/doneSound";
import { pageDrawn } from "./lib/pageCheck";
import { ViewBoundary } from "./components/ViewBoundary";
import { TitleTips } from "./components/TitleTips";
import Popover from "./popover/Popover";
import QuickAdd from "./quick/QuickAdd";
import "./styles.css";
import "./popover/popover.css";
import "./quick/quick.css";

/** Both windows load this bundle; the window's label picks the view. */
function currentView(): string {
  try {
    return getCurrentWindow().label;
  } catch {
    return new URLSearchParams(window.location.search).get("view") ?? "panel";
  }
}

const view = currentView();
document.documentElement.dataset.view = view;
// No flash of the wrong theme while settings load.
applyTheme(cachedTheme());

// Every window follows the Appearance preference, live.
try {
  api
    .getSettings()
    .then((s) => {
      applyTheme(s.theme);
      setDoneSound(s.done_sound);
    })
    .catch(() => undefined);
  void onSettingsChanged((s) => {
    applyTheme(s.theme);
    setDoneSound(s.done_sound);
  }).catch(() => undefined);
} catch {
  // Outside Tauri (e.g. a browser preview): follow the system.
}

// Errors outside drawing (a failed load, say) go to the app's log too.
window.addEventListener("error", (e) => {
  void api.pageError(view, `${e.message}\n${e.error?.stack ?? ""}`).catch(() => undefined);
});

// The menu-bar popover answers each time it opens, so the app can reload it
// if macOS unloaded the page while it was hidden (see popover.rs).
if (view === "popover") {
  try {
    void listen<number>("popover-check", (e) => {
      void api.popoverAlive(e.payload, pageDrawn(document.getElementById("root"))).catch(() => undefined);
    }).catch(() => undefined);
  } catch {
    // Outside Tauri.
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ViewBoundary view={view}>{view === "popover" ? <Popover /> : view === "quick" ? <QuickAdd /> : <App />}</ViewBoundary>
    <TitleTips />
  </React.StrictMode>,
);
