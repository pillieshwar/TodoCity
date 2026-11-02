//! Keeping TodoCity in step with Things 3 or Todoist (the rules are in
//! `todocity_core::mirror` and `todocity_core::mirror_out`).
//!
//! * Things 3: its database on this Mac is checked every 15 seconds, and
//!   read (from a copy, as the import does) only when Things has saved since.
//! * Todoist: read every 5 minutes over its API, with the person's token
//!   kept in the macOS Keychain. Disconnecting deletes it.
//!
//! Todoist syncs both ways unless the person picks one-way: after each read,
//! changes made here go back through its API. Things comes into TodoCity.
//!
//! A project that starts here joins with "Sync with Todoist" (its ⋯ menu):
//! the project is made in Todoist, or linked to one there with the same name,
//! and the next pass sends its open tasks. One project at a time, never the
//! Inbox, never a project kept on this Mac only.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};
use todocity_core::mirror::{PassOptions, PassReport, Source};
use todocity_core::mirror_out::{OutOptions, Sent};
use todocity_core::things::{self, Options, Preview};
use todocity_core::todoist::{self, TodoistError};

use crate::{err, tray, AppState, CmdResult};

const KEYCHAIN_SERVICE: &str = "app.todocity.todoist";
const KEYCHAIN_ACCOUNT: &str = "api-token";
/// How often Things' database is checked for a save (cheap: one stat).
const THINGS_EVERY: Duration = Duration::from_secs(15);
/// How often Todoist is read.
const TODOIST_EVERY: Duration = Duration::from_secs(300);

/// One app being kept in step.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Link {
    /// RFC 3339: when syncing began.
    pub since: String,
    /// When the last pass went through.
    pub last: Option<String>,
    /// What went wrong on the last try, if it did.
    pub error: Option<String>,
    /// Things: a database picked by hand, when it isn't the usual one.
    pub path: Option<String>,
    /// Things: the save that was read last (its modification time).
    pub seen: Option<String>,
    /// Changes here go back to the app too. On unless the person picks
    /// one-way (links saved before two-way existed turn it on).
    #[serde(default = "yes")]
    pub two_way: bool,
    /// Two-way has been set up: tasks deleted here while it was one-way
    /// were let go (they stay in the other app).
    pub two_way_ready: bool,
}

fn yes() -> bool {
    true
}

impl Default for Link {
    fn default() -> Self {
        Self {
            since: String::new(),
            last: None,
            error: None,
            path: None,
            seen: None,
            two_way: true,
            two_way_ready: false,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Cfg {
    things: Option<Link>,
    todoist: Option<Link>,
}

pub struct Mirror {
    path: PathBuf,
    cfg: Mutex<Cfg>,
    /// One pass at a time.
    busy: tokio::sync::Mutex<()>,
    wake: tokio::sync::Notify,
    todoist_at: Mutex<Option<Instant>>,
}

/// What Settings shows about one app.
#[derive(Debug, Clone, Serialize)]
pub struct LinkStatus {
    pub since: String,
    pub last: Option<String>,
    pub error: Option<String>,
    /// Projects kept in step right now.
    pub projects: usize,
    /// Changes here go back to the app.
    pub two_way: bool,
    /// The app can take changes back (Things: coming soon).
    pub can_two_way: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct MirrorStatus {
    pub things: Option<LinkStatus>,
    pub todoist: Option<LinkStatus>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Which {
    Things,
    Todoist,
}

impl Which {
    fn parse(s: &str) -> CmdResult<Self> {
        match s {
            "things" | "things3" => Ok(Self::Things),
            "todoist" => Ok(Self::Todoist),
            _ => Err(format!("Unknown app: {s}")),
        }
    }
    fn source(self) -> &'static str {
        match self {
            Self::Things => things::SOURCE,
            Self::Todoist => todoist::SOURCE,
        }
    }
    /// Changes here can go back to this app.
    fn can_two_way(self) -> bool {
        self == Self::Todoist
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn keychain() -> Option<keyring::Entry> {
    keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).ok()
}

fn modified(p: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// When Things last saved: its database or the write-ahead log beside it.
fn things_saved(db: &Path) -> Option<String> {
    let mut wal = db.as_os_str().to_owned();
    wal.push("-wal");
    let t = [modified(db), modified(Path::new(&wal))]
        .into_iter()
        .flatten()
        .max()?;
    Some(DateTime::<Utc>::from(t).to_rfc3339())
}

impl Mirror {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join("mirror.json");
        let cfg = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Self {
            path,
            cfg: Mutex::new(cfg),
            busy: tokio::sync::Mutex::new(()),
            wake: tokio::sync::Notify::new(),
            todoist_at: Mutex::new(None),
        }
    }

    fn cfg(&self) -> Cfg {
        self.cfg.lock().map(|c| c.clone()).unwrap_or_default()
    }

    fn edit(&self, which: Which, f: impl FnOnce(&mut Option<Link>)) {
        let Ok(mut c) = self.cfg.lock() else {
            return;
        };
        f(match which {
            Which::Things => &mut c.things,
            Which::Todoist => &mut c.todoist,
        });
        if let Ok(json) = serde_json::to_vec_pretty(&*c) {
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }

    fn link(&self, which: Which) -> Option<Link> {
        let c = self.cfg();
        match which {
            Which::Things => c.things,
            Which::Todoist => c.todoist,
        }
    }

    /// Check now rather than at the next tick.
    fn poke(&self) {
        if let Ok(mut at) = self.todoist_at.lock() {
            *at = None;
        }
        self.wake.notify_one();
    }

    /// The background loop: Things every 15 s (when it has saved), Todoist
    /// every 5 minutes.
    pub fn start(app: &AppHandle) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            // Let the app finish opening first.
            tokio::time::sleep(Duration::from_secs(5)).await;
            loop {
                let m = app.state::<Mirror>();
                if m.link(Which::Things).is_some() {
                    let _ = pass(&app, Which::Things, false).await;
                }
                let due = m
                    .todoist_at
                    .lock()
                    .map(|at| (*at).map_or(true, |t| t.elapsed() >= TODOIST_EVERY))
                    .unwrap_or(true);
                if due && m.link(Which::Todoist).is_some() {
                    let _ = pass(&app, Which::Todoist, false).await;
                }
                tokio::select! {
                    _ = tokio::time::sleep(THINGS_EVERY) => {}
                    _ = m.wake.notified() => {}
                }
            }
        });
    }
}

/// One pass for `which`. `Ok(None)`: nothing to do (not connected, or Things
/// hasn't saved since last time).
async fn pass(app: &AppHandle, which: Which, force: bool) -> CmdResult<Option<PassReport>> {
    let m = app.state::<Mirror>();
    let _one = m.busy.lock().await;
    let Some(link) = m.link(which) else {
        return Ok(None);
    };
    let result = match which {
        Which::Things => things_pass(app, &link, force).await,
        Which::Todoist => {
            if let Ok(mut at) = m.todoist_at.lock() {
                *at = Some(Instant::now());
            }
            todoist_pass(app, &link).await
        }
    };
    match &result {
        Ok(Some((report, seen))) => {
            let (report, seen) = (report.clone(), seen.clone());
            for e in &report.errors {
                log::warn!("sync from {}: {e}", which.source());
            }
            m.edit(which, |l| {
                if let Some(l) = l {
                    l.last = Some(now());
                    // What needs the person's attention (a held-back
                    // removal, a change Todoist didn't take), if anything.
                    l.error = report.errors.first().cloned();
                    if seen.is_some() {
                        l.seen = seen;
                    }
                }
            });
            if report.added + report.updated + report.removed > 0 {
                log::info!(
                    "sync from {}: {} added, {} updated, {} removed",
                    which.source(),
                    report.added,
                    report.updated,
                    report.removed
                );
                let _ = app.emit("tasks-changed", ());
                tray::refresh(app);
            }
        }
        Ok(None) => {}
        Err(e) => {
            log::warn!("sync from {} failed: {e}", which.source());
            let e = e.clone();
            m.edit(which, |l| {
                if let Some(l) = l {
                    l.error = Some(e);
                }
            });
        }
    }
    let _ = app.emit("mirror-changed", ());
    result.map(|r| r.map(|(report, _)| report))
}

async fn things_pass(
    app: &AppHandle,
    link: &Link,
    force: bool,
) -> CmdResult<Option<(PassReport, Option<String>)>> {
    let db = crate::import::locate(link.path.as_deref())?;
    let saved = things_saved(&db);
    if !force && saved.is_some() && saved == link.seen {
        return Ok(None);
    }
    let app = app.clone();
    let since = link.since.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let lib = things::read_copy(&db, &state.data_dir).map_err(crate::import::friendly)?;
        let opts = Options {
            include_done: true,
            ..Default::default()
        };
        // Days as Things has them; the store shows passed ones as today.
        let plan = things::plan(&lib, &opts, &HashSet::new(), chrono::NaiveDate::MIN);
        let report = apply(
            &state,
            things::SOURCE,
            &plan.preview,
            &plan.floors,
            &plan.items,
            &since,
            false,
        )?;
        Ok(Some((report, saved)))
    })
    .await
    .map_err(err)?
}

async fn todoist_pass(
    app: &AppHandle,
    link: &Link,
) -> CmdResult<Option<(PassReport, Option<String>)>> {
    let token = keychain()
        .and_then(|k| k.get_password().ok())
        .ok_or("Connect Todoist again in Settings → Connectors to keep it in sync.")?;
    let client = reqwest::Client::builder()
        .user_agent(concat!("TodoCity/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(err)?;
    let parse = |s: &str| {
        DateTime::parse_from_rfc3339(s)
            .ok()
            .map(|t| t.with_timezone(&Utc))
    };
    let from = link
        .last
        .as_deref()
        .and_then(parse)
        .or(parse(&link.since))
        .unwrap_or_else(Utc::now)
        - chrono::Duration::days(1);
    let lib = todoist::fetch_live(&client, todoist::API_BASE, &token, from, Utc::now())
        .await
        .map_err(|e| match e {
            TodoistError::BadToken => {
                "Todoist no longer accepts the saved token. Connect it again in Settings → Connectors.".to_string()
            }
            e => e.to_string(),
        })?;
    let opts = Options {
        include_done: true,
        ..Default::default()
    };
    let today = chrono::Local::now().date_naive();
    let plan = todoist::plan(&lib, &opts, &HashSet::new(), today);
    let state = app.state::<AppState>();
    let two_way = link.two_way;
    if two_way && !link.two_way_ready {
        let store = state.store.lock().map_err(err)?;
        let let_go = store.mirror_start_two_way(todoist::SOURCE).map_err(err)?;
        drop(store);
        if let_go > 0 {
            log::info!(
                "two-way sync with Todoist: {let_go} tasks deleted here earlier stay in Todoist"
            );
        }
        app.state::<Mirror>().edit(Which::Todoist, |l| {
            if let Some(l) = l {
                l.two_way_ready = true;
            }
        });
    }
    let mut report = apply(
        &state,
        todoist::SOURCE,
        &plan.preview,
        &plan.floors,
        &plan.items,
        &link.since,
        two_way,
    )?;
    if two_way {
        let sent = send_changes(app, &client, &token, &lib).await?;
        report.updated += sent.0;
        report.errors.extend(sent.1);
    }
    Ok(Some((report, None)))
}

/// Two-way: send what changed here to Todoist. Returns how many changes
/// went, and what didn't.
async fn send_changes(
    app: &AppHandle,
    client: &reqwest::Client,
    token: &str,
    lib: &todoist::Library,
) -> CmdResult<(usize, Vec<String>)> {
    let state = app.state::<AppState>();
    let device = crate::sync::this_device(app);
    let local_only = crate::sync::local_only_projects(app);
    let outbox = {
        let store = state.store.lock().map_err(err)?;
        store
            .mirror_outbox(
                todoist::SOURCE,
                &OutOptions {
                    today: chrono::Local::now().date_naive(),
                    extras: todocity_core::todoist_push::EXTRAS,
                    device: device.as_deref(),
                    now_ms: Utc::now().timestamp_millis(),
                    local_only: &local_only,
                },
            )
            .map_err(err)?
    };
    let mut errors = outbox.errors;
    if outbox.ops.is_empty() {
        return Ok((0, errors));
    }
    let results =
        todocity_core::todoist_push::push(client, todoist::API_BASE, token, lib, &outbox.ops).await;
    let mut done = 0;
    let store = state.store.lock().map_err(err)?;
    for (op, sent) in outbox.ops.iter().zip(&results) {
        if let Sent::Failed(e) = sent {
            errors.push(format!("{}: {e}", op.title()));
        } else {
            done += 1;
        }
        store.mirror_sent(todoist::SOURCE, op, sent).map_err(err)?;
    }
    if done > 0 {
        log::info!("sync to Todoist: {done} changes sent");
    }
    Ok((done, errors))
}

fn apply(
    state: &AppState,
    source: &str,
    preview: &Preview,
    floors: &[(String, Option<String>)],
    items: &[todocity_core::Imported],
    since: &str,
    two_way: bool,
) -> CmdResult<PassReport> {
    let store = state.store.lock().map_err(err)?;
    store
        .mirror(
            &Source {
                source,
                buildings: preview
                    .buildings
                    .iter()
                    .map(|b| (b.key.clone(), b.name.clone()))
                    .collect(),
                floors,
                items,
                complete: true,
            },
            &PassOptions {
                today: chrono::Local::now().date_naive(),
                since,
                two_way,
            },
        )
        .map_err(err)
}

/// Start keeping `which` in step, right after it was imported. Projects
/// left out of the import stay out.
pub fn begin(
    app: &AppHandle,
    which: &str,
    path: Option<String>,
    token: Option<String>,
    preview: &Preview,
    skip: &[String],
) -> CmdResult<()> {
    let which = Which::parse(which)?;
    if which == Which::Todoist {
        let token = token
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .ok_or("Connect Todoist with your API token to keep it in sync.")?;
        keychain()
            .ok_or("Couldn't open the Keychain.")?
            .set_password(&token)
            .map_err(|e| format!("Couldn't save the Todoist token in the Keychain: {e}"))?;
    }
    let skipped: Vec<(String, String)> = preview
        .buildings
        .iter()
        .filter(|b| skip.contains(&b.key) && b.key != things::LOOSE_KEY)
        .map(|b| (b.key.clone(), b.name.clone()))
        .collect();
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(err)?;
        store
            .stop_mirroring_keys(which.source(), &skipped)
            .map_err(err)?;
    }
    let m = app.state::<Mirror>();
    m.edit(which, |l| {
        *l = Some(Link {
            since: now(),
            path: path.filter(|p| !p.trim().is_empty()),
            ..Default::default()
        })
    });
    m.poke();
    let _ = app.emit("mirror-changed", ());
    Ok(())
}

// ── Commands ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn mirror_status(
    state: State<'_, AppState>,
    mirror: State<'_, Mirror>,
) -> CmdResult<MirrorStatus> {
    let c = mirror.cfg();
    let store = state.store.lock().map_err(err)?;
    let count = |source: &str| -> usize {
        store
            .mirror_projects(Some(source))
            .map(|v| v.iter().filter(|p| !p.stopped).count())
            .unwrap_or(0)
    };
    let status = |l: Option<Link>, which: Which| {
        l.map(|l| LinkStatus {
            since: l.since,
            last: l.last,
            error: l.error,
            projects: count(which.source()),
            two_way: l.two_way && which.can_two_way(),
            can_two_way: which.can_two_way(),
        })
    };
    Ok(MirrorStatus {
        things: status(c.things, Which::Things),
        todoist: status(c.todoist, Which::Todoist),
    })
}

/// Bring changes in now.
#[tauri::command]
pub async fn mirror_sync_now(app: AppHandle, source: String) -> CmdResult<Option<PassReport>> {
    pass(&app, Which::parse(&source)?, true).await
}

/// Stop keeping an app in step. Its tasks stay, as ordinary tasks; the
/// Todoist token is deleted from the Keychain.
#[tauri::command]
pub async fn mirror_stop(app: AppHandle, source: String) -> CmdResult<()> {
    let which = Which::parse(&source)?;
    let m = app.state::<Mirror>();
    let _one = m.busy.lock().await;
    m.edit(which, |l| *l = None);
    if which == Which::Todoist {
        if let Some(k) = keychain() {
            let _ = k.delete_credential();
        }
    }
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(err)?;
        store.forget_mirror(which.source()).map_err(err)?;
    }
    let _ = app.emit("mirror-changed", ());
    let _ = app.emit("tasks-changed", ());
    Ok(())
}

/// Two-way (changes here go back to the app) or one-way (they stay here).
#[tauri::command]
pub async fn mirror_set_two_way(app: AppHandle, source: String, on: bool) -> CmdResult<()> {
    let which = Which::parse(&source)?;
    if on && !which.can_two_way() {
        return Err("Two-way sync with Things comes in a coming update.".into());
    }
    let m = app.state::<Mirror>();
    {
        let _one = m.busy.lock().await;
        m.edit(which, |l| {
            if let Some(l) = l {
                l.two_way = on;
                // Turning it on again lets go of what was deleted meanwhile.
                l.two_way_ready = false;
            }
        });
    }
    m.poke();
    let _ = app.emit("mirror-changed", ());
    Ok(())
}

/// Stop keeping one project in step; the rest carry on.
#[tauri::command]
pub fn mirror_stop_project(app: AppHandle, name: String) -> CmdResult<bool> {
    let stopped = {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(err)?;
        store.stop_mirroring_project(&name).map_err(err)?
    };
    let _ = app.emit("mirror-changed", ());
    let _ = app.emit("tasks-changed", ());
    Ok(stopped)
}

/// How "Sync with Todoist" went.
#[derive(Debug, Clone, Serialize)]
pub struct ProjectSynced {
    /// Todoist already had a project with that name; the two are linked.
    pub joined: bool,
}

/// The projects here that could start syncing with Todoist now: with
/// two-way Todoist sync on, every project not synced with an app yet and
/// not kept on this Mac only.
#[tauri::command]
pub fn mirror_syncable(app: AppHandle) -> CmdResult<Vec<String>> {
    let on = app
        .state::<Mirror>()
        .link(Which::Todoist)
        .is_some_and(|l| l.two_way);
    if !on {
        return Ok(Vec::new());
    }
    let local_only: HashSet<String> = crate::sync::local_only_projects(&app)
        .into_iter()
        .map(|p| p.to_lowercase())
        .collect();
    let state = app.state::<AppState>();
    let store = state.store.lock().map_err(err)?;
    Ok(store
        .projects()
        .map_err(err)?
        .into_iter()
        .filter(|p| p.synced.is_none() && !local_only.contains(&p.name.to_lowercase()))
        .map(|p| p.name)
        .collect())
}

/// "Sync with Todoist": make project `name` in Todoist with its sections
/// (or link it to Todoist's project of that name), then let the next pass
/// send its open tasks.
#[tauri::command]
pub async fn mirror_sync_project(app: AppHandle, name: String) -> CmdResult<ProjectSynced> {
    let m = app.state::<Mirror>();
    let link = m
        .link(Which::Todoist)
        .ok_or("Connect Todoist in Settings → Connectors to sync projects with it.")?;
    if !link.two_way {
        return Err(
            "Switch Todoist to two-way in Settings → Connectors to send projects there.".into(),
        );
    }
    let local_only = crate::sync::local_only_projects(&app);
    if local_only
        .iter()
        .any(|p| p.to_lowercase() == name.to_lowercase())
    {
        return Err(format!(
            "{name} is kept on this Mac only. Switch that off in Settings → Sync to send it to Todoist."
        ));
    }
    let token = keychain()
        .and_then(|k| k.get_password().ok())
        .ok_or("Connect Todoist again in Settings → Connectors to keep it in sync.")?;
    let _one = m.busy.lock().await;
    let source = todoist::SOURCE;
    let state = app.state::<AppState>();
    // Already syncing (another window, or a double click): nothing to do.
    let (taken, floors) = {
        let store = state.store.lock().map_err(err)?;
        let projects = store.mirror_projects(None).map_err(err)?;
        if projects
            .iter()
            .any(|p| !p.stopped && p.project.to_lowercase() == name.to_lowercase())
        {
            return Ok(ProjectSynced { joined: false });
        }
        let taken: HashSet<String> = projects
            .into_iter()
            .filter(|p| !p.stopped && p.source == source)
            .map(|p| p.key)
            .collect();
        let floors: Vec<String> = store
            .floors()
            .map_err(err)?
            .into_iter()
            .filter(|f| f.project.to_lowercase() == name.to_lowercase())
            .map(|f| f.name)
            .collect();
        (taken, floors)
    };
    let client = reqwest::Client::builder()
        .user_agent(concat!("TodoCity/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(err)?;
    let read = |lib: Result<todoist::Library, TodoistError>| {
        lib.map_err(|e| match e {
            TodoistError::BadToken => {
                "Todoist no longer accepts the saved token. Connect it again in Settings → Connectors.".to_string()
            }
            e => e.to_string(),
        })
    };
    let since = DateTime::parse_from_rfc3339(&link.since)
        .map(|t| t.with_timezone(&Utc))
        .unwrap_or_else(|_| Utc::now());
    let mut lib =
        read(todoist::fetch_live(&client, todoist::API_BASE, &token, since, Utc::now()).await)?;
    use todocity_core::todoist_push::{make_project, missing_sections, same_name_project};
    let found = same_name_project(&lib, &name, &taken).map(|p| (p.id.clone(), p.name.clone()));
    let (key, there, joined) = match found {
        Some((id, there)) => {
            let need = missing_sections(&lib, Some(&id), &floors);
            if !need.is_empty() {
                // A section that doesn't take now comes with its first task.
                if let Err(e) =
                    make_project(&client, todoist::API_BASE, &token, &name, Some(&id), &need).await
                {
                    log::warn!("sections for {name} in Todoist: {e}");
                }
            }
            (id, there, true)
        }
        None => {
            let need = missing_sections(&lib, None, &floors);
            match make_project(&client, todoist::API_BASE, &token, &name, None, &need).await? {
                Some(id) => (id, name.trim().to_string(), false),
                None => {
                    // Another Mac made it a moment ago: link to that one.
                    lib = read(
                        todoist::fetch_live(&client, todoist::API_BASE, &token, since, Utc::now())
                            .await,
                    )?;
                    let p = same_name_project(&lib, &name, &taken).ok_or_else(|| {
                        format!("Todoist is still setting up {name}. Choose Sync with Todoist again in a moment.")
                    })?;
                    (p.id.clone(), p.name.clone(), true)
                }
            }
        }
    };
    let live: HashSet<String> = lib.tasks.iter().map(|t| t.id.clone()).collect();
    let linked = {
        let store = state.store.lock().map_err(err)?;
        store
            .mirror_link_project(source, &name, &key, &there, joined, &live)
            .map_err(err)?
    };
    if !linked {
        return Err(format!(
            "Todoist's {there} already syncs with another project here. Rename {name} to sync it as a new project."
        ));
    }
    log::info!("{name} now syncs with Todoist");
    drop(_one);
    m.poke();
    let _ = app.emit("mirror-changed", ());
    let _ = app.emit("tasks-changed", ());
    Ok(ProjectSynced { joined })
}
