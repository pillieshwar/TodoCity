//! The Slack connector on the Mac (Settings → Connectors → Slack). The rules
//! are in `todocity_core::slack`; this runs them.
//!
//! One toggle: turning it on picks the person's agent, opens it in the
//! agent panel with the setup check (the UI starts that terminal on the
//! `slack-setup` event), and waits for the agent's `slack_check` call over
//! MCP. Once ready, a worker scans Slack headless every five minutes, from
//! where the last good scan ended, and adds what needs the person to the
//! Inbox. State lives in `slack.json`, local to this Mac.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::Duration;

use chrono::{Local, TimeZone};
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use todocity_core::agent_runs;
use todocity_core::slack::{self as rules, CheckOutcome, Item, LogEntry, Phase};
use todocity_core::NewTask;

use crate::agents::apps;

const FILE: &str = "slack.json";
/// One scan: the agent starts, reads Slack and answers.
const SCAN_TIME: Duration = Duration::from_secs(5 * 60);
/// How often the worker looks at the clock (a Mac waking from sleep is
/// noticed within this).
const TICK: Duration = Duration::from_secs(20);
const SLACK_BUNDLE: &str = "com.tinyspeck.slackmacgap";

pub struct SlackService {
    path: PathBuf,
    state: Mutex<rules::State>,
    scanning: AtomicBool,
    wake: Mutex<Option<mpsc::Sender<()>>>,
}

impl SlackService {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join(FILE);
        let state = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            path,
            state: Mutex::new(state),
            scanning: AtomicBool::new(false),
            wake: Mutex::new(None),
        }
    }

    fn get(&self) -> rules::State {
        self.state.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Change the state and save it.
    fn update<T>(&self, f: impl FnOnce(&mut rules::State) -> T) -> T {
        let mut s = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let out = f(&mut s);
        match serde_json::to_vec_pretty(&*s) {
            Ok(bytes) => {
                if let Err(e) = std::fs::write(&self.path, bytes) {
                    log::warn!("slack: could not save {}: {e}", self.path.display());
                }
            }
            Err(e) => log::warn!("slack: could not encode its state: {e}"),
        }
        out
    }

    /// Look at the clock now (after a change, or "Check now").
    fn nudge(&self) {
        if let Ok(w) = self.wake.lock() {
            if let Some(tx) = w.as_ref() {
                let _ = tx.send(());
            }
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn local_text(ms: i64) -> Option<String> {
    match Local.timestamp_millis_opt(ms) {
        chrono::LocalResult::Single(t) | chrono::LocalResult::Ambiguous(t, _) => {
            Some(t.format("%Y-%m-%dT%H:%M:%S").to_string())
        }
        chrono::LocalResult::None => None,
    }
}

fn changed(app: &AppHandle) {
    let _ = app.emit("slack-changed", ());
}

fn agent_name(id: &str) -> String {
    agent_runs::cli(id)
        .map(|c| c.name.to_string())
        .unwrap_or_else(|| id.to_string())
}

// ── What the Slack card shows ─────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct AgentChoice {
    pub id: &'static str,
    pub name: &'static str,
    pub installed: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ActivityView {
    pub at: Option<String>,
    pub kind: String,
    pub text: String,
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SlackStatus {
    pub enabled: bool,
    /// "off", "checking", "ready", "needs_slack", "stalled".
    pub phase: &'static str,
    /// Why Slack isn't readable: "no_slack", "cant_read", "no_read_tools".
    pub reason: Option<String>,
    pub detail: Option<String>,
    pub agent: Option<String>,
    pub agent_name: Option<String>,
    pub scanning: bool,
    /// Local `YYYY-MM-DDTHH:MM:SS`.
    pub last_checked: Option<String>,
    pub next_check: Option<String>,
    /// Messages up to here have been looked at.
    pub covered_until: Option<String>,
    pub last_error: Option<String>,
    pub added: u64,
    pub activity: Vec<ActivityView>,
}

fn status_of(s: &rules::State, scanning: bool) -> SlackStatus {
    let (phase, reason, detail) = match &s.phase {
        Phase::Off => ("off", None, None),
        Phase::Checking { .. } => ("checking", None, None),
        Phase::Ready => ("ready", None, None),
        Phase::NeedsSlack { reason, detail } => {
            ("needs_slack", Some(reason.clone()), detail.clone())
        }
        Phase::Stalled => ("stalled", None, None),
    };
    SlackStatus {
        enabled: s.enabled,
        phase,
        reason,
        detail,
        agent: s.agent.clone(),
        agent_name: s.agent.as_deref().map(agent_name),
        scanning,
        last_checked: (s.last_ok_ms > 0)
            .then(|| local_text(s.last_ok_ms))
            .flatten(),
        next_check: s.next_scan_ms().and_then(local_text),
        covered_until: (s.cursor_ms > 0).then(|| local_text(s.cursor_ms)).flatten(),
        last_error: s.last_error.clone(),
        added: s.added,
        activity: s
            .log
            .iter()
            .take(12)
            .map(|l| ActivityView {
                at: local_text(l.at_ms),
                kind: l.kind.clone(),
                text: l.text.clone(),
                url: l.url.clone(),
            })
            .collect(),
    }
}

#[tauri::command]
pub fn slack_status(service: State<'_, SlackService>) -> SlackStatus {
    status_of(&service.get(), service.scanning.load(Ordering::SeqCst))
}

/// The agents that can read Slack for TodoCity, and which are installed.
#[tauri::command]
pub async fn slack_agents() -> Result<Vec<AgentChoice>, String> {
    let installed = tauri::async_runtime::spawn_blocking(crate::agent_panel::find_installed)
        .await
        .map_err(|e| e.to_string())?;
    Ok(agent_runs::CLIS
        .iter()
        .filter(|c| rules::can_scan(c.id))
        .map(|c| AgentChoice {
            id: c.id,
            name: c.name,
            installed: installed.iter().any(|i| i == c.id),
        })
        .collect())
}

// ── Turning it on ─────────────────────────────────────────────────────────

/// What the UI starts in the agent panel for the setup check.
#[derive(Debug, Clone, Serialize)]
pub struct SetupPlan {
    pub agent: String,
    pub agent_name: String,
    pub prompt: String,
    /// Tools the session may use without asking (Claude Code).
    pub allow: Vec<String>,
}

/// The agent to use: the one asked for, else the one used before, else
/// Watch's, else the first installed one that can read Slack for TodoCity.
fn pick_agent(
    asked: Option<&str>,
    before: Option<&str>,
    watch: &str,
    installed: &[String],
) -> Option<String> {
    let usable = |id: &str| rules::can_scan(id) && agent_runs::cli(id).is_some();
    if let Some(a) = asked.filter(|a| usable(a)) {
        return Some(a.to_string());
    }
    let is_installed = |id: &str| installed.iter().any(|i| i == id);
    for c in [before, Some(watch)].into_iter().flatten() {
        if usable(c) && is_installed(c) {
            return Some(c.to_string());
        }
    }
    rules::SCAN_AGENTS
        .iter()
        .find(|id| is_installed(id))
        .map(|id| id.to_string())
}

fn new_token() -> String {
    let mut bytes = [0u8; 12];
    if getrandom::fill(&mut bytes).is_err() {
        bytes[..8].copy_from_slice(&now_ms().to_le_bytes());
    }
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The toggle, on: pick the agent and start its check. The UI hears
/// `slack-setup` and opens the agent in the panel; the result comes back
/// through `slack_check` (see [`on_check`]).
#[tauri::command]
pub async fn slack_connect(app: AppHandle, agent: Option<String>) -> Result<SetupPlan, String> {
    let installed = tauri::async_runtime::spawn_blocking(crate::agent_panel::find_installed)
        .await
        .map_err(|e| e.to_string())?;
    let service = app.state::<SlackService>();
    let before = service.get().agent;
    let watch = app.state::<crate::settings::Settings>().get().watch.reader;
    let Some(agent) = pick_agent(agent.as_deref(), before.as_deref(), &watch, &installed) else {
        return Err("Install Claude Code, Codex or Cursor Agent and connect Slack to it, then turn Slack on here.".into());
    };
    let token = new_token();
    service.update(|s| s.begin_check(&agent, &token, now_ms()));
    let plan = SetupPlan {
        agent_name: agent_name(&agent),
        prompt: rules::setup_prompt(&token),
        allow: rules::setup_allow(&agent),
        agent,
    };
    log::info!("slack: checking Slack with {}", plan.agent_name);
    let _ = app.emit("slack-setup", plan.clone());
    changed(&app);
    Ok(plan)
}

/// The toggle, off.
#[tauri::command]
pub fn slack_disconnect(app: AppHandle) {
    app.state::<SlackService>().update(|s| s.turn_off());
    log::info!("slack: turned off");
    changed(&app);
}

/// "Check now": scan as soon as the worker can.
#[tauri::command]
pub fn slack_check_now(app: AppHandle) {
    let service = app.state::<SlackService>();
    service.update(|s| {
        s.last_attempt_ms = 0;
        s.failures = 0;
        // Due right away, still from where the last scan ended.
        s.cursor_ms = s.cursor_ms.min(now_ms() - rules::EVERY_MS);
    });
    service.nudge();
    changed(&app);
}

/// The setup agent's report (TodoCity's `slack_check` MCP tool).
pub fn on_check(app: &AppHandle, args: &Value) -> Result<Value, String> {
    let check: rules::Check = serde_json::from_value(args.clone())
        .map_err(|e| format!("TodoCity couldn't read that check ({e})."))?;
    let service = app.state::<SlackService>();
    let state = service.get();
    if !state.waiting_for(&check.token) {
        return Err("TodoCity isn't waiting for this Slack check. Turn Slack on in TodoCity → Settings → Connectors to start a new one.".into());
    }
    let agent = state.agent.clone().unwrap_or_default();
    let now = now_ms();
    let today = Local::now().date_naive();
    match rules::judge_check(&check, &agent, today, now) {
        CheckOutcome::NeedsSlack { reason, detail } => {
            log::info!(
                "slack: {} can't read Slack yet ({reason})",
                agent_name(&agent)
            );
            service.update(|s| s.phase = Phase::NeedsSlack { reason, detail });
            changed(app);
            Ok(json!({
                "ok": true,
                "message": "Thanks. TodoCity will show the user how to connect Slack to you. Tell them in one line that Slack needs connecting first."
            }))
        }
        CheckOutcome::Ready { tools, sample } => {
            service.update(|s| {
                s.tools = tools;
                s.phase = Phase::Ready;
                // Scans start from now; the sample covers what came before.
                s.cursor_ms = now;
                s.last_ok_ms = now;
                s.last_attempt_ms = now;
                s.failures = 0;
                s.last_error = None;
                s.push_log(LogEntry {
                    at_ms: now,
                    kind: "ready".into(),
                    text: format!("Connected through {}", agent_name(&agent)),
                    url: None,
                });
            });
            let added = sample.map(|i| add_items(app, &[i])).unwrap_or_default();
            log::info!(
                "slack: ready with {} ({} sample task)",
                agent_name(&agent),
                added.len()
            );
            crate::notifications::send_plain(
                app,
                "slack-ready",
                "Slack is connected".into(),
                "Messages that need you will show up in your Inbox.".into(),
            );
            changed(app);
            service.nudge();
            Ok(json!({
                "ok": true,
                "message": "TodoCity's Slack connector is ready. Tell the user in one line, then you're done."
            }))
        }
    }
}

// ── Adding tasks ──────────────────────────────────────────────────────────

/// Whether a task from this Slack link exists already (another Mac may
/// have added it, and sync brought it here).
fn added_elsewhere(app: &AppHandle, url: &str) -> bool {
    app.state::<crate::AppState>()
        .store
        .lock()
        .map(|store| store.has_source_url(url).unwrap_or(false))
        .unwrap_or(false)
}

/// Add each item not added before (here, or on another Mac by its link) to
/// the Inbox. Returns the titles added.
fn add_items(app: &AppHandle, items: &[Item]) -> Vec<String> {
    let service = app.state::<SlackService>();
    let mut added = Vec::new();
    for item in items {
        if service.get().is_seen(&item.key) {
            continue;
        }
        let elsewhere = item
            .url
            .as_deref()
            .is_some_and(|url| added_elsewhere(app, url));
        if elsewhere {
            service.update(|s| s.remember(&item.key, now_ms()));
            continue;
        }
        let task = NewTask {
            title: item.title.clone(),
            due_date: item.due_date.clone(),
            source_app: Some("Slack".into()),
            source_bundle: Some(SLACK_BUNDLE.into()),
            source_url: item.url.clone(),
            notes: item.from.as_ref().map(|f| format!("From {f} in Slack")),
            // The Inbox, whatever mode the Mac is in.
            project: None,
            ..Default::default()
        };
        match crate::insert_task_as_is(app, task) {
            Ok(_) => {
                added.push(item.title.clone());
                let now = now_ms();
                service.update(|s| {
                    s.remember(&item.key, now);
                    s.added += 1;
                    s.push_log(LogEntry {
                        at_ms: now,
                        kind: "added".into(),
                        text: item.title.clone(),
                        url: item.url.clone(),
                    });
                });
            }
            // One message never stops the rest.
            Err(e) => log::warn!("slack: couldn't add a task: {e}"),
        }
    }
    added
}

// ── Scanning ──────────────────────────────────────────────────────────────

/// Ask the agent about one window; the checked answer.
fn ask(agent: &str, tools: &[String], since: i64, until: i64) -> Result<rules::Scan, String> {
    let cli = agent_runs::cli(agent).ok_or("Pick an agent for Slack in Settings → Connectors.")?;
    let today = Local::now().date_naive();
    let message = rules::scan_prompt(since, until, today);
    let args = rules::scan_args(agent, &message, tools)
        .ok_or("Turn Slack off and on again in Settings → Connectors to set it up again.")?;
    let (program, argv) = crate::agent_panel::agent_argv(cli, &args);
    // A folder of its own with nothing in it.
    let dir = std::env::temp_dir().join("todocity-slack");
    let _ = std::fs::create_dir_all(&dir);
    let reply =
        apps::run(Command::new(program).args(argv).current_dir(dir), SCAN_TIME).map_err(|e| {
            let last = e.lines().last().unwrap_or_default().trim().to_string();
            if last.is_empty() {
                format!("{} didn't answer.", cli.name)
            } else {
                format!("{}: {last}", cli.name)
            }
        })?;
    let json = todocity_core::agent_llm::json_from_reply(&reply).ok_or_else(|| {
        format!(
            "{} didn't answer with the list TodoCity asked for.",
            cli.name
        )
    })?;
    rules::parse_scan(&json, since, until, today)
}

/// One scan, if one is due. Returns whether it ran.
fn scan_once(app: &AppHandle) -> bool {
    let service = app.state::<SlackService>();
    let now = now_ms();
    let state = service.get();
    if !state.scan_due(now) || service.scanning.swap(true, Ordering::SeqCst) {
        return false;
    }
    let (since, until) = rules::window(state.cursor_ms, now);
    service.update(|s| s.last_attempt_ms = now);
    changed(app);
    let agent = state.agent.clone().unwrap_or_default();
    let result = ask(&agent, &state.tools, since, until);
    // Turned off (or set up again) meanwhile: drop the answer.
    let still = service.get();
    let current = still.enabled && still.phase == Phase::Ready && still.agent == state.agent;
    match result {
        Ok(_) if !current => {}
        Ok(scan) => {
            let added = add_items(app, &scan.items);
            service.update(|s| s.scanned(scan.covered_until_ms, now_ms()));
            log::info!(
                "slack: looked at {} to {}, added {}",
                local_text(since).unwrap_or_default(),
                local_text(scan.covered_until_ms).unwrap_or_default(),
                added.len()
            );
            let body = match added.as_slice() {
                [] => None,
                [one] => Some(one.clone()),
                many => Some(format!("{} new tasks in your Inbox", many.len())),
            };
            if let Some(body) = body {
                crate::notifications::send_plain(app, "slack-added", "From Slack".into(), body);
            }
        }
        Err(e) if current => {
            log::warn!("slack: scan failed: {e}");
            service.update(|s| s.scan_failed(&e, now_ms()));
        }
        Err(_) => {}
    }
    service.scanning.store(false, Ordering::SeqCst);
    changed(app);
    true
}

/// The worker: every few seconds, see whether a scan is due (so a Mac that
/// slept catches up as soon as it wakes) and whether a check has stalled.
pub fn start(app: &AppHandle) {
    let (tx, rx) = mpsc::channel::<()>();
    if let Ok(mut w) = app.state::<SlackService>().wake.lock() {
        *w = Some(tx);
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("todocity-slack".into())
        .spawn(move || loop {
            let service = app.state::<SlackService>();
            let late = matches!(service.get().phase, Phase::Checking { .. })
                && service.update(|s| s.stall_if_late(now_ms()));
            if late {
                log::info!("slack: the setup check didn't report back");
                changed(&app);
            }
            // Catching up runs scans back to back (each waits a moment).
            while scan_once(&app) {}
            let _ = rx.recv_timeout(TICK);
        });
    if let Err(e) = spawned {
        log::warn!("could not start the Slack connector: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_agent_asked_for_then_the_one_used_before() {
        let installed = vec!["codex".to_string(), "claude".to_string()];
        assert_eq!(
            pick_agent(Some("cursor"), Some("codex"), "local", &installed).as_deref(),
            Some("cursor")
        );
        assert_eq!(
            pick_agent(None, Some("codex"), "claude", &installed).as_deref(),
            Some("codex")
        );
        assert_eq!(
            pick_agent(None, None, "codex", &installed).as_deref(),
            Some("codex")
        );
        // Watch on this Mac's open model: the first installed that can read Slack.
        assert_eq!(
            pick_agent(None, None, "local", &installed).as_deref(),
            Some("claude")
        );
        // Agents that can't scan headless aren't picked.
        assert_eq!(
            pick_agent(Some("gemini"), None, "gemini", &[]).as_deref(),
            None
        );
    }
}
