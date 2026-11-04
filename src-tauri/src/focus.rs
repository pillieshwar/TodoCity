//! Focus Blocks (macOS): events on the Focus calendar turn the Mac's Focus on
//! and off.
//!
//! macOS has no API for apps to set Focus, so TodoCity runs a Shortcuts
//! shortcut ("TodoCity Focus" by default) with `/usr/bin/shortcuts run`. Its
//! input is the block's end time (ISO 8601) or `off`; the shortcut turns the
//! chosen Focus on *until that time*, so macOS ends it on its own even if
//! TodoCity is closed or the Mac sleeps through the end.
//!
//! Blocks are ordinary events on one calendar, so they can be made, moved and
//! deleted in TodoCity's Calendar or in Apple Calendar alike. A worker thread
//! looks at the calendar every [`TICK`] (and right away when something
//! changes), and `todocity_core::focus::plan` decides what to do. What it
//! decided is saved in `focus.json`, so a restart never starts a block twice.
//! Picked tasks live in the task database (`focus_tasks`), on this Mac only.

#![cfg_attr(not(target_os = "macos"), allow(dead_code, unused_imports))]

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{Local, NaiveDate, NaiveDateTime};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use todocity_core::focus::{self as plan, Action, Block, Ended, State};

use crate::reminders::Access;
use crate::settings::{FocusSettings, Settings};

/// The calendar "Make a Focus calendar" adds.
pub const CALENDAR_TITLE: &str = "Focus";
/// How often the calendar is looked at.
const TICK: Duration = Duration::from_secs(20);
/// A running block that seems to have vanished is looked at again this soon
/// before Focus is turned off, in case Calendar only missed it for a moment.
const RECHECK: Duration = Duration::from_secs(4);
/// How long a shortcut may take.
const RUN_TIMEOUT: Duration = Duration::from_secs(15);
/// The wrap-up card is offered for this long after a block ends.
const WRAP_UP_HOURS: i64 = 3;
const SHORTCUTS: &str = "/usr/bin/shortcuts";

pub struct FocusService {
    path: PathBuf,
    input: PathBuf,
    state: Mutex<State>,
    wake: Mutex<Option<Sender<()>>>,
    /// The last shortcut run that didn't work, to show in the panel.
    error: Mutex<Option<String>>,
    /// A running block went missing on the last look.
    missing: Mutex<bool>,
    /// Held while deciding and acting, so a look and "End now" never cross.
    turn: Mutex<()>,
}

impl FocusService {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join("focus.json");
        let state = std::fs::read_to_string(&path)
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default();
        Self {
            path,
            input: data_dir.join("focus-input.txt"),
            state: Mutex::new(state),
            wake: Mutex::new(None),
            error: Mutex::new(None),
            missing: Mutex::new(false),
            turn: Mutex::new(()),
        }
    }

    fn state(&self) -> State {
        self.state.lock().map(|s| s.clone()).unwrap_or_default()
    }

    fn save(&self, next: State) {
        if let Ok(text) = serde_json::to_string_pretty(&next) {
            if let Err(e) = std::fs::write(&self.path, text) {
                log::warn!("could not save focus.json: {e}");
            }
        }
        if let Ok(mut s) = self.state.lock() {
            *s = next;
        }
    }

    fn set_error(&self, e: Option<String>) {
        if let Ok(mut s) = self.error.lock() {
            *s = e;
        }
    }

    fn error(&self) -> Option<String> {
        self.error.lock().ok().and_then(|e| e.clone())
    }

    /// Look at the calendar now.
    pub fn nudge(&self) {
        if let Some(tx) = self.wake.lock().ok().and_then(|w| w.clone()) {
            let _ = tx.send(());
        }
    }
}

/// Start the worker (macOS only).
pub fn start(app: &AppHandle) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let (tx, rx) = mpsc::channel::<()>();
    if let Ok(mut w) = app.state::<FocusService>().wake.lock() {
        *w = Some(tx);
    }
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("todocity-focus".into())
        .spawn(move || loop {
            let wait = tick(&app);
            let _ = rx.recv_timeout(wait);
        });
    if let Err(e) = spawned {
        log::warn!("could not start focus blocks: {e}");
    }
}

/// `YYYY-MM-DDTHH:MM[:SS]` local.
fn parse(s: &str) -> Option<NaiveDateTime> {
    todocity_core::meeting_move::parse_local(s).ok()
}

/// The focus blocks from yesterday to tomorrow, or `None` when the calendar
/// can't be read right now.
fn blocks(key: &str, today: NaiveDate) -> Option<Vec<Block>> {
    if crate::calendar::access() != Access::Full {
        return None;
    }
    let from = today - chrono::Duration::days(1);
    let to = today + chrono::Duration::days(1);
    let events = crate::calendar::events_in(key, from, to).ok()?;
    Some(
        events
            .into_iter()
            .filter(|e| !e.all_day)
            .filter_map(|e| {
                Some(Block {
                    start: parse(&e.start)?,
                    end: parse(&e.end)?,
                    id: e.id,
                    title: if e.title.trim().is_empty() {
                        CALENDAR_TITLE.to_string()
                    } else {
                        e.title
                    },
                })
            })
            .collect(),
    )
}

fn settings(app: &AppHandle) -> FocusSettings {
    app.state::<Settings>().get().focus
}

/// One look at the calendar. Returns how long to wait before the next.
fn tick(app: &AppHandle) -> Duration {
    let s = settings(app);
    let svc = app.state::<FocusService>();
    let Some(key) = s.calendar.as_deref().filter(|_| s.enabled) else {
        return TICK;
    };
    let now = Local::now().naive_local();
    let Some(list) = blocks(key, now.date()) else {
        return TICK;
    };
    let _turn = svc.turn.lock();
    let before = svc.state();
    let step = plan::plan(&before, &list, now);
    // A running block that vanished: make sure before ending it.
    let vanished = step.finished.iter().any(|d| d.reason == Ended::Changed);
    if let Ok(mut missing) = svc.missing.lock() {
        if vanished && !*missing {
            *missing = true;
            return RECHECK;
        }
        *missing = false;
    }
    apply(app, &s, &before, step.state, &step.action);
    TICK
}

/// Tell macOS, save, and let the windows know.
fn apply(app: &AppHandle, s: &FocusSettings, before: &State, next: State, action: &Action) {
    let svc = app.state::<FocusService>();
    if let Some(input) = plan::shortcut_input(action, *Local::now().offset()) {
        match run_shortcut(&s.shortcut, &input, &svc.input) {
            Ok(()) => {
                log::info!("focus: sent {input:?} to {:?}", s.shortcut);
                svc.set_error(None);
            }
            Err(e) => {
                log::warn!("focus: {e}");
                svc.set_error(Some(e));
            }
        }
    }
    let changed = &next != before;
    svc.save(next);
    if changed || *action != Action::Nothing {
        let _ = app.emit("focus-changed", ());
    }
}

// ── Shortcuts ───────────────────────────────────────────────────────────────

/// Whether the shortcut `name` is in the Shortcuts app.
pub fn shortcut_installed(name: &str) -> bool {
    if !cfg!(target_os = "macos") {
        return false;
    }
    Command::new(SHORTCUTS)
        .arg("list")
        .stderr(Stdio::null())
        .output()
        .map(|o| {
            String::from_utf8_lossy(&o.stdout)
                .lines()
                .any(|l| l.trim() == name)
        })
        .unwrap_or(false)
}

/// Run the shortcut with `input` (written to `file`, then passed by path).
fn run_shortcut(name: &str, input: &str, file: &Path) -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Focus Blocks are only available on macOS.".into());
    }
    std::fs::write(file, input).map_err(|e| format!("Couldn't prepare the shortcut: {e}"))?;
    let mut child = Command::new(SHORTCUTS)
        .arg("run")
        .arg(name)
        .arg("--input-path")
        .arg(file)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't open Shortcuts: {e}"))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => return Ok(()),
            Ok(Some(_)) => {
                let mut text = String::new();
                if let Some(mut err) = child.stderr.take() {
                    let _ = std::io::Read::read_to_string(&mut err, &mut text);
                }
                let detail = text.trim();
                return Err(if detail.is_empty() {
                    format!("Add the “{name}” shortcut in Settings → Focus Blocks, then turn Focus on here.")
                } else {
                    format!("The “{name}” shortcut said: {detail}")
                });
            }
            Ok(None) if started.elapsed() > RUN_TIMEOUT => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!(
                    "The “{name}” shortcut took too long. Open Shortcuts, run it once, then turn Focus on here."
                ));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("Couldn't run the shortcut: {e}")),
        }
    }
}

// ── What the windows show ───────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct BlockView {
    pub title: String,
    /// Local `YYYY-MM-DDTHH:MM:SS`.
    pub start: String,
    pub end: String,
    /// The block occurrences in it (`focus::key`).
    pub keys: Vec<String>,
    /// Picked tasks, in order.
    pub tasks: Vec<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct DoneView {
    #[serde(flatten)]
    pub block: BlockView,
    pub reason: Ended,
    pub at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub supported: bool,
    pub enabled: bool,
    /// The Focus calendar's key, if one was chosen.
    pub calendar: Option<String>,
    pub calendar_access: Access,
    pub shortcut: String,
    pub shortcut_ready: bool,
    /// A link that adds the shortcut, when TodoCity offers one.
    pub shortcut_link: Option<&'static str>,
    pub login_item: bool,
    pub minutes: u32,
    pub active: Option<BlockView>,
    pub next: Option<BlockView>,
    /// The block that ended last, for a few hours after.
    pub last: Option<DoneView>,
    pub error: Option<String>,
}

/// A shared iCloud link to the ready-made shortcut, once one is published.
/// Until then Settings shows the three steps to make it.
pub const SHORTCUT_LINK: Option<&str> = None;

fn when(t: NaiveDateTime) -> String {
    t.format("%Y-%m-%dT%H:%M:%S").to_string()
}

fn tasks_for(app: &AppHandle, keys: &[String]) -> Vec<i64> {
    let state = app.state::<crate::AppState>();
    let Ok(store) = state.store.lock() else {
        return Vec::new();
    };
    let mut out: Vec<i64> = Vec::new();
    for k in keys {
        for id in store.focus_tasks(k).unwrap_or_default() {
            if !out.contains(&id) {
                out.push(id);
            }
        }
    }
    out
}

/// What Settings and the panels show. `check_shortcut` asks Shortcuts
/// whether the shortcut is there (takes a moment).
pub fn status(app: &AppHandle, check_shortcut: bool) -> Status {
    let s = settings(app);
    let svc = app.state::<FocusService>();
    let st = svc.state();
    let now = Local::now().naive_local();
    let view = |title: &str, start, end, keys: &[String]| BlockView {
        title: title.to_string(),
        start: when(start),
        end: when(end),
        keys: keys.to_vec(),
        tasks: tasks_for(app, keys),
    };
    let active = st
        .active
        .as_ref()
        .map(|a| view(&a.title, a.start, a.end, &a.keys));
    let next = match (s.enabled, s.calendar.as_deref()) {
        (true, Some(key)) if active.is_none() => blocks(key, now.date())
            .and_then(|list| plan::next(&list, &st, now))
            .filter(|w| w.start.date() == now.date())
            .map(|w| view(&w.title, w.start, w.end, &w.keys)),
        _ => None,
    };
    let last = st
        .last_done()
        .filter(|d| now - d.at < chrono::Duration::hours(WRAP_UP_HOURS))
        .filter(|d| matches!(d.reason, Ended::Completed | Ended::ByYou))
        .map(|d| DoneView {
            block: view(&d.title, d.start, d.end, &d.keys),
            reason: d.reason,
            at: when(d.at),
        });
    Status {
        supported: cfg!(target_os = "macos"),
        enabled: s.enabled,
        calendar: s.calendar.clone(),
        calendar_access: crate::calendar::access(),
        shortcut_ready: check_shortcut && shortcut_installed(&s.shortcut),
        shortcut: s.shortcut,
        shortcut_link: SHORTCUT_LINK,
        login_item: crate::login_item::enabled(),
        minutes: s.minutes,
        active,
        next,
        last,
        error: svc.error(),
    }
}

/// End the running block (if any) and save.
fn end_now(app: &AppHandle) {
    let s = settings(app);
    let svc = app.state::<FocusService>();
    let _turn = svc.turn.lock();
    let before = svc.state();
    let step = plan::end_now(&before, Local::now().naive_local());
    apply(app, &s, &before, step.state, &step.action);
}

// ── Commands ───────────────────────────────────────────────────────────────

/// Run `f` off the main thread (it may wait on Calendar or Shortcuts).
async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn focus_status(app: AppHandle) -> Result<Status, String> {
    blocking(move || Ok(status(&app, true))).await
}

/// Change Focus Blocks' settings. Turning them on shows the Focus calendar in
/// TodoCity's Calendar; turning them off ends a running block.
#[tauri::command]
pub async fn focus_set(
    app: AppHandle,
    enabled: Option<bool>,
    calendar: Option<String>,
    shortcut: Option<String>,
    minutes: Option<u32>,
) -> Result<Status, String> {
    blocking(move || {
        let was_on = settings(&app).enabled;
        let next = app.state::<Settings>().update(|v| {
            if let Some(on) = enabled {
                v.focus.enabled = on;
            }
            if let Some(key) = calendar.filter(|k| !k.trim().is_empty()) {
                v.focus.calendar = Some(key);
            }
            if let Some(name) = shortcut.map(|n| n.trim().to_string()) {
                if !name.is_empty() {
                    v.focus.shortcut = name;
                }
            }
            if let Some(m) = minutes {
                v.focus.minutes = m.clamp(5, 480);
            }
            if v.focus.enabled {
                if let Some(key) = v.focus.calendar.clone() {
                    v.calendar_enabled = true;
                    v.calendar_hidden.retain(|h| *h != key);
                }
            }
        });
        if was_on && !next.focus.enabled {
            end_now(&app);
        }
        let _ = app.emit("calendar-changed", ());
        let _ = app.emit("settings-changed", next);
        app.state::<FocusService>().nudge();
        Ok(status(&app, true))
    })
    .await
}

/// Make (or find) the "Focus" calendar and use it.
#[tauri::command]
pub async fn focus_make_calendar(app: AppHandle) -> Result<Status, String> {
    if crate::calendar::access() != Access::Full {
        let granted = blocking(crate::calendar::request_access).await?;
        if granted != Access::Full {
            return Err("Allow TodoCity full access to Calendars in System Settings → Privacy & Security → Calendars, then try again.".into());
        }
    }
    let cal = blocking(|| crate::calendar::make_calendar(CALENDAR_TITLE)).await?;
    focus_set(app, None, Some(cal.key), None, None).await
}

/// Turn Focus on for one minute, to check the shortcut works.
#[tauri::command]
pub async fn focus_try(app: AppHandle) -> Result<(), String> {
    blocking(move || {
        let s = settings(&app);
        let svc = app.state::<FocusService>();
        let until = Local::now().naive_local() + chrono::Duration::minutes(1);
        let input = plan::shortcut_input(&Action::On { until }, *Local::now().offset())
            .ok_or("Couldn't work out the time.")?;
        let result = run_shortcut(&s.shortcut, &input, &svc.input);
        svc.set_error(result.as_ref().err().cloned());
        let _ = app.emit("focus-changed", ());
        result
    })
    .await
}

/// Turn Focus on again for the running block (after the shortcut didn't run).
#[tauri::command]
pub async fn focus_resume(app: AppHandle) -> Result<Status, String> {
    blocking(move || {
        let s = settings(&app);
        let svc = app.state::<FocusService>();
        let Some(a) = svc.state().active else {
            return Ok(status(&app, false));
        };
        let input = plan::shortcut_input(&Action::On { until: a.end }, *Local::now().offset())
            .ok_or("Couldn't work out the time.")?;
        let result = run_shortcut(&s.shortcut, &input, &svc.input);
        svc.set_error(result.as_ref().err().cloned());
        let _ = app.emit("focus-changed", ());
        result.map(|_| status(&app, false))
    })
    .await
}

#[tauri::command]
pub async fn focus_end_now(app: AppHandle) -> Result<Status, String> {
    blocking(move || {
        end_now(&app);
        Ok(status(&app, false))
    })
    .await
}

/// "+15 min": move the running block's end in the calendar. The next look
/// moves Focus's end with it.
#[tauri::command]
pub async fn focus_extend(app: AppHandle, minutes: u32) -> Result<Status, String> {
    blocking(move || {
        let s = settings(&app);
        let key = s.calendar.clone().ok_or("Choose a Focus calendar first.")?;
        let svc = app.state::<FocusService>();
        let a = svc.state().active.ok_or("No focus block is running.")?;
        let now = Local::now().naive_local();
        let list = blocks(&key, now.date()).ok_or("Calendar isn't ready yet.")?;
        // The block that ends last carries the run's end.
        let last = list
            .iter()
            .filter(|b| a.keys.contains(&b.key()))
            .max_by_key(|b| b.end)
            .ok_or("This block just changed in Calendar. Take another look.")?;
        let end = last.end + chrono::Duration::minutes(minutes.clamp(5, 120) as i64);
        crate::calendar::move_event(
            &last.id,
            &when(last.start),
            &when(last.start),
            &when(end),
            false,
        )?;
        svc.nudge();
        Ok(status(&app, false))
    })
    .await
}

/// A new focus block from `start` to `end` (local), with picked tasks.
#[tauri::command]
pub async fn focus_add_block(
    app: AppHandle,
    start: String,
    end: String,
    title: Option<String>,
    tasks: Vec<i64>,
) -> Result<crate::calendar::EventInfo, String> {
    blocking(move || {
        let s = settings(&app);
        if !s.enabled {
            return Err("Turn on Focus Blocks in Settings → Focus Blocks first.".into());
        }
        let key = s
            .calendar
            .clone()
            .ok_or("Choose a Focus calendar in Settings → Focus Blocks.")?;
        let title = title
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| CALENDAR_TITLE.to_string());
        let mut event = crate::calendar::create_event(&key, &title, &start, &end)?;
        event.focus = true;
        if let Some(at) = parse(&event.start) {
            let block = plan::key(&event.id, at);
            let state = app.state::<crate::AppState>();
            let store = state.store.lock().map_err(|e| e.to_string())?;
            store
                .set_focus_tasks(&block, &tasks)
                .map_err(|e| e.to_string())?;
        }
        let _ = app.emit("calendar-changed", ());
        app.state::<FocusService>().nudge();
        Ok(event)
    })
    .await
}

/// Delete one focus block occurrence (starting at `at`).
#[tauri::command]
pub async fn focus_delete_block(app: AppHandle, id: String, at: String) -> Result<(), String> {
    blocking(move || {
        let key = settings(&app)
            .calendar
            .ok_or("Choose a Focus calendar in Settings → Focus Blocks.")?;
        crate::calendar::delete_event(&id, &at, &key)?;
        let _ = app.emit("calendar-changed", ());
        app.state::<FocusService>().nudge();
        Ok(())
    })
    .await
}

/// The tasks picked for a block occurrence.
#[tauri::command]
pub fn focus_block_tasks(app: AppHandle, id: String, at: String) -> Result<Vec<i64>, String> {
    let at = parse(&at).ok_or("Not a time.")?;
    let state = app.state::<crate::AppState>();
    let store = state.store.lock().map_err(|e| e.to_string())?;
    store
        .focus_tasks(&plan::key(&id, at))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn focus_set_block_tasks(
    app: AppHandle,
    id: String,
    at: String,
    tasks: Vec<i64>,
) -> Result<(), String> {
    let at = parse(&at).ok_or("Not a time.")?;
    {
        let state = app.state::<crate::AppState>();
        let store = state.store.lock().map_err(|e| e.to_string())?;
        store
            .set_focus_tasks(&plan::key(&id, at), &tasks)
            .map_err(|e| e.to_string())?;
    }
    let _ = app.emit("focus-changed", ());
    Ok(())
}

/// A focus block was dragged in TodoCity's Calendar: its tasks go with it.
pub fn moved(app: &AppHandle, id: &str, from: &str, to: &str) {
    let (Some(from), Some(to)) = (parse(from), parse(to)) else {
        return;
    };
    let state = app.state::<crate::AppState>();
    if let Ok(store) = state.store.lock() {
        if let Err(e) = store.move_focus_block(&plan::key(id, from), &plan::key(id, to)) {
            log::warn!("focus: could not move a block's tasks: {e}");
        }
    }
    app.state::<FocusService>().nudge();
}

/// Open Shortcuts (or the link that adds TodoCity's shortcut).
#[tauri::command]
pub fn focus_open_shortcuts() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Only available on macOS.".into());
    }
    let mut cmd = Command::new("open");
    match SHORTCUT_LINK {
        Some(link) => cmd.arg(link),
        None => cmd.args(["-a", "Shortcuts"]),
    };
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// System Settings → Focus, to choose what's allowed through.
#[tauri::command]
pub fn focus_open_system_settings() -> Result<(), String> {
    if !cfg!(target_os = "macos") {
        return Err("Only available on macOS.".into());
    }
    Command::new("open")
        .arg("x-apple.systempreferences:com.apple.Focus-Settings.extension")
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
