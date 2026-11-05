import { createContext, useContext, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { defaultAgent, runText } from "../lib/agentRuns";
import type { AgentCliStatus, AgentRun, Task } from "../lib/types";
import { AgentTile } from "./AgentPanel";
import { LineIcon } from "./LineIcon";

/** What tasks need to show their agent: each task's run, and what can be done with it. */
export interface AgentRunsValue {
  byTask: Map<number, AgentRun>;
  /** "Send to agent…": opens the dialog (absent where agents can't be started). */
  send?: (task: Task) => void;
  /** Show a run's terminal in the agent panel. */
  open?: (run: AgentRun) => void;
  /** Answer the agent, or start it again with a note. */
  reply?: (run: AgentRun, task: Task, text: string) => Promise<void>;
  /** Start a paused run again. */
  resume?: (run: AgentRun, task: Task) => void;
  dismiss?: (run: AgentRun) => void;
  markDone?: (task: Task) => void;
}

export const AgentRuns = createContext<AgentRunsValue>({ byTask: new Map() });

export function useAgentRun(task: Task): AgentRun | undefined {
  return useContext(AgentRuns).byTask.get(task.id);
}

/**
 * On a task's line (shown on hover): hand the task to an agent. Hidden while
 * an agent is already on it.
 */
export function DelegateButton({ task }: { task: Task }) {
  const ctx = useContext(AgentRuns);
  const run = ctx.byTask.get(task.id);
  if (!ctx.send || task.done || (run && (run.status === "working" || run.status === "needs_you"))) return null;
  return (
    <button
      type="button"
      className="row-delegate"
      data-nodrag
      aria-label="Send to agent"
      title="Send to agent"
      onClick={(e) => {
        e.stopPropagation();
        ctx.send!(task);
      }}
    >
      <LineIcon name="delegate" size={16} />
    </button>
  );
}

/** "What it did": everything the agent's terminal showed, as plain text. */
export function TranscriptDialog({ run, title, onClose }: { run: AgentRun; title: string; onClose: () => void }) {
  const [text, setText] = useState<string | null | undefined>(undefined);
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    let live = true;
    api
      .agentRunTranscript(run.id)
      .then((t) => live && setText(t))
      .catch(() => live && setText(null));
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => {
      live = false;
      window.removeEventListener("keydown", key);
    };
  }, [run.id, onClose]);
  // Open at the end, where the agent finished.
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [text]);
  return (
    <div className="who-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="who-dialog transcript-dialog" role="dialog" aria-modal="true" aria-labelledby="transcript-title">
        <div className="transcript-head">
          <AgentTile agent={run.agent} size={26} />
          <div>
            <h2 id="transcript-title">What {run.agent_name} did</h2>
            <p>“{title}”</p>
          </div>
        </div>
        {run.summary && <p className="transcript-summary">{run.summary}</p>}
        {text === undefined ? (
          <p className="transcript-note">Loading…</p>
        ) : text ? (
          <pre className="transcript" ref={box} tabIndex={0} aria-label="Terminal output">
            {text}
          </pre>
        ) : (
          <p className="transcript-note">The terminal's text shows here once the agent has started working.</p>
        )}
        <div className="who-dialog-actions">
          <button type="button" className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Claude Code is working", on a task's line. */
export function AgentRunPill({ run }: { run: AgentRun }) {
  const t = runText(run);
  return (
    <span className={`run-pill ${t.tone}`} title={run.summary ?? undefined}>
      {t.tone === "working" && <span className="run-dot" aria-hidden />}
      {t.label}
    </span>
  );
}

/** On an open task: where its agent is, what it reported, and what to do next. */
export function AgentRunCard({ task, run }: { task: Task; run: AgentRun }) {
  const ctx = useContext(AgentRuns);
  const t = runText(run);
  const [note, setNote] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [showing, setShowing] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (note !== null) noteRef.current?.focus();
  }, [note !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  async function sendNote() {
    const text = note?.trim();
    if (!text || !ctx.reply) return;
    setSending(true);
    try {
      await ctx.reply(run, task, text);
      setNote(null);
    } finally {
      setSending(false);
    }
  }

  return (
    <section className={`run-card ${t.tone}`} aria-label="Agent" data-nodrag>
      <div className="run-head">
        <AgentTile agent={run.agent} size={24} />
        <div className="run-head-text">
          <b>{t.label}</b>
          {run.folder && <small>{run.folder.replace(/^\/Users\/[^/]+/, "~")}</small>}
        </div>
        {ctx.dismiss && (
          <button type="button" className="run-x" aria-label="Clear from this task" title="Clear from this task" onClick={() => ctx.dismiss!(run)}>
            ×
          </button>
        )}
      </div>
      {run.summary ? (
        <p className="run-summary">{run.summary}</p>
      ) : (
        run.tail && (
          <div className="run-tail">
            <small>Last lines from its terminal</small>
            <pre>{run.tail}</pre>
          </div>
        )
      )}
      {run.links.length > 0 && (
        <div className="run-links">
          {run.links.map((l) => (
            <a
              key={l}
              href={l}
              onClick={(e) => {
                e.preventDefault();
                void api.openUrl(l).catch(() => undefined);
              }}
            >
              {l.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}
            </a>
          ))}
        </div>
      )}
      {note !== null ? (
        <div className="run-note">
          <textarea
            ref={noteRef}
            rows={2}
            value={note}
            maxLength={2000}
            placeholder={run.status === "needs_you" ? "Your answer" : "What should it change?"}
            aria-label="Note for the agent"
            onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void sendNote();
              if (e.key === "Escape") {
                e.stopPropagation();
                setNote(null);
              }
            }}
          />
          <div className="run-actions">
            <button type="button" className="primary" disabled={sending || !note.trim()} onClick={() => void sendNote()}>
              Send to {run.agent_name}
            </button>
            <button type="button" onClick={() => setNote(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="run-actions">
          {run.status === "ready" && ctx.markDone && (
            <button type="button" className="primary" onClick={() => ctx.markDone!(task)}>
              Mark done
            </button>
          )}
          {run.status === "needs_you" && ctx.reply && (
            <button type="button" className="primary" onClick={() => setNote("")}>
              Answer
            </button>
          )}
          {run.status === "ready" && ctx.reply && (
            <button type="button" onClick={() => setNote("")}>
              Send back with a note
            </button>
          )}
          {run.status === "paused" && ctx.resume && (
            <button type="button" className="primary" onClick={() => ctx.resume!(run, task)}>
              Continue
            </button>
          )}
          {run.session !== null && ctx.open && (
            <button type="button" onClick={() => ctx.open!(run)}>
              Show terminal
            </button>
          )}
          {(run.has_transcript || run.session !== null) && (
            <button type="button" onClick={() => setShowing(true)}>
              What it did
            </button>
          )}
        </div>
      )}
      {showing && <TranscriptDialog run={run} title={task.title} onClose={() => setShowing(false)} />}
    </section>
  );
}

/**
 * "Send to agent": pick the agent and the folder it works in, add a note,
 * and start it on the task.
 */
export function SendToAgentDialog({
  task,
  clis,
  folder: startFolder,
  lastAgent,
  onStart,
  onClose,
}: {
  task: Task;
  clis: AgentCliStatus[];
  folder: string;
  /** The agent used last time; the default agent (Settings → Agents) comes first. */
  lastAgent: string | null;
  onStart: (agent: string, folder: string, extra: string) => Promise<void>;
  onClose: () => void;
}) {
  const installed = clis.filter((c) => c.installed);
  const preferred = clis.find((c) => c.default)?.id ?? null;
  const [agent, setAgent] = useState<string | null>(() => defaultAgent(installed.map((c) => c.id), lastAgent, preferred));
  const [folder, setFolder] = useState(startFolder);
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!agent && installed.length) setAgent(defaultAgent(installed.map((c) => c.id), lastAgent, preferred));
  }, [installed.length]); // eslint-disable-line react-hooks/exhaustive-deps
  // Return starts it: Start has the focus as soon as there's an agent.
  useEffect(() => {
    if (agent) go.current?.focus();
  }, [agent]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const name = installed.find((c) => c.id === agent)?.name;

  async function start() {
    if (!agent) return;
    setBusy(true);
    setError(null);
    try {
      await onStart(agent, folder, extra);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return (
    <div className="who-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="who-dialog send-dialog" role="dialog" aria-modal="true" aria-labelledby="send-title">
        <h2 id="send-title">Send to an agent</h2>
        <p className="send-task">“{task.title}”</p>
        <p>The agent gets this task's title, notes and sub-tasks, works in the folder below, and tells TodoCity how it's going.</p>
        {installed.length ? (
          <div className="send-agents" role="radiogroup" aria-label="Agent">
            {installed.map((c) => (
              <button key={c.id} type="button" role="radio" aria-checked={agent === c.id} className={agent === c.id ? "send-agent on" : "send-agent"} onClick={() => setAgent(c.id)}>
                <AgentTile agent={c.id} size={28} />
                <span>{c.name}</span>
                {c.default && <small className="send-default">Default</small>}
              </button>
            ))}
          </div>
        ) : (
          <p className="send-install">Install Claude Code, Codex, Gemini CLI or Cursor Agent (or add yours in Settings → Agents), then send tasks to it from here.</p>
        )}
        <label className="send-field">
          <span>Work in</span>
          <span className="send-folder">
            <input value={folder} onChange={(e) => setFolder(e.target.value)} spellCheck={false} aria-label="Folder" title={folder} />
            <button
              type="button"
              onClick={() =>
                void api.pickFolder().then((f) => {
                  if (f) setFolder(f);
                })
              }
            >
              Choose…
            </button>
          </span>
        </label>
        <label className="send-field">
          <span>Anything to add?</span>
          <textarea rows={2} value={extra} maxLength={2000} placeholder="Open a pull request when the tests pass." onChange={(e) => setExtra(e.target.value)} />
        </label>
        {error && <p className="send-error">{error}</p>}
        <div className="who-dialog-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="primary" ref={go} disabled={!agent || busy || !folder.trim()} onClick={() => void start()}>
            {busy ? "Starting…" : name ? `Start ${name}` : "Start"}
          </button>
        </div>
        <small className="send-privacy">The agent you choose sends what it reads to its own provider. You mark the task done after you review its work.</small>
      </div>
    </div>
  );
}
