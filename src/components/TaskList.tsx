import { useWords } from "../lib/words";
import { playDone } from "../lib/doneSound";
import { type CSSProperties, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useProjectColor } from "../lib/colors";
import { CalendarIcon } from "./icons";
import { SnoozeBar } from "./SnoozeBar";
import { Checklist, stepsLabel } from "./Checklist";
import type { ProjectInfo } from "./ProjectPicker";
import { SourceChip, useSourceDisplay } from "./SourceChip";
import { AgentRunCard, AgentRunPill, AgentRuns, DelegateButton, useAgentRun } from "./AgentRuns";
import { AgentMark, useIsAgentTask } from "./WhoSwitch";
import { endOf } from "../lib/timeblock";
import { LineIcon } from "./LineIcon";
import { TaskFields, type FieldMenu, type FieldValues } from "./TaskFields";
import { deadlineChip } from "../lib/lists";
import { dueChip } from "../lib/due";
import { api } from "../lib/api";
import type { DayGroup } from "../lib/grouping";
import { findSchedule, repeatLabel, timeLabel } from "../lib/schedule";
import { dayOrderForLocale, relativeLabel, toISODate } from "../lib/dates";
import type { TaskDrag } from "../lib/useTaskDrag";
import type { TaskActions } from "../lib/taskActions";
import { linkParts, priorityColor, sourceLabel, tagsOf, titleParts, toggleTag } from "../lib/taskText";
import type { ChecklistItem, Task, TaskPatch } from "../lib/types";

/** A keyboard command for one row (from the panel's shortcuts). */
export interface RowCommand {
  id: number;
  kind: "edit" | "date" | "snooze" | "notes" | "steps" | "project";
  /** Changes every time, so repeating the same command re-triggers it. */
  n: number;
}

interface Props {
  groups: DayGroup[];
  actions: TaskActions;
  now: Date;
  locale: string;
  /** Current capture shortcut, for the empty state. */
  shortcut: string;
  quickShortcut: string | null;
  /** Task to scroll to and flash (picked from the menu bar). */
  highlight: number | null;
  /** Keyboard focus (arrow keys). */
  focusId: number | null;
  onFocus: (id: number) => void;
  command: RowCommand | null;
  onTag: (tag: string) => void;
  /** A search or tag filter is active. */
  filtered: boolean;
  /** Today-only focus is on. */
  focusToday: boolean;
  today: string;
  /** Projects to move tasks into. */
  projects: ProjectInfo[];
  /** The project being viewed (its name isn't repeated on each row). */
  inProject: string | null;
  onOpenProject: (name: string) => void;
  /** Shown when there are no groups (instead of the general empty state). */
  emptyNote?: ReactNode;
  /** Selected for batch actions (⌘-click / Shift-click). */
  selected: Set<number>;
  onSelect: (id: number, mode: "toggle" | "range") => void;
  /** Drag rows onto a day (the week strip). */
  drag?: TaskDrag;
  /** The task opened as a card, if any. */
  openId: number | null;
  onOpenTask: (id: number | null) => void;
  /** An opened task shows in a detail pane, not in place. */
  detail?: boolean;
  /**
   * Full screen: each row shows its notes and sub-tasks underneath, and a
   * task opens in place with every property as a labelled row.
   */
  rich?: boolean;
  /** No section headers (a section's own page already says which section). */
  plain?: boolean;
  /** In a project's list: each section takes dropped tasks (drag a task between sections). */
  dropProject?: string;
  /** With `rich`: show notes and sub-tasks under each row (Preferences). */
  details?: boolean;
  /** Tags in use, to pick from in an open task. */
  tags?: string[];
}

export function TaskList(props: Props) {
  const { groups, shortcut, quickShortcut, filtered, focusToday, actions, today, emptyNote } = props;
  if (!groups.length && emptyNote) return <div className="empty">{emptyNote}</div>;
  if (!groups.length && focusToday && !filtered) {
    return (
      <div className="empty">
        <EmptyArt />
        <p className="empty-big">Nothing left for today</p>
        <p>{props.rich ? "Open Calendar in the sidebar to see what’s next." : "Open Calendar in the list menu to see what’s next."}</p>
      </div>
    );
  }
  if (!groups.length) {
    if (filtered) {
      return (
        <div className="empty">
          <p className="empty-big">No matching tasks</p>
          <p>Try fewer words, or clear the filter.</p>
        </div>
      );
    }
    return (
      <div className="empty">
        <EmptyArt />
        <p className="empty-big">All clear</p>
        <p>
          Select text in any app and press <kbd>{shortcut}</kbd>
          {quickShortcut && (
            <>
              , or press <kbd>{quickShortcut}</kbd> to type a task
            </>
          )}
          .
        </p>
      </div>
    );
  }
  return (
    <div className={props.openId !== null && !props.detail ? "groups has-open" : "groups"}>
      {groups.map((g) => {
        // A section of the project being viewed: drop a dragged task here to move it in.
        const section = props.dropProject && g.key.startsWith("h:") ? g.key.slice(2) : null;
        const over = props.drag?.drag?.over?.place;
        const dropHere =
          section !== null &&
          !!over &&
          over.project === props.dropProject &&
          (over.heading ?? "") === section &&
          (props.drag?.drag?.task.heading ?? "") !== section;
        return (
        <section
          key={g.key}
          className={[`group tone-${g.tone}`, dropHere ? "drop" : ""].filter(Boolean).join(" ")}
          aria-label={g.label}
          data-group={g.key}
          data-drop-project={section !== null ? props.dropProject : undefined}
          data-drop-floor={section !== null ? section : undefined}
        >
          <h2 className={props.plain ? "day sr-only" : "day"}>
            {g.label}
            <span className="count">{g.tasks.length}</span>
            {g.key === "overdue" && g.tone === "overdue" && (
              <button
                type="button"
                className="day-action"
                onClick={() => void actions.moveAll(g.tasks, today)}
                title="Move every overdue task to today"
              >
                Move to today
              </button>
            )}
          </h2>
          <ul>
            {g.tasks.map((t) => (
              <TaskRow key={t.id} task={t} {...props} />
            ))}
            {section !== null && !g.tasks.length && <li className="group-empty">Drag a task here</li>}
          </ul>
        </section>
        );
      })}
    </div>
  );
}

function TaskRow({
  task,
  actions,
  now,
  locale,
  highlight,
  focusId,
  onFocus,
  command,
  onTag,
  projects,
  inProject,
  onOpenProject,
  selected,
  onSelect,
  drag,
  openId,
  onOpenTask,
  detail,
  rich,
  details = true,
  tags,
}: { task: Task } & Props) {
  const ref = useRef<HTMLLIElement>(null);
  // The project's color, if the user picked one: the check and the calendar chips use it.
  const pc = useProjectColor(task.project);
  const highlighted = highlight === task.id;
  const focused = focusId === task.id;
  // In full screen the row stays a row; the task opens in the detail pane.
  const picked = !!detail && openId === task.id;
  const open = !detail && openId === task.id;
  const [completing, setCompleting] = useState(false);
  const byAgentTask = useIsAgentTask(task);
  // Which menu of the open card is showing (and whether ⋯ shows snooze).
  const [menu, setMenu] = useState<FieldMenu | null>(null);
  const [snooze, setSnooze] = useState(false);
  const [focusPart, setFocusPart] = useState<"title" | "notes" | "steps" | null>(null);

  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [highlighted]);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);
  useEffect(() => {
    if (!open) {
      setMenu(null);
      setSnooze(false);
      setFocusPart(null);
    } else ref.current?.scrollIntoView({ block: "nearest" });
  }, [open]);
  useEffect(() => {
    if (picked) ref.current?.scrollIntoView({ block: "nearest" });
  }, [picked]);
  useEffect(() => {
    if (!command || command.id !== task.id) return;
    // Every row command opens the task with the right part ready.
    onOpenTask(task.id);
    // (The detail pane picks the part itself.)
    if (detail) return;
    if (command.kind === "date") setMenu("date");
    if (command.kind === "project" && !task.done) setMenu("place");
    if (command.kind === "snooze" && !task.done) {
      setMenu("more");
      setSnooze(true);
    }
    if (command.kind === "edit") setFocusPart("title");
    if (command.kind === "notes") setFocusPart("notes");
    if (command.kind === "steps") setFocusPart("steps");
    // Only react to new commands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);

  // An open card closes on a click anywhere outside it (edits are already saved).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (ref.current && !ref.current.contains(t) && !t.closest(".toasts, .batch, .keys-sheet")) onOpenTask(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
  }, [open, onOpenTask]);

  function toggle() {
    if (task.done) {
      void actions.setDone(task, false);
      return;
    }
    // Let the check animation play before the row leaves; the sound plays now.
    playDone(task.id);
    setCompleting(true);
    if (open) onOpenTask(null);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => void actions.setDone(task, true), reduce ? 0 : 420);
  }

  const check = (
    <button
      type="button"
      data-nodrag
      className={task.done || completing ? "check on" : "check"}
      onClick={toggle}
      aria-label={task.done ? `Mark “${task.title}” not done` : `Mark “${task.title}” done`}
      aria-pressed={task.done}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4">
        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );

  return (
    <li
      ref={ref}
      className={[
        "task",
        open ? "open" : "",
        picked ? "picked" : "",
        task.done ? "done" : "",
        highlighted ? "flash" : "",
        focused && !open ? "focused" : "",
        completing ? "completing" : "",
        selected.has(task.id) ? "selected" : "",
        drag?.drag?.task.id === task.id ? "lifted" : "",
        byAgentTask ? "by-agent" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      aria-selected={selected.size ? selected.has(task.id) : undefined}
      style={pc ? ({ "--pc": pc } as CSSProperties) : undefined}
      onPointerDown={(e) => {
        if (!open && drag && !(e.metaKey || e.ctrlKey || e.shiftKey)) drag.start(e, task);
      }}
      onMouseDown={() => onFocus(task.id)}
      // ⌘-click toggles a task in the selection, Shift-click selects a range.
      onMouseDownCapture={(e) => {
        if (open || !(e.metaKey || e.ctrlKey || e.shiftKey) || e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        onFocus(task.id);
        onSelect(task.id, e.shiftKey ? "range" : "toggle");
      }}
      onClickCapture={(e) => {
        if (!open && (e.metaKey || e.ctrlKey || e.shiftKey)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      {open ? (
        <TaskCard
          task={task}
          check={check}
          actions={actions}
          now={now}
          locale={locale}
          projects={projects}
          tags={tags ?? []}
          menu={menu}
          onMenu={setMenu}
          snooze={snooze}
          onSnooze={setSnooze}
          focusPart={focusPart}
          onClose={() => onOpenTask(null)}
        />
      ) : (
        <>
        <div
          className="task-row"
          title={task.done ? undefined : detail ? "Click for details · drag onto a day or an hour" : "Click to open · drag onto a day to move"}
          onClick={(e) => {
            if (drag?.wasDrag()) return;
            if ((e.target as HTMLElement).closest("button, a, input")) return;
            onOpenTask(task.id);
          }}
        >
          {check}
          <div className="task-main">
            <span className="task-title">
              {titleParts(task.title).map((p, i) =>
                p.tag ? (
                  <button
                    key={i}
                    type="button"
                    className="tag"
                    data-nodrag
                    onClick={() => onTag(p.text.toLowerCase())}
                  >
                    {p.text}
                  </button>
                ) : (
                  <span key={i}>{p.text}</span>
                ),
              )}
            </span>
            <RowMeta task={task} now={now} locale={locale} inProject={inProject} onOpenProject={onOpenProject} onError={actions.fail} whenOnly={rich} />
          </div>
          <DelegateButton task={task} />
        </div>
        {rich && <RowSub task={task} inProject={inProject} onOpenProject={onOpenProject} hasNotes={details && !!task.notes} />}
        {rich && details && (task.notes || (task.checklist?.length ?? 0) > 0) && (
          <div className="task-extra" data-nodrag>
            {task.notes && <Notes text={task.notes} onEdit={() => onOpenTask(task.id)} onError={actions.fail} />}
            {(task.checklist?.length ?? 0) > 0 && (
              <Checklist items={task.checklist} onChange={(next) => void actions.update(task, { checklist: next })} readOnly={task.done} noAdd />
            )}
          </div>
        )}
        </>
      )}
    </li>
  );
}

/** One quiet grey line under a title; only lateness is red. */
function RowMeta({
  task,
  now,
  locale,
  inProject,
  onOpenProject,
  onError,
  whenOnly,
}: {
  task: Task;
  now: Date;
  locale: string;
  inProject: string | null;
  onOpenProject: (name: string) => void;
  onError: (e: unknown) => void;
  /** Full screen: just when (and the deadline) on the right; the rest goes under the title. */
  whenOnly?: boolean;
}) {
  const showSource = useSourceDisplay();
  const agentTask = useIsAgentTask(task);
  const run = useAgentRun(task);
  const w = useWords();
  const parts: ReactNode[] = [];
  const when = whenText(task, now, locale);
  if (when) parts.push(<span key="w" className={when.late ? "late" : when.soon ? "soon" : undefined}>{when.text}</span>);
  const dl = deadlineChip(task, now, locale);
  if (dl) parts.push(<span key="dl" className={dl.tone === "overdue" ? "late" : undefined}>{dl.label}</span>);
  if (task.paused && !task.done) parts.push(<span key="p">Paused</span>);
  const pri = task.done ? null : priorityColor(task.priority);
  const flag = pri && (
    <span className="pri-flag" style={{ color: pri }} title={`Priority P${task.priority}`} aria-label={`Priority P${task.priority}`}>
      <LineIcon name="flagFilled" size={13} />
    </span>
  );
  const repeats = task.recurrence && !task.done ? (
    <span className="row-repeat" title={`${repeatLabel(task.recurrence) ?? "Repeats"}${task.paused ? " · paused" : ""}`} aria-label={repeatLabel(task.recurrence) ?? "Repeats"}>
      <LineIcon name="repeat" size={12} />
    </span>
  ) : null;
  if (whenOnly) {
    if (!parts.length && !flag && !repeats) return null;
    return (
      <div className="task-meta">
        {flag}
        {repeats}
        {parts.map((p, i) => (
          <span key={i} className="meta-part">
            {i > 0 && <span className="meta-sep" aria-hidden>·</span>}
            {p}
          </span>
        ))}
      </div>
    );
  }
  const steps = task.checklist ?? [];
  if (steps.length) parts.push(<span key="s">{stepsLabel(steps)} {w.steps}</span>);
  const link = firstLink(task.notes);
  if (link) {
    parts.push(
      <a
        key="l"
        href={link}
        data-nodrag
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void api.openUrl(link).catch(onError);
        }}
      >
        {shortUrl(link)}
      </a>,
    );
  }
  if (task.project && task.project !== inProject) {
    parts.push(
      <button key="pr" type="button" className="meta-link" data-nodrag onClick={() => onOpenProject(task.project!)}>
        <span className="task-project-dot" aria-hidden />
        {task.project}
      </button>,
    );
  }
  if (agentTask) parts.unshift(<AgentMark key="ag" task={task} />);
  if (run && !task.done) parts.unshift(<AgentRunPill key="run" run={run} />);
  if (sourceLabel(task) && !link && showSource !== "never") parts.push(<SourceChip key="src" task={task} onFail={onError} />);
  if (!parts.length && !flag && !repeats) return null;
  return (
    <div className="task-meta">
      {flag}
      {repeats}
      {parts.map((p, i) => (
        <span key={i} className="meta-part">
          {i > 0 && <span className="meta-sep" aria-hidden>·</span>}
          {p}
        </span>
      ))}
    </div>
  );
}

/**
 * Full screen: one quiet line under the title — its project (when it isn't
 * the one on screen), its repeat, where it came from, and its link when
 * the notes don't already show it.
 */
function RowSub({
  task,
  inProject,
  onOpenProject,
  hasNotes,
}: {
  task: Task;
  inProject: string | null;
  onOpenProject: (name: string) => void;
  hasNotes: boolean;
}) {
  const showSource = useSourceDisplay();
  const agentTask = useIsAgentTask(task);
  const run = useAgentRun(task);
  const parts: ReactNode[] = [];
  if (run && !task.done) parts.push(<AgentRunPill key="run" run={run} />);
  if (agentTask) parts.push(<AgentMark key="ag" task={task} />);
  if (task.project && task.project !== inProject) {
    parts.push(
      <button key="pr" type="button" className="meta-link" data-nodrag onClick={() => onOpenProject(task.project!)}>
        <span className="task-project-dot" aria-hidden />
        {task.project}
        {task.heading ? ` · ${task.heading}` : ""}
      </button>,
    );
  }
  const link = hasNotes ? null : firstLink(task.notes);
  if (link) {
    parts.push(
      <a
        key="l"
        href={link}
        data-nodrag
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void api.openUrl(link);
        }}
      >
        ↗ {linkHost(link)}
      </a>,
    );
  }
  if (sourceLabel(task) && showSource !== "never") parts.push(<SourceChip key="src" task={task} />);
  if (!parts.length) return null;
  return (
    <div className="task-sub">
      {parts.map((p, i) => (
        <span key={i} className="meta-part">
          {i > 0 && <span className="meta-sep" aria-hidden>·</span>}
          {p}
        </span>
      ))}
    </div>
  );
}

/** "Tuesday" (late), "4:26 PM", "in 40 min", "Evening". */
export function whenText(t: Task, now: Date, locale: string): { text: string; late?: boolean; soon?: boolean } | null {
  if (t.done) return null;
  const chip = dueChip(t, now, locale);
  // With a length: "9:07 – 9:14 AM".
  const end = t.due_time ? endOf(t.due_time, t.duration) : null;
  const time = t.due_time ? (end ? `${timeLabel(t.due_time, locale)} – ${timeLabel(end, locale)}` : timeLabel(t.due_time, locale)) : null;
  if (chip?.tone === "overdue") {
    const today = toISODate(now);
    if (t.due_date && t.due_date < today) {
      const day = relativeLabel(t.due_date, now, locale);
      return { text: time ? `${day}, ${time}` : day, late: true };
    }
    return { text: time ?? "Late", late: true };
  }
  if (chip?.tone === "soon") return { text: chip.label, soon: true };
  if (time) return { text: t.evening ? `${time} · evening` : time };
  if (t.evening) return { text: "Evening" };
  return null;
}

export function firstLink(notes: string | null): string | null {
  if (!notes) return null;
  return linkParts(notes).find((p) => p.url)?.url ?? null;
}

export function shortUrl(url: string): string {
  const s = url.replace(/^(https?:\/\/(www\.)?|mailto:)/i, "").replace(/\/$/, "");
  return s.length > 28 ? `${s.slice(0, 27)}…` : s;
}

/**
 * A task opened in place (or in the detail pane): its title, notes and
 * sub-tasks to edit, and the same row of chips and icons as when adding one.
 * Everything saves as you go; Esc or a click outside closes it.
 */
function TaskCard({
  task,
  check,
  actions,
  now,
  locale,
  projects,
  tags,
  menu,
  onMenu,
  snooze,
  onSnooze,
  focusPart,
  onClose,
}: {
  task: Task;
  check: ReactNode;
  actions: TaskActions;
  now: Date;
  locale: string;
  projects: ProjectInfo[];
  tags: string[];
  menu: FieldMenu | null;
  onMenu: (m: FieldMenu | null) => void;
  /** The ⋯ menu shows the snooze choices. */
  snooze: boolean;
  onSnooze: (on: boolean) => void;
  focusPart: "title" | "notes" | "steps" | null;
  onClose: () => void;
}) {
  const runs = useContext(AgentRuns);
  const run = runs.byTask.get(task.id);
  const [title, setTitle] = useState(task.title);
  const [notes, setNotes] = useState(task.notes ?? "");
  const [editNotes, setEditNotes] = useState(false);
  const [steps, setSteps] = useState<ChecklistItem[]>(task.checklist ?? []);
  const stepsKey = JSON.stringify(task.checklist ?? []);
  useEffect(() => setSteps(task.checklist ?? []), [stepsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Edits save as you type (and at once when you leave the field or close
  // the card). What comes back from the save doesn't overwrite the field
  // while you're still typing in it.
  const saved = useRef({ title: task.title, notes: task.notes ?? "" });
  const live = useRef({ title, notes });
  live.current = { title, notes };
  const timer = useRef<number | null>(null);
  useEffect(() => {
    if (task.title !== saved.current.title) {
      saved.current.title = task.title;
      setTitle(task.title);
    }
  }, [task.title]);
  useEffect(() => {
    if ((task.notes ?? "") !== saved.current.notes) {
      saved.current.notes = task.notes ?? "";
      setNotes(task.notes ?? "");
    }
  }, [task.notes]);
  function flush() {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const patch: TaskPatch = {};
    const t = live.current.title.trim();
    if (t && t !== saved.current.title) {
      patch.title = t;
      saved.current.title = t;
    }
    const n = live.current.notes.trim();
    if (n !== saved.current.notes) {
      patch.notes = n || null;
      saved.current.notes = n;
    }
    if (Object.keys(patch).length) void actions.update(task, patch);
  }
  function soon() {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 500);
  }
  // Closing the card (Esc, a click outside, another task) keeps what was typed.
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => flushRef.current(), []);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusPart === "notes") setEditNotes(true);
  }, [focusPart]);
  useEffect(() => {
    if (editNotes) notesRef.current?.focus();
  }, [editNotes]);
  // Grow the notes box with its text.
  useEffect(() => {
    const el = notesRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 320)}px`;
  }, [notes, editNotes]);

  function saveTitle() {
    flush();
    // A title can't be blank: an emptied one goes back to what it was.
    if (!title.trim()) setTitle(saved.current.title);
  }
  // A date typed into the title ("call Sam tomorrow 3pm"): offer to use it.
  const typedWhen = useMemo(() => {
    if (task.done) return null;
    const f = findSchedule(title, now, dayOrderForLocale(locale));
    const differs = f.date !== task.due_date || (f.time ?? null) !== (task.due_time ?? null);
    return f.date && f.title && f.confident && differs ? f : null;
  }, [title, now, locale, task.done, task.due_date, task.due_time]);
  function applyTypedWhen() {
    if (!typedWhen) return;
    const patch: TaskPatch = { title: typedWhen.title, due_date: typedWhen.date, due_time: typedWhen.time, someday: false };
    if (typedWhen.repeat) patch.recurrence = typedWhen.repeat;
    setTitle(typedWhen.title);
    saved.current.title = typedWhen.title;
    void actions.update(task, patch);
  }
  function saveNotes() {
    flush();
    if (notes.trim()) setEditNotes(false);
  }
  function saveSteps(next: ChecklistItem[]) {
    setSteps(next);
    void actions.update(task, { checklist: next });
  }
  function change(patch: TaskPatch) {
    if (patch.project !== undefined || patch.heading !== undefined) {
      void actions.place(task, { project: patch.project === undefined ? task.project : patch.project, heading: patch.heading ?? null });
      return;
    }
    const keys = Object.keys(patch).filter((k) => k !== "only_this");
    if (keys.length && keys.every((k) => k === "due_date" || k === "due_time")) void actions.reschedule(task, patch);
    else void actions.update(task, patch);
  }

  const source = sourceLabel(task);
  const showNotesText = !!task.notes && !editNotes;
  const values: FieldValues = {
    project: task.project,
    heading: task.heading,
    date: task.due_date,
    time: task.due_time,
    evening: task.evening,
    someday: task.someday,
    repeat: task.recurrence,
    deadline: task.deadline,
    priority: task.priority ?? 0,
    paused: task.paused,
    duration: task.duration ?? null,
  };

  return (
    <div
      className="task-card tfc open"
      role="group"
      aria-label={`Editing “${task.title}”`}
      // Keys typed here are for the card, not the list's shortcuts.
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
      }}
    >
      <div className="tfc-head">
        {check}
        <input
          className="tfc-title"
          value={title}
          autoFocus={focusPart === "title"}
          maxLength={200}
          aria-label="Title"
          onChange={(e) => {
            setTitle(e.target.value);
            soon();
          }}
          onBlur={saveTitle}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </div>
      <div className="tfc-body">
        {typedWhen && (
          <button type="button" className="tc-suggest" onMouseDown={(e) => e.preventDefault()} onClick={applyTypedWhen}>
            <CalendarIcon /> Set {[relativeLabel(typedWhen.date!, now, locale), typedWhen.time && timeLabel(typedWhen.time, locale)].filter(Boolean).join(", ")}
          </button>
        )}
        {showNotesText ? (
          <Notes text={task.notes!} onEdit={() => setEditNotes(true)} onError={actions.fail} />
        ) : (
          <textarea
            ref={notesRef}
            className="tfc-notes"
            value={notes}
            rows={1}
            maxLength={2000}
            placeholder="Notes"
            aria-label="Notes"
            onChange={(e) => {
              setNotes(e.target.value);
              soon();
            }}
            onBlur={saveNotes}
          />
        )}
        {source && (
          <div className="tfc-source">
            <SourceChip task={task} onFail={actions.fail} />
          </div>
        )}
        {run && !task.done && <AgentRunCard task={task} run={run} />}
        <Checklist items={steps} onChange={saveSteps} autoFocusAdd={focusPart === "steps"} readOnly={task.done} />
        <TaskFields
          value={values}
          onChange={change}
          places={projects}
          now={now}
          locale={locale}
          menu={menu}
          onMenu={(m) => {
            onMenu(m);
            if (m !== "more") onSnooze(false);
          }}
          tags={{
            known: tags,
            active: tagsOf(task.title),
            onToggle: (t) => {
              const next = toggleTag(saved.current.title, t);
              setTitle(next);
              saved.current.title = next;
              void actions.update(task, { title: next });
            },
          }}
          series={task.recurrence ? { onSkip: () => void actions.skip(task), onPause: (p) => void actions.pause(task, p) } : undefined}
          more={(close) =>
            snooze && !task.done ? (
              <>
                <div className="tf-head">Snooze</div>
                <SnoozeBar
                  onSnooze={(kind) => {
                    close();
                    onSnooze(false);
                    void actions.snooze(task, kind);
                  }}
                />
              </>
            ) : (
              <>
                {source && (
                  <>
                    <button
                      type="button"
                      role="menuitem"
                      className="tf-opt"
                      title={task.source_url ?? undefined}
                      onClick={() => {
                        close();
                        void api.openSource(task.id).catch(actions.fail);
                      }}
                    >
                      <span className="tf-opt-icon">
                        <LineIcon name="external" size={16} />
                      </span>
                      Open in {source}
                    </button>
                    <div className="tf-sep" />
                  </>
                )}
                {!task.done && runs.send && (
                  <button
                    type="button"
                    role="menuitem"
                    className="tf-opt"
                    onClick={() => {
                      close();
                      runs.send!(task);
                    }}
                  >
                    <span className="tf-opt-icon">
                      <LineIcon name="external" size={16} />
                    </span>
                    {run ? "Send to agent again…" : "Send to agent…"}
                  </button>
                )}
                {!task.done && (
                  <button type="button" role="menuitem" className="tf-opt" onClick={() => onSnooze(true)}>
                    <span className="tf-opt-icon">
                      <LineIcon name="snooze" size={16} />
                    </span>
                    Snooze<em>›</em>
                  </button>
                )}
                {!task.done && !task.someday && (
                  <button
                    type="button"
                    role="menuitem"
                    className="tf-opt"
                    onClick={() => {
                      close();
                      void actions.update(task, { someday: true });
                    }}
                  >
                    <span className="tf-opt-icon">
                      <LineIcon name="someday" size={16} />
                    </span>
                    Move to Someday
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  className="tf-opt"
                  onClick={() => {
                    close();
                    void actions.duplicate(task);
                  }}
                >
                  <span className="tf-opt-icon">
                    <LineIcon name="copy" size={16} />
                  </span>
                  Duplicate
                </button>
                <div className="tf-sep" />
                <button
                  type="button"
                  role="menuitem"
                  className="tf-opt danger"
                  onClick={() => {
                    close();
                    void actions.remove(task);
                  }}
                >
                  <span className="tf-opt-icon">
                    <LineIcon name="trash" size={16} />
                  </span>
                  Delete
                </button>
              </>
            )
          }
        />
      </div>
    </div>
  );
}

/**
 * Full screen's detail pane: the task opened beside the list, in the same
 * card as everywhere. ↑ ↓ step through the list; Esc closes.
 */
export function TaskDetail({
  task,
  actions,
  now,
  locale,
  projects,
  tags = [],
  command,
  onClose,
  onStep,
}: {
  task: Task;
  actions: TaskActions;
  now: Date;
  locale: string;
  projects: ProjectInfo[];
  tags?: string[];
  command: RowCommand | null;
  onClose: () => void;
  /** Open the task before (-1) or after (1) in the list. */
  onStep?: (d: -1 | 1) => void;
}) {
  const [menu, setMenu] = useState<FieldMenu | null>(null);
  const [snooze, setSnooze] = useState(false);
  const [focusPart, setFocusPart] = useState<"title" | "notes" | "steps" | null>(null);
  useEffect(() => {
    setMenu(null);
    setSnooze(false);
    setFocusPart(null);
  }, [task.id]);
  useEffect(() => {
    if (!command || command.id !== task.id) return;
    if (command.kind === "date") setMenu("date");
    if (command.kind === "project" && !task.done) setMenu("place");
    if (command.kind === "snooze" && !task.done) {
      setMenu("more");
      setSnooze(true);
    }
    if (command.kind === "edit") setFocusPart("title");
    if (command.kind === "notes") setFocusPart("notes");
    if (command.kind === "steps") setFocusPart("steps");
    // Only react to new commands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [command]);
  const check = (
    <button
      type="button"
      className={task.done ? "check on" : "check"}
      onClick={() => void actions.setDone(task, !task.done)}
      aria-label={task.done ? `Mark “${task.title}” not done` : `Mark “${task.title}” done`}
      aria-pressed={task.done}
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4">
        <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  );
  return (
    <aside className="side-pane detail-pane" aria-label="Task details">
      <div className="dp-bar">
        {onStep && (
          <>
            <button type="button" className="icon" onClick={() => onStep(-1)} aria-label="Previous task" title="Previous task (↑)">
              <LineIcon name="chevronUp" size={16} />
            </button>
            <button type="button" className="icon" onClick={() => onStep(1)} aria-label="Next task" title="Next task (↓)">
              <LineIcon name="chevronDown" size={16} />
            </button>
          </>
        )}
        <span className="topbar-gap" />
        <button
          type="button"
          className="icon"
          // Finish any edit in progress (it saves on blur) before closing.
          onMouseDown={() => (document.activeElement as HTMLElement | null)?.blur()}
          onClick={onClose}
          aria-label="Close"
          title="Close (Esc)"
        >
          <LineIcon name="close" size={16} />
        </button>
      </div>
      <div className="sp-body">
        <TaskCard
          key={task.id}
          task={task}
          check={check}
          actions={actions}
          now={now}
          locale={locale}
          projects={projects}
          tags={tags}
          menu={menu}
          onMenu={setMenu}
          snooze={snooze}
          onSnooze={setSnooze}
          focusPart={focusPart}
          onClose={onClose}
        />
      </div>
    </aside>
  );
}

/** The description: one quiet line, links clickable, click to edit. */
function Notes({ text, onEdit, onError }: { text: string; onEdit: () => void; onError: (e: unknown) => void }) {
  return (
    <p className="task-notes" title={text} onClick={onEdit}>
      {linkParts(text).map((p, i) =>
        p.url ? (
          <a
            key={i}
            href={p.url}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void api.openUrl(p.url!).catch(onError);
            }}
          >
            ↗ {linkHost(p.url)}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  );
}

/** "docs.example.com" for a link (an email address for mailto:). */
export function linkHost(url: string): string {
  if (/^mailto:/i.test(url)) return url.slice(7);
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return shortUrl(url);
  }
}

function EmptyArt() {
  return (
    <svg className="empty-art" width="56" height="56" viewBox="0 0 56 56" fill="none" aria-hidden>
      <circle cx="28" cy="28" r="26" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2" />
      <path d="M18 29l7 7 13-15" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
