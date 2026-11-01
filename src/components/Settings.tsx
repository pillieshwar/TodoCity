import type { ReactNode } from "react";
import { activeMode } from "../lib/modes";
import type { AppSettings, Status, UpdateStatus } from "../lib/types";
import type { ShortcutSettings } from "../lib/shortcuts";
import { ConnectorsTab } from "./ConnectorsTab";
import { AgentsPage } from "./AgentsSection";
import { WatchSection } from "./WatchSection";
import { safeLocale } from "../lib/locale";
import { AppearancePage, CapturePage, CityPage, DataSection, GeneralPage, HelpPage, NotificationsPage } from "./GeneralSettings";
import { ModelsTab } from "./ModelsTab";
import { ModesSection } from "./ModesSettings";
import { ShortcutEditor } from "./ShortcutEditor";
import { SyncSection, useSyncStatus } from "./SyncSection";
import { LineIcon, type IconName } from "./LineIcon";

export type SettingsPage =
  | "general"
  | "appearance"
  | "notifications"
  | "capture"
  | "modes"
  | "city"
  | "sync"
  | "connectors"
  | "agents"
  | "watch"
  | "model"
  | "backups"
  | "help";

interface PageInfo {
  id: SettingsPage;
  label: string;
  /** A grey line icon (the accent when selected). */
  icon: IconName;
}

export const PAGE_GROUPS: { label: string; pages: PageInfo[] }[] = [
  {
    label: "App",
    pages: [
      { id: "general", label: "General", icon: "gear" },
      { id: "appearance", label: "Appearance", icon: "appearance" },
      { id: "notifications", label: "Notifications", icon: "bell" },
      { id: "capture", label: "Capture & shortcuts", icon: "command" },
    ],
  },
  {
    label: "Tasks",
    pages: [
      { id: "modes", label: "Modes", icon: "modes" },
      { id: "city", label: "Your city", icon: "city" },
    ],
  },
  {
    label: "AI",
    pages: [
      { id: "agents", label: "Agents", icon: "delegate" },
      { id: "watch", label: "Watch", icon: "eye" },
      { id: "model", label: "Open models", icon: "sparkle" },
    ],
  },
  {
    label: "Connections",
    pages: [
      { id: "connectors", label: "Connectors", icon: "plug" },
      { id: "sync", label: "Your other Macs", icon: "macs" },
    ],
  },
  {
    label: "Data",
    pages: [
      { id: "backups", label: "Backups & export", icon: "backup" },
      { id: "help", label: "Help", icon: "help" },
    ],
  },
];

const ALL = PAGE_GROUPS.flatMap((g) => g.pages);
export const pageLabel = (p: SettingsPage) => ALL.find((x) => x.id === p)?.label ?? "Settings";

/** Older names for places in Settings (from the menu bar, the tour…). */
export function pageFromTab(t: string): SettingsPage | null {
  const old: Record<string, SettingsPage> = { settings: "general", models: "model", transfer: "connectors", movein: "connectors", preferences: "general", harness: "agents" };
  if (old[t]) return old[t];
  return ALL.some((p) => p.id === t) ? (t as SettingsPage) : null;
}

/** The pages, grouped: a sidebar in full screen, a list in the side panel. */
export function SettingsNav({
  page,
  onPage,
  settings,
  update,
  variant,
}: {
  page: SettingsPage | null;
  onPage: (p: SettingsPage) => void;
  settings: AppSettings | null;
  update: UpdateStatus;
  variant: "side" | "list";
}) {
  const [sync] = useSyncStatus();
  const mode = activeMode(settings);
  const badge = (p: SettingsPage): ReactNode => {
    if (p === "modes" && mode) return mode.name;
    if (p === "sync" && sync?.on) return `${sync.devices.length} ${sync.devices.length === 1 ? "Mac" : "Macs"}`;
    if (p === "general" && update.state === "ready") return <span className="tab-dot" aria-label="Update ready" />;
    return null;
  };
  return (
    <nav className={`set-nav ${variant}`} aria-label="Settings">
      {PAGE_GROUPS.map((g) => (
        <div key={g.label} className="set-group">
          <h2 className="set-group-label">{g.label}</h2>
          {g.pages.map((p) => {
            const on = variant === "side" && page === p.id;
            return (
              <button
                key={p.id}
                type="button"
                className={on ? "set-item on" : "set-item"}
                aria-current={on ? "page" : undefined}
                onClick={() => onPage(p.id)}
              >
                <span className="set-icon" aria-hidden>
                  <LineIcon name={p.icon} size={18} />
                </span>
                <span className="set-label">{p.label}</span>
                <span className="set-badge">{badge(p.id)}</span>
                {variant === "list" && (
                  <svg className="set-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
                    <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>
      ))}
    </nav>
  );
}

/** One page of Settings. */
export function SettingsContent({
  page,
  settings,
  onSettings,
  shortcuts,
  onShortcuts,
  status,
  update,
  onError,
  onTour,
  onKeys,
  onModelChanged,
  onDone,
  onPage,
  showTitle = true,
}: {
  page: SettingsPage;
  settings: AppSettings | null;
  onSettings: (s: AppSettings) => void;
  shortcuts: ShortcutSettings | null;
  onShortcuts: (s: ShortcutSettings) => void;
  status: Status | null;
  update: UpdateStatus;
  onError: (message: string) => void;
  onTour: () => void;
  onKeys: () => void;
  onModelChanged: () => void;
  /** Back to the tasks (after moving in). */
  onDone: () => void;
  /** Go to another page of Settings. */
  onPage?: (p: SettingsPage) => void;
  showTitle?: boolean;
}) {
  const props = { settings, onSettings, onError };
  return (
    <div className={`settings set-page-${page}`}>
      {showTitle && <h1 className="set-title">{pageLabel(page)}</h1>}
      {page === "general" && <GeneralPage {...props} status={status} update={update} />}
      {page === "appearance" && <AppearancePage {...props} />}
      {page === "notifications" && <NotificationsPage {...props} />}
      {page === "capture" && <CapturePage {...props} shortcuts={<ShortcutEditor shortcuts={shortcuts} onShortcuts={onShortcuts} />} />}
      {page === "modes" && <ModesSection {...props} />}
      {page === "city" && <CityPage {...props} />}
      {page === "sync" && <SyncPage />}
      {page === "connectors" && <ConnectorsTab onDone={onDone} />}
      {page === "agents" && <AgentsPage />}
      {page === "watch" && <WatchSection locale={safeLocale()} onAgents={() => onPage?.("agents")} onModels={() => onPage?.("model")} />}
      {page === "model" && <ModelsTab onChanged={onModelChanged} />}
      {page === "backups" && <DataSection onError={onError} />}
      {page === "help" && <HelpPage onTour={onTour} onKeys={onKeys} />}
    </div>
  );
}

function SyncPage() {
  const [status, setStatus] = useSyncStatus();
  return (
    <section className="settings-section set-sync">
      <SyncSection status={status} onStatus={setStatus} />
    </section>
  );
}
