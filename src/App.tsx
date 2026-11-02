import { actionFor, keyMap } from "./lib/appKeys";
import { type CSSProperties, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CaptureCard, type CaptureState } from "./components/CaptureCard";
import { Onboarding } from "./components/Onboarding";
import { processCapture } from "./lib/capture";
import { UpdateBanner } from "./components/UpdateBanner";
import { pageFromTab, pageLabel, SettingsContent, SettingsNav, type SettingsPage } from "./components/Settings";
import { type RowCommand, TaskDetail, TaskList } from "./components/TaskList";
import { Sidebar } from "./components/Sidebar";
import { CityView } from "./components/City";
import { FullFooter } from "./components/FullFooter";
import { KeyboardIcon, KeysModal } from "./components/KeysModal";
import { buildCity } from "./lib/city";
import { cheerFor, newMilestones, type Milestone } from "./lib/milestones";
import { CITY, PLAIN, WordsContext } from "./lib/words";
import { WeekGrid, WeekSide, sevenDays } from "./components/WeekGrid";
import { MonthCalendar } from "./components/MonthCalendar";
import { applyLook, lookOf, weekStartOf } from "./lib/look";
import { ProjectColors } from "./lib/colors";
import { Toasts, useToasts } from "./components/Toasts";
import { SourceDisplay } from "./components/SourceChip";
import { GearIcon, PlusIcon, SearchIcon } from "./components/icons";
import { ViewSwitch } from "./components/ViewSwitch";
import { WeekView } from "./components/WeekView";
import { WeekStrip } from "./components/WeekStrip";
import { DayPlan } from "./components/DayPlan";
import { DragGhost } from "./components/DragGhost";
import { SideResizer, defaultSideWidth } from "./components/SideResizer";
import { TaskBoard, type BoardColumn } from "./components/TaskBoard";
import { useTaskDrag } from "./lib/useTaskDrag";
import { dropPatch } from "./lib/plan";
import {
  api,
  onCalendarChanged,
  onCapture,
  onHighlightTask,
  onOpenTab,
  onPanelCollapsed,
  onPanelFull,
  onSettingsChanged,
  onShortcutsChanged,
  onMirrorChanged,
  onSyncChanged,
  onTasksChanged,
  onUpdateStatus,
  onAgentChanges,
  onAgentRuns,
  onInboxChanged,
  onTermExit,
} from "./lib/api";
import { agentCounts, agentsBy, byAgent, filterWho, latestByTask, type Who } from "./lib/agents";
import { AgentMarks, AgentsSetUpDialog } from "./components/WhoSwitch";
import { ViewMenu, whoLabel } from "./components/ViewMenu";
import { showDragHint } from "./lib/hints";
import { AgentPanel, guessSize } from "./components/AgentPanel";
import { AgentRuns, SendToAgentDialog, type AgentRunsValue } from "./components/AgentRuns";
import {
  continueNote,
  folderFor,
  groupByRun,
  waitingCount,
  lastAgent,
  loadFolders,
  rememberFolder,
  runsByTask,
  saveFolders,
  saveLastAgent,
  type FolderMemory,
} from "./lib/agentRuns";
import type { AgentChange, AgentCliStatus, AgentRun, AgentsStatus, TermSession } from "./lib/types";
import { formatShortcut, type ShortcutSettings } from "./lib/shortcuts";
import { addDays, parseISODate, toISODate } from "./lib/dates";
import { groupTasks } from "./lib/grouping";
import { bySection, groupByHeading, groupInbox, headingsOf, inboxColumnDay, type InboxColumn, listTitle, normalizeList, projectList, projectOf, tasksForList, type ListId, withEmptySections } from "./lib/lists";
import { ListPicker } from "./components/ListPicker";
import { Logbook } from "./components/Logbook";
import type { ProjectInfo } from "./components/ProjectPicker";
import { ProjectHeader } from "./components/ProjectHeader";
import { LineIcon } from "./components/LineIcon";
import { BatchBar } from "./components/BatchBar";
import { taskActions } from "./lib/taskActions";
import { dueNow } from "./lib/due";
import { DueNowCard } from "./components/DueNowCard";
import { AddTaskForm } from "./components/AddTaskForm";
import { relativeLabel } from "./lib/dates";
import { timeLabel } from "./lib/schedule";
import { matchesQuery, topTags } from "./lib/taskText";
import type { AppSettings, CalendarEvent, CaptureResult, CityWindow, FloorSummary, LookSettings, NewTask, ProjectSummary, Status, Task, UpdateStatus } from "./lib/types";
import { safeLocale } from "./lib/locale";
import { activeMode, showsTask } from "./lib/modes";
import { ModeSwitch } from "./components/ModeSwitch";

const LOCALE = safeLocale();

type Tab = "tasks" | "settings";

type TodayMode = "list" | "hours";
function saved<T extends string>(key: string, allowed: T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the choice lasts this session.
  }
}

/** Keys that stay as they are; the rest are changeable (`APP_ACTIONS`). */
const KEYS: [string, string][] = [
  ["↑ ↓", "Move between tasks"],
  ["⌫", "Delete"],
  ["⌘Z", "Undo"],
  ["⌘-click · ⇧-click", "Select several (⌘A all)"],
  ["← →", "Day before / after (Calendar)"],
  ["/ or ⌘F", "Search"],
  ["⌃⌘F", "Full screen ↔ side panel"],
];

function typingIn(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

export default function App() {
  const [now, setNow] = useState(() => new Date());
  const [allTasks, setTasks] = useState<Task[]>([]);
  const allTasksRef = useRef(allTasks);
  allTasksRef.current = allTasks;
  const [capture, setCapture] = useState<CaptureState | null>(null);
  const [hidden, setHidden] = useState<string[]>(() => {
    try {
      return (localStorage.getItem("todocity.banners.hidden") ?? "").split(",").filter(Boolean);
    } catch {
      return [];
    }
  });
  const [status, setStatus] = useState<Status | null>(null);
  const [settings, setSettings] = useState<AppSettings | null>(null);
  // The mode this Mac is in (Work, Personal…): lists show only its projects.
  // "Show everything for now" lifts it until the mode changes.
  const [peek, setPeek] = useState(false);
  const realMode = activeMode(settings);
  const mode = peek ? null : realMode;
  useEffect(() => setPeek(false), [realMode?.id]);
  const tasks = useMemo(() => (mode ? allTasks.filter((t) => showsTask(mode, t)) : allTasks), [allTasks, mode]);
  const [update, setUpdate] = useState<UpdateStatus>({ state: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("tasks");
  // Settings: the page showing, and (side panel) whether it's on the list of pages.
  const [page, setPage] = useState<SettingsPage>("general");
  const [panelHome, setPanelHome] = useState(true);
  const openSettings = useCallback((p?: SettingsPage) => {
    setTab("settings");
    if (p) {
      setPage(p);
      setPanelHome(false);
    } else setPanelHome(true);
  }, []);
  const [collapsed, setCollapsed] = useState(false);
  // Full screen: the panel as a big window with a sidebar and a detail pane.
  const [full, setFull] = useState(false);
  const [sideOpen, setSideOpen] = useState(() => saved("todocity.sidebar", ["open", "closed"], "open") === "open");
  useEffect(() => remember("todocity.sidebar", sideOpen ? "open" : "closed"), [sideOpen]);
  // The side panel's window is see-through around its rounded card; full
  // screen paints the whole window.
  useEffect(() => {
    document.documentElement.dataset.full = full ? "1" : "";
  }, [full]);
  useEffect(() => {
    if (full) api.cityWindows().then(setCityWins, () => undefined);
    else setCityOpen(null);
  }, [full]);
  const [shortcuts, setShortcuts] = useState<ShortcutSettings | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [focusId, setFocusId] = useState<number | null>(null);
  const [command, setCommand] = useState<RowCommand | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  // Which list: Today, Calendar, Inbox, Overdue, Completed or a project.
  // Remembered per Mac. (Anytime and Someday, from before, open Inbox.)
  const [list, setListRaw] = useState<ListId>(() => {
    try {
      const saved = localStorage.getItem("todocity.list");
      if (saved) return normalizeList(saved as ListId);
      return localStorage.getItem("todocity.view") === "week" ? "upcoming" : "today";
    } catch {
      return "today";
    }
  });
  const setList = useCallback((l: ListId | ((prev: ListId) => ListId)) => setListRaw((p) => normalizeList(typeof l === "function" ? l(p) : l)), []);
  useEffect(() => {
    try {
      localStorage.setItem("todocity.list", list);
    } catch {
      // Storage unavailable: the choice lasts this session.
    }
  }, [list]);
  const focusToday = list === "today";
  const setFocusToday = (f: boolean | ((v: boolean) => boolean)) =>
    setList((l) => ((typeof f === "function" ? f(l === "today") : f) ? "today" : "inbox"));
  const [projectStats, setProjectStats] = useState<ProjectSummary[]>([]);
  // Projects that could start syncing with Todoist ("Sync with Todoist").
  const [syncable, setSyncable] = useState<string[]>([]);
  // Each project's headings: the floors of its building.
  const [floorList, setFloorList] = useState<FloorSummary[]>([]);
  // Tasks selected for batch actions, and where a Shift-click range starts.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const anchor = useRef<number | null>(null);
  // Today as a list, or in hour blocks. Remembered per Mac.
  const [todayMode, setTodayMode] = useState<TodayMode>(() => saved("todocity.todayMode", ["list", "hours"], "list"));
  useEffect(() => remember("todocity.todayMode", todayMode), [todayMode]);
  const upcoming = list === "upcoming";
  // Full screen always shows Today with its hours beside the list.
  const todayHours = list === "today" && (full || todayMode === "hours");
  // The task list shows except in the week — and in full screen, Today's
  // hours sit beside it rather than replacing it.
  const showList = !upcoming && (!todayHours || full);
  // The search field shows on demand (/, ⌘F or the magnifier).
  const [searchOpen, setSearchOpen] = useState(false);
  // The task opened as a card.
  const [openId, setOpenId] = useState<number | null>(null);
  const [planDay, setPlanDay] = useState(() => toISODate(new Date()));
  // Calendar opens on seven days from today: a slid or paged week isn't kept
  // once you leave it.
  const wasCalendar = useRef(upcoming);
  useEffect(() => {
    if (wasCalendar.current && !upcoming) setPlanDay(toISODate(new Date()));
    wasCalendar.current = upcoming;
  }, [upcoming]);
  // Full screen's right side: the day picked in the month calendar.
  const [sideDay, setSideDay] = useState(() => toISODate(new Date()));
  // The user's own touches: clock, accent, first day of the week, the city.
  const look = lookOf(settings);
  // The right-hand pane's width: while its edge is dragged, then as saved.
  const [liveSideW, setLiveSideW] = useState<number | null>(null);
  const sideW = liveSideW ?? look.side_width;
  applyLook(look);
  const weekStart = useMemo(() => weekStartOf(look, LOCALE), [look.week_start]); // eslint-disable-line react-hooks/exhaustive-deps
  // Open on the list picked in Preferences (once, when settings first load).
  const startApplied = useRef(false);
  useEffect(() => {
    if (!settings || startApplied.current) return;
    startApplied.current = true;
    const s = lookOf(settings).start_list;
    if (s !== "last") setList(s as ListId);
  }, [settings]);
  const captureSeq = useRef(0);
  const statusRef = useRef<Status | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const today = toISODate(now);
  const { toasts, show, dismiss, undoLast } = useToasts();
  // The add-task form at the top of the list.
  const [adding, setAdding] = useState(false);
  // The heading new tasks go under, when adding from a project's heading.
  const [addHeading, setAddHeading] = useState<string | null>(null);
  // Full screen: one floor of a building on a page of its own (floor null: the lobby).
  const [floorView, setFloorView] = useState<{ project: string; floor: string | null } | null>(null);
  const actions = useMemo(() => taskActions(show, LOCALE), [show]);
  const fullRef = useRef(false);
  fullRef.current = full;
  const toggleFull = useCallback(() => {
    const next = !fullRef.current;
    setFull(next);
    api.setPanelFull(next).catch((e) => {
      setFull(!next);
      setError(String(e));
    });
  }, []);
  const toggleFullRef = useRef(toggleFull);
  toggleFullRef.current = toggleFull;
  // The city (full screen): finished tasks, and whether it's open.
  const [cityWins, setCityWins] = useState<CityWindow[]>([]);
  const [cityOpen, setCityOpen] = useState<null | "view" | "share">(null);

  const refresh = useCallback(async () => {
    try {
      api.listProjects().then(setProjectStats, () => undefined);
      api.mirrorSyncable().then(setSyncable, () => undefined);
      api.listFloors().then(setFloorList, () => undefined);
      if (fullRef.current) api.cityWindows().then(setCityWins, () => undefined);
      setTasks(await api.listTasks(today));
    } catch (e) {
      setError(String(e));
    }
  }, [today]);

  const checkStatus = useCallback(async () => {
    try {
      const s = await api.status();
      statusRef.current = s;
      setStatus(s);
    } catch (e) {
      setError(String(e));
    }
  }, []);
  const refreshStatus = useCallback(() => void checkStatus(), [checkStatus]);

  // Keep "today" correct across midnight and after sleep.
  useEffect(() => {
    const tick = () => setNow(new Date());
    const id = window.setInterval(tick, 60_000);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", tick);
    };
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    void checkStatus();
    api
      .getShortcuts()
      .then(setShortcuts)
      .catch((e) => setError(String(e)));
    api
      .getSettings()
      .then(setSettings)
      .catch((e) => setError(String(e)));
    api
      .updateStatus()
      .then(setUpdate)
      .catch(() => undefined);
    api
      .panelFull()
      .then((f) => setFull(!!f))
      .catch(() => undefined);
  }, [checkStatus]);

  // The tour opens on a first run (nothing set up yet) and stays open until
  // it's finished or skipped, even once the model arrives mid-way.
  const [tour, setTour] = useState(false);
  const tourDecided = useRef(false);
  useEffect(() => {
    if (tourDecided.current || !settings || !status) return;
    tourDecided.current = true;
    if (!settings.onboarding_done && !status.active_model && status.engine !== "ollama") setTour(true);
  }, [settings, status]);

  // People upgrading with a model already set up skip the walkthrough.
  useEffect(() => {
    if (!settings || !status || settings.onboarding_done || tour) return;
    if (status.active_model || status.engine === "ollama") {
      api
        .setSettings({ ...settings, onboarding_done: true })
        .then(setSettings)
        .catch(() => undefined);
    }
  }, [settings, status, tour]);

  // A task picked from the menu bar flashes briefly.
  useEffect(() => {
    if (highlight === null) return;
    const t = window.setTimeout(() => setHighlight(null), 1800);
    return () => window.clearTimeout(t);
  }, [highlight]);

  const handleCapture = useCallback(async (result: CaptureResult) => {
    const seq = ++captureSeq.current;
    if (result.kind === "text") setTab("tasks");
    await processCapture(result, statusRef.current, setCapture, () => seq === captureSeq.current);
  }, []);

  useEffect(() => {
    const subs = [
      onCapture((r) => void handleCapture(r)),
      onTasksChanged(() => void refresh()),
      // Todoist connected, two-way switched, or a project kept on this Mac.
      onMirrorChanged(() => void api.mirrorSyncable().then(setSyncable, () => undefined)),
      onSyncChanged(() => void api.mirrorSyncable().then(setSyncable, () => undefined)),
      onOpenTab((t) => {
        const p = pageFromTab(t);
        if (p) openSettings(p);
        else setTab("tasks");
      }),
      onShortcutsChanged(setShortcuts),
      // A mode switched from the menu bar (or another window) shows here too.
      onSettingsChanged(setSettings),
      onHighlightTask((id) => {
        setTab("tasks");
        // Its own list: its project, or Inbox.
        const t = allTasksRef.current.find((x) => x.id === id);
        setList(t?.project ? projectList(t.project) : "inbox");
        setQuery("");
        setHighlight(id);
        setFocusId(id);
      }),
      onPanelCollapsed(setCollapsed),
      onPanelFull(setFull),
      onUpdateStatus(setUpdate),
    ];
    return () => {
      subs.forEach((p) => void p.then((unlisten) => unlisten()));
    };
  }, [handleCapture, refresh]);

  const nowTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  // Full screen, a project: every task in it, done ones too (they stay on their floor, crossed out).
  const [projectAll, setProjectAll] = useState<Task[]>([]);
  const viewing = projectOf(list);
  useEffect(() => {
    if (!full || viewing === null) {
      setProjectAll([]);
      return;
    }
    let live = true;
    api
      .projectTasks(viewing)
      .then((t) => live && setProjectAll(t))
      .catch(() => live && setProjectAll([]));
    return () => {
      live = false;
    };
  }, [full, viewing, tasks]);
  // You · All · Agents (full screen): whose tasks the lists show.
  const [who, setWhoState] = useState<Who>(() => saved("todocity.who", ["you", "all", "agents"], "all"));
  const setWho = (w: Who) => {
    remember("todocity.who", w);
    setWhoState(w);
  };
  useEffect(() => {
    // The menu bar's "See what changed" switches to Agents from its window.
    const sync = (e: StorageEvent) => {
      if (e.key === "todocity.who" && (e.newValue === "you" || e.newValue === "all" || e.newValue === "agents")) setWhoState(e.newValue);
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const [agentsSt, setAgentsSt] = useState<AgentsStatus | null>(null);
  const [activity, setActivity] = useState<AgentChange[]>([]);
  const [askAgents, setAskAgents] = useState(false);
  useEffect(() => {
    const load = () => {
      api.agentsStatus().then(setAgentsSt).catch(() => undefined);
      api.agentActivity().then(setActivity).catch(() => undefined);
    };
    load();
    const subs = [onTasksChanged(load), onAgentChanges(load), onInboxChanged(load), onSettingsChanged(load)];
    return () => subs.forEach((p) => void p.then((u) => u()));
  }, []);
  const agentsOn = !!agentsSt?.enabled;
  const latestAgent = useMemo(() => latestByTask(activity), [activity]);
  // Agents not set up (or off): nothing to filter by.
  const whoShown: Who = agentsOn ? who : "all";
  const visible = useMemo(() => {
    // A project's page and search see every task, whatever the mode.
    let base = tasksForList(viewing !== null || query.trim() ? allTasks : tasks, list, today, nowTime);
    if (viewing !== null && projectAll.length) {
      const have = new Set(base.map((t) => t.id));
      base = [...base, ...projectAll.filter((t) => t.done && !have.has(t.id) && t.project === viewing)];
    }
    const shown = base.filter((t) => !query.trim() || matchesQuery(t, query));
    return full ? filterWho(shown, whoShown, now) : shown;
  }, [tasks, allTasks, query, list, today, nowTime, viewing, projectAll, full, whoShown, now]);
  const firing = useMemo(() => dueNow(tasks, now), [tasks, now]);
  const agentMarks = useMemo(
    () => ({
      latest: latestAgent,
      now,
      on: agentsOn,
      undo:
        whoShown === "agents"
          ? (id: number) =>
              void api
                .agentUndo({ tasks: [id] })
                .then(() => show("Put back as it was"))
                .catch((e) => setError(String(e)))
          : undefined,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [latestAgent, now, whoShown, agentsOn],
  );
  // The agent panel (full screen) and tasks sent to agents.
  const [agentPane, setAgentPaneRaw] = useState(() => saved("todocity.agentPane", ["on", "off"], "off") === "on");
  const setAgentPane = (on: boolean) => {
    remember("todocity.agentPane", on ? "on" : "off");
    setAgentPaneRaw(on);
  };
  const [clis, setClis] = useState<AgentCliStatus[]>([]);
  const [termSessions, setTermSessions] = useState<TermSession[]>([]);
  const [activeTerm, setActiveTerm] = useState<number | null>(null);
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [sendTask, setSendTask] = useState<Task | null>(null);
  const [homeDir, setHomeDir] = useState("");
  const [folders, setFolders] = useState<FolderMemory>(loadFolders);
  const [termBusy, setTermBusy] = useState(false);
  useEffect(() => {
    api.homeFolder().then(setHomeDir).catch(() => undefined);
    const loadRuns = () => {
      api.agentRuns().then(setRuns).catch(() => undefined);
      api.termList().then(setTermSessions).catch(() => undefined);
    };
    loadRuns();
    const subs = [onAgentRuns(loadRuns), onTermExit(loadRuns), onTasksChanged(loadRuns)];
    return () => subs.forEach((p) => void p.then((u) => u()));
  }, []);
  // Which agents are installed: looked up when the panel or the dialog opens.
  useEffect(() => {
    if (!agentPane && !sendTask) return;
    api.agentClis().then(setClis).catch(() => undefined);
  }, [agentPane, sendTask]);
  const panelFolder = folders.last || homeDir;
  const keepFolder = (project: string | null, folder: string) => {
    const next = rememberFolder(folders, project, folder);
    setFolders(next);
    saveFolders(next);
  };
  /** Open a terminal (an agent, or a plain shell), optionally on a task. */
  const startTerm = async (
    agent: string | null,
    o: { folder?: string | null; taskId?: number; extra?: string; prompt?: string } = {},
  ) => {
    const width = (sideW || defaultSideWidth()) - 2;
    const { cols, rows } = guessSize(width, window.innerHeight - 190);
    setTermBusy(true);
    try {
      const sess = await api.termStart({
        agent,
        folder: o.folder ?? panelFolder,
        taskId: o.taskId ?? null,
        extra: o.extra ?? null,
        prompt: o.prompt ?? null,
        cols,
        rows,
      });
      if (agent) saveLastAgent(agent);
      setTermSessions(await api.termList());
      setActiveTerm(sess.id);
      if (full) setAgentPane(true);
      return sess;
    } finally {
      setTermBusy(false);
    }
  };
  const runMap = useMemo(() => runsByTask(runs), [runs]);
  const runsValue: AgentRunsValue = useMemo(
    () => ({
      byTask: runMap,
      send: (t: Task) => setSendTask(t),
      open: (r: AgentRun) => {
        if (r.session !== null) setActiveTerm(r.session);
        if (!full) void api.setPanelFull(true).catch(() => undefined);
        setAgentPane(true);
      },
      reply: async (r: AgentRun, t: Task, text: string) => {
        const live = r.session !== null && termSessions.some((x) => x.id === r.session && x.alive);
        try {
          if (live) await api.termWrite(r.session!, `${text}\r`);
          else await startTerm(r.agent, { folder: r.folder, taskId: t.id, extra: text });
        } catch (e) {
          setError(String(e));
        }
      },
      resume: (r: AgentRun, t: Task) =>
        void startTerm(r.agent, { folder: r.folder, taskId: t.id, extra: continueNote(r) }).catch((e) => setError(String(e))),
      dismiss: (r: AgentRun) => void api.agentRunDismiss(r.id).catch((e) => setError(String(e))),
      markDone: (t: Task) => void actions.setDone(t, true),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runMap, termSessions, full, panelFolder, actions],
  );
  const sendDialog = sendTask && (
    <SendToAgentDialog
      task={sendTask}
      clis={clis}
      folder={folderFor(folders, sendTask.project ?? null, homeDir)}
      lastAgent={lastAgent()}
      onClose={() => setSendTask(null)}
      onStart={async (agent, folder, extra) => {
        await startTerm(agent, { folder, taskId: sendTask.id, extra });
        keepFolder(sendTask.project ?? null, folder);
        const name = clis.find((c) => c.id === agent)?.name ?? "The agent";
        show(`${name} is on “${sendTask.title.slice(0, 40)}”`);
        setSendTask(null);
      }}
    />
  );

  const viewedProject = projectOf(list);
  const floorOpen = full && floorView && floorView.project === viewedProject ? floorView : null;
  useEffect(() => {
    if (floorView && projectOf(list) !== floorView.project) setFloorView(null);
  }, [list, floorView]);
  // Finished tasks wait in Completed unless the user shows them (Settings →
  // General), or asks to see this list's for now.
  const [revealDone, setRevealDone] = useState(false);
  useEffect(() => setRevealDone(false), [list, floorView]);
  const showDone = list === "logbook" || lookOf(settings).show_done || revealDone;
  const rawGroups = useMemo(() => {
    if (list === "logbook") return [];
    if (list === "agents") return groupByRun(visible, runMap);
    if (list === "inbox") return groupInbox(visible, now);
    if (viewedProject === null) return groupTasks(visible, now, LOCALE);
    const all = groupByHeading(visible, full);
    // A section's page: just that section's tasks.
    if (floorOpen) return all.filter((g) => g.key === `h:${floorOpen.floor ?? ""}`);
    // The whole project: every section shows, even empty ones, so tasks can be dragged between them.
    if (!all.length || query.trim()) return all;
    return withEmptySections(all, floorList.filter((f) => f.project === viewedProject).map((f) => f.name));
  }, [visible, now, list, viewedProject, floorOpen, full, floorList, query, runMap]);
  const doneHidden = useMemo(
    () => (showDone ? 0 : rawGroups.reduce((n, g) => n + g.tasks.filter((t) => t.done).length, 0)),
    [rawGroups, showDone],
  );
  const groups = useMemo(
    () => {
      if (showDone) return rawGroups;
      // A project's sections stay even when empty (somewhere to drag tasks into).
      const keepEmpty = viewedProject !== null && !floorOpen;
      const open = rawGroups.map((g) => ({ ...g, tasks: g.tasks.filter((t) => !t.done) }));
      const left = open.filter((g) => g.tasks.length > 0 || (keepEmpty && g.key.startsWith("h:")));
      return left.some((g) => g.tasks.length > 0) ? left : [];
    },
    [rawGroups, showDone, viewedProject, floorOpen],
  );
  // Inbox and projects as a board (full screen; each remembers list or board).
  const boardKey = list === "inbox" ? "inbox" : viewedProject !== null ? `project:${viewedProject}` : null;
  const viewMode = boardKey ? (lookOf(settings).list_views[boardKey] ?? "list") : "list";
  const boardView = full && boardKey !== null && !floorOpen && viewMode === "board" && !query.trim();
  // A board needs the room: the calendar pane stays closed there unless asked for.
  const [boardPane, setBoardPane] = useState(false);
  // Calendar has its own week grid, so its pane starts closed too; opening or
  // closing it there is remembered for Calendar only.
  const [calPane, setCalPane] = useState(() => saved("todocity.calendar.pane", ["open", "closed"], "closed") === "open");
  const calView = upcoming && !boardView && tab === "tasks";
  const paneShown = boardView ? boardPane : calView ? calPane : lookOf(settings).side_open;
  const togglePane = () => {
    // The calendar and the agent panel share the right side.
    if (agentPane) {
      setAgentPane(false);
      if (paneShown) return;
    }
    if (boardView) setBoardPane((o) => !o);
    else if (calView)
      setCalPane((o) => {
        remember("todocity.calendar.pane", o ? "closed" : "open");
        return !o;
      });
    else void patchLook({ side_open: !lookOf(settingsRef.current).side_open });
  };
  const togglePaneRef = useRef(togglePane);
  togglePaneRef.current = togglePane;
  const setViewMode = (m: "list" | "board") => {
    if (!boardKey) return;
    void patchLook({ list_views: { ...lookOf(settings).list_views, [boardKey]: m } });
  };
  const listCounts = useMemo(
    () => ({
      inbox: tasksForList(tasks, "inbox", today).filter((t) => !t.done).length,
      today: tasksForList(tasks, "today", today).filter((t) => !t.done).length,
      overdue: tasksForList(tasks, "overdue", today, nowTime).length,
      agents: runs.length,
      agentsWaiting: waitingCount(runs),
    }),
    [tasks, today, nowTime, runs],
  );
  const projectInfos: ProjectInfo[] = useMemo(() => {
    const names = new Set([...projectStats.map((p) => p.name), ...allTasks.flatMap((t) => (t.project ? [t.project] : []))]);
    return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ name, headings: headingsOf(allTasks, name) }));
  }, [projectStats, allTasks]);
  // Today's calendar events, for Today in hours.
  const [todayEvents, setTodayEvents] = useState<CalendarEvent[]>([]);
  const [eventsKey, setEventsKey] = useState(0);
  useEffect(() => {
    let live = true;
    api
      .calendarEvents(today, today)
      .then((e) => live && setTodayEvents(e))
      .catch(() => live && setTodayEvents([]));
    return () => {
      live = false;
    };
  }, [today, eventsKey]);
  useEffect(() => {
    const sub = onCalendarChanged(() => setEventsKey((k) => k + 1));
    return () => void sub.then((u) => u());
  }, []);
  async function addFromPlan(task: NewTask) {
    try {
      // A column that says where its tasks go (Inbox's) keeps them there.
      await api.addTask(task, "project" in task);
      show(
        task.due_time
          ? `Added at ${timeLabel(task.due_time, LOCALE)}`
          : task.due_date
            ? `Added for ${relativeLabel(task.due_date, new Date(), LOCALE).toLowerCase()}`
            : "Task added",
      );
    } catch (e) {
      setError(String(e));
      throw e;
    }
  }
  /** From an hour block: show the task in a list, opened. */
  function showInList(t: Task) {
    setAdding(false);
    setQuery("");
    setTodayMode("list");
    setList(t.due_date && t.due_date <= today ? "today" : t.project ? projectList(t.project) : "inbox");
    setHighlight(t.id);
    setFocusId(t.id);
    window.setTimeout(() => setOpenId(t.id), 0);
  }
  const openProject = (name: string) => {
    setFloorView(null);
    setTab("tasks");
    setQuery("");
    setList(projectList(name));
  };
  const flat = useMemo(() => groups.flatMap((g) => g.tasks), [groups]);
  // The selection only holds tasks still on screen.
  useEffect(() => {
    setSelected((sel) => {
      if (!sel.size) return sel;
      const ids = new Set(flat.filter((t) => !t.done).map((t) => t.id));
      const next = new Set([...sel].filter((id) => ids.has(id)));
      return next.size === sel.size ? sel : next;
    });
  }, [flat]);
  useEffect(() => {
    setSelected(new Set());
    setOpenId(null);
  }, [list, tab, todayMode]);
  // Drag a task onto a day of the week strip (or an hour, in Today's hours).
  // Or onto a building or floor in the sidebar.
  const drag = useTaskDrag((task, to) => {
    const patch = dropPatch(task, to);
    if (patch && to.place) void actions.place(task, patch);
    else if (patch) void actions.reschedule(task, patch);
  });
  const selectTask = (id: number, mode: "toggle" | "range") => {
    setSelected((sel) => {
      const next = new Set(sel);
      const from = anchor.current ?? focusId;
      if (mode === "range" && from !== null) {
        const ids = flat.filter((t) => !t.done).map((t) => t.id);
        const a = ids.indexOf(from);
        const b = ids.indexOf(id);
        if (a >= 0 && b >= 0) {
          for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x);
          return next;
        }
      }
      if (next.has(id)) next.delete(id);
      else next.add(id);
      anchor.current = id;
      return next;
    });
  };
  const selectedTasks = useMemo(() => flat.filter((t) => selected.has(t.id)), [flat, selected]);
  const tags = useMemo(() => topTags(allTasks), [allTasks]);
  const projectColors = useMemo(
    () => Object.fromEntries(projectStats.flatMap((p) => (p.color ? [[p.name, p.color] as [string, string]] : []))),
    [projectStats],
  );
  const city = useMemo(() => buildCity(cityWins, allTasks, projectStats, floorList, today), [cityWins, allTasks, projectStats, floorList, today]);
  // The board's columns: Inbox's days, or a building's floors from the ground up.
  const boardColumns = useMemo((): BoardColumn[] => {
    if (!boardView) return [];
    const keep = (ts: Task[]) => (showDone ? ts : ts.filter((t) => !t.done));
    const short = (iso: string) => parseISODate(iso).toLocaleDateString(LOCALE, { weekday: "short", day: "numeric" });
    if (list === "inbox") {
      return rawGroups
        .filter((g) => g.key.startsWith("in:"))
        .map((g) => {
          const col = g.key.slice(3) as InboxColumn;
          const day = inboxColumnDay(col, now);
          const sub =
            col === "someday" ? "no date" : col === "week" ? `to ${short(toISODate(addDays(now, 7)))}` : col === "later" ? "" : day ? short(day) : "";
          return {
            key: g.key,
            label: g.label,
            sub,
            tasks: keep(g.tasks),
            drop: day ? { iso: day } : { nodate: true },
            add: day ? { due_date: day, project: null } : { due_date: null, someday: true, project: null },
            showDay: col === "week" || col === "later",
          };
        });
    }
    const name = viewedProject!;
    const b = city.buildings.find((x) => x.project === name);
    const floors = b ? [...b.floors].sort(bySection) : [];
    if (!floors.some((f) => f.name === null)) floors.unshift({ name: null, label: CITY.looseHeading, level: 0, rooms: [], per: 1, levels: 1, size: 1 });
    const shown = keep(rawGroups.flatMap((g) => g.tasks));
    return floors.map((f) => ({
      key: `fl:${f.name ?? ""}`,
      label: f.name ?? CITY.looseHeading,
      tasks: shown.filter((t) => (t.heading ?? null) === f.name),
      drop: { place: { project: name, heading: f.name } },
      add: { project: name, heading: f.name },
      showDay: true,
    }));
  }, [boardView, list, rawGroups, showDone, now, city, viewedProject]);
  // Milestones: the highest population ever reached keeps what's built.
  const peak = settings?.city_peak ?? 0;
  const reached = Math.max(city.total, peak);
  const cityShown = useMemo(() => ({ ...city, reached }), [city, reached]);
  const [celebrate, setCelebrate] = useState<Milestone[]>([]);
  const cheered = useRef(0);
  useEffect(() => {
    if (!settings || !full || city.total === 0) return;
    const seen = Math.max(settings.city_seen ?? 0, cheered.current);
    const fresh = newMilestones(seen, reached);
    const patch: Partial<AppSettings> = {};
    if (city.total > peak) patch.city_peak = city.total;
    if (fresh.length) {
      const top = fresh[fresh.length - 1].at;
      cheered.current = top;
      patch.city_seen = top;
      show(`🎉 ${cheerFor(fresh)} Open your city to see it.`);
      setCelebrate(fresh);
    }
    if (Object.keys(patch).length) void patchSettings(patch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reached, city.total, peak, settings?.city_seen, full]);
  // Full screen's add form picks the building and floor.
  const places = useMemo(
    () => city.buildings.filter((b) => b.project).map((b) => ({ name: b.project!, floors: b.floors.filter((f) => f.name).map((f) => f.name!) })),
    [city],
  );
  // Projects and every floor they have (empty ones too), to pick from.
  const fieldPlaces: ProjectInfo[] = useMemo(
    () =>
      projectInfos.map((p) => ({
        name: p.name,
        headings: [...new Set([...(places.find((x) => x.name === p.name)?.floors ?? []), ...p.headings])],
      })),
    [projectInfos, places],
  );

  // Keyboard: Esc, undo, search and list navigation.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // The keys the person picked for actions (T for today…), in the shortcuts sheet.
  const keysRef = useRef(keyMap(settings?.app_keys));
  keysRef.current = keyMap(settings?.app_keys);
  const keyState = useRef({ flat, focusId, capture, tab, query, showKeys, upcoming, selectedTasks, openId, searchOpen, full, cityOpen });
  keyState.current = { flat, focusId, capture, tab, query, showKeys, upcoming, selectedTasks, openId, searchOpen, full, cityOpen };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // A dialog (Send to agent, What it did…) keeps its own keys: Return
      // presses its button, Esc closes it.
      if (e.target instanceof Element && e.target.closest('[role="dialog"]')) return;
      const s = keyState.current;
      // ⌃⌥1…9 switch mode; ⌃⌥0 shows everything.
      if (e.ctrlKey && e.altKey && !e.metaKey && /^Digit[0-9]$/.test(e.code)) {
        const n = Number(e.code.slice(5));
        const modes = settingsRef.current?.modes ?? [];
        if (n === 0 || modes[n - 1]) {
          e.preventDefault();
          void api
            .setViewMode(n === 0 ? null : modes[n - 1].id)
            .then(setSettings)
            .catch(() => undefined);
        }
        return;
      }
      // The city has its own keys.
      if (s.cityOpen) return;
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape" && !e.defaultPrevented) {
        if (s.showKeys) setShowKeys(false);
        else if (s.openId !== null) setOpenId(null);
        else if (s.selectedTasks.length) setSelected(new Set());
        else if (s.capture) setCapture(null);
        else if (s.searchOpen && document.activeElement === searchRef.current) {
          setQuery("");
          setSearchOpen(false);
        } else if (s.tab !== "tasks") setTab("tasks");
        // Full screen is a window to stay in; Esc only hides the side panel.
        else if (!s.full) void api.hidePanel();
        return;
      }
      if (e.ctrlKey && e.metaKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        toggleFullRef.current();
        return;
      }
      if (s.full && mod && e.key === ",") {
        e.preventDefault();
        openSettings();
        return;
      }
      if (s.full && mod && e.altKey && e.code === "Backslash") {
        e.preventDefault();
        togglePaneRef.current();
        return;
      }
      if (s.full && mod && e.key === "\\") {
        e.preventDefault();
        setSideOpen((o) => !o);
        return;
      }
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey && !typingIn(e.target)) {
        if (undoLast()) e.preventDefault();
        return;
      }
      if (s.tab !== "tasks") return;
      if ((mod && (e.key.toLowerCase() === "f" || e.key.toLowerCase() === "k")) || (e.key === "/" && !typingIn(e.target))) {
        e.preventDefault();
        setSearchOpen(true);
        window.setTimeout(() => {
          searchRef.current?.focus();
          searchRef.current?.select();
        }, 0);
        return;
      }
      if (s.upcoming && !typingIn(e.target) && !mod && !e.altKey && !s.capture) {
        // The week has no list to move through; its own few keys.
        const act = actionFor(e.key, keysRef.current);
        let used = true;
        if (act === "add") setAdding(true);
        else if (act === "today_inbox") setList("today");
        else if (e.key === "?") setShowKeys((v) => !v);
        else if (act === "today") setPlanDay(toISODate(new Date()));
        else if (e.key === "ArrowLeft") setPlanDay((d) => toISODate(addDays(parseISODate(d), s.full ? -7 : -1)));
        else if (e.key === "ArrowRight") setPlanDay((d) => toISODate(addDays(parseISODate(d), s.full ? 7 : 1)));
        else used = false;
        if (used) e.preventDefault();
        return;
      }
      // ⌘A selects every open task shown.
      if (mod && e.key.toLowerCase() === "a" && !typingIn(e.target) && !s.upcoming && !s.capture) {
        e.preventDefault();
        setSelected(new Set(s.flat.filter((t) => !t.done).map((t) => t.id)));
        return;
      }
      // With a selection, the usual keys act on all of it.
      const sel = s.selectedTasks;
      if (sel.length && !typingIn(e.target) && !mod && !e.altKey && !s.capture) {
        const act = actionFor(e.key, keysRef.current);
        const iso = (n: number) => toISODate(addDays(new Date(), n));
        const what = sel.length === 1 ? "1 task" : `${sel.length} tasks`;
        let used = true;
        if (e.key === " " || act === "complete") void actions.completeMany(sel).then(() => setSelected(new Set()));
        else if (e.key === "Backspace" || e.key === "Delete") void actions.removeMany(sel).then(() => setSelected(new Set()));
        else if (act === "today") void actions.batch(sel, { due_date: iso(0) }, `Moved ${what} to today`);
        else if (act === "tomorrow") void actions.batch(sel, { due_date: iso(1) }, `Moved ${what} to tomorrow`);
        else if (act === "next_week") void actions.batch(sel, { due_date: iso(7) }, `Moved ${what} to next week`);
        else used = false;
        if (used) {
          e.preventDefault();
          return;
        }
      }
      if (typingIn(e.target) || mod || e.altKey || s.capture) {
        if (e.key === "ArrowDown" && e.target === searchRef.current && s.flat.length) {
          e.preventDefault();
          searchRef.current?.blur();
          setFocusId(s.flat[0].id);
        }
        return;
      }
      const idx = s.flat.findIndex((t) => t.id === s.focusId);
      const current = idx >= 0 ? s.flat[idx] : null;
      const move = (d: number) => {
        if (!s.flat.length) return;
        const next = idx < 0 ? (d > 0 ? 0 : s.flat.length - 1) : Math.min(s.flat.length - 1, Math.max(0, idx + d));
        setFocusId(s.flat[next].id);
        // In full screen the detail pane follows along.
        if (s.full && s.openId !== null) setOpenId(s.flat[next].id);
      };
      const n = Date.now();
      const key = e.key;
      const act = actionFor(key, keysRef.current);
      let handled = true;
      if ((key === "ArrowDown" || key === "ArrowUp") && e.shiftKey) {
        // Shift+↑/↓ grows the selection from the focused task.
        const d = key === "ArrowDown" ? 1 : -1;
        const open = s.flat.filter((t) => !t.done);
        const i = open.findIndex((t) => t.id === s.focusId);
        const next = open[Math.min(open.length - 1, Math.max(0, i + d))];
        if (next) {
          setSelected((sel) => {
            const n2 = new Set(sel);
            if (i >= 0) n2.add(open[i].id);
            n2.add(next.id);
            return n2;
          });
          setFocusId(next.id);
        }
      } else if (key === "ArrowDown" || act === "next") move(1);
      else if (key === "ArrowUp" || act === "previous") move(-1);
      else if (key === "?") setShowKeys((v) => !v);
      else if (act === "today_inbox") setFocusToday((v) => !v);
      else if (act === "add") setAdding(true);
      else if (act === "view") setTodayMode((m) => (m === "list" ? "hours" : "list"));
      else if (!current) handled = false;
      else if (key === " " || act === "complete") void actions.setDone(current, !current.done);
      else if (key === "Enter" || act === "edit") setCommand({ id: current.id, kind: "edit", n });
      else if (key === "ArrowRight") setOpenId(current.id);
      else if (act === "date") setCommand({ id: current.id, kind: "date", n });
      else if (act === "snooze") setCommand({ id: current.id, kind: "snooze", n });
      else if (act === "notes") setCommand({ id: current.id, kind: "notes", n });
      else if (act === "steps") setCommand({ id: current.id, kind: "steps", n });
      else if (act === "project") setCommand({ id: current.id, kind: "project", n });
      else if (act === "today") void actions.reschedule(current, { due_date: toISODate(new Date()) });
      else if (act === "tomorrow") void actions.reschedule(current, { due_date: toISODate(addDays(new Date(), 1)) });
      else if (act === "next_week") void actions.reschedule(current, { due_date: toISODate(addDays(new Date(), 7)) });
      else if (act === "source" && (current.source_url || current.source_bundle))
        void api.openSource(current.id).catch(actions.fail);
      else if (key === "Backspace" || key === "Delete") {
        move(1);
        void actions.remove(current);
      } else handled = false;
      if (handled) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions, undoLast]);

  async function save(task: NewTask) {
    try {
      await api.addTask(task);
      setCapture(null);
      show("Task added");
    } catch (e) {
      setError(String(e));
    }
  }

  async function grantAccess() {
    await api.requestAccessibility();
    setCapture(null);
    void checkStatus();
  }

  // Settings changes one after another, each on top of the last (so two quick
  // changes — the city's name and the mayor's — don't overwrite each other).
  const settingsChain = useRef<Promise<void>>(Promise.resolve());
  function patchSettings(patch: Partial<AppSettings>) {
    settingsChain.current = settingsChain.current.then(async () => {
      try {
        const cur = await api.getSettings();
        setSettings(await api.setSettings({ ...cur, ...patch }));
      } catch (e) {
        setError(String(e));
      }
    });
    return settingsChain.current;
  }

  /** Change some of the look (calendar, city, pane width…) on top of the latest settings. */
  function patchLook(patch: Partial<LookSettings>) {
    settingsChain.current = settingsChain.current.then(async () => {
      try {
        const cur = await api.getSettings();
        setSettings(await api.setSettings({ ...cur, look: { ...lookOf(cur), ...patch } }));
      } catch (e) {
        setError(String(e));
      }
    });
    return settingsChain.current;
  }

  async function saveSettings(next: AppSettings) {
    try {
      setSettings(await api.setSettings(next));
    } catch (e) {
      setError(String(e));
    }
  }

  function toggleTag(tag: string) {
    const words = query.split(/\s+/).filter(Boolean);
    const has = words.some((w) => w.toLowerCase() === tag);
    setQuery(has ? words.filter((w) => w.toLowerCase() !== tag).join(" ") : [...words, tag].join(" "));
    setTab("tasks");
  }

  const open = tasks.filter((t) => !t.done).length;
  const captureLabel = shortcuts ? formatShortcut(shortcuts.capture) : "…";
  const quickLabel = shortcuts?.quick_add ? formatShortcut(shortcuts.quick_add) : null;
  const dueToday = tasks.filter((t) => !t.done && t.due_date !== null && t.due_date <= today).length;
  const onboarding = tour;

  function minimize(next: boolean) {
    setCollapsed(next);
    api.setPanelCollapsed(next).catch((e) => setError(String(e)));
  }

  // The side panel's window buttons, top left as on every Mac window: close
  // (hide), minimize (to the slim bar) and zoom (full screen).
  const controls = (
    <div className="traffic" data-tauri-drag-region>
      <button type="button" className="tl close" onClick={() => void api.hidePanel()} aria-label="Close" title="Close (Esc)">
        <svg viewBox="0 0 12 12" aria-hidden>
          <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" />
        </svg>
      </button>
      <button
        type="button"
        className="tl min"
        onClick={() => minimize(!collapsed)}
        aria-label={collapsed ? "Expand panel" : "Minimize panel"}
        title={collapsed ? "Expand" : "Minimize to a slim bar"}
      >
        <svg viewBox="0 0 12 12" aria-hidden>
          <path d="M3 6h6" />
        </svg>
      </button>
      <button type="button" className="tl zoom" onClick={toggleFull} aria-label="Open full screen" title="Full screen (⌃⌘F)">
        <svg viewBox="0 0 12 12" aria-hidden>
          <path d="M3.2 6.6V8.8h2.2M8.8 5.4V3.2H6.6" />
        </svg>
      </button>
    </div>
  );

  if (collapsed && !full) {
    return (
      <div className="panel collapsed">
        <header className="mini" data-tauri-drag-region onDoubleClick={() => minimize(false)}>
          {controls}
          <span className="mini-title" data-tauri-drag-region>
            TodoCity
          </span>
          <span className="mini-meta" data-tauri-drag-region>
            {open} open{dueToday ? ` · ${dueToday} due` : ""}
          </span>
        </header>
      </div>
    );
  }

  const stats = viewedProject !== null ? projectStats.find((p) => p.name === viewedProject) : undefined;
  // Plain words in the task screens; the city keeps its own.
  const w = full ? CITY : PLAIN;
  // Task screens show the section's own name ("Travel"); floor numbers stay in the city.
  const floorTitle = floorOpen?.floor ?? CITY.looseHeading;
  const weekDays = sevenDays(planDay);
  const rangeText = (() => {
    const a = parseISODate(weekDays[0]);
    const b = parseISODate(weekDays[6]);
    try {
      return new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric" }).formatRange(a, b);
    } catch {
      return `${a.toLocaleDateString(LOCALE)} – ${b.toLocaleDateString(LOCALE)}`;
    }
  })();
  // Full screen's header says only what nothing else on screen says: the
  // day on Today, the week on Calendar. Counts live in the sidebar.
  const fullSub = tab !== "tasks" ? "" : list === "today" && !floorOpen ? now.toLocaleDateString(LOCALE, { weekday: "long", month: "short", day: "numeric" }) : upcoming ? rangeText : "";
  const subText =
    tab !== "tasks"
      ? page === "model"
        ? status?.active_model
          ? `Using ${status.active_model}`
          : "Pick a model to get started"
        : `TodoCity ${status?.version ?? ""}`
      : list === "today"
        ? `${now.toLocaleDateString(LOCALE, { weekday: "long", month: "short", day: "numeric" })} · ${w.toDo(listCounts.today)}`
        : list === "upcoming"
          ? full
            ? rangeText
            : "Your week, hour by hour"
          : list === "inbox"
            ? `Tasks in no project · ${w.open(listCounts.inbox)}`
            : list === "overdue"
              ? listCounts.overdue
                ? `${listCounts.overdue} past their day, time or deadline`
                : "All caught up"
              : list === "agents"
                ? "Tasks you handed to agents, and how each is going"
              : list === "logbook"
                ? "Everything you've finished"
                : stats
                  ? w.progress(stats.open, stats.done)
                  : "";

  const hideBanner = (id: string) => {
    const next = [...hidden, id];
    setHidden(next);
    remember("todocity.banners.hidden", next.join(","));
  };
  const banners = (
    <>
      {/* Full screen shows a quiet "Update ready" pill in its footer instead. */}
      {tab !== "settings" && !full && <UpdateBanner update={update} onError={setError} />}
      {status &&
        !status.accessibility &&
        settings?.double_copy === false &&
        !capture &&
        !onboarding &&
        !hidden.includes("access") && (
          <Banner
            tone="info"
            action={{ label: "Allow", run: grantAccess }}
            onDismiss={() => hideBanner("access")}
          >
            Allow Accessibility so your shortcut can pick up selected text.
          </Banner>
        )}
      {tab === "tasks" &&
        status?.engine === "bundled" &&
        !status.active_model &&
        !onboarding &&
        !hidden.includes("model") && (
          <Banner
            tone="info"
            action={{ label: "Set up", run: () => openSettings("model") }}
            onDismiss={() => hideBanner("model")}
          >
            Add the on-device model to turn selected text into tasks.
          </Banner>
        )}
      {error && (
        <Banner tone="error" action={{ label: "Dismiss", run: () => setError(null) }}>
          {error}
        </Banner>
      )}
    </>
  );

  const tourEl = tab === "tasks" && onboarding && (
    <Onboarding
      status={status}
      shortcuts={shortcuts}
      onShortcuts={setShortcuts}
      settings={settings}
      onSettings={setSettings}
      taskCount={tasks.length}
      hidden={!!capture}
      onRefreshStatus={refreshStatus}
      onTry={(text) => void handleCapture({ kind: "text", text, method: "service", source: null })}
      onDone={() => {
        setTour(false);
        if (settings) void saveSettings({ ...settings, onboarding_done: true, seen_version: status?.version ?? null });
      }}
    />
  );

  const captureEl = tab === "tasks" && capture && (
    <CaptureCard state={capture} now={now} onSave={save} onCancel={() => setCapture(null)} onGrantAccess={grantAccess} />
  );

  const searchEl = tab === "tasks" && !onboarding && searchOpen && (
    <div className="search">
      <label className="search-box">
        <SearchIcon />
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search or #tag"
          aria-label="Search tasks"
          spellCheck={false}
        />
        {query && (
          <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}>
            ×
          </button>
        )}
      </label>
      {tags.length > 0 && (
        <div className="tag-row" aria-label="Tags">
          {tags.map((t) => {
            const on = query.toLowerCase().split(/\s+/).includes(t);
            return (
              <button key={t} type="button" className={on ? "tag-chip on" : "tag-chip"} onClick={() => toggleTag(t)}>
                {t}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  const tasksShown = tab === "tasks" && !onboarding;
  // "2 completed · Show": under a list, or above a board.
  const doneToggle = list !== "logbook" && (doneHidden > 0 || (revealDone && !look.show_done)) && (
    <button type="button" className={boardView ? "done-toggle on-board" : "done-toggle"} onClick={() => setRevealDone((v) => !v)}>
      {revealDone ? (
        <>Hide completed</>
      ) : (
        <>
          {doneHidden} completed{list === "today" ? " today" : ""} · <span>Show</span>
        </>
      )}
    </button>
  );
  const listEl = tasksShown && (
    <>
      {/* The side panel has no sidebar, so a project's own actions sit at its top. */}
      {showList && !full && viewedProject !== null && !floorOpen && (
        <ProjectHeader
          name={viewedProject}
          stats={projectStats.find((p) => p.name === viewedProject) ?? null}
          onAddUnder={(heading) => {
            // A new heading (floor) stays even before a task is on it.
            if (heading) void api.addFloor(viewedProject, heading).then(() => refresh(), () => undefined);
            setAddHeading(heading);
            setAdding(true);
          }}
          onRename={async (to) => {
            try {
              await api.renameProject(viewedProject, to);
              setList(projectList(to));
            } catch (e) {
              setError(String(e));
            }
          }}
        />
      )}
      {showList && adding && list !== "logbook" && (
        <AddTaskForm
          places={fieldPlaces}
          tags={tags}
          compact={!full}
          locale={LOCALE}
          defaultDay={list === "today" ? today : null}
          defaultPlace={
            viewedProject !== null
              ? { project: viewedProject, heading: floorOpen ? floorOpen.floor : addHeading }
              : list === "inbox"
                ? { project: null, heading: null }
                : { project: mode?.new_task_project ?? null, heading: null }
          }
          placeholder="What needs doing? Try “send deck fri 3pm p1”"
          onAdd={async (task) => {
            try {
              // No day and no project: it waits in Inbox's Someday until you plan it.
              const loose = !task.due_date && !task.project && !task.someday;
              await api.addTask(loose ? { ...task, someday: true } : task, true);
              show(
                task.due_date
                  ? `Added for ${relativeLabel(task.due_date, new Date(), LOCALE).toLowerCase()}`
                  : loose
                    ? "Added to Inbox, under Someday"
                    : "Task added",
              );
              // Added: the form closes; the add button opens it again.
              setAdding(false);
              setAddHeading(null);
            } catch (e) {
              setError(String(e));
              throw e;
            }
          }}
          onCancel={() => {
            setAdding(false);
            setAddHeading(null);
          }}
        />
      )}
      {list === "logbook" && <Logbook actions={actions} now={now} locale={LOCALE} query={query} onOpenProject={openProject} />}
      {showList && boardView && doneToggle}
      {showList && boardView && (
        <TaskBoard
          columns={boardColumns}
          actions={actions}
          now={now}
          locale={LOCALE}
          drag={drag}
          openId={openId}
          onOpen={setOpenId}
          onAdd={addFromPlan}
        />
      )}
      {full && tab === "tasks" && whoShown === "agents" && visible.some((t) => !t.done) && (
        <div className="agents-banner" role="status">
          <span>
            <b>
              Agents added or changed {visible.filter((t) => !t.done).length} {visible.filter((t) => !t.done).length === 1 ? "task" : "tasks"} here
            </b>{" "}
            <span className="muted">· {agentsBy(agentCounts(visible.map((t) => t.id), latestAgent))}</span>
          </span>
          <span className="spacer" />
          <button
            type="button"
            className="ghost small"
            onClick={() =>
              void api
                .agentUndo({ tasks: visible.map((t) => t.id) })
                .then((n) => show(n ? `Undid what agents did to ${n} ${n === 1 ? "task" : "tasks"}` : "Already as it was"))
                .catch((e) => setError(String(e)))
            }
          >
            Undo all
          </button>
        </div>
      )}
      {full && tab === "tasks" && whoShown === "you" && agentsOn && tasks.some((t) => byAgent(t, now)) && (
        <p className="who-hint">Tasks you added yourself. Tasks from agents are under All and Agents.</p>
      )}
      {showList && list !== "logbook" && !boardView && (
        <TaskList
          groups={viewedProject !== null ? groups.map((g) => (g.key === "h:" ? { ...g, label: w.looseHeading } : g)) : groups}
          plain={!!floorOpen}
          dropProject={viewedProject !== null && !floorOpen && !query.trim() ? viewedProject : undefined}
          actions={actions}
          now={now}
          locale={LOCALE}
          shortcut={captureLabel}
          quickShortcut={quickLabel}
          highlight={highlight}
          focusId={focusId}
          onFocus={setFocusId}
          command={command}
          onTag={toggleTag}
          filtered={!!query.trim()}
          focusToday={focusToday}
          today={today}
          projects={fieldPlaces}
          tags={tags}
          inProject={viewedProject}
          onOpenProject={openProject}
          selected={selected}
          onSelect={selectTask}
          drag={drag}
          openId={openId}
          onOpenTask={setOpenId}
          detail={false}
          rich={full}
          details={look.details}
          emptyNote={
            list === "overdue" && !query.trim() ? (
              <>
                <p className="empty-big">Nothing overdue</p>
                <p>Tasks whose day, time or deadline has passed gather here, so nothing slips by.</p>
              </>
            ) : list === "agents" && !query.trim() ? (
              <>
                <p className="empty-big">Hand a task to an agent</p>
                <p>Point at a task and click the agent button on its right. You'll see how it's going here.</p>
                {!agentsOn && (
                  <p>
                    <button type="button" className="ghost small" onClick={() => setAskAgents(true)}>
                      Let AI apps add and plan tasks
                    </button>
                  </p>
                )}
              </>
            ) : list === "inbox" && !query.trim() ? (
              <>
                <p className="empty-big">Inbox is clear</p>
                <p>Tasks with no project land here — captures, quick adds, ideas for someday.</p>
              </>
            ) : floorOpen && !query.trim() ? (
              <>
                <p className="empty-big">{floorOpen.floor ? `Add a task to ${floorOpen.floor}` : "Tasks with no section go here"}</p>
                <p>
                  <button type="button" className="primary floor-add" onClick={() => setAdding(true)}>
                    <PlusIcon /> {w.addButton}
                  </button>
                </p>
              </>
            ) : viewedProject !== null && !query.trim() ? (
              <>
                <p className="empty-big">{w.emptyProject(viewedProject)}</p>
                <p>
                  Add one with {full ? w.addButton : "+"}, or type “@{viewedProject}” in a new {w.task}.
                </p>
              </>
            ) : undefined
          }
        />
      )}
      {!boardView && doneToggle}
    </>
  );

  const settingsContent = (
    <SettingsContent
      page={page}
      settings={settings}
      onSettings={setSettings}
      shortcuts={shortcuts}
      onShortcuts={setShortcuts}
      status={status}
      update={update}
      onError={setError}
      onTour={() => {
        setTab("tasks");
        setTour(true);
      }}
      onKeys={() => setShowKeys(true)}
      onModelChanged={checkStatus}
      onDone={() => setTab("tasks")}
      onPage={setPage}
      showTitle={full}
    />
  );
  const settingsEl =
    tab === "tasks" ? null : full || !panelHome ? (
      settingsContent
    ) : (
      <SettingsNav
        variant="list"
        page={null}
        settings={settings}
        update={update}
        onPage={(p) => {
          setPage(p);
          setPanelHome(false);
        }}
      />
    );

  const keysSheet = showKeys && (
    <KeysModal
      keys={KEYS}
      appKeys={settings?.app_keys ?? {}}
      onAppKeys={(app_keys) => void patchSettings({ app_keys })}
      hideActions={full ? ["view"] : []}
      shortcuts={shortcuts}
      onShortcuts={setShortcuts}
      doubleCopy={settings?.double_copy !== false}
      onDoubleCopy={(on) => void patchSettings({ double_copy: on })}
      onClose={() => setShowKeys(false)}
    />
  );

  const captureHint =
    settings?.double_copy !== false ? (
      <>
        <kbd>⌘C</kbd> twice
      </>
    ) : (
      <kbd>{captureLabel}</kbd>
    );

  if (full) {
    const openTask = openId !== null ? (allTasks.find((t) => t.id === openId) ?? null) : null;
    // The right side follows the page: a project's tasks, a floor's, or all of them.
    const sideTasks =
      viewedProject === null
        ? tasks
        : allTasks.filter((t) => t.project === viewedProject && (!floorOpen || (t.heading ?? null) === floorOpen.floor));
    const ids = flat.map((t) => t.id);
    const stepTask = (d: -1 | 1) => {
      const i = ids.indexOf(openId ?? -1);
      const next = ids[i + d];
      if (next !== undefined) {
        setOpenId(next);
        setFocusId(next);
      }
    };
    // A task opens in place in the list; one that isn't in it (picked from the
    // calendar or the hours) opens in the detail pane.
    const inList = openTask ? flat.some((t) => t.id === openTask.id) && !upcoming && !boardView : false;
    // The right-hand pane: a task opened from the calendar or a board always
    // shows; the rest (the month and hours, the week's undated tasks) only
    // while the pane is open (the button at the top right).
    const paneOn = paneShown;
    const sidePane = !tasksShown ? null : openTask && !inList ? (
      <TaskDetail
        task={openTask}
        actions={actions}
        now={now}
        locale={LOCALE}
        projects={fieldPlaces}
        tags={tags}
        command={command}
        onClose={() => setOpenId(null)}
        onStep={ids.includes(openTask.id) ? stepTask : undefined}
      />
    ) : agentPane ? (
      <AgentPanel
        clis={clis}
        sessions={termSessions}
        active={activeTerm}
        onActive={setActiveTerm}
        busy={termBusy}
        onStart={(agent, prompt) => void startTerm(agent, { prompt }).catch((e) => setError(String(e)))}
        onCloseSession={(id) => {
          void api
            .termClose(id)
            .then(() => api.termList())
            .then(setTermSessions)
            .catch(() => undefined);
          if (activeTerm === id) setActiveTerm(null);
        }}
        folder={panelFolder}
        home={homeDir}
        onPickFolder={() =>
          void api.pickFolder().then((f) => {
            if (f) keepFolder(null, f);
          })
        }
        fullAccess={!!agentsSt?.full_access}
        onSettings={() => {
          openSettings("agents");
        }}
      />
    ) : !paneOn ? null : upcoming ? (
      <WeekSide
        tasks={tasks}
        days={weekDays}
        today={today}
        now={now}
        locale={LOCALE}
        drag={drag}
        onOpen={(t) => setOpenId(t.id)}
        month={
          <MonthCalendar tasks={tasks} today={today} selected={planDay} locale={LOCALE} weekStart={weekStart} drag={drag} onSelect={setPlanDay} />
        }
      />
    ) : list !== "logbook" ? (
      // Every list: the month at a glance, and the picked day's hours below
      // it — in a project or on a floor, only that project's or floor's tasks.
      <aside className="side-pane plan-pane month-pane" aria-label="Calendar">
        <MonthCalendar
          tasks={sideTasks}
          today={today}
          selected={sideDay}
          locale={LOCALE}
          weekStart={weekStart}
          drag={drag}
          onSelect={setSideDay}
          weekOnly={list === "today"}
          scope={
            viewedProject !== null
              ? { label: floorOpen ? `${viewedProject} · ${floorTitle}` : viewedProject, color: projectColors[viewedProject] }
              : null
          }
        />
        <div className="sp-head">
          <span className="sp-title">
            {sideDay === today ? "Today" : parseISODate(sideDay).toLocaleDateString(LOCALE, { weekday: "long", month: "short", day: "numeric" })}
          </span>
          {showDragHint(!!drag.drag) && <span className="sp-count">Drag a task onto an hour</span>}
        </div>
        <DayPlan
          tasks={sideTasks}
          day={sideDay}
          today={today}
          now={now}
          locale={LOCALE}
          events={sideDay === today && viewedProject === null ? todayEvents : []}
          actions={actions}
          drag={drag}
          onAdd={addFromPlan}
          onOpen={(t) => setOpenId(t.id)}
          // Today's list already shows the untimed ones.
          hoursOnly={list === "today" && sideDay === today}
        />
      </aside>
    ) : null;

    // The window's own buttons, top left as on every Mac window: close
    // (hide TodoCity), minimize to the Dock, and back to the side panel.
    const lights = (
      <div className="traffic" data-tauri-drag-region>
        <button type="button" className="tl close" onClick={() => void api.hidePanel()} aria-label="Close" title="Close (hide TodoCity)">
          <svg viewBox="0 0 12 12" aria-hidden>
            <path d="M3.5 3.5l5 5M8.5 3.5l-5 5" />
          </svg>
        </button>
        <button type="button" className="tl min" onClick={() => void api.minimizePanel().catch((e) => setError(String(e)))} aria-label="Minimize" title="Minimize to the Dock">
          <svg viewBox="0 0 12 12" aria-hidden>
            <path d="M3 6h6" />
          </svg>
        </button>
        <button type="button" className="tl zoom" onClick={toggleFull} aria-label="Back to the side panel" title="Back to the side panel (⌃⌘F)">
          <svg viewBox="0 0 12 12" aria-hidden>
            <path d="M3.2 6.6V8.8h2.2M8.8 5.4V3.2H6.6" />
          </svg>
        </button>
      </div>
    );
    return (
      <ProjectColors.Provider value={projectColors}>
      <SourceDisplay.Provider value={look.show_source}>
      <AgentMarks.Provider value={agentMarks}>
      <AgentRuns.Provider value={runsValue}>
      <WordsContext.Provider value={CITY}>
      <div
        className={["app-full", drag.drag ? "dragging" : "", look.compact ? "compact" : ""].filter(Boolean).join(" ")}
        style={sideW ? ({ "--side-w": `${sideW}px` } as CSSProperties) : undefined}
      >
        <div className="full-row">
        {sideOpen && (
          <Sidebar
            list={list}
            inSettings={tab !== "tasks"}
            onList={(l) => {
              setTab("tasks");
              setList(l);
              setFloorView(null);
              setAdding(false);
              setQuery("");
              setSearchOpen(false);
            }}
            counts={listCounts}
            projects={projectStats}
            modeSwitch={<ModeSwitch settings={settings} onSettings={setSettings} onEdit={() => openSettings("modes")} variant="side" />}
            inMode={mode ? (name) => showsTask(mode, { project: name }) : undefined}
            modeName={mode?.name}
            tags={tags}
            activeTags={query.toLowerCase().split(/\s+/).filter(Boolean)}
            onTag={(t) => {
              setSearchOpen(true);
              toggleTag(t);
            }}
            onSearch={() => {
              setTab("tasks");
              setSearchOpen(true);
              window.setTimeout(() => searchRef.current?.focus(), 0);
            }}
            onSettings={() => (tab === "tasks" ? openSettings() : setTab("tasks"))}
            onKeys={() => setShowKeys(true)}
            onCity={() => setCityOpen("view")}
            cityName={settings?.city_name ?? null}
            mayor={settings?.mayor_name ?? null}
            mayorLook={look.mayor_look}
            dropOn={drag.drag?.over?.place ?? null}
            dragging={!!drag.drag}
            lit={city.total}
            buildings={city.buildings.filter((b) => b.project)}
            floorOn={tab === "tasks" ? floorOpen : null}
            onFloor={(project, floor) => {
              // The floor's own page: its rooms, and adding a room adds it there.
              setTab("tasks");
              setQuery("");
              setAdding(false);
              setOpenId(null);
              setList(projectList(project));
              setFloorView({ project, floor });
            }}
            onNewBuilding={(name) =>
              void api
                .createProject(name)
                .then((made) => {
                  void refresh();
                  if (made) {
                    setTab("tasks");
                    setList(projectList(made));
                    show(`Created ${made}`);
                  }
                })
                .catch((e) => setError(String(e)))
            }
            onNewFloor={(project, name) =>
              void api
                .addFloor(project, name)
                .then(() => refresh())
                .catch((e) => setError(String(e)))
            }
            onRenameBuilding={(from, to) =>
              void api
                .renameProject(from, to)
                .then(() => {
                  void refresh();
                  if (projectOf(list) === from) setList(projectList(to));
                  show(`Renamed ${from} to ${to}`);
                })
                .catch((e) => setError(String(e)))
            }
            onDeleteBuilding={(name) =>
              void api
                .deleteProject(name)
                .then((gone) => {
                  void refresh();
                  if (!gone) {
                    show(`Move or delete the tasks in ${name} first`);
                    return;
                  }
                  if (projectOf(list) === name) setList("today");
                  show(`Deleted ${name}`);
                })
                .catch((e) => setError(String(e)))
            }
            onRenameFloor={(project, from, to) =>
              void api
                .renameFloor(project, from, to)
                .then(() => {
                  void refresh();
                  setFloorView((f) => (f && f.project === project && f.floor === from ? { project, floor: to } : f));
                  show(`Renamed the section to ${to}`);
                })
                .catch((e) => setError(String(e)))
            }
            onColor={(project, color) =>
              void api
                .setProjectColor(project, color)
                .then(() => refresh())
                .catch((e) => setError(String(e)))
            }
            syncable={syncable}
            onStartSync={(project) => {
              show(`Sending ${project} to Todoist…`);
              void api
                .mirrorSyncProject(project)
                .then((r) => {
                  void refresh();
                  show(r.joined ? `${project} now syncs with your Todoist project of the same name` : `${project} now syncs with Todoist`);
                })
                .catch((e) => setError(String(e)));
            }}
            onStopSync={(project) =>
              void api
                .mirrorStopProject(project)
                .then(() => {
                  void refresh();
                  show(`${project} no longer syncs — it's yours now`);
                })
                .catch((e) => setError(String(e)))
            }
            onDeleteFloor={(project, name) =>
              void api
                .deleteFloor(project, name)
                .then((gone) => {
                  void refresh();
                  if (!gone) {
                    show(`Move or delete the tasks in ${name} first`);
                    return;
                  }
                  setFloorView((f) => (f && f.project === project && f.floor === name ? null : f));
                  show(`Deleted the ${name} section`);
                })
                .catch((e) => setError(String(e)))
            }
            lights={lights}
          />
        )}
        <div className="full-main">
          <header className="full-head" data-tauri-drag-region>
            {!sideOpen && lights}
            <button
              type="button"
              className={sideOpen ? "icon" : "icon on"}
              onClick={() => setSideOpen((o) => !o)}
              aria-label={sideOpen ? "Hide sidebar" : "Show sidebar"}
              title={`${sideOpen ? "Hide" : "Show"} sidebar (⌘\\)`}
            >
              <SidebarIcon />
            </button>
            <span className="fh-icon" aria-hidden>
              {tab !== "tasks" ? <LineIcon name="gear" size={20} /> : <HeadIcon list={list} color={viewedProject ? projectColors[viewedProject] : undefined} />}
            </span>
            {/* Where you are, as a breadcrumb: Project › Floor. Earlier steps are links. */}
            <nav className="fh-crumbs" aria-label="You are here" data-tauri-drag-region>
              {tab === "tasks" && floorOpen && (
                <>
                  <button type="button" className="fh-crumb" onClick={() => setFloorView(null)} title={`All of ${floorOpen.project}`}>
                    {floorOpen.project}
                  </button>
                  <span className="fh-crumb-sep" aria-hidden>
                    ›
                  </span>
                </>
              )}
              <h1 className="fh-title" data-tauri-drag-region>
                {tab !== "tasks" ? "Settings" : floorOpen ? floorTitle : listTitle(list)}
              </h1>
            </nav>
            {fullSub && (
              <span className="fh-sub" data-tauri-drag-region>
                {fullSub}
              </span>
            )}
            {tasksShown && list !== "logbook" && whoShown !== "all" && (
              <span className="who-chip">
                {whoLabel(whoShown)}
                <button type="button" aria-label="Show everything" title="Show everything" onClick={() => setWho("all")}>
                  ×
                </button>
              </span>
            )}
            {/* The sidebar shows the mode; with it hidden, a small pill does. */}
            {tab === "tasks" && realMode && !sideOpen && <ModeSwitch settings={settings} onSettings={setSettings} onEdit={() => openSettings("modes")} />}
            {tab === "tasks" && upcoming && (
              <div className="fh-week">
                <button type="button" className="fh-btn" onClick={() => setPlanDay((d) => toISODate(addDays(parseISODate(d), -7)))} aria-label="Previous week" title="Previous week (←)">
                  ‹
                </button>
                <button type="button" className="fh-btn" onClick={() => setPlanDay(today)} title="Seven days from today (T)">
                  Today
                </button>
                <button type="button" className="fh-btn" onClick={() => setPlanDay((d) => toISODate(addDays(parseISODate(d), 7)))} aria-label="Next week" title="Next week (→)">
                  ›
                </button>
              </div>
            )}
            <span className="topbar-gap" data-tauri-drag-region />
            {tasksShown && (
              <ViewMenu
                who={whoShown}
                onWho={setWho}
                agentsOn={agentsOn && list !== "logbook"}
                agentCount={tasks.filter((t) => byAgent(t, now)).length}
                layout={boardKey && !floorOpen ? viewMode : undefined}
                onLayout={setViewMode}
              />
            )}
            {tasksShown && !sideOpen && (
              <button
                type="button"
                className={searchOpen ? "icon on" : "icon"}
                onClick={() => {
                  if (searchOpen) {
                    setSearchOpen(false);
                    setQuery("");
                  } else {
                    setSearchOpen(true);
                    window.setTimeout(() => searchRef.current?.focus(), 0);
                  }
                }}
                aria-label="Search"
                aria-expanded={searchOpen}
                title="Search (⌘K)"
              >
                <SearchIcon />
              </button>
            )}
            {tasksShown && list !== "logbook" && (
              <button type="button" className="primary fh-new" onClick={() => setAdding(true)} title="New task (A)">
                <PlusIcon /> {w.addButton}
              </button>
            )}
            {tasksShown && list !== "logbook" && (
              <button
                type="button"
                className={paneShown ? "icon pane-toggle" : "icon pane-toggle on"}
                onClick={togglePane}
                aria-label={paneShown ? "Hide calendar pane" : "Show calendar pane"}
                aria-pressed={paneShown}
                title={`${paneShown ? "Hide" : "Show"} calendar (⌥⌘\\)`}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="2" y="2.5" width="12" height="11" rx="2" />
                  <path d="M10 2.5v11" />
                </svg>
              </button>
            )}
            {tasksShown && (
              <button
                type="button"
                className={agentPane ? "icon agent-toggle on-pane" : "icon agent-toggle"}
                onClick={() => setAgentPane(!agentPane)}
                aria-label={agentPane ? "Hide agents" : "Show agents"}
                aria-pressed={agentPane}
                title={agentPane ? "Hide agents" : "Agents: Claude Code, Codex and more, with your tasks"}
              >
                <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="1.8" y="2.5" width="12.4" height="11" rx="2" />
                  <path d="M4.5 6.2l2.3 1.8-2.3 1.8M8.6 10h3" />
                </svg>
                {runs.some((r) => r.status === "needs_you" || r.status === "ready") && <span className="icon-dot" aria-label="An agent needs you" />}
              </button>
            )}
          </header>

          {banners}
          {tourEl && <div className="full-tour">{tourEl}</div>}
          {captureEl && <div className="full-capture">{captureEl}</div>}
          {searchEl && <div className="full-search">{searchEl}</div>}

          {tab === "tasks" ? (
            <div className={sidePane ? "full-body with-side" : "full-body"}>
              {upcoming && tasksShown ? (
                <main className="full-content week">
                  {adding && (
                    <AddTaskForm
                      places={fieldPlaces}
                      tags={tags}
                      locale={LOCALE}
                      defaultDay={planDay}
                      defaultPlace={{ project: mode?.new_task_project ?? null, heading: null }}
                      placeholder="What needs doing? Try “call Sam fri 3pm”"
                      onAdd={async (t) => {
                        await addFromPlan(t);
                        setAdding(false);
                      }}
                      onCancel={() => setAdding(false)}
                    />
                  )}
                  <WeekGrid
                    tasks={filterWho(tasks, whoShown, now)}
                    day={planDay}
                    today={today}
                    now={now}
                    locale={LOCALE}
                    actions={actions}
                    drag={drag}
                    onAdd={addFromPlan}
                    onOpen={(t) => setOpenId(t.id)}
                    openId={openId}
                    onSlide={(n) => setPlanDay((d) => toISODate(addDays(parseISODate(d), n)))}
                    onToast={(text, action) => show(text, action)}
                    onError={(e) => setError(e)}
                  />
                </main>
              ) : (
                <main className={boardView ? "full-content board-mode" : "full-content"} data-autoscroll={boardView ? undefined : true}>
                  <div className={boardView ? "full-list wide" : "full-list"}>{listEl}</div>
                </main>
              )}
              {sidePane && (
                <SideResizer
                  width={sideW || defaultSideWidth()}
                  onLive={setLiveSideW}
                  onCommit={(w) => {
                    setLiveSideW(null);
                    void patchLook({ side_width: w });
                  }}
                />
              )}
              {sidePane}
            </div>
          ) : (
            <div className="full-body settings">
              <SettingsNav variant="side" page={page} settings={settings} update={update} onPage={setPage} />
              <main className="fs-content">
                <div className="fs-inner">{settingsEl}</div>
              </main>
            </div>
          )}
        </div>
        </div>
        <FullFooter
          model={status?.active_model ?? null}
          onModel={() => openSettings("model")}
          city={cityShown}
          showCity={settings?.city_corner !== false}
          onCity={() => setCityOpen("view")}
          now={now}
          version={status?.version ?? null}
          update={update}
          onError={setError}
        />

        {tasksShown && !upcoming && selectedTasks.length > 0 && (
          <BatchBar tasks={selectedTasks} actions={actions} projects={projectInfos} onClear={() => setSelected(new Set())} />
        )}
        {cityOpen && (
          <CityView
            city={cityShown}
            celebrate={celebrate}
            onCelebrated={() => setCelebrate([])}
            name={settings?.city_name ?? null}
            now={now}
            locale={LOCALE}
            startSharing={cityOpen === "share"}
            mayor={settings?.mayor_name ?? null}
            onName={(n) => void patchSettings({ city_name: n })}
            onMayor={(m) => void patchSettings({ mayor_name: m || null })}
            onOpenProject={(project) => {
              setCityOpen(null);
              setTab("tasks");
              setQuery("");
              setSearchOpen(false);
              setList(project ? projectList(project) : "inbox");
            }}
            onOpenSomeday={() => {
              setCityOpen(null);
              setTab("tasks");
              setQuery("");
              setSearchOpen(false);
              setList("inbox");
            }}
            onClose={() => setCityOpen(null)}
            onError={actions.fail}
            onSaved={() => show("Saved a picture of your city to Downloads")}
          />
        )}
        <Toasts toasts={toasts} onDismiss={dismiss} />
        {drag.drag && <DragGhost drag={drag.drag} now={now} locale={LOCALE} />}
        {keysSheet}
        {sendDialog}
        {askAgents && (
          <AgentsSetUpDialog
            onClose={() => setAskAgents(false)}
            onSetUp={() => {
              setAskAgents(false);
              openSettings("agents");
            }}
          />
        )}
      </div>
      </WordsContext.Provider>
      </AgentRuns.Provider>
      </AgentMarks.Provider>
      </SourceDisplay.Provider>
      </ProjectColors.Provider>
    );
  }

  return (
    <ProjectColors.Provider value={projectColors}>
    <SourceDisplay.Provider value={look.show_source}>
    <AgentRuns.Provider value={runsValue}>
    <div className={drag.drag ? "panel dragging" : "panel"}>
      <header className="topbar" data-tauri-drag-region>
        {controls}
        {tab === "tasks" ? (
          <ListPicker
            value={list}
            onChange={(l) => {
              setList(l);
              setAdding(false);
              setQuery("");
              setSearchOpen(false);
            }}
            counts={listCounts}
            projects={projectStats}
            tags={tags}
            onTag={(t) => {
              setSearchOpen(true);
              setQuery(t);
            }}
          />
        ) : (
          <button
            type="button"
            className="back-btn"
            onClick={() => (panelHome ? setTab("tasks") : setPanelHome(true))}
            title={panelHome ? "Back to tasks (Esc)" : "All settings"}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M10 3.5 5.5 8l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {panelHome ? "Settings" : pageLabel(page)}
          </button>
        )}
        {tab === "tasks" && realMode && <ModeSwitch settings={settings} onSettings={setSettings} onEdit={() => openSettings("modes")} variant="icon" />}
        <span className="topbar-gap" data-tauri-drag-region />
        {tab === "tasks" && !onboarding && (
          <>
            <button
              type="button"
              className={adding ? "icon accent on" : "icon accent"}
              onClick={() => setAdding((a) => !a)}
              aria-label="Add a task"
              aria-expanded={adding}
              title="Add a task (A)"
            >
              <PlusIcon />
            </button>
            <button
              type="button"
              className={searchOpen ? "icon on" : "icon"}
              onClick={() => {
                if (searchOpen) {
                  setSearchOpen(false);
                  setQuery("");
                } else {
                  setSearchOpen(true);
                  window.setTimeout(() => searchRef.current?.focus(), 0);
                }
              }}
              aria-label="Search"
              aria-expanded={searchOpen}
              title="Search (/)"
            >
              <SearchIcon />
            </button>
          </>
        )}
        <button
          type="button"
          className={tab !== "tasks" ? "icon on" : "icon"}
          onClick={() => (tab === "tasks" ? openSettings() : setTab("tasks"))}
          aria-label="Settings"
          title="Settings"
        >
          <GearIcon />
          {update.state === "ready" && <span className="icon-dot" aria-label="Update ready" />}
        </button>
      </header>

      {tab === "tasks" ? (
        <div className="subline" data-tauri-drag-region>
          <p className="sub" data-tauri-drag-region>
            {subText}
          </p>
          {list === "today" && !onboarding && (
            <ViewSwitch
              value={todayMode}
              options={[
                ["list", "List"],
                ["hours", "Hours"],
              ]}
              onChange={setTodayMode}
              label="Show today as (V)"
            />
          )}
        </div>
      ) : null}

      {tab === "tasks" && list === "today" && !onboarding && (
        <WeekStrip
          tasks={tasks}
          now={now}
          locale={LOCALE}
          drag={drag.drag}
          onPick={(iso) => {
            setPlanDay(iso);
            setList("upcoming");
          }}
        />
      )}

      {banners}
      {tourEl}

      {/* Due-now reminders show where they belong — Today and Overdue — not on every list. */}
      {tasksShown && !capture && (list === "today" || list === "overdue") && (
        <DueNowCard tasks={firing} actions={actions} now={now} locale={LOCALE} compact />
      )}

      {captureEl}
      {searchEl}

      <main className={tasksShown && (upcoming || todayHours) ? "panel-body week" : "panel-body"}>
        {tasksShown && upcoming && (
          <WeekView
            tasks={tasks}
            day={planDay}
            onDay={setPlanDay}
            now={now}
            locale={LOCALE}
            weekStart={weekStart}
            actions={actions}
            adding={adding}
            onAdding={setAdding}
            onAdd={addFromPlan}
            onOpen={showInList}
          />
        )}
        {tasksShown && todayHours && (
          <div className="week-view today-hours">
            {adding && (
              <AddTaskForm
                places={fieldPlaces}
                tags={tags}
                compact
                locale={LOCALE}
                defaultDay={today}
                defaultPlace={{ project: mode?.new_task_project ?? null, heading: null }}
                placeholder="What needs doing? Try “call Sam 3pm”"
                onAdd={async (t) => {
                  await addFromPlan(t);
                  setAdding(false);
                }}
                onCancel={() => setAdding(false)}
              />
            )}
            <DayPlan
              tasks={tasks}
              day={today}
              today={today}
              now={now}
              locale={LOCALE}
              events={todayEvents}
              actions={actions}
              drag={drag}
              onAdd={addFromPlan}
              onOpen={showInList}
            />
          </div>
        )}
        {listEl}
        {settingsEl}
      </main>

      {tab === "tasks" && showList && selectedTasks.length > 0 && (
        <BatchBar tasks={selectedTasks} actions={actions} projects={projectInfos} onClear={() => setSelected(new Set())} />
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
      {drag.drag && <DragGhost drag={drag.drag} now={now} locale={LOCALE} />}

      {keysSheet}

      <footer className="panel-foot" data-tauri-drag-region>
        <span className="local-dot" aria-hidden />
        <span className="foot-text" data-tauri-drag-region>
          On this Mac · {captureHint} to capture
        </span>
        <button type="button" className="foot-keys" onClick={() => setShowKeys(true)} title="Keyboard shortcuts" aria-label="Keyboard shortcuts">
          <KeyboardIcon />
        </button>
      </footer>
      {sendDialog}
    </div>
    </AgentRuns.Provider>
    </SourceDisplay.Provider>
    </ProjectColors.Provider>
  );
}

/** The current list's icon, for full screen's header. */
/** The page's icon in full screen's header: a project's ring, or the list's line icon. */
function HeadIcon({ list, color }: { list: ListId; color?: string }) {
  if (projectOf(list) !== null) return <i className="fh-ring" style={color ? { borderColor: color } : undefined} />;
  const name = list === "today" ? "today" : list === "upcoming" ? "calendar" : list === "logbook" ? "done" : list === "overdue" ? "overdue" : list === "agents" ? "delegate" : "inbox";
  return <LineIcon name={name} size={20} />;
}

function Banner({
  tone,
  children,
  action,
  onDismiss,
}: {
  tone: "warn" | "error" | "info";
  children: ReactNode;
  action?: { label: string; run: () => void | Promise<void> };
  onDismiss?: () => void;
}) {
  return (
    <div className={`banner ${tone}`} role={tone === "error" ? "alert" : "status"}>
      <p>{children}</p>
      <span className="banner-actions">
        {onDismiss && (
          <button type="button" className="banner-later" onClick={onDismiss}>
            Not now
          </button>
        )}
        {action && (
          <button type="button" onClick={() => void action.run()}>
            {action.label}
          </button>
        )}
      </span>
    </div>
  );
}

function SidebarIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M6 2.5v11" />
    </svg>
  );
}

