import { useWords } from "../lib/words";
import { Fragment, useEffect, useState, type ReactElement } from "react";
import { projectList, projectOf, type ListId } from "../lib/lists";
import type { ProjectSummary } from "../lib/types";
import { Pie } from "./ListPicker";
import { initials, type Building } from "../lib/city";
import { bySection } from "../lib/lists";
import { PROJECT_COLORS } from "../lib/colors";
import { MayorAvatar } from "./MayorAvatar";
import { LineIcon, type IconName } from "./LineIcon";

const COLLAPSED_KEY = "todocity.projectsFolded";
function savedFolded(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

interface Props {
  list: ListId;
  /** Settings is showing instead of a list. */
  inSettings: boolean;
  onList: (id: ListId) => void;
  counts: { inbox: number; today: number; overdue: number; agents?: number; agentsWaiting?: number };
  projects: ProjectSummary[];
  tags: string[];
  activeTags: string[];
  onTag: (tag: string) => void;
  onSearch: () => void;
  onSettings: () => void;
  onKeys: () => void;
  /** Open the city. */
  onCity: () => void;
  cityName: string | null;
  mayor: string | null;
  /** The mayor's figure, drawn in 3D. */
  mayorLook: "man" | "woman";
  /** While a task is dragged: the building or floor under the pointer. */
  dropOn: { project: string; heading?: string | null } | null;
  dragging: boolean;
  /** The population: every finished task. */
  lit: number;
  /** The city's buildings (projects), with their floors stacked as drawn. */
  buildings: Building[];
  /** Open a building at one of its floors (null: the ground floor). */
  onFloor: (project: string, floor: string | null) => void;
  /** The floor whose page is showing. */
  floorOn: { project: string; floor: string | null } | null;
  onNewBuilding: (name: string) => void;
  onNewFloor: (project: string, name: string) => void;
  onRenameBuilding: (from: string, to: string) => void;
  /** Take down an empty building. */
  onDeleteBuilding: (name: string) => void;
  onRenameFloor: (project: string, from: string, to: string) => void;
  onDeleteFloor: (project: string, name: string) => void;
  /** Pick a project's color (null: the accent color). */
  onColor: (project: string, color: string | null) => void;
  /** Stop keeping a project in sync with Things 3 or Todoist. */
  onStopSync?: (project: string) => void;
  /** Projects that can start syncing with Todoist ("Sync with Todoist"). */
  syncable?: string[];
  /** Start keeping a project in sync with Todoist. */
  onStartSync?: (project: string) => void;
  /** The window's close, minimize and zoom buttons. */
  lights: ReactElement;
  /** The mode switcher (Work, Personal…), under the title. */
  modeSwitch?: ReactElement;
  /** In a mode: whether it shows this project, and the mode's name. */
  inMode?: (project: string) => boolean;
  modeName?: string;
}

/** Display names of the apps a project can be synced from. */
const SYNC_APPS: Record<string, string> = { things3: "Things 3", todoist: "Todoist" };

/**
 * Full screen's sidebar: search, the lists (Today, Calendar, Inbox,
 * Overdue, Completed), projects with their progress, tags, and — at the
 * bottom — what's reading captures and Settings.
 */
export function Sidebar(p: Props) {
  const w = useWords();
  const project = projectOf(p.list);
  // Buildings opened to show their floors; the one being viewed opens itself.
  const [openB, setOpenB] = useState<Set<string>>(() => new Set());
  // In a mode: projects it hides are listed apart, folded away.
  const [showOthers, setShowOthers] = useState(false);
  const shownB = p.inMode ? p.buildings.filter((b) => p.inMode!(b.project!)) : p.buildings;
  const hiddenB = p.inMode ? p.buildings.filter((b) => !p.inMode!(b.project!)) : [];
  const othersBtn = (
    <button type="button" className="sb-others" aria-expanded={showOthers} onClick={() => setShowOthers((v) => !v)}>
      <svg className={showOthers ? "open" : ""} width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
        <path d="M6 3.5 10.5 8 6 12.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>
        {hiddenB.length} other {hiddenB.length === 1 ? "project" : "projects"}
      </span>
      <span className="sb-others-note">not in {p.modeName ?? "this mode"}</span>
    </button>
  );
  const [adding, setAdding] = useState<
    | { kind: "building" }
    | { kind: "floor"; project: string }
    | { kind: "rename-building"; project: string }
    | { kind: "rename-floor"; project: string; floor: string }
    | null
  >(null);
  const [text, setText] = useState("");
  // The whole Projects section folded away (remembered on this Mac).
  const [folded, setFolded] = useState(savedFolded);
  const fold = () =>
    setFolded((f) => {
      try {
        localStorage.setItem(COLLAPSED_KEY, f ? "0" : "1");
      } catch {
        // Not remembered; fine.
      }
      return !f;
    });
  // The "⋯" menu open on a building or a floor.
  const [menu, setMenu] = useState<{ project: string; floor?: string } | null>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest(".sb-menu, .sb-more")) setMenu(null);
    };
    document.addEventListener("pointerdown", close, true);
    return () => document.removeEventListener("pointerdown", close, true);
  }, [menu]);
  // Hold a dragged task over a closed building and its floors open.
  const hoverB = p.dropOn && p.dropOn.heading === undefined ? p.dropOn.project : null;
  useEffect(() => {
    if (!hoverB) return;
    const t = window.setTimeout(() => setOpenB((s) => (s.has(hoverB) ? s : new Set(s).add(hoverB))), 550);
    return () => window.clearTimeout(t);
  }, [hoverB]);
  useEffect(() => {
    if (project) setOpenB((s) => (s.has(project) ? s : new Set(s).add(project)));
  }, [project]);
  const toggle = (name: string) =>
    setOpenB((s) => {
      const n = new Set(s);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  const done = () => {
    const v = text.trim();
    if (v && adding?.kind === "building") p.onNewBuilding(v);
    if (v && adding?.kind === "floor") p.onNewFloor(adding.project, v);
    if (v && adding?.kind === "rename-building" && v !== adding.project) p.onRenameBuilding(adding.project, v);
    if (v && adding?.kind === "rename-floor" && v !== adding.floor) p.onRenameFloor(adding.project, adding.floor, v);
    setText("");
    setAdding(null);
  };
  const field = (placeholder: string) => (
    <input
      className="sb-new"
      autoFocus
      value={text}
      maxLength={60}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(e) => setText(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") done();
        if (e.key === "Escape") {
          setText("");
          setAdding(null);
        }
      }}
      onBlur={done}
    />
  );
  const item = (id: ListId, text: string, icon: IconName, count?: number, late?: boolean) => {
    const on = !p.inSettings && p.list === id;
    return (
      <button
        key={id}
        type="button"
        className={on ? "sb-item on" : "sb-item"}
        aria-current={on ? "page" : undefined}
        onClick={() => p.onList(id)}
      >
        <span className="sb-icon" aria-hidden>
          <LineIcon name={icon} size={18} />
        </span>
        <span className="sb-text">{text}</span>
        <span className={late ? "sb-count late" : "sb-count"}>{count ? count : ""}</span>
      </button>
    );
  };
  return (
    <aside className={p.dragging ? "sidebar dragging" : "sidebar"} aria-label="Lists">
      <div className="sb-top" data-tauri-drag-region>
        {p.lights}
        <span className="sb-brand" data-tauri-drag-region>
          TodoCity
        </span>
      </div>
      {p.modeSwitch}
      <button type="button" className="sb-search" onClick={p.onSearch} title="Search (/ or ⌘K)">
        <LineIcon name="search" size={17} />
        <span>Search</span>
        <kbd>⌘K</kbd>
      </button>
      <nav className="sb-nav" aria-label="Lists">
        {item("today", "Today", "today", p.counts.today)}
        {item("upcoming", "Calendar", "calendar")}
        {item("inbox", "Inbox", "inbox", p.counts.inbox)}
        {item("overdue", "Overdue", "overdue", p.counts.overdue, true)}
        {item("logbook", "Completed", "done")}
        {(p.counts.agents || p.list === "agents") && item("agents", "With agents", "delegate", p.counts.agentsWaiting || p.counts.agents, !!p.counts.agentsWaiting)}
      </nav>

      <div className="sb-scroll">
        <h2 className="sb-head sb-head-row">
          <button
            type="button"
            className="sb-head-btn"
            onClick={fold}
            aria-expanded={!folded}
            title="Each project is a building in your city"
          >
            {w.projects}
          </button>
          <span className="sb-head-actions">
            <button type="button" className="sb-act" onClick={() => setAdding({ kind: "building" })} aria-label="New project" title="New project">
              <LineIcon name="plus" size={15} />
            </button>
            <button
              type="button"
              className="sb-act"
              onClick={fold}
              aria-label={folded ? "Show projects" : "Hide projects"}
              title={folded ? "Show projects" : "Hide projects"}
              aria-expanded={!folded}
            >
              <LineIcon name={folded ? "chevronRight" : "chevronDown"} size={15} />
            </button>
          </span>
        </h2>
        {adding?.kind === "building" && field(`New ${w.project.toLowerCase()}'s name`)}
        {!folded && <>
        {p.buildings.length === 0 && !adding && (
          <p className="sb-empty">
            Press + to start your first project, or type “@Name” in a task.
          </p>
        )}
        {shownB.length === 0 && hiddenB.length > 0 && !adding && <p className="sb-empty">No projects in {p.modeName ?? "this mode"} yet.</p>}
        {[...shownB, ...(showOthers ? hiddenB : [])].map((b, i) => {
          const name = b.project!;
          const other = i >= shownB.length;
          const on = !p.inSettings && project === name && !(p.floorOn && p.floorOn.project === name);
          const expanded = openB.has(name);
          const pr = p.projects.find((x) => x.name === name);
          const total = (pr?.open ?? b.open) + (pr?.done ?? b.done);
          if (adding?.kind === "rename-building" && adding.project === name) {
            return (
              <div key={name} className="sb-building">
                {field("Project's new name")}
              </div>
            );
          }
          return (
            <Fragment key={name}>
            {other && i === shownB.length && othersBtn}
            <div className={other ? "sb-building sb-other" : "sb-building"}>
              <div
                className={["sb-item sb-b", on ? "on" : "", hoverB === name ? "drop" : ""].filter(Boolean).join(" ")}
                data-drop-project={name}
              >
                <button
                  type="button"
                  className={expanded ? "sb-chev open" : "sb-chev"}
                  onClick={() => toggle(name)}
                  aria-label={expanded ? `Hide ${name}'s sections` : `Show ${name}'s sections`}
                  aria-expanded={expanded}
                >
                  <LineIcon name="chevronRight" size={13} />
                </button>
                <button type="button" className="sb-b-main" aria-current={on ? "page" : undefined} onClick={() => p.onList(projectList(name))}>
                  <span className="sb-icon t-project" aria-hidden style={pr?.color ? { color: pr.color } : undefined}>
                    <Pie done={pr?.done ?? b.done} total={(pr?.open ?? b.open) + (pr?.done ?? b.done)} />
                  </span>
                  <span className="sb-text">{name}</span>
                </button>
                <span className={menu && menu.project === name && !menu.floor ? "sb-trail busy" : "sb-trail"}>
                  <span className="sb-count">{b.open > 0 ? b.open : ""}</span>
                  <span className="sb-row-actions">
                    <button
                      type="button"
                      className="sb-act"
                      aria-label={`New section in ${name}`}
                      title="New section"
                      onClick={() => {
                        setOpenB((s) => new Set(s).add(name));
                        setAdding({ kind: "floor", project: name });
                      }}
                    >
                      <LineIcon name="plus" size={14} />
                    </button>
                    <button
                      type="button"
                      className="sb-act sb-more"
                      aria-expanded={!!menu && menu.project === name && !menu.floor}
                      aria-label={`More for ${name}`}
                      title="Rename, color or delete"
                      onClick={() => setMenu(menu && menu.project === name && !menu.floor ? null : { project: name })}
                    >
                      <LineIcon name="more" size={15} />
                    </button>
                  </span>
                </span>
                {menu && menu.project === name && !menu.floor && (
                  <div className="sb-menu" role="menu">
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(null);
                        setText(name);
                        setAdding({ kind: "rename-building", project: name });
                      }}
                    >
                      Rename project…
                    </button>
                    <button
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(null);
                        setOpenB((s) => new Set(s).add(name));
                        setAdding({ kind: "floor", project: name });
                      }}
                    >
                      Add a section…
                    </button>
                    <p className="sb-menu-label">Color</p>
                    <div className="sb-swatches" role="radiogroup" aria-label={`${name}'s color`}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={!pr?.color}
                        aria-label="Default color"
                        title="Default"
                        className={!pr?.color ? "sb-swatch none on" : "sb-swatch none"}
                        onClick={() => p.onColor(name, null)}
                      />
                      {PROJECT_COLORS.map(([c, label]) => (
                        <button
                          key={c}
                          type="button"
                          role="radio"
                          aria-checked={pr?.color === c}
                          aria-label={label}
                          title={label}
                          className={pr?.color === c ? "sb-swatch on" : "sb-swatch"}
                          style={{ background: c }}
                          onClick={() => p.onColor(name, c)}
                        />
                      ))}
                    </div>
                    {!pr?.synced && p.onStartSync && p.syncable?.includes(name) && (
                      <>
                        <p className="sb-menu-label">Todoist</p>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenu(null);
                            p.onStartSync?.(name);
                          }}
                        >
                          Sync with Todoist
                          <span className="sb-menu-note">Its open tasks go to Todoist too</span>
                        </button>
                      </>
                    )}
                    {pr?.synced && p.onStopSync && (
                      <>
                        <p className="sb-menu-label">Synced from {SYNC_APPS[pr.synced] ?? pr.synced}</p>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenu(null);
                            p.onStopSync?.(name);
                          }}
                        >
                          Stop syncing
                          <span className="sb-menu-note">Its tasks stay here</span>
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      role="menuitem"
                      className="danger"
                      disabled={total > 0}
                      title={total > 0 ? "Move or delete its tasks first" : undefined}
                      onClick={() => {
                        setMenu(null);
                        p.onDeleteBuilding(name);
                      }}
                    >
                      Delete project
                      {total > 0 && <span className="sb-menu-note">Only when it has no tasks</span>}
                    </button>
                  </div>
                )}
              </div>
              {expanded && (
                <div className="sb-floors">
                  {/* Like Slack channels: General first, then the sections A–Z (the list uses the same order). */}
                  {[...b.floors].sort(bySection).map((f) => {
                    const fname = f.name;
                    if (fname && adding?.kind === "rename-floor" && adding.project === name && adding.floor === fname) {
                      return <div key={f.label}>{field("Section's new name")}</div>;
                    }
                    const fOn = !!p.floorOn && p.floorOn.project === name && p.floorOn.floor === fname;
                    const todo = f.rooms.filter((r) => !r.lit).length;
                    const dropHere = !!p.dropOn && p.dropOn.project === name && p.dropOn.heading === (fname ?? null);
                    return (
                      <div
                        key={f.label}
                        className={["sb-floor-row", fOn ? "on" : "", dropHere ? "drop" : ""].filter(Boolean).join(" ")}
                        data-drop-project={name}
                        data-drop-floor={fname ?? ""}
                      >
                        <button
                          type="button"
                          className={fOn ? "sb-floor on" : "sb-floor"}
                          aria-current={fOn ? "page" : undefined}
                          aria-label={fname ?? w.looseHeading}
                          onClick={() => p.onFloor(name, fname)}
                          title={fname ? undefined : "Tasks with no section"}
                        >
                          <span className="sb-hash" aria-hidden>
                            #
                          </span>
                          <span className="sb-floor-name">{fname ?? w.looseHeading}</span>
                        </button>
                        <span className={menu && menu.project === name && menu.floor === fname ? "sb-trail busy" : "sb-trail"}>
                          <span className="sb-count" title={`${todo} to do · ${f.rooms.length - todo} done`}>
                            {todo || ""}
                          </span>
                          {fname && (
                            <span className="sb-row-actions">
                              <button
                                type="button"
                                className="sb-act sb-more"
                                aria-expanded={!!menu && menu.project === name && menu.floor === fname}
                                aria-label={`More for ${f.label}`}
                                title="Rename or delete"
                                onClick={() => setMenu(menu && menu.project === name && menu.floor === fname ? null : { project: name, floor: fname })}
                              >
                                <LineIcon name="more" size={15} />
                              </button>
                            </span>
                          )}
                        </span>
                        {fname && menu && menu.project === name && menu.floor === fname && (
                          <div className="sb-menu" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMenu(null);
                                setText(fname);
                                setAdding({ kind: "rename-floor", project: name, floor: fname });
                              }}
                            >
                              Rename section…
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="danger"
                              disabled={f.rooms.length > 0}
                              title={f.rooms.length > 0 ? "Delete or move its tasks first" : undefined}
                              onClick={() => {
                                setMenu(null);
                                p.onDeleteFloor(name, fname);
                              }}
                            >
                              Delete section
                              {f.rooms.length > 0 && <span className="sb-menu-note">Only when it has no tasks</span>}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {adding?.kind === "floor" && adding.project === name && field(`New ${w.heading.toLowerCase()}'s name`)}
                </div>
              )}
            </div>
            </Fragment>
          );
        })}
        {hiddenB.length > 0 && !showOthers && othersBtn}
        </>}

        {p.tags.length > 0 && (
          <>
            <h2 className="sb-head">Tags</h2>
            <div className="sb-tags">
              {p.tags.map((t) => (
                <button
                  key={t}
                  type="button"
                  className={p.activeTags.includes(t) ? "sb-tag on" : "sb-tag"}
                  aria-pressed={p.activeTags.includes(t)}
                  onClick={() => p.onTag(t)}
                >
                  {t}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="sb-foot">
        <div className="sb-me">
          <button type="button" className="sb-mayor" onClick={p.onCity} title="Open your city">
            <MayorAvatar look={p.mayorLook} fallback={initials(p.mayor)} />
            <span className="sb-mayor-text">
              <span className="sb-mayor-title">{p.mayor ? `Mayor ${p.mayor}` : "The mayor"}</span>
              <span className="sb-mayor-sub">{p.cityName ?? "Name your city"}</span>
            </span>
          </button>
          <button type="button" className="sb-act big" onClick={p.onKeys} title="Keyboard shortcuts" aria-label="Keyboard shortcuts">
            <LineIcon name="keyboard" size={19} />
          </button>
          <button
            type="button"
            className={p.inSettings ? "sb-act big on" : "sb-act big"}
            onClick={p.onSettings}
            title="Settings (⌘,)"
            aria-label="Settings"
            aria-pressed={p.inSettings}
          >
            <LineIcon name="gear" size={19} />
          </button>
        </div>
      </div>
    </aside>
  );
}

