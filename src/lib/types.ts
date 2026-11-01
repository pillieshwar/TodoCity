/** Mirrors `todocity_core::Task`. */
export interface Task {
  id: number;
  title: string;
  due_date: string | null;
  /** `HH:MM`, only with a due date. */
  due_time: string | null;
  /** "daily" | "weekdays" | "weekly" | "biweekly" | "monthly" | "yearly" */
  recurrence: string | null;
  source_text: string | null;
  source_app: string | null;
  source_bundle: string | null;
  source_url: string | null;
  done: boolean;
  created_at: string;
  created_tz: string | null;
  completed_at: string | null;
  snoozed_until: string | null;
  notified_at: string | null;
  next_id: number | null;
  /** The user's description: links, details. */
  notes: string | null;
  /** Hard deadline, `YYYY-MM-DD` — separate from the day it's planned for. */
  deadline: string | null;
  /** Planned for the evening of its day. */
  evening: boolean;
  /** Parked: no date, out of the way. */
  someday: boolean;
  project: string | null;
  /** Section within the project. */
  heading: string | null;
  checklist: ChecklistItem[];
  /** A repeating task moved on its own: the day the series had it on. */
  series_date: string | null;
  /** A paused repeating task (no reminders). */
  paused: boolean;
  /** 0 (none), 1 (urgent), 2 (high), 3 (medium). Missing before 0.4.55. */
  priority?: number;
  /** Minutes, 1–1440; null: no set length. */
  duration?: number | null;
  /** The AI agent that last added or changed it, until you change it yourself. */
  agent?: string | null;
  /** When (RFC 3339). */
  agent_at?: string | null;
}

export interface ChecklistItem {
  text: string;
  done: boolean;
}

/** Mirrors `todocity_core::ProjectSummary`. */
export interface ProjectSummary {
  name: string;
  open: number;
  done: number;
  /** The color the user picked for it (`#rrggbb`). */
  color?: string | null;
  /** The app it's kept in sync with (`things3`, `todoist`). */
  synced?: string | null;
}

/** Mirrors `todocity_core::NewTask` (created_tz is filled in by Rust). */
export interface NewTask {
  title: string;
  due_date: string | null;
  due_time?: string | null;
  recurrence?: string | null;
  source_text: string | null;
  source_app?: string | null;
  source_bundle?: string | null;
  source_url?: string | null;
  notes?: string | null;
  deadline?: string | null;
  evening?: boolean;
  someday?: boolean;
  project?: string | null;
  heading?: string | null;
  checklist?: ChecklistItem[];
  priority?: number;
  /** Minutes, 1–1440. */
  duration?: number | null;
}

/** Mirrors `todocity_core::TaskPatch`. Omit a key to leave it unchanged. */
export interface TaskPatch {
  title?: string;
  due_date?: string | null;
  due_time?: string | null;
  recurrence?: string | null;
  snoozed_until?: string | null;
  notes?: string | null;
  done?: boolean;
  deadline?: string | null;
  evening?: boolean;
  someday?: boolean;
  project?: string | null;
  heading?: string | null;
  checklist?: ChecklistItem[];
  paused?: boolean;
  /** 0 clears it. */
  priority?: number;
  /** Minutes, 1–1440; null (or 0) clears it. */
  duration?: number | null;
  /** Moving a repeating task: just this one (the series keeps its days). */
  only_this?: boolean;
}

/** Mirrors `todocity_core::Extraction`. */
export interface Extraction {
  task: string;
  date_text: string | null;
  date_confidence: "high" | "low" | "none";
}

/** Mirrors `capture::CaptureResult` in the Tauri crate. */
/** Mirrors `capture::SourceInfo`. */
export interface SourceInfo {
  app: string | null;
  bundle: string | null;
  url: string | null;
}

export type CaptureResult =
  | { kind: "text"; text: string; method: "accessibility" | "clipboard" | "service"; source: SourceInfo | null }
  | { kind: "nothing_selected" }
  | { kind: "permission_needed" }
  | { kind: "clipboard_busy" }
  | { kind: "failed"; message: string };

export interface Status {
  accessibility: boolean;
  /** "bundled" (default) or "ollama" (developer override). */
  engine: "bundled" | "ollama";
  /** Name of the model captures will use, or null if none is downloaded. */
  active_model: string | null;
  version: string;
  /** "macos" | "windows" | "linux" */
  platform: string;
}

/** Mirrors `todocity_core::notify::NotifySettings`. */
export interface NotifySettings {
  enabled: boolean;
  /** `HH:MM` — when to remind about tasks with a day but no time. */
  all_day_time: string;
  daily_summary: boolean;
}

/** Mirrors `settings::AppSettings`. */
export interface AppSettings {
  notify: NotifySettings;
  auto_update: boolean;
  remember_source: boolean;
  onboarding_done: boolean;
  autostart_initialized: boolean;
  last_summary: string | null;
  last_backup: string | null;
  seen_version: string | null;
  show_on_start: boolean;
  last_greeted: string | null;
  menubar_placed: boolean;
  capture_in_menu_bar: boolean;
  theme: Theme;
  theme_v2?: boolean;
  look_v2?: boolean;
  /** Press ⌘C twice to capture. */
  double_copy: boolean;
  /** The name the user gave their city; null until they name it. */
  city_name: string | null;
  /** Show the city in the corner of full screen. */
  city_corner: boolean;
  /** Play the "Lights on" sound when a task is done. */
  done_sound?: boolean;
  /** What the city calls its mayor (the user). */
  mayor_name: string | null;
  /** Highest population reached (milestones stay built); only goes up. */
  city_peak?: number;
  /** The milestone (its population) last celebrated. */
  city_seen?: number;
  /** Once a day, open the menu-bar dropdown on tasks that have no date. */
  undated_nudge: boolean;
  /** When, `HH:MM` local time. */
  undated_time: string;
  last_undated_nudge: string | null;
  /** When a task's time comes, also open the dropdown on it. */
  due_spotlight: boolean;
  agents_enabled: boolean;
  agents_proactive: boolean;
  watch: WatchSettings;
  /** Personal touches (missing in older settings files). */
  look?: LookSettings;
  /** Modes this Mac offers (missing before 0.4.48). */
  modes?: ViewMode[];
  /** The mode this Mac is in; null shows everything. */
  mode?: string | null;
  /** Open in full screen when TodoCity starts. */
  open_full?: boolean;
  /** Keys changed for actions in task lists (`appKeys.ts` action id → key). */
  app_keys?: Record<string, string>;
}

/** Mirrors `todocity_core::modes::ViewMode`: which projects a Mac shows. */
export interface ViewMode {
  id: string;
  name: string;
  icon: string;
  /** Shown projects, or hidden ones when `new_projects` is on. */
  projects: string[];
  /** New projects show here too (then `projects` lists the hidden ones). */
  new_projects: boolean;
  /** Show tasks that belong to no project. */
  no_project: boolean;
  /** Calendars hidden in this mode, by key. */
  hidden_calendars: string[];
  /** Only notify about tasks this mode shows. */
  notify: boolean;
  /** Tasks added with no project go here in this mode. */
  new_task_project: string | null;
}

/** Mirrors `settings::LookSettings`. */
export interface LookSettings {
  week_start: "auto" | "sun" | "mon" | "sat";
  clock: "auto" | "12" | "24";
  start_list: "last" | "today" | "upcoming" | "inbox" | "all";
  /** Notes and sub-tasks under each task in full screen. */
  details: boolean;
  accent: "purple" | "blue" | "green" | "orange" | "pink";
  city_sky: "auto" | "night" | "dusk";
  city_motion: boolean;
  compact: boolean;
  /** The mayor's figure in the city and the sidebar. */
  mayor_look: "man" | "woman";
  /** Full screen's right-hand pane width in points (0: the default). */
  side_width: number;
  /** Full screen's right-hand pane is open. */
  side_open: boolean;
  /** Show finished tasks in the lists (they're always in Completed). */
  show_done: boolean;
  /** List or board, per view ("inbox", "project:<name>"). */
  list_views: Record<string, "list" | "board">;
  /** Where a task came from ("from Mail"): always, only on hover, or never. */
  show_source: "always" | "hover" | "never";
}

/** Mirrors `agents::InboxItem`: a task an AI agent sent, waiting for review. */
export interface InboxItem {
  id: number;
  title: string;
  due_date: string | null;
  due_time: string | null;
  notes: string | null;
  /** Display name of the AI app, e.g. "Claude". */
  agent: string;
  received_at: string;
  /** Deadline phrase to resolve ("by Friday") when there's no due_date. */
  date_text: string | null;
  /** "agent" (sent over MCP) or "watch" (noticed on screen). */
  source: "agent" | "watch";
}

/** Mirrors `settings::WatchSettings`. */
export interface WatchSettings {
  enabled: boolean;
  /** Bundle ids the user doesn't want read. */
  excluded: string[];
  plugged_in_only: boolean;
  show_right_away: boolean;
  paused_until: string | null;
  /** Your name as each app shows it, by bundle id. */
  names: Record<string, string>;
  /** Who reads new messages: "local" (open model on this Mac) or an agent id. */
  reader: string;
}

/** An agent Watch can send to (mirrors `watch_agent::Reader`). */
export interface WatchReader {
  id: string;
  name: string;
  installed: boolean;
  /** TodoCity is connected in it (Settings → Agents). */
  connected: boolean;
}

/** Mirrors `watch::Status`. */
export interface WatchStatus {
  supported: boolean;
  /** The Mac account's full name, the default for "your name". */
  default_name: string | null;
  /** Id of the model in use. */
  model: string | null;
  settings: WatchSettings;
  /** [bundle id, name] of apps never read. */
  always_skipped: [string, string][];
  live: {
    state: "off" | "watching" | "paused" | "on_battery" | "no_model" | "no_agent" | "no_access" | "unsupported";
    current: string | null;
    last_found: string | null;
    /** The last look at a watched window: counts only, never text. */
    last_look: {
      app: string;
      at: string;
      lines: number;
      new: number;
      asked: boolean;
      found: number;
      step: string;
    } | null;
    /** Apps recently in front, most recent first. */
    recent: { bundle: string; name: string; skipped: boolean }[];
  };
  /** Agents Watch can send to. */
  readers: WatchReader[];
}

/** Mirrors `agents::Status`. */
export interface AgentsStatus {
  supported: boolean;
  enabled: boolean;
  /** Agents may add to-dos they notice on their own (still reviewed). */
  proactive: boolean;
  /** Agents can read and change everything, with no review. */
  full_access: boolean;
  /** How many tools full access gives agents. */
  tool_count: number;
  command: string;
  temporary_location: boolean;
  apps: AgentApp[];
  pending: number;
}

/** Mirrors `agents::apps::AppStatus`. */
export interface AgentApp {
  id: string;
  name: string;
  installed: boolean;
  connected: boolean;
  /** Connected to a copy of TodoCity that has moved. */
  stale: boolean;
  restart_hint: string;
}

export type Theme = "system" | "light" | "dark";

/** Mirrors `popover::Focus`: why the popover opened by itself. */
export type PopoverFocus = { kind: "due"; ids: number[] } | { kind: "undated" } | { kind: "inbox" };

export type NotificationPermission = "not_determined" | "denied" | "granted" | "unsupported";

/** Mirrors `updates::UpdateStatus`. */
export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "up_to_date" }
  | { state: "downloading"; version: string; percent: number | null }
  | { state: "ready"; version: string; notes: string | null }
  | { state: "failed"; message: string };

/** Mirrors `data::BackupInfo`. */
export interface BackupInfo {
  name: string;
  day: string;
  size: number;
}

/** Mirrors `models::ModelView` (catalog entry + local state). */
export interface ModelInfo {
  id: string;
  name: string;
  publisher: string;
  description: string;
  license: string;
  repo: string;
  file: string;
  approx_size_mb: number;
  min_ram_gb: number;
  recommended: boolean;
  /** Quality for TodoCity (1 = best). */
  rank: number;
  installed: boolean;
  active: boolean;
  partial_bytes: number;
  progress: { downloaded: number; total: number } | null;
}

/** Mirrors `models::DownloadEvent`. */
export type DownloadEvent =
  | { state: "progress"; id: string; downloaded: number; total: number }
  | { state: "done"; id: string }
  | { state: "cancelled"; id: string }
  | { state: "failed"; id: string; error: string };

/** Mirrors `models::CustomModelView`: a model file the user added by path. */
export interface CustomModelInfo {
  id: string;
  name: string;
  path: string;
  size: number;
  source: string | null;
  active: boolean;
  /** False if the file was moved or deleted after it was added. */
  available: boolean;
}

/** Mirrors `local_models::FoundModel`: a model another app downloaded. */
export interface FoundModel {
  name: string;
  path: string;
  size: number;
  source: string;
}

export interface LocalModels {
  added: CustomModelInfo[];
  found: FoundModel[];
}

/** Mirrors `reminders::Access`. */
export type RemindersAccess = "not_determined" | "denied" | "restricted" | "full" | "write_only" | "unsupported";

/** Mirrors `reminders::ListInfo`. */
export interface RemindersList {
  id: string;
  title: string;
  /** "iCloud", "On My Mac", an Exchange account… */
  source: string;
  /** The list syncs off this Mac (iCloud or another account). */
  leaves_mac: boolean;
  icloud: boolean;
  writable: boolean;
}

/** Mirrors `reminders::Status`. */
export interface RemindersStatus {
  supported: boolean;
  access: RemindersAccess;
  enabled: boolean;
  include_notes: boolean;
  list: RemindersList | null;
  linked: number;
  last_sync: string | null;
  last_error: string | null;
}


/** Mirrors `calendar::CalendarInfo`. */
export interface CalendarInfo {
  id: string;
  /** "Account / Title" — how TodoCity remembers which calendars to hide. */
  key: string;
  title: string;
  source: string;
  color: string | null;
}

/** Mirrors `calendar::EventInfo`. Times are local `YYYY-MM-DDTHH:MM:SS`. */
export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  calendar: string;
  color: string | null;
  /** Mirrors `meeting_move::Movable`: moves freely, after "Move for everyone?", or stays put. */
  movable?: "yes" | "everyone" | "no";
}

/** Mirrors `calendar::Status`. */
export interface CalendarStatus {
  supported: boolean;
  access: RemindersAccess;
  enabled: boolean;
  /** Calendars turned off, by key. Everything else (and anything new) shows. */
  hidden: string[];
}

export interface RemindersEnableRequest {
  /** null = create a list called "TodoCity". */
  list_id: string | null;
  include_notes: boolean;
  push_existing: boolean;
}

/** A finished task, as one lit window of the city. */
export interface CityWindow {
  id: number;
  title: string;
  project: string | null;
  heading: string | null;
  completed_at: string;
}

/** A project's heading (a floor of its building) and its task counts. */
export interface FloorSummary {
  project: string;
  name: string;
  open: number;
  done: number;
}

/** Mirrors `todocity_core::things::Options`. */
export interface ThingsOptions {
  include_done: boolean;
  include_canceled: boolean;
  /** Building keys to leave behind. */
  skip: string[];
  /** Todoist: priorities 1–3 become #p1–#p3. */
  priority_tags?: boolean;
}

/** Mirrors `todocity_core::things::BuildingPreview`. */
export interface ThingsBuilding {
  key: string;
  name: string;
  kind: "project" | "area" | "loose";
  area: string | null;
  open: number;
  done: number;
  floors: number;
}

/** Mirrors `todocity_core::things::Preview`. */
export interface ThingsPreviewData {
  buildings: ThingsBuilding[];
  open: number;
  done: number;
  someday: number;
  repeating: number;
  subtasks: number;
  canceled: number;
  unmapped_repeats: number;
  already: number;
}

export interface ThingsSource {
  path: string;
  modified: string | null;
}

export interface ThingsPreview {
  source: ThingsSource;
  preview: ThingsPreviewData;
}

export interface TodoistPreview {
  source: { kind: "api" | "csv"; label: string };
  preview: ThingsPreviewData;
}

/** Mirrors `todocity_core::ImportReport`. */
export type MirrorSource = "things" | "todoist";

/** One app kept in sync (mirrors `mirror::LinkStatus`). */
export interface MirrorLink {
  since: string;
  last: string | null;
  error: string | null;
  projects: number;
}

export interface MirrorStatus {
  things: MirrorLink | null;
  todoist: MirrorLink | null;
}

export interface ImportReport {
  added: number;
  done: number;
  skipped: number;
  failed: number;
}

/** A Mac in the sync group (mirrors `sync::DeviceView`). */
export interface SyncDevice {
  id: string;
  name: string;
  me: boolean;
  /** When this Mac last heard from it (RFC 3339). */
  last_seen: string | null;
}

/** A pairing in progress (mirrors `sync::PairView`). */
export interface SyncPairing {
  role: "host" | "join";
  /** Shown as `K7MX-4QRB`. */
  code: string;
  stage: "waiting" | "compare" | "finishing" | "done" | "failed";
  /** Six digits both Macs show, e.g. `482 913`. */
  sas: string | null;
  confirmed: boolean;
  error: string | null;
}

/** Mirrors `sync::SyncStatus`. */
export interface SyncStatus {
  on: boolean;
  name: string;
  devices: SyncDevice[];
  /** Projects kept on this Mac only. */
  local_only: string[];
  last_ok: string | null;
  error: string | null;
  busy: boolean;
  /** Changes made here not sent yet. */
  pending: number;
  /** Another Mac removed this one. */
  removed_notice: boolean;
  pairing: SyncPairing | null;
}

/** Mirrors `calsync::SourceInfo`: an account TodoCity's calendars can live in. */
export interface CalendarSource {
  id: string;
  title: string;
  /** On My Mac (stays here) rather than an account that syncs (iCloud…). */
  local: boolean;
}

/** Mirrors `calsync::LaneInfo`: one project's calendar (or Inbox). */
export interface CalendarLane {
  key: string;
  group: string;
  name: string;
  on: boolean;
}

/** Mirrors `calsync::Status`. */
export interface CalendarSyncStatus {
  supported: boolean;
  access: RemindersAccess;
  enabled: boolean;
  source: string | null;
  sources: CalendarSource[];
  lanes: CalendarLane[];
  last_sync: string | null;
  last_error: string | null;
  synced: number;
}

/** Mirrors `agents::ChangeInfo`: one thing an agent did to one task. */
/** Where a task sent to an agent is: on it, waiting for you, finished, or its terminal closed. */
export type RunStatus = "working" | "needs_you" | "ready" | "paused";

/** A task handed to an AI agent with "Send to agent" (local to this Mac). */
export interface AgentRun {
  id: number;
  task_id: number;
  /** "claude", "codex", "gemini", "cursor". */
  agent: string;
  agent_name: string;
  folder: string | null;
  status: RunStatus;
  summary: string | null;
  links: string[];
  started_at: string;
  updated_at: string;
  /** The last few readable lines from its terminal, if any were kept. */
  tail: string | null;
  /** Its terminal's text was kept ("What it did"). */
  has_transcript: boolean;
  /** The open terminal it's in, if any. */
  session: number | null;
}

/** A command-line agent the panel can start. */
export interface AgentCliStatus {
  id: string;
  name: string;
  installed: boolean;
}

/** A terminal in the agent panel. */
export interface TermSession {
  id: number;
  /** An agent id, or null for a plain terminal. */
  agent: string | null;
  name: string;
  title: string;
  folder: string;
  task_id: number | null;
  run_id: number | null;
  alive: boolean;
}

export interface AgentChange {
  id: number;
  at: string;
  /** "Claude", "Cursor"… */
  agent: string;
  batch: string;
  task_id: number;
  kind: string;
  title: string;
  summary: string;
  undone: boolean;
}
