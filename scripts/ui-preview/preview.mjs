// Renders TodoCity's UI in Chromium with a fake Tauri backend and saves
// screenshots of the main states. Used by .github/workflows/ui-preview.yml.
//
//   node scripts/ui-preview/preview.mjs http://localhost:4173 out/
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const [base = "http://localhost:4173", out = "ui-preview-out"] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const pad = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const day = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return iso(d);
};

const hm = (offsetMin) => {
  const d = new Date(Date.now() + offsetMin * 60000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const localStamp = (offsetMin) => {
  const d = new Date(Date.now() + offsetMin * 60000);
  return `${iso(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
};

let nextId = 1;
const task = (title, extra = {}) => ({
  id: nextId++,
  title,
  due_date: null,
  due_time: null,
  recurrence: null,
  source_text: null,
  source_app: null,
  source_bundle: null,
  source_url: null,
  done: false,
  created_at: "2026-10-10T10:00:00Z",
  created_tz: null,
  completed_at: null,
  snoozed_until: null,
  notified_at: null,
  next_id: null,
  notes: null,
  deadline: null,
  evening: false,
  someday: false,
  project: null,
  heading: null,
  checklist: [],
  series_date: null,
  paused: false,
  priority: 0,
  ...extra,
});

const TASKS = [
  task("Send Q3 numbers to Priya #work", {
    due_date: day(0),
    due_time: hm(-5),
    notified_at: localStamp(-5),
    source_app: "Slack",
    source_bundle: "com.tinyspeck.slackmacgap",
    source_url: "https://app.slack.com/client/T1/C2",
    source_text: "Could you send me the Q3 numbers by 3pm today?",
    priority: 1,
  }),
  task("Review the rollout checklist", {
    due_date: day(0),
    source_app: "Mail",
    notes: "Checklist: https://docs.example.com/rollout/v2 — ping Dana before sign-off",
  }),
  task("Water the plants #home", { due_date: day(0), due_time: hm(40), recurrence: "weekly" }),
  task("Renew passport", { due_date: day(-3), priority: 2 }),
  task("Reply to the design review thread #work", {
    due_date: day(1),
    source_app: "Google Chrome",
    source_url: "https://github.com/acme/app/pull/42",
  }),
  task("Book a room for Monday's review", { due_date: day(3), due_time: "10:30" }),
  task("Read the onboarding doc", {}),
  task("Pay rent #home", { due_date: day(0), done: true, completed_at: new Date().toISOString() }),
];

const MODE = (id, name, icon, extra = {}) => ({
  id, name, icon, projects: [], new_projects: false, no_project: true, hidden_calendars: [], notify: true, new_task_project: null, ...extra,
});
const MODES = [
  MODE("work", "Work", "💼", { projects: ["Office"], new_task_project: "Office" }),
  MODE("personal", "Personal", "🏠", { new_projects: true, projects: ["Office"], new_task_project: "Home" }),
];
const SETTINGS = {
  modes: MODES,
  mode: "personal",
  open_full: true,
  notify: { enabled: true, all_day_time: "09:00", daily_summary: false },
  auto_update: true,
  remember_source: true,
  onboarding_done: true,
  autostart_initialized: true,
  last_summary: null,
  last_backup: null,
  seen_version: "0.2.1",
  show_on_start: true,
  last_greeted: null,
  menubar_placed: true,
  capture_in_menu_bar: true,
  theme: "system",
  theme_v2: true,
  double_copy: true,
  city_name: "Lumen Bay",
  city_corner: true,
  mayor_name: "Sam",
  city_seen: 99999,
  undated_nudge: true,
  undated_time: "16:00",
  last_undated_nudge: null,
  due_spotlight: true,
  agents_enabled: false,
  agents_proactive: true,
  watch: {
    enabled: false,
    apps: [],
    excluded: [],
    plugged_in_only: false,
    show_right_away: true,
    paused_until: null,
    names: {},
    reader: "local",
  },
};

const agentApp = (id, name, installed, connected = false) => ({
  id,
  name,
  installed,
  connected,
  stale: false,
  restart_hint: "Restart the app to finish.",
});
const CALSYNC_OFF = {
  supported: true,
  access: "full",
  enabled: false,
  source: null,
  sources: [
    { id: "local", title: "On My Mac", local: true },
    { id: "icloud", title: "iCloud", local: false },
  ],
  lanes: [
    { key: "p:Q4 launch", group: "Work", name: "Q4 launch", on: true },
    { key: "p:Hiring", group: "Work", name: "Hiring", on: true },
    { key: "p:Home", group: "Personal", name: "Home", on: true },
    { key: "p:Offsite 2026", group: "Personal", name: "Offsite 2026", on: true },
    { key: "inbox", group: "Personal", name: "Inbox", on: true },
  ],
  last_sync: null,
  last_error: null,
  synced: 0,
};
const AGENT_STATUS = {
  supported: true,
  enabled: false,
  proactive: true,
  full_access: false,
  tool_count: 30,
  command: "/Applications/TodoCity.app/Contents/MacOS/TodoCity",
  temporary_location: false,
  apps: [
    agentApp("claude_code", "Claude Code", true),
    agentApp("codex", "Codex", true),
    agentApp("antigravity", "Antigravity CLI", false),
    agentApp("claude_desktop", "Claude Desktop", true),
    agentApp("cursor", "Cursor", true),
    agentApp("vscode", "VS Code", false),
    agentApp("windsurf", "Windsurf", false),
    agentApp("gemini_cli", "Gemini CLI", false),
    agentApp("lm_studio", "LM Studio", false),
  ],
  pending: 0,
};

const SHORTCUTS = {
  capture: { meta: true, ctrl: false, alt: false, shift: true, code: "KeyS" },
  quick_add: { meta: true, ctrl: false, alt: false, shift: true, code: "Space" },
  toggle_panel: { meta: true, ctrl: false, alt: false, shift: true, code: "KeyH" },
};

function scenario(overrides = {}) {
  return {
    label: "panel",
    tasks: TASKS,
    settings: SETTINGS,
    status: { accessibility: true, engine: "bundled", active_model: "Qwen3.5 4B", version: "0.2.1", platform: "macos" },
    update: { state: "idle" },
    agents: AGENT_STATUS,
    calsync: CALSYNC_OFF,
    extract: null,
    backups: [
      { name: `tasks-${day(0)}.db`, day: day(0), size: 48_000 },
      { name: `tasks-${day(-1)}.db`, day: day(-1), size: 47_000 },
    ],
    ...overrides,
  };
}

/** Installed before the app loads: a fake `window.__TAURI_INTERNALS__`. */
function mockTauri(s) {
  const callbacks = new Map();
  const listeners = new Map();
  let id = 1;
  window.__emit = (event, payload) => {
    for (const cb of listeners.get(event) ?? []) callbacks.get(cb)?.({ event, id: 0, payload });
  };
  const responses = {
    // Fresh objects each time, as the real backend returns.
    list_tasks: () => s.tasks.map((t) => ({ ...t })),
    status: () => s.status,
    get_settings: () => s.settings,
    set_settings: (a) => (s.settings = a.value),
    set_view_mode: (a) => {
      s.settings = { ...s.settings, mode: a.id };
      setTimeout(() => window.__emit?.("settings-changed", s.settings), 0);
      return s.settings;
    },
    get_shortcuts: () => s.shortcuts,
    update_status: () => s.update,
    list_models: () => {
      const m = (id, name, publisher, description, mb, ram, recommended) => ({
        id, name, publisher, description, license: "Apache 2.0", repo: "x", file: "x",
        approx_size_mb: mb, min_ram_gb: ram, recommended,
        installed: recommended && !!s.status.active_model, active: recommended && !!s.status.active_model,
        partial_bytes: 0, progress: null,
      });
      return [
        m("qwen3.5-4b", "Qwen3.5 4B", "Alibaba Qwen", "The best all-rounder: fast, accurate, and quiet — it rarely suggests a to-do that isn't one.", 3010, 8, true),
        m("gemma-4-e4b", "Gemma 4 E4B", "Google", "Misses the fewest to-dos, but larger and about three times slower. For Macs with 16 GB or more.", 4980, 16, false),
        m("qwen3.5-2b", "Qwen3.5 2B", "Alibaba Qwen", "The lightest: quick captures on smaller Macs. Suggests more to-dos that aren't when watching.", 1300, 4, false),
      ];
    },
    list_local_models: () => s.local ?? { added: [], found: [] },
    reminders_status: () => s.reminders ?? ({
      supported: true,
      access: "not_determined",
      enabled: false,
      include_notes: false,
      list: null,
      linked: 0,
      last_sync: null,
      last_error: null,
    }),
    notification_permission: () => "granted",
    agents_status: () => s.agents,
    calsync_status: () => s.calsync,
    calsync_apple_enable: (a) => {
      s.calsync = { ...s.calsync, enabled: true, source: a.source, synced: 4, last_sync: new Date().toISOString() };
      window.__calsyncSource = a.source;
      return s.calsync;
    },
    calsync_set_group: (a) => {
      const c = s.calsync;
      s.calsync = { ...c, lanes: c.lanes.map((l) => (l.group === a.group ? { ...l, on: a.on } : l)) };
      return s.calsync;
    },
    calsync_set_lane: (a) => {
      const c = s.calsync;
      s.calsync = { ...c, lanes: c.lanes.map((l) => (l.key === a.key ? { ...l, on: a.on } : l)) };
      return s.calsync;
    },
    agents_set_full_access: (a) => {
      s.agents = { ...s.agents, full_access: a.on };
      window.__fullAccess = a.on;
      return s.agents;
    },
    agents_test: () => "Working — AI apps can send tasks to TodoCity.",
    inbox_list: () => s.inbox ?? [],
    agent_activity: () => s.activity ?? [],
    agent_undo: (a) => {
      window.__agentUndo = a;
      const ids = new Set(a.tasks ?? []);
      for (const c of s.activity ?? []) {
        if (c.id === a.change || c.batch === a.batch) ids.add(c.task_id);
      }
      s.activity = (s.activity ?? []).map((c) => (ids.has(c.task_id) ? { ...c, undone: true } : c));
      s.tasks = s.tasks.map((t) => (ids.has(t.id) ? { ...t, agent: null, agent_at: null } : t));
      window.__emit("tasks-changed", null);
      window.__emit("agent-changes", null);
      return ids.size;
    },
    watch_set: (a) => {
      window.__watchSet = a.change;
      const now = s.watch ?? responses.watch_status();
      s.watch = { ...now, settings: { ...now.settings, ...a.change } };
      return s.watch;
    },
    watch_status: () =>
      s.watch ?? {
        supported: true,
        default_name: "Sam Rivera",
        model: "qwen3.5-4b",
        settings: s.settings.watch,
        always_skipped: [["com.1password.1password", "1Password"]],
        live: { state: "off", current: null, last_found: null, last_look: null, recent: [] },
      },
    sync_status: () =>
      s.sync ?? {
        on: false,
        name: "Sam's MacBook Air",
        devices: [],
        local_only: [],
        last_ok: null,
        error: null,
        busy: false,
        pending: 0,
        removed_notice: false,
        pairing: null,
      },
    calendar_status: () => s.calendar ?? { supported: true, access: "not_determined", enabled: false, hidden: [] },
    calendar_calendars: () => [
      { id: "c1", key: "Google / Work", title: "Work", source: "Google", color: "#3b82f6" },
      { id: "c2", key: "iCloud / Home", title: "Home", source: "iCloud", color: "#16a34a" },
      { id: "c3", key: "Other / Birthdays", title: "Birthdays", source: "Other", color: "#a855f7" },
      { id: "c4", key: "Other / US Holidays", title: "US Holidays", source: "Other", color: "#ef4444" },
    ],
    calendar_events: (a) =>
      (s.events ?? []).filter((e) => e.start.slice(0, 10) <= a.to && (e.end.slice(0, 10) > a.from || e.start.slice(0, 10) >= a.from)),
    calendar_move_event: (a) => {
      window.__moved = a;
      const at = (s.events ?? []).find((e) => e.id === a.id && e.start === a.at);
      if (!at) throw new Error("This meeting just changed in Calendar. Take another look and move it again.");
      const now = { ...at, start: a.start, end: a.end };
      s.events = s.events.map((e) => (e === at ? now : e));
      return now;
    },
    autostart_enabled: () => true,
    panel_full: () => !!s.full,
    // v0.4.66: the agent panel and "Send to agent".
    agent_clis: () =>
      s.clis ?? [
        { id: "claude", name: "Claude Code", installed: true },
        { id: "codex", name: "Codex", installed: true },
        { id: "gemini", name: "Gemini CLI", installed: false },
        { id: "cursor", name: "Cursor Agent", installed: false },
      ],
    agent_run_list: () => s.runs ?? [],
    agent_run_transcript: (a) => (s.transcripts ?? {})[a.id] ?? null,
    agent_run_dismiss: (a) => {
      s.runs = (s.runs ?? []).filter((r) => r.id !== a.id);
      setTimeout(() => window.__emit?.("agent-runs", null), 0);
    },
    home_folder: () => "/Users/sam",
    pick_folder: () => "/Users/sam/Projects/website",
    term_list: () => s.terms ?? [],
    term_attach: (a) => {
      const data = (s.termOutput ?? {})[a.id] ?? "";
      return { data, end: data.length };
    },
    term_write: (a) => {
      window.__termWrites = [...(window.__termWrites ?? []), a];
    },
    term_resize: () => null,
    term_close: (a) => {
      s.terms = (s.terms ?? []).filter((t) => t.id !== a.id);
    },
    term_start: (a) => {
      window.__termStart = a;
      const task = a.taskId ? s.tasks.find((t) => t.id === a.taskId) : null;
      const names = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", cursor: "Cursor Agent" };
      const t = {
        id: 90 + (s.terms ?? []).length,
        agent: a.agent,
        name: a.agent ? names[a.agent] : "Terminal",
        title: task ? task.title : "website",
        folder: a.folder ?? "/Users/sam",
        task_id: a.taskId,
        run_id: a.taskId ? 700 : null,
        alive: true,
      };
      s.terms = [...(s.terms ?? []), t];
      if (task) {
        s.runs = [
          ...(s.runs ?? []),
          { id: 700, task_id: task.id, agent: a.agent, agent_name: t.name, folder: t.folder, status: "working", summary: null, links: [], started_at: new Date().toISOString(), updated_at: new Date().toISOString(), session: t.id, tail: null, has_transcript: false },
        ];
        setTimeout(() => window.__emit?.("agent-runs", null), 0);
      }
      return t;
    },
    city_windows: () => s.cityWindows ?? [],
    list_floors: () => s.floors ?? [],
    create_project: (a) => a.name,
    project_tasks: (a) => [...s.tasks, ...(s.logbook ?? [])].filter((t) => t.project === a.project),
    delete_project: () => true,
    set_project_color: (a) => {
      s.colors = { ...(s.colors ?? { "Offsite 2026": "#f08a3c", "Q4 launch": "#3fbf7f" }), [a.name]: a.color };
      return null;
    },
    delete_floor: () => true,
    add_floor: (a) => a.name,
    things_find: () => [{ path: "/Users/sam/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-1A2B3/Things Database.thingsdatabase/main.sqlite", modified: "2026-10-25T18:40:00Z" }],
    things_pick: () => null,
    things_preview: (a) => {
      const done = a.options?.include_done ?? true;
      const b = (key, name, kind, area, open, d, floors) => ({ key, name, kind, area, open, done: done ? d : 0, floors });
      const buildings = [
        b("P1", "Kitchen remodel", "project", "Home", 14, 22, 3),
        b("P2", "Q1 planning", "project", "Work", 9, 41, 2),
        b("P3", "Trip to Lisbon", "project", null, 6, 3, 0),
        b("area:A1", "Home", "area", null, 7, 120, 0),
        b("", "", "loose", null, 11, 310, 0),
      ];
      return {
        source: { path: "/Users/sam/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac/ThingsData-1A2B3/Things Database.thingsdatabase/main.sqlite", modified: "2026-10-25T18:40:00Z" },
        preview: { buildings, open: 47, done: done ? 496 : 0, someday: 8, repeating: 4, subtasks: 63, canceled: 5, unmapped_repeats: 1, already: 0 },
      };
    },
    things_import: (a) => {
      if (a.keepInSync) {
        s.mirror = { todoist: null, ...(s.mirror ?? {}), things: { since: new Date().toISOString(), last: new Date().toISOString(), error: null, projects: 4, two_way: false, can_two_way: false } };
        setTimeout(() => window.__emit?.("mirror-changed", null), 0);
      }
      return { added: 543, done: 496, skipped: 0, failed: 0 };
    },
    mirror_status: () => s.mirror ?? { things: null, todoist: null },
    mirror_sync_now: () => null,
    mirror_set_two_way: (a) => {
      const l = s.mirror?.[a.source];
      if (l) s.mirror = { ...s.mirror, [a.source]: { ...l, two_way: a.on } };
      setTimeout(() => window.__emit?.("mirror-changed", null), 0);
      return null;
    },
    mirror_stop: (a) => {
      s.mirror = { ...(s.mirror ?? {}), [a.source]: null };
      return null;
    },
    mirror_stop_project: (a) => {
      s.synced = { ...(s.synced ?? {}), [a.name]: null };
      return true;
    },
    todoist_pick_files: () => ["/Users/sam/Downloads/Lisbon [2203306141].csv"],
    todoist_preview: (a) => {
      if (a.token && a.token !== "good-token") throw "Todoist didn't accept that token. Copy it again from Todoist → Settings → Integrations → Developer.";
      if (a.token || a.files) s.todoistKind = a.token ? "api" : "csv";
      const api = (s.todoistKind ?? "api") === "api";
      const done = api && (a.options?.include_done ?? true);
      const b = (key, name, kind, area, open, d, floors) => ({ key, name, kind, area, open, done: done ? d : 0, floors });
      const buildings = [
        b("200", "Kitchen", "project", null, 12, 30, 2),
        b("201", "Tiles", "project", "Kitchen", 4, 6, 0),
        b("300", "Work", "project", null, 21, 180, 3),
        b("9", "Old launch", "project", "archived", 0, 44, 0),
        b("", "", "loose", null, 9, 75, 0),
      ].filter((x) => x.open + x.done > 0);
      return {
        source: api ? { kind: "api", label: "your Todoist account" } : { kind: "csv", label: "1 CSV file" },
        preview: { buildings, open: 46, done: done ? 335 : 0, someday: 0, repeating: 6, subtasks: 38, canceled: 0, unmapped_repeats: 2, already: 0 },
      };
    },
    todoist_import: (a) => {
      if (a.keepInSync) {
        s.mirror = { things: null, ...(s.mirror ?? {}), todoist: { since: new Date().toISOString(), last: new Date().toISOString(), error: null, projects: 3, two_way: true, can_two_way: true } };
        setTimeout(() => window.__emit?.("mirror-changed", null), 0);
      }
      return { added: 381, done: 335, skipped: 0, failed: 0 };
    },
    save_city_image: () => "/Users/sam/Downloads/Lumen Bay.png",
    set_panel_full: (a) => {
      s.full = a.full;
      setTimeout(() => window.__emit("panel-full", a.full), 0);
      return null;
    },
    list_backups: () => s.backups,
    open_source: (a) => {
      (window.__opened ??= []).push(a.id);
      return null;
    },
    reveal_data_folder: () => {
      window.__revealedData = true;
      return null;
    },
    extract: () => (s.extract === "pending" ? new Promise(() => {}) : s.extract),
    update_task: (a) => {
      const t = s.tasks.find((x) => x.id === a.id);
      if (!t) return null;
      const { only_this, ...patch } = a.patch ?? {};
      (window.__updates ??= []).push({ id: a.id, patch });
      Object.assign(t, patch);
      // The app refreshes when the backend says tasks changed.
      setTimeout(() => window.__emit?.("tasks-changed", null), 0);
      return { ...t };
    },
    add_task: (a) => {
      const t = {
        id: 900 + s.tasks.length, title: "", due_date: null, due_time: null, recurrence: null, source_text: null, source_app: null,
        source_bundle: null, source_url: null, done: false, created_at: new Date().toISOString(), created_tz: null, completed_at: null,
        snoozed_until: null, notified_at: null, next_id: null, notes: null, deadline: null, evening: false, someday: false,
        project: null, heading: null, checklist: [], series_date: null, paused: false, priority: 0, ...a.task,
      };
      s.tasks.push(t);
      setTimeout(() => window.__emit?.("tasks-changed", null), 0);
      return { ...t };
    },
    logbook: () => s.logbook ?? [],
    list_projects: () => {
      const m = new Map();
      for (const t of [...s.tasks, ...(s.logbook ?? [])]) {
        if (!t.project) continue;
        const p = m.get(t.project) ?? { name: t.project, open: 0, done: 0, color: (s.colors ?? { "Offsite 2026": "#f08a3c", "Q4 launch": "#3fbf7f" })[t.project] ?? null, synced: (s.synced ?? {})[t.project] ?? null };
        if (t.done) p.done += 1;
        else p.open += 1;
        m.set(t.project, p);
      }
      return [...m.values()];
    },
  };
  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: s.label }, currentWebview: { label: s.label, windowLabel: s.label } },
    transformCallback(cb) {
      const n = id++;
      callbacks.set(n, cb);
      return n;
    },
    unregisterCallback(n) {
      callbacks.delete(n);
    },
    convertFileSrc: (p) => p,
    async invoke(cmd, args) {
      if (cmd === "plugin:event|listen") {
        const list = listeners.get(args.event) ?? [];
        list.push(args.handler);
        listeners.set(args.event, list);
        return id++;
      }
      if (cmd.startsWith("plugin:")) return null;
      const f = responses[cmd];
      return f ? f(args ?? {}) : null;
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
}

// Software WebGL, so the 3D city renders too.
const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });

const failed = [];
async function shot(name, size, s, steps = async () => {}, dark = false) {
  // ONLY=<regex> renders just the matching previews (handy while working).
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(name)) return;
  const page = await browser.newPage({ viewport: size, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.emulateMedia({ colorScheme: dark ? "dark" : "light", reducedMotion: "reduce" });
    await page.addInitScript(mockTauri, { ...s, shortcuts: SHORTCUTS });
    await page.goto(`${base}/?view=${s.label}`);
    await page.waitForTimeout(400);
    await steps(page);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${out}/${name}.png` });
    console.log("saved", name);
  } catch (e) {
    const msg = `${name}: ${String(e).split("\n")[0]}${errors.length ? ` | page: ${errors[0]}` : ""}`;
    failed.push(msg);
    console.log(`::error::${msg.replace(/[\r\n]+/g, " ")}`);
    await page.screenshot({ path: `${out}/${name}-FAILED.png` }).catch(() => {});
  } finally {
    await page.close();
  }
}

const PANEL = { width: 360, height: 720 };
/** Settings live behind the gear; open it, then the tab. */
/** Settings pages by their old tab names too. */
const PAGE_NAMES = { Preferences: "General", Models: "Open models", "AI model": "Open models", "Data transfer": "Connectors", "Import Data": "Connectors" };
/** Open an app's card in Settings → Connectors. */
const openApp = async (p, name) => {
  await tab(p, "Connectors");
  await p.locator(".connector", { hasText: name }).first().locator(".connector-action").click();
  await p.waitForTimeout(150);
};
const tab = async (p, name) => {
  const label = PAGE_NAMES[name] ?? name;
  const item = () => p.locator(".set-item", { hasText: new RegExp(`^.?${label}`) }).first();
  if (!(await item().count())) await p.getByRole("button", { name: "Settings", exact: true }).first().click();
  await p.waitForTimeout(100);
  await item().click();
  await p.waitForTimeout(150);
};
/** Open a task as a card. */
const openTask = async (p, n) => {
  await p.locator(".task .task-row").nth(n).click();
  await p.waitForTimeout(150);
};
const POP = { width: 340, height: 540 };
const QUICK = { width: 640, height: 300 };

await shot("panel-tasks", PANEL, scenario());
await shot("panel-tasks-dark", PANEL, scenario(), async () => {}, true);
await shot("panel-focus-keys", PANEL, scenario(), async (p) => {
  await p.keyboard.press("ArrowDown");
  await p.keyboard.press("ArrowDown");
});
const doneAt = (daysAgo, h) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(h, 15, 0, 0);
  return d.toISOString();
};
const RICH_TASKS = [
  ...TASKS,
  task("Pack for the offsite", {
    due_date: day(1),
    deadline: day(2),
    project: "Offsite 2026",
    heading: "Travel",
    checklist: [
      { text: "Charger and adapters", done: true },
      { text: "Passport", done: false },
      { text: "Printed agenda", done: false },
    ],
  }),
  task("Book flights", { due_date: day(4), deadline: day(0), project: "Offsite 2026", heading: "Travel" }),
  task("Draft the welcome talk", { project: "Offsite 2026", heading: "Program" }),
  task("Call mom", { due_date: day(0), evening: true }),
  task("Learn to make sourdough", { someday: true }),
  task("Plan a trip to Japan", { someday: true }),
];
const LOGBOOK = [
  task("Send the Q2 report", { done: true, completed_at: doneAt(0, 9), project: "Offsite 2026" }),
  task("Renew car registration", { done: true, completed_at: doneAt(1, 16) }),
  task("Order team t-shirts", { done: true, completed_at: doneAt(1, 11), project: "Offsite 2026" }),
  task("Fix the leaking tap", { done: true, completed_at: doneAt(3, 18) }),
];
const rich = (o = {}) => scenario({ tasks: RICH_TASKS, logbook: LOGBOOK, ...o });
const pickList = (name) => async (p) => {
  await p.locator(".list-title").click();
  await p.locator(".lp-menu").getByRole("menuitemradio", { name }).click();
  await p.waitForTimeout(200);
};
await shot("panel-rich", PANEL, rich());
await shot("panel-lists-menu", PANEL, rich(), async (p) => {
  await p.locator(".list-title").click();
});
await shot("panel-project", PANEL, rich(), pickList(/Offsite 2026/));
await shot("panel-project-dark", PANEL, rich(), pickList(/Offsite 2026/), true);
await shot("panel-inbox", PANEL, rich(), pickList(/Inbox/));
await shot("panel-completed", PANEL, rich(), pickList(/Completed/));
await shot("panel-steps-open", PANEL, rich(), async (p) => {
  await pickList(/Offsite 2026/)(p);
  await p.locator(".task .task-row", { hasText: "Pack for the offsite" }).click();
});
await shot("panel-project-picker", PANEL, rich(), async (p) => {
  await openTask(p, 1);
  await p.locator(".task.open .tf-chip").first().click();
  await p.locator(".tf-menu").waitFor();
});
await shot("panel-when-editor", PANEL, rich(), async (p) => {
  await openTask(p, 1);
  await p.locator(".task.open .tf-chip-main").first().click();
  await p.locator(".tf-menu").waitFor();
});
await shot("popover-rich", POP, rich({ label: "popover" }));
await shot("panel-multi-select", PANEL, rich(), async (p) => {
  await p.locator(".task").nth(1).click({ modifiers: ["Meta"] });
  await p.locator(".task").nth(2).click({ modifiers: ["Meta"] });
  await p.locator(".task").nth(3).click({ modifiers: ["Meta"] });
});
await shot("panel-repeat-editor", PANEL, rich(), async (p) => {
  await p.locator(".task .task-row", { hasText: "Water the plants" }).first().click();
  // v0.4.70: repeat is an icon right after priority.
  await p.locator(".task.open").getByRole("button", { name: /^Repeat/ }).click();
  await p.locator(".tf-menu").scrollIntoViewIfNeeded();
});

const PLAN_EVENTS = [
  { id: "e1", title: "Standup", start: `${day(0)}T09:30:00`, end: `${day(0)}T09:45:00`, all_day: false, calendar: "Work", color: "#3b82f6" },
  { id: "e2", title: "Design review", start: `${day(0)}T13:00:00`, end: `${day(0)}T14:00:00`, all_day: false, calendar: "Work", color: "#3b82f6" },
  { id: "e3", title: "Halloween", start: `${day(2)}T00:00:00`, end: `${day(3)}T00:00:00`, all_day: true, calendar: "US Holidays", color: "#ef4444" },
];
const PLAN_TASKS = [
  ...TASKS,
  task("Wrap up the launch notes #work", { due_date: day(0), due_time: "12:00" }),
  task("Gym", { due_date: day(0), due_time: "18:30" }),
  task("Draft the offsite agenda", { due_date: day(0), due_time: "10:00" }),
];
const planScenario = (o = {}) => scenario({ tasks: PLAN_TASKS, events: PLAN_EVENTS, ...o });
const week = async (p) => {
  await p.locator(".list-title").click();
  await p.locator(".lp-menu").getByRole("menuitemradio", { name: /Calendar/ }).click();
  await p.waitForTimeout(250);
};
await shot("panel-week", PANEL, planScenario(), week);
await shot("panel-week-dark", PANEL, planScenario(), week, true);
await shot("panel-week-add-at-hour", PANEL, planScenario(), async (p) => {
  await week(p);
  const slot = p.locator('.plan-slot[data-hour="11"]');
  await slot.scrollIntoViewIfNeeded();
  await slot.hover();
  await slot.locator(".plan-add").click();
  await p.keyboard.type("Prep questions for the 1:1");
});
const dragTo = (from, to) => async (p) => {
  const a = p.locator(from).first();
  const b = p.locator(to).first();
  await b.scrollIntoViewIfNeeded();
  const ra = await a.boundingBox();
  const rb = await b.boundingBox();
  await p.mouse.move(ra.x + 30, ra.y + ra.height / 2);
  await p.mouse.down();
  for (let i = 1; i <= 8; i++) {
    const tx = rb.width < 120 ? rb.x + rb.width / 2 : rb.x + 60;
    await p.mouse.move(ra.x + 30 + ((tx - ra.x - 30) * i) / 8, ra.y + ra.height / 2 + ((rb.y + rb.height / 2 - ra.y - ra.height / 2) * i) / 8);
  }
  await p.waitForTimeout(150);
};
await shot("panel-week-drag-hour", PANEL, planScenario(), async (p) => {
  await week(p);
  await dragTo(".plan-any .plan-task", '.plan-slot[data-hour="15"] .plan-cell')(p);
});
await shot("panel-week-drag-day", PANEL, planScenario(), async (p) => {
  await week(p);
  await dragTo(".plan-any .plan-task", ".wk-day:not(.on)")(p);
});
await shot("popover-hours", POP, planScenario({ label: "popover" }), async (p) => {
  await p.getByRole("radio", { name: "Day" }).click();
});
await shot("popover-hours-dark", POP, planScenario({ label: "popover" }), async (p) => {
  await p.getByRole("radio", { name: "Day" }).click();
}, true);
await shot("popover-hours-drag", POP, planScenario({ label: "popover" }), async (p) => {
  await p.getByRole("radio", { name: "Day" }).click();
  await p.waitForTimeout(200);
  await dragTo(".plan-any .plan-task", '.plan-slot[data-hour="16"] .plan-cell')(p);
});
await shot("panel-today-hours", PANEL, planScenario(), async (p) => {
  await p.getByRole("radio", { name: "Hours" }).click();
  await p.waitForTimeout(250);
});
await shot("panel-today-hours-dark", PANEL, planScenario(), async (p) => {
  await p.getByRole("radio", { name: "Hours" }).click();
  await p.waitForTimeout(250);
}, true);
await shot("panel-drag-to-day", PANEL, scenario(), async (p) => {
  await dragTo(".task .task-row", ".ws-day:nth-child(4)")(p);
});
await shot("panel-add-at-project", PANEL, rich(), async (p) => {
  await p.getByRole("button", { name: "Add a task", exact: true }).click();
  await p.keyboard.type("Book hotel @off fri");
});
await shot("panel-focus-today", PANEL, scenario(), async (p) => {
  await p.keyboard.press("f");
});
await shot("panel-snooze", PANEL, scenario(), async (p) => {
  await openTask(p, 2);
  await p.locator(".task.open").getByRole("button", { name: "More", exact: true }).click();
  await p.getByRole("menuitem", { name: /Snooze/ }).click();
  await p.locator(".tf-menu .snooze-bar").waitFor();
});
await shot("panel-task-open", PANEL, scenario(), async (p) => {
  await openTask(p, 2);
});
await shot("panel-task-open-dark", PANEL, scenario(), async (p) => {
  await openTask(p, 2);
}, true);
await shot("panel-notes-edit", PANEL, scenario(), async (p) => {
  await openTask(p, 3);
  await p.locator(".task.open .tfc-notes, .task.open .task-notes").first().click();
  await p.keyboard.type("Deck: https://slides.example.com/q3");
});
await shot("panel-keys-sheet", PANEL, scenario(), async (p) => {
  await p.keyboard.press("Shift+Slash");
  await p.locator(".km-card").waitFor();
});
await shot("panel-header-in-mode", PANEL, scenario({ settings: { ...SETTINGS, modes: [{ id: "work", name: "Work", icon: "💼", projects: [], new_projects: false, no_project: true, hidden_calendars: [], notify: true, new_task_project: null }], mode: "work" } }), async (p) => {
  // Every header button stays inside the window.
  const w = await p.evaluate(() => window.innerWidth);
  for (const b of await p.locator(".topbar button").all()) {
    const r = await b.boundingBox();
    if (r && r.x + r.width > w + 1) throw new Error("a header button runs off the edge");
  }
});
await shot("panel-date-editor", PANEL, scenario(), async (p) => {
  await openTask(p, 0);
  await p.locator(".task.open .tf-chip-main").first().click();
  await p.locator(".tf-menu").waitFor();
  await p.keyboard.type("fri 3pm every week");
});
await shot("panel-search", PANEL, scenario(), async (p) => {
  await p.getByRole("button", { name: "Search", exact: true }).click();
  await p.locator(".tag-chip").first().click();
});
await shot("panel-toast", PANEL, scenario(), async (p) => {
  await p.locator(".check").nth(1).click();
  await p.waitForTimeout(700);
});
await shot(
  "panel-capture-single",
  PANEL,
  scenario({ extract: { task: "Water the plants", date_text: "every Monday morning", date_confidence: "high" } }),
  async (p) => {
    await p.evaluate(() =>
      window.__emit("capture", {
        kind: "text",
        method: "clipboard",
        text: "Reminder: water the plants every Monday morning.",
        source: { app: "Notes", bundle: "com.apple.Notes", url: null },
      }),
    );
  },
);
await shot("panel-extracting", PANEL, scenario({ extract: "pending" }), async (p) => {
  await p.evaluate(() =>
    window.__emit("capture", {
      kind: "text",
      method: "accessibility",
      text: "Can you review the rollout checklist and send comments by Friday?",
      source: { app: "Mail", bundle: "com.apple.mail", url: null },
    }),
  );
});
await shot("panel-settings-home", PANEL, scenario({ update: { state: "ready", version: "0.2.1", notes: null } }), async (p) => {
  await p.getByRole("button", { name: "Settings", exact: true }).first().click();
});
await shot("panel-settings-appearance", PANEL, scenario(), async (p) => {
  await tab(p, "Appearance");
});
await shot("panel-settings-notifications", PANEL, scenario(), async (p) => {
  await tab(p, "Notifications");
});
await shot("panel-preferences", PANEL, scenario(), async (p) => {
  await tab(p, "Preferences");
});
// Dark chosen in Preferences while macOS is light.
await shot("panel-preferences-dark", PANEL, scenario({ settings: { ...SETTINGS, theme: "dark" } }), async (p) => {
  await tab(p, "Preferences");
});
await shot("panel-settings", PANEL, scenario({ update: { state: "ready", version: "0.2.1", notes: null } }), async (p) => {
  await tab(p, "General");
});
await shot("panel-settings-data", PANEL, scenario(), async (p) => {
  await tab(p, "Backups & export");
});
await shot(
  "panel-onboarding",
  PANEL,
  scenario({
    tasks: [],
    settings: { ...SETTINGS, onboarding_done: false },
    status: { accessibility: false, engine: "bundled", active_model: null, version: "0.2.1", platform: "macos" },
  }),
);
const FRESH = scenario({
  tasks: [],
  settings: { ...SETTINGS, onboarding_done: false },
  status: { accessibility: true, engine: "bundled", active_model: null, version: "0.4.1", platform: "macos" },
});
for (let step = 1; step <= 3; step++) {
  await shot(`panel-tour-${step}`, PANEL, FRESH, async (p) => {
    for (let i = 1; i < step; i++) {
      await p.locator(".onboard-actions .primary").click();
      await p.waitForTimeout(150);
    }
  });
}
await shot(
  "panel-models",
  PANEL,
  scenario({
    local: {
      added: [],
      found: [{ name: "llama3.2:3b", path: "/Users/me/.ollama/models/blobs/sha256-x", source: "Ollama", size: 2_019_000_000 }],
    },
  }),
  async (p) => {
    await tab(p, "Models");
  },
);
await shot("panel-models-local-open", PANEL, scenario(), async (p) => {
  await tab(p, "Models");
  await p.locator(".local-toggle").click();
  await p.locator(".local-toggle").scrollIntoViewIfNeeded();
});
await shot(
  "panel-connectors-reminders-on",
  PANEL,
  scenario({
    reminders: {
      supported: true,
      access: "full",
      enabled: true,
      include_notes: false,
      list: { id: "l1", title: "TodoCity", source: "iCloud", icloud: true, leaves_mac: true, writable: true },
      linked: 12,
      last_sync: new Date().toISOString(),
      last_error: null,
    },
  }),
  async (p) => {
    await tab(p, "Connectors");
    await p.locator(".connector", { hasText: "Apple Reminders" }).locator(".connector-action").click();
  },
);
await shot("panel-update-downloading", PANEL, scenario({ update: { state: "downloading", version: "0.4.5", percent: 40 } }), async (p) => {
  if (await p.locator(".update-banner").count()) throw new Error("downloading is quiet");
});
await shot("panel-update-ready", PANEL, scenario({ update: { state: "ready", version: "0.4.5", notes: null } }));
await shot("panel-update-ready-dark", PANEL, scenario({ update: { state: "ready", version: "0.4.5", notes: null } }), async () => {}, true);
const CAPTURED = {
  kind: "text",
  method: "accessibility",
  text: "Hey — can you send the Q3 numbers to Priya by Friday 3pm? Thanks!",
  source: { app: "Slack", bundle: "com.tinyspeck.slackmacgap", url: null },
};
await shot(
  "popover-capture",
  POP,
  scenario({
    label: "popover",
    extract: { task: "Send Q3 numbers to Priya", date_text: "by Friday 3pm", date_confidence: "high" },
  }),
  async (p) => {
    await p.evaluate((c) => window.__emit("capture", c), CAPTURED);
    await p.waitForTimeout(300);
  },
);
await shot(
  "popover-capture-place",
  POP,
  scenario({
    label: "popover",
    extract: { task: "Send Q3 numbers to Priya", date_text: "by Friday 3pm", date_confidence: "high" },
    tasks: RICH_TASKS,
    floors: [
      { project: "Offsite 2026", name: "Travel", open: 1, done: 0 },
      { project: "Offsite 2026", name: "Program", open: 1, done: 0 },
    ],
  }),
  async (p) => {
    await p.evaluate((c) => window.__emit("capture", c), CAPTURED);
    await p.waitForTimeout(300);
    await p.locator(".capture .add-place select").first().selectOption("Offsite 2026");
    const floors = await p.locator(".capture .add-place select").nth(1).locator("option").allTextContents();
    if (!floors.includes("Travel")) throw new Error(`the floor list doesn't follow the project: ${floors.join(", ")}`);
    await p.locator(".capture .add-place select").nth(1).selectOption("Travel");
  },
);
await shot("popover-capture-reading", POP, scenario({ label: "popover", extract: "pending" }), async (p) => {
  await p.evaluate((c) => window.__emit("capture", c), CAPTURED);
});
await shot(
  "popover-capture-dark",
  POP,
  scenario({
    label: "popover",
    extract: { task: "Send Q3 numbers to Priya", date_text: "by Friday 3pm", date_confidence: "high" },
  }),
  async (p) => {
    await p.evaluate((c) => window.__emit("capture", c), CAPTURED);
    await p.waitForTimeout(300);
  },
  true,
);
const EV_DAY = day(0);
const CAL_ON = { supported: true, access: "full", enabled: true, hidden: ["Other / Birthdays"] };
const EVENTS = [
  { id: "e0", title: "Office closed (half day)", start: `${EV_DAY}T00:00:00`, end: `${day(1)}T00:00:00`, all_day: true, calendar: "Work", color: "#3b82f6" },
  { id: "e1", title: "Standup", start: `${EV_DAY}T09:30:00`, end: `${EV_DAY}T09:45:00`, all_day: false, calendar: "Work", color: "#3b82f6" },
  { id: "e2", title: "Design review with Priya", start: `${EV_DAY}T13:00:00`, end: `${EV_DAY}T14:00:00`, all_day: false, calendar: "Work", color: "#3b82f6" },
  { id: "h1", title: "Veterans Day", start: `${day(2)}T00:00:00`, end: `${day(3)}T00:00:00`, all_day: true, calendar: "US Holidays", color: "#7c3aed" },
  { id: "e3", title: "Pick up groceries", start: `${EV_DAY}T18:00:00`, end: `${EV_DAY}T18:30:00`, all_day: false, calendar: "Home", color: "#16a34a" },
];
await shot("panel-connectors", PANEL, scenario(), async (p) => {
  await tab(p, "Connectors");
});
const SYNC_BASE = {
  on: false,
  name: "Sam's MacBook Air",
  devices: [],
  local_only: [],
  last_ok: null,
  error: null,
  busy: false,
  pending: 0,
  removed_notice: false,
  pairing: null,
};
const SYNC_ON = {
  ...SYNC_BASE,
  on: true,
  devices: [
    { id: "me", name: "Sam's MacBook Air", me: true, last_seen: null },
    { id: "work", name: "Work MacBook Pro", me: false, last_seen: new Date(Date.now() - 4 * 60_000).toISOString() },
  ],
  local_only: ["Offsite 2026"],
  last_ok: new Date(Date.now() - 30_000).toISOString(),
};
const syncOpen = async (p) => {
  await tab(p, "Your other Macs");
};
await shot("panel-connectors-sync", PANEL, scenario({ sync: SYNC_BASE }), syncOpen);
await shot(
  "panel-connectors-sync-code",
  PANEL,
  scenario({ sync: { ...SYNC_BASE, on: true, pairing: { role: "host", code: "K7MX-4QRB", stage: "waiting", sas: null, confirmed: false, error: null } } }),
  async (p) => await tab(p, "Your other Macs"),
);
const SYNC_COMPARE = { ...SYNC_BASE, pairing: { role: "join", code: "K7MX-4QRB", stage: "compare", sas: "482 913", confirmed: false, error: null } };
await shot("panel-connectors-sync-compare", PANEL, scenario({ sync: SYNC_COMPARE }), async (p) => await tab(p, "Your other Macs"));
await shot("panel-connectors-sync-compare-dark", PANEL, scenario({ sync: SYNC_COMPARE }), async (p) => await tab(p, "Your other Macs"), true);
await shot("panel-connectors-sync-on", PANEL, scenario({ sync: SYNC_ON }), async (p) => {
  await syncOpen(p);
  await p.locator(".connector-subhead", { hasText: "Your Macs" }).scrollIntoViewIfNeeded();
});
await shot("panel-connectors-sync-local", PANEL, scenario({ sync: SYNC_ON, tasks: RICH_TASKS }), async (p) => {
  await syncOpen(p);
  await p.locator(".sync-leave").scrollIntoViewIfNeeded();
});
await shot("panel-connectors-sync-join", PANEL, scenario({ sync: SYNC_BASE }), async (p) => {
  await syncOpen(p);
  await p.getByRole("button", { name: "I have a code" }).click();
  await p.locator("#sync-code").fill("k7mx-4qrb");
});
await shot("panel-connectors-calendar", PANEL, scenario({ calendar: CAL_ON }), async (p) => {
  await tab(p, "Connectors");
  await p.locator(".connector", { hasText: "Apple Calendar" }).locator(".connector-action").click();
});
await shot("panel-connectors-reminders", PANEL, scenario(), async (p) => {
  await tab(p, "Connectors");
  await p.locator(".connector", { hasText: "Apple Reminders" }).locator(".connector-action").click();
});
await shot("popover-events", POP, scenario({ label: "popover", calendar: CAL_ON, events: EVENTS }));
await shot("popover-events-dark", POP, scenario({ label: "popover", calendar: CAL_ON, events: EVENTS }), async () => {}, true);
await shot("panel-empty", PANEL, scenario({ tasks: [] }));
await shot("panel-whats-new", PANEL, scenario({ settings: { ...SETTINGS, seen_version: "0.1.6" } }));
await shot("popover", POP, scenario({ label: "popover" }));
await shot("popover-dark", POP, scenario({ label: "popover" }), async () => {}, true);
await shot("popover-drag", POP, scenario({ label: "popover" }), async (p) => {
  const row = p.locator(".pop-row").nth(1);
  const box = await row.boundingBox();
  const target = await p.locator(".pop-day").nth(12).boundingBox();
  await p.mouse.move(box.x + 60, box.y + 12);
  await p.mouse.down();
  await p.mouse.move(box.x + 80, box.y - 20, { steps: 4 });
  await p.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
});
await shot("popover-add", POP, scenario({ label: "popover" }), async (p) => {
  await p.locator(".pop-quick input").click();
  await p.keyboard.type("dentist fri 3pm");
});
await shot("popover-add-description", POP, scenario({ label: "popover" }), async (p) => {
  await p.locator(".pop-quick input").click();
  await p.keyboard.type("Send the Q3 deck to Priya fri 3pm @Offsite");
});
await shot("panel-add-task", PANEL, scenario(), async (p) => {
  await p.getByRole("button", { name: "Add a task", exact: true }).click();
  await p.keyboard.type("Book flights for the offsite next tue");
  await p.locator(".tfc-notes").click();
  await p.keyboard.type("Team of 6, window seats if possible");
});
const focus = (f) => async (p) => {
  await p.waitForTimeout(200);
  await p.evaluate((x) => window.__emit("popover-focus", x), f);
  await p.waitForTimeout(400);
};
await shot("popover-focus-due", POP, scenario({ label: "popover" }), focus({ kind: "due", ids: [TASKS[0].id] }));
await shot(
  "popover-focus-due-dark",
  POP,
  scenario({ label: "popover" }),
  focus({ kind: "due", ids: [TASKS[0].id, TASKS[2].id] }),
  true,
);
const UNDATED = [
  ...TASKS,
  task("Look into the flaky login test #work", { source_app: "Slack" }),
  task("Get a quote for the bike service"),
  task("Draft the offsite agenda #work"),
];
await shot("popover-focus-undated", POP, scenario({ label: "popover", tasks: UNDATED }), focus({ kind: "undated" }));
await shot(
  "popover-focus-undated-dark",
  POP,
  scenario({ label: "popover", tasks: UNDATED, settings: { ...SETTINGS, theme: "dark" } }),
  focus({ kind: "undated" }),
);
const INBOX = [
  { id: 1, title: "Send the Q3 deck to Priya", due_date: day(1), due_time: "15:00", notes: "She asked for the version with the regional breakdown.", agent: "Claude", received_at: localStamp(0), date_text: null, source: "agent" },
  { id: 2, title: "Book flights for the Austin offsite", due_date: day(4), due_time: null, notes: null, agent: "Claude", received_at: localStamp(0), date_text: null, source: "agent" },
];
const NOTICED = [
  { id: 7, title: "Send Dana the rollout checklist", due_date: null, due_time: null, notes: "Noticed in Slack · #launch", agent: "Slack", received_at: localStamp(0), date_text: "by Friday", source: "watch" },
  { id: 8, title: "Review the pricing doc", due_date: null, due_time: null, notes: "Noticed in Slack · Priya Shah", agent: "Slack", received_at: localStamp(0), date_text: "tomorrow 3pm", source: "watch" },
];
await shot("popover-focus-noticed", POP, scenario({ label: "popover", inbox: NOTICED }), focus({ kind: "inbox" }));
await shot("popover-noticed-banner", POP, scenario({ label: "popover", inbox: NOTICED }));
const WATCH_ON = {
  supported: true,
  default_name: "Sam Rivera",
  model: "qwen3.5-4b",
  settings: { ...SETTINGS.watch, enabled: true, reader: "claude", excluded: ["com.spotify.client"], names: { "*": "Sam Rivera; Rivera, Sam" } },
  readers: [
    { id: "claude", name: "Claude Code", installed: true, connected: true },
    { id: "codex", name: "Codex", installed: true, connected: true },
    { id: "antigravity", name: "Antigravity CLI", installed: false, connected: false },
    { id: "gemini", name: "Gemini CLI", installed: false, connected: false },
    { id: "cursor", name: "Cursor Agent", installed: true, connected: false },
  ],
  always_skipped: [["com.1password.1password", "1Password"]],
  live: {
    state: "watching",
    current: "Slack",
    last_found: null,
    last_look: { app: "Slack", at: "15:58:12", lines: 214, new: 3, asked: true, found: 1, step: "suggested" },
    recent: [
      { bundle: "com.tinyspeck.slackmacgap", name: "Slack", skipped: false },
      { bundle: "com.google.Chrome", name: "Google Chrome", skipped: false },
      { bundle: "com.microsoft.Outlook", name: "Microsoft Outlook", skipped: false },
      { bundle: "com.spotify.client", name: "Spotify", skipped: true },
    ],
  },
};
await shot("panel-watch", PANEL, scenario({ watch: WATCH_ON }), async (p) => {
  await tab(p, "Watch");
  const send = p.getByRole("combobox", { name: "Send to" });
  if ((await send.inputValue()) !== "claude") throw new Error("Watch sends to Claude Code");
  const options = await send.locator("option").allTextContents();
  // Only connected agents, then the open model.
  if (options.join("|") !== "Claude Code|Codex|Open model on this Mac") throw new Error(`options: ${options.join("|")}`);
});
await shot("panel-watch-names", PANEL, scenario({ watch: WATCH_ON }), async (p) => {
  await tab(p, "Watch");
  await p.locator(".set-subhead", { hasText: "Apps" }).scrollIntoViewIfNeeded();
});
await shot("popover-focus-inbox", POP, scenario({ label: "popover", inbox: INBOX }), focus({ kind: "inbox" }));
await shot("popover-focus-inbox-dark", POP, scenario({ label: "popover", inbox: INBOX }), focus({ kind: "inbox" }), true);
await shot("popover-inbox-banner", POP, scenario({ label: "popover", inbox: INBOX }));
const POP_AGENT = [0, 1, 2].map((i) => ({
  id: 200 + i,
  at: localStamp(-8),
  agent: "Claude",
  batch: "pop1",
  task_id: TASKS[i].id,
  kind: "scheduled",
  title: TASKS[i].title,
  summary: "Time set",
  undone: false,
}));
await shot("popover-agent-note", POP, scenario({ label: "popover", activity: POP_AGENT }), async (p) => {
  await p.locator(".pop-agent-note", { hasText: "Timed 3 tasks." }).waitFor();
});
await shot("popover-agent-note-undo", POP, scenario({ label: "popover", activity: POP_AGENT }), async (p) => {
  await p.locator(".pop-agent-note").getByRole("button", { name: "Undo" }).click();
  await p.waitForFunction(() => window.__agentUndo?.batch === "pop1");
  await p.locator(".pop-agent-note").waitFor({ state: "detached" });
});

const AGENTS_ON = {
  ...AGENT_STATUS,
  enabled: true,
  apps: AGENT_STATUS.apps.map((a) => (a.id === "claude_code" ? { ...a, connected: true } : a)),
};
await shot("panel-connectors-agents", PANEL, scenario({ agents: AGENTS_ON }), async (p) => {
  await tab(p, "Agents");
  await p.locator(".set-subhead", { hasText: "Your agents" }).scrollIntoViewIfNeeded();
});
// v0.4.69: email to tasks is gone; Watch covers it.
await shot("panel-agents-no-email", PANEL, scenario({ agents: AGENTS_ON }), async (p) => {
  await tab(p, "Agents");
  await p.locator(".set-subhead", { hasText: "Your agents" }).scrollIntoViewIfNeeded();
  if (await p.getByText("Email to tasks").count()) throw new Error("Email to tasks still shows");
});
await shot("panel-connectors-agents-tested", PANEL, scenario({ agents: AGENTS_ON }), async (p) => {
  await tab(p, "Agents");
  await p.getByText("More: another app, or test the connection").click();
  await p.getByRole("button", { name: "Test the connection" }).click();
  await p.waitForTimeout(200);
  await p.locator(".agent-test").scrollIntoViewIfNeeded();
});
// v0.4.65: tasks an agent deleted come back from Connectors → AI agents.
const AGENTS_FULL = { ...AGENTS_ON, full_access: true };
const DELETED_BY_AGENT = [
  { id: 41, at: localStamp(-50), agent: "Claude", batch: "b9", task_id: 900, kind: "deleted", title: "Old flight reminder", summary: "Deleted", undone: false },
  { id: 42, at: localStamp(-50), agent: "Claude", batch: "b9", task_id: 901, kind: "deleted", title: "Duplicate: Send Q3 numbers", summary: "Deleted", undone: false },
];
await shot("panel-connectors-agents-deleted", PANEL, scenario({ agents: AGENTS_FULL, activity: DELETED_BY_AGENT }), async (p) => {
  await tab(p, "Agents");
  const list = p.locator(".agent-deletes");
  await list.scrollIntoViewIfNeeded();
  await list.getByRole("button", { name: "Bring back" }).first().click();
  await p.waitForFunction(() => window.__agentUndo?.change === 42);
  if ((await list.locator("li").count()) !== 1) throw new Error("brought-back task still listed");
});
// v0.4.64: tasks in Apple Calendar, one calendar per project under Work and Personal.
await shot("panel-connectors-calendar-sync", PANEL, scenario({}), async (p) => {
  await tab(p, "Connectors");
  await p.locator(".connector", { hasText: "Apple Calendar" }).locator(".connector-action").click();
  const sw = p.getByRole("switch", { name: /^Put my tasks in Calendar/ });
  await sw.scrollIntoViewIfNeeded();
  await p.getByRole("combobox", { name: "Account for TodoCity's calendars" }).selectOption("icloud");
  await sw.click();
  await p.waitForTimeout(200);
  if ((await p.evaluate(() => window.__calsyncSource)) !== "icloud") throw new Error("the picked account didn't reach the app");
  const groups = (await p.locator(".calsync-group-name").allTextContents()).map((t) => t.trim());
  if (groups.join("|") !== "TodoCity · Work|TodoCity · Personal") throw new Error(`groups: ${groups.join("|")}`);
  await p.getByRole("checkbox", { name: "Sync every Work project" }).click();
  await p.waitForTimeout(150);
  const work = p.locator(".calsync-group").first().locator(".calsync-lanes input");
  if ((await work.evaluateAll((els) => els.filter((e) => e.checked).length)) !== 0) throw new Error("turning off Work didn't turn off its projects");
  await p.locator(".calsync-lead").scrollIntoViewIfNeeded();
});
// v0.4.69: the follow-up switches show only once agents are on.
await shot("panel-agents-off", PANEL, scenario(), async (p) => {
  await tab(p, "Agents");
  await p.getByRole("switch", { name: /^Agents can add tasks/ }).waitFor();
  if (await p.getByRole("switch", { name: /^Full access/ }).count()) throw new Error("Full access shows only with agents on");
});
// v0.4.63: full access for agents, behind one switch.
await shot("panel-connectors-agents-full", PANEL, scenario({ agents: AGENTS_ON }), async (p) => {
  await tab(p, "Agents");
  const sw = p.getByRole("switch", { name: /^Full access/ });
  await sw.scrollIntoViewIfNeeded();
  if (await sw.isChecked()) throw new Error("Full access should start off");
  await sw.click();
  await p.waitForTimeout(200);
  if (!(await p.evaluate(() => window.__fullAccess))) throw new Error("turning on Full access didn't reach the app");
  await p.getByRole("button", { name: "About Full access" }).hover();
  await p.getByRole("tooltip", { name: /30 tools/ }).waitFor();
  if (await p.getByText(/never (read|see)/i).count()) throw new Error("an old 'never read' claim is still showing");
});
await shot("quick-empty", QUICK, scenario({ label: "quick" }));
await shot("quick-typed", QUICK, scenario({ label: "quick" }), async (p) => {
  await p.keyboard.type("pay rent friday 5pm every month #home");
});
await shot("quick-typed-dark", QUICK, scenario({ label: "quick" }), async (p) => {
  await p.keyboard.type("call mom tomorrow 6pm");
}, true);

// ── Full screen ─────────────────────────────────────────────────────────────
const FULL = { width: 1440, height: 900 };
const FULL_TASKS = [
  ...RICH_TASKS,
  task("Wrap up the launch notes #work", { due_date: day(0), due_time: "12:00", project: "Q4 launch" }),
  task("Draft the offsite agenda", { due_date: day(0), due_time: "10:00", project: "Offsite 2026", heading: "Program" }),
  task("Final pricing page copy", { due_date: day(2), due_time: "11:00", deadline: day(3), project: "Q4 launch" }),
  task("1:1 prep for Maya", { due_date: day(1), due_time: "15:00" }),
  task("Accessibility pass", { project: "Q4 launch" }),
  task("Order a new desk chair"),
];
const FULL_EVENTS = [
  ...PLAN_EVENTS,
  { id: "e4", title: "Lunch with Sam", start: `${day(1)}T12:00:00`, end: `${day(1)}T13:00:00`, all_day: false, calendar: "Home", color: "#16a34a" },
  { id: "e5", title: "Launch rehearsal", start: `${day(3)}T15:00:00`, end: `${day(3)}T16:30:00`, all_day: false, calendar: "Work", color: "#3b82f6" },
];
// The city: finished tasks over the last two months, more on some projects.
const CITY_WINDOWS = (() => {
  const out = [];
  const projects = [["Q4 launch", 58], ["Hiring", 40], ["Offsite 2026", 31], [null, 26], ["Taxes 2026", 22], ["Home", 14], ["Reading list", 6]];
  let n = 5000;
  for (const [project, count] of projects) {
    for (let i = 0; i < count; i++) {
      const daysAgo = Math.floor(((i * 7919) % 60) * (i < count * 0.2 ? 0.1 : 1));
      const d = new Date();
      d.setDate(d.getDate() - daysAgo);
      d.setHours(9 + (i % 9), (i * 13) % 60, 0, 0);
      const heading = project === "Offsite 2026" ? (i % 3 ? "Travel" : "Program") : project === "Q4 launch" ? ["Design", "Launch day", "Design", "Docs"][i % 4] : null;
      out.push({ id: n++, title: `${project ?? "Errand"} task ${i + 1}`, project, heading, completed_at: d.toISOString() });
    }
  }
  out.push({ id: n++, title: "Sent Q3 numbers to Priya", project: "Q4 launch", heading: "Docs", completed_at: new Date().toISOString() });
  return out.sort((a, b) => a.completed_at.localeCompare(b.completed_at));
})();
const FULL_FLOORS = [{ project: "Garden reno", name: "Beds", open: 0, done: 0 }];
const full = (o = {}) =>
  scenario({ tasks: FULL_TASKS, logbook: LOGBOOK, events: FULL_EVENTS, calendar: CAL_ON, full: true, cityWindows: CITY_WINDOWS, floors: FULL_FLOORS, ...o });
const DARK = { ...SETTINGS, theme: "dark" };
const LIGHT = { ...SETTINGS, theme: "light" };
const side = (name) => async (p) => {
  await p.locator(".sidebar button:not(.sb-chev)").filter({ hasText: name }).first().click();
  await p.waitForTimeout(250);
};
await shot("full-today", FULL, full({ settings: DARK }));
await shot("full-today-light", FULL, full({ settings: LIGHT }));
// v0.4.65: You · All · Agents. Claude timed two tasks and added one.
const BY_CLAUDE = { agent: "Claude", agent_at: localStamp(-20) };
const AGENT_PICKS = FULL_TASKS.filter((t) => t.due_date === day(0) && !t.done && !t.project).slice(0, 2).map((t) => t.id)
  .concat(FULL_TASKS.filter((t) => t.title === "Draft the offsite agenda").map((t) => t.id));
const AGENT_FULL_TASKS = FULL_TASKS.map((t) => (AGENT_PICKS.includes(t.id) ? { ...t, ...BY_CLAUDE } : t));
const AGENT_ACTIVITY = AGENT_FULL_TASKS.filter((t) => t.agent).map((t, i) => ({
  id: 100 + i,
  at: localStamp(-20),
  agent: "Claude",
  batch: "plan1",
  task_id: t.id,
  kind: i === 2 ? "added" : "scheduled",
  title: t.title,
  summary: i === 2 ? "Added" : "Time set",
  undone: false,
}));
const agentsFull = (o = {}) => full({ tasks: AGENT_FULL_TASKS, activity: AGENT_ACTIVITY, agents: { ...AGENT_STATUS, enabled: true, full_access: true }, ...o });
// v0.4.69: whose tasks is in the header's View menu, not a switch.
const VIEW_LABEL = { You: "Only mine", All: "Everything", Agents: "Changed by agents" };
const who = (name) => async (p) => {
  await p.getByRole("button", { name: "View options" }).click();
  await p.getByRole("menuitemradio", { name: new RegExp(`^${VIEW_LABEL[name]}`) }).click();
  await p.waitForTimeout(250);
};
const boardView = async (p) => {
  await p.getByRole("button", { name: "View options" }).click();
  await p.getByRole("menuitemradio", { name: "Board" }).click();
};
await shot("full-who-all", FULL, agentsFull({ settings: LIGHT }), async (p) => {
  if ((await p.locator(".task.by-agent").count()) < 2) throw new Error("agent tasks not marked");
  if (!(await p.locator(".task:not(.by-agent)").count())) throw new Error("All shows your tasks too");
  await p.locator(".agent-mark", { hasText: "Scheduled by Claude" }).first().waitFor();
});
await shot("full-who-agents", FULL, agentsFull({ settings: LIGHT }), async (p) => {
  await who("Agents")(p);
  await p.locator(".who-chip", { hasText: "Changed by agents" }).waitFor();
  await p.locator(".agents-banner", { hasText: "Claude" }).waitFor();
  if (await p.locator(".task:not(.by-agent)").count()) throw new Error("Agents shows only agents' tasks");
  await p.locator(".agent-undo").first().waitFor();
});
await shot("full-who-agents-dark", FULL, agentsFull({ settings: DARK }), async (p) => {
  await who("Agents")(p);
}, true);
await shot("full-who-agents-undo", FULL, agentsFull({ settings: LIGHT }), async (p) => {
  await who("Agents")(p);
  await p.locator(".agents-banner").getByRole("button", { name: "Undo all" }).click();
  await p.waitForFunction(() => window.__agentUndo?.tasks?.length >= 2);
  await p.waitForTimeout(300);
});
await shot("full-who-you", FULL, agentsFull({ settings: LIGHT }), async (p) => {
  await who("You")(p);
  if (await p.locator(".task.by-agent").count()) throw new Error("You hides agents' tasks");
  await p.locator(".who-hint").waitFor();
});
// v0.4.68: Watch sends to a connected agent.
await shot("full-watch-info", FULL, full({ settings: LIGHT, watch: WATCH_ON }), async (p) => {
  await p.locator(".sidebar").getByRole("button", { name: /^Settings/ }).click();
  await tab(p, "Watch");
  await p.getByRole("button", { name: "About where Watch sends" }).hover();
  await p.getByRole("tooltip", { name: /go to Claude Code/ }).waitFor();
});
await shot("full-watch-no-agents", FULL, full({ settings: LIGHT, watch: { ...WATCH_ON, settings: { ...WATCH_ON.settings, reader: "local" }, readers: WATCH_ON.readers.map((r) => ({ ...r, connected: false })) } }), async (p) => {
  await p.locator(".sidebar").getByRole("button", { name: /^Settings/ }).click();
  await tab(p, "Watch");
  await p.getByText("Connect an agent to send Watch to it.").waitFor();
  await p.locator(".watch-page").getByRole("button", { name: "Agents", exact: true }).click();
  await p.locator(".set-subhead", { hasText: "Your agents" }).waitFor();
});
// v0.4.66: the agent panel, and tasks sent to agents.
const TODAY_OPEN = FULL_TASKS.filter((t) => t.due_date === day(0) && !t.done);
const RUN_WORKING = FULL_TASKS.find((t) => t.title.startsWith("Wrap up the launch notes"));
const RUN_READY = FULL_TASKS.find((t) => t.title === "Draft the offsite agenda");
const RUN_ASKING = TODAY_OPEN.find((t) => t !== RUN_WORKING && t !== RUN_READY);
const runOf = (t, id, agent, agent_name, status, extra = {}) => ({
  id,
  task_id: t.id,
  agent,
  agent_name,
  folder: "/Users/sam/Projects/website",
  status,
  summary: null,
  links: [],
  started_at: localStamp(-30),
  updated_at: localStamp(-2),
  session: null,
  tail: null,
  has_transcript: false,
  ...extra,
});
const RUNS = [
  runOf(RUN_WORKING, 1, "claude", "Claude Code", "working", { session: 1 }),
  runOf(RUN_READY, 2, "codex", "Codex", "ready", {
    summary: "Drafted the agenda: welcome, two workshops and a closing talk, with times. It's in docs/offsite-agenda.md for you to look over.",
    links: ["https://github.com/example/offsite/pull/42"],
  }),
  runOf(RUN_ASKING, 3, "claude", "Claude Code", "needs_you", { summary: "Should the summary go to the whole team or just Priya?", session: 2 }),
];
const TERM_SAMPLE =
  "\x1b[38;5;173m✻\x1b[0m Welcome to \x1b[1mClaude Code\x1b[0m\r\n\r\n  cwd: ~/Projects/website\r\n\r\n" +
  "\x1b[90m> Work on this task from my TodoCity to-do list.\x1b[0m\r\n\r\n" +
  "● Reading docs/launch-notes.md\r\n● Found 4 open items; drafting the wrap-up.\r\n" +
  "\x1b[32m✓\x1b[0m Updated docs/launch-notes.md\r\n\x1b[32m✓\x1b[0m todocity · report_progress (working)\r\n\r\n" +
  "\x1b[38;5;173m✻\x1b[0m Summarising the launch metrics…\r\n";
const TERMS = [
  { id: 1, agent: "claude", name: "Claude Code", title: RUN_WORKING.title, folder: "/Users/sam/Projects/website", task_id: RUN_WORKING.id, run_id: 1, alive: true },
  { id: 2, agent: "claude", name: "Claude Code", title: RUN_ASKING.title, folder: "/Users/sam/Projects/website", task_id: RUN_ASKING.id, run_id: 3, alive: true },
];
const TRANSCRIPT = [
  "Welcome to Codex",
  "",
  "> Work on this task from my TodoCity to-do list.",
  "",
  "Reading docs/offsite-notes.md and last year's agenda",
  "Drafting: welcome (9:30), workshops (10:00, 13:30), closing talk (16:00)",
  "Wrote docs/offsite-agenda.md",
  "git checkout -b offsite-agenda && git commit -m \"Offsite agenda draft\"",
  "Opened pull request #42",
  "todocity · report_progress (done)",
].join("\n");
const RUNS_KEPT = RUNS.map((r) => (r.id === 2 ? { ...r, has_transcript: true } : r));
const runsFull = (o = {}) =>
  agentsFull({ runs: RUNS_KEPT, terms: TERMS, termOutput: { 1: TERM_SAMPLE, 2: TERM_SAMPLE }, transcripts: { 2: TRANSCRIPT }, ...o });
const openAgents = async (p) => {
  await p.getByRole("button", { name: "Show agents" }).click();
  await p.locator(".agent-pane").waitFor();
  await p.waitForTimeout(300);
};
await shot("full-agents-panel", FULL, runsFull({ settings: LIGHT }), async (p) => {
  await p.locator(".run-pill", { hasText: "Claude Code is working" }).first().waitFor();
  await p.locator(".run-pill", { hasText: "Ready to review" }).first().waitFor();
  await p.locator(".run-pill", { hasText: "Claude Code needs you" }).first().waitFor();
  await openAgents(p);
  await p.locator(".term-view .xterm").waitFor();
  if ((await p.locator(".ap-tab").count()) !== 2) throw new Error("both sessions have tabs");
});
await shot("full-agents-panel-dark", FULL, runsFull({ settings: DARK }), openAgents, true);
await shot("full-agents-empty", FULL, agentsFull({ settings: LIGHT }), async (p) => {
  await openAgents(p);
  await p.locator(".ap-empty").waitFor();
  await p.locator(".ap-prompts button", { hasText: "Plan my day" }).click();
  await p.waitForFunction(() => window.__termStart?.agent === "claude" && /plan my day/i.test(window.__termStart?.prompt ?? ""));
  await p.locator(".term-view .xterm").waitFor();
});
await shot("full-agents-send", FULL, agentsFull({ settings: LIGHT }), async (p) => {
  await p.locator(".task .task-row", { hasText: "Wrap up the launch notes" }).first().click();
  await p.waitForTimeout(200);
  await p.getByRole("button", { name: "More", exact: true }).first().click();
  await p.getByRole("menuitem", { name: /Send to agent/ }).click();
  await p.locator(".send-dialog").waitFor();
  await p.getByRole("radio", { name: "Codex" }).click();
  await p.locator(".send-dialog textarea").fill("Open a pull request when the tests pass.");
});
await shot("full-agents-send-started", FULL, agentsFull({ settings: LIGHT }), async (p) => {
  await p.locator(".task .task-row", { hasText: "Wrap up the launch notes" }).first().click();
  await p.waitForTimeout(200);
  await p.getByRole("button", { name: "More", exact: true }).first().click();
  await p.getByRole("menuitem", { name: /Send to agent/ }).click();
  await p.locator(".send-dialog").getByRole("button", { name: /^Start/ }).click();
  await p.waitForFunction(() => window.__termStart?.taskId > 0 && window.__termStart?.folder);
  await p.locator(".agent-pane .term-view").waitFor();
  await p.locator(".run-pill", { hasText: "is working" }).first().waitFor();
});
await shot("full-agents-review", FULL, runsFull({ settings: LIGHT }), async (p) => {
  await p.locator(".task .task-row", { hasText: "Draft the offsite agenda" }).first().click();
  await p.locator(".run-card.ready").waitFor();
  await p.locator(".run-card").getByRole("button", { name: "Mark done" }).waitFor();
  await p.locator(".run-card").getByRole("button", { name: "Send back with a note" }).click();
  await p.locator(".run-note textarea").fill("Add a 15-minute break after lunch.");
});
await shot("full-agents-answer", FULL, runsFull({ settings: DARK }), async (p) => {
  await p.locator(".task .task-row", { hasText: RUN_ASKING.title }).first().click();
  await p.locator(".run-card.needs_you").waitFor();
  await p.locator(".run-card").getByRole("button", { name: "Answer" }).click();
  await p.locator(".run-note textarea").fill("Just Priya for now.");
  await p.locator(".run-card").getByRole("button", { name: /^Send to Claude Code/ }).click();
  await p.waitForFunction(() => (window.__termWrites ?? []).some((w) => w.id === 2 && w.data === "Just Priya for now.\r"));
}, true);
// v0.4.67: delegate from a task's line, With agents, and what the agent did.
await shot("full-agents-list", FULL, runsFull({ settings: LIGHT }), async (p) => {
  await side("With agents")(p);
  for (const g of ["Needs you", "Ready to review", "Working"]) await p.locator(".group-title, h2, h3", { hasText: g }).first().waitFor();
  if ((await p.locator(".task").count()) !== 3) throw new Error("only tasks with agents");
  if (await p.locator(".day-action", { hasText: "Move to today" }).count()) throw new Error("no Move all on Needs you");
});
await shot("full-agents-list-dark", FULL, runsFull({ settings: DARK }), side("With agents"), true);
await shot("full-agents-row-button", FULL, agentsFull({ settings: LIGHT }), async (p) => {
  const row = p.locator(".task", { hasText: "Wrap up the launch notes" }).first();
  await row.hover();
  await row.getByRole("button", { name: "Send to agent" }).waitFor();
});
await shot("full-agents-row-send", FULL, agentsFull({ settings: LIGHT }), async (p) => {
  const row = p.locator(".task", { hasText: "Book flights" }).first();
  await row.hover();
  await row.getByRole("button", { name: "Send to agent" }).click();
  await p.locator(".send-dialog", { hasText: "Book flights" }).waitFor();
  // Return starts it: the Start button has the focus (once the agents have loaded).
  await p.waitForFunction(() => /^Start/.test(document.activeElement?.textContent ?? ""));
  await p.keyboard.press("Enter");
  await p.waitForFunction(() => window.__termStart?.taskId > 0);
  await p.locator(".run-pill", { hasText: "is working" }).first().waitFor();
});
await shot("full-agents-transcript", FULL, runsFull({ settings: LIGHT }), async (p) => {
  await p.locator(".task .task-row", { hasText: "Draft the offsite agenda" }).first().click();
  await p.locator(".run-card").getByRole("button", { name: "What it did" }).click();
  await p.locator(".transcript", { hasText: "Opened pull request #42" }).waitFor();
});
await shot("full-agents-tail", FULL, runsFull({
  settings: DARK,
  runs: RUNS.map((r) => (r.id === 3 ? { ...r, status: "paused", summary: null, session: null, has_transcript: true, tail: "Read the Q3 numbers sheet\nDrafted the email to Priya\nWaiting for which numbers to include" } : r)),
}), async (p) => {
  await p.locator(".task .task-row", { hasText: RUN_ASKING.title }).first().click();
  await p.locator(".run-tail", { hasText: "Drafted the email to Priya" }).waitFor();
  await p.locator(".run-card").getByRole("button", { name: "Continue" }).waitFor();
}, true);
await shot("panel-agents-row-button", PANEL, scenario(), async (p) => {
  const row = p.locator(".task").nth(1);
  await row.hover();
  await row.getByRole("button", { name: "Send to agent" }).waitFor();
});
await shot("panel-agents-pill", PANEL, scenario({ runs: [runOf(TASKS.find((t) => t.due_date === day(0) && !t.done), 1, "claude", "Claude Code", "working")] }), async (p) => {
  await p.locator(".run-pill", { hasText: "Claude Code is working" }).first().waitFor();
});
// v0.4.69: with agents off, the header has no View button on Today and
// "With agents" offers to set them up.
await shot("full-who-setup", FULL, full({ settings: LIGHT, tasks: AGENT_FULL_TASKS }), async (p) => {
  if (await p.getByRole("button", { name: "View options" }).count()) throw new Error("no View button on Today with agents off");
  if (await p.locator(".agent-mark").count()) throw new Error("no agent marks while agents are off");
});
await shot("full-who-setup-go", FULL, full({ settings: LIGHT, runs: [] }), async (p) => {
  await p.evaluate(() => localStorage.setItem("todocity.list", "agents"));
  await p.reload();
  await p.getByRole("button", { name: "Let AI apps add and plan tasks" }).click();
  await p.getByRole("button", { name: "Set up AI agents" }).click();
  await p.locator(".set-subhead", { hasText: "Your agents" }).waitFor();
});

// Modes: the work laptop in Work mode shows only work projects.
const WORK_MODES = [
  MODE("work", "Work", "💼", { projects: ["Hiring", "Q4 launch"] }),
  MODE("personal", "Personal", "🏠", { new_projects: true, projects: ["Hiring", "Q4 launch"] }),
  MODE("study", "Study", "📚", { projects: ["Reading list"], no_project: false }),
];
const IN_WORK = { ...LIGHT, modes: WORK_MODES, mode: "work" };
await shot("full-mode-work", FULL, full({ settings: IN_WORK }));
await shot("full-mode-work-dark", FULL, full({ settings: { ...IN_WORK, theme: "dark" } }), async () => {}, true);
await shot("full-mode-menu", FULL, full({ settings: IN_WORK }), async (p) => {
  await p.locator(".mode-switch.mode-side .mode-btn").click();
});
await shot("full-mode-others", FULL, full({ settings: IN_WORK }), async (p) => {
  await p.locator(".sb-others").click();
});
await shot("full-mode-quiet", FULL, full({ settings: IN_WORK }), async (p) => {
  if (await p.locator(".mode-hidden").count()) throw new Error("Today still lists what's outside the mode");
});
await shot("full-mode-switch", FULL, full({ settings: { ...LIGHT, modes: WORK_MODES } }), async (p) => {
  await p.locator(".mode-switch.mode-side .mode-btn").click();
  await p.getByRole("menuitemradio", { name: /Personal/ }).click();
  await p.waitForTimeout(300);
  if (!(await p.locator(".mode-switch.mode-side.on").count())) throw new Error("the mode didn't switch");
});
await shot("full-settings-modes", FULL, full({ settings: IN_WORK }), async (p) => {
  await tab(p, "Modes");
});
await shot("popover-mode", POP, scenario({ label: "popover", settings: IN_WORK, tasks: FULL_TASKS }));
await shot("full-today-hours", FULL, full({ settings: DARK }), async (p) => {
  // Today always shows its hours beside the list; there's no switch any more.
  if (await p.getByRole("radio", { name: "List + Hours" }).count()) throw new Error("the List / List + Hours switch is still there");
  if (!(await p.locator(".mcal").count())) throw new Error("no month calendar on the right");
  // v0.4.69: beside Today, just the week and the hours (the list has the rest).
  if ((await p.locator(".mcal.week-only .mcal-day").count()) !== 7) throw new Error("Today's pane shows one week");
  if (await p.locator(".month-pane .plan-any:not(.slim)").count()) throw new Error("Today's pane repeats the untimed tasks");
});
await shot("full-hints-after-drag", FULL, full({ settings: DARK }), async (p) => {
  await p.evaluate(() => localStorage.setItem("todocity.hint.dragged", "1"));
  await p.reload();
  await p.locator(".mcal").waitFor();
  if (await p.getByText("Drag a task onto an hour").count()) throw new Error("the hint stays after the first drag");
});
await shot("full-overdue", FULL, full({ settings: DARK }), async (p) => {
  await side(/Overdue/)(p);
  if (await p.locator(".due-strip, .full-due").count()) throw new Error("the due bar is still showing in full screen");
});
await shot("full-task-open", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".task .task-row").nth(1).click();
});
await shot("full-task-autosave", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".task .task-row").nth(1).click();
  const title = p.locator(".tfc-title");
  await title.click();
  await title.press("End");
  await p.keyboard.type(" today");
  // Saves while typing, with no Enter and no Save button.
  await p.waitForTimeout(800);
  let ups = await p.evaluate(() => window.__updates ?? []);
  if (!ups.some((u) => (u.patch.title ?? "").endsWith(" today"))) throw new Error(`the title didn't save as typed: ${JSON.stringify(ups)}`);
  // Notes typed and closed straight away with Esc are kept too.
  await p.locator(".task-card .tfc-notes, .task-card .task-notes").first().click();
  await p.waitForTimeout(100);
  await p.keyboard.type("Ask about the budget");
  await p.keyboard.press("Escape");
  await p.waitForTimeout(300);
  ups = await p.evaluate(() => window.__updates ?? []);
  if (!ups.some((u) => (u.patch.notes ?? "").includes("Ask about the budget"))) throw new Error(`notes typed before Esc were lost: ${JSON.stringify(ups)}`);
});
await shot("full-task-open-light", FULL, full({ settings: LIGHT }), async (p) => {
  await p.locator(".task .task-row").nth(1).click();
});
await shot("full-project", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
  // A project opens as a list; Board shows its floors as columns.
  if (await p.locator(".bcol").count()) throw new Error("a project should open as a list");
  await boardView(p);
  await p.locator(".board").waitFor();
  await p.waitForTimeout(300);
  if ((await p.locator(".bcol").count()) < 2) throw new Error("Board didn't show the floors as columns");
  await p.locator(".bcard", { hasText: "Pack for the offsite" }).click();
  await p.locator(".detail-pane").waitFor();
});
await shot("full-when-editor", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".task .task-row").nth(1).click();
  await p.locator(".task.open .tf-chip-main").first().click();
  await p.locator(".tf-menu").waitFor();
});
await shot("full-upcoming", FULL, full({ settings: DARK }), side(/Calendar/));
// v0.4.71: drag a meeting to a new time; it moves in Apple Calendar too.
const MOVE_EVENTS = [
  { id: "m1", title: "Lunch with Sam", start: `${day(1)}T12:00:00`, end: `${day(1)}T13:00:00`, all_day: false, calendar: "Home", color: "#16a34a", movable: "yes" },
  { id: "m2", title: "Roadmap sync", start: `${day(1)}T15:00:00`, end: `${day(1)}T16:00:00`, all_day: false, calendar: "Work", color: "#3b82f6", movable: "everyone" },
  { id: "m3", title: "Vendor call", start: `${day(1)}T10:00:00`, end: `${day(1)}T10:30:00`, all_day: false, calendar: "Work", color: "#8b5cf6", movable: "no" },
];
const dragMeeting = async (p, title, dy, dx = 0) => {
  const block = p.locator(".wg-event", { hasText: title }).first();
  await block.scrollIntoViewIfNeeded();
  const b = await block.boundingBox();
  await p.mouse.move(b.x + b.width / 2, b.y + 8);
  await p.mouse.down();
  await p.mouse.move(b.x + b.width / 2 + dx / 2, b.y + 8 + dy / 2, { steps: 5 });
  await p.mouse.move(b.x + b.width / 2 + dx, b.y + 8 + dy, { steps: 5 });
  await p.waitForTimeout(120);
};
const meetings = (o = {}) => full({ settings: LIGHT, events: MOVE_EVENTS, ...o });
await shot("full-meeting-dragging", FULL, meetings(), async (p) => {
  await side(/Calendar/)(p);
  await dragMeeting(p, "Lunch with Sam", 52);
  await p.locator(".wg-event.lifted", { hasText: "1:00" }).waitFor();
});
await shot("full-meeting-moved", FULL, meetings(), async (p) => {
  await side(/Calendar/)(p);
  await dragMeeting(p, "Lunch with Sam", 52);
  await p.mouse.up();
  await p.waitForFunction(() => window.__moved?.id === "m1");
  const m = await p.evaluate(() => window.__moved);
  if (!m.start.endsWith("T13:00:00") || !m.end.endsWith("T14:00:00") || m.everyone) throw new Error(`moved wrong: ${JSON.stringify(m)}`);
  await p.locator(".toast", { hasText: "Moved “Lunch with Sam”" }).waitFor();
});
await shot("full-meeting-undo", FULL, meetings(), async (p) => {
  await side(/Calendar/)(p);
  await dragMeeting(p, "Lunch with Sam", 52);
  await p.mouse.up();
  await p.locator(".toast", { hasText: "Moved" }).getByRole("button", { name: "Undo" }).click();
  await p.waitForFunction(() => window.__moved?.start?.endsWith("T12:00:00"));
});
await shot("full-meeting-everyone", FULL, meetings(), async (p) => {
  await side(/Calendar/)(p);
  await dragMeeting(p, "Roadmap sync", 26);
  await p.mouse.up();
  await p.getByRole("dialog", { name: "Move “Roadmap sync” for everyone?" }).waitFor();
  if (await p.evaluate(() => window.__moved)) throw new Error("moved before the OK");
});
await shot("full-meeting-everyone-moved", FULL, meetings(), async (p) => {
  await side(/Calendar/)(p);
  await dragMeeting(p, "Roadmap sync", 26);
  await p.mouse.up();
  await p.getByRole("button", { name: "Move for everyone" }).click();
  await p.waitForFunction(() => window.__moved?.id === "m2");
  const m = await p.evaluate(() => window.__moved);
  if (!m.everyone || !m.start.endsWith("T15:30:00")) throw new Error(`moved wrong: ${JSON.stringify(m)}`);
});
await shot("full-meeting-invite-stays", FULL, meetings(), async (p) => {
  await side(/Calendar/)(p);
  await dragMeeting(p, "Vendor call", 52);
  await p.mouse.up();
  await p.waitForTimeout(200);
  if (await p.evaluate(() => window.__moved)) throw new Error("an invite moved");
});
await shot("full-upcoming-light", FULL, full({ settings: LIGHT }), side(/Calendar/));
await shot("full-upcoming-drag", FULL, full({ settings: DARK }), async (p) => {
  await side(/Calendar/)(p);
  const from = await p.locator(".wg-task").first().boundingBox();
  const to = await p.locator(`.wg-cell[data-iso="${day(2)}"][data-hour="16"]`).boundingBox();
  await p.mouse.move(from.x + 30, from.y + 8);
  await p.mouse.down();
  await p.mouse.move(from.x + 60, from.y + 30, { steps: 4 });
  await p.mouse.move(to.x + 30, to.y + 20, { steps: 8 });
  await p.waitForTimeout(150);
});
await shot("full-settings", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".sidebar").getByRole("button", { name: /^Settings/ }).click();
  await p.waitForTimeout(200);
});
for (const [name, page] of [["notifications", "Notifications"], ["capture", "Capture & shortcuts"], ["city", "Your city"], ["sync", "Your other Macs"], ["connectors", "Connectors"], ["agents", "Agents"], ["watch", "Watch"], ["models", "Open models"], ["help", "Help"], ["backups", "Backups & export"]]) {
  await shot(`full-settings-${name}`, FULL, full({ settings: DARK }), async (p) => await tab(p, page));
}
await shot("full-customize", FULL, full({ settings: DARK }), async (p) => {
  await tab(p, "Appearance");
  await p.getByRole("radio", { name: "Green" }).click();
  await p.waitForTimeout(150);
  if ((await p.evaluate(() => document.documentElement.dataset.accent)) !== "green") throw new Error("the accent color didn't change");
});
await shot("full-transfer", FULL, full({ settings: DARK }), async (p) => {
  await openApp(p, "Things 3");
  await p.getByRole("button", { name: "Find my Things library" }).click();
  await p.waitForTimeout(200);
  await p.locator(".tr-list li", { hasText: "Trip to Lisbon" }).locator("input").click();
  const label = await p.locator(".tr-preview .primary").textContent();
  if (label !== "Import 534 to-dos") throw new Error(`move-in count wrong: ${label}`);
});
await shot("full-transfer-todoist", FULL, full({ settings: DARK }), async (p) => {
  await openApp(p, "Todoist");
  await p.getByLabel("Todoist API token").fill("bad-token");
  await p.getByRole("button", { name: "Connect", exact: true }).click();
  await p.locator(".tr-error").waitFor();
  await p.getByLabel("Todoist API token").fill("good-token");
  await p.getByRole("button", { name: "Connect", exact: true }).click();
  await p.locator(".tr-preview").waitFor();
  const label = await p.locator(".tr-preview .primary").textContent();
  if (label !== "Import 381 tasks") throw new Error(`move-in count wrong: ${label}`);
  if ((await p.getByLabel("Todoist API token").count()) !== 0) throw new Error("the token field should be gone after connecting");
});
await shot("full-transfer-todoist-csv", FULL, full({ settings: DARK }), async (p) => {
  await openApp(p, "Todoist");
  await p.getByText("No token? Use CSV files instead").click();
  await p.getByRole("button", { name: "Choose CSV files…" }).click();
  await p.locator(".tr-preview").waitFor();
  if (!(await p.getByRole("switch", { name: /Bring completed tasks/ }).isDisabled())) throw new Error("completed tasks should be off for CSV");
});
await shot("full-transfer-syncing", FULL, full({ settings: DARK, mirror: { things: { since: "2026-10-20T10:00:00Z", last: new Date(Date.now() - 120_000).toISOString(), error: null, projects: 4, two_way: false, can_two_way: false }, todoist: null } }), async (p) => {
  await openApp(p, "Things 3");
  await p.locator(".tr-sync").waitFor();
  const text = await p.locator(".tr-sync").textContent();
  if (!text.includes("Syncing with Things") || !text.includes("2 min ago")) throw new Error(`sync card wrong: ${text}`);
  if (await p.getByRole("button", { name: "Find my Things library" }).count()) throw new Error("the import flow should hide while syncing");
});
await shot("full-transfer-sync-start", FULL, full({ settings: DARK }), async (p) => {
  await openApp(p, "Things 3");
  await p.getByRole("button", { name: "Find my Things library" }).click();
  await p.getByRole("switch", { name: /Keep in sync/ }).waitFor();
  await p.getByRole("button", { name: /^Import \d/ }).click();
  await p.locator(".tr-done", { hasText: "flow in on their own" }).waitFor({ timeout: 5000 });
});
await shot("panel-transfer-done", PANEL, scenario(), async (p) => {
  await openApp(p, "Things 3");
  await p.getByRole("button", { name: "Find my Things library" }).click();
  await p.getByRole("button", { name: /^Import \d/ }).click();
  await p.locator(".tr-done").waitFor();
  if (!(await p.locator(".tr-done").textContent()).includes("543 tasks imported")) throw new Error("done message missing");
});
// v0.4.74: Todoist and Things live in Connectors; Todoist syncs both ways unless set to one-way.
const TODOIST_LINK = { since: "2026-10-20T10:00:00Z", last: new Date(Date.now() - 60_000).toISOString(), error: null, projects: 3, two_way: true, can_two_way: true };
await shot("full-connectors-apps", FULL, full({ settings: DARK, mirror: { things: null, todoist: TODOIST_LINK } }), async (p) => {
  await tab(p, "Connectors");
  const names = await p.locator(".connector-text h3").allTextContents();
  if (names.join("|") !== "Todoist|Things 3|Apple Calendar|Apple Reminders") throw new Error(`cards: ${names.join(", ")}`);
  if (!(await p.locator(".connector", { hasText: "Todoist" }).first().textContent()).includes("in sync both ways")) throw new Error("Todoist card should say both ways");
  if (await p.locator(".set-item", { hasText: "Import Data" }).count()) throw new Error("Import Data page should be gone");
});
await shot("full-connectors-todoist-two-way", FULL, full({ settings: DARK, mirror: { things: null, todoist: TODOIST_LINK } }), async (p) => {
  await openApp(p, "Todoist");
  const sw = p.getByRole("switch", { name: /Two-way sync/ });
  await sw.waitFor();
  if ((await sw.getAttribute("aria-checked")) !== "true") throw new Error("two-way should be on by default");
  if (!(await p.locator(".tr-sync").textContent()).includes("go to Todoist too")) throw new Error("two-way text missing");
});
await shot("full-connectors-todoist-one-way", FULL, full({ settings: DARK, mirror: { things: null, todoist: TODOIST_LINK } }), async (p) => {
  await openApp(p, "Todoist");
  await p.getByRole("switch", { name: /Two-way sync/ }).click();
  await p.waitForTimeout(250);
  if ((await p.getByRole("switch", { name: /Two-way sync/ }).getAttribute("aria-checked")) !== "false") throw new Error("one-way didn't take");
  if (!(await p.locator(".tr-sync").textContent()).includes("Your edits here stay in TodoCity")) throw new Error("one-way text missing");
  if (!(await p.locator(".connector", { hasText: "Todoist" }).first().textContent()).includes("coming in as they change")) throw new Error("card should say one-way");
});
await shot("full-connectors-todoist-howto", FULL, full({ settings: DARK }), async (p) => {
  await openApp(p, "Todoist");
  if (await p.locator(".tr-steps").count()) throw new Error("steps should be behind the (i)");
  await p.getByRole("button", { name: "How to move in" }).hover();
  await p.locator(".info-pop.rich .tr-steps").waitFor();
});
await shot("full-connectors-things-map", FULL, full({ settings: DARK }), async (p) => {
  await openApp(p, "Things 3");
  await p.getByRole("button", { name: "What goes where" }).hover();
  await p.locator(".info-pop.rich .tr-map-table").waitFor();
  if (await p.getByRole("switch", { name: /Two-way sync/ }).count()) throw new Error("Things has no two-way switch yet");
});
await shot("panel-connectors-todoist-done", PANEL, scenario(), async (p) => {
  await openApp(p, "Todoist");
  await p.getByLabel("Todoist API token").fill("good-token");
  await p.getByRole("button", { name: "Connect", exact: true }).click();
  await p.locator(".tr-preview").waitFor();
  if (!(await p.locator(".tr-options").textContent()).includes("Changes go both ways")) throw new Error("keep-in-sync should say both ways");
  await p.getByRole("button", { name: /^Import \d/ }).click();
  await p.locator(".tr-done", { hasText: "in sync both ways" }).waitFor({ timeout: 5000 });
});
await shot("full-compact-blue", FULL, full({ settings: { ...DARK, look: { week_start: "mon", clock: "24", start_list: "last", details: false, accent: "blue", city_sky: "auto", city_motion: true, compact: true } } }), async (p) => {
  if (!(await p.locator(".app-full.compact").count())) throw new Error("compact rows didn't apply");
  if (await p.locator(".task-extra").count()) throw new Error("notes still show under tasks with details off");
  const dow = await p.locator(".mcal-dow").first().textContent();
  if (dow !== "M") throw new Error(`week doesn't start on Monday (${dow})`);
});
await shot("full-search", FULL, full({ settings: DARK }), async (p) => {
  await p.keyboard.press("Meta+k");
  await p.keyboard.type("offsite");
});
await shot("full-no-sidebar", FULL, full({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: "Hide sidebar" }).click();
});
await shot("full-tour", FULL, full({ settings: { ...DARK, onboarding_done: false }, status: { accessibility: true, engine: "bundled", active_model: null, version: "0.4.28", platform: "macos" } }));
await shot("full-setup-banners", FULL, full({ settings: { ...DARK, onboarding_done: true, double_copy: false }, status: { accessibility: false, engine: "bundled", active_model: null, version: "0.4.28", platform: "macos" } }), async (p) => {
  await p.locator(".banner-later").first().waitFor();
});
await shot("full-footer-city-hover", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".ff-city").hover();
});
await shot("full-city", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".ff-city").click();
  await p.waitForTimeout(300);
});
await shot("full-city-light", FULL, full({ settings: LIGHT }), async (p) => {
  await p.locator(".ff-city").click();
  await p.waitForTimeout(300);
});
await shot("full-city-turned", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".ff-city").click();
  const c = await p.locator(".city-view canvas").first().boundingBox();
  await p.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await p.mouse.down();
  await p.mouse.move(c.x + c.width / 2 - 260, c.y + c.height / 2 + 90, { steps: 10 });
  await p.mouse.up();
  await p.mouse.move(c.x + c.width / 2, c.y + c.height / 2 + 40);
  await p.waitForTimeout(200);
});
await shot("full-city-hover", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".ff-city").click();
  const c = await p.locator(".city-view canvas").first().boundingBox();
  await p.mouse.move(c.x + c.width / 2 + 5, c.y + c.height / 2 + 10, { steps: 3 });
});
await shot("full-city-clicked-building", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".ff-city").click();
  const c = await p.locator(".city-view canvas").first().boundingBox();
  await p.mouse.move(c.x + c.width / 2 + 5, c.y + c.height / 2 + 10, { steps: 3 });
  await p.mouse.down();
  await p.mouse.up();
  await p.waitForTimeout(250);
});
await shot("full-city-share", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".ff-city").click();
  await p.locator(".cv-share").click();
  await p.waitForTimeout(300);
});
await shot("full-city-name", FULL, full({ settings: { ...DARK, city_name: null } }), async (p) => {
  await p.locator(".ff-city").click();
  await p.waitForTimeout(300);
});
await shot("full-city-named", FULL, full({ settings: { ...DARK, city_name: null } }), async (p) => {
  await p.locator(".ff-city").click();
  await p.getByRole("button", { name: "Harbor Lights" }).click();
  await p.getByRole("button", { name: "Found the city" }).click();
  await p.waitForTimeout(1200);
  if (!(await p.locator(".cv-name", { hasText: "Harbor Lights" }).count())) throw new Error("the city didn't open after naming it");
});
await shot("full-city-empty", FULL, full({ settings: DARK, cityWindows: [] }));
await shot("full-project-building", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
});
await shot("full-building-floors", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
  await p.getByRole("button", { name: "Show Q4 launch's sections" }).click();
});
await shot("full-add-room", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
  await p.getByRole("button", { name: /^Add Task$/ }).click();
  await p.keyboard.type("Book the venue fri 2pm");
});
const openFloor = async (p) => {
  await side(/Offsite 2026/)(p);
  await p.getByRole("button", { name: "Travel", exact: true }).click();
  await p.waitForTimeout(250);
  if (!(await p.locator(".fh-title", { hasText: /^Travel$/ }).count())) throw new Error("the section's page didn't open");
  if (!(await p.locator(".fh-crumb", { hasText: "Offsite 2026" }).count())) throw new Error("no breadcrumb back to the project");
  if (!(await p.locator(".mcal-scope", { hasText: "Offsite 2026" }).count())) throw new Error("the month isn't narrowed to the floor");
};
await shot("full-floor-page", FULL, full({ settings: DARK }), openFloor);
await shot("full-floor-add", FULL, full({ settings: DARK }), async (p) => {
  await openFloor(p);
  await p.getByRole("button", { name: /^Add Task$/ }).first().click();
  await p.keyboard.type("Book the airport taxi");
});
await shot("full-floor-added", FULL, full({ settings: DARK }), async (p) => {
  await openFloor(p);
  await p.getByRole("button", { name: /^Add Task$/ }).first().click();
  await p.keyboard.type("Book the airport taxi");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(300);
  if (await p.locator(".add-task").count()) throw new Error("the add form stayed open after adding");
});
// Inbox: tasks in no project, as a board by default.
await shot("full-inbox-board", FULL, full({ settings: DARK }), async (p) => {
  await side(/Inbox/)(p);
  await boardView(p);
  await p.locator(".board").waitFor();
  await p.waitForTimeout(300);
  // The board reaches down to the footer, with its scrollbar at the bottom.
  const board = await p.locator(".board").boundingBox();
  const foot = await p.locator(".full-foot").boundingBox();
  if (foot.y - (board.y + board.height) > 48) throw new Error(`the board stops ${Math.round(foot.y - board.y - board.height)}px above the footer`);
  const cols = await p.locator(".bcol-title").allTextContents();
  if (cols.join(",") !== "Today,Tomorrow,Next 7 days,Later,Someday") throw new Error(`Inbox columns: ${cols.join(",")}`);
  if (await p.locator(".bcard", { hasText: "Book flights" }).count()) throw new Error("a project's task is in Inbox");
});
await shot("full-inbox-list", FULL, full({ settings: DARK }), async (p) => {
  await side(/Inbox/)(p);
  await p.waitForTimeout(300);
  if (await p.locator(".bcol").count()) throw new Error("still a board after choosing List");
  if (!(await p.locator(".task").count())) throw new Error("no tasks in Inbox's list");
});
await shot("full-inbox-drag", FULL, full({ settings: DARK }), async (p) => {
  await side(/Inbox/)(p);
  await boardView(p);
  await p.locator(".board").waitFor();
  await p.waitForTimeout(300);
  const card = p.locator(".bcard").first();
  const title = (await card.locator(".bcard-title").textContent())?.trim();
  const from = await card.boundingBox();
  const to = await p.locator(".bcol", { has: p.locator(".bcol-title", { hasText: "Someday" }) }).boundingBox();
  await p.mouse.move(from.x + 40, from.y + 14);
  await p.mouse.down();
  await p.mouse.move(from.x + 60, from.y + 40, { steps: 4 });
  await p.mouse.move(to.x + 60, to.y + 60, { steps: 10 });
  await p.waitForTimeout(150);
  if (!(await p.locator(".bcol.drop").count())) throw new Error("the column doesn't light up under a dragged card");
  await p.mouse.up();
  await p.waitForTimeout(400);
  const some = await p.locator(".bcol", { has: p.locator(".bcol-title", { hasText: "Someday" }) }).locator(".bcard-title").allTextContents();
  if (!some.map((x) => x.trim()).includes(title)) throw new Error(`"${title}" didn't move to Someday`);
});
await shot("full-board-floor-drag", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
  await boardView(p);
  await p.locator(".board").waitFor();
  await p.waitForTimeout(300);
  const card = p.locator(".bcard", { hasText: "Book flights" });
  const from = await card.boundingBox();
  const to = await p.locator(".bcol", { has: p.locator(".bcol-title", { hasText: "Program" }) }).boundingBox();
  await p.mouse.move(from.x + 40, from.y + 14);
  await p.mouse.down();
  await p.mouse.move(from.x + 60, from.y + 40, { steps: 4 });
  await p.mouse.move(to.x + 60, to.y + 60, { steps: 10 });
  await p.mouse.up();
  await p.waitForTimeout(400);
  if (!(await p.locator(".toast", { hasText: "Moved to Offsite 2026 › Program" }).count())) throw new Error("the card didn't move to the Program floor");
});
// The keyboard window: global shortcuts to record, and the keys inside.
await shot("full-keys", FULL, full({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: "Keyboard shortcuts" }).first().click();
  await p.locator(".km-card").waitFor();
  if ((await p.locator(".km-card .keycap").count()) < 1) throw new Error("no shortcut to record");
});
// v0.4.72: pick your own keys for actions in task lists.
const openKeys = async (p) => {
  await p.getByRole("button", { name: "Keyboard shortcuts" }).first().click();
  await p.locator(".km-card").waitFor();
};
await shot("full-keys-pick", FULL, full({ settings: LIGHT }), async (p) => {
  await openKeys(p);
  await p.getByRole("button", { name: "Tomorrow: M. Change key" }).click();
  await p.locator(".km-cap.recording").waitFor();
  await p.keyboard.press("y");
  await p.getByRole("button", { name: "Tomorrow: Y. Change key" }).waitFor();
  await p.getByRole("button", { name: "Use the usual keys" }).waitFor();
});
await shot("full-keys-swap", FULL, full({ settings: LIGHT }), async (p) => {
  await openKeys(p);
  await p.getByRole("button", { name: "Tomorrow: M. Change key" }).click();
  await p.keyboard.press("d");
  await p.locator(".km-mine-foot", { hasText: "Date, time and repeat is on M now." }).waitFor();
  await p.getByRole("button", { name: "Date, time and repeat: M. Change key" }).waitFor();
});
await shot("full-keys-in-use", FULL, full({ settings: { ...LIGHT, app_keys: { tomorrow: "y" } } }), async (p) => {
  await p.keyboard.press("ArrowDown");
  await p.waitForTimeout(150);
  await p.keyboard.press("y");
  await p.waitForTimeout(300);
  const ups = await p.evaluate(() => window.__updates ?? []);
  if (!ups.some((u) => u.patch?.due_date === day(1))) throw new Error(`Y didn't move the task to tomorrow: ${JSON.stringify(ups)}`);
});
// The week's columns line up from the day names down through the hours.
await shot("full-week-aligned", FULL, full({ settings: DARK }), async (p) => {
  await side(/Calendar/)(p);
  const day = await p.locator(".wg-days .wg-day").nth(1).boundingBox();
  const any = await p.locator(".wg-any .wg-cell").nth(1).boundingBox();
  const hour = await p.locator(".wg-body .wg-row").first().locator(".wg-cell").nth(1).boundingBox();
  for (const [name, b] of [["all-day", any], ["hours", hour]]) {
    if (Math.abs(b.x - day.x) > 1 || Math.abs(b.width - day.width) > 1) throw new Error(`the ${name} row is off by ${Math.round(b.x - day.x)}px`);
  }
});
// With the calendar pane closed, the list sits in the middle.
await shot("full-pane-closed-centered", FULL, full({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: "Hide calendar pane" }).click();
  await p.waitForTimeout(300);
  const main = await p.locator(".full-content").boundingBox();
  const list = await p.locator(".full-list").boundingBox();
  const left = list.x - main.x;
  const right = main.x + main.width - (list.x + list.width);
  if (Math.abs(left - right) > 20) throw new Error(`the list isn't centred (${Math.round(left)} vs ${Math.round(right)})`);
});
// The calendar pane closes from the header, and stays closed.
await shot("full-pane-closed", FULL, full({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: "Hide calendar pane" }).click();
  await p.waitForTimeout(300);
  if (await p.locator(".side-pane").count()) throw new Error("the pane didn't close");
  await p.getByRole("button", { name: "Show calendar pane" }).waitFor();
});
// Finished tasks wait behind "N completed · Show".
await shot("full-today-completed", FULL, full({ settings: DARK }), async (p) => {
  if (await p.locator(".task.done").count()) throw new Error("finished tasks show by default");
  await p.locator(".done-toggle").click();
  await p.waitForTimeout(200);
  if (!(await p.locator(".task.done").count())) throw new Error("Show didn't bring the finished tasks back");
});
// Sections in the sidebar, like Slack channels: "# General" first, then "# Travel"…
await shot("full-sidebar-floors", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
  const hashes = await p.locator(".sb-floor-row .sb-hash").allTextContents();
  if (!hashes.length || hashes.some((h) => h.trim() !== "#")) throw new Error(`sections don't start with #: ${hashes.join(",")}`);
  const names = (await p.locator(".sb-floor-row .sb-floor-name").allTextContents()).map((x) => x.trim());
  if (names[0] !== "General") throw new Error(`General isn't first: ${names.join(",")}`);
  if (await p.locator(".sidebar", { hasText: /Floor|Ground floor|Buildings/ }).count()) throw new Error("city words left in the sidebar");
});
// Drag a task from Today onto a floor of another building.
await shot("full-drag-to-floor", FULL, full({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: "Show Offsite 2026's sections" }).click();
  const task = p.locator(".task .task-row").first();
  const name = (await task.locator(".task-title").first().textContent())?.trim();
  const from = await task.boundingBox();
  const to = await p.getByRole("button", { name: "Travel", exact: true }).boundingBox();
  await p.mouse.move(from.x + 40, from.y + from.height / 2);
  await p.mouse.down();
  await p.mouse.move(from.x + 60, from.y + 30, { steps: 4 });
  await p.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 10 });
  await p.waitForTimeout(150);
  if (!(await p.locator(".sb-floor-row.drop").count())) throw new Error("the floor doesn't light up under a dragged task");
  if (!(await p.locator(".pop-ghost", { hasText: "Offsite 2026 › Travel" }).count())) throw new Error("the drag label doesn't say where it goes");
  await p.mouse.up();
  await p.waitForTimeout(300);
  if (!(await p.locator(".toast", { hasText: "Moved to Offsite 2026 › Travel" }).count())) throw new Error(`no 'moved' note after dropping ${name}`);
});
// The right-hand pane: narrower, and its edge can be dragged (and the width is kept).
await shot("full-side-resized", FULL, full({ settings: DARK }), async (p) => {
  const pane = p.locator(".side-pane").first();
  const before = (await pane.boundingBox()).width;
  if (Math.abs(before - 300) > 2) throw new Error(`the pane should start at 300px, not ${before}`);
  const edge = await p.locator(".side-resize").boundingBox();
  await p.mouse.move(edge.x, edge.y + 300);
  await p.mouse.down();
  await p.mouse.move(edge.x - 120, edge.y + 300, { steps: 6 });
  await p.mouse.up();
  await p.waitForTimeout(300);
  const after = (await pane.boundingBox()).width;
  if (Math.abs(after - 420) > 3) throw new Error(`dragging the edge should make it 420px, not ${after}`);
  const kept = await p.locator(".app-full").getAttribute("style");
  if (!kept?.includes("--side-w: 420px")) throw new Error(`the width wasn't kept (${kept})`);
});
// v0.4.69: one quiet "Update ready" pill in the footer; nothing else.
await shot("full-version-dot", FULL, full({ settings: DARK, update: { state: "ready", version: "0.9.9", notes: null } }), async (p) => {
  await p.locator(".vdot.ready", { hasText: "Update ready" }).waitFor();
  if (await p.locator(".update-banner").count()) throw new Error("no banner in full screen");
  if (await p.locator(".sidebar .sb-dot").count()) throw new Error("no dot on the settings gear");
  await p.locator(".vdot").click();
  await p.locator(".vdot-pop").getByRole("button", { name: "Update" }).waitFor();
});
await shot("full-version-latest", FULL, full({ settings: DARK, update: { state: "up_to_date" } }), async (p) => {
  if (await p.locator(".vdot").count()) throw new Error("the footer stays quiet on the latest version");
});
// The mayor: a 3D figure, a man or a woman.
await shot("full-mayor-pick", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".sidebar").getByRole("button", { name: /^Settings/ }).click();
  await tab(p, "Your city");
  await p.getByRole("radio", { name: /Woman/ }).click();
  await p.waitForTimeout(300);
  if (!(await p.locator(".sb-mayor .mayor-badge.figure img").count())) throw new Error("no 3D mayor in the sidebar");
});
await shot("full-city-mayor-woman", FULL, full({ settings: { ...DARK, look: { ...(DARK.look ?? {}), mayor_look: "woman" } } }), async (p) => {
  await p.locator(".sb-mayor").click();
  await p.waitForTimeout(1200);
});
await shot("full-room-drawers", FULL, full({ settings: DARK }), async (p) => {
  await openFloor(p);
  await p.locator(".task .task-row", { hasText: "Pack for the offsite" }).click();
  await p.waitForTimeout(200);
  if (!(await p.locator(".task.open .tf").count())) throw new Error("the task didn't open in place with its fields");
  if (await p.locator(".task.open .sp-done, .task.open .tc-foot, .task.open .tc-props").count()) throw new Error("the open task still has the old footer or labels");
});
await shot("full-task-when", FULL, full({ settings: DARK }), async (p) => {
  await openFloor(p);
  await p.locator(".task .task-row", { hasText: "Pack for the offsite" }).click();
  await p.waitForTimeout(200);
  await p.locator(".task.open .tf-chip-main").first().click();
  await p.locator(".tf-menu").waitFor();
  const box = await p.locator(".tf-menu").boundingBox();
  if (box.width > 320) throw new Error(`the date menu is too wide: ${Math.round(box.width)}px`);
  for (const gone of ["This evening", "Next week"]) {
    if (await p.locator(".tf-menu .tf-opt", { hasText: gone }).count()) throw new Error(`"${gone}" is still in the date menu`);
  }
  // Time: its own chip, type a time and Return.
  await p.locator(".task.open .tf-chip-main").nth(1).click();
  await p.getByRole("combobox", { name: "Time" }).waitFor();
  await p.keyboard.type("10:30pm");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(250);
  if (!(await p.locator(".task.open .tf-chip.set", { hasText: "10:30" }).count())) throw new Error("typing a time didn't set it");
  await p.locator(".task.open .tf-chip-main").first().click();
  await p.waitForTimeout(150);
});
await shot("full-task-deadline", FULL, full({ settings: DARK }), async (p) => {
  await openFloor(p);
  await p.locator(".task .task-row", { hasText: "Pack for the offsite" }).click();
  await p.waitForTimeout(200);
  await p.locator(".task.open .tf-tool[aria-label^='Deadline']").click();
  await p.locator(".tf-menu", { hasText: "the day it must be done by" }).waitFor();
  await p.locator(".tf-menu .cal button:not([disabled])").filter({ hasText: /^2[0-9]$/ }).first().click();
  await p.waitForTimeout(200);
  if (!(await p.locator(".task.open .tf-tool.dl").count())) throw new Error("the deadline icon didn't show the date");
});
await shot("full-task-title-date", FULL, full({ settings: DARK }), async (p) => {
  await openFloor(p);
  await p.locator(".task .task-row", { hasText: "Pack for the offsite" }).click();
  await p.waitForTimeout(200);
  await p.locator(".task.open .tfc-title").click();
  await p.keyboard.press("End");
  await p.keyboard.type(" tomorrow 10:30 pm");
  await p.locator(".tc-suggest").waitFor();
});
await shot("full-add-rich", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
  await p.getByRole("button", { name: /^Add Task$/ }).click();
  await p.keyboard.type("Ship the update tomorrow 3pm every week p1");
  await p.waitForTimeout(150);
  if (!(await p.locator(".add-task .tf-chip.set", { hasText: "Tomorrow" }).count())) throw new Error("the typed date didn't fill the date chip");
  if (!(await p.locator(".add-task .tf-chip.set", { hasText: "3:00" }).count())) throw new Error("the typed time didn't fill the time chip");
  if (!(await p.locator(".add-task .tf-tool.rep").count())) throw new Error("the typed repeat didn't show");
  if (!(await p.locator(".add-task .tf-tool[aria-label='Priority P1']").count())) throw new Error("p1 didn't set the priority");
  await p.locator(".add-task .tfc-notes").click();
  await p.keyboard.type("Release notes are in the shared doc");
});
await shot("full-add-empty", FULL, full({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: /^Add Task$/ }).click();
  // On Today the date is set; the time waits as a quiet chip.
  if (!(await p.locator(".add-task .tf-chip.set", { hasText: "Today" }).count())) throw new Error("a new task on Today isn't for today");
  if (!(await p.locator(".add-task .tf-chip.ghost", { hasText: "Time" }).count())) throw new Error("no Time chip on a new task");
  if (!(await p.locator(".add-task .tf-chip", { hasText: "Home" }).count())) throw new Error("a new task in Personal mode doesn't go to Home");
});
await shot("full-add-date-menu", FULL, full({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: /^Add Task$/ }).click();
  await p.keyboard.type("Call the bank");
  await p.locator(".add-task .tf-chip-main").first().click();
  await p.locator(".tf-menu .cal").waitFor();
});
await shot("full-add-priority", FULL, full({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: /^Add Task$/ }).click();
  await p.keyboard.type("Call the bank");
  await p.locator(".add-task").getByRole("button", { name: "Priority", exact: true }).click();
  await p.getByRole("menuitemradio", { name: /P1/ }).waitFor();
});
await shot("full-add-place", FULL, full({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: /^Add Task$/ }).click();
  await p.keyboard.type("Book the venue");
  await p.locator(".add-task .tf-chip").first().click();
  await p.locator(".tf-menu .tf-filter").waitFor();
});
await shot("full-repeat-deadline", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".task .task-row", { hasText: "Water the plants" }).first().click();
  await p.waitForTimeout(200);
  await p.locator(".task.open").getByRole("button", { name: "Deadline", exact: true }).click();
  await p.locator(".tf-menu .cal button:not([disabled])").filter({ hasText: /^2[0-9]$/ }).last().click();
  await p.waitForTimeout(250);
  await p.locator(".task.open").getByRole("button", { name: /^Repeat/ }).click();
  await p.locator(".tf-note", { hasText: "Ends by the deadline" }).waitFor();
});
// v0.4.70: custom repeats, from the repeat icon beside priority.
await shot("full-repeat-icon", FULL, full({ settings: LIGHT }), async (p) => {
  await p.locator(".task .task-row", { hasText: "Book flights" }).first().click();
  await p.waitForTimeout(200);
  const tools = await p.locator(".task.open .tf-tools .tf-tool").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  if (tools.indexOf("Repeat") !== tools.findIndex((l) => /^Priority/.test(l ?? "")) + 1) throw new Error(`repeat isn't right after priority: ${tools.join(", ")}`);
  await p.locator(".task.open").getByRole("button", { name: "Repeat", exact: true }).click();
  await p.getByRole("menuitem", { name: "Custom…" }).waitFor();
});
await shot("full-repeat-custom", FULL, full({ settings: LIGHT }), async (p) => {
  await p.locator(".task .task-row", { hasText: "Wrap up the launch notes" }).first().click();
  await p.waitForTimeout(200);
  await p.locator(".task.open").getByRole("button", { name: "Repeat", exact: true }).click();
  await p.getByRole("menuitem", { name: "Custom…" }).click();
  const ed = p.getByRole("dialog", { name: "Custom repeat" });
  await ed.getByLabel("How many", { exact: true }).fill("2");
  for (const d of ["Monday", "Wednesday"]) {
    const b = ed.getByRole("button", { name: d });
    if ((await b.getAttribute("aria-pressed")) !== "true") await b.click();
  }
  for (const d of ["Sunday", "Tuesday", "Thursday", "Friday", "Saturday"]) {
    const b = ed.getByRole("button", { name: d });
    if ((await b.getAttribute("aria-pressed")) === "true") await b.click();
  }
  await ed.locator(".rep-sum", { hasText: "Every 2 weeks on Monday, Wednesday" }).waitFor();
  await ed.getByLabel("How many times").fill("6");
  await ed.locator(".rep-pills span").nth(5).waitFor();
  const box = await ed.boundingBox();
  if (box.y + box.height > (p.viewportSize()?.height ?? 900)) throw new Error("the repeat editor runs off the window");
  await p.screenshot({ path: `${out}/full-repeat-custom-open.png` });
  await ed.getByRole("button", { name: "Done" }).click();
  await p.waitForTimeout(300);
  const ups = await p.evaluate(() => (window.__updates ?? []).map((u) => u.patch.recurrence).filter(Boolean));
  if (!ups.includes("rrule:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=6")) throw new Error(`saved ${JSON.stringify(ups)}`);
});
await shot("full-repeat-typed", FULL, full({ settings: LIGHT }), async (p) => {
  await p.getByRole("button", { name: /^Add Task$/ }).click();
  await p.keyboard.type("Book club the 2nd tuesday of every month");
  await p.waitForTimeout(150);
  await p.locator(".add-task .tf-tool.rep", { hasText: "Monthly · 2nd Tue" }).waitFor();
});
await shot("full-task-more", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".task .task-row").nth(1).click();
  await p.locator(".task.open").getByRole("button", { name: "More", exact: true }).click();
  await p.getByRole("menuitem", { name: "Duplicate" }).waitFor();
});
await shot("full-sidebar-hover", FULL, full({ settings: DARK }), async (p) => {
  // Counts line up on the right; + and ⋯ only show on hover.
  const counts = await p.locator(".sidebar .sb-count:not(:empty)").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().right)));
  if (new Set(counts).size > 1) throw new Error(`the sidebar's counts don't line up: ${counts.join(", ")}`);
  if ((await p.locator(".sb-head-actions").evaluate((e) => getComputedStyle(e).opacity)) !== "0") throw new Error("the Projects + shows without hover");
  await p.locator(".sb-b", { hasText: "Offsite 2026" }).hover();
  await p.waitForTimeout(200);
});
await shot("full-floor-menu", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
  await p.locator(".sb-b", { hasText: "Offsite 2026" }).hover();
  await p.getByRole("button", { name: "More for Offsite 2026" }).click();
});
await shot("full-project-synced", FULL, full({ settings: DARK, synced: { "Offsite 2026": "things3" } }), async (p) => {
  await side(/Offsite 2026/)(p);
  await p.locator(".sb-b", { hasText: "Offsite 2026" }).hover();
  await p.getByRole("button", { name: "More for Offsite 2026" }).click();
  await p.getByText("Synced from Things 3").waitFor();
  await p.getByRole("menuitem", { name: /Stop syncing/ }).waitFor();
});
await shot("full-project-color", FULL, full({ settings: DARK }), async (p) => {
  await side(/Q4 launch/)(p);
  await p.locator(".sb-b", { hasText: "Q4 launch" }).hover();
  await p.getByRole("button", { name: "More for Q4 launch" }).click();
  await p.getByRole("radio", { name: "Pink" }).click();
  await p.waitForTimeout(300);
});
await shot("full-city-story", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".ff-city").click();
  await p.waitForTimeout(600);
  await p.getByRole("button", { name: /Story/ }).click();
  await p.locator(".story-card").getByRole("button", { name: "Next", exact: true }).click();
  await p.locator(".story-card").getByRole("button", { name: "Next", exact: true }).click();
  await p.waitForTimeout(350);
});
await shot("full-city-milestones", FULL, full({ settings: { ...DARK, city_peak: 1200, city_seen: 1200 } }), async (p) => {
  await p.locator(".ff-city").click();
  await p.waitForTimeout(900);
  const n = await p.locator(".city3d-label.landmark").count();
  if (n < 6) throw new Error(`expected the park, square, train, harbour, stadium and island labels, saw ${n}`);
});
await shot("full-city-milestones-light", FULL, full({ settings: { ...LIGHT, city_peak: 1200, city_seen: 1200 } }), async (p) => {
  await p.locator(".ff-city").click();
  await p.waitForTimeout(900);
});
await shot("full-city-milestones-sheet", FULL, full({ settings: { ...DARK, city_peak: 80, city_seen: 99999 } }), async (p) => {
  await p.locator(".ff-city").click();
  await p.waitForTimeout(500);
  await p.getByRole("button", { name: /Milestones/ }).click();
  await p.waitForTimeout(300);
  if ((await p.locator(".ms-list li.got").count()) < 3) throw new Error("reached milestones aren't marked");
  if (!(await p.locator(".ms-rules").textContent()).includes("What's built stays built")) throw new Error("rules missing");
});
await shot("full-city-celebrate", FULL, full({ settings: { ...DARK, city_peak: 120, city_seen: 10 } }), async (p) => {
  await p.waitForTimeout(300);
  if (!(await p.locator(".toast, [role=status]").filter({ hasText: "the train is running" }).count())) throw new Error("no milestone toast");
  await p.locator(".ff-city").click();
  await p.locator(".ms-cheer").waitFor();
  await p.waitForTimeout(400);
});
await shot("full-new-building", FULL, full({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: "New project" }).click();
  await p.keyboard.type("Garden reno");
});
await shot("full-city-dark-room", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".ff-city").click();
  await p.waitForTimeout(800);
  const c = await p.locator(".city-view canvas").first().boundingBox();
  for (const [dx, dy] of [[0, 40], [60, 20], [-80, 30], [120, -40], [-140, 60]]) {
    await p.mouse.move(c.x + c.width / 2 + dx, c.y + c.height / 2 + dy, { steps: 2 });
    await p.waitForTimeout(80);
    if (await p.locator(".cv-tip", { hasText: /still to do|Overdue|readied/ }).count()) break;
  }
});
await shot("full-city-house", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".ff-city").click();
  await p.waitForTimeout(900);
  const c = await p.locator(".city-view canvas").first().boundingBox();
  // Sweep across the city until a house is under the pointer.
  outer: for (let y = 0.35; y < 0.95; y += 0.05) {
    for (let x = 0.1; x < 0.95; x += 0.05) {
      await p.mouse.move(c.x + c.width * x, c.y + c.height * y);
      await p.waitForTimeout(30);
      if (await p.locator(".cv-tip", { hasText: "A house" }).count()) break outer;
    }
  }
  const tip = p.locator(".cv-tip", { hasText: "A house" });
  if (await tip.count()) {
    const strong = await tip.locator("strong").textContent();
    if (strong === "Houses") throw new Error("hovering a house shows the whole neighbourhood, not its task");
  }
});
// ── v0.4.59 ────────────────────────────────────────────────────────────────
// A project's list shows every section; drag a task from one section to another.
await shot("full-section-drag", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
  const heads = (await p.locator("section.group[data-drop-floor] h2").allTextContents()).map((t) => t.replace(/\d+$/, "").trim());
  if (heads.join(",") !== "General,Program,Travel") throw new Error(`sections: ${heads.join(",")}`);
  const row = p.locator(".task .task-row", { hasText: "Book flights" }).first();
  const from = await row.boundingBox();
  const to = await p.locator('section.group[data-drop-floor="Program"]').boundingBox();
  await p.mouse.move(from.x + 60, from.y + from.height / 2);
  await p.mouse.down();
  await p.mouse.move(from.x + 80, from.y + 30, { steps: 4 });
  await p.mouse.move(to.x + 120, to.y + to.height / 2, { steps: 10 });
  await p.waitForTimeout(150);
  if (!(await p.locator('section.group.drop[data-drop-floor="Program"]').count())) throw new Error("the Program section doesn't light up under a dragged task");
  await p.mouse.up();
  await p.waitForTimeout(400);
  if (!(await p.locator(".toast", { hasText: "Moved to Offsite 2026 › Program" }).count())) throw new Error("no 'Moved to … › Program' note");
});
// Finishing a task: a green toast with a check.
await shot("full-done-toast", FULL, full({ settings: DARK }), async (p) => {
  await p.locator(".task:not(.done) .check").first().click();
  await p.waitForTimeout(800);
  if (!(await p.locator(".toast.done .toast-check").count())) throw new Error("the Completed toast isn't green");
});
await shot("full-done-toast-light", FULL, full({ settings: LIGHT }), async (p) => {
  await p.locator(".task:not(.done) .check").first().click();
  await p.waitForTimeout(800);
  if (!(await p.locator(".toast.done").count())) throw new Error("the Completed toast isn't green");
});
// Calendar opens with the side pane closed; opening it there is remembered for Calendar only.
await shot("full-calendar-pane", FULL, full({ settings: DARK }), async (p) => {
  if (!(await p.getByRole("button", { name: "Hide calendar pane" }).count())) throw new Error("Today lost its pane");
  await side(/Calendar/)(p);
  if (!(await p.getByRole("button", { name: "Show calendar pane" }).count())) throw new Error("Calendar opened with the pane showing");
  await p.getByRole("button", { name: "Show calendar pane" }).click();
  await side(/^Today/)(p);
  await side(/Calendar/)(p);
  if (!(await p.getByRole("button", { name: "Hide calendar pane" }).count())) throw new Error("Calendar forgot its pane was opened");
});
// Drag the row of dates two days to the right: two new days come in on the right.
await shot("full-calendar-slide", FULL, full({ settings: DARK }), async (p) => {
  await side(/Calendar/)(p);
  const first = () => p.locator(".wg-days .wg-day").first().getAttribute("data-iso");
  if ((await first()) !== day(0)) throw new Error("Calendar doesn't start today");
  const a = await p.locator(".wg-days .wg-day").nth(1).boundingBox();
  await p.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await p.mouse.down();
  await p.mouse.move(a.x + a.width / 2 + a.width * 2, a.y + a.height / 2, { steps: 12 });
  await p.mouse.up();
  await p.waitForTimeout(200);
  if ((await first()) !== day(2)) throw new Error(`dragging two days didn't move two days: ${await first()}`);
  if ((await p.locator(".wg-days .wg-day").count()) !== 7) throw new Error("the week isn't seven days wide");
  await side(/^Today/)(p);
  await side(/Calendar/)(p);
  if ((await first()) !== day(0)) throw new Error("coming back to Calendar didn't reset to today");
});
// Where a task came from: a chip that opens the exact message.
await shot("full-source-chip", FULL, full({ settings: DARK }), async (p) => {
  const chip = p.locator(".task .src-chip.link", { hasText: "from Slack" }).first();
  await chip.waitFor();
  if ((await chip.getAttribute("title")) !== "Open the message in Slack") throw new Error(`tooltip: ${await chip.getAttribute("title")}`);
  await chip.hover();
  await chip.click();
  if (!(await p.evaluate(() => (window.__opened ?? []).length))) throw new Error("clicking the chip didn't open the source");
  if (await p.locator(".task.open").count()) throw new Error("clicking the chip opened the task instead");
});
await shot("full-source-hover", FULL, full({ settings: { ...DARK, look: { ...(DARK.look ?? {}), show_source: "hover" } } }), async (p) => {
  const chip = p.locator(".task .src-chip", { hasText: "from Slack" }).first();
  if ((await chip.evaluate((el) => getComputedStyle(el).opacity)) !== "0") throw new Error("the chip shows before hovering");
  await p.locator(".task", { hasText: "Send Q3 numbers" }).first().locator(".task-row").first().hover();
  await p.waitForTimeout(250);
  if ((await chip.evaluate((el) => getComputedStyle(el).opacity)) !== "1") throw new Error("the chip doesn't show on hover");
});
await shot("full-source-never", FULL, full({ settings: { ...DARK, look: { ...(DARK.look ?? {}), show_source: "never" } } }), async (p) => {
  if (await p.locator(".src-chip").count()) throw new Error("chips show with Never");
});
await shot("full-settings-source", FULL, full({ settings: DARK }), async (p) => {
  await tab(p, "General");
  await p.getByText("Show where tasks came from").waitFor();
});
await shot("full-settings-data-folder", FULL, full({ settings: DARK }), async (p) => {
  await tab(p, "Backups & export");
  await p.getByRole("button", { name: "Show data folder" }).click();
  if (!(await p.evaluate(() => window.__revealedData))) throw new Error("Show data folder didn't ask to open it");
});
// Plain words in the task screens: no buildings, floors or houses outside the city.
await shot("full-plain-words", FULL, full({ settings: DARK }), async (p) => {
  await side(/Offsite 2026/)(p);
  await p.getByRole("button", { name: /^Add Task$/ }).first().click();
  const text = await p.locator(".full-content, .sidebar, .add-task").allInnerTexts();
  const hit = text.join("\n").match(/\b(Buildings?|Ground floor|New floor|a house|houses)\b/);
  if (hit) throw new Error(`city word in a task screen: ${hit[0]}`);
});

// ── v0.4.62: tasks at any minute, for any length ──────────────────────────
const TIMED = [
  ...FULL_TASKS,
  task("Stand-up with Priya", { due_date: day(1), due_time: "09:07", duration: 7 }),
  task("Deep work: pricing page", { due_date: day(1), due_time: "13:05", duration: 95 }),
  task("Review Maya's draft", { due_date: day(1), due_time: "13:30", duration: 30 }),
];
const updatesFor = (p, id) => p.evaluate((i) => (window.__updates ?? []).filter((u) => u.id === i).map((u) => u.patch), id);
const idOf = (title) => TIMED.find((t) => t.title === title).id;
await shot("full-week-blocks", FULL, full({ settings: DARK, tasks: TIMED }), async (p) => {
  await side(/Calendar/)(p);
  const lane = p.locator(".wg-lane").nth(1);
  const stand = lane.locator(".wg-task", { hasText: "Stand-up with Priya" });
  const deep = lane.locator(".wg-task", { hasText: "Deep work" });
  const review = lane.locator(".wg-task", { hasText: "Review Maya" });
  for (const b of [stand, deep, review]) await b.scrollIntoViewIfNeeded();
  const [sb, db, rb] = [await stand.boundingBox(), await deep.boundingBox(), await review.boundingBox()];
  const hour = await p.locator(".wg-body .wg-row").first().boundingBox();
  // 95 minutes is about 1.6 hours tall; 7 minutes is drawn small.
  if (Math.abs(db.height - (95 / 60) * hour.height) > 6) throw new Error(`a 95-minute task is ${Math.round(db.height)}px, an hour is ${Math.round(hour.height)}px`);
  if (sb.height > hour.height / 2) throw new Error("a 7-minute task is drawn as big as an hour");
  // 13:05–14:40 and 13:30–14:00 overlap: side by side.
  if (Math.abs(db.width - rb.width) > 2 || Math.abs(db.x - rb.x) < 10) throw new Error("overlapping tasks aren't side by side");
  if (!(await deep.innerText()).match(/1:05.*2:40/)) throw new Error(`no time range on the block: ${await deep.innerText()}`);
});
// v0.4.69: short tasks with long titles stay one tidy line; a crowded hour folds into "+N".
const SHORT = [
  ...FULL_TASKS,
  task("Reply to Maya about the venue options for the offsite kickoff", { due_date: day(1), due_time: "09:30", duration: 5 }),
  task("Confirm catering headcount", { due_date: day(1), due_time: "14:00", duration: 15 }),
  task("Send the signed contract to Dana", { due_date: day(1), due_time: "14:00", duration: 15 }),
  task("Book a room for the kickoff", { due_date: day(1), due_time: "14:05", duration: 15 }),
];
await shot("full-week-short", FULL, full({ settings: LIGHT, tasks: SHORT }), async (p) => {
  await side(/Calendar/)(p);
  const lane = p.locator(".wg-lane").nth(1);
  const reply = lane.locator(".wg-task", { hasText: "Reply to Maya" });
  await reply.scrollIntoViewIfNeeded();
  const b = await reply.boundingBox();
  if (b.height < 21) throw new Error(`a 5-minute task is ${Math.round(b.height)}px, too short to read`);
  if (!(await reply.locator(".wg-t").evaluate((e) => getComputedStyle(e).whiteSpace === "nowrap"))) throw new Error("a short task's title wraps");
  const fold = lane.locator(".wg-fold", { hasText: "+2" });
  await fold.waitFor();
  if ((await lane.locator(".wg-task", { hasText: /Confirm catering|Send the signed|Book a room/ }).count()) !== 1) throw new Error("a crowded hour shows one task and +2");
  await reply.hover();
  await p.getByRole("tooltip").filter({ hasText: "venue options for the offsite kickoff" }).waitFor();
});
await shot("full-week-resize", FULL, full({ settings: DARK, tasks: TIMED }), async (p) => {
  await side(/Calendar/)(p);
  const block = p.locator(".wg-lane").nth(1).locator(".wg-task", { hasText: "Review Maya" });
  await block.scrollIntoViewIfNeeded();
  const b = await block.boundingBox();
  const hour = await p.locator(".wg-body .wg-row").first().boundingBox();
  await p.mouse.move(b.x + b.width / 2, b.y + b.height - 2);
  await p.mouse.down();
  await p.mouse.move(b.x + b.width / 2, b.y + b.height - 2 + hour.height / 4, { steps: 6 }); // +15 minutes
  await p.mouse.up();
  await p.waitForTimeout(300);
  const ups = await updatesFor(p, idOf("Review Maya's draft"));
  if (!ups.some((u) => u.duration === 45)) throw new Error(`dragging the edge didn't make it 45 minutes: ${JSON.stringify(ups)}`);
});
await shot("full-week-drop-minute", FULL, full({ settings: DARK, tasks: TIMED }), async (p) => {
  await side(/Calendar/)(p);
  const block = p.locator(".wg-lane").nth(1).locator(".wg-task", { hasText: "Stand-up with Priya" });
  await block.scrollIntoViewIfNeeded();
  const from = await block.boundingBox();
  const cell = p.locator(`.wg-cell[data-iso="${day(2)}"][data-hour="10"]`);
  const to = await cell.boundingBox();
  await p.mouse.move(from.x + 40, from.y + from.height / 2);
  await p.mouse.down();
  await p.mouse.move(from.x + 60, from.y + 20, { steps: 4 });
  await p.mouse.move(to.x + 30, to.y + to.height * 0.5, { steps: 10 });
  await p.waitForTimeout(150);
  if (!(await p.locator(".wg-drop-at").count())) throw new Error("no time label while dropping");
  await p.mouse.up();
  await p.waitForTimeout(300);
  const ups = await updatesFor(p, idOf("Stand-up with Priya"));
  const t = ups.map((u) => u.due_time).find(Boolean);
  // Lands inside the 10 o'clock hour, on a minute (not snapped to 10:00). Where
  // in the short block the grab lands shifts it a few minutes, so any minute counts.
  if (!t || !/^10:(?!00)\d[05]$/.test(t)) throw new Error(`dropped mid-hour but got ${t}`);
});
await shot("full-length-menu", FULL, full({ settings: DARK, tasks: TIMED }), async (p) => {
  await side(/Calendar/)(p);
  await p.locator(".wg-lane").nth(1).locator(".wg-task", { hasText: "Stand-up with Priya" }).locator(".wg-title").click();
  await p.waitForTimeout(250);
  await p.getByRole("button", { name: "Length: 7 min" }).first().click();
  await p.getByRole("textbox", { name: "Length in minutes" }).fill("12");
  await p.keyboard.press("Enter");
  await p.waitForTimeout(250);
  const ups = await updatesFor(p, idOf("Stand-up with Priya"));
  if (!ups.some((u) => u.duration === 12)) throw new Error(`typing 12 didn't set 12 minutes: ${JSON.stringify(ups)}`);
});
await shot("full-add-length", FULL, full({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: /^Add Task$/ }).first().click();
  await p.keyboard.type("Stand-up tomorrow 9:07am for 7 min");
  await p.waitForTimeout(150);
  if (!(await p.locator(".add-task .tf-chip.set", { hasText: "7 min" }).count())) throw new Error("“for 7 min” didn't set the length");
});

await shot("panel-full-button", PANEL, scenario({ settings: DARK }), async (p) => {
  await p.getByRole("button", { name: "Open full screen" }).hover();
});

await browser.close();

if (failed.length) {
  console.log(`::error::${failed.length} preview(s) failed`);
  process.exitCode = 1;
}
