import { createContext, useContext, useEffect, useRef } from "react";
import { agentIdOf, byAgent, markLabel } from "../lib/agents";
import { AgentTile } from "./AgentPanel";
import type { AgentChange, Task } from "../lib/types";

/** What lists need to mark agents' tasks: each task's latest agent change, and Undo in the Agents view. */
export interface AgentMarksValue {
  latest: Map<number, AgentChange>;
  now: Date;
  /** AI agents are on; with them off, nothing is marked. */
  on?: boolean;
  /** Set in the Agents view: undo what agents did to this task. */
  undo?: (taskId: number) => void;
}
export const AgentMarks = createContext<AgentMarksValue>({ latest: new Map(), now: new Date() });

/** "Scheduled by Claude", for a task an agent touched (and Undo in the Agents view). */
export function AgentMark({ task }: { task: Task }) {
  const m = useContext(AgentMarks);
  if (!m.on || !byAgent(task, m.now)) return null;
  const c = m.latest.get(task.id);
  return (
    <>
      <span className="agent-mark" title={c?.summary}>
        {c && agentIdOf(c.agent) ? <AgentTile agent={agentIdOf(c.agent)} size={14} /> : <AgentIcon size={11} />}
        {c ? markLabel(c) : "Changed by an agent"}
      </span>
      {m.undo && (
        <button type="button" className="agent-undo" data-nodrag onClick={(e) => { e.stopPropagation(); m.undo!(task.id); }} title={c?.summary}>
          Undo
        </button>
      )}
    </>
  );
}

export function useIsAgentTask(task: Task): boolean {
  const m = useContext(AgentMarks);
  return !!m.on && byAgent(task, m.now);
}

export const AgentIcon = ({ size = 13 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
    <path d="M8 1.8l1.4 3.6 3.8.4-2.9 2.5.9 3.8L8 10.1l-3.2 2 .9-3.8L2.8 5.8l3.8-.4z" />
  </svg>
);

/** Agents aren't on yet: what they'd do, and where to turn them on. */
export function AgentsSetUpDialog({ onSetUp, onClose }: { onSetUp: () => void; onClose: () => void }) {
  const go = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    go.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const steps: [string, string][] = [
    ["Turn on AI agents", "One switch, on this Mac only."],
    ["Connect your AI app", "One click adds TodoCity to Claude, Cursor, VS Code and more."],
    ["Choose how much they can do", "Add tasks for your OK, or full access to plan and tidy for you."],
  ];
  return (
    <div className="who-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="who-dialog" role="dialog" aria-modal="true" aria-labelledby="who-dialog-title">
        <span className="who-dialog-icon" aria-hidden>
          <AgentIcon size={20} />
        </span>
        <h2 id="who-dialog-title">Let your AI apps help with your tasks</h2>
        <p>Claude, Cursor and other AI apps on this Mac can add tasks for you, plan your day and tidy your Inbox. Everything they do shows up here, under Agents.</p>
        <ol>
          {steps.map(([t, d], i) => (
            <li key={t}>
              <span className="who-step">{i + 1}</span>
              <span>
                <b>{t}</b>
                <small>{d}</small>
              </span>
            </li>
          ))}
        </ol>
        <div className="who-dialog-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Not now
          </button>
          <button type="button" className="primary" ref={go} onClick={onSetUp}>
            Set up AI agents
          </button>
        </div>
      </div>
    </div>
  );
}
