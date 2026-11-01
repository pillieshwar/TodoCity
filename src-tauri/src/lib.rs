//! TodoCity desktop shell: tray icon, global shortcut, docked task panel.
//!
//! Lifecycle of one capture:
//!   shortcut released → pre-warm the bundled model runtime and capture the
//!   selection (worker thread, before the panel takes focus) → emit `capture`
//!   to the panel and show it → the panel calls `extract` (one localhost
//!   request) → user confirms the date → `add_task` (one SQLite write).
//!   The runtime stops itself after a few idle minutes.

mod agent_panel;
mod agents;
mod app_icons;
mod calendar;
mod calsync;
mod capture;
mod data;
mod double_copy;
mod engine;
mod greet;
mod import;
mod login_item;
mod mirror;
mod models;
mod notifications;
mod panel;
mod popover;
mod pty;
mod quick;
mod reminders;
#[cfg(target_os = "macos")]
mod services;
mod settings;
mod shortcuts;
mod slack_cleanup;
mod spaces;
mod sync;
mod tray;
mod updates;
mod watch;
mod watch_agent;

use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::ShortcutState;
use todocity_core::{Extraction, NewTask, Store, Task, TaskPatch};

use crate::capture::{CaptureMethod, CaptureResult};
use crate::engine::Engine;
use crate::models::{CustomModel, LocalModels, ModelManager, ModelView};
use crate::settings::{AppSettings, Settings};
use crate::shortcuts::{Action, ShortcutSettings, ShortcutSpec, Shortcuts};
use crate::updates::{UpdateStatus, Updates};

pub struct AppState {
    store: Mutex<Store>,
    data_dir: std::path::PathBuf,
}

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
async fn extract(
    engine: State<'_, Engine>,
    models: State<'_, ModelManager>,
    selection: String,
) -> CmdResult<Extraction> {
    let path = match models.active() {
        Some(m) => m.path,
        None if engine.kind() == "ollama" => Default::default(),
        None => return Err("No model downloaded yet. Open the Models tab to get one.".into()),
    };
    engine.extract(&path, &selection).await
}

#[tauri::command]
fn list_tasks(state: State<'_, AppState>, done_since: Option<String>) -> CmdResult<Vec<Task>> {
    state
        .store
        .lock()
        .map_err(err)?
        .list(done_since.as_deref())
        .map_err(err)
}

#[tauri::command]
fn add_task(app: AppHandle, task: NewTask, keep_place: Option<bool>) -> CmdResult<Task> {
    if keep_place == Some(true) {
        // The person chose where it goes (Inbox included): leave it there.
        return insert_task_as_is(&app, task);
    }
    insert_task(&app, task)
}

/// Add a task and update everything that shows tasks.
pub(crate) fn insert_task(app: &AppHandle, task: NewTask) -> CmdResult<Task> {
    let mut task = NewTask {
        created_tz: iana_time_zone::get_timezone().ok(),
        ..task
    };
    // In a mode, a task added with no project goes where the mode says.
    if task.project.is_none() {
        task.project = active_mode(app).and_then(|m| m.new_task_project);
    }
    insert_task_as_is(app, task)
}

/// Add a task exactly where it says (no mode default) and update everything.
fn insert_task_as_is(app: &AppHandle, task: NewTask) -> CmdResult<Task> {
    let task = NewTask {
        created_tz: task
            .created_tz
            .or_else(|| iana_time_zone::get_timezone().ok()),
        ..task
    };
    let state = app.state::<AppState>();
    let t = state.store.lock().map_err(err)?.insert(task).map_err(err)?;
    let _ = app.emit("tasks-changed", ());
    tray::refresh(app);
    nudge_reminders(app);
    Ok(t)
}

/// The mode this Mac is in (Work, Personal…), if any.
pub(crate) fn active_mode(app: &AppHandle) -> Option<todocity_core::modes::ViewMode> {
    let s = app.try_state::<Settings>()?.get();
    todocity_core::modes::active(&s.modes, s.mode.as_deref()).cloned()
}

/// Switch this Mac's mode (none: show everything).
#[tauri::command]
fn set_view_mode(app: AppHandle, settings: State<'_, Settings>, id: Option<String>) -> AppSettings {
    let next = settings.update(|v| {
        v.mode = id.filter(|id| v.modes.iter().any(|m| &m.id == id));
    });
    let _ = app.emit("settings-changed", &next);
    // A mode can hide calendars: everything showing events looks again.
    let _ = app.emit("calendar-changed", ());
    tray::refresh(&app);
    next
}

/// Every completed task, briefly: the lit windows of the city.
#[tauri::command]
fn city_windows(state: State<'_, AppState>) -> CmdResult<Vec<todocity_core::CityWindow>> {
    state
        .store
        .lock()
        .map_err(err)?
        .city_windows(20_000)
        .map_err(err)
}

/// Completed tasks, newest first, a page at a time.
#[tauri::command]
fn logbook(
    state: State<'_, AppState>,
    before: Option<String>,
    limit: Option<u32>,
) -> CmdResult<Vec<Task>> {
    state
        .store
        .lock()
        .map_err(err)?
        .logbook(before.as_deref(), limit.unwrap_or(100))
        .map_err(err)
}

#[tauri::command]
fn list_projects(state: State<'_, AppState>) -> CmdResult<Vec<todocity_core::ProjectSummary>> {
    state.store.lock().map_err(err)?.projects().map_err(err)
}

/// Every project's headings: the floors of each building.
#[tauri::command]
fn list_floors(state: State<'_, AppState>) -> CmdResult<Vec<todocity_core::FloorSummary>> {
    state.store.lock().map_err(err)?.floors().map_err(err)
}

/// Start an empty project (a building).
#[tauri::command]
fn create_project(app: AppHandle, name: String) -> CmdResult<Option<String>> {
    let made = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(err)?;
        store.create_project(&name).map_err(err)?
    };
    let _ = app.emit("tasks-changed", ());
    Ok(made)
}

/// Add a heading (a floor) to a project.
#[tauri::command]
fn add_floor(app: AppHandle, project: String, name: String) -> CmdResult<Option<String>> {
    let made = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(err)?;
        store.add_floor(&project, &name).map_err(err)?
    };
    let _ = app.emit("tasks-changed", ());
    Ok(made)
}

/// Give a project its own color (`#rrggbb`), or clear it.
#[tauri::command]
fn set_project_color(app: AppHandle, name: String, color: Option<String>) -> CmdResult<()> {
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(err)?;
        store
            .set_project_color(&name, color.as_deref())
            .map_err(err)?;
    }
    let _ = app.emit("tasks-changed", ());
    Ok(())
}

/// Every task in a project, done ones too.
#[tauri::command]
fn project_tasks(state: State<'_, AppState>, project: String) -> CmdResult<Vec<Task>> {
    state
        .store
        .lock()
        .map_err(err)?
        .project_tasks(&project)
        .map_err(err)
}

/// Take down an empty building; false while it still has homes.
#[tauri::command]
fn delete_project(app: AppHandle, name: String) -> CmdResult<bool> {
    let gone = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(err)?;
        store.delete_project(&name).map_err(err)?
    };
    let _ = app.emit("tasks-changed", ());
    Ok(gone)
}

/// Take down an empty floor; false while it still has homes.
#[tauri::command]
fn delete_floor(app: AppHandle, project: String, name: String) -> CmdResult<bool> {
    let gone = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(err)?;
        store.delete_floor(&project, &name).map_err(err)?
    };
    let _ = app.emit("tasks-changed", ());
    Ok(gone)
}

#[tauri::command]
fn rename_floor(app: AppHandle, project: String, from: String, to: String) -> CmdResult<usize> {
    let n = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(err)?;
        store.rename_floor(&project, &from, &to).map_err(err)?
    };
    let _ = app.emit("tasks-changed", ());
    Ok(n)
}

#[tauri::command]
fn rename_project(app: AppHandle, from: String, to: String) -> CmdResult<usize> {
    let n = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(err)?;
        store.rename_project(&from, &to).map_err(err)?
    };
    let _ = app.emit("tasks-changed", ());
    Ok(n)
}

/// Skip one occurrence of a repeating task.
#[tauri::command]
fn skip_occurrence(app: AppHandle, id: i64) -> CmdResult<Task> {
    let task = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(err)?;
        store.skip(id).map_err(err)?
    };
    notifications::clear_task(id);
    let _ = app.emit("tasks-changed", ());
    tray::refresh(&app);
    nudge_reminders(&app);
    Ok(task)
}

#[tauri::command]
fn update_task(app: AppHandle, id: i64, patch: TaskPatch) -> CmdResult<Task> {
    apply_patch(&app, id, patch)
}

/// Update a task and everything that depends on it: a repeating task's next
/// occurrence, its reminder, its notification, the menu bar and windows.
pub(crate) fn apply_patch(app: &AppHandle, id: i64, patch: TaskPatch) -> CmdResult<Task> {
    let state = app.state::<AppState>();
    let completing = patch.done == Some(true);
    let (task, removed_link) = {
        let store = state.store.lock().map_err(err)?;
        // If un-completing removes the next occurrence, its reminder goes too.
        let next_link = store
            .get(id)
            .ok()
            .and_then(|t| t.next_id)
            .and_then(|n| store.reminder_link(n).ok().flatten());
        let (task, effects) = store.update_with_effects(id, patch).map_err(err)?;
        (task, effects.removed.and(next_link))
    };
    if let (Some(link), Some(r)) = (removed_link, app.try_state::<reminders::Reminders>()) {
        r.deleted(link.reminder_id);
    }
    if completing {
        notifications::clear_task(id);
    }
    let _ = app.emit("tasks-changed", ());
    tray::refresh(app);
    nudge_reminders(app);
    Ok(task)
}

/// Open a link from a task's description in the default browser or app.
#[tauri::command]
fn open_url(url: String) -> CmdResult<()> {
    let lower = url.to_ascii_lowercase();
    let ok = (lower.starts_with("https://")
        || lower.starts_with("http://")
        || lower.starts_with("mailto:"))
        && !url.chars().any(char::is_whitespace)
        && url.len() <= 2048;
    if !ok {
        return Err("Only web and email links can be opened.".into());
    }
    open_target(&OpenTarget::Url(url))
}

/// Open the page or app a task was captured from.
#[tauri::command]
fn open_source(state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let task = state.store.lock().map_err(err)?.get(id).map_err(err)?;
    let target = source_target(&task).ok_or("This task doesn't remember where it came from.")?;
    open_target(&target)
}

#[derive(Debug, PartialEq, Eq)]
enum OpenTarget {
    Url(String),
    App(String),
}

/// Slack's web client links reopen in the Slack app.
fn slack_deep_link(url: &str) -> Option<String> {
    let rest = url.strip_prefix("https://app.slack.com/client/")?;
    let mut parts = rest.split(['/', '?', '#']);
    let team = parts.next().filter(|t| t.starts_with('T'))?;
    let channel = parts.next().filter(|c| c.starts_with(['C', 'D', 'G']))?;
    let ok = |s: &str| s.chars().all(|c| c.is_ascii_alphanumeric());
    (ok(team) && ok(channel)).then(|| format!("slack://channel?team={team}&id={channel}"))
}

fn source_target(task: &Task) -> Option<OpenTarget> {
    if let Some(url) = task.source_url.as_deref() {
        let lower = url.to_ascii_lowercase();
        if lower.starts_with("https://")
            || lower.starts_with("http://")
            || lower.starts_with("file://")
        {
            if task.source_bundle.as_deref() == Some("com.tinyspeck.slackmacgap") {
                if let Some(deep) = slack_deep_link(url) {
                    return Some(OpenTarget::Url(deep));
                }
            }
            return Some(OpenTarget::Url(url.to_string()));
        }
    }
    let bundle = task.source_bundle.as_deref()?;
    let ok = !bundle.is_empty()
        && bundle
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_');
    ok.then(|| OpenTarget::App(bundle.to_string()))
}

fn open_target(target: &OpenTarget) -> CmdResult<()> {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        match target {
            OpenTarget::Url(u) => c.arg(u),
            OpenTarget::App(b) => c.arg("-b").arg(b),
        };
        c
    } else if cfg!(windows) {
        let OpenTarget::Url(u) = target else {
            return Err("Opening apps is only supported on macOS.".into());
        };
        let mut c = std::process::Command::new("explorer");
        c.arg(u);
        c
    } else {
        let OpenTarget::Url(u) = target else {
            return Err("Opening apps is only supported on macOS.".into());
        };
        let mut c = std::process::Command::new("xdg-open");
        c.arg(u);
        c
    };
    cmd.spawn().map(|_| ()).map_err(err)
}

#[tauri::command]
fn delete_task(app: AppHandle, state: State<'_, AppState>, id: i64) -> CmdResult<()> {
    let link = {
        let store = state.store.lock().map_err(err)?;
        let link = store.reminder_link(id).ok().flatten();
        store.delete(id).map_err(err)?;
        link
    };
    if let (Some(link), Some(r)) = (link, app.try_state::<reminders::Reminders>()) {
        r.deleted(link.reminder_id);
    }
    notifications::clear_task(id);
    let _ = app.emit("tasks-changed", ());
    tray::refresh(&app);
    Ok(())
}

/// Put back a task deleted moments ago (Undo). It comes back as a new task
/// with the same details.
#[tauri::command]
fn restore_task(app: AppHandle, state: State<'_, AppState>, task: Task) -> CmdResult<Task> {
    let restored = {
        let store = state.store.lock().map_err(err)?;
        let t = store
            .insert(NewTask {
                title: task.title.clone(),
                due_date: task.due_date.clone(),
                due_time: task.due_time.clone(),
                recurrence: task.recurrence.clone(),
                source_text: task.source_text.clone(),
                source_app: task.source_app.clone(),
                source_bundle: task.source_bundle.clone(),
                source_url: task.source_url.clone(),
                notes: task.notes.clone(),
                created_tz: task.created_tz.clone(),
                deadline: task.deadline.clone(),
                evening: task.evening,
                someday: task.someday,
                project: task.project.clone(),
                heading: task.heading.clone(),
                checklist: task.checklist.clone(),
                priority: task.priority,
                duration: task.duration,
            })
            .map_err(err)?;
        if task.done {
            store
                .update(
                    t.id,
                    TaskPatch {
                        done: Some(true),
                        ..Default::default()
                    },
                )
                .map_err(err)?
        } else {
            t
        }
    };
    let _ = app.emit("tasks-changed", ());
    tray::refresh(&app);
    nudge_reminders(&app);
    Ok(restored)
}

fn nudge_reminders(app: &AppHandle) {
    if let Some(r) = app.try_state::<reminders::Reminders>() {
        r.nudge();
    }
}

// ── Apple Reminders ─────────────────────────────────────────────────────────

fn linked_count(state: &State<'_, AppState>) -> usize {
    state
        .store
        .lock()
        .ok()
        .and_then(|s| s.reminder_links().ok())
        .map(|l| l.iter().filter(|l| !l.detached).count())
        .unwrap_or(0)
}

#[tauri::command]
fn reminders_status(
    state: State<'_, AppState>,
    r: State<'_, reminders::Reminders>,
) -> reminders::Status {
    r.status(linked_count(&state))
}

/// Blocking (waits for the user to answer the macOS prompt), so async.
#[tauri::command]
async fn reminders_request_access(
    r: State<'_, reminders::Reminders>,
) -> CmdResult<reminders::Access> {
    r.request_access()
}

#[tauri::command]
async fn reminders_lists(
    r: State<'_, reminders::Reminders>,
) -> CmdResult<Vec<reminders::ListInfo>> {
    r.lists()
}

#[tauri::command]
async fn reminders_enable(
    r: State<'_, reminders::Reminders>,
    request: reminders::EnableRequest,
) -> CmdResult<()> {
    r.enable(request)
}

#[tauri::command]
async fn reminders_disable(r: State<'_, reminders::Reminders>) -> CmdResult<()> {
    r.disable()
}

#[tauri::command]
fn reminders_sync_now(r: State<'_, reminders::Reminders>) {
    r.nudge();
}

/// System Settings → Privacy & Security → Reminders.
#[tauri::command]
fn reminders_open_privacy_settings() -> CmdResult<()> {
    if !cfg!(target_os = "macos") {
        return Err("Only available on macOS.".into());
    }
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Reminders")
        .spawn()
        .map(|_| ())
        .map_err(err)
}

// ── todocity:// links ─────────────────────────────────────────────────────────

/// A `todocity://…` link opened by macOS. None are handled today (the Slack
/// sign-in that used them is gone); the scheme stays registered.
fn on_deep_link(_app: &AppHandle, url: &url::Url) {
    if url.scheme() == "todocity" {
        log::info!(
            "ignored todocity:// link ({:?}{})",
            url.host_str(),
            url.path()
        );
    }
}

// ── Calendar connector ──────────────────────────────────────────────────────

fn calendar_state(s: &AppSettings) -> calendar::Status {
    calendar::Status {
        supported: cfg!(target_os = "macos"),
        access: calendar::access(),
        enabled: s.calendar_enabled,
        hidden: s.calendar_hidden.clone(),
    }
}

/// 0.4.9 remembered the calendars to show by id, but macOS can change a
/// subscribed calendar's id (Holidays, for one) after a sync, which silently
/// hid it. Convert that once into calendars to hide, by name.
fn migrate_calendar_ids(settings: &Settings) {
    let Some(ids) = settings.get().calendar_ids else {
        return;
    };
    if calendar::access() != reminders::Access::Full {
        return;
    }
    let Ok(all) = calendar::calendars() else {
        return;
    };
    if all.is_empty() {
        return;
    }
    let hidden: Vec<String> = all
        .into_iter()
        .filter(|c| !ids.contains(&c.id))
        .map(|c| c.key)
        .collect();
    settings.update(|s| {
        s.calendar_hidden = hidden;
        s.calendar_ids = None;
    });
}

#[tauri::command]
async fn calendar_status(app: AppHandle) -> CmdResult<calendar::Status> {
    tauri::async_runtime::spawn_blocking(move || {
        let settings = app.state::<Settings>();
        migrate_calendar_ids(&settings);
        calendar_state(&settings.get())
    })
    .await
    .map_err(err)
}

/// Blocking (waits for the user to answer the macOS prompt), so async.
#[tauri::command]
async fn calendar_request_access() -> CmdResult<reminders::Access> {
    tauri::async_runtime::spawn_blocking(calendar::request_access)
        .await
        .map_err(err)?
}

#[tauri::command]
async fn calendar_calendars() -> CmdResult<Vec<calendar::CalendarInfo>> {
    tauri::async_runtime::spawn_blocking(calendar::calendars)
        .await
        .map_err(err)?
}

/// Turn the connector on or off, and choose calendars to hide (by key).
#[tauri::command]
fn calendar_set(
    app: AppHandle,
    settings: State<'_, Settings>,
    enabled: bool,
    hidden: Vec<String>,
) -> calendar::Status {
    let s = settings.update(|s| {
        s.calendar_enabled = enabled;
        s.calendar_hidden = hidden;
        s.calendar_ids = None;
    });
    let _ = app.emit("calendar-changed", ());
    calendar_state(&s)
}

/// Events for the days `from..=to`; empty when the connector is off.
#[tauri::command]
async fn calendar_events(
    settings: State<'_, Settings>,
    from: String,
    to: String,
) -> CmdResult<Vec<calendar::EventInfo>> {
    let s = settings.get();
    if !s.calendar_enabled {
        return Ok(Vec::new());
    }
    // A mode can hide more calendars (e.g. personal ones in Work).
    let mut hidden = s.calendar_hidden.clone();
    if let Some(m) = todocity_core::modes::active(&s.modes, s.mode.as_deref()) {
        hidden.extend(m.hidden_calendars.iter().cloned());
    }
    tauri::async_runtime::spawn_blocking(move || calendar::events(&from, &to, &hidden))
        .await
        .map_err(err)?
}

/// Move a meeting in Calendar (dragged in TodoCity's Calendar). Only events
/// `meeting_move::movable` allows; meetings with guests need `everyone`.
#[tauri::command]
async fn calendar_move_event(
    settings: State<'_, Settings>,
    id: String,
    at: String,
    start: String,
    end: String,
    everyone: bool,
) -> CmdResult<calendar::EventInfo> {
    if !settings.get().calendar_enabled {
        return Err("Turn on Calendar in Settings → Connectors first.".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        calendar::move_event(&id, &at, &start, &end, everyone)
    })
    .await
    .map_err(err)?
}

/// System Settings → Privacy & Security → Calendars.
#[tauri::command]
fn calendar_open_privacy_settings() -> CmdResult<()> {
    if !cfg!(target_os = "macos") {
        return Err("Only available on macOS.".into());
    }
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_Calendars")
        .spawn()
        .map(|_| ())
        .map_err(err)
}

#[tauri::command]
fn reminders_set_include_notes(r: State<'_, reminders::Reminders>, include: bool) {
    r.set_include_notes(include);
}

#[derive(Serialize)]
struct Status {
    accessibility: bool,
    /// "bundled" (default) or "ollama" (developer override).
    engine: &'static str,
    /// Name of the model captures will use, if one is installed.
    active_model: Option<String>,
    version: &'static str,
    platform: &'static str,
}

#[tauri::command]
fn status(engine: State<'_, Engine>, models: State<'_, ModelManager>) -> Status {
    Status {
        accessibility: capture::accessibility_trusted(false),
        engine: engine.kind(),
        active_model: models.active().map(|m| m.name),
        version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
    }
}

// ── Preferences ─────────────────────────────────────────────────────────────

#[tauri::command]
fn get_settings(settings: State<'_, Settings>) -> AppSettings {
    settings.get()
}

/// Save the user-editable preferences; bookkeeping fields are kept.
#[tauri::command]
fn set_settings(app: AppHandle, settings: State<'_, Settings>, value: AppSettings) -> AppSettings {
    let theme = match value.theme.as_str() {
        "light" | "dark" => value.theme.clone(),
        _ => "system".to_string(),
    };
    let undated_time = if chrono::NaiveTime::parse_from_str(&value.undated_time, "%H:%M").is_ok() {
        value.undated_time.clone()
    } else {
        "16:00".to_string()
    };
    let next = settings.update(|v| {
        v.notify = value.notify;
        v.auto_update = value.auto_update;
        v.remember_source = value.remember_source;
        v.onboarding_done = value.onboarding_done;
        v.seen_version = value.seen_version;
        v.show_on_start = value.show_on_start;
        v.capture_in_menu_bar = value.capture_in_menu_bar;
        v.theme = theme;
        v.undated_nudge = value.undated_nudge;
        v.undated_time = undated_time;
        v.due_spotlight = value.due_spotlight;
        v.double_copy = value.double_copy;
        v.city_name = clean_city_name(value.city_name.as_deref());
        v.city_corner = value.city_corner;
        v.mayor_name = clean_city_name(value.mayor_name.as_deref());
        // Milestones are kept for good: these only go up.
        v.city_peak = v.city_peak.max(value.city_peak);
        v.city_seen = v.city_seen.max(value.city_seen);
        v.look = value.look.clean();
        v.modes = todocity_core::modes::clean(value.modes);
        v.mode = value.mode.filter(|id| v.modes.iter().any(|m| &m.id == id));
        v.open_full = value.open_full;
        v.app_keys = todocity_core::app_keys::clean(value.app_keys);
    });
    tray::refresh(&app);
    let _ = app.emit("calendar-changed", ());
    // Every window follows the theme (and other preferences) right away.
    let _ = app.emit("settings-changed", &next);
    next
}

#[tauri::command]
async fn notification_permission() -> notifications::Permission {
    tauri::async_runtime::spawn_blocking(notifications::permission)
        .await
        .unwrap_or(notifications::Permission::NotDetermined)
}

#[tauri::command]
async fn request_notification_permission() -> notifications::Permission {
    tauri::async_runtime::spawn_blocking(notifications::request_permission)
        .await
        .unwrap_or(notifications::Permission::NotDetermined)
}

#[tauri::command]
fn test_notification(app: AppHandle) {
    notifications::send_test(&app);
}

/// System Settings → Notifications.
#[tauri::command]
fn open_notification_settings() -> CmdResult<()> {
    if !cfg!(target_os = "macos") {
        return Err("Only available on macOS.".into());
    }
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.notifications")
        .spawn()
        .map(|_| ())
        .map_err(err)
}

#[tauri::command]
fn autostart_enabled(app: AppHandle) -> bool {
    if login_item::available() {
        return login_item::enabled();
    }
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> CmdResult<bool> {
    if login_item::available() {
        login_item::set(enabled)?;
        return Ok(login_item::enabled());
    }
    let al = app.autolaunch();
    if enabled {
        al.enable().map_err(err)?;
        associate_login_item(&app);
    } else {
        al.disable().map_err(err)?;
    }
    Ok(al.is_enabled().unwrap_or(enabled))
}

#[tauri::command]
fn update_status(updates: State<'_, Updates>) -> UpdateStatus {
    updates.status()
}

#[tauri::command]
async fn check_for_updates(app: AppHandle) -> UpdateStatus {
    updates::check(app.clone()).await;
    app.state::<Updates>().status()
}

#[tauri::command]
fn install_update(app: AppHandle) -> CmdResult<()> {
    updates::install_and_restart(&app)
}

// ── Backups and export ──────────────────────────────────────────────────────

#[tauri::command]
fn list_backups(state: State<'_, AppState>) -> Vec<data::BackupInfo> {
    data::list(&state.data_dir)
}

#[tauri::command]
fn backup_now(state: State<'_, AppState>) -> CmdResult<Vec<data::BackupInfo>> {
    let store = state.store.lock().map_err(err)?;
    let path = data::backup_dir(&state.data_dir).join(format!(
        "tasks-{}-manual.db",
        chrono::Local::now().format("%Y-%m-%d-%H%M%S")
    ));
    std::fs::create_dir_all(data::backup_dir(&state.data_dir)).map_err(err)?;
    store.backup_to(&path).map_err(err)?;
    Ok(data::list(&state.data_dir))
}

/// Replace the task list with a backup. The current list is saved first.
#[tauri::command]
fn restore_backup(app: AppHandle, state: State<'_, AppState>, name: String) -> CmdResult<()> {
    let source = data::backup_path(&state.data_dir, &name)?;
    let db = state.data_dir.join("tasks.db");
    let staged = state.data_dir.join("tasks.db.restoring");
    let _ = std::fs::remove_file(&staged);
    std::fs::copy(&source, &staged).map_err(err)?;
    // Make sure it opens (and is migrated) before touching the live file.
    drop(Store::open(&staged).map_err(|e| format!("That backup can't be read: {e}"))?);
    {
        let mut store = state.store.lock().map_err(err)?;
        data::safety_copy(&store, &state.data_dir, "restore")?;
        // Close the live database before swapping files.
        *store = Store::open_in_memory().map_err(err)?;
        for ext in ["-wal", "-shm"] {
            let _ = std::fs::remove_file(format!("{}{ext}", db.display()));
        }
        std::fs::rename(&staged, &db).map_err(err)?;
        *store = open_store(&db);
    }
    log::info!("restored tasks from {name}");
    sync::after_restore(&app);
    let _ = app.emit("tasks-changed", ());
    tray::refresh(&app);
    nudge_reminders(&app);
    Ok(())
}

#[tauri::command]
fn reveal_backups(state: State<'_, AppState>) -> CmdResult<()> {
    let dir = data::backup_dir(&state.data_dir);
    std::fs::create_dir_all(&dir).map_err(err)?;
    reveal(&dir, false)
}

/// Open TodoCity's data folder in Finder: tasks.db, backups, models and settings.
#[tauri::command]
fn reveal_data_folder(state: State<'_, AppState>) -> CmdResult<()> {
    std::fs::create_dir_all(&state.data_dir).map_err(err)?;
    reveal(&state.data_dir, false)
}

/// Save every task to Downloads as CSV or JSON and show it.
#[tauri::command]
fn export_tasks(state: State<'_, AppState>, format: String) -> CmdResult<String> {
    let tasks = state.store.lock().map_err(err)?.all().map_err(err)?;
    let (ext, body) = match format.as_str() {
        "csv" => ("csv", data::to_csv(&tasks)),
        "json" => ("json", serde_json::to_string_pretty(&tasks).map_err(err)?),
        other => return Err(format!("Unknown export format {other}")),
    };
    let stem = format!("TodoCity tasks {}", chrono::Local::now().format("%Y-%m-%d"));
    let path = data::free_name(&data::downloads_dir(), &stem, ext);
    std::fs::write(&path, body).map_err(err)?;
    reveal(&path, true)?;
    Ok(path.display().to_string())
}

/// Save a picture of the user's city to Downloads and show it in Finder.
/// The picture is made in the app; only a PNG is accepted.
#[tauri::command]
fn save_city_image(name: String, png: Vec<u8>) -> CmdResult<String> {
    const PNG_MAGIC: &[u8] = b"\x89PNG\r\n\x1a\n";
    if !png.starts_with(PNG_MAGIC) || png.len() > 20 * 1024 * 1024 {
        return Err("That isn't a picture TodoCity can save.".into());
    }
    let path = data::free_name(&data::downloads_dir(), &city_file_stem(&name), "png");
    std::fs::write(&path, png).map_err(err)?;
    reveal(&path, true)?;
    Ok(path.display().to_string())
}

/// The city's name as saved: trimmed, at most 40 characters, none if blank.
fn clean_city_name(name: Option<&str>) -> Option<String> {
    let n: String = name?
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(40)
        .collect();
    let n = n.trim().to_string();
    (!n.is_empty()).then_some(n)
}

/// A safe file name from the city's name ("Lumen Bay" → "Lumen Bay").
fn city_file_stem(name: &str) -> String {
    let clean: String = name
        .chars()
        .filter(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_'))
        .take(60)
        .collect();
    let clean = clean.trim();
    if clean.is_empty() {
        "My city".into()
    } else {
        clean.to_string()
    }
}

fn reveal(path: &std::path::Path, select: bool) -> CmdResult<()> {
    let mut cmd = if cfg!(target_os = "macos") {
        let mut c = std::process::Command::new("open");
        if select {
            c.arg("-R");
        }
        c.arg(path);
        c
    } else if cfg!(windows) {
        let mut c = std::process::Command::new("explorer");
        if select {
            c.arg(format!("/select,{}", path.display()));
        } else {
            c.arg(path);
        }
        c
    } else {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(if select {
            path.parent().unwrap_or(path)
        } else {
            path
        });
        c
    };
    cmd.spawn().map(|_| ()).map_err(err)
}

#[tauri::command]
fn show_quick_add(app: AppHandle) {
    quick::show(&app);
}

#[tauri::command]
fn hide_quick_add(app: AppHandle) {
    quick::hide(&app);
}

// ── Models tab ──────────────────────────────────────────────────────────────

#[tauri::command]
fn list_models(models: State<'_, ModelManager>) -> Vec<ModelView> {
    models.list()
}

#[tauri::command]
fn download_model(app: AppHandle, id: String) -> CmdResult<()> {
    models::start_download(app, id)
}

#[tauri::command]
fn cancel_download(models: State<'_, ModelManager>, id: String) {
    models.cancel(&id);
}

#[tauri::command]
async fn delete_model(
    engine: State<'_, Engine>,
    models: State<'_, ModelManager>,
    id: String,
) -> CmdResult<()> {
    models.delete(&engine, &id).await
}

#[tauri::command]
async fn set_active_model(
    engine: State<'_, Engine>,
    models: State<'_, ModelManager>,
    id: String,
) -> CmdResult<()> {
    if !models.is_available(&id) {
        return Err("That model's file isn't available — download or add it first.".into());
    }
    models.set_active(Some(&id))?;
    // Free the old model's memory now; the new one loads on next capture.
    engine.stop().await;
    Ok(())
}

#[tauri::command]
fn list_local_models(models: State<'_, ModelManager>) -> LocalModels {
    models.local_models()
}

#[tauri::command]
async fn add_model_file(
    engine: State<'_, Engine>,
    models: State<'_, ModelManager>,
    path: String,
    source: Option<String>,
) -> CmdResult<CustomModel> {
    let model = models.add_file(&path, source)?;
    // The new file becomes active; free the previous model's memory.
    engine.stop().await;
    Ok(model)
}

#[tauri::command]
async fn remove_model_file(
    engine: State<'_, Engine>,
    models: State<'_, ModelManager>,
    id: String,
) -> CmdResult<()> {
    models.remove_file(&engine, &id).await
}

#[tauri::command]
fn request_accessibility() -> bool {
    capture::accessibility_trusted(true)
}

#[tauri::command]
fn hide_panel(app: AppHandle) {
    panel::hide(&app);
}

/// From the popover: open the main panel, optionally at a task or tab.
#[tauri::command]
fn open_main(app: AppHandle, task_id: Option<i64>, tab: Option<String>) {
    popover::hide(&app);
    panel::show(&app);
    let _ = app.emit_to("panel", "open-tab", tab.as_deref().unwrap_or("tasks"));
    if let Some(id) = task_id {
        let _ = app.emit_to("panel", "highlight-task", id);
    }
}

/// Show the panel on the task list, optionally flashing one task.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn open_main_at(app: &AppHandle, task_id: Option<i64>) {
    open_main(app.clone(), task_id, None);
}

#[tauri::command]
fn hide_popover(app: AppHandle) {
    popover::hide(&app);
}

/// The popover is (or stops) reviewing a capture; keep it open meanwhile.
#[tauri::command]
fn set_popover_pinned(pinned: bool) {
    popover::set_pinned(pinned);
}

#[tauri::command]
fn set_panel_collapsed(app: AppHandle, collapsed: bool) -> CmdResult<()> {
    panel::set_collapsed(&app, collapsed).map_err(err)
}

#[tauri::command]
fn snap_panel_to_edge(app: AppHandle) {
    if panel::is_full(&app) {
        let _ = panel::set_full(&app, false);
    }
    panel::snap_to_edge(&app);
}

/// Open the panel as a full-screen window, or put it back at the side.
#[tauri::command]
fn set_panel_full(app: AppHandle, full: bool) -> CmdResult<()> {
    panel::set_full(&app, full).map_err(err)
}

/// Full screen: minimize the window to the Dock (clicking TodoCity's Dock icon
/// brings it back).
#[tauri::command]
fn minimize_panel(app: AppHandle) -> CmdResult<()> {
    match app.get_webview_window("panel") {
        Some(w) => w.minimize().map_err(err),
        None => Ok(()),
    }
}

#[tauri::command]
fn panel_full(app: AppHandle) -> bool {
    panel::is_full(&app)
}

// ── Shortcuts ───────────────────────────────────────────────────────────────

#[tauri::command]
fn get_shortcuts(shortcuts: State<'_, Shortcuts>) -> ShortcutSettings {
    shortcuts.get()
}

fn shortcuts_changed(app: &AppHandle, settings: &ShortcutSettings) {
    let _ = app.emit("shortcuts-changed", settings);
    tray::refresh(app);
}

#[tauri::command]
fn set_shortcut(
    app: AppHandle,
    shortcuts: State<'_, Shortcuts>,
    action: Action,
    spec: Option<ShortcutSpec>,
) -> CmdResult<ShortcutSettings> {
    let next = shortcuts.set(&app, action, spec)?;
    shortcuts_changed(&app, &next);
    Ok(next)
}

#[tauri::command]
fn reset_shortcuts(app: AppHandle, shortcuts: State<'_, Shortcuts>) -> CmdResult<ShortcutSettings> {
    let next = shortcuts.reset(&app)?;
    shortcuts_changed(&app, &next);
    Ok(next)
}

/// Stop the global shortcuts while the user records a new one, so pressing
/// the current shortcut doesn't trigger a capture.
#[tauri::command]
fn pause_shortcuts(app: AppHandle, shortcuts: State<'_, Shortcuts>, paused: bool) {
    shortcuts.pause(&app, paused);
}

// ── Capture flow ────────────────────────────────────────────────────────────

fn on_capture(app: AppHandle) {
    // Start loading the model while the user reviews the capture.
    let warm_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let models = warm_app.state::<ModelManager>();
        if let Some(m) = models.active() {
            warm_app.state::<Engine>().warm(&m.path).await;
        }
    });
    tauri::async_runtime::spawn(async move {
        // Capture before showing the panel so the source app still has focus.
        let worker_app = app.clone();
        let with_source = app.state::<Settings>().get().remember_source;
        let joined = tauri::async_runtime::spawn_blocking(move || {
            capture::capture_selection(&worker_app, with_source)
        })
        .await;
        let result = match joined {
            Ok(Some(r)) => r,
            // Another capture is already running.
            Ok(None) => return,
            Err(e) => {
                log::error!("capture task failed: {e}");
                CaptureResult::Failed {
                    message: "Something went wrong reading the selection. Please try again.".into(),
                }
            }
        };
        deliver_capture(&app, &result);
    });
}

/// Show the capture for review: under the menu-bar icon by default, or in
/// the side panel (the user's choice, or when the icon isn't on screen).
fn deliver_capture(app: &AppHandle, result: &CaptureResult) {
    quick::hide(app);
    let in_menu_bar = app.state::<Settings>().get().capture_in_menu_bar;
    let target = if in_menu_bar && popover::show_for_capture(app) {
        popover::LABEL
    } else {
        panel::show(app);
        "panel"
    };
    if let Err(e) = app.emit_to(target, "capture", result) {
        log::error!("failed to deliver capture: {e}");
    }
}

/// On a Mac, the data folder is `Application Support/TodoCity`; the old
/// `app.pluck.desktop` folder (Tauri's default, from the bundle identifier,
/// which stays unchanged) is moved there once and left as a link. Other
/// platforms keep Tauri's default.
fn settle_data_dir(tauri_default: std::path::PathBuf) -> std::path::PathBuf {
    if !cfg!(target_os = "macos") {
        return tauri_default;
    }
    let Some(parent) = tauri_default.parent() else {
        return tauri_default;
    };
    let (dir, outcome) = todocity_core::data_folder::settle(parent);
    log::info!("data folder {} ({outcome:?})", dir.display());
    dir
}

/// Up to 0.4.1 the app was called Pluck, then Plucky until 0.4.36, then
/// "Todo City" (two words) until 0.4.50. An update keeps the old bundle
/// path, so finish the rename on first launch: move it to `TodoCity.app`
/// and reopen from there. Returns true when
/// relaunching.
#[cfg(target_os = "macos")]
fn finish_rename(app: &AppHandle) -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    // …/Plucky.app/Contents/MacOS/<executable>.
    let Some(bundle) = exe.ancestors().nth(3).map(|p| p.to_path_buf()) else {
        return false;
    };
    // Earlier names: Pluck, Plucky, then Todo City.
    if !matches!(
        bundle.file_name().and_then(|n| n.to_str()),
        Some("Pluck.app" | "Plucky.app" | "Todo City.app")
    ) {
        return false;
    }
    let target = bundle.with_file_name("TodoCity.app");
    if target.exists() {
        return false;
    }
    if let Err(e) = std::fs::rename(&bundle, &target) {
        log::warn!("could not rename {} to TodoCity.app: {e}", bundle.display());
        return false;
    }
    log::info!("renamed the app to {}", target.display());
    match std::process::Command::new("/usr/bin/open")
        .arg("-n")
        .arg(&target)
        .spawn()
    {
        Ok(_) => {
            app.exit(0);
            true
        }
        Err(e) => {
            log::warn!("could not reopen as TodoCity: {e}");
            false
        }
    }
}

/// The login item of versions called Pluck (`Pluck.plist`) points at the old
/// app. Replace it with TodoCity's, if it was on.
fn migrate_login_item(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let Some(home) = std::env::var_os("HOME") else {
            return;
        };
        let agents = std::path::PathBuf::from(home).join("Library/LaunchAgents");
        // The login items of the app's earlier names.
        let Some(old) = ["Pluck.plist", "Plucky.plist", "Todo City.plist"]
            .iter()
            .map(|n| agents.join(n))
            .find(|p| p.is_file())
        else {
            return;
        };
        if let Err(e) = std::fs::remove_file(&old) {
            log::warn!("could not remove the old login item: {e}");
            return;
        }
        match app.autolaunch().enable() {
            Ok(()) => log::info!("moved the login item to TodoCity"),
            Err(e) => log::warn!("could not re-create the login item: {e}"),
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Mark the login item as TodoCity's (`AssociatedBundleIdentifiers`), so
/// macOS lists it under the app's name and icon in Login Items & Extensions
/// instead of under the developer's name. Safe to run every launch.
fn associate_login_item(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let Some(home) = std::env::var_os("HOME") else {
            return;
        };
        let path = std::path::PathBuf::from(home)
            .join("Library/LaunchAgents")
            .join(format!("{}.plist", app.package_info().name));
        let Ok(text) = std::fs::read_to_string(&path) else {
            return;
        };
        if let Some(fixed) = with_associated_bundle(&text, &app.config().identifier) {
            match std::fs::write(&path, fixed) {
                Ok(()) => log::info!("tied the login item to {}", app.config().identifier),
                Err(e) => log::warn!("could not update the login item: {e}"),
            }
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// The launch agent plist with `AssociatedBundleIdentifiers` added, or None
/// when it already has it (or isn't a plist we understand).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn with_associated_bundle(plist: &str, id: &str) -> Option<String> {
    if plist.contains("AssociatedBundleIdentifiers") {
        return None;
    }
    let at = plist.rfind("</dict>")?;
    Some(format!(
        "{}  <key>AssociatedBundleIdentifiers</key>\n  <array>\n    <string>{id}</string>\n  </array>\n{}",
        &plist[..at],
        &plist[at..]
    ))
}

/// Text sent through Services → "Add to TodoCity".
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn on_service_text(app: AppHandle, text: String) {
    deliver_text(app, text, CaptureMethod::Service);
}

/// Text copied twice in a row (⌘C ⌘C).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub(crate) fn on_copied_text(app: AppHandle, text: String) {
    deliver_text(app, text, CaptureMethod::Clipboard);
}

/// Review text that arrived ready-made (not read from a selection).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn deliver_text(app: AppHandle, text: String, method: CaptureMethod) {
    let with_source = app.state::<Settings>().get().remember_source;
    tauri::async_runtime::spawn(async move {
        let source = if with_source {
            tauri::async_runtime::spawn_blocking(capture::source_info)
                .await
                .ok()
                .flatten()
        } else {
            None
        };
        let models = app.state::<ModelManager>();
        if let Some(m) = models.active() {
            app.state::<Engine>().warm(&m.path).await;
        }
        deliver_capture(
            &app,
            &CaptureResult::Text {
                text,
                method,
                source,
            },
        );
    });
}

/// Open the task database. If it can't be opened (e.g. the file is damaged),
/// set it aside as `tasks.db.unreadable-<time>` and start a fresh one rather
/// than refusing to launch; as a last resort, run with an in-memory store.
fn open_store(path: &std::path::Path) -> Store {
    match Store::open(path) {
        Ok(s) => return s,
        Err(e) => log::error!("could not open {}: {e}", path.display()),
    }
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    for ext in ["", "-wal", "-shm"] {
        let from = std::path::PathBuf::from(format!("{}{ext}", path.display()));
        if from.exists() {
            let to = format!("{}.unreadable-{stamp}{ext}", path.display());
            if let Err(e) = std::fs::rename(&from, &to) {
                log::error!("could not move {} aside: {e}", from.display());
            }
        }
    }
    match Store::open(path) {
        Ok(s) => s,
        Err(e) => {
            log::error!("starting with an in-memory task list: {e}");
            Store::open_in_memory().expect("in-memory SQLite is always available")
        }
    }
}

// ── Logging ─────────────────────────────────────────────────────────────────

/// `~/Library/Logs/TodoCity/todocity.log` on macOS; the temp folder elsewhere.
fn log_file_path() -> Option<std::path::PathBuf> {
    if cfg!(target_os = "macos") {
        std::env::var_os("HOME")
            .map(|h| std::path::PathBuf::from(h).join("Library/Logs/TodoCity/todocity.log"))
    } else {
        Some(std::env::temp_dir().join("TodoCity").join("todocity.log"))
    }
}

/// Log to a file users can send with a bug report, and record panics (with
/// a backtrace) there before the default handler runs.
fn init_logging() {
    let mut builder =
        env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"));
    builder.format_timestamp_millis();
    if let Some(path) = log_file_path() {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        // Start a fresh file once it passes 2 MB.
        if std::fs::metadata(&path).is_ok_and(|m| m.len() > 2_000_000) {
            let _ = std::fs::remove_file(&path);
        }
        if let Ok(file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            builder.target(env_logger::Target::Pipe(Box::new(file)));
        }
    }
    let _ = builder.try_init();
    log::info!("TodoCity {} starting", env!("CARGO_PKG_VERSION"));

    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        log::error!(
            "panic: {info}\n{}",
            std::backtrace::Backtrace::force_capture()
        );
        default_hook(info);
    }));
}

/// Show the log file in Finder / Explorer.
#[tauri::command]
fn reveal_logs() -> CmdResult<String> {
    let path = log_file_path().ok_or("no log location")?;
    let shown = path.display().to_string();
    let result = if cfg!(target_os = "macos") {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
    } else if cfg!(windows) {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path.display()))
            .spawn()
    } else {
        std::process::Command::new("xdg-open")
            .arg(path.parent().unwrap_or(&path))
            .spawn()
    };
    result.map(|_| shown).map_err(err)
}

// ── Entry point ─────────────────────────────────────────────────────────────

/// `TodoCity --mcp`: serve TodoCity's MCP tools over stdio. Returns the
/// process exit code.
pub fn run_mcp() -> i32 {
    agents::mcp::run()
}

pub fn run() {
    init_logging();
    let builder = tauri::Builder::default()
        // todocity:// links.
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(not(target_os = "macos"))]
    let builder = builder.plugin(tauri_plugin_notification::init());
    builder
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, sc, event| {
                    let Some(shortcuts) = app.try_state::<Shortcuts>() else {
                        return;
                    };
                    match (shortcuts.action_for(sc), event.state()) {
                        // Act on release so the user's modifier keys are coming
                        // up before any synthesized Copy.
                        (Some(Action::Capture), ShortcutState::Released) => on_capture(app.clone()),
                        (Some(Action::QuickAdd), ShortcutState::Pressed) => quick::toggle(app),
                        (Some(Action::TogglePanel), ShortcutState::Pressed) => panel::toggle(app),
                        _ => {}
                    }
                })
                .build(),
        )
        .setup(|app| {
            #[cfg(target_os = "macos")]
            if finish_rename(app.handle()) {
                return Ok(());
            }
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let data_dir = settle_data_dir(app.path().app_data_dir()?);
            std::fs::create_dir_all(&data_dir)?;
            let log_dir = app.path().app_log_dir()?;
            std::fs::create_dir_all(&log_dir)?;
            let store = open_store(&data_dir.join("tasks.db"));
            match data::daily_backup(&store, &data_dir) {
                Ok(Some(p)) => log::info!("backup written to {}", p.display()),
                Ok(None) => {}
                Err(e) => log::warn!("daily backup failed: {e}"),
            }
            let settings = Settings::new(&data_dir);
            if !settings.get().default_projects_made {
                // Every Mac starts with Home (for Personal) and Office (for
                // Work), once — deleting them later sticks.
                for name in [todocity_core::modes::HOME, todocity_core::modes::OFFICE] {
                    if let Err(e) = store.create_project(name) {
                        log::warn!("could not make the {name} project: {e}");
                    }
                }
                settings.update(|s| s.default_projects_made = true);
            }
            app.manage(AppState {
                store: Mutex::new(store),
                data_dir: data_dir.clone(),
            });
            app.manage(settings);
            app.manage(agents::Agents::new(&data_dir));
            app.manage(agent_panel::Sessions::default());
            app.manage(Updates::default());
            app.manage(import::TodoistCache::default());
            app.manage(mirror::Mirror::new(&data_dir));
            app.manage(ModelManager::new(&data_dir));
            app.manage(panel::PanelState::new(&data_dir));
            app.manage(Engine::new(&log_dir));
            app.manage(Shortcuts::new(&data_dir));
            app.manage(reminders::Reminders::start(app.handle(), &data_dir));
            app.manage(sync::SyncService::new(&data_dir));
            app.manage(calsync::CalendarSync::start(app.handle(), &data_dir));
            mirror::Mirror::start(app.handle());

            // Every 30 s: release the model's memory when idle, and roll the
            // menu-bar list over to the new day at midnight.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut day = chrono::Local::now().date_naive();
                loop {
                    tokio::time::sleep(Duration::from_secs(30)).await;
                    handle.state::<Engine>().stop_if_idle().await;
                    let now = chrono::Local::now().date_naive();
                    if now != day {
                        day = now;
                        tray::refresh(&handle);
                        let _ = handle.emit("tasks-changed", ());
                        let state = handle.state::<AppState>();
                        let result = match state.store.lock() {
                            Ok(store) => data::daily_backup(&store, &state.data_dir),
                            Err(e) => Err(e.to_string()),
                        };
                        if let Err(e) = result {
                            log::warn!("daily backup failed: {e}");
                        }
                    }
                }
            });

            app.state::<Shortcuts>().register_all(app.handle());
            tray::build(app.handle())?;
            // Let TodoCity's windows open over full-screen apps.
            spaces::configure_all(app.handle());
            notifications::init(app.handle());
            notifications::start_scheduler(app.handle());
            updates::start(app.handle());
            #[cfg(target_os = "macos")]
            {
                let handle = app.handle().clone();
                services::register(move |text| on_service_text(handle.clone(), text));
            }

            // TodoCity lives in the menu bar, so open it at login — once, by
            // default; after that it's the user's switch in Settings.
            let settings = app.state::<Settings>();
            if login_item::available() {
                // macOS 13+: the app is its own login item, listed as
                // TodoCity. Earlier versions used a launch agent (listed under
                // the developer's name): move over, keeping the user's choice.
                let legacy = login_item::legacy_agents();
                let was_on = !legacy.is_empty() || app.autolaunch().is_enabled().unwrap_or(false);
                if was_on {
                    let _ = app.autolaunch().disable();
                    for p in &legacy {
                        let _ = std::fs::remove_file(p);
                    }
                }
                if was_on || !settings.get().autostart_initialized {
                    if let Err(e) = login_item::set(true) {
                        log::warn!("could not enable open at login: {e}");
                    }
                }
                settings.update(|s| s.autostart_initialized = true);
            } else {
                migrate_login_item(app.handle());
                if !settings.get().autostart_initialized {
                    if let Err(e) = app.autolaunch().enable() {
                        log::warn!("could not enable open at login: {e}");
                    }
                    settings.update(|s| s.autostart_initialized = true);
                }
                associate_login_item(app.handle());
            }

            // Show the panel at launch (always on a first run, for the tour),
            // and again on the first wake of each day.
            let first_run = !app.state::<Settings>().get().onboarding_done
                && app.state::<ModelManager>().active().is_none()
                && app.state::<Engine>().kind() == "bundled";
            greet::on_launch(app.handle(), first_run);
            greet::start(app.handle());
            // Keep one warm connection to the Mac's calendars (see calendar.rs).
            calendar::start(app.handle());

            // todocity:// links: while running, and the one TodoCity was opened with.
            {
                use tauri_plugin_deep_link::DeepLinkExt;
                let handle = app.handle().clone();
                app.deep_link().on_open_url(move |event| {
                    for url in event.urls() {
                        on_deep_link(&handle, &url);
                    }
                });
                if let Ok(Some(urls)) = app.deep_link().get_current() {
                    for url in urls {
                        on_deep_link(app.handle(), &url);
                    }
                }
            }
            slack_cleanup::start(app.handle());
            sync::start(app.handle());
            agents::start(app.handle());
            agent_panel::start(app.handle());
            watch::start(app.handle());
            double_copy::start(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::Moved(pos) if window.label() == "panel" => {
                panel::on_moved(window.app_handle(), *pos);
            }
            // The popover behaves like a menu: clicking elsewhere closes it.
            tauri::WindowEvent::Focused(false) if window.label() == popover::LABEL => {
                popover::on_blur(window.app_handle());
            }
            tauri::WindowEvent::Focused(false) if window.label() == quick::LABEL => {
                quick::hide(window.app_handle());
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            extract,
            import::things_find,
            import::things_pick,
            import::things_preview,
            import::things_import,
            import::todoist_pick_files,
            import::todoist_preview,
            import::todoist_import,
            mirror::mirror_status,
            mirror::mirror_sync_now,
            mirror::mirror_stop,
            mirror::mirror_stop_project,
            mirror::mirror_set_two_way,
            set_view_mode,
            sync::sync_status,
            sync::sync_add_mac,
            sync::sync_join,
            sync::sync_pair_confirm,
            sync::sync_pair_cancel,
            sync::sync_pair_dismiss,
            sync::sync_now,
            sync::sync_remove,
            sync::sync_leave,
            sync::sync_local_only,
            sync::sync_rename,
            sync::sync_dismiss_notice,
            list_tasks,
            logbook,
            city_windows,
            save_city_image,
            list_projects,
            list_floors,
            create_project,
            add_floor,
            rename_floor,
            project_tasks,
            set_project_color,
            delete_project,
            delete_floor,
            skip_occurrence,
            rename_project,
            add_task,
            update_task,
            delete_task,
            status,
            request_accessibility,
            hide_panel,
            set_panel_collapsed,
            snap_panel_to_edge,
            set_panel_full,
            panel_full,
            minimize_panel,
            list_models,
            download_model,
            cancel_download,
            delete_model,
            set_active_model,
            list_local_models,
            add_model_file,
            remove_model_file,
            get_shortcuts,
            set_shortcut,
            reset_shortcuts,
            pause_shortcuts,
            reveal_logs,
            open_main,
            hide_popover,
            set_popover_pinned,
            reminders_status,
            reminders_request_access,
            reminders_lists,
            reminders_enable,
            reminders_disable,
            reminders_sync_now,
            reminders_set_include_notes,
            reminders_open_privacy_settings,
            agents::agents_status,
            agents::agents_set_enabled,
            agents::agents_set_proactive,
            agents::agents_set_full_access,
            agents::agent_activity,
            agents::agent_undo,
            agent_panel::agent_clis,
            agent_panel::agent_run_list,
            agent_panel::agent_run_dismiss,
            agent_panel::agent_run_transcript,
            agent_panel::term_start,
            agent_panel::term_list,
            agent_panel::term_attach,
            agent_panel::term_write,
            agent_panel::term_resize,
            agent_panel::term_close,
            agent_panel::pick_folder,
            agent_panel::home_folder,
            app_icons::app_icons,
            calsync::calsync_status,
            calsync::calsync_apple_enable,
            calsync::calsync_apple_disable,
            calsync::calsync_set_lane,
            calsync::calsync_set_group,
            calsync::calsync_sync_now,
            agents::agents_connect,
            agents::agents_disconnect,
            agents::agents_test,
            watch::watch_status,
            watch::watch_set,
            watch::watch_pause,
            watch::watch_check_now,
            agents::inbox_list,
            agents::inbox_accept,
            agents::inbox_discard,
            calendar_status,
            calendar_request_access,
            calendar_calendars,
            calendar_set,
            calendar_events,
            calendar_move_event,
            calendar_open_privacy_settings,
            open_source,
            open_url,
            restore_task,
            get_settings,
            set_settings,
            notification_permission,
            request_notification_permission,
            test_notification,
            open_notification_settings,
            autostart_enabled,
            set_autostart,
            update_status,
            check_for_updates,
            install_update,
            list_backups,
            backup_now,
            restore_backup,
            reveal_backups,
            reveal_data_folder,
            export_tasks,
            show_quick_add,
            hide_quick_add
        ])
        .build(tauri::generate_context!())
        .expect("error while building TodoCity")
        .run(|app, event| {
            // Clicking the Dock icon (shown while full screen) brings the
            // window back, minimized or hidden.
            #[cfg(target_os = "macos")]
            // Opening TodoCity again (Finder, Spotlight, Launchpad) while
            // it runs: bring up the window, in full screen by default.
            if let tauri::RunEvent::Reopen { .. } = event {
                panel::open_main_window(app);
            }
            if let tauri::RunEvent::Exit = event {
                // try_state: a relaunch after the rename exits before setup
                // registers anything.
                if let Some(engine) = app.try_state::<Engine>() {
                    engine.kill_now();
                }
                if let Some(panel) = app.try_state::<panel::PanelState>() {
                    panel.flush();
                }
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn city_names_are_tidied() {
        assert_eq!(
            clean_city_name(Some("  Lumen Bay ")),
            Some("Lumen Bay".into())
        );
        assert_eq!(clean_city_name(Some("   ")), None);
        assert_eq!(clean_city_name(None), None);
        assert_eq!(clean_city_name(Some(&"x".repeat(80))).unwrap().len(), 40);
    }

    #[test]
    fn city_file_names_are_safe() {
        assert_eq!(city_file_stem("Lumen Bay"), "Lumen Bay");
        assert_eq!(city_file_stem("../../etc/passwd"), "etcpasswd");
        assert_eq!(city_file_stem("  /:  "), "My city");
        let plist =
            "<plist><dict>\n  <key>Label</key>\n  <string>TodoCity</string>\n</dict></plist>";
        let fixed = with_associated_bundle(plist, "app.pluck.desktop").unwrap();
        assert!(fixed.contains("<key>AssociatedBundleIdentifiers</key>"));
        assert!(fixed.contains("<string>app.pluck.desktop</string>"));
        assert!(fixed.trim_end().ends_with("</dict></plist>"));
        assert!(with_associated_bundle(&fixed, "app.pluck.desktop").is_none());
    }

    fn task() -> Task {
        Task {
            id: 1,
            title: "x".into(),
            due_date: None,
            source_text: None,
            done: false,
            created_at: String::new(),
            created_tz: None,
            completed_at: None,
            due_time: None,
            recurrence: None,
            source_app: None,
            source_bundle: None,
            source_url: None,
            snoozed_until: None,
            notified_at: None,
            next_id: None,
            notes: None,
            ..Default::default()
        }
    }

    #[test]
    fn slack_links_open_in_the_app() {
        assert_eq!(
            slack_deep_link("https://app.slack.com/client/T0123/C0456"),
            Some("slack://channel?team=T0123&id=C0456".into())
        );
        assert_eq!(
            slack_deep_link("https://app.slack.com/client/T0123/C0456/thread/C0456-1.2"),
            Some("slack://channel?team=T0123&id=C0456".into())
        );
        assert_eq!(slack_deep_link("https://app.slack.com/client/T0123"), None);
        assert_eq!(slack_deep_link("https://evil.example/client/T1/C2"), None);
    }

    #[test]
    fn source_targets() {
        let mut t = task();
        assert_eq!(source_target(&t), None);
        t.source_bundle = Some("com.apple.Notes".into());
        assert_eq!(
            source_target(&t),
            Some(OpenTarget::App("com.apple.Notes".into()))
        );
        t.source_url = Some("https://example.com/a?b=1".into());
        assert_eq!(
            source_target(&t),
            Some(OpenTarget::Url("https://example.com/a?b=1".into()))
        );
        // Only web and file links are opened.
        t.source_url = Some("javascript:alert(1)".into());
        assert_eq!(
            source_target(&t),
            Some(OpenTarget::App("com.apple.Notes".into()))
        );
        t.source_bundle = Some("bad bundle; rm -rf".into());
        assert_eq!(source_target(&t), None);
    }
}
