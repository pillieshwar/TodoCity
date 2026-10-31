import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Calendar } from "./Calendar";
import { TimePicker } from "./TimePicker";
import { LineIcon } from "./LineIcon";
import type { ProjectInfo } from "./ProjectPicker";
import { useProjectColor } from "../lib/colors";
import { addDays, dayOrderForLocale, daysBetween, parseISODate, relativeLabel, toISODate } from "../lib/dates";
import { repeatLabel, resolveSchedule, timeLabel } from "../lib/schedule";
import { parseRepeat, repeatBrief } from "../lib/repeat";
import { EndsNote, RepeatMenu } from "./RepeatMenu";
import { PRIORITIES, priorityColor } from "../lib/taskText";
import { DURATION_PRESETS, durationLabel, parseDuration } from "../lib/timeblock";
import type { TaskPatch } from "../lib/types";

/** What the chips show, for a new task or a saved one. */
export interface FieldValues {
  project: string | null;
  heading: string | null;
  date: string | null;
  time: string | null;
  evening: boolean;
  someday: boolean;
  repeat: string | null;
  deadline: string | null;
  priority: number;
  paused?: boolean;
  /** How long it takes, in minutes. */
  duration?: number | null;
}

export type FieldMenu = "place" | "date" | "time" | "length" | "repeat" | "priority" | "deadline" | "tags" | "more";

/**
 * The fields of a task as one quiet row: where it goes, its day and time
 * as chips on the left; priority, repeat, deadline, tags and more as grey
 * icons on the right. Each opens one small menu under it.
 * Used the same way when adding a task and when one is open.
 */
export function TaskFields({
  value,
  onChange,
  places,
  now,
  locale,
  tags,
  steps,
  series,
  more,
  menu: menuProp,
  onMenu,
}: {
  value: FieldValues;
  /** A change, in the same shape as a task update. */
  onChange: (patch: TaskPatch) => void;
  places: ProjectInfo[];
  now: Date;
  locale: string;
  /** Tags: the ones in use, the ones in this title, and add/remove one. */
  tags?: { known: string[]; active: string[]; onToggle: (tag: string) => void };
  /** Adding a task: show or hide its sub-tasks. */
  steps?: { on: boolean; onToggle: () => void };
  /** A saved repeating task: skip one, or pause the series. */
  series?: { onSkip: () => void; onPause: (paused: boolean) => void };
  /** The ⋯ menu's items (an open task). */
  more?: (close: () => void) => ReactNode;
  /** Open a menu from outside (a keyboard shortcut). */
  menu?: FieldMenu | null;
  onMenu?: (m: FieldMenu | null) => void;
}) {
  const [menu, setMenuRaw] = useState<FieldMenu | null>(menuProp ?? null);
  useEffect(() => {
    if (menuProp !== undefined) setMenuRaw(menuProp);
  }, [menuProp]);
  const setMenu = (m: FieldMenu | null) => {
    setMenuRaw(m);
    onMenu?.(m);
  };
  const toggle = (m: FieldMenu) => setMenu(menu === m ? null : m);
  const close = () => setMenu(null);
  const root = useRef<HTMLDivElement>(null);
  const today = toISODate(now);

  // A click anywhere else closes the menu.
  useEffect(() => {
    if (!menu) return;
    const down = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".tf-menu") && !t.closest(".tf-trigger")) setMenuRaw(null);
    };
    document.addEventListener("pointerdown", down, true);
    return () => document.removeEventListener("pointerdown", down, true);
  }, [menu]);

  const pc = useProjectColor(value.project);
  const place = value.project ? `${value.project}${value.heading ? ` › ${value.heading}` : ""}` : "Inbox";
  const dateLabel = value.someday ? "Someday" : value.date ? relativeLabel(value.date, now, locale) : null;
  const late = !!value.date && value.date < today;
  const timeText = value.time ? timeLabel(value.time, locale) : value.evening && value.date ? "Evening" : null;
  const pri = priorityColor(value.priority);
  const dlLabel = value.deadline ? shortDay(value.deadline, now, locale) : null;
  const dlLate = !!value.deadline && value.deadline < today;

  return (
    <div
      className="tf"
      ref={root}
      onKeyDown={(e) => {
        if (e.key === "Escape" && menu) {
          e.preventDefault();
          e.stopPropagation();
          close();
        }
      }}
    >
      <div className="tf-chips">
        <span className="tf-anchor">
          <button
            type="button"
            className={["tf-chip ghost tf-trigger", menu === "place" ? "on" : ""].join(" ")}
            onClick={() => toggle("place")}
            aria-expanded={menu === "place"}
            title="Where it goes"
          >
            {value.project ? <i className="tf-ring" style={pc ? { borderColor: pc } : undefined} aria-hidden /> : <LineIcon name="inbox" size={15} />}
            <span className="tf-chip-text">{place}</span>
            <LineIcon name="chevronDown" size={13} className="tf-caret" />
          </button>
          {menu === "place" && (
            <PlaceMenu
              places={places}
              project={value.project}
              heading={value.heading}
              onPick={(project, heading) => {
                onChange({ project, heading });
                close();
              }}
            />
          )}
        </span>

        <span className="tf-anchor">
          <Chip
            set={!!dateLabel}
            on={menu === "date"}
            late={late && !value.someday}
            icon="calendar"
            label={dateLabel ?? "Date"}
            title="Date"
            onClick={() => toggle("date")}
            onClear={() => onChange({ due_date: null, someday: false })}
          />
          {menu === "date" && (
            <DateMenu
              value={value}
              now={now}
              locale={locale}
              repeating={!!series && !!value.repeat}
              onChange={onChange}
              onTime={() => setMenu("time")}
              onRepeat={() => setMenu("repeat")}
              onClose={close}
            />
          )}
        </span>

        <span className="tf-anchor">
          <Chip
            set={!!timeText}
            on={menu === "time"}
            icon="clock"
            label={timeText ?? "Time"}
            title="Time"
            onClick={() => toggle("time")}
            onClear={() => onChange(value.time ? { due_time: null } : { evening: false })}
          />
          {menu === "time" && (
            <div className="tf-menu narrow" role="dialog" aria-label="Time">
              <TimePicker
                autoFocus
                value={value.time}
                locale={locale}
                now={!value.date || value.date === today ? now : undefined}
                placeholder="Add a time"
                onChange={(t) => {
                  onChange(t ? { due_date: value.date ?? today, due_time: t } : { due_time: null });
                  if (t) close();
                }}
              />
            </div>
          )}
        </span>

        {(value.time || value.duration) && (
          <span className="tf-anchor">
            <Chip
              set={!!value.duration}
              on={menu === "length"}
              icon="timer"
              label={durationLabel(value.duration) ?? "Length"}
              title="Length"
              onClick={() => toggle("length")}
              onClear={() => onChange({ duration: null })}
            />
            {menu === "length" && (
              <LengthMenu
                value={value.duration ?? null}
                onPick={(m) => {
                  onChange({ duration: m });
                  close();
                }}
              />
            )}
          </span>
        )}

      </div>

      <div className="tf-tools">
        <span className="tf-anchor">
          <button
            type="button"
            className={["tf-tool tf-trigger", menu === "priority" ? "on" : ""].join(" ")}
            style={pri ? { color: pri } : undefined}
            onClick={() => toggle("priority")}
            aria-label={value.priority ? `Priority P${value.priority}` : "Priority"}
            title={value.priority ? `Priority: P${value.priority}` : "Priority"}
          >
            <LineIcon name={pri ? "flagFilled" : "flag"} size={18} />
          </button>
          {menu === "priority" && (
            <div className="tf-menu right" role="menu" aria-label="Priority">
              {PRIORITIES.map((p) => (
                <button
                  key={p.n}
                  type="button"
                  role="menuitemradio"
                  aria-checked={value.priority === p.n}
                  className={value.priority === p.n ? "tf-opt sel" : "tf-opt"}
                  onClick={() => {
                    onChange({ priority: p.n });
                    close();
                  }}
                >
                  <span className="tf-opt-icon" style={{ color: p.color }}>
                    <LineIcon name="flagFilled" size={16} />
                  </span>
                  {p.label} · {p.name}
                  <em>p{p.n}</em>
                </button>
              ))}
              <div className="tf-sep" />
              <button
                type="button"
                role="menuitemradio"
                aria-checked={!value.priority}
                className="tf-opt"
                onClick={() => {
                  onChange({ priority: 0 });
                  close();
                }}
              >
                <span className="tf-opt-icon">
                  <LineIcon name="flag" size={16} />
                </span>
                No priority
              </button>
            </div>
          )}
        </span>

        {/* Repeat, right after priority: always here, its rule in a few words once set. */}
        <span className="tf-anchor">
          <button
            type="button"
            className={["tf-tool tf-trigger", value.repeat ? "rep" : "", menu === "repeat" ? "on" : ""].filter(Boolean).join(" ")}
            onClick={() => toggle("repeat")}
            aria-label={value.repeat ? `Repeat: ${repeatLabel(value.repeat) ?? "custom"}` : "Repeat"}
            title={value.repeat ? `${repeatLabel(value.repeat) ?? "Repeats"}${value.paused ? " · paused" : ""}` : "Repeat"}
          >
            <LineIcon name="repeat" size={17} />
            {value.repeat && (
              <span>
                {repeatBrief(value.repeat, value.date ?? today, locale) ?? "Repeats"}
                {value.paused ? " · paused" : ""}
              </span>
            )}
          </button>
          {menu === "repeat" && <RepeatMenu value={value} now={now} locale={locale} series={series} onChange={onChange} onClose={close} />}
        </span>

        <span className="tf-anchor">
          <button
            type="button"
            className={["tf-tool tf-trigger", dlLabel ? (dlLate ? "dl late" : "dl") : "", menu === "deadline" ? "on" : ""].filter(Boolean).join(" ")}
            onClick={() => toggle("deadline")}
            aria-label={value.deadline ? `Deadline ${dlLabel}` : "Deadline"}
            title={value.deadline ? `Deadline: ${parseISODate(value.deadline).toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" })}` : "Deadline"}
          >
            <LineIcon name="target" size={18} />
            {dlLabel && <span>{dlLabel}</span>}
          </button>
          {menu === "deadline" && <DeadlineMenu value={value} now={now} locale={locale} onChange={onChange} onClose={close} />}
        </span>

        {steps && (
          <button
            type="button"
            className={steps.on ? "tf-tool active" : "tf-tool"}
            onClick={steps.onToggle}
            aria-pressed={steps.on}
            aria-label="Sub-tasks"
            title="Sub-tasks"
          >
            <LineIcon name="checklist" size={18} />
          </button>
        )}

        {tags && (
          <span className="tf-anchor">
            <button
              type="button"
              className={["tf-tool tf-trigger", tags.active.length ? "active" : "", menu === "tags" ? "on" : ""].filter(Boolean).join(" ")}
              onClick={() => toggle("tags")}
              aria-label="Tags"
              title={tags.active.length ? `Tags: ${tags.active.join(" ")}` : "Tags"}
            >
              <LineIcon name="tag" size={18} />
            </button>
            {menu === "tags" && <TagsMenu tags={tags} />}
          </span>
        )}

        {more && (
          <span className="tf-anchor">
            <button
              type="button"
              className={["tf-tool tf-trigger", menu === "more" ? "on" : ""].join(" ")}
              onClick={() => toggle("more")}
              aria-label="More"
              title="More"
            >
              <LineIcon name="more" size={18} />
            </button>
            {menu === "more" && (
              <div className="tf-menu right" role="menu" aria-label="More">
                {more(close)}
              </div>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

/** "Fri" this week, else "Nov 20". */
function shortDay(iso: string, now: Date, locale: string): string {
  const d = parseISODate(iso);
  const days = daysBetween(now, d);
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days > 1 && days < 7) return d.toLocaleDateString(locale, { weekday: "short" });
  return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

/** How long a task takes: quick picks, or any number of minutes typed ("7", "1h30"). */
function LengthMenu({ value, onPick }: { value: number | null; onPick: (minutes: number | null) => void }) {
  const [text, setText] = useState("");
  const typed = parseDuration(text);
  return (
    <div className="tf-menu narrow" role="dialog" aria-label="Length">
      <input
        className="tf-filter"
        autoFocus
        value={text}
        placeholder="Minutes, e.g. 7 or 1h30"
        aria-label="Length in minutes"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && typed) {
            e.preventDefault();
            onPick(typed);
          }
        }}
      />
      {typed && !DURATION_PRESETS.includes(typed) && (
        <button type="button" className="tf-opt sel" onClick={() => onPick(typed)}>
          {durationLabel(typed)}
        </button>
      )}
      {DURATION_PRESETS.map((m) => (
        <button key={m} type="button" className={value === m ? "tf-opt sel" : "tf-opt"} onClick={() => onPick(m)}>
          {durationLabel(m)}
        </button>
      ))}
      {value !== null && (
        <button type="button" className="tf-opt quiet" onClick={() => onPick(null)}>
          No set length
        </button>
      )}
    </div>
  );
}

function Chip({
  set,
  on,
  late,
  icon,
  label,
  title,
  onClick,
  onClear,
}: {
  set: boolean;
  on: boolean;
  late?: boolean;
  icon: "calendar" | "clock" | "repeat" | "timer";
  label: string;
  title: string;
  onClick: () => void;
  onClear: () => void;
}) {
  return (
    <span className={["tf-chip tf-trigger", set ? "set" : "ghost", on ? "on" : "", late ? "late" : ""].filter(Boolean).join(" ")}>
      <button type="button" className="tf-chip-main" onClick={onClick} title={title} aria-label={set ? `${title}: ${label}` : title}>
        <LineIcon name={icon} size={15} />
        <span className="tf-chip-text">{label}</span>
      </button>
      {set && (
        <button type="button" className="tf-x" onClick={onClear} aria-label={`Remove ${title.toLowerCase()}`} title={`Remove ${title.toLowerCase()}`}>
          <LineIcon name="close" size={12} />
        </button>
      )}
    </span>
  );
}

function DateMenu({
  value,
  now,
  locale,
  repeating,
  onChange,
  onTime,
  onRepeat,
  onClose,
}: {
  value: FieldValues;
  now: Date;
  locale: string;
  /** A saved repeating task: moving it can be just this one or all of them. */
  repeating: boolean;
  onChange: (patch: TaskPatch) => void;
  onTime: () => void;
  onRepeat: () => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [scope, setScope] = useState<"one" | "series">("one");
  const order = useMemo(() => dayOrderForLocale(locale), [locale]);
  const today = toISODate(now);
  const tomorrow = toISODate(addDays(now, 1));
  const parsed = useMemo(() => (text.trim() ? resolveSchedule(text, now, order) : null), [text, now, order]);
  const understood = !!parsed && !parsed.leftover && !!(parsed.date || parsed.time || parsed.repeat);
  const apply = (patch: TaskPatch) =>
    onChange(repeating && patch.due_date !== undefined && !("recurrence" in patch) ? { ...patch, only_this: scope === "one" } : patch);
  const pick = (patch: TaskPatch) => {
    apply(patch);
    onClose();
  };
  const weekday = (iso: string) => parseISODate(iso).toLocaleDateString(locale, { weekday: "short" });

  return (
    <div className="tf-menu wide" role="dialog" aria-label="Date">
      <div className="tf-type">
        <input
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.stopPropagation();
              if (!parsed || !understood) return;
              const patch: TaskPatch = { due_date: parsed.date ?? value.date ?? today };
              if (parsed.time) patch.due_time = parsed.time;
              if (parsed.repeat) patch.recurrence = parsed.repeat;
              pick(patch);
            }
          }}
          placeholder="Type a date… “fri 3pm”, “every monday”"
          aria-label="Type a date"
          spellCheck={false}
        />
        {parsed && (
          <span className={understood ? "tf-preview" : "tf-preview miss"} aria-live="polite">
            {understood
              ? [parsed.date && relativeLabel(parsed.date, now, locale), parsed.time && timeLabel(parsed.time, locale), parsed.repeat && repeatLabel(parsed.repeat)?.toLowerCase()]
                  .filter(Boolean)
                  .join(" · ")
              : "Try “tomorrow 9am”"}
          </span>
        )}
      </div>
      {repeating && (
        <div className="tf-scope" role="radiogroup" aria-label="Which to move">
          <button type="button" role="radio" aria-checked={scope === "one"} className={scope === "one" ? "on" : ""} onClick={() => setScope("one")}>
            This one
          </button>
          <button type="button" role="radio" aria-checked={scope === "series"} className={scope === "series" ? "on" : ""} onClick={() => setScope("series")}>
            All of them
          </button>
        </div>
      )}
      <button type="button" className={value.date === today && !value.someday ? "tf-opt sel" : "tf-opt"} onClick={() => pick({ due_date: today, evening: false })}>
        <span className="tf-opt-icon">
          <LineIcon name="star" size={16} />
        </span>
        Today<em>{weekday(today)}</em>
      </button>
      <button type="button" className={value.date === tomorrow ? "tf-opt sel" : "tf-opt"} onClick={() => pick({ due_date: tomorrow, evening: false })}>
        <span className="tf-opt-icon">
          <LineIcon name="sun" size={16} />
        </span>
        Tomorrow<em>{weekday(tomorrow)}</em>
      </button>
      <button type="button" className={value.someday ? "tf-opt sel" : "tf-opt"} onClick={() => pick({ someday: true })}>
        <span className="tf-opt-icon">
          <LineIcon name="someday" size={16} />
        </span>
        Someday
      </button>
      <div className="tf-cal">
        <Calendar
          value={value.someday ? null : value.date}
          mark={value.deadline}
          onChange={(iso) => iso && apply({ due_date: iso })}
          onClose={onClose}
          now={now}
          locale={locale}
          autoFocus={false}
          hideQuick
          stayOpen
        />
      </div>
      <div className="tf-pair">
        <button type="button" className={value.time ? "set" : ""} onClick={onTime}>
          <LineIcon name="clock" size={15} />
          {value.time ? timeLabel(value.time, locale) : "Time"}
        </button>
        <button type="button" className={value.repeat ? "set" : ""} onClick={onRepeat}>
          <LineIcon name="repeat" size={15} />
          {value.repeat ? repeatLabel(value.repeat) : "Repeat"}
        </button>
      </div>
      {(value.date || value.someday) && (
        <button type="button" className="tf-opt quiet" onClick={() => pick({ due_date: null, someday: false })}>
          No date
        </button>
      )}
    </div>
  );
}

function DeadlineMenu({
  value,
  now,
  locale,
  onChange,
  onClose,
}: {
  value: FieldValues;
  now: Date;
  locale: string;
  onChange: (patch: TaskPatch) => void;
  onClose: () => void;
}) {
  return (
    <div className="tf-menu right wide" role="dialog" aria-label="Deadline">
      <div className="tf-head">Deadline — the day it must be done by</div>
      <div className="tf-cal">
        <Calendar
          value={value.deadline}
          mark={value.someday ? null : value.date}
          onChange={(iso) => iso && onChange({ deadline: iso })}
          onClose={onClose}
          now={now}
          locale={locale}
          autoFocus={false}
          hideQuick
          stayOpen
          flag
        />
      </div>
      {value.deadline && value.date && value.deadline < value.date && !value.repeat && (
        <p className="tf-help">This is before the day it's planned for.</p>
      )}
      {value.repeat && value.deadline && parseRepeat(value.repeat) && (
        <EndsNote rule={parseRepeat(value.repeat)!} start={value.date ?? toISODate(now)} deadline={value.deadline} locale={locale} />
      )}
      {value.deadline && (
        <button
          type="button"
          className="tf-opt quiet"
          onClick={() => {
            onChange({ deadline: null });
            onClose();
          }}
        >
          Remove deadline
        </button>
      )}
    </div>
  );
}

function TagsMenu({ tags }: { tags: { known: string[]; active: string[]; onToggle: (tag: string) => void } }) {
  const [text, setText] = useState("");
  const all = [...new Set([...tags.active, ...tags.known])];
  const clean = text.trim().replace(/^#+/, "").replace(/\s+/g, "-");
  return (
    <div className="tf-menu right" role="dialog" aria-label="Tags">
      <input
        className="tf-filter"
        autoFocus
        value={text}
        maxLength={40}
        placeholder="Add a tag…"
        aria-label="Add a tag"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            if (clean) tags.onToggle(`#${clean.toLowerCase()}`);
            setText("");
          }
        }}
      />
      {all.length === 0 && <p className="tf-help">Type a tag and press Return. You can also type #tags in the title.</p>}
      {all.map((t) => (
        <button key={t} type="button" role="menuitemcheckbox" aria-checked={tags.active.includes(t)} className={tags.active.includes(t) ? "tf-opt sel" : "tf-opt"} onClick={() => tags.onToggle(t)}>
          <span className="tf-opt-icon">
            <LineIcon name="tag" size={15} />
          </span>
          {t}
          {tags.active.includes(t) && <em>✓</em>}
        </button>
      ))}
    </div>
  );
}

function PlaceMenu({
  places,
  project,
  heading,
  onPick,
}: {
  places: ProjectInfo[];
  project: string | null;
  heading: string | null;
  onPick: (project: string | null, heading: string | null) => void;
}) {
  const [text, setText] = useState("");
  const [newFloor, setNewFloor] = useState<string | null>(null);
  const q = text.trim().toLowerCase();
  const shown = q ? places.filter((p) => p.name.toLowerCase().includes(q) || p.headings.some((h) => h.toLowerCase().includes(q))) : places;
  const exact = places.some((p) => p.name.toLowerCase() === q);
  return (
    <div className="tf-menu" role="dialog" aria-label="Where it goes">
      <input
        className="tf-filter"
        autoFocus
        value={text}
        maxLength={60}
        placeholder="Move to…"
        aria-label="Find a project"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            if (shown[0]) onPick(shown[0].name, null);
            else if (text.trim()) onPick(text.trim(), null);
          }
        }}
      />
      {!q && (
        <>
          <button type="button" className={!project ? "tf-opt sel" : "tf-opt"} onClick={() => onPick(null, null)}>
            <span className="tf-opt-icon">
              <LineIcon name="inbox" size={16} />
            </span>
            Inbox
          </button>
          <div className="tf-sep" />
        </>
      )}
      <div className="tf-scroll">
        {shown.map((p) => {
          const open = p.name === project || (!!q && p.headings.some((h) => h.toLowerCase().includes(q)));
          return (
            <div key={p.name}>
              <PlaceRow name={p.name} sel={p.name === project} onClick={() => onPick(p.name, null)} />
              {open &&
                p.headings
                  .filter((h) => !q || p.name.toLowerCase().includes(q) || h.toLowerCase().includes(q))
                  .map((h) => (
                    <button key={h} type="button" className={p.name === project && h === heading ? "tf-opt sub sel" : "tf-opt sub"} onClick={() => onPick(p.name, h)}>
                      {h}
                    </button>
                  ))}
              {open && !q && p.name === project && (
                newFloor === null ? (
                  <button type="button" className="tf-opt sub quiet" onClick={() => setNewFloor("")}>
                    + New section
                  </button>
                ) : (
                  <input
                    className="tf-filter sub"
                    autoFocus
                    value={newFloor}
                    maxLength={60}
                    placeholder="Section name"
                    aria-label="Section name"
                    onChange={(e) => setNewFloor(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        e.stopPropagation();
                        if (newFloor.trim()) onPick(p.name, newFloor.trim());
                      }
                    }}
                  />
                )
              )}
            </div>
          );
        })}
      </div>
      {q && !exact && (
        <button type="button" className="tf-opt quiet" onClick={() => onPick(text.trim(), null)}>
          + New project “{text.trim()}”
        </button>
      )}
    </div>
  );
}

function PlaceRow({ name, sel, onClick }: { name: string; sel: boolean; onClick: () => void }) {
  const c = useProjectColor(name);
  return (
    <button type="button" className={sel ? "tf-opt sel" : "tf-opt"} onClick={onClick}>
      <span className="tf-opt-icon">
        <i className="tf-ring" style={c ? { borderColor: c } : undefined} aria-hidden />
      </span>
      {name}
    </button>
  );
}
