import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, onMirrorChanged, onTodoistProgress } from "../lib/api";
import { Toggle } from "./GeneralSettings";
import { InfoTip } from "./InfoTip";
import type { ImportReport, MirrorLink, MirrorSource, ThingsOptions, ThingsPreviewData } from "../lib/types";

/** What a preview shows, whichever app it came from. */
interface Found {
  /** "Found your Things library · saved …" */
  line: string;
  title?: string;
  preview: ThingsPreviewData;
}

type Phase =
  | { kind: "idle" }
  | { kind: "reading" }
  | { kind: "preview"; found: Found }
  | { kind: "moving"; found: Found }
  | { kind: "done"; report: ImportReport }
  | { kind: "error"; message: string };

const n = (x: number) => x.toLocaleString();
const plural = (x: number, one: string, many = `${one}s`) => `${n(x)} ${x === 1 ? one : many}`;

/** What goes where, Things 3 → TodoCity. */
const THINGS_MAP: [string, string][] = [
  ["Project", "Project"],
  ["Heading", "Section"],
  ["To-do", "Task"],
  ["Checklist", "Sub-tasks"],
  ["Area", "Its projects come as they are; to-dos sitting right in the area become a project named after it"],
  ["Inbox and loose to-dos", "Tasks with no project"],
  ["Today, This Evening, Upcoming", "The same day (and evening)"],
  ["Anytime", "No day"],
  ["Someday", "Someday"],
  ["Deadline", "Deadline"],
  ["Reminder time", "Time of day"],
  ["Repeating to-do", "Repeat — daily, weekdays, weekly, every 2 weeks, monthly, yearly"],
  ["Notes", "Notes"],
  ["Tags", "#tags on the task"],
  ["Logbook", "Done tasks — lit windows in your city"],
];

/** What goes where, Todoist → TodoCity. */
const TODOIST_MAP: [string, string][] = [
  ["Project", "Project, sub-projects too"],
  ["Inbox", "Tasks with no project"],
  ["Section", "Section"],
  ["Task", "Task"],
  ["Sub-tasks (any depth)", "Sub-tasks"],
  ["Labels", "#tags on the task"],
  ["Priority 1–3", "Priority P1, P2, P3"],
  ["Description and comments", "Notes"],
  ["Date and time", "Day and time of day"],
  ["Deadline", "Deadline"],
  ["Recurring date", "Repeat — daily, weekdays, weekly, every 2 weeks, monthly, yearly"],
  ["Completed tasks", "Done tasks — lit windows in your city (with a token)"],
];

/**
 * Moving in from Things 3 (read on this Mac) or Todoist (over its API with
 * your token, or from CSV files), and keeping it in sync afterwards. Each
 * lives in its card in Settings → Connectors; how it works is behind (i).
 */

/** Shared state for one move-in: options, skipped buildings, the phase. */
function useMoveIn() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [includeDone, setIncludeDone] = useState(true);
  const [includeCanceled, setIncludeCanceled] = useState(false);
  const [priorityTags, setPriorityTags] = useState(true);
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [keepSync, setKeepSync] = useState(true);
  const options = useCallback(
    (): ThingsOptions => ({
      include_done: includeDone,
      include_canceled: includeCanceled,
      priority_tags: priorityTags,
      skip: [...skip],
    }),
    [includeDone, includeCanceled, priorityTags, skip],
  );
  return { phase, setPhase, includeDone, setIncludeDone, includeCanceled, setIncludeCanceled, priorityTags, setPriorityTags, skip, setSkip, keepSync, setKeepSync, options };
}

/** Whether an app is kept in sync, kept fresh. */
function useLink(source: MirrorSource) {
  const [link, setLink] = useState<MirrorLink | null | undefined>(undefined);
  const load = useCallback(() => {
    api
      .mirrorStatus()
      .then((s) => setLink(s[source]))
      .catch(() => setLink(null));
  }, [source]);
  useEffect(() => {
    load();
    const un = onMirrorChanged(load);
    // "Synced 2 min ago" stays right.
    const t = window.setInterval(load, 30_000);
    return () => {
      window.clearInterval(t);
      void un.then((u) => u());
    };
  }, [load]);
  return { link, reload: load };
}

function ago(iso: string | null): string {
  if (!iso) return "not yet";
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Shown while an app is kept in sync: how it's going, which way, Sync now, Stop. */
function SyncCard({ source, app, link, onChange }: { source: MirrorSource; app: string; link: MirrorLink; onChange: () => void }) {
  const [busy, setBusy] = useState<"now" | "stop" | "way" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const run = async (what: "now" | "stop") => {
    setBusy(what);
    setProblem(null);
    try {
      if (what === "now") await api.mirrorSyncNow(source);
      else await api.mirrorStop(source);
    } catch (e) {
      setProblem(String(e));
    } finally {
      setBusy(null);
      onChange();
    }
  };
  const setWay = async (on: boolean) => {
    setBusy("way");
    setProblem(null);
    try {
      await api.mirrorSetTwoWay(source, on);
    } catch (e) {
      setProblem(String(e));
    } finally {
      setBusy(null);
      onChange();
    }
  };
  const error = problem ?? link.error;
  return (
    <section className="tr-sync" aria-label={`Syncing with ${app}`}>
      <div className="tr-sync-head">
        <span className={error ? "tr-sync-dot bad" : "tr-sync-dot"} aria-hidden />
        <div>
          <h3>Syncing with {app}</h3>
          <p className="tr-small">
            Synced {ago(link.last)} · {plural(link.projects, "project")}
          </p>
        </div>
      </div>
      {link.can_two_way && (
        <Toggle
          checked={link.two_way}
          disabled={busy !== null}
          onChange={(v) => void setWay(v)}
          label="Two-way sync"
          hint={
            link.two_way
              ? `Edit in either app; changes go both ways. When the same thing changes in both, ${app}'s change is kept.`
              : `Changes in ${app} come in here. Your edits here stay in TodoCity.`
          }
        />
      )}
      <p className="tr-sync-text">
        {link.two_way
          ? `Tasks you add to a synced project here go to ${app} too. To stop one project, use its ⋯ menu.`
          : `Edit anything in TodoCity — your change stays until the same thing changes in ${app}. To stop one project, use its ⋯ menu.`}
      </p>
      {error && (
        <p className="tr-sync-error" role="alert">
          {error}
        </p>
      )}
      <div className="tr-actions">
        <button type="button" className="ghost" disabled={busy !== null} onClick={() => void run("now")}>
          {busy === "now" ? "Syncing…" : "Sync now"}
        </button>
        <button type="button" className="ghost" disabled={busy !== null} onClick={() => void run("stop")}>
          {busy === "stop" ? "Stopping…" : "Stop syncing"}
        </button>
      </div>
    </section>
  );
}

export function ThingsConnector({ onFinished }: { onFinished: () => void }) {
  const m = useMoveIn();
  const { link, reload } = useLink("things");
  const { phase, setPhase, includeDone, includeCanceled } = m;
  const [path, setPath] = useState<string | null>(null);

  const read = useCallback(
    async (p: string | null, opts: ThingsOptions) => {
      setPhase({ kind: "reading" });
      try {
        const data = await api.thingsPreview(p, opts);
        setPhase({
          kind: "preview",
          found: {
            line: `Found your Things library${data.source.modified ? ` · saved ${new Date(data.source.modified).toLocaleString()}` : ""}`,
            title: data.source.path,
            preview: data.preview,
          },
        });
      } catch (e) {
        setPhase({ kind: "error", message: String(e) });
      }
    },
    [setPhase],
  );

  // The counts depend on these two, so read again when they change.
  const previewing = phase.kind === "preview";
  useEffect(() => {
    if (previewing) void read(path, { ...m.options(), skip: [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeDone, includeCanceled]);

  async function pick() {
    try {
      const p = await api.thingsPick();
      if (!p) return;
      setPath(p);
      m.setSkip(new Set());
      await read(p, m.options());
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  }

  return (
    <>
      {link && phase.kind !== "done" && <SyncCard source="things" app="Things" link={link} onChange={reload} />}

      {!link && phase.kind !== "done" && (
        <HowTo
          intro="Projects, headings, to-dos, checklists and the Logbook come in, and keep flowing in."
          map={<MapTable from="Things 3" rows={THINGS_MAP} foot="Trashed to-dos stay behind. Projects you've finished come with their to-dos as done." />}
        >
          <li>
            <b>Open Things 3 on this Mac</b> and let it finish syncing, so this Mac has all your to-dos. Only use
            Things on iPhone or iPad? Install Things 3 for Mac and sign in to Things Cloud first.
          </li>
          <li>
            <b>Click Find my Things library.</b> If macOS asks whether TodoCity may access data from other apps,
            click <b>Allow</b>.
          </li>
          <li>
            <b>Check the preview.</b> Untick any project you'd rather leave behind, and choose whether to bring your
            Logbook.
          </li>
          <li>
            <b>Click Import.</b> TodoCity backs itself up first. With <b>Keep in sync</b> on, whatever changes in Things
            keeps flowing in.
          </li>
        </HowTo>
      )}

      {!link && (phase.kind === "idle" || phase.kind === "error" || phase.kind === "reading") && (
        <div className="tr-actions">
          <button type="button" className="primary" disabled={phase.kind === "reading"} onClick={() => void read(path, m.options())}>
            {phase.kind === "reading" ? "Reading Things…" : "Find my Things library"}
          </button>
          <button type="button" className="ghost" disabled={phase.kind === "reading"} onClick={() => void pick()}>
            Choose the database myself…
          </button>
        </div>
      )}

      {!link && phase.kind === "error" && (
        <div className="tr-error" role="alert">
          <p>{phase.message}</p>
          <details>
            <summary>Where is the Things database?</summary>
            <p>
              In Finder, choose <b>Go → Go to Folder…</b> and paste
              <code>~/Library/Group Containers/JLMPQHK86H.com.culturedcode.ThingsMac</code>
              Open the <b>ThingsData-…</b> folder inside (older versions don't have one) and pick{" "}
              <b>Things Database.thingsdatabase</b>. Copying it to your Desktop first and choosing the copy works too.
            </p>
          </details>
        </div>
      )}

      {!link && (phase.kind === "preview" || phase.kind === "moving") && (
        <PreviewPanel
          m={m}
          found={phase.found}
          app="Things"
          canSync
          unit="to-do"
          loose="No project — Inbox and loose to-dos"
          toggles={
            <>
              <Toggle
                checked={m.includeDone}
                onChange={m.setIncludeDone}
                label="Bring the Logbook"
                hint="Finished to-dos come as done tasks — each one a lit window in your city."
              />
              <Toggle
                checked={m.includeCanceled}
                onChange={m.setIncludeCanceled}
                label="Bring cancelled to-dos"
                hint={`As done tasks.${phase.found.preview.canceled ? ` ${plural(phase.found.preview.canceled, "cancelled to-do")} would stay behind otherwise.` : ""}`}
              />
            </>
          }
          onMove={() => api.thingsImport(path, m.options(), m.keepSync)}
          other={
            <button type="button" className="ghost" disabled={phase.kind === "moving"} onClick={() => void pick()}>
              Use a different database…
            </button>
          }
        />
      )}

      {phase.kind === "done" && (
        <DonePanel report={phase.report} app="Things" synced={!!link} onFinished={onFinished} onAgain={() => setPhase({ kind: "idle" })} />
      )}

    </>
  );
}

export function TodoistConnector({ onFinished }: { onFinished: () => void }) {
  const m = useMoveIn();
  const { phase, setPhase, includeDone, priorityTags } = m;
  const [token, setToken] = useState("");
  const { link, reload } = useLink("todoist");
  // Kept (off screen) for Keep in sync, which saves it in the Keychain.
  const tokenRef = useRef<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [kind, setKind] = useState<"api" | "csv">("api");

  useEffect(() => {
    const un = onTodoistProgress(setProgress);
    return () => void un.then((u) => u());
  }, []);

  const read = useCallback(
    async (from: { token?: string; files?: string[] } | null, opts: ThingsOptions) => {
      setPhase({ kind: "reading" });
      setProgress(null);
      try {
        const data = await api.todoistPreview(from, opts);
        setKind(data.source.kind);
        if (from?.token) tokenRef.current = from.token;
        else if (from?.files) tokenRef.current = null;
        // The token was used once; don't keep it on screen.
        if (from?.token) setToken("");
        setPhase({
          kind: "preview",
          found: {
            line: data.source.kind === "api" ? "Connected to your Todoist account" : `Read ${data.source.label} from Todoist`,
            preview: data.preview,
          },
        });
      } catch (e) {
        setPhase({ kind: "error", message: String(e) });
      }
    },
    [setPhase],
  );

  // Changing these re-plans what was already read (no new requests).
  const previewing = phase.kind === "preview";
  useEffect(() => {
    if (previewing) void read(null, { ...m.options(), skip: [] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [includeDone, priorityTags]);

  async function pickFiles() {
    try {
      const files = await api.todoistPickFiles();
      if (!files.length) return;
      m.setSkip(new Set());
      await read({ files }, m.options());
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  }

  const connect = () => {
    if (!token.trim()) return;
    m.setSkip(new Set());
    void read({ token: token.trim() }, m.options());
  };

  return (
    <>
      {link && phase.kind !== "done" && <SyncCard source="todoist" app="Todoist" link={link} onChange={reload} />}

      {!link && phase.kind !== "done" && (
        <HowTo
          intro="Projects, sections, tasks, labels, comments and completed tasks come in, then stay in sync both ways."
          map={
            <MapTable
              from="Todoist"
              rows={TODOIST_MAP}
              foot="Deleted tasks stay behind. Archived projects only come for their completed tasks. Custom repeats come once, with a note so you can pick a repeat."
            />
          }
        >
          <li>
            <b>Copy your API token from Todoist.</b> In Todoist (web or app) open <b>Settings → Integrations → Developer</b>{" "}
            and click <b>Copy API token</b>.
          </li>
          <li>
            <b>Paste it below and click Connect.</b> TodoCity reads your Todoist straight from Todoist's servers to
            this Mac — big accounts take a minute while completed tasks come in, year by year.
          </li>
          <li>
            <b>Check the preview.</b> Untick any project you'd rather leave behind, and choose whether to bring completed
            tasks.
          </li>
          <li>
            <b>Click Import.</b> TodoCity backs itself up first. With <b>Keep in sync</b> on, changes go both ways
            (you can switch to one-way any time); your token is kept in the macOS Keychain for that, and deleted when you
            stop.
          </li>
        </HowTo>
      )}

      {!link && (phase.kind === "idle" || phase.kind === "error" || phase.kind === "reading") && (
        <>
          <form
            className="tr-token"
            onSubmit={(e) => {
              e.preventDefault();
              connect();
            }}
          >
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="Paste your Todoist API token"
              aria-label="Todoist API token"
              autoComplete="off"
              spellCheck={false}
              disabled={phase.kind === "reading"}
            />
            <button type="submit" className="primary" disabled={phase.kind === "reading" || !token.trim()}>
              {phase.kind === "reading" ? "Reading Todoist…" : "Connect"}
            </button>
          </form>
          {phase.kind === "reading" && progress && <p className="tr-progress">{progress}</p>}
          <details className="tr-alt">
            <summary>No token? Use CSV files instead</summary>
            <p>
              In Todoist, open a project, click <b>⋯ → Export as CSV</b>, and repeat for each project you want. On Pro,
              you can instead download a backup from <b>Settings → Backups</b> and unzip it. Then choose all the .csv
              files together. CSV files don't include completed tasks, so your city starts dark.
            </p>
            <button type="button" className="ghost" disabled={phase.kind === "reading"} onClick={() => void pickFiles()}>
              Choose CSV files…
            </button>
          </details>
        </>
      )}

      {!link && phase.kind === "error" && (
        <div className="tr-error" role="alert">
          <p>{phase.message}</p>
          <details>
            <summary>Where is my Todoist API token?</summary>
            <p>
              Open Todoist on the web or in the app, go to <b>Settings → Integrations → Developer</b>, and click{" "}
              <b>Copy API token</b>. It's a long string of letters and numbers. If you ever want to cut off access,
              Todoist lets you issue a new token there.
            </p>
          </details>
        </div>
      )}

      {!link && (phase.kind === "preview" || phase.kind === "moving") && (
        <PreviewPanel
          m={m}
          found={phase.found}
          app="Todoist"
          canSync={kind === "api"}
          twoWay
          unit="task"
          loose="Inbox (tasks with no project)"
          toggles={
            <>
              <Toggle
                checked={m.includeDone && kind === "api"}
                onChange={m.setIncludeDone}
                disabled={kind === "csv"}
                label="Bring completed tasks"
                hint={kind === "csv" ? "CSV files don't include completed tasks — connect with a token for those." : "Each one comes as a done task — a lit window in your city."}
              />
            </>
          }
          onMove={() => api.todoistImport(m.options(), m.keepSync && kind === "api", tokenRef.current)}
          other={
            <button type="button" className="ghost" disabled={phase.kind === "moving"} onClick={() => setPhase({ kind: "idle" })}>
              Start over
            </button>
          }
        />
      )}

      {phase.kind === "done" && (
        <DonePanel report={phase.report} app="Todoist" synced={!!link} twoWay={!!link?.two_way} onFinished={onFinished} onAgain={() => setPhase({ kind: "idle" })} />
      )}

    </>
  );
}

/** The preview: what was found, options, buildings to tick, and Import. */
function PreviewPanel({
  m,
  found,
  app,
  canSync,
  twoWay = false,
  unit,
  loose,
  toggles,
  onMove,
  other,
}: {
  m: ReturnType<typeof useMoveIn>;
  found: Found;
  app: string;
  /** Keep in sync is possible (not for CSV files). */
  canSync: boolean;
  /** Keeping in sync goes both ways. */
  twoWay?: boolean;
  unit: string;
  loose: string;
  toggles: ReactNode;
  onMove: () => Promise<ImportReport>;
  other: ReactNode;
}) {
  const { phase, setPhase, skip, setSkip, includeDone } = m;
  const moving = phase.kind === "moving";
  const chosen = useMemo(() => {
    const on = found.preview.buildings.filter((b) => !skip.has(b.key));
    const open = on.reduce((s, b) => s + b.open, 0);
    const done = on.reduce((s, b) => s + b.done, 0);
    return { open, done, buildings: on.filter((b) => b.kind !== "loose").length };
  }, [found, skip]);
  // The counts are only what's new: earlier imports are left out already.
  const toMove = chosen.open + chosen.done;
  const syncing = canSync && m.keepSync;

  async function move() {
    setPhase({ kind: "moving", found });
    try {
      setPhase({ kind: "done", report: await onMove() });
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  }

  const p = found.preview;
  return (
    <section className="tr-preview" aria-label="What will be imported">
      <p className="tr-found" title={found.title}>
        {found.line}
      </p>
      <div className="tr-stats">
        <Stat value={chosen.open} label="to do" />
        <Stat value={chosen.done} label="done" />
        <Stat value={chosen.buildings} label="projects" />
        <Stat value={p.subtasks} label="sub-tasks" />
      </div>

      <div className="tr-options">
        {canSync && (
          <Toggle
            checked={m.keepSync}
            onChange={m.setKeepSync}
            label="Keep in sync"
            hint={
              twoWay
                ? `Changes go both ways: edit here or in ${app}. You can switch to one-way any time.`
                : `Changes in ${app} keep flowing in. Your edits here stay.`
            }
          />
        )}
        {toggles}
      </div>

      <h3 className="tr-h">Projects</h3>
      <ul className="tr-list">
        {p.buildings.map((b) => {
          const on = !skip.has(b.key);
          return (
            <li key={b.key || "loose"} className={on ? "" : "off"}>
              <label>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() =>
                    setSkip((s) => {
                      const next = new Set(s);
                      if (next.has(b.key)) next.delete(b.key);
                      else next.add(b.key);
                      return next;
                    })
                  }
                />
                <span className="tr-name">
                  {b.kind === "loose" ? loose : b.name}
                  {b.area && <span className="tr-tag">{b.area}</span>}
                  {b.kind === "area" && <span className="tr-tag">area</span>}
                </span>
                <span className="tr-count">
                  {[b.open && `${n(b.open)} to do`, includeDone && b.done && `${n(b.done)} done`, b.floors && plural(b.floors, "section")]
                    .filter(Boolean)
                    .join(" · ") || "empty"}
                </span>
              </label>
            </li>
          );
        })}
      </ul>

      <ul className="tr-notes">
        {p.already > 0 && <li>{plural(p.already, unit)} moved in earlier — they won't be added twice.</li>}
        {p.someday > 0 && <li>{plural(p.someday, unit)} go to Someday.</li>}
        {p.repeating > 0 && <li>{plural(p.repeating, `repeating ${unit}`)} keep their repeat.</li>}
        {p.unmapped_repeats > 0 && (
          <li>
            {p.unmapped_repeats === 1
              ? "1 custom repeat comes once, with a note so you can pick a repeat."
              : `${n(p.unmapped_repeats)} custom repeats come once, with a note so you can pick a repeat.`}
          </li>
        )}
      </ul>

      <div className="tr-actions">
        <button type="button" className="primary" disabled={moving || (toMove === 0 && !syncing)} onClick={() => void move()}>
          {moving
            ? "Importing…"
            : toMove === 0
              ? syncing
                ? "Start syncing"
                : "Nothing new to import"
              : `Import ${plural(toMove, unit)}`}
        </button>
        {other}
      </div>
    </section>
  );
}

function DonePanel({
  report,
  app,
  synced,
  twoWay = false,
  onFinished,
  onAgain,
}: {
  report: ImportReport;
  app: string;
  synced: boolean;
  twoWay?: boolean;
  onFinished: () => void;
  onAgain: () => void;
}) {
  return (
    <section className="tr-done" aria-live="polite">
      <h3>Welcome home.</h3>
      <p>
        {report.added
          ? `${plural(report.added, "task")} imported${report.done ? ` — ${plural(report.done, "window")} lit up in your city` : ""}.`
          : "Everything was already here — nothing new to import."}
        {report.skipped > 0 && ` ${plural(report.skipped, "task")} were already here.`}
        {report.failed > 0 && ` ${plural(report.failed, "task")} stayed in ${app} — import again to bring them over.`}
        {synced &&
          (twoWay
            ? ` From now on, ${app} and TodoCity stay in sync both ways.`
            : ` From now on, changes in ${app} flow in on their own.`)}
      </p>
      <p className="tr-small">
        A backup from just before is in Settings → Backups & export, if you want to undo this. Moved-in tasks aren't sent to
        Apple Reminders on their own.
      </p>
      <div className="tr-actions">
        <button type="button" className="primary" onClick={onFinished}>
          See your tasks
        </button>
        {!synced && (
          <button type="button" className="ghost" onClick={onAgain}>
            Import again
          </button>
        )}
      </div>
    </section>
  );
}

/** What goes where, as a small table for an (i). */
function MapTable({ from, rows, foot }: { from: string; rows: [string, string][]; foot: string }) {
  return (
    <>
      <table className="tr-map-table">
        <thead>
          <tr>
            <th>{from}</th>
            <th>TodoCity</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([a, b]) => (
            <tr key={a}>
              <td>{a}</td>
              <td>{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>{foot}</p>
    </>
  );
}

/** One line on what comes in, with the steps and the map behind (i)s. */
function HowTo({ intro, map, children }: { intro: string; map: ReactNode; children: ReactNode }) {
  return (
    <div className="tr-howto">
      <p>{intro}</p>
      <span className="tr-howto-tips">
        How to move in <InfoTip label="How to move in" wide text={<ol className="tr-steps">{children}</ol>} />
        <span aria-hidden>·</span>
        What goes where <InfoTip label="What goes where" wide text={map} />
      </span>
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="tr-stat">
      <b>{n(value)}</b>
      <span>{label}</span>
    </div>
  );
}

/** A plain check-in-a-square mark (not Things' own logo). */
export function ThingsGlyph() {
  return (
    <svg className="tr-glyph" viewBox="0 0 40 40" aria-hidden="true">
      <rect x="2" y="2" width="36" height="36" rx="9" fill="#2f7bf5" />
      <rect x="10" y="10" width="20" height="20" rx="4" fill="none" stroke="#fff" strokeWidth="2.6" />
      <path d="M14.5 20.5l4 4 7-8" fill="none" stroke="#fff" strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A plain list-with-a-tick mark in red (not Todoist's own logo). */
export function TodoistGlyph() {
  return (
    <svg className="tr-glyph" viewBox="0 0 40 40" aria-hidden="true">
      <rect x="2" y="2" width="36" height="36" rx="9" fill="#e4553f" />
      <path d="M11 14h18M11 20h18M11 26h10" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M24 26.5l2.5 2.5 4.5-5" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
