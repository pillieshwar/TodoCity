import { useCallback, useEffect, useState, type ReactNode } from "react";
import { api, onAgentChanges } from "../lib/api";
import type { AgentApp, AgentChange, AgentsStatus } from "../lib/types";
import { Toggle } from "./GeneralSettings";
import { safeLocale } from "../lib/locale";
import { InfoTip } from "./InfoTip";
import { AgentTile } from "./AgentPanel";

type Run = (action: () => Promise<AgentsStatus>, connected?: string[]) => Promise<void>;

/**
 * Settings → Agents: the agents and AI apps on this Mac, connected to
 * TodoCity's MCP server in one click, and what they may do with tasks.
 */
export function AgentsPage() {
  const [status, setStatus] = useState<AgentsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ ok: boolean; text: string } | "running" | null>(null);
  useEffect(() => {
    const load = () => void api.agentsStatus().then(setStatus).catch(() => undefined);
    load();
    const sub = onAgentChanges(load);
    return () => void sub.then((u) => u());
  }, []);
  if (!status) return null;
  if (!status.supported) return <p className="setting-line muted">Agents are available on macOS.</p>;
  const onStatus = setStatus;

  async function runTest() {
    setTest("running");
    try {
      setTest({ ok: true, text: await api.agentsTest() });
    } catch (e) {
      setTest({ ok: false, text: String(e) });
    }
  }

  return (
    <section className="settings-section agents-page">
      <div className="card-stack">
        <Toggle
          label="Agents can add tasks"
          info="Tasks they send wait in the menu bar until you add them."
          checked={status.enabled}
          onChange={(v) =>
            void api
              .agentsSetEnabled(v)
              .then(onStatus)
              .catch((e) => setError(String(e)))
          }
        />
        {status.enabled && (
          <div className="toggle-nested">
            <Toggle
              label="Full access"
              info={`Agents can read, add, change, schedule, complete and delete tasks, projects and sections (${status.tool_count} tools). Everything they do is marked and can be undone. What they read goes to their AI service.`}
              checked={status.full_access}
              onChange={(v) =>
                void api
                  .agentsSetFullAccess(v)
                  .then(onStatus)
                  .catch((e) => setError(String(e)))
              }
            />
            <Toggle
              label="Suggest tasks on their own"
              info="When you mention a deadline or say “remind me”, agents send it without being asked. You still approve each one."
              checked={status.proactive}
              onChange={(v) =>
                void api
                  .agentsSetProactive(v)
                  .then(onStatus)
                  .catch((e) => setError(String(e)))
              }
            />
          </div>
        )}
      </div>

      {status.temporary_location && (
        <div className="setting-line">
          <span className="dot warn" aria-hidden />
          <span className="setting-line-text">Move TodoCity to Applications and open it from there to connect agents.</span>
        </div>
      )}

      <h3 className="set-subhead" id="agents-list">
        Your agents
        <InfoTip text="Connect adds TodoCity's MCP server to that agent's settings. Agents started from TodoCity's agent panel are connected for you." />
      </h3>
      <AgentAppList status={status} onStatus={onStatus} onError={setError} />

      {status.full_access && <AgentDeletes onError={setError} />}
      <ManualSetup command={status.command} onError={setError}>
        <div className="agent-test">
          <button type="button" className="ghost small" disabled={test === "running" || !status.enabled} onClick={() => void runTest()}>
            {test === "running" ? "Testing…" : "Test the connection"}
          </button>
          {test && test !== "running" && <span className={test.ok ? "agent-test-result ok" : "agent-test-result error"}>{test.text}</span>}
        </div>
      </ManualSetup>
      {error && <p className="rem-error">{error}</p>}
    </section>
  );
}

/**
 * The AI apps found on this Mac, each with Connect / Disconnect. Used in
 * Connectors and in the first-run tour.
 */
export function AgentAppList({
  status,
  onStatus,
  onError,
}: {
  status: AgentsStatus;
  onStatus: (s: AgentsStatus) => void;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  // Apps connected just now: show what to do next.
  const [fresh, setFresh] = useState<string[]>([]);

  const installed = status.apps.filter((a) => a.installed);
  const missing = status.apps.filter((a) => !a.installed);
  const todo = installed.filter((a) => !a.connected || a.stale);

  const run: Run = async (action, connected = []) => {
    onError(null);
    try {
      onStatus(await action());
      setFresh((f) => [...f.filter((id) => !connected.includes(id)), ...connected]);
    } catch (e) {
      onError(String(e));
    }
  };

  async function act(key: string, action: () => Promise<AgentsStatus>, connected?: string[]) {
    setBusy(key);
    await run(action, connected);
    setBusy(null);
  }

  if (installed.length === 0) {
    return (
      <p className="setting-line muted">Install one of these to connect it: {status.apps.map((a) => a.name).join(", ")}.</p>
    );
  }

  return (
    <div className="agent-apps">
      <ul className="agent-app-list">
        {installed.map((app) => (
          <AppRow
            key={app.id}
            app={app}
            busy={busy !== null}
            working={busy === app.id}
            fresh={fresh.includes(app.id) && app.connected && !app.stale}
            onConnect={() => void act(app.id, () => api.agentsConnect(app.id), [app.id])}
            onDisconnect={() => void act(app.id, () => api.agentsDisconnect(app.id))}
          />
        ))}
      </ul>
      {todo.length > 1 && (
        <button
          type="button"
          className="primary small agent-all"
          disabled={busy !== null}
          onClick={() =>
            void act(
              "all",
              () => api.agentsConnect("all"),
              todo.map((a) => a.id),
            )
          }
        >
          {busy === "all" ? "Connecting…" : `Connect all ${todo.length}`}
        </button>
      )}
      {missing.length > 0 && <p className="agent-app-hint">Also works with {missing.map((a) => a.name).join(", ")}.</p>}
    </div>
  );
}

function AppRow({
  app,
  busy,
  working,
  fresh,
  onConnect,
  onDisconnect,
}: {
  app: AgentApp;
  busy: boolean;
  working: boolean;
  fresh: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <li className="agent-app-row">
      <div className="agent-app-head">
        <AgentTile agent={app.id} size={28} />
        <span className="agent-app-name">
          <b>{app.name}</b>
          {app.connected && !app.stale && <span className="agent-ok">✓ Connected</span>}
          {app.stale && <span className="agent-warn">Update available</span>}
        </span>
        {app.connected && !app.stale ? (
          <button type="button" className="link-btn quiet" disabled={busy} onClick={onDisconnect}>
            {working ? "Removing…" : "Disconnect"}
          </button>
        ) : (
          <button type="button" className="ghost small agent-connect" disabled={busy} onClick={onConnect}>
            {working ? "Connecting…" : app.stale ? "Update" : "Connect"}
          </button>
        )}
      </div>
      {fresh && <p className="agent-app-hint">Connected. {app.restart_hint}</p>}
    </li>
  );
}

/** For apps TodoCity doesn't know: the command and JSON to paste. */
export function ManualSetup({ command, onError, children }: { command: string; onError: (m: string | null) => void; children?: ReactNode }) {
  const [copied, setCopied] = useState<string | null>(null);
  const quoted = `"${command}"`;
  const generic = JSON.stringify({ mcpServers: { todocity: { command, args: ["--mcp"] } } }, null, 2);

  async function copy(key: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      window.setTimeout(() => setCopied((c) => (c === key ? null : c)), 1600);
    } catch (e) {
      onError(String(e));
    }
  }

  return (
    <details className="agent-manual">
      <summary>More: another app, or test the connection</summary>
      <p className="agent-app-hint">Add a stdio MCP server named “todocity” that runs:</p>
      <code className="agent-cmd">{quoted} --mcp</code>
      <div className="agent-manual-actions">
        <button type="button" className="ghost small" onClick={() => void copy("json", generic)}>
          {copied === "json" ? "Copied" : "Copy JSON"}
        </button>
        <button type="button" className="ghost small" onClick={() => void copy("cmd", `${quoted} --mcp`)}>
          {copied === "cmd" ? "Copied" : "Copy command"}
        </button>
      </div>
      {children}
    </details>
  );
}

/** Tasks agents deleted in the last 7 days, each with "Bring back". */
export function AgentDeletes({ onError }: { onError: (e: string) => void }) {
  const [gone, setGone] = useState<AgentChange[]>([]);
  const load = useCallback(
    () =>
      void api
        .agentActivity()
        .then((cs) => setGone(cs.filter((c) => c.kind === "deleted" && !c.undone).sort((a, b) => b.id - a.id)))
        .catch(() => undefined),
    [],
  );
  useEffect(() => {
    load();
    const sub = onAgentChanges(load);
    return () => void sub.then((u) => u());
  }, [load]);
  if (!gone.length) return null;
  const fmt = new Intl.DateTimeFormat(safeLocale(), { weekday: "short", hour: "numeric", minute: "2-digit" });
  return (
    <>
      <h4 className="connector-subhead">Deleted by agents</h4>
      <ul className="agent-deletes" aria-label="Deleted by agents">
        {gone.slice(0, 20).map((c) => (
          <li key={c.id}>
            <span className="agent-deletes-text">
              <b>{c.title}</b>
              <small>
                {c.agent} · {fmt.format(new Date(c.at))}
              </small>
            </span>
            <button
              type="button"
              className="ghost small"
              onClick={() =>
                void api
                  .agentUndo({ change: c.id })
                  .then(load)
                  .catch((e) => onError(String(e)))
              }
            >
              Bring back
            </button>
          </li>
        ))}
      </ul>
      <p className="agent-deletes-note">Kept for 7 days.</p>
    </>
  );
}
