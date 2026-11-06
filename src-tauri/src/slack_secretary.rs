//! Slack Secretary on the Mac: the background task, and the app's side of
//! it. The rules are in `todocity_core::slack_secretary`.
//!
//! - [`run_background`] is `TodoCity --slack-secretary`, started by launchd
//!   every five minutes and at login, with or without the app. It asks the
//!   agent about the time since its last good run (catching up after the
//!   Mac was off), and appends what it finds to the queue file.
//! - The app ([`set`], [`ensure`], [`import`]) installs or removes the
//!   LaunchAgent, tells the task which agent to use, and adds the queue to
//!   the Inbox with the Slack connector's own rules (one task per message).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager};
use todocity_core::slack::{self as rules, Phase};
use todocity_core::slack_secretary::{self as sec, Config, QueueLine, RunState};

use crate::agents::apps;
use crate::slack::SlackService;

const LOG_NAME: &str = "slack-secretary.log";
/// The log is started fresh past this.
const LOG_MAX: u64 = 1024 * 1024;

fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn plist_path() -> PathBuf {
    home()
        .join("Library/LaunchAgents")
        .join(format!("{}.plist", sec::LABEL))
}

fn log_path() -> PathBuf {
    home().join("Library/Logs/TodoCity").join(LOG_NAME)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn read_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> T {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Write a file whole: a reader never sees half of it.
fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// The person's user id, for launchd's `gui/<uid>` domain.
#[cfg(unix)]
fn uid() -> Option<u32> {
    use std::os::unix::fs::MetadataExt;
    std::fs::metadata(home()).ok().map(|m| m.uid())
}
#[cfg(not(unix))]
fn uid() -> Option<u32> {
    None
}

fn launchctl(args: &[&str]) -> Result<String, String> {
    apps::run(
        Command::new("/bin/launchctl").args(args),
        Duration::from_secs(20),
    )
}

// ── The background task ───────────────────────────────────────────────────

struct Lock(PathBuf);

impl Drop for Lock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// One run at a time (a lock left by a run that died expires).
fn take_lock(dir: &Path) -> Option<Lock> {
    let path = dir.join(sec::LOCK_FILE);
    let fresh = |p: &Path| {
        std::fs::metadata(p)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| (age.as_millis() as i64) < sec::LOCK_STALE_MS)
    };
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut f) => {
            let _ = writeln!(f, "{}", std::process::id());
            Some(Lock(path))
        }
        Err(_) if fresh(&path) => None,
        Err(_) => {
            let _ = std::fs::remove_file(&path);
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&path)
                .ok()
                .map(|_| Lock(path))
        }
    }
}

fn append(dir: &Path, lines: &[QueueLine]) {
    if lines.is_empty() {
        return;
    }
    let text: String = lines.iter().map(QueueLine::to_line).collect();
    let opened = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(sec::QUEUE_FILE));
    match opened {
        Ok(mut f) => {
            if let Err(e) = f.write_all(text.as_bytes()) {
                say(&format!("couldn't add to the queue: {e}"));
            }
        }
        Err(e) => say(&format!("couldn't open the queue: {e}")),
    }
}

/// A line in the log (launchd sends stdout there).
fn say(text: &str) {
    println!(
        "{} {text}",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
    );
}

/// Whether the app is running (its agent socket answers).
fn app_running(dir: &Path) -> bool {
    #[cfg(unix)]
    {
        std::os::unix::net::UnixStream::connect(dir.join(crate::agents::SOCKET_NAME)).is_ok()
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        false
    }
}

/// A Mac notification from the background task (the app shows its own
/// when it's running). The text goes in as arguments, never as script.
fn notify(title: &str, body: &str) {
    let _ = apps::run(
        Command::new("/usr/bin/osascript").args([
            "-e",
            "on run argv",
            "-e",
            "display notification (item 2 of argv) with title (item 1 of argv)",
            "-e",
            "end run",
            title,
            body,
        ]),
        Duration::from_secs(10),
    );
}

/// `TodoCity --slack-secretary`: one check. Always exits 0 so launchd keeps
/// the schedule; problems go to the state file and the log.
pub fn run_background() -> i32 {
    let Some(dir) = crate::agents::mcp::data_dir() else {
        return 0;
    };
    // Keep the log small.
    if std::fs::metadata(log_path()).is_ok_and(|m| m.len() > LOG_MAX) {
        let _ = std::fs::write(log_path(), "");
    }
    let Some(_lock) = take_lock(&dir) else {
        say("a check is already running");
        return 0;
    };
    let config: Config = read_json(&dir.join(sec::CONFIG_FILE));
    if config.agent.is_empty() {
        say("Slack Secretary isn't set up: turn it on in TodoCity → Settings → Connectors → Slack");
        return 0;
    }
    let state_path = dir.join(sec::STATE_FILE);
    let mut state: RunState = read_json(&state_path);
    let now = now_ms();
    if !sec::should_run(&state, now) {
        return 0;
    }
    let plan = sec::plan(&state, &config, now);
    let name = crate::slack::agent_name(&config.agent);
    let mut lines: Vec<QueueLine> = Vec::new();
    let note = |kind: &str, text: String| QueueLine::Note {
        at_ms: now_ms(),
        kind: kind.into(),
        text,
    };
    if plan.gap_ms > 30 * 60_000 {
        lines.push(note(
            "working",
            format!(
                "Slack Secretary is catching up on {} it didn't check (the Mac was off or asleep)",
                sec::gap_text(plan.gap_ms)
            ),
        ));
    }
    if plan.skipped_ms > 0 {
        lines.push(note(
            "info",
            format!(
                "Messages older than a week ({} more) weren't looked at",
                sec::gap_text(plan.skipped_ms)
            ),
        ));
    }
    let mut found = 0;
    let mut last_title = String::new();
    for (since, until) in &plan.windows {
        let span = format!(
            "{}–{}",
            crate::slack::clock(*since),
            crate::slack::clock(*until)
        );
        say(&format!("looking at {span} with {name}"));
        match crate::slack::ask(
            &config.agent,
            &config.tools,
            *since,
            *until,
            rules::Reach::Everything,
        ) {
            Ok(scan) => {
                let fresh = sec::record_ok(&mut state, scan.items, scan.covered_until_ms, now_ms());
                say(&format!("{span}: {} new", fresh.len()));
                if fresh.is_empty() {
                    lines.push(note(
                        "ok",
                        format!("Slack Secretary looked at {span}: nothing new"),
                    ));
                }
                for item in fresh {
                    found += 1;
                    last_title = item.title.clone();
                    lines.push(QueueLine::Item {
                        at_ms: now_ms(),
                        item,
                    });
                }
                // Hand over each window's finds as they come.
                append(&dir, &lines);
                lines.clear();
                let _ = write_json(&state_path, &state);
            }
            Err(e) => {
                say(&format!("{span}: {e}"));
                sec::record_err(&mut state, &e);
                lines.push(note(
                    "error",
                    format!("{e} Slack Secretary tries again on its own."),
                ));
                break;
            }
        }
    }
    state.last_run_ms = now;
    append(&dir, &lines);
    if let Err(e) = write_json(&state_path, &state) {
        say(&format!("couldn't save where it's up to: {e}"));
    }
    if found > 0 && !app_running(&dir) {
        let body = if found == 1 {
            last_title
        } else {
            format!(
                "{found} Slack messages need you. They're in your Inbox when you open TodoCity."
            )
        };
        notify("From Slack", &body);
    }
    0
}

// ── The app's side ────────────────────────────────────────────────────────

/// How Slack Secretary is doing, for the Slack card.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SecretaryView {
    pub on: bool,
    /// Its LaunchAgent is in place.
    pub installed: bool,
    /// Local `YYYY-MM-DDTHH:MM:SS`.
    pub last_checked: Option<String>,
    /// "9 h 20 min" while it's catching up.
    pub behind: Option<String>,
    pub last_error: Option<String>,
    pub found: u64,
}

fn local_text(ms: i64) -> Option<String> {
    use chrono::TimeZone;
    match chrono::Local.timestamp_millis_opt(ms) {
        chrono::LocalResult::Single(t) | chrono::LocalResult::Ambiguous(t, _) => {
            Some(t.format("%Y-%m-%dT%H:%M:%S").to_string())
        }
        chrono::LocalResult::None => None,
    }
}

fn data_dir(app: &AppHandle) -> PathBuf {
    app.state::<crate::AppState>().data_dir.clone()
}

pub fn view(app: &AppHandle, on: bool) -> SecretaryView {
    let state: RunState = read_json(&data_dir(app).join(sec::STATE_FILE));
    SecretaryView {
        on,
        installed: plist_path().is_file(),
        last_checked: (state.last_ok_ms > 0)
            .then(|| local_text(state.last_ok_ms))
            .flatten(),
        behind: (state.behind_ms > 0).then(|| sec::gap_text(state.behind_ms)),
        last_error: state.last_error,
        found: state.found,
    }
}

/// Install (or refresh) the LaunchAgent for this copy of TodoCity, and tell
/// the background task which agent and tools to use.
fn install(app: &AppHandle) -> Result<(), String> {
    let s = app.state::<SlackService>().get();
    let agent = s.agent.clone().filter(|_| s.phase == Phase::Ready).ok_or(
        "Connect Slack first (Settings → Connectors → Slack), then turn on Slack Secretary.",
    )?;
    let dir = data_dir(app);
    let config = Config {
        agent,
        tools: s.tools.clone(),
        start_ms: s.cursor_ms,
    };
    write_json(&dir.join(sec::CONFIG_FILE), &config)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy().to_string();
    crate::agents::refuse_temporary(&exe)?;
    let shell = std::env::var("SHELL")
        .ok()
        .filter(|s| s.starts_with('/'))
        .unwrap_or_else(|| "/bin/zsh".into());
    let home = home();
    let _ = std::fs::create_dir_all(log_path().parent().unwrap_or(home.as_path()));
    let plist = sec::launch_agent_plist(
        &exe,
        &shell,
        &home.to_string_lossy(),
        &log_path().to_string_lossy(),
    );
    let path = plist_path();
    let _ = std::fs::create_dir_all(path.parent().unwrap_or(home.as_path()));
    let same = std::fs::read_to_string(&path).is_ok_and(|old| old == plist);
    let uid = uid().ok_or("TodoCity couldn't find your Mac user to set up the background task.")?;
    let domain = format!("gui/{uid}");
    let target = format!("{domain}/{}", sec::LABEL);
    let loaded = launchctl(&["print", &target]).is_ok();
    if same && loaded {
        return Ok(());
    }
    std::fs::write(&path, plist)
        .map_err(|e| format!("TodoCity couldn't save the background task: {e}"))?;
    let _ = launchctl(&["bootout", &target]);
    launchctl(&["bootstrap", &domain, &path.to_string_lossy()]).map_err(|e| {
        format!(
            "macOS didn't start the background task ({}). Check System Settings → General → Login Items that TodoCity is allowed in the background, then turn Slack Secretary on again.",
            e.lines().last().unwrap_or_default().trim()
        )
    })?;
    log::info!("slack secretary: background task installed");
    Ok(())
}

/// Remove the LaunchAgent (Slack Secretary off, or Slack off).
pub fn uninstall() {
    if let Some(uid) = uid() {
        let _ = launchctl(&["bootout", &format!("gui/{uid}/{}", sec::LABEL)]);
    }
    let _ = std::fs::remove_file(plist_path());
}

/// Turn Slack Secretary on or off (the switch in the Slack card, or the
/// offer after Slack connects).
#[tauri::command]
pub async fn slack_secretary_set(app: AppHandle, on: bool) -> Result<SecretaryView, String> {
    let app2 = app.clone();
    tauri::async_runtime::spawn_blocking(move || set(&app2, on))
        .await
        .map_err(|e| e.to_string())??;
    crate::slack::changed(&app);
    Ok(view(&app, on))
}

fn set(app: &AppHandle, on: bool) -> Result<(), String> {
    let service = app.state::<SlackService>();
    let agent = service.get().agent.clone();
    if on {
        install(app)?;
        service.update(|s| s.secretary = true);
        crate::activity::log(
            app,
            "slack",
            agent.as_deref(),
            "ok",
            "Slack Secretary is on: a background task checks Slack every 5 minutes, even when TodoCity is closed",
        );
    } else {
        uninstall();
        // The app checks again, from wherever the background task got to.
        let dir = data_dir(app);
        let state: RunState = read_json(&dir.join(sec::STATE_FILE));
        let now = now_ms();
        service.update(|s| {
            s.secretary = false;
            s.cursor_ms = s.cursor_ms.max(state.cursor_ms);
            for key in &state.seen {
                s.remember(key, now);
            }
        });
        crate::activity::log(
            app,
            "slack",
            agent.as_deref(),
            "info",
            "Slack Secretary is off: TodoCity checks Slack while it's open",
        );
    }
    Ok(())
}

/// At launch: keep the background task pointing at this copy of TodoCity
/// (it may have moved or updated) when Slack Secretary is on.
pub fn ensure(app: &AppHandle) {
    let s = app.state::<SlackService>().get();
    if !s.secretary {
        return;
    }
    if let Err(e) = install(app) {
        log::warn!("slack secretary: {e}");
        crate::activity::log(app, "slack", s.agent.as_deref(), "error", e);
    }
}

/// Add what the background task found to the Inbox (on every tick of the
/// Slack worker: within seconds while TodoCity is open, or at next launch).
pub fn import(app: &AppHandle) {
    let dir = data_dir(app);
    let queue = dir.join(sec::QUEUE_FILE);
    if !queue.is_file() {
        return;
    }
    // Take the file first, so the background task starts a new one.
    let taken = dir.join(format!("{}.importing", sec::QUEUE_FILE));
    if std::fs::rename(&queue, &taken).is_err() {
        return;
    }
    let text = std::fs::read_to_string(&taken).unwrap_or_default();
    let lines = sec::read_queue(&text);
    let agent = app.state::<SlackService>().get().agent;
    let mut items = Vec::new();
    for line in lines {
        match line {
            QueueLine::Item { item, .. } => items.push(item),
            QueueLine::Note { kind, text, .. } => {
                let kind: &'static str = match kind.as_str() {
                    "working" => "working",
                    "ok" => "ok",
                    "error" => "error",
                    _ => "info",
                };
                crate::activity::log(app, "slack", agent.as_deref(), kind, text);
            }
        }
    }
    let added = crate::slack::add_items(app, &items);
    for title in &added {
        crate::activity::log(
            app,
            "slack",
            agent.as_deref(),
            "added",
            format!("Slack Secretary added to your Inbox: {title}"),
        );
    }
    let _ = std::fs::remove_file(&taken);
    if !added.is_empty() {
        let body = match added.as_slice() {
            [one] => one.clone(),
            many => format!("{} new tasks in your Inbox", many.len()),
        };
        crate::notifications::send_plain(app, "slack-added", "From Slack".into(), body);
        crate::slack::changed(app);
    }
}
