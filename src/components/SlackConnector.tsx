import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { fileLogo } from "../lib/sourceLogos";
import { ago, connectSteps, until } from "../lib/slack";
import type { SlackAgent, SlackSetupPlan, SlackStatus } from "../lib/types";
import { AgentTile } from "./AgentPanel";
import { InfoTip } from "./InfoTip";

/** Slack's own logo (official file). */
export function SlackGlyph({ size = 20 }: { size?: number }) {
  const logo = fileLogo("slack");
  return logo ? <img src={logo.src} width={size} height={size} alt="" aria-hidden /> : null;
}

export const SLACK_PRIVACY =
  "Your agent reads Slack with its own Slack access, and what it reads goes to that agent's service, just as when you use it yourself. Only its read and search tools are used. The tasks stay in TodoCity on this Mac, and each Slack message becomes one task at most.";

/** The switch in the Slack card's header: one change turns everything on or off. */
export function SlackSwitch({ status, onError }: { status: SlackStatus | null; onError: (e: string | null) => void }) {
  const [busy, setBusy] = useState(false);
  const on = !!status?.enabled;
  async function set(v: boolean) {
    onError(null);
    setBusy(true);
    try {
      if (v) await api.slackConnect(null);
      else await api.slackDisconnect();
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <input
      type="checkbox"
      role="switch"
      className="switch slack-switch"
      aria-label="Turn Slack messages into tasks"
      checked={on}
      disabled={busy}
      onChange={(e) => void set(e.target.checked)}
    />
  );
}

/** What the Slack card shows once it's on: who reads Slack, how it's going, what came in. */
export function SlackBody({ status, error }: { status: SlackStatus; error: string | null }) {
  const [agents, setAgents] = useState<SlackAgent[]>([]);
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api.slackAgents().then(setAgents).catch(() => undefined);
    const t = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(t);
  }, []);
  const installed = agents.filter((a) => a.installed || a.id === status.agent);
  const run = async (f: () => Promise<unknown>) => {
    setErr(null);
    setBusy(true);
    try {
      await f();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };
  const name = status.agent_name ?? "your agent";

  return (
    <div className="connector-body-inner slack-body">
      <div className="slack-who">
        <AgentTile agent={status.agent} size={22} />
        <span className="slack-who-text">
          Read by <b>{name}</b>
          <InfoTip text={SLACK_PRIVACY} label="About the Slack connector" />
        </span>
        {installed.length > 1 && (
          <select
            className="slack-agent-pick"
            value={status.agent ?? ""}
            aria-label="Agent that reads Slack"
            disabled={busy || status.phase === "checking"}
            onChange={(e) => void run(() => api.slackConnect(e.target.value))}
          >
            {installed.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {status.phase === "checking" && (
        <p className="setting-line slack-state">
          <span className="slack-pulse" aria-hidden />
          <span className="setting-line-text">{name} is checking your Slack in the agent panel. TodoCity lets you know when it's ready.</span>
        </p>
      )}

      {(status.phase === "needs_slack" || status.phase === "stalled") && (
        <div className="slack-needs">
          <p className="setting-line-text">
            {status.phase === "stalled" ? `Check again to finish setting up with ${name}.` : `Connect Slack to ${name} to finish:`}
          </p>
          {status.phase === "needs_slack" && (
            <ol>
              {connectSteps(status.agent, status.reason).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          )}
          {status.detail && <p className="slack-detail">{status.detail}</p>}
          <div className="rem-actions">
            <button type="button" className="primary small" disabled={busy} onClick={() => void run(() => api.slackConnect(status.agent))}>
              Check again
            </button>
          </div>
        </div>
      )}

      {status.phase === "ready" && (
        <>
          <div className="setting-line slack-state">
            <span className={status.scanning ? "slack-pulse" : "dot ok"} aria-hidden />
            <span className="setting-line-text">
              {status.scanning
                ? "Looking at Slack now…"
                : [
                    status.last_checked ? `Checked ${ago(status.last_checked, now)}` : null,
                    status.next_check ? `next ${until(status.next_check, now)}` : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
            </span>
            <button type="button" className="ghost small" disabled={busy || status.scanning} onClick={() => void run(() => api.slackCheckNow())}>
              Check now
            </button>
          </div>
          <p className="setting-line-text muted slack-note">
            Every 5 minutes, {name} looks at your DMs, group DMs and mentions. If the Mac was asleep, it picks up from the last check, so nothing is missed.
          </p>
          {status.last_error && (
            <p className="slack-detail">
              Last try: {status.last_error}. TodoCity tries again on its own, or choose Check now.
            </p>
          )}
        </>
      )}

      {status.activity.length > 0 && (
        <>
          <h4 className="connector-subhead">{status.added > 0 ? `Added from Slack · ${status.added}` : "Activity"}</h4>
          <ul className="slack-activity">
            {status.activity
              .filter((a) => a.kind !== "error")
              .slice(0, 8)
              .map((a, i) => (
                <li key={`${a.at}-${i}`}>
                  <span className={a.kind === "added" ? "slack-act added" : "slack-act"}>{a.kind === "added" ? "+" : "✓"}</span>
                  {a.url ? (
                    <a href={a.url} target="_blank" rel="noreferrer">
                      {a.text}
                    </a>
                  ) : (
                    <span>{a.text}</span>
                  )}
                  <small>{ago(a.at, now)}</small>
                </li>
              ))}
          </ul>
        </>
      )}
      {(error || err) && <p className="rem-error">{error || err}</p>}
    </div>
  );
}

/**
 * Shown when Slack is turned on: the agent is checking Slack in the panel
 * beside it, and TodoCity says when it's ready (or what to connect).
 */
export function SlackSetupDialog({
  plan,
  status,
  onClose,
  onWatch,
  onHelp,
}: {
  plan: SlackSetupPlan;
  status: SlackStatus | null;
  onClose: () => void;
  /** Close the dialog and look at the agent working in the panel. */
  onWatch: () => void;
  /** Start the agent to help connect Slack to it. */
  onHelp: () => void;
}) {
  const done = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    done.current?.focus();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const phase = status?.phase ?? "checking";
  const name = plan.agent_name;
  const [busy, setBusy] = useState(false);
  const again = async () => {
    setBusy(true);
    try {
      await api.slackConnect(plan.agent);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="who-scrim" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="who-dialog slack-dialog" role="dialog" aria-modal="true" aria-labelledby="slack-setup-title">
        <div className="slack-dialog-icons" aria-hidden>
          <SlackGlyph size={30} />
          <span className="slack-dialog-arrow">→</span>
          <AgentTile agent={plan.agent} size={30} />
        </div>

        {phase === "ready" ? (
          <>
            <h2 id="slack-setup-title">Slack is connected</h2>
            <p>
              Every 5 minutes, {name} looks at your DMs, group DMs and mentions, and anything that needs you lands in your Inbox. If your Mac sleeps, it catches up when it wakes.
            </p>
            {status && status.added > 0 && <p>Your most recent DM is already in your Inbox, so you can see how it looks.</p>}
          </>
        ) : phase === "needs_slack" ? (
          <>
            <h2 id="slack-setup-title">Connect Slack to {name}</h2>
            <p>Once {name} can read Slack, TodoCity takes it from there.</p>
            <ol className="slack-steps">
              {connectSteps(plan.agent, status?.reason ?? null).map((s, i) => (
                <li key={s}>
                  <span className="slack-step-n">{i + 1}</span>
                  <span>{s}</span>
                </li>
              ))}
            </ol>
          </>
        ) : phase === "stalled" ? (
          <>
            <h2 id="slack-setup-title">Check again to finish</h2>
            <p>Check again to finish. If {name} asks to use Slack or TodoCity in the panel, allow it.</p>
          </>
        ) : (
          <>
            <h2 id="slack-setup-title">Checking Slack with {name}</h2>
            <p>
              {name} is looking for its Slack tools and reading your latest DM, in the agent panel. You can keep working; TodoCity lets you know when it's ready.
            </p>
            <p className="slack-dialog-tip">If {name} asks to use Slack in the panel, allow it so it can read for TodoCity from now on.</p>
            <div className="slack-dialog-progress" aria-hidden>
              <span />
            </div>
          </>
        )}

        <div className="who-dialog-actions">
          {phase === "needs_slack" && (
            <button type="button" className="ghost" onClick={onHelp}>
              Ask {name} to help
            </button>
          )}
          {(phase === "needs_slack" || phase === "stalled") && (
            <button type="button" className="ghost" disabled={busy} onClick={() => void again()}>
              Check again
            </button>
          )}
          {phase === "checking" && (
            <button type="button" className="ghost" onClick={onWatch}>
              Watch it work
            </button>
          )}
          <button type="button" className="primary" ref={done} onClick={onClose}>
            {phase === "ready" ? "Done" : "Got it"}
          </button>
        </div>
        <small>{SLACK_PRIVACY}</small>
      </div>
    </div>
  );
}
