import { useState, type CSSProperties } from "react";
import { openTaskMenu } from "./TaskMenu";
import { SourceChip, useSourceDisplay } from "./SourceChip";
import { playDone } from "../lib/doneSound";
import { useProjectColor } from "../lib/colors";
import { deadlineChip } from "../lib/lists";
import type { DropTarget } from "../lib/plan";
import type { TaskActions } from "../lib/taskActions";
import { linkParts, sourceLabel } from "../lib/taskText";
import type { NewTask, Task } from "../lib/types";
import type { TaskDrag } from "../lib/useTaskDrag";
import { stepsLabel } from "./Checklist";
import { firstLink, linkHost, whenText } from "./TaskList";
import { LineIcon } from "./LineIcon";
import { priorityColor } from "../lib/taskText";

/** One column of a board: Inbox's "Tomorrow", or a building's floor. */
export interface BoardColumn {
  key: string;
  label: string;
  /** Small text beside the name ("Wed 28", "no date"). */
  sub?: string;
  /** A floor's number, like the sidebar's lift buttons ("G", "1"…). */
  lvl?: string;
  tasks: Task[];
  /** Where a card dropped here goes. */
  drop: DropTarget;
  /** What a task added in this column gets. */
  add: Partial<NewTask>;
  /** The card's chip shows the day, not just the time (Next 7 days, Later). */
  showDay?: boolean;
}

/**
 * Tasks as cards in columns. Drag a card to another column to move it
 * (another day in Inbox, another floor in a building); click a card to open
 * it; tick it off from its box; add a task at the foot of any column.
 */
export function TaskBoard({
  columns,
  actions,
  now,
  locale,
  drag,
  openId,
  onOpen,
  onAdd,
}: {
  columns: BoardColumn[];
  actions: TaskActions;
  now: Date;
  locale: string;
  drag: TaskDrag;
  openId: number | null;
  onOpen: (id: number) => void;
  onAdd: (task: NewTask) => Promise<void>;
}) {
  const over = drag.drag?.over;
  const isOver = (c: BoardColumn) => {
    if (!over) return false;
    if (c.drop.nodate) return !!over.nodate;
    if (c.drop.place) return over.place?.project === c.drop.place.project && (over.place?.heading ?? null) === (c.drop.place.heading ?? null);
    return !!c.drop.iso && over.iso === c.drop.iso && over.hour === undefined;
  };
  return (
    <div className="board" data-autoscroll>
      {columns.map((c) => (
        <section
          key={c.key}
          className={isOver(c) ? "bcol drop" : "bcol"}
          aria-label={c.label}
          data-iso={c.drop.iso}
          data-drop-nodate={c.drop.nodate ? "" : undefined}
          data-drop-project={c.drop.place?.project}
          data-drop-floor={c.drop.place ? (c.drop.place.heading ?? "") : undefined}
        >
          <header className="bcol-head">
            {c.lvl && (
              <span className="bcol-lvl" aria-hidden>
                {c.lvl}
              </span>
            )}
            <h2 className="bcol-title">{c.label}</h2>
            <span className="bcol-count">{c.tasks.filter((t) => !t.done).length || ""}</span>
            {c.sub && <span className="bcol-sub">{c.sub}</span>}
          </header>
          <ul className="bcol-cards">
            {c.tasks.map((t) => (
              <Card
                key={t.id}
                task={t}
                actions={actions}
                now={now}
                locale={locale}
                drag={drag}
                open={openId === t.id}
                onOpen={onOpen}
                showDay={!!c.showDay}
              />
            ))}
          </ul>
          <AddCard column={c} onAdd={onAdd} />
        </section>
      ))}
    </div>
  );
}

function Card({
  task,
  actions,
  now,
  locale,
  drag,
  open,
  onOpen,
  showDay,
}: {
  task: Task;
  actions: TaskActions;
  now: Date;
  locale: string;
  drag: TaskDrag;
  open: boolean;
  onOpen: (id: number) => void;
  showDay: boolean;
}) {
  const pc = useProjectColor(task.project);
  const [leaving, setLeaving] = useState(false);
  const link = firstLink(task.notes);
  // The first line of the notes that isn't just the link.
  const noteLine =
    linkParts(task.notes ?? "")
      .filter((p) => !p.url)
      .map((p) => p.text)
      .join("")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) ?? null;
  const showSource = useSourceDisplay();
  const source = showSource === "never" ? null : sourceLabel(task);
  const when = whenText(task, now, locale);
  const day = showDay && task.due_date && !when?.late ? new Date(`${task.due_date}T12:00:00`).toLocaleDateString(locale, { weekday: "short", month: "short", day: "numeric" }) : null;
  const dl = deadlineChip(task, now, locale);
  const steps = task.checklist ?? [];
  const pri = task.done ? null : priorityColor(task.priority);
  const toggle = () => {
    if (task.done) return void actions.setDone(task, false);
    playDone(task.id);
    setLeaving(true);
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    window.setTimeout(() => void actions.setDone(task, true), reduce ? 0 : 380);
  };
  return (
    <li
      className={["bcard", open ? "open" : "", task.done ? "done" : "", leaving ? "leaving" : "", drag.drag?.task.id === task.id ? "lifted" : ""].filter(Boolean).join(" ")}
      style={pc ? ({ "--pc": pc } as CSSProperties) : undefined}
      onPointerDown={(e) => drag.start(e, task)}
      onContextMenu={(e) => openTaskMenu(e, task)}
      onClick={(e) => {
        if (drag.wasDrag()) return;
        if ((e.target as HTMLElement).closest("button, a")) return;
        onOpen(task.id);
      }}
    >
      <button
        type="button"
        data-nodrag
        className={task.done || leaving ? "check on" : "check"}
        onClick={toggle}
        aria-label={task.done ? `Mark “${task.title}” not done` : `Mark “${task.title}” done`}
        aria-pressed={task.done}
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.6">
          <path d="M3.5 8.5 6.5 11.5 12.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className="bcard-main">
        <span className="bcard-title">{task.title}</span>
        {(link || noteLine || source) && (
          <span className="bcard-note">
            {link && <span className="bcard-link">↗ {linkHost(link)}</span>}
            {noteLine ?? (source ? <SourceChip task={task} /> : "")}
          </span>
        )}
        {(when || day || dl || steps.length > 0 || pri) && (
          <span className="bcard-chips">
            {pri && (
              <span className="bchip pri" style={{ color: pri }} title={`Priority P${task.priority}`}>
                <LineIcon name="flagFilled" size={12} /> P{task.priority}
              </span>
            )}
            {(day || when) && (
              <span className={when?.late ? "bchip late" : when?.soon ? "bchip soon" : "bchip"}>{[day, when?.text].filter(Boolean).join(" · ")}</span>
            )}
            {dl && <span className={dl.tone === "overdue" ? "bchip late" : "bchip"}>{dl.label}</span>}
            {steps.length > 0 && <span className="bchip quiet">{stepsLabel(steps)}</span>}
          </span>
        )}
      </div>
    </li>
  );
}

function AddCard({ column, onAdd }: { column: BoardColumn; onAdd: (task: NewTask) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const title = text.trim();
    if (!title) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onAdd({ title, due_date: null, source_text: null, ...column.add });
      setText("");
    } catch {
      // The error shows as a banner; keep the text.
    } finally {
      setBusy(false);
    }
  };
  if (!editing) {
    return (
      <button type="button" className="bcol-add" onClick={() => setEditing(true)}>
        + Add task
      </button>
    );
  }
  return (
    <input
      className="bcol-input"
      autoFocus
      value={text}
      disabled={busy}
      maxLength={200}
      placeholder={`New task in ${column.label}`}
      aria-label={`New task in ${column.label}`}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") void save();
        if (e.key === "Escape") {
          setText("");
          setEditing(false);
        }
      }}
      onBlur={() => !text.trim() && setEditing(false)}
    />
  );
}
