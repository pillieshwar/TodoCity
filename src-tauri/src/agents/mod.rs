//! AI agents: add-only by default, full access when the user turns it on.
//!
//! AI apps on this Mac (Claude Desktop, Claude Code, Cursor…) launch
//! `TodoCity --mcp`, an MCP server (see `mcp.rs`) that talks to the running
//! app over a Unix socket only this user can open.
//!
//! By default it has one tool, `add_task`: the app puts each task in an inbox
//! and nothing is added until the user approves it in the menu-bar dropdown.
//! Every accepted task gets the same reply, with no id, no duplicate check
//! and no counts, so an agent learns nothing about the user's tasks.
//!
//! With full access on (`agents_full_access`), every tool in
//! `todocity_core::agent_tools` works: read, add, change, complete and
//! delete, with no review (`ToolCall` / `on_call`). The app checks the
//! setting on every call.

// The socket listener is Unix-only; elsewhere most of this is unused.
#![cfg_attr(not(unix), allow(dead_code))]

pub mod apps;
pub mod mcp;

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use todocity_core::NewTask;

use crate::settings::Settings;

pub const SOCKET_NAME: &str = "agents.sock";
const INBOX_FILE: &str = "agent-inbox.json";
/// Waiting tasks kept at most; more are refused until some are reviewed.
const INBOX_MAX: usize = 50;
/// At most this many tasks per `RATE_WINDOW`, from all agents together.
const RATE_MAX: usize = 20;
const RATE_WINDOW: Duration = Duration::from_secs(600);
const TITLE_MAX: usize = 200;
const NOTES_MAX: usize = 2000;
const AGENT_MAX: usize = 40;

/// What `TodoCity --mcp` sends to the app: one JSON line per task.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Submission {
    /// The AI app, from its MCP `clientInfo` (e.g. "claude-ai").
    pub agent: String,
    pub task: TaskDraft,
}

/// A task as an agent describes it. Deliberately small: no links, tags,
/// repeats or ids.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskDraft {
    pub title: String,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub due_time: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    /// A deadline phrase to resolve later ("by Friday"), when there's no
    /// due_date. Used by watch mode.
    #[serde(default)]
    pub date_text: Option<String>,
}

/// What `TodoCity --mcp` sends for a full-access tool: one JSON line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToolCall {
    /// The AI app, from its MCP `clientInfo`.
    pub agent: String,
    /// One of `todocity_core::agent_tools::names()`.
    pub tool: String,
    #[serde(default)]
    pub args: serde_json::Value,
}

/// The app's answer to a tool call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CallReply {
    pub ok: bool,
    #[serde(default)]
    pub result: Option<serde_json::Value>,
    #[serde(default)]
    pub error: Option<String>,
}

/// Turned off, or not set up: what agents are told.
pub const FULL_ACCESS_OFF: &str =
    "Full access is off. The user can turn it on in TodoCity → Settings → Agents → Full access.";

/// Run a full-access tool for an agent, then refresh what the change touches.
fn on_call(app: &AppHandle, call: ToolCall) -> CallReply {
    // An agent TodoCity started reporting on its task: allowed with or
    // without full access (it only touches that run).
    if call.tool == mcp::REPORT_TOOL {
        return match crate::agent_panel::on_report(app, &call.args) {
            Ok(result) => CallReply {
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(e) => CallReply {
                ok: false,
                result: None,
                error: Some(e),
            },
        };
    }
    let settings = app.state::<Settings>().get();
    if !settings.agents_enabled || !settings.agents_full_access {
        return CallReply {
            ok: false,
            result: None,
            error: Some(FULL_ACCESS_OFF.into()),
        };
    }
    let now = chrono::Local::now().naive_local();
    let outcome = {
        let state = app.state::<crate::AppState>();
        let Ok(store) = state.store.lock() else {
            return CallReply {
                ok: false,
                result: None,
                error: Some("TodoCity is busy; try again.".into()),
            };
        };
        // Meetings, for find_free_time and get_schedule: only when the
        // person shows their calendars in TodoCity, and never hidden ones.
        let busy = |from: chrono::NaiveDate,
                    to: chrono::NaiveDate|
         -> Vec<todocity_core::agent_tools::Busy> {
            if !settings.calendar_enabled {
                return Vec::new();
            }
            let fmt = |d: chrono::NaiveDate| d.format("%Y-%m-%d").to_string();
            let parse =
                |s: &str| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").ok();
            crate::calendar::events(&fmt(from), &fmt(to), &settings.calendar_hidden)
                .unwrap_or_default()
                .into_iter()
                .filter(|e| !e.all_day)
                .filter_map(|e| {
                    Some(todocity_core::agent_tools::Busy {
                        title: e.title,
                        start: parse(&e.start)?,
                        end: parse(&e.end)?,
                    })
                })
                .collect()
        };
        let ctx = todocity_core::agent_tools::Ctx {
            agent: &call.agent,
            busy: &busy,
        };
        todocity_core::agent_tools::run(&store, &ctx, &call.tool, &call.args, now)
    };
    match outcome {
        Ok(result) => {
            if !todocity_core::agent_tools::is_read_only(&call.tool) {
                log::info!(
                    "agent {} used {}",
                    call.agent.chars().take(40).collect::<String>(),
                    call.tool
                );
                if matches!(call.tool.as_str(), "complete_task" | "delete_task") {
                    if let Some(id) = call.args["id"].as_i64() {
                        crate::notifications::clear_task(id);
                    }
                }
                after_agent_change(app);
            }
            CallReply {
                ok: true,
                result: Some(result),
                error: None,
            }
        }
        Err(e) => CallReply {
            ok: false,
            result: None,
            error: Some(e),
        },
    }
}

/// Tasks changed by (or undone from) an agent: refresh everything that shows them.
fn after_agent_change(app: &AppHandle) {
    let _ = app.emit("tasks-changed", ());
    let _ = app.emit("agent-changes", ());
    crate::tray::refresh(app);
    if let Some(r) = app.try_state::<crate::reminders::Reminders>() {
        r.nudge();
    }
}

/// One agent change, as the app shows it.
#[derive(Debug, Clone, Serialize)]
pub struct ChangeInfo {
    pub id: i64,
    pub at: String,
    /// "Claude", "Cursor"…
    pub agent: String,
    pub batch: String,
    pub task_id: i64,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub undone: bool,
}

/// What agents did in the last 7 days, newest first.
#[tauri::command]
pub fn agent_activity(app: AppHandle) -> Result<Vec<ChangeInfo>, String> {
    let state = app.state::<crate::AppState>();
    let store = state.store.lock().map_err(|e| e.to_string())?;
    let _ = store.agent_prune();
    Ok(store
        .agent_changes(todocity_core::agent_log::KEEP_DAYS)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|c| ChangeInfo {
            id: c.id,
            at: c.at,
            agent: agent_label(&c.agent),
            batch: c.batch,
            task_id: c.task_id,
            kind: c.kind,
            title: c.title,
            summary: c.summary,
            undone: c.undone,
        })
        .collect())
}

/// Undo agent changes: one change, one batch, or everything done to some tasks.
#[tauri::command]
pub fn agent_undo(
    app: AppHandle,
    change: Option<i64>,
    batch: Option<String>,
    tasks: Option<Vec<i64>>,
) -> Result<usize, String> {
    let n = {
        let state = app.state::<crate::AppState>();
        let store = state.store.lock().map_err(|e| e.to_string())?;
        let mut n = 0;
        if let Some(id) = change {
            n += store.agent_undo_change(id).map_err(|e| e.to_string())?;
        }
        if let Some(b) = batch {
            n += store.agent_undo_batch(&b).map_err(|e| e.to_string())?;
        }
        for id in tasks.unwrap_or_default() {
            n += store.agent_undo_task(id).map_err(|e| e.to_string())?;
        }
        n
    };
    after_agent_change(&app);
    Ok(n)
}

/// The app's one-line answer. The same for every accepted task.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Reply {
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
}

/// Remove control characters; keep newlines only where asked.
fn clean(s: &str, keep_newlines: bool) -> String {
    s.chars()
        .map(|c| if c == '\t' { ' ' } else { c })
        .filter(|c| !c.is_control() || (keep_newlines && *c == '\n'))
        .collect::<String>()
        .trim()
        .to_string()
}

/// Check and tidy a draft. The error text goes back to the agent, so it only
/// talks about the input.
pub fn validate(draft: &TaskDraft) -> Result<TaskDraft, String> {
    let title = clean(&draft.title.replace('\n', " "), false);
    if title.is_empty() {
        return Err("title is required".into());
    }
    if title.chars().count() > TITLE_MAX {
        return Err(format!("title is longer than {TITLE_MAX} characters"));
    }
    let due_date = match draft.due_date.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(d) => {
            chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d")
                .map_err(|_| format!("due_date \"{d}\" is not a YYYY-MM-DD date"))?;
            Some(d.to_string())
        }
    };
    let due_time = match draft.due_time.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(t) => {
            let parsed = chrono::NaiveTime::parse_from_str(t, "%H:%M")
                .map_err(|_| format!("due_time \"{t}\" is not a 24-hour HH:MM time"))?;
            if due_date.is_none() {
                return Err("due_time needs a due_date".into());
            }
            Some(parsed.format("%H:%M").to_string())
        }
    };
    let notes = match draft.notes.as_deref().map(|n| clean(n, true)) {
        None => None,
        Some(n) if n.is_empty() => None,
        Some(n) if n.chars().count() > NOTES_MAX => {
            return Err(format!("notes are longer than {NOTES_MAX} characters"))
        }
        Some(n) => Some(n),
    };
    // Only meaningful without a due_date; short, single line.
    let date_text = match (
        &due_date,
        draft.date_text.as_deref().map(|d| clean(d, false)),
    ) {
        (None, Some(d)) if !d.is_empty() && d.chars().count() <= 60 => Some(d),
        _ => None,
    };
    Ok(TaskDraft {
        title,
        due_date,
        due_time,
        notes,
        date_text,
    })
}

/// "claude-ai" → "Claude", "claude-code" → "Claude Code", "cursor-vscode" →
/// "Cursor Vscode"; never empty.
pub fn agent_label(raw: &str) -> String {
    let raw = clean(raw, false);
    let known = match raw.to_ascii_lowercase().as_str() {
        "claude-ai" | "claude" | "claude-desktop" => Some("Claude"),
        "claude-code" => Some("Claude Code"),
        "cursor" | "cursor-vscode" => Some("Cursor"),
        "vscode" | "visual-studio-code" => Some("VS Code"),
        "zed" => Some("Zed"),
        "goose" => Some("Goose"),
        "lm-studio" | "lmstudio" => Some("LM Studio"),
        _ => None,
    };
    if let Some(k) = known {
        return k.to_string();
    }
    let words: Vec<String> = raw
        .split(|c: char| c == '-' || c == '_' || c.is_whitespace())
        .filter(|w| !w.is_empty())
        .map(|w| {
            let mut cs = w.chars();
            match cs.next() {
                Some(f) => f.to_uppercase().chain(cs).collect(),
                None => String::new(),
            }
        })
        .collect();
    let label: String = words.join(" ").chars().take(AGENT_MAX).collect();
    if label.is_empty() {
        "An AI agent".into()
    } else {
        label
    }
}

/// A task waiting for review.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InboxItem {
    pub id: u64,
    pub title: String,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub notes: Option<String>,
    /// Display name of the AI app that sent it (or the watched app).
    pub agent: String,
    /// Local time, `YYYY-MM-DDTHH:MM:SS`.
    pub received_at: String,
    /// Deadline phrase to resolve when shown ("by Friday"), if no due_date.
    #[serde(default)]
    pub date_text: Option<String>,
    /// "agent" (sent over MCP) or "watch" (noticed on screen).
    #[serde(default = "agent_source")]
    pub source: String,
}

fn agent_source() -> String {
    "agent".into()
}

#[derive(Default, Serialize, Deserialize)]
struct InboxFile {
    next_id: u64,
    items: Vec<InboxItem>,
    /// Tasks reviewed recently, as fingerprints only, so an agent that
    /// sends the same thing again (e.g. re-reading the same email) is
    /// quietly ignored. Never shown to agents.
    #[serde(default)]
    seen: Vec<Seen>,
}

#[derive(Clone, Serialize, Deserialize)]
struct Seen {
    fp: String,
    /// Day it was reviewed, `YYYY-MM-DD`.
    day: String,
}

/// How long a reviewed task keeps blocking an identical one.
const SEEN_DAYS: i64 = 30;
const SEEN_MAX: usize = 2000;

/// Same task, ignoring case, spacing and trailing punctuation.
fn fingerprint(title: &str, due_date: Option<&str>, due_time: Option<&str>) -> String {
    use sha2::{Digest, Sha256};
    let title = title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim_end_matches(['.', '!', '?', ',', ';', ':'])
        .to_lowercase();
    let digest = Sha256::digest(format!(
        "{title}|{}|{}",
        due_date.unwrap_or(""),
        due_time.unwrap_or("")
    ));
    digest.iter().take(12).map(|b| format!("{b:02x}")).collect()
}

impl InboxItem {
    fn fingerprint(&self) -> String {
        fingerprint(
            &self.title,
            self.due_date.as_deref().or(self.date_text.as_deref()),
            self.due_time.as_deref(),
        )
    }
}

pub struct Agents {
    path: PathBuf,
    #[cfg_attr(not(unix), allow(dead_code))]
    socket: PathBuf,
    inbox: Mutex<InboxFile>,
    recent: Mutex<VecDeque<Instant>>,
}

impl Agents {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join(INBOX_FILE);
        let inbox = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            path,
            socket: data_dir.join(SOCKET_NAME),
            inbox: Mutex::new(inbox),
            recent: Mutex::new(VecDeque::new()),
        }
    }

    pub fn items(&self) -> Vec<InboxItem> {
        self.inbox
            .lock()
            .map(|i| i.items.clone())
            .unwrap_or_default()
    }

    fn save(&self, inbox: &InboxFile) {
        match serde_json::to_vec_pretty(inbox) {
            Ok(bytes) => {
                if let Err(e) = write_private(&self.path, &bytes) {
                    log::warn!("could not save the agent inbox: {e}");
                }
            }
            Err(e) => log::warn!("could not encode the agent inbox: {e}"),
        }
    }

    /// Take a task into the inbox, within the limits. `Ok(false)`: the same
    /// task is already waiting or was reviewed recently, so it's dropped (the
    /// agent gets the usual reply either way).
    fn receive(&self, agent: &str, draft: TaskDraft) -> Result<bool, String> {
        self.receive_from(agent_label(agent), "agent", draft)
    }

    /// A to-do noticed in a watched app (`app` is its display name).
    pub fn receive_watch(&self, app: &str, draft: TaskDraft) -> Result<bool, String> {
        let draft = validate(&draft)?;
        self.receive_from(app.to_string(), "watch", draft)
    }

    fn receive_from(&self, label: String, source: &str, draft: TaskDraft) -> Result<bool, String> {
        let busy = "TodoCity can't take more tasks right now. Try again later.";
        let fp = fingerprint(
            &draft.title,
            draft.due_date.as_deref().or(draft.date_text.as_deref()),
            draft.due_time.as_deref(),
        );
        {
            let inbox = self.inbox.lock().map_err(|e| e.to_string())?;
            if inbox.items.iter().any(|i| i.fingerprint() == fp)
                || inbox.seen.iter().any(|s| s.fp == fp)
            {
                return Ok(false);
            }
        }
        {
            let mut recent = self.recent.lock().map_err(|e| e.to_string())?;
            while recent.front().is_some_and(|t| t.elapsed() > RATE_WINDOW) {
                recent.pop_front();
            }
            if recent.len() >= RATE_MAX {
                return Err(busy.into());
            }
            recent.push_back(Instant::now());
        }
        let mut inbox = self.inbox.lock().map_err(|e| e.to_string())?;
        if inbox.items.len() >= INBOX_MAX {
            return Err(busy.into());
        }
        inbox.next_id += 1;
        let item = InboxItem {
            id: inbox.next_id,
            title: draft.title,
            due_date: draft.due_date,
            due_time: draft.due_time,
            notes: draft.notes,
            agent: label,
            received_at: chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
            date_text: draft.date_text,
            source: source.into(),
        };
        inbox.items.push(item);
        self.save(&inbox);
        Ok(true)
    }

    fn take(&self, id: u64) -> Option<InboxItem> {
        let mut inbox = self.inbox.lock().ok()?;
        let pos = inbox.items.iter().position(|i| i.id == id)?;
        let item = inbox.items.remove(pos);
        let today = chrono::Local::now().date_naive();
        let cutoff = (today - chrono::Duration::days(SEEN_DAYS))
            .format("%Y-%m-%d")
            .to_string();
        inbox.seen.retain(|s| s.day >= cutoff);
        inbox.seen.push(Seen {
            fp: item.fingerprint(),
            day: today.format("%Y-%m-%d").to_string(),
        });
        let extra = inbox.seen.len().saturating_sub(SEEN_MAX);
        inbox.seen.drain(..extra);
        self.save(&inbox);
        Some(item)
    }
}

/// Write a file only this user can read.
fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)
}

/// Handle one submission from `TodoCity --mcp`.
fn on_submission(app: &AppHandle, sub: Submission) -> Reply {
    if !app.state::<Settings>().get().agents_enabled {
        return Reply {
            ok: false,
            error: Some(mcp::NOT_REACHABLE.into()),
        };
    }
    let draft = match validate(&sub.task) {
        Ok(d) => d,
        Err(e) => {
            return Reply {
                ok: false,
                error: Some(e),
            }
        }
    };
    // "Send test task" in Connectors: the whole path works, keep nothing.
    if sub.agent == mcp::SELF_TEST {
        return Reply {
            ok: true,
            error: None,
        };
    }
    let agents = app.state::<Agents>();
    match agents.receive(&sub.agent, draft) {
        Err(e) => {
            return Reply {
                ok: false,
                error: Some(e),
            }
        }
        // A repeat: same reply, nothing to show.
        Ok(false) => {
            return Reply {
                ok: true,
                error: None,
            }
        }
        Ok(true) => {}
    }
    let _ = app.emit("inbox-changed", ());
    crate::tray::refresh(app);
    // Open the dropdown on the inbox (without taking the keyboard), or
    // notify if the menu-bar icon is hidden.
    if !crate::popover::show_focus(app, crate::popover::Focus::Inbox) {
        let n = agents.items().len();
        crate::notifications::send_plain(
            app,
            "todocity-inbox",
            if n == 1 {
                "1 task to review".into()
            } else {
                format!("{n} tasks to review")
            },
            "An AI agent sent tasks to TodoCity. Open TodoCity to add or discard them.".into(),
        );
    }
    Reply {
        ok: true,
        error: None,
    }
}

/// Listen for `TodoCity --mcp` on the private socket.
pub fn start(app: &AppHandle) {
    // Apps connected to a copy of TodoCity that has moved: point them here.
    let command = exe_path();
    if !is_temporary(&command) {
        let _ = std::thread::Builder::new()
            .name("agents-repair".into())
            .spawn(move || apps::repair(&command));
    }
    #[cfg(unix)]
    {
        let socket = app.state::<Agents>().socket.clone();
        let app = app.clone();
        let spawned = std::thread::Builder::new()
            .name("agents-socket".into())
            .spawn(move || listen(&app, &socket));
        if let Err(e) = spawned {
            log::warn!("could not start the agent listener: {e}");
        }
    }
    #[cfg(not(unix))]
    let _ = app;
}

#[cfg(unix)]
fn listen(app: &AppHandle, socket: &Path) {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::{UnixListener, UnixStream};

    // A socket left over from a crash; but not one another TodoCity is using.
    if socket.exists() {
        if UnixStream::connect(socket).is_ok() {
            log::warn!("another TodoCity is listening for agents; not starting a second listener");
            return;
        }
        let _ = std::fs::remove_file(socket);
    }
    let listener = match UnixListener::bind(socket) {
        Ok(l) => l,
        Err(e) => {
            log::warn!("could not listen for agents at {}: {e}", socket.display());
            return;
        }
    };
    // Only this user can connect.
    if let Err(e) = std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600)) {
        log::warn!("could not restrict the agent socket: {e}");
        return;
    }
    log::info!("listening for AI agents at {}", socket.display());

    for stream in listener.incoming() {
        let Ok(mut stream) = stream else { continue };
        let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
        let _ = stream.set_write_timeout(Some(Duration::from_secs(3)));
        let mut line = String::new();
        let read = BufReader::new((&stream).take(16 * 1024)).read_line(&mut line);
        let Ok(_) = read else { continue };
        // A full-access tool call names its tool; anything else is a task to review.
        let is_call = serde_json::from_str::<serde_json::Value>(&line)
            .ok()
            .is_some_and(|v| v.get("tool").is_some());
        let answer = if is_call {
            match serde_json::from_str::<ToolCall>(&line) {
                Ok(call) => serde_json::to_string(&on_call(app, call)),
                Err(_) => serde_json::to_string(&CallReply {
                    ok: false,
                    result: None,
                    error: Some("TodoCity couldn't read that request.".into()),
                }),
            }
        } else {
            let reply = match serde_json::from_str::<Submission>(&line) {
                Ok(sub) => on_submission(app, sub),
                Err(_) => Reply {
                    ok: false,
                    error: Some("TodoCity couldn't read that request.".into()),
                },
            };
            serde_json::to_string(&reply)
        };
        if let Ok(mut out) = answer {
            out.push('\n');
            let _ = stream.write_all(out.as_bytes());
        }
    }
}

// ── Commands ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    /// The MCP server needs Unix sockets (macOS).
    pub supported: bool,
    pub enabled: bool,
    /// Agents add to-dos they notice on their own (still reviewed).
    pub proactive: bool,
    /// Agents can read and change everything, with no review.
    pub full_access: bool,
    /// How many tools full access gives agents.
    pub tool_count: usize,
    /// The program AI apps should launch, with `--mcp`.
    pub command: String,
    /// TodoCity is running from somewhere temporary (a disk image, or moved by
    /// macOS Gatekeeper), so the path above won't last.
    pub temporary_location: bool,
    /// Every supported AI app and whether it's set up.
    pub apps: Vec<apps::AppStatus>,
    pub pending: usize,
}

pub(crate) fn exe_path() -> String {
    std::env::current_exe()
        .map(|p| p.display().to_string())
        .unwrap_or_default()
}

fn is_temporary(command: &str) -> bool {
    command.contains("/AppTranslocation/") || command.starts_with("/Volumes/")
}

fn status(app: &AppHandle) -> Status {
    let command = exe_path();
    let settings = app.state::<Settings>().get();
    Status {
        supported: cfg!(unix),
        enabled: settings.agents_enabled,
        proactive: settings.agents_proactive,
        full_access: settings.agents_full_access,
        tool_count: todocity_core::agent_tools::names().len(),
        temporary_location: is_temporary(&command),
        apps: apps::statuses(&command),
        command,
        pending: app.state::<Agents>().items().len(),
    }
}

#[tauri::command]
pub fn agents_status(app: AppHandle) -> Status {
    status(&app)
}

#[tauri::command]
pub fn agents_set_enabled(app: AppHandle, enabled: bool) -> Status {
    app.state::<Settings>()
        .update(|s| s.agents_enabled = enabled);
    // The header's You · All · Agents switch follows this.
    let _ = app.emit("agent-changes", ());
    status(&app)
}

/// Full access for agents: read and change everything, with no review.
#[tauri::command]
pub fn agents_set_full_access(app: AppHandle, on: bool) -> Status {
    app.state::<Settings>()
        .update(|s| s.agents_full_access = on);
    // The header's You · All · Agents switch follows this.
    let _ = app.emit("agent-changes", ());
    status(&app)
}

/// Let agents suggest tasks on their own. In Claude Code this adds (or
/// removes) a small TodoCity subagent; other apps follow the tool description.
#[tauri::command]
pub async fn agents_set_proactive(app: AppHandle, on: bool) -> Status {
    app.state::<Settings>().update(|s| s.agents_proactive = on);
    let _ = tauri::async_runtime::spawn_blocking(move || apps::set_proactive(on)).await;
    status(&app)
}

pub(crate) fn refuse_temporary(command: &str) -> Result<(), String> {
    if is_temporary(command) {
        Err("Move TodoCity to your Applications folder and open it from there first.".into())
    } else {
        Ok(())
    }
}

/// Connect one app (or every installed one with `id` = "all"). Connecting
/// also turns agent access on.
#[tauri::command]
pub async fn agents_connect(app: AppHandle, id: String) -> Result<Status, String> {
    let command = exe_path();
    refuse_temporary(&command)?;
    let proactive = app.state::<Settings>().get().agents_proactive;
    app.state::<Settings>().update(|s| s.agents_enabled = true);
    let result = tauri::async_runtime::spawn_blocking(move || {
        let ids: Vec<&'static str> = if id == "all" {
            apps::statuses(&command)
                .into_iter()
                .filter(|a| a.installed && (!a.connected || a.stale))
                .map(|a| a.id)
                .collect()
        } else {
            match apps::statuses(&command).into_iter().find(|a| a.id == id) {
                Some(a) => vec![a.id],
                None => return Err("Unknown app.".to_string()),
            }
        };
        let errors: Vec<String> = ids
            .into_iter()
            .filter_map(|id| apps::connect(id, &command, proactive).err())
            .collect();
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join(" "))
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    result.map(|_| status(&app))
}

#[tauri::command]
pub async fn agents_disconnect(app: AppHandle, id: String) -> Result<Status, String> {
    tauri::async_runtime::spawn_blocking(move || apps::disconnect(&id))
        .await
        .map_err(|e| e.to_string())??;
    Ok(status(&app))
}

/// Run `TodoCity --mcp` the way an AI app does and send a test task through it.
/// The app recognises the test and keeps nothing.
#[tauri::command]
pub async fn agents_test() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(self_test)
        .await
        .map_err(|e| e.to_string())?
}

fn self_test() -> Result<String, String> {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};

    let mut child = Command::new(exe_path())
        .arg("--mcp")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Couldn't start TodoCity's MCP server: {e}"))?;
    let messages = [
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
            "protocolVersion":"2025-06-18","capabilities":{},
            "clientInfo":{"name": mcp::SELF_TEST,"version":"1"}}}),
        serde_json::json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{
            "name":"add_task","arguments":{"title":"TodoCity connection test"}}}),
    ];
    if let Some(mut stdin) = child.stdin.take() {
        for m in &messages {
            writeln!(stdin, "{m}").map_err(|e| e.to_string())?;
        }
    }
    let stdout = child
        .stdout
        .take()
        .ok_or("No output from the MCP server.")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let lines: Vec<String> = BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
            .collect();
        let _ = tx.send(lines);
    });
    let lines = rx.recv_timeout(Duration::from_secs(10));
    let _ = child.kill();
    let _ = child.wait();
    let lines = lines.map_err(|_| "TodoCity's MCP server didn't answer in time.".to_string())?;
    let replies: Vec<serde_json::Value> = lines
        .iter()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect();
    let tools = replies
        .iter()
        .find(|r| r["id"] == 2)
        .and_then(|r| r["result"]["tools"].as_array().map(Vec::len))
        .unwrap_or(0);
    if tools == 0 {
        return Err("TodoCity's MCP server didn't list its tools.".into());
    }
    let call = replies
        .iter()
        .find(|r| r["id"] == 3)
        .ok_or("TodoCity's MCP server didn't answer the test task.")?;
    let text = call["result"]["content"][0]["text"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    if call["result"]["isError"] == false {
        Ok("Working — AI apps can send tasks to TodoCity.".into())
    } else {
        Err(text)
    }
}

/// A date the window resolved from an item's `date_text`.
#[derive(Debug, Clone, Deserialize)]
pub struct Schedule {
    pub due_date: Option<String>,
    pub due_time: Option<String>,
}

#[tauri::command]
pub fn inbox_list(agents: State<'_, Agents>) -> Vec<InboxItem> {
    agents.items()
}

/// Approve a task: it joins the task list, labelled with the agent.
#[tauri::command]
pub fn inbox_accept(
    app: AppHandle,
    id: u64,
    schedule: Option<Schedule>,
) -> Result<todocity_core::Task, String> {
    let item = app
        .state::<Agents>()
        .take(id)
        .ok_or("That task was already reviewed.")?;
    let _ = app.emit("inbox-changed", ());
    crate::tray::refresh(&app);
    crate::insert_task(
        &app,
        NewTask {
            title: item.title,
            // A date the app worked out from `date_text`, if any.
            due_date: item
                .due_date
                .or_else(|| schedule.as_ref().and_then(|s| s.due_date.clone())),
            due_time: item
                .due_time
                .or_else(|| schedule.as_ref().and_then(|s| s.due_time.clone())),
            notes: item.notes,
            source_app: Some(item.agent),
            ..Default::default()
        },
    )
}

#[tauri::command]
pub fn inbox_discard(app: AppHandle, id: u64) {
    if app.state::<Agents>().take(id).is_some() {
        let _ = app.emit("inbox-changed", ());
        crate::tray::refresh(&app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draft(title: &str) -> TaskDraft {
        TaskDraft {
            title: title.into(),
            ..Default::default()
        }
    }

    #[test]
    fn validates_and_tidies() {
        let d = validate(&TaskDraft {
            title: "  Send the\\ndeck\u{7}  ".replace("\\n", "\n"),
            due_date: Some("2026-10-23".into()),
            due_time: Some("9:05".into()),
            notes: Some(" line one\nline two \u{1b}[31m ".into()),
            date_text: None,
        })
        .unwrap();
        assert_eq!(d.title, "Send the deck");
        assert_eq!(d.due_time.as_deref(), Some("09:05"));
        assert_eq!(d.notes.as_deref(), Some("line one\nline two [31m"));
    }

    #[test]
    fn rejects_bad_input() {
        assert!(validate(&draft("   ")).is_err());
        assert!(validate(&draft(&"x".repeat(201))).is_err());
        let mut d = draft("x");
        d.due_date = Some("next friday".into());
        assert!(validate(&d).is_err());
        let mut d = draft("x");
        d.due_time = Some("15:00".into());
        assert!(validate(&d).unwrap_err().contains("due_date"));
        let mut d = draft("x");
        d.due_date = Some("2026-10-23".into());
        d.due_time = Some("3pm".into());
        assert!(validate(&d).is_err());
    }

    #[test]
    fn labels_agents() {
        assert_eq!(agent_label("claude-ai"), "Claude");
        assert_eq!(agent_label("claude-code"), "Claude Code");
        assert_eq!(agent_label("my_local-agent"), "My Local Agent");
        assert_eq!(agent_label("\u{7}"), "An AI agent");
    }

    #[test]
    fn repeats_are_dropped_quietly() {
        let dir = tempfile::tempdir().unwrap();
        let a = Agents::new(dir.path());
        assert!(a.receive("claude-code", draft("Send the deck")).unwrap());
        // Waiting already: same task with different spacing/case/punctuation.
        assert!(!a.receive("claude-code", draft("send  the DECK.")).unwrap());
        // A different date is a different task.
        let mut dated = draft("Send the deck");
        dated.due_date = Some("2026-10-23".into());
        assert!(a.receive("claude-code", dated).unwrap());
        // Reviewed (added or discarded): still blocked afterwards.
        let id = a.items()[0].id;
        a.take(id).unwrap();
        assert!(!a.receive("claude-code", draft("Send the deck")).unwrap());
        assert!(!Agents::new(dir.path())
            .receive("claude-code", draft("Send the deck"))
            .unwrap());
    }

    #[test]
    fn inbox_limits_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let a = Agents::new(dir.path());
        for i in 0..RATE_MAX {
            assert!(a.receive("claude-ai", draft(&format!("t{i}"))).unwrap());
        }
        assert!(a.receive("claude-ai", draft("one too many")).is_err());
        let b = Agents::new(dir.path());
        assert_eq!(b.items().len(), RATE_MAX);
        let first = b.items()[0].id;
        assert_eq!(b.take(first).unwrap().title, "t0");
        assert!(b.take(first).is_none());
        assert_eq!(Agents::new(dir.path()).items().len(), RATE_MAX - 1);
    }
}
