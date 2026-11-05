import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, onTermOutput } from "../lib/api";
import { monogram, PANEL_PROMPTS, shortFolder } from "../lib/agentRuns";
import { iconFor, needsDarkTile, useAppIcons } from "../lib/agentIcons";
import type { ActivityEntry, AgentCliStatus, TermSession } from "../lib/types";

/** An agent's logo (its official file, or its app's icon), else a lettered tile; a prompt sign for a plain terminal. */
export function AgentTile({ agent, size = 24 }: { agent: string | null; size?: number }) {
  const icons = useAppIcons();
  const src = iconFor(agent, icons);
  if (src) return <img className={needsDarkTile(agent) ? "agent-tile agent-logo dark-tile" : "agent-tile agent-logo"} src={src} width={size} height={size} alt="" aria-hidden />;
  const m = monogram(agent);
  return (
    <span className="agent-tile" style={{ width: size, height: size, background: m.color, fontSize: size * 0.42 }} aria-hidden>
      {m.letters || (
        <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 7l5 5-5 5M12 18h7" />
        </svg>
      )}
    </span>
  );
}

const TERM_THEME = {
  background: "#1b1a18",
  foreground: "#e8e6e1",
  cursor: "#e8e6e1",
  selectionBackground: "#4a4740",
};

/** Rough size before the terminal is on screen (each start needs one). */
export function guessSize(width: number, height: number): { cols: number; rows: number } {
  return { cols: Math.max(40, Math.floor((width - 24) / 7.3)), rows: Math.max(10, Math.floor((height - 24) / 17)) };
}

/** One terminal, drawn with xterm.js: what it showed so far, then live. */
function TermView({ session }: { session: TermSession }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: TERM_THEME,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    let live = true;
    // Output that arrives while the past is loading waits, and only what
    // comes after the past is drawn.
    const queued: { data: string; end: number }[] = [];
    let shown = -1;
    const sub = onTermOutput((id, data, end) => {
      if (id !== session.id) return;
      if (shown < 0) queued.push({ data, end });
      else if (end > shown) {
        term.write(data);
        shown = end;
      }
    });
    void api
      .termAttach(session.id)
      .then((past) => {
        if (!live) return;
        term.write(past.data);
        shown = past.end;
        for (const q of queued) {
          if (q.end > shown) {
            term.write(q.data);
            shown = q.end;
          }
        }
      })
      .catch(() => {
        shown = 0;
      });
    const typed = term.onData((d) => void api.termWrite(session.id, d).catch(() => undefined));
    const resize = () => {
      try {
        fit.fit();
      } catch {
        return;
      }
      void api.termResize(session.id, term.cols, term.rows).catch(() => undefined);
    };
    const ro = new ResizeObserver(() => resize());
    ro.observe(el);
    resize();
    term.focus();
    return () => {
      live = false;
      ro.disconnect();
      typed.dispose();
      void sub.then((u) => u());
      term.dispose();
    };
  }, [session.id]);
  return <div className="term-view" ref={box} data-nodrag />;
}

/** "10:05 AM" for a local `YYYY-MM-DDTHH:MM:SS`. */
function clockOf(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** The Activity tab: what agents do in the background (connecting, Slack checks), live. */
function ActivityView({ entries, onClear }: { entries: ActivityEntry[]; onClear: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length]);
  return (
    <div className="ap-activity" data-nodrag>
      <div className="ap-activity-list" ref={box} role="log" aria-live="polite" aria-label="Agent activity">
        {entries.length === 0 ? (
          <p className="ap-activity-empty">What your agents do in the background shows here: connecting, Slack checks and tasks they add.</p>
        ) : (
          entries.map((e) => (
            <div key={e.id} className={`ap-act ap-act-${e.kind}`}>
              <span className="ap-act-time">{clockOf(e.at)}</span>
              <AgentTile agent={e.agent ?? (e.source === "slack" ? "slack" : null)} size={14} />
              <span className="ap-act-text">{e.text}</span>
            </div>
          ))
        )}
      </div>
      {entries.length > 0 && (
        <button type="button" className="ap-activity-clear" onClick={onClear}>
          Clear
        </button>
      )}
    </div>
  );
}

/**
 * The agent panel, beside the list: start an agent (or a plain terminal),
 * switch between open ones, and ask for the usual things in one click.
 * Every agent started here has TodoCity's MCP server.
 */
export function AgentPanel({
  clis,
  sessions,
  active,
  onActive,
  onStart,
  onCloseSession,
  folder,
  home,
  onPickFolder,
  fullAccess,
  onSettings,
  busy,
  defaultAgent,
  onFindAgents,
  finding,
  activity,
  activityOpen,
  onActivity,
  onClearActivity,
}: {
  clis: AgentCliStatus[];
  sessions: TermSession[];
  active: number | null;
  onActive: (id: number) => void;
  /** Start an agent (null: a plain terminal), with a first message if any. */
  onStart: (agent: string | null, prompt?: string) => void;
  onCloseSession: (id: number) => void;
  folder: string;
  home: string;
  onPickFolder: () => void;
  fullAccess: boolean;
  onSettings: () => void;
  busy: boolean;
  /** The default agent (Settings → Agents), first in the list and for ready-made requests. */
  defaultAgent?: string | null;
  /** Look for agents on this Mac again. */
  onFindAgents?: () => void;
  finding?: boolean;
  activity?: ActivityEntry[];
  /** The Activity tab is showing (instead of a terminal). */
  activityOpen?: boolean;
  onActivity?: () => void;
  onClearActivity?: () => void;
}) {
  const installed = clis.filter((c) => c.installed);
  const current = sessions.find((s) => s.id === active) ?? sessions[sessions.length - 1] ?? null;
  const [asking, setAsking] = useState(false);
  const preferred = installed.find((c) => c.id === defaultAgent) ?? installed[0];
  const agentFor = current?.agent ?? preferred?.id ?? null;
  const entries = activity ?? [];
  const showActivity = !!activityOpen;

  /** A ready-made request: typed into the open agent, or a new one started with it. */
  function ask(text: string) {
    setAsking(false);
    if (current?.alive && current.agent) {
      void api.termWrite(current.id, `${text}\r`).catch(() => undefined);
      return;
    }
    if (agentFor) onStart(agentFor, text);
  }

  return (
    <aside className="side-pane agent-pane" aria-label="Agents">
      <div className="ap-head">
        <div className="ap-start" role="group" aria-label="Start">
          {installed.map((c) => (
            <button
              key={c.id}
              type="button"
              className={c.id === defaultAgent ? "ap-agent is-default" : "ap-agent"}
              disabled={busy}
              onClick={() => onStart(c.id)}
              title={`Start ${c.name} in ${shortFolder(folder, home)}${c.id === defaultAgent ? " (your default agent)" : ""}${c.slack ? " · has Slack" : ""}`}
            >
              <AgentTile agent={c.id} size={22} />
              <span>{c.name}</span>
            </button>
          ))}
          <button type="button" className="ap-agent" disabled={busy} onClick={() => onStart(null)} title={`Open a terminal in ${shortFolder(folder, home)}`}>
            <AgentTile agent={null} size={22} />
            <span>Terminal</span>
          </button>
          {onFindAgents && (
            <button type="button" className="ap-agent ap-find" disabled={finding} onClick={onFindAgents} title="Look for agents on this Mac again">
              <span aria-hidden>{finding ? "…" : "↻"}</span>
              <span>{finding ? "Looking…" : "Find agents"}</span>
            </button>
          )}
        </div>
        <button type="button" className="ap-folder" onClick={onPickFolder} title="Change the folder new sessions start in">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          {shortFolder(folder, home)}
        </button>
      </div>

      {(sessions.length > 0 || entries.length > 0) && (
        <div className="ap-tabs" role="tablist" aria-label="Open sessions">
          {entries.length > 0 && onActivity && (
            <div className={showActivity ? "ap-tab on ap-tab-activity" : "ap-tab ap-tab-activity"} role="presentation">
              <button type="button" role="tab" aria-selected={showActivity} onClick={onActivity} title="What your agents are doing in the background">
                <span className={entries.some((e) => e.kind === "working") && entries[entries.length - 1]?.kind === "working" ? "ap-act-dot live" : "ap-act-dot"} aria-hidden />
                <span className="ap-tab-title">Activity</span>
              </button>
            </div>
          )}
          {sessions.map((s) => (
            <div key={s.id} className={!showActivity && s.id === current?.id ? "ap-tab on" : "ap-tab"} role="presentation">
              <button type="button" role="tab" aria-selected={!showActivity && s.id === current?.id} onClick={() => onActive(s.id)} title={`${s.name} · ${shortFolder(s.folder, home)}`}>
                <AgentTile agent={s.agent} size={16} />
                <span className="ap-tab-title">{s.task_id ? s.title : s.name}</span>
                {!s.alive && <span className="ap-tab-ended">ended</span>}
              </button>
              <button type="button" className="ap-tab-x" aria-label={`Close ${s.name}`} onClick={() => onCloseSession(s.id)}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="ap-body">
        {showActivity ? (
          <ActivityView entries={entries} onClear={() => onClearActivity?.()} />
        ) : current ? (
          <TermView key={current.id} session={current} />
        ) : (
          <div className="ap-empty">
            <h3>Work on your tasks with an agent</h3>
            <p>
              {installed.length
                ? "Start an agent above. It can see TodoCity's tools, so you can ask it to plan your day, tidy your Inbox or work on a task."
                : "Install Claude Code, Codex, Gemini CLI or Cursor Agent, then choose Find agents. Or add your own in Settings → Agents. A plain Terminal works too."}
            </p>
            {agentFor && (
              <div className="ap-prompts">
                {PANEL_PROMPTS.map((p) => (
                  <button key={p.label} type="button" onClick={() => ask(p.text)} disabled={busy}>
                    {p.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="ap-foot">
        {current?.agent && current.alive && (
          <div className="ap-asks">
            <button type="button" className="ap-ask-toggle" aria-expanded={asking} onClick={() => setAsking((a) => !a)}>
              Ask…
            </button>
            {asking &&
              PANEL_PROMPTS.map((p) => (
                <button key={p.label} type="button" onClick={() => ask(p.text)}>
                  {p.label}
                </button>
              ))}
          </div>
        )}
        <p className="ap-note">
          {fullAccess ? "Agents can read and change your tasks; everything they do can be undone." : "Agents can add tasks for your review."}{" "}
          <button type="button" className="link" onClick={onSettings}>
            {fullAccess ? "Settings" : "Let them plan and tidy"}
          </button>
        </p>
      </div>
    </aside>
  );
}
