import { useCallback, useEffect, useState } from "react";
import { api, onFocusChanged, onTasksChanged } from "../lib/api";
import { addDays, toISODate } from "../lib/dates";
import { FOCUS_LENGTHS, focusNow, leftLabel, minutesLeft, parseFocusEntry, parseStamp, pickedTasks, wrapUpId, wrapUpLine } from "../lib/focus";
import { timeLabel } from "../lib/schedule";
import type { TaskActions } from "../lib/taskActions";
import type { FocusStatus, Task } from "../lib/types";

/** Focus Blocks' status, kept fresh (and re-read every half minute for the countdown). */
export function useFocusStatus(): [FocusStatus | null, () => void] {
  const [status, setStatus] = useState<FocusStatus | null>(null);
  const refresh = useCallback(() => {
    api
      .focusStatus()
      .then(setStatus)
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refresh();
    const subs = [onFocusChanged(refresh), onTasksChanged(refresh)];
    const timer = window.setInterval(refresh, 30_000);
    return () => {
      window.clearInterval(timer);
      subs.forEach((s) => void s.then((u) => u()));
    };
  }, [refresh]);
  return [status, refresh];
}

/** Wrap-up cards closed this session. */
const dismissed = new Set<string>();

const clock = (stamp: string, locale: string) => timeLabel(stamp.slice(11, 16), locale);

/**
 * The focus block going on now: only its tasks, the time left, and a way to
 * add 15 minutes or end it. Afterwards, a short wrap-up: what got done, and
 * where the rest goes. Nothing when Focus Blocks are off.
 */
export function FocusNow({
  tasks,
  actions,
  locale,
  compact,
  idle,
  onError,
}: {
  tasks: Task[];
  actions: TaskActions;
  locale: string;
  compact?: boolean;
  /** Also show the next block and "Focus now" when nothing is running. */
  idle?: boolean;
  onError?: (message: string) => void;
}) {
  const [status, refresh] = useFocusStatus();
  const [busy, setBusy] = useState(false);
  const [, setTick] = useState(0);
  const [startOpen, setStartOpen] = useState(false);
  useEffect(() => {
    if (!status?.active) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 15_000);
    return () => window.clearInterval(t);
  }, [status?.active]);

  if (!status?.supported || !status.enabled || !status.calendar) return null;

  const run = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
      refresh();
    } catch (e) {
      onError?.(String(e));
    } finally {
      setBusy(false);
    }
  };
  const cls = compact ? "focus-now compact" : "focus-now";
  const now = new Date();

  if (status.active) {
    const a = status.active;
    const picked = pickedTasks(a.tasks, tasks);
    return (
      <section className={`${cls} on`} aria-label="Focus block">
        <div className="focus-head">
          <span className="focus-moon" aria-hidden />
          <span className="focus-text">
            <strong>{a.title}</strong>
            <span>
              Focus is on until {clock(a.end, locale)} · {leftLabel(minutesLeft(a.end, now))}
            </span>
          </span>
        </div>
        {status.error && (
          <div className="focus-line">
            <span className="focus-note">{status.error}</span>
            <button type="button" className="ghost small" disabled={busy} onClick={() => void run(api.focusResume)}>
              Turn on Focus
            </button>
          </div>
        )}
        {picked.length > 0 ? (
          <ul className="focus-tasks">
            {picked.map((t) => (
              <li key={t.id} className={t.done ? "done" : undefined}>
                <label>
                  <input type="checkbox" checked={t.done} onChange={(e) => void actions.setDone(t, e.target.checked)} />
                  <span>{t.title}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="focus-note">One thing at a time — everything else can wait until {clock(a.end, locale)}.</p>
        )}
        <div className="focus-actions">
          <button type="button" className="ghost small" disabled={busy} onClick={() => void run(() => api.focusExtend(15))}>
            +15 min
          </button>
          <button type="button" className="ghost small" disabled={busy} onClick={() => void run(api.focusEndNow)}>
            End now
          </button>
        </div>
      </section>
    );
  }

  const last = status.last;
  if (last && !dismissed.has(wrapUpId(last))) {
    const picked = pickedTasks(last.tasks, tasks);
    const open = picked.filter((t) => !t.done);
    const tomorrow = toISODate(addDays(now, 1));
    const close = () => {
      dismissed.add(wrapUpId(last));
      refresh();
      setTick((n) => n + 1);
    };
    return (
      <section className={cls} aria-label="Focus block finished">
        <div className="focus-head">
          <span className="focus-moon done" aria-hidden />
          <span className="focus-text">
            <strong>{wrapUpLine(picked)}</strong>
            <span>
              {last.title} · {clock(last.start, locale)} – {clock(last.end, locale)}
            </span>
          </span>
          <button type="button" className="focus-close" aria-label="Close" onClick={close}>
            ×
          </button>
        </div>
        {open.length > 0 && (
          <ul className="focus-tasks">
            {open.map((t) => (
              <li key={t.id}>
                <span className="focus-task-title">{t.title}</span>
                <button type="button" className="ghost small" onClick={() => void actions.reschedule(t, { due_date: tomorrow, due_time: null })}>
                  Tomorrow
                </button>
                <button type="button" className="ghost small" onClick={() => void actions.setDone(t, true)}>
                  Done
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="focus-actions">
          <button
            type="button"
            className="ghost small"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.focusAddBlock({ ...focusNow(new Date(), status.minutes), tasks: open.map((t) => t.id) });
                dismissed.add(wrapUpId(last));
              })
            }
          >
            Focus again for {status.minutes} min
          </button>
        </div>
      </section>
    );
  }

  // Not focusing: the next block today, and a quick way to start one.
  if (!idle) return null;
  const next = status.next;
  const soon = next && parseStamp(next.start).getTime() - now.getTime() < 3 * 3600_000;
  return (
    <section className={`${cls} quiet`} aria-label="Focus">
      <div className="focus-line">
        <span className="focus-moon idle" aria-hidden />
        <span className="focus-note">
          {soon && next ? `Next focus block ${clock(next.start, locale)} · ${next.title}` : "Ready to focus?"}
        </span>
        {startOpen ? (
          FOCUS_LENGTHS.map((m) => (
            <button
              key={m}
              type="button"
              className="ghost small"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setStartOpen(false);
                  await api.focusAddBlock({ ...focusNow(new Date(), m), tasks: [] });
                })
              }
            >
              {m} min
            </button>
          ))
        ) : (
          <button type="button" className="ghost small" onClick={() => setStartOpen(true)}>
            Focus now
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * "Focus…" typed into Calendar's field at an hour makes a focus block there
 * (when Focus Blocks are on). True when it did; anything else is a task.
 */
export async function addFocusFromEntry(typed: string, iso: string, at: string | null): Promise<boolean> {
  const entry = parseFocusEntry(typed);
  if (!entry || at === null) return false;
  const status = await api.focusStatus().catch(() => null);
  if (!status?.enabled || !status.calendar) return false;
  const start = parseStamp(`${iso}T${at}:00`);
  const minutes = entry.minutes ?? status.minutes;
  await api.focusAddBlock({ ...focusNow(start, minutes), title: entry.title, tasks: [] });
  return true;
}
