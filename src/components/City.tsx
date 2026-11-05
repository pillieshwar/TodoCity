import { MayorAvatar } from "./MayorAvatar";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { CITY_NAMES, SOMEDAY_KEY, cityStats, initials, type City, type CityRange } from "../lib/city";
import { api } from "../lib/api";
import { MILESTONES, MILESTONE_RULES, nextMilestone, reachedMilestones, type Milestone } from "../lib/milestones";
import type { Picked } from "./CityScene";

// three.js loads only when the city is first shown (full screen).
const CityScene = lazy(() => import("./CityScene").then((m) => ({ default: m.CityScene })));

const hasWebGL = (() => {
  let ok: boolean | null = null;
  return () => {
    if (ok === null) {
      try {
        const c = document.createElement("canvas");
        ok = !!(c.getContext("webgl2") || c.getContext("webgl"));
      } catch {
        ok = false;
      }
    }
    return ok;
  };
})();

/** The city in 3D (three.js). */
function City3D(props: {
  city: City;
  range: CityRange;
  now: Date;
  still?: boolean;
  labels?: boolean;
  mayor?: string | null;
  onPick?: (key: string) => void;
  onHover?: (h: Picked | null) => void;
  onInteract?: () => void;
}) {
  const dark = useDark();
  if (!hasWebGL()) return <div className="city3d city3d-none">Your city appears here when 3D graphics are turned on for TodoCity.</div>;
  return (
    <Suspense fallback={<div className="city3d" />}>
      <CityScene {...props} dark={dark} />
    </Suspense>
  );
}

const isDark = () => {
  // The city's own sky, when one is picked in Preferences.
  const sky = document.documentElement.dataset.citySky;
  if (sky === "night") return true;
  if (sky === "dusk") return false;
  const t = document.documentElement.dataset.theme;
  if (t === "dark") return true;
  if (t === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
};

/** Follow the theme as it changes. */
function useDark(): boolean {
  const [dark, setDark] = useState(isDark);
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(isDark()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-city-sky"] });
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const on = () => setDark(isDark());
    mq?.addEventListener?.("change", on);
    return () => {
      obs.disconnect();
      mq?.removeEventListener?.("change", on);
    };
  }, []);
  return dark;
}


/**
 * The city, opened over full screen: turn it, zoom in, click a building to
 * go to its project, rename the city, share a picture of it.
 */
export function CityView({
  city,
  name,
  now,
  locale,
  startSharing,
  mayor,
  onName,
  onMayor,
  onOpenProject,
  onOpenSomeday,
  onClose,
  onError,
  onSaved,
  celebrate = [],
  onCelebrated,
}: {
  city: City;
  name: string | null;
  now: Date;
  locale: string;
  /** Milestones just reached, to celebrate when the city opens. */
  celebrate?: Milestone[];
  onCelebrated?: () => void;
  startSharing?: boolean;
  /** The mayor's (the user's) name. */
  mayor: string | null;
  onName: (name: string) => void;
  onMayor: (name: string) => void;
  /** Open a building's project (null: the houses, tasks in no project). */
  onOpenProject: (project: string | null) => void;
  /** Open Someday (the Coming soon plots). */
  onOpenSomeday: () => void;
  onClose: () => void;
  onError: (e: unknown) => void;
  onSaved: (path: string) => void;
}) {
  const [range, setRange] = useState<CityRange>("week");
  const [hover, setHover] = useState<Picked | null>(null);
  const [renamingMayor, setRenamingMayor] = useState(false);
  const [hint, setHint] = useState(true);
  const [renaming, setRenaming] = useState(false);
  const [sharing, setSharing] = useState(!!startSharing && !!name);
  const [story, setStory] = useState(false);
  const [goals, setGoals] = useState(false);
  const dark = useDark();
  const reached = city.reached ?? city.total;
  const next = nextMilestone(reached);
  const stats = useMemo(() => cityStats(city, range, now, locale), [city, range, now, locale]);
  const byKey = useMemo(() => new Map(city.buildings.map((b) => [b.key, b] as const)), [city]);
  const rangeLabel = range === "week" ? "this week" : range === "month" ? "this month" : "in all";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (sharing) setSharing(false);
      else if (celebrate.length) onCelebrated?.();
      else if (goals) setGoals(false);
      else if (story) setStory(false);
      else if (renaming) setRenaming(false);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [sharing, story, goals, celebrate, onCelebrated, renaming, onClose]);

  if (!name)
    return (
      <NameCity
        city={city}
        now={now}
        mayor={mayor}
        onName={(n, m) => {
          if (m !== (mayor ?? "")) onMayor(m);
          onName(n);
        }}
        onLater={onClose}
      />
    );

  const hb = hover ? byKey.get(hover.key) : undefined;
  const towers = city.buildings.filter((b) => b.kind === "tower").length;
  const when = (iso: string | null) =>
    new Date(iso ?? "").toLocaleString(locale, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const delta = stats.before === null ? null : stats.inRange - stats.before;
  return (
    <div className={dark ? "city-view" : "city-view light"} role="dialog" aria-label={`${name}: your city`}>
      <div className="cv-stage">
        <City3D
          city={city}
          range={range}
          now={now}
          labels
          mayor={mayor}
          onPick={(key) => (key === SOMEDAY_KEY ? onOpenSomeday() : onOpenProject(byKey.get(key)?.project ?? null))}
          onHover={setHover}
          onInteract={() => setHint(false)}
        />
      </div>
      <header className="cv-head" data-tauri-drag-region>
        <button type="button" className="cv-back" onClick={onClose} title="Back to your tasks (Esc)">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <path d="M10 3.5 5.5 8l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Back
        </button>
        {renaming ? (
          <RenameField
            name={name}
            onDone={(n) => {
              setRenaming(false);
              if (n && n !== name) onName(n);
            }}
          />
        ) : (
          <button type="button" className="cv-name" onClick={() => setRenaming(true)} title="Rename your city">
            {name}
            <PencilIcon />
          </button>
        )}
        {renamingMayor ? (
          <RenameField
            name={mayor ?? ""}
            onDone={(n) => {
              setRenamingMayor(false);
              if (n !== (mayor ?? "")) onMayor(n);
            }}
          />
        ) : (
          <button type="button" className="cv-mayor" onClick={() => setRenamingMayor(true)} title="What should the city call you?">
            <MayorAvatar fallback={initials(mayor)} size={26} />
            {mayor ? `Mayor ${mayor}` : "Your name, Mayor?"}
          </button>
        )}
        <span className="cv-sub" data-tauri-drag-region>
          {city.founded ? `Founded ${new Date(city.founded).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })} · ` : ""}
          Population {city.total} · {towers} {towers === 1 ? "building" : "buildings"}
        </span>
        <span className="cv-gap" data-tauri-drag-region />
        <div className="cv-seg" role="radiogroup" aria-label="Show">
          {(
            [
              ["week", "7 days"],
              ["month", "30 days"],
              ["all", "All time"],
            ] as [CityRange, string][]
          ).map(([v, t]) => (
            <button key={v} type="button" role="radio" aria-checked={range === v} className={range === v ? "on" : ""} onClick={() => setRange(v)}>
              {t}
            </button>
          ))}
        </div>
        <button type="button" className="cv-story cv-goals" onClick={() => setGoals(true)} title="What your city unlocks as it grows">
          <TrophyIcon /> Milestones
          <span className="cv-goals-count">
            {reachedMilestones(reached).length}/{MILESTONES.length}
          </span>
        </button>
        <button type="button" className="cv-story" onClick={() => setStory(true)} title="How your city works">
          <BookIcon /> Story
        </button>
        <button type="button" className="cv-share" onClick={() => setSharing(true)}>
          <ShareIcon /> Share
        </button>
      </header>

      {hint && <p className="cv-hint">Drag to turn · scroll to zoom · click a building to open it</p>}

      {hover && hb && (
        <div className="cv-tip" style={{ left: Math.min(hover.x + 16, window.innerWidth - 300), top: Math.min(hover.y + 12, window.innerHeight - 200) }}>
          {hover.room ? (
            <>
              <strong>{hover.room.title}</strong>
              <span>
                {hover.room.lit
                  ? `Lights on · moved in ${when(hover.room.at)}`
                  : hover.room.late
                    ? "Overdue · someone's waiting at the door"
                    : hover.room.readying && hover.room.readying.done > 0
                      ? "Being readied · lights not on yet"
                      : "Empty home · still to do"}
              </span>
              {hover.room.readying && (
                <span>
                  {hover.room.readying.done} of {hover.room.readying.total} sub-tasks done
                </span>
              )}
              <span>{hb.kind === "houses" ? "A house · no project" : `${hb.name}${hover.floor ? ` · ${hover.floor}` : ""}`}</span>
            </>
          ) : (
            <>
              <strong>{hb.name}</strong>
              {hover.floor && hb.kind === "tower" && <span>{hover.floor}</span>}
              <span>
                {hb.kind === "plots"
                  ? `${hb.open} ${hb.open === 1 ? "idea" : "ideas"} for someday`
                  : hb.planned
                    ? "An empty lot · no tasks yet"
                    : `${hb.done} lived in · ${hb.open} to go${hb.finished ? " · every light on" : ""}`}
              </span>
              <span className="cv-tip-go">Click to open</span>
            </>
          )}
        </div>
      )}

      <footer className="cv-stats">
        <Stat big={`+${stats.inRange}`} small={`new residents ${rangeLabel}`} note={delta === null ? undefined : delta >= 0 ? `+${delta} on the ${range === "week" ? "week" : "month"} before` : `${delta} on the ${range === "week" ? "week" : "month"} before`} />
        <Stat
          big={String(city.total)}
          small="population"
          note={next ? `${next.left} more to ${next.milestone.name.replace(/^(A|The) /, "the ").toLowerCase()}` : "every milestone reached"}
        />
        {stats.tallest && <Stat big={stats.tallest.name} small="tallest building" note={`${stats.tallest.floors.length} ${stats.tallest.floors.length === 1 ? "floor" : "floors"} · ${stats.tallest.done + stats.tallest.open} homes`} />}
        <Stat big={String(stats.finished)} small={stats.finished === 1 ? "rooftop lit" : "rooftops lit"} note="projects complete" />
        {stats.brightest && <Stat big={stats.brightest.day} small="busiest moving day" note={`${stats.brightest.count} moved in`} />}
        <span className="cv-gap" />
        <div className="cv-legend" aria-label="Legend">
          <span>
            <i className="lg-fresh" /> Moved in {range === "all" ? "today" : rangeLabel}
          </span>
          <span>
            <i className="lg-lit" /> Lived in
          </span>
          <span>
            <i className="lg-ready" /> Being readied
          </span>
          <span>
            <i className="lg-late" /> Overdue
          </span>
          <span>
            <i className="lg-dark" /> Empty: still to do
          </span>
        </div>
      </footer>

      <ul className="sr-only" aria-label="Buildings">
        {city.buildings.map((b) => (
          <li key={b.key}>
            <button type="button" onClick={() => (b.key === SOMEDAY_KEY ? onOpenSomeday() : onOpenProject(b.project))}>
              {b.name}: {b.done} lived in, {b.open} to go. Open it.
            </button>
          </li>
        ))}
      </ul>

      {story && <StorySheet name={name} mayor={mayor} reached={reached} onClose={() => setStory(false)} />}
      {goals && <MilestonesSheet name={name} reached={reached} onClose={() => setGoals(false)} />}
      {celebrate.length > 0 && !sharing && <Celebration name={name} fresh={celebrate} onClose={() => onCelebrated?.()} />}
      {sharing && (
        <ShareSheet
          city={city}
          name={name}
          now={now}
          count={cityStats(city, "week", now).inRange}
          onClose={() => setSharing(false)}
          onError={onError}
          onSaved={onSaved}
        />
      )}
    </div>
  );
}

function Stat({ big, small, note }: { big: string; small: string; note?: string }) {
  return (
    <div className="cv-stat">
      <span className="cv-stat-big">{big}</span>
      <span className="cv-stat-small">{small}</span>
      {note && <span className="cv-stat-note">{note}</span>}
    </div>
  );
}

function RenameField({ name, onDone }: { name: string; onDone: (name: string) => void }) {
  const [text, setText] = useState(name);
  const done = useRef(false);
  const finish = (v: string) => {
    if (done.current) return;
    done.current = true;
    onDone(v.trim().slice(0, 40));
  };
  return (
    <input
      className="cv-name-input"
      autoFocus
      value={text}
      maxLength={40}
      aria-label="City name"
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(text);
        if (e.key === "Escape") finish(name);
      }}
      onBlur={() => finish(text)}
    />
  );
}

/** The first time: what the city is, and what to call it. */
function NameCity({
  city,
  now,
  mayor,
  onName,
  onLater,
}: {
  city: City;
  now: Date;
  mayor: string | null;
  onName: (city: string, mayor: string) => void;
  onLater: () => void;
}) {
  const dark = useDark();
  const [text, setText] = useState(CITY_NAMES[0]);
  const [who, setWho] = useState(mayor ?? "");
  const found = () => text.trim() && onName(text.trim(), who.trim());
  const [offset, setOffset] = useState(0);
  const picks = [0, 1, 2, 3].map((i) => CITY_NAMES[(i + offset) % CITY_NAMES.length]);
  return (
    <div className={dark ? "city-view naming" : "city-view naming light"} role="dialog" aria-label="Name your city">
      <div className="cv-stage low">
        <City3D city={city} range="week" now={now} still />
      </div>
      <button type="button" className="cv-back nc-back" onClick={onLater} title="Back to your tasks (Esc)">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <path d="M10 3.5 5.5 8l4.5 4.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back
      </button>
      <div className="nc-card">
        <p className="nc-kicker">{city.total ? `Population ${city.total}` : "Your city starts here"}</p>
        <h2>Every task is a home. Finish it, someone moves in, and the lights come on.</h2>
        <p className="nc-text">
          Every project is an apartment building, and its sections are floors. A new task is an empty home with a dark window; when you finish it, someone
          moves in and the lights stay on for good. You're the mayor — what should we call your city?
        </p>
        <input
          className="nc-input"
          autoFocus
          value={text}
          maxLength={40}
          aria-label="City name"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") found();
          }}
        />
        <input
          className="nc-input nc-mayor"
          value={who}
          maxLength={40}
          placeholder="Your name (optional): “Mayor …”"
          aria-label="Your name, Mayor"
          onChange={(e) => setWho(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") found();
          }}
        />
        <div className="nc-picks">
          {picks.map((n) => (
            <button key={n} type="button" className={text === n ? "on" : ""} onClick={() => setText(n)}>
              {n}
            </button>
          ))}
          <button type="button" className="nc-shuffle" onClick={() => setOffset((o) => o + 4)}>
            More names
          </button>
        </div>
        <div className="nc-actions">
          <button type="button" className="nc-later" onClick={onLater}>
            Later
          </button>
          <button type="button" className="primary" disabled={!text.trim()} onClick={found}>
            Found the city
          </button>
        </div>
      </div>
    </div>
  );
}

function ShareSheet({
  city,
  name,
  now,
  count,
  onClose,
  onError,
  onSaved,
}: {
  city: City;
  name: string;
  now: Date;
  count: number;
  onClose: () => void;
  onError: (e: unknown) => void;
  onSaved: (path: string) => void;
}) {
  const dark = useDark();
  const [showCount, setShowCount] = useState(true);
  const [names, setNames] = useState(false);
  const [copied, setCopied] = useState(false);
  // The picture is drawn in 3D like the city (flat where WebGL isn't available).
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  useEffect(() => {
    let live = true;
    const opts = { count: showCount ? count : null, names, now, dark };
    import("./CityScene")
      .then((m) => live && setCanvas(m.renderCityPicture(city, name, opts)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [city, name, showCount, count, names, now, dark]);
  const preview = useMemo(() => canvas?.toDataURL("image/png") ?? null, [canvas]);
  const blob = () =>
    new Promise<Blob>((res, rej) =>
      canvas ? canvas.toBlob((b) => (b ? res(b) : rej(new Error("The picture didn’t come out. Try again."))), "image/png") : rej(new Error("The picture is still being made. Try again in a moment.")),
    );

  async function copy() {
    try {
      const b = await blob();
      await navigator.clipboard.write([new ClipboardItem({ "image/png": b })]);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch (e) {
      onError(e);
    }
  }
  async function save() {
    try {
      const b = await blob();
      onSaved(await api.saveCityImage(name, new Uint8Array(await b.arrayBuffer())));
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="share-sheet" onClick={onClose}>
      <div className="ss-card" role="dialog" aria-label="Share your city" onClick={(e) => e.stopPropagation()}>
        <div className="ss-head">
          <h2>Share your city</h2>
          <button type="button" className="cv-close" onClick={onClose} aria-label="Close">
            <svg width="12" height="12" viewBox="0 0 12 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
              <path d="M3 3l6 6M9 3l-6 6" />
            </svg>
          </button>
        </div>
        {preview ? <img className="ss-preview" src={preview} alt={`A picture of ${name}`} /> : <div className="ss-preview ss-wait" />}
        <label className="ss-opt">
          <input type="checkbox" checked={showCount} onChange={(e) => setShowCount(e.target.checked)} /> Show this week's count
        </label>
        <label className="ss-opt">
          <input type="checkbox" checked={names} onChange={(e) => setNames(e.target.checked)} /> Show project names on buildings
        </label>
        <p className="ss-note">Only this picture is shared. It's made on your Mac; no task names, notes or times are in it.</p>
        <div className="ss-actions">
          <button type="button" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy image"}
          </button>
          <button type="button" className="primary" onClick={() => void save()}>
            Save to Downloads
          </button>
        </div>
      </div>
    </div>
  );
}

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M11 2.5l2.5 2.5L6 12.5H3.5V10Z" strokeLinejoin="round" />
    </svg>
  );
}


function BookIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden>
      <path d="M2.5 3.2c2-.9 3.9-.9 5.5.4v9.2c-1.6-1.3-3.5-1.3-5.5-.4V3.2ZM13.5 3.2c-2-.9-3.9-.9-5.5.4v9.2c1.6-1.3 3.5-1.3 5.5-.4V3.2Z" />
    </svg>
  );
}

/** The story of the city, one page at a time: how tasks become a lit skyline. */
const STORY: { title: string; text: string; art: string }[] = [
  {
    title: "Welcome, Mayor",
    text: "This city is quiet and dark when it begins. Your job is to fill it with people — and the only way anyone moves in is when you get something done.",
    art: "🌃",
  },
  {
    title: "Every project is a building",
    text: "Start a project and an apartment building goes up. Its sections are floors you name: “1st Floor: Travel”, “2nd Floor: Program”. Tasks on no floor live on the ground floor. The older the project, the closer to downtown it stands.",
    art: "🏢",
  },
  {
    title: "Every task is a home",
    text: "A new task is an empty home with a dark window. Finish it, someone moves in, and the lights come on — and they stay on for good. Every lit window is something you did.",
    art: "💡",
  },
  {
    title: "Sub-tasks get a home ready",
    text: "Paint the walls, fix the boiler, hand over the keys. Tick sub-tasks off and the window starts to glow behind the curtains. When the task is done, the lights come fully on.",
    art: "🪟",
  },
  {
    title: "Houses, plots and the street",
    text: "Tasks in no project are little houses on the edge of town — their porch lights come on when they're done. Someday ideas wait on “Coming soon” plots. An amber window blinking means a task is overdue: someone's waiting at the door.",
    art: "🏡",
  },
  {
    title: "Your city grows with you",
    text: "Today's timed tasks go up on the rooftop “Moving in today” billboard. Trucks circle buildings still under construction; a rooftop light switches on when every home is lived in; luxury cars come to the tallest tower. Your population is every task you've finished — and at each milestone the city gains something new for good: street lamps, a park, a train, a harbour. See Milestones.",
    art: "🌆",
  },
];

function StorySheet({ name, mayor, reached, onClose }: { name: string; mayor: string | null; reached: number; onClose: () => void }) {
  const [page, setPage] = useState(0);
  // Each milestone reached adds a chapter.
  const pages = useMemo(
    () => [...STORY, ...reachedMilestones(reached).map((m) => ({ title: `Population ${m.at.toLocaleString()}: ${m.name}`, text: m.story, art: m.emoji }))],
    [reached],
  );
  const p = pages[page];
  const last = page === pages.length - 1;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setPage((n) => Math.min(pages.length - 1, n + 1));
      if (e.key === "ArrowLeft") setPage((n) => Math.max(0, n - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pages.length]);
  return (
    <div className="story-sheet" role="dialog" aria-label="The story of your city" onClick={onClose}>
      <div className="story-card" onClick={(e) => e.stopPropagation()}>
        <p className="story-kicker">
          The story of {name}
          {mayor ? ` · Mayor ${mayor}` : ""}
        </p>
        <div className="story-art" aria-hidden key={page}>
          {p.art}
        </div>
        <h2 key={`t${page}`}>{p.title}</h2>
        <p className="story-text">{p.text}</p>
        <div className="story-dots" role="tablist" aria-label="Pages">
          {pages.map((s, i) => (
            <button key={s.title} type="button" role="tab" aria-selected={i === page} aria-label={s.title} className={i === page ? "on" : ""} onClick={() => setPage(i)} />
          ))}
        </div>
        <div className="story-foot">
          <button type="button" className="story-btn quiet" onClick={() => (page ? setPage(page - 1) : onClose())}>
            {page ? "Back" : "Close"}
          </button>
          <button type="button" className="story-btn" onClick={() => (last ? onClose() : setPage(page + 1))} autoFocus>
            {last ? "Start building" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}

function TrophyIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" aria-hidden>
      <path d="M5 2.5h6v3.2a3 3 0 0 1-6 0V2.5ZM5 3.5H2.8c0 1.8.9 3 2.4 3.2M11 3.5h2.2c0 1.8-.9 3-2.4 3.2M8 8.7v2.6M5.5 13.5h5M6.3 11.3h3.4" />
    </svg>
  );
}

/** The rules of the game, and every milestone: reached, or how far to go. */
function MilestonesSheet({ name, reached, onClose }: { name: string; reached: number; onClose: () => void }) {
  const next = nextMilestone(reached);
  return (
    <div className="story-sheet" role="dialog" aria-label="City milestones" onClick={onClose}>
      <div className="story-card ms-card" onClick={(e) => e.stopPropagation()}>
        <p className="story-kicker">{name} · milestones</p>
        <h2>Grow your city</h2>
        <div className="ms-progress">
          <div className="ms-pop">
            <b>{reached.toLocaleString()}</b> population
          </div>
          {next ? (
            <>
              <div className="ms-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(next.progress * 100)} aria-label={`Progress to ${next.milestone.name}`}>
                <i style={{ width: `${Math.max(3, next.progress * 100)}%` }} />
              </div>
              <p className="ms-next">
                {next.milestone.emoji} <b>{next.left.toLocaleString()}</b> more {next.left === 1 ? "task" : "tasks"} done until <b>{next.milestone.name.toLowerCase()}</b> ({next.milestone.at.toLocaleString()})
              </p>
            </>
          ) : (
            <p className="ms-next">Every milestone reached. Your city is complete — and still growing.</p>
          )}
        </div>

        <div className="ms-rules">
          <h3>The rules</h3>
          <ul>
            {MILESTONE_RULES.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </div>

        <ol className="ms-list">
          {MILESTONES.map((m) => {
            const got = reached >= m.at;
            return (
              <li key={m.id} className={got ? "got" : ""}>
                <span className="ms-emoji" aria-hidden>
                  {got ? m.emoji : "🔒"}
                </span>
                <span className="ms-text">
                  <b>{m.name}</b>
                  <span>{m.what}</span>
                </span>
                <span className="ms-at">{got ? "Built ✓" : m.at.toLocaleString()}</span>
              </li>
            );
          })}
        </ol>

        <div className="story-foot">
          <span />
          <button type="button" className="story-btn" onClick={onClose}>
            Keep building
          </button>
        </div>
      </div>
    </div>
  );
}

/** A milestone was just reached: show what the city gained. */
function Celebration({ name, fresh, onClose }: { name: string; fresh: Milestone[]; onClose: () => void }) {
  const top = fresh[fresh.length - 1];
  return (
    <div className="story-sheet" role="dialog" aria-label="Milestone reached" onClick={onClose}>
      <div className="story-card ms-card ms-cheer" onClick={(e) => e.stopPropagation()}>
        <p className="story-kicker">New in {name}</p>
        <div className="story-art">{top.emoji}</div>
        <h2>Population {top.at.toLocaleString()}!</h2>
        <p className="story-text">{top.story}</p>
        {fresh.length > 1 && (
          <ul className="ms-fresh">
            {fresh.map((m) => (
              <li key={m.id}>
                {m.emoji} {m.name}
              </li>
            ))}
          </ul>
        )}
        <div className="story-foot">
          <span />
          <button type="button" className="story-btn" onClick={onClose} autoFocus>
            Go see it
          </button>
        </div>
      </div>
    </div>
  );
}

function ShareIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
      <path d="M8 10V2.5M5 5.5l3-3 3 3M3.5 8.5v4a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1v-4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
