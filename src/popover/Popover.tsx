import { latestBatch, type BatchNote } from "../lib/agents";
import { AgentIcon } from "../components/WhoSwitch";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { DayPlan } from "../components/DayPlan";
import { DragGhost } from "../components/DragGhost";
import { ViewSwitch } from "../components/ViewSwitch";
import { dropPatch } from "../lib/plan";
import { useTaskDrag } from "../lib/useTaskDrag";
import { agendaFor, agendaHeading, dayMarks, overdueTaskLabel, undatedCount, weekRows } from "../lib/agenda";
import { api, onAgentChanges, onCalendarChanged, onCapture, onInboxChanged, onPopoverFocus, onWatchChanged, onPopoverShown, onSettingsChanged, onShortcutsChanged, onTasksChanged, onUpdateStatus } from "../lib/api";
import { activeMode, showsTask } from "../lib/modes";
import { ModeSwitch } from "../components/ModeSwitch";
import { processCapture } from "../lib/capture";
import { CaptureCard, type CaptureState } from "../components/CaptureCard";
import { monthGrid, monthLabel, shiftMonth, weekStartForLocale, weekdayLabels, type DayCell } from "../lib/calendar";
import { addDays, dayOrderForLocale, parseISODate, relativeLabel, toISODate } from "../lib/dates";
import { findSchedule, repeatShort, timeLabel } from "../lib/schedule";
import { formatShortcut } from "../lib/shortcuts";
import { taskActions } from "../lib/taskActions";
import { linkParts, sourceLabel } from "../lib/taskText";
import type { AppSettings, CalendarEvent, InboxItem, NewTask, Task, UpdateStatus, WatchStatus } from "../lib/types";
import { safeLocale } from "../lib/locale";
import { Toasts, useToasts } from "../components/Toasts";
import { SourceChip, SourceDisplay, useSourceDisplay } from "../components/SourceChip";
import { DueNowCard } from "../components/DueNowCard";
import { dueChip, dueNow, type DueChip } from "../lib/due";
import { FocusCard, type Focus } from "./FocusCard";
import { atProject } from "../components/AddTaskForm";
import { holidaysByDay } from "../lib/holidays";
import { deadlineChip, isDeadlinePhrase } from "../lib/lists";

const LOCALE = safeLocale();

type Mode = "list" | "hours";

function savedMode(): Mode {
  try {
    return localStorage.getItem("todocity.popMode") === "hours" ? "hours" : "list";
  } catch {
    return "list";
  }
}

/**
 * The menu-bar popover: a two-week strip that expands into a month, and the
 * selected day's agenda. Overdue tasks surface on today. Tasks can be checked
 * off and added without opening the main panel.
 */
export default function Popover() {
  const [now, setNow] = useState(() => new Date());
  const today = toISODate(now);
  const [selected, setSelected] = useState(today);
  // First day shown by the two-week strip; it only moves when the selection
  // leaves the visible fortnight, so clicking a day never shifts the grid.
  const [stripAnchor, setStripAnchor] = useState(today);
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState(() => ({ year: now.getFullYear(), month: now.getMonth() }));
  const [allTasks, setTasks] = useState<Task[]>([]);
  // The mode this Mac is in: the dropdown shows only its projects.
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const viewMode = activeMode(settings);
  const tasks = useMemo(() => (viewMode ? allTasks.filter((t) => showsTask(viewMode, t)) : allTasks), [allTasks, viewMode]);
  const [adding, setAdding] = useState(false);
  const quickRef = useRef<HTMLInputElement>(null);
  const [showDone, setShowDone] = useState(false);
  const [shortcut, setShortcut] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [openKey, setOpenKey] = useState(0);
  const [update, setUpdate] = useState<UpdateStatus>({ state: "idle" });
  // The selected day as a list, or in hour blocks. Remembered.
  const [mode, setMode] = useState<Mode>(savedMode);
  const rootRef = useRef<HTMLDivElement>(null);
  const { toasts, show, dismiss, undoLast } = useToasts();
  // A selection captured with the shortcut (or Add to TodoCity), reviewed
  // right here under the menu-bar icon.
  const [capture, setCapture] = useState<CaptureState | null>(null);
  const captureSeq = useRef(0);
  // Events from the Calendar connector for the selected day (empty if off).
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [eventsKey, setEventsKey] = useState(0);
  // All events in the visible weeks, for the holiday dots.
  const [rangeEvents, setRangeEvents] = useState<CalendarEvent[]>([]);
  const actions = useMemo(() => taskActions(show, LOCALE), [show]);
  // Drag a task onto a day (keeps its time) or, in hours, onto a block.
  const taskDrag = useTaskDrag((task, to) => {
    const patch = dropPatch(task, to);
    if (patch) void actions.reschedule(task, patch);
  });
  const drag = taskDrag.drag;
  // Opened by TodoCity itself: a task's time came, or the undated check-in.
  const [focus, setFocus] = useState<Focus | null>(null);
  // Tasks AI agents sent, waiting for review.
  const [inbox, setInbox] = useState<InboxItem[]>([]);
  // What AI agents last did (last day), until it's undone or dismissed.
  const [agentNote, setAgentNote] = useState<BatchNote | null>(null);
  const [noteSeen, setNoteSeen] = useState<string | null>(() => {
    try {
      return localStorage.getItem("todocity.agentNoteSeen");
    } catch {
      return null;
    }
  });
  // Watch mode, for the eye in the header (pause / resume).
  const [watch, setWatch] = useState<WatchStatus | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem("todocity.popMode", mode);
    } catch {
      // Storage unavailable: the choice lasts this session.
    }
  }, [mode]);

  const weekStart = useMemo(() => weekStartForLocale(LOCALE), []);
  const labels = useMemo(() => weekdayLabels(LOCALE, weekStart), [weekStart]);

  const load = useCallback(async () => {
    try {
      setTasks(await api.listTasks(toISODate(new Date())));
      setError(null);
      setInbox(await api.inboxList().catch(() => []));
      setAgentNote(latestBatch(await api.agentActivity().catch(() => []), new Date()));
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Every time the popover opens: back to today, fresh data.
  const reset = useCallback(() => {
    const n = new Date();
    setNow(n);
    setSelected(toISODate(n));
    setStripAnchor(toISODate(n));
    setView({ year: n.getFullYear(), month: n.getMonth() });
    setExpanded(false);
    setAdding(false);
    setShowDone(false);
    setFocus(null);
    setOpenKey((k) => k + 1);
    void load();
  }, [load]);

  useEffect(() => {
    void load();
    api
      .getShortcuts()
      .then((s) => setShortcut(formatShortcut(s.capture)))
      .catch(() => undefined);
    api
      .updateStatus()
      .then(setUpdate)
      .catch(() => undefined);
    api
      .watchStatus()
      .then(setWatch)
      .catch(() => undefined);
    api
      .getSettings()
      .then(setSettings)
      .catch(() => undefined);
    const subs = [
      onTasksChanged(() => void load()),
      onAgentChanges(() => void load()),
      onSettingsChanged(setSettings),
      onInboxChanged(() => void api.inboxList().then(setInbox, () => undefined)),
      onWatchChanged(() => void api.watchStatus().then(setWatch, () => undefined)),
      onPopoverShown(reset),
      onPopoverFocus((f) => {
        setFocus(f);
        void load();
      }),
      onShortcutsChanged((s) => setShortcut(formatShortcut(s.capture))),
      onUpdateStatus(setUpdate),
      onCapture((r) => {
        const seq = ++captureSeq.current;
        void api
          .status()
          .catch(() => null)
          .then((st) => processCapture(r, st, setCapture, () => seq === captureSeq.current));
      }),
    ];
    return () => subs.forEach((p) => void p.then((u) => u()));
  }, [load, reset]);

  useEffect(() => {
    let live = true;
    api
      .calendarEvents(selected, selected)
      .then((e) => live && setEvents(e))
      .catch(() => live && setEvents([]));
    return () => {
      live = false;
    };
  }, [selected, openKey, eventsKey]);

  useEffect(() => {
    const sub = onCalendarChanged(() => setEventsKey((k) => k + 1));
    return () => void sub.then((u) => u());
  }, []);

  // Keep the popover open while a capture is being reviewed.
  useEffect(() => {
    void api.setPopoverPinned(capture !== null).catch(() => undefined);
  }, [capture]);

  function endCapture() {
    captureSeq.current++;
    setCapture(null);
    void api.hidePopover();
  }

  async function saveCapture(task: NewTask) {
    try {
      await api.addTask(task);
      captureSeq.current++;
      setCapture(null);
      show(task.due_date ? `Added for ${relativeLabel(task.due_date, new Date(), LOCALE).toLowerCase()}` : "Task added");
      // Let the confirmation show for a moment, then get out of the way.
      window.setTimeout(() => void api.hidePopover(), 1100);
    } catch (e) {
      setError(String(e));
    }
  }

  // Keyboard shortcuts work as soon as the popover opens.
  useEffect(() => {
    rootRef.current?.focus();
  }, [openKey]);

  const marks = useMemo(() => dayMarks(tasks, today), [tasks, today]);
  const agenda = useMemo(() => agendaFor(tasks, selected, today), [tasks, selected, today]);
  const undated = useMemo(() => undatedCount(tasks), [tasks]);
  const projectNames = useMemo(() => [...new Set(tasks.flatMap((t) => (t.project ? [t.project] : [])))], [tasks]);
  const heading = agendaHeading(selected, today, LOCALE);

  const stripDays = weekRows(stripAnchor, weekStart, 2);
  const cells: DayCell[] = expanded ? monthGrid(view.year, view.month, weekStart) : stripDays;
  const rangeFrom = cells[0]?.iso ?? today;
  const rangeTo = cells[cells.length - 1]?.iso ?? today;
  const holidays = useMemo(() => holidaysByDay(rangeEvents, rangeFrom, rangeTo), [rangeEvents, rangeFrom, rangeTo]);

  useEffect(() => {
    let live = true;
    api
      .calendarEvents(rangeFrom, rangeTo)
      .then((e) => live && setRangeEvents(e))
      .catch(() => live && setRangeEvents([]));
    return () => {
      live = false;
    };
  }, [rangeFrom, rangeTo, openKey, eventsKey]);
  const shownMonth = expanded
    ? view
    : { year: parseISODate(selected).getFullYear(), month: parseISODate(selected).getMonth() };

  function select(iso: string) {
    setSelected(iso);
    if (!stripDays.some((c) => c.iso === iso)) setStripAnchor(iso);
    const d = parseISODate(iso);
    if (expanded && (d.getFullYear() !== view.year || d.getMonth() !== view.month)) {
      setView({ year: d.getFullYear(), month: d.getMonth() });
    }
    setAdding(false);
  }

  function step(n: number) {
    if (expanded) {
      const v = shiftMonth(view.year, view.month, n);
      setView(v);
      // Keep the selection in the visible month.
      const s = parseISODate(selected);
      const day = Math.min(s.getDate(), new Date(v.year, v.month + 1, 0).getDate());
      setSelected(toISODate(new Date(v.year, v.month, day)));
    } else {
      setSelected(toISODate(addDays(parseISODate(selected), 7 * n)));
      setStripAnchor(toISODate(addDays(parseISODate(stripAnchor), 7 * n)));
    }
  }

  function toggleExpanded() {
    const s = parseISODate(selected);
    setView({ year: s.getFullYear(), month: s.getMonth() });
    // Collapsing shows the fortnight around the day picked in month view.
    if (expanded) setStripAnchor(selected);
    setExpanded((e) => !e);
  }

  async function toggleDone(t: Task) {
    // Decide once, before anything async can change `t`.
    const done = !t.done;
    const completedAt = done ? new Date().toISOString() : null;
    // Optimistic: tick immediately, then persist.
    setTasks((ts) => ts.map((x) => (x.id === t.id ? { ...x, done, completed_at: completedAt } : x)));
    await actions.setDone(t, done);
  }

  async function add(task: NewTask) {
    try {
      await api.addTask(task);
      setAdding(false);
      if (task.due_date !== selected && task.due_date) {
        show(`Added for ${relativeLabel(task.due_date, new Date(), LOCALE).toLowerCase()}`);
      }
    } catch (err) {
      setError(String(err));
      throw err;
    }
  }

  function openTask(task: Task) {
    // A drag ends with a click on the row; don't treat it as one.
    if (taskDrag.wasDrag()) return;
    void api.openMain(task.id, "tasks");
  }

  function finishFocus(message?: string) {
    setFocus(null);
    if (message) show(message);
    // Leave a confirmation up for a moment, then get out of the way.
    window.setTimeout(() => void api.hidePopover(), message ? 1100 : 0);
  }

  function openFromFocus(task: Task | null) {
    setFocus(null);
    void api.openMain(task?.id ?? null, "tasks");
  }

  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    const typing = target.tagName === "INPUT";
    if (focusing && !capture) {
      if (e.key === "Escape") {
        e.preventDefault();
        finishFocus();
      } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        if (undoLast()) e.preventDefault();
      }
      return;
    }
    if (capture) {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        endCapture();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (adding) setAdding(false);
      else void api.hidePopover();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !typing) {
      if (undoLast()) e.preventDefault();
      return;
    }
    if (typing) return;
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    if (e.key in moves) {
      e.preventDefault();
      select(toISODate(addDays(parseISODate(selected), moves[e.key])));
    } else if (e.key === "n" || e.key === "+") {
      e.preventDefault();
      quickRef.current?.focus();
    } else if (e.key === "t") {
      e.preventDefault();
      select(today);
    } else if (e.key === "h") {
      e.preventDefault();
      setMode((m) => (m === "hours" ? "list" : "hours"));
    }
  }

  const empty = agenda.overdue.length === 0 && agenda.due.length === 0;
  // Show the focus card only while it has something to show.
  const focusing =
    focus !== null &&
    (focus.kind === "undated" ||
      (focus.kind === "inbox" && inbox.length > 0) ||
      (focus.kind === "due" && focus.ids.some((id) => tasks.some((t) => t.id === id && !t.done))));

  if (capture) {
    return (
      <div ref={rootRef} className="pop pop-capture" key={openKey} onKeyDown={onKey} tabIndex={-1}>
        <header className="pop-capture-head">
          <span className="pop-capture-title">Add to TodoCity</span>
          <IconButton label="Discard (Esc)" onClick={endCapture}>
            <path d="M4 4l8 8M12 4l-8 8" />
          </IconButton>
        </header>
        <div className="pop-capture-body">
          <CaptureCard
            state={capture}
            now={new Date()}
            onSave={saveCapture}
            onCancel={endCapture}
            onGrantAccess={() => {
              void api.requestAccessibility();
              endCapture();
            }}
          />
        </div>
        <Toasts toasts={toasts} onDismiss={dismiss} />
      </div>
    );
  }

  return (
    <SourceDisplay.Provider value={settings?.look?.show_source ?? "always"}>
    <div
      ref={rootRef}
      className={["pop", drag ? "dragging" : "", focusing ? "focusing" : ""].filter(Boolean).join(" ")}
      key={openKey}
      onKeyDown={onKey}
      tabIndex={-1}
    >
      {update.state === "ready" && (
        <button type="button" className="pop-update" onClick={() => void api.installUpdate().catch((e) => setError(String(e)))}>
          TodoCity {update.version} is ready · <strong>Restart to update</strong>
        </button>
      )}
      <header className="pop-head">
        <h1 className="pop-month">
          {monthLabel(LOCALE, shownMonth.year, shownMonth.month).replace(String(shownMonth.year), "").trim()}
          {shownMonth.year !== now.getFullYear() && <span className="pop-year"> {shownMonth.year}</span>}
        </h1>
        <div className="pop-actions">
          {selected !== today && (
            <button type="button" className="pop-today" onClick={() => select(today)}>
              Today
            </button>
          )}
          <IconButton label={expanded ? "Previous month" : "Previous week"} onClick={() => step(-1)}>
            <path d="M10 3.5 5.5 8l4.5 4.5" />
          </IconButton>
          <IconButton label={expanded ? "Next month" : "Next week"} onClick={() => step(1)}>
            <path d="M6 3.5 10.5 8 6 12.5" />
          </IconButton>
          {watch?.settings.enabled && (
            <IconButton
              label="Check what's on screen for to-dos"
              onClick={() =>
                void api
                  .watchCheckNow()
                  .then((m) => show(m))
                  .catch((e) => show(String(e), undefined, "error"))
              }
            >
              <path d="M7 12.5A5.5 5.5 0 1 1 7 1.5a5.5 5.5 0 0 1 0 11Z" />
              <path d="m11 11 3.5 3.5M4.6 7l1.6 1.6L9.4 5.4" />
            </IconButton>
          )}
          {watch?.settings.enabled && (
            <IconButton
              label={
                watch.live.state === "paused"
                  ? "Watching is paused — click to resume"
                  : `Watching ${watch.live.current ?? "your screen"} for to-dos — click to pause for an hour`
              }
              onClick={() => void api.watchPause(watch.live.state === "paused" ? 0 : 60).then(setWatch, () => undefined)}
            >
              {watch.live.state === "paused" ? (
                <>
                  <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4Z" />
                  <path d="M3 13 13 3" />
                </>
              ) : (
                <>
                  <path d="M2 8s2.2-4 6-4 6 4 6 4-2.2 4-6 4-6-4-6-4Z" />
                  <circle cx="8" cy="8" r="1.8" />
                </>
              )}
            </IconButton>
          )}
          <ModeSwitch settings={settings} onSettings={setSettings} onEdit={() => void api.openMain(null, "settings")} variant="icon" />
          <IconButton label="Open TodoCity" onClick={() => void api.openMain(null, null)}>
            <rect x="2.5" y="3" width="11" height="10" rx="2" />
            <path d="M9.5 3v10" />
          </IconButton>
        </div>
      </header>

      <div className="pop-cal">
        <div className="pop-grid" role="grid" aria-label="Calendar">
          {labels.map((l, i) => (
            <span key={`dow${i}`} className="pop-dow" aria-hidden>
              {l}
            </span>
          ))}
          {cells.map((c) => {
            const m = marks.get(c.iso);
            const holiday = holidays.get(c.iso);
            const cls = [
              "pop-day",
              c.inMonth ? "" : "out",
              c.iso === today ? "today" : "",
              c.iso === selected ? "on" : "",
              c.iso < today ? "past" : "",
              drag?.over?.iso === c.iso && drag.over.hour === undefined ? "drop" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={c.iso}
                type="button"
                className={cls}
                data-iso={c.iso}
                onClick={() => select(c.iso)}
                aria-pressed={c.iso === selected}
                aria-label={`${parseISODate(c.iso).toLocaleDateString(LOCALE, {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })}${holiday ? `, ${holiday.join(", ")}` : ""}${m ? `, ${m.open} open` : ""}`}
                title={holiday?.join(", ")}
              >
                <span className="pop-num">{c.day}</span>
                <span className="pop-dots" aria-hidden>
                  {m && <span className={m.overdue ? "pop-dot late" : "pop-dot"} />}
                  {holiday && <span className="pop-dot holiday" />}
                  {!m && !holiday && <span className="pop-dot none" />}
                </span>
              </button>
            );
          })}
        </div>
        <button
          type="button"
          className={expanded ? "pop-expand up" : "pop-expand"}
          onClick={toggleExpanded}
          aria-label={expanded ? "Show two weeks" : "Show the whole month"}
          aria-expanded={expanded}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M3.5 6 8 10.5 12.5 6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <section className={mode === "hours" ? "pop-agenda hours" : "pop-agenda"} aria-label="Agenda">
        <div className="pop-ah-row">
          <h2 className="pop-ah">
            {heading.lead && <span className="lead">{heading.lead}</span>}
            {heading.lead && <span className="sep"> · </span>}
            <span>{heading.date}</span>
          </h2>
          <ViewSwitch
            value={mode}
            options={[
              ["list", "List"],
              ["hours", "Day"],
            ]}
            onChange={setMode}
            label="Show the day as (H)"
          />
        </div>

        {agentNote && agentNote.batch !== noteSeen && (
          <AgentNote
            note={agentNote}
            onUndo={() =>
              void api
                .agentUndo({ batch: agentNote.batch })
                .then(load)
                .catch((e) => setError(String(e)))
            }
            onSee={() => {
              try {
                localStorage.setItem("todocity.who", "agents");
              } catch {
                // The main window opens on its last view.
              }
              void api.openMain(null, "tasks");
            }}
            onDismiss={() => {
              setNoteSeen(agentNote.batch);
              try {
                localStorage.setItem("todocity.agentNoteSeen", agentNote.batch);
              } catch {
                // Hidden for this session.
              }
            }}
          />
        )}

        {inbox.length > 0 && (
          <button type="button" className="pop-inbox" onClick={() => setFocus({ kind: "inbox" })}>
            <span aria-hidden>✦</span>
            <span>
              {inboxLabel(inbox)}
            </span>
            <b>Review</b>
          </button>
        )}

        {mode === "list" && events.length > 0 && <EventList events={events} day={selected} now={now} />}

        {selected === today && mode === "list" && (
          <DueNowCard tasks={dueNow(tasks, new Date())} actions={actions} now={new Date()} locale={LOCALE} compact />
        )}

        {mode === "hours" && (
          <DayPlan
            compact
            tasks={tasks}
            day={selected}
            today={today}
            now={new Date()}
            locale={LOCALE}
            events={events}
            actions={actions}
            drag={taskDrag}
            onAdd={add}
            onOpen={openTask}
          />
        )}

        {mode === "list" && agenda.overdue.length > 1 && selected === today && (
          <button type="button" className="pop-move" onClick={() => void actions.moveAll(agenda.overdue, today)}>
            Move {agenda.overdue.length} overdue to today
          </button>
        )}

        {error && <p className="pop-error">{error}</p>}

        {mode === "list" && (
        <ul className="pop-list">
          {agenda.overdue.map((t) => (
            <Row
              key={t.id}
              task={t}
              chip={dueChip(t, new Date(), LOCALE) ?? { tone: "overdue", label: overdueTaskLabel(t, today) }}
              meta={rowMeta(t).join(" · ") || null}
              tone="late"
              onToggle={toggleDone}
              onOpen={openTask}
              onPointerDown={taskDrag.start}
              dragging={drag?.task.id === t.id}
            />
          ))}
          {agenda.due.map((t) => (
            <Row
              key={t.id}
              task={t}
              chip={dueChip(t, new Date(), LOCALE)}
              meta={rowMeta(t).join(" · ") || (t.notes ? null : snippet(t.source_text))}
              tone={dueChip(t, new Date(), LOCALE)?.tone === "overdue" ? "late" : "due"}
              onToggle={toggleDone}
              onOpen={openTask}
              onPointerDown={taskDrag.start}
              dragging={drag?.task.id === t.id}
            />
          ))}
        </ul>
        )}

        {mode === "list" && empty && !adding && (
          <div className="pop-empty">
            <p className="big">{selected === today ? "You're all clear today." : "Nothing due this day."}</p>
            <p>
              <button type="button" className="pop-link" onClick={() => quickRef.current?.focus()}>
                Add a task
              </button>
              {shortcut && (
                <>
                  {" "}
                  or select text anywhere and press <kbd>{shortcut}</kbd>
                </>
              )}
            </p>
          </div>
        )}

        {mode === "list" && agenda.done.length > 0 && (
          <div className="pop-done">
            <button type="button" className="pop-done-toggle" onClick={() => setShowDone((s) => !s)}>
              {showDone ? "Hide" : "Show"} completed · {agenda.done.length}
            </button>
            {showDone && (
              <ul className="pop-list">
                {agenda.done.map((t) => (
                  <Row key={t.id} task={t} chip={null} meta={null} tone="done" onToggle={toggleDone} onOpen={openTask} />
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <footer className="pop-foot">
        <QuickField
          inputRef={quickRef}
          placeholder={`Add to ${heading.lead ? heading.lead.toLowerCase() : heading.date.split(",")[0]}…`}
          day={selected}
          projects={projectNames}
          onAdd={add}
        />
        {undated > 0 ? (
          <button
            type="button"
            className="pop-link"
            onClick={() => void api.openMain(null, "tasks")}
            title="Plan tasks that have no date"
          >
            {undated} undated
          </button>
        ) : (
          shortcut && <span className="pop-hint"><kbd>{shortcut}</kbd></span>
        )}
      </footer>
      {focusing && focus && (
        // Clicking the blurred popover around the card shows it again.
        <div className="pop-focus" onClick={(e) => e.target === e.currentTarget && setFocus(null)}>
          <FocusCard
            focus={focus}
            tasks={tasks}
            inbox={inbox}
            actions={actions}
            locale={LOCALE}
            onFinish={finishFocus}
            onOpen={openFromFocus}
          />
        </div>
      )}
      <Toasts toasts={toasts} onDismiss={dismiss} />
      {drag && <DragGhost drag={drag} now={now} locale={LOCALE} />}
    </div>
    </SourceDisplay.Provider>
  );
}

/** Repeat and source, for the line under a title (time is in the chip). */
/** "2 tasks from Claude", "1 to-do noticed in Slack", "3 to review". */
function inboxLabel(items: InboxItem[]): string {
  const n = items.length;
  const names = [...new Set(items.map((i) => i.agent))];
  const who = names.length === 1 ? names[0] : null;
  if (items.every((i) => i.source === "watch")) {
    return `${n === 1 ? "1 to-do" : `${n} to-dos`} noticed${who ? ` in ${who}` : ""}`;
  }
  if (items.every((i) => i.source !== "watch")) {
    return `${n === 1 ? "1 task" : `${n} tasks`} from ${who ?? "AI agents"}`;
  }
  return `${n} suggested tasks`;
}

function rowMeta(t: Task): string[] {
  const parts: string[] = [];
  if (t.evening) parts.push("Evening");
  if (t.checklist?.length) parts.push(`${t.checklist.filter((c) => c.done).length}/${t.checklist.length} steps`);
  if (t.project) parts.push(t.project);
  const r = repeatShort(t.recurrence);
  if (r) parts.push(r);
  return parts;
}

function Row({
  task,
  chip,
  meta,
  tone,
  onToggle,
  onOpen,
  onPointerDown,
  dragging,
}: {
  task: Task;
  chip: DueChip | null;
  meta: string | null;
  tone: "late" | "due" | "done";
  onToggle: (t: Task) => void;
  onOpen: (t: Task) => void;
  onPointerDown?: (e: ReactPointerEvent, t: Task) => void;
  dragging?: boolean;
}) {
  const deadline = task.done ? null : deadlineChip(task, new Date(), LOCALE);
  const hasSource = useSourceDisplay() !== "never" && !!sourceLabel(task);
  return (
    <li
      className={`pop-row ${tone}${task.done ? " checked" : ""}${dragging ? " lifted" : ""}`}
      onPointerDown={onPointerDown ? (e) => onPointerDown(e, task) : undefined}
    >
      <button
        type="button"
        className="pop-check"
        data-nodrag
        onClick={() => onToggle(task)}
        aria-label={task.done ? `Mark “${task.title}” not done` : `Mark “${task.title}” done`}
        aria-pressed={task.done}
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4">
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className="pop-main">
        <button
          type="button"
          className="pop-body"
          onClick={() => onOpen(task)}
          title="Open in TodoCity · drag onto a day to move it"
        >
          <span className="pop-title">{task.title}</span>
        </button>
        {/* Outside the row's button, so where it came from can be a link of its own. */}
        {(chip || meta || deadline || hasSource) && (
          <span className="pop-meta" onClick={() => onOpen(task)}>
            {chip && <span className={`due-chip ${chip.tone}`}>{chip.label}</span>}
            {deadline && <span className={`due-chip deadline ${deadline.tone}`}>⚑ {deadline.label}</span>}
            {meta && <span className="pop-meta-text">{meta}</span>}
            {hasSource && <SourceChip task={task} />}
          </span>
        )}
        {task.notes?.trim() && !task.done && <RowNotes text={task.notes} />}
      </div>
    </li>
  );
}

/** A task's description under its title; links open in the browser. */
function RowNotes({ text }: { text: string }) {
  return (
    <p className="pop-notes" title={text}>
      {linkParts(text.trim()).map((p, i) =>
        p.url ? (
          <a
            key={i}
            href={p.url}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void api.openUrl(p.url!).then(() => api.hidePopover()).catch(() => undefined);
            }}
          >
            {p.url.replace(/^(https?:\/\/(www\.)?|mailto:)/i, "").replace(/\/$/, "")}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  );
}

function IconButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={active ? "pop-icon on" : "pop-icon"}
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {children}
      </svg>
    </button>
  );
}

/** First line of the original selection, as context under the title. */
function snippet(source: string | null): string | null {
  if (!source) return null;
  const line = source.replace(/\s+/g, " ").trim();
  return line.length > 70 ? `${line.slice(0, 69)}…` : line || null;
}

/** The selected day's calendar events, above its tasks. */
function EventList({ events, day, now }: { events: CalendarEvent[]; day: string; now: Date }) {
  const [all, setAll] = useState(false);
  const shown = all ? events : events.slice(0, 4);
  const hhmm = (t: string) => timeLabel(t.slice(11, 16), LOCALE);
  const nowStr = `${toISODate(now)}T${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:00`;
  return (
    <ul className="pop-events" aria-label="Calendar">
      {shown.map((e) => {
        const when = e.all_day
          ? "All day"
          : e.start.slice(0, 10) < day
            ? `Until ${hhmm(e.end)}`
            : e.end.slice(0, 10) > day
              ? `From ${hhmm(e.start)}`
              : `${hhmm(e.start)} – ${hhmm(e.end)}`;
        const past = !e.all_day && e.end <= nowStr;
        return (
          <li key={`${e.id}${e.start}`} className={past ? "pop-event past" : "pop-event"} title={e.calendar}>
            <span className="pop-event-bar" style={{ background: e.color ?? "var(--faint)" }} aria-hidden />
            <span className="pop-event-title">{e.title || "Busy"}</span>
            <span className="pop-event-time">{when}</span>
          </li>
        );
      })}
      {events.length > 4 && (
        <li>
          <button type="button" className="pop-event-more" onClick={() => setAll((a) => !a)}>
            {all ? "Show fewer" : `${events.length - 4} more event${events.length - 4 === 1 ? "" : "s"}`}
          </button>
        </li>
      )}
    </ul>
  );
}


/** The one-line add field at the bottom: “call Sam 3pm @Work” → a task on the selected day. */
function QuickField({
  inputRef,
  placeholder,
  day,
  projects,
  onAdd,
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  placeholder: string;
  day: string;
  projects: string[];
  onAdd: (task: NewTask) => Promise<void>;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    if (!text.trim() || busy) return;
    const at = atProject(text, projects);
    const f = findSchedule(at.rest, new Date(), dayOrderForLocale(LOCALE));
    const title = (f.title || at.rest).trim();
    if (!title) return;
    setBusy(true);
    try {
      await onAdd({
        title,
        due_date: f.date ?? day,
        due_time: f.date ? f.time : null,
        recurrence: f.repeat ?? null,
        deadline: f.date && isDeadlinePhrase(f.matched) ? f.date : null,
        project: at.project,
        source_text: null,
      });
      setText("");
    } catch {
      // The error is shown; keep what was typed.
    } finally {
      setBusy(false);
    }
  }
  return (
    <label className="pop-quick">
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
        <path d="M8 3v10M3 8h10" strokeLinecap="round" />
      </svg>
      <input
        ref={inputRef}
        value={text}
        maxLength={200}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") void submit();
          if (e.key === "Escape") {
            if (text) setText("");
            else (e.target as HTMLInputElement).blur();
          }
        }}
      />
    </label>
  );
}

/** "Claude planned your day: timed 5 tasks." with Undo and See what changed. */
function AgentNote({ note, onUndo, onSee, onDismiss }: { note: BatchNote; onUndo: () => void; onSee: () => void; onDismiss: () => void }) {
  const at = new Date(note.at).toLocaleTimeString(LOCALE, { hour: "numeric", minute: "2-digit" });
  return (
    <div className="pop-agent-note" role="status">
      <span className="pop-agent-icon" aria-hidden>
        <AgentIcon size={12} />
      </span>
      <span className="pop-agent-body">
        <span className="pop-agent-text">
          <b>{note.agent}</b> · {at}
          <br />
          {note.summary}
        </span>
        <span className="pop-agent-actions">
          <button type="button" className="pop-agent-btn" onClick={onUndo}>
            Undo
          </button>
          <button type="button" className="pop-agent-btn" onClick={onSee}>
            See what changed
          </button>
        </span>
      </span>
      <button type="button" className="pop-agent-x" aria-label="Hide" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
