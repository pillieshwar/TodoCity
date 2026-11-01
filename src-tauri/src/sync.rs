//! Sync between the person's Macs (see `todocity_core::sync`): the group
//! key in the Keychain, pairing, and a background round every 30 seconds
//! (sooner after a change here).
//!
//! What's kept where:
//! * the group key — the login Keychain (a file next to the database on
//!   other systems);
//! * this Mac's id, name, relay and This-Mac-only projects — `sync.json`;
//! * what was last synced (the shadow) and the read position — the task
//!   database itself, so they always match the tasks.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Listener, Manager, State};
use todocity_core::sync::{self, crypto, pair, GroupKey, Membership, Relay, RelayError};

use crate::{tray, AppState, CmdResult};

pub const DEFAULT_RELAY: &str = "https://todocity-relay.todocity.workers.dev";
const ROUND: Duration = Duration::from_secs(30);
const PAIR_FOR: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
struct Config {
    on: bool,
    device: String,
    /// The person's own name for this Mac; otherwise the Mac's name.
    name: Option<String>,
    relay: String,
    local_only: Vec<String>,
    /// When each other Mac was last heard from (RFC 3339).
    seen: BTreeMap<String, String>,
    /// Shown once: another Mac removed this one.
    removed_notice: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
struct Health {
    last_ok: Option<String>,
    error: Option<String>,
    busy: bool,
}

enum Role {
    Host(pair::Host),
    Join(pair::Joiner),
}

struct Pairing {
    id: u64,
    code: String,
    role: Role,
    heard: usize,
    confirmed: bool,
    stage: &'static str,
    error: Option<String>,
}

pub struct SyncService {
    path: PathBuf,
    key_file: PathBuf,
    cfg: Mutex<Config>,
    key: Mutex<Option<GroupKey>>,
    health: Mutex<Health>,
    pairing: Mutex<Option<Pairing>>,
    wake: tokio::sync::Notify,
    next_pair: Mutex<u64>,
}

// ── Keys ───────────────────────────────────────────────────────────────────

#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "app.todocity.sync";
#[cfg(target_os = "macos")]
const KEYCHAIN_ACCOUNT: &str = "group-key";

/// Projects kept on this Mac only (they never leave it: not to other Macs,
/// and not to calendar apps either).
pub fn local_only_projects(app: &AppHandle) -> std::collections::HashSet<String> {
    app.try_state::<SyncService>()
        .and_then(|s| {
            s.cfg
                .lock()
                .ok()
                .map(|c| c.local_only.iter().cloned().collect())
        })
        .unwrap_or_default()
}

/// This Mac's id in Mac-to-Mac sync, when sync is on.
pub fn this_device(app: &AppHandle) -> Option<String> {
    app.try_state::<SyncService>().and_then(|s| {
        s.cfg
            .lock()
            .ok()
            .filter(|c| c.on && !c.device.is_empty())
            .map(|c| c.device.clone())
    })
}

impl SyncService {
    pub fn new(data_dir: &std::path::Path) -> Self {
        let path = data_dir.join("sync.json");
        let mut cfg: Config = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        if cfg.device.is_empty() {
            cfg.device = crypto::random_id(12).unwrap_or_else(|_| "mac".into());
        }
        if cfg.relay.is_empty() {
            cfg.relay = DEFAULT_RELAY.into();
        }
        let s = Self {
            path,
            key_file: data_dir.join("sync.key"),
            cfg: Mutex::new(cfg),
            key: Mutex::new(None),
            health: Mutex::new(Health::default()),
            pairing: Mutex::new(None),
            wake: tokio::sync::Notify::new(),
            next_pair: Mutex::new(0),
        };
        let on = s.cfg().on;
        if on {
            match s.load_key() {
                Some(k) => *s.key.lock().unwrap() = Some(k),
                None => {
                    log::warn!("sync: on, but the group key is missing; turning sync off");
                    s.edit(|c| c.on = false);
                }
            }
        }
        s.save();
        s
    }

    fn cfg(&self) -> Config {
        self.cfg.lock().map(|c| c.clone()).unwrap_or_default()
    }

    fn edit(&self, f: impl FnOnce(&mut Config)) {
        if let Ok(mut c) = self.cfg.lock() {
            f(&mut c);
        }
        self.save();
    }

    fn save(&self) {
        let c = self.cfg();
        if let Ok(json) = serde_json::to_vec_pretty(&c) {
            let tmp = self.path.with_extension("json.tmp");
            if std::fs::write(&tmp, json).is_ok() {
                let _ = std::fs::rename(&tmp, &self.path);
            }
        }
    }

    fn load_key(&self) -> Option<GroupKey> {
        #[cfg(target_os = "macos")]
        {
            let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT).ok()?;
            GroupKey::from_text(&entry.get_password().ok()?)
        }
        #[cfg(not(target_os = "macos"))]
        {
            GroupKey::from_text(&std::fs::read_to_string(&self.key_file).ok()?)
        }
    }

    fn store_key(&self, key: Option<&GroupKey>) -> Result<(), String> {
        #[cfg(target_os = "macos")]
        {
            let _ = &self.key_file;
            let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
                .map_err(|e| e.to_string())?;
            match key {
                Some(k) => entry
                    .set_password(&k.to_text())
                    .map_err(|e| format!("Couldn't save the sync key in the Keychain: {e}"))?,
                None => {
                    let _ = entry.delete_credential();
                }
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            match key {
                Some(k) => {
                    std::fs::write(&self.key_file, k.to_text()).map_err(|e| e.to_string())?;
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = std::fs::set_permissions(
                            &self.key_file,
                            std::fs::Permissions::from_mode(0o600),
                        );
                    }
                }
                None => {
                    let _ = std::fs::remove_file(&self.key_file);
                }
            }
        }
        *self.key.lock().map_err(|e| e.to_string())? = key.cloned();
        Ok(())
    }

    fn membership(&self) -> Option<Membership> {
        let c = self.cfg();
        if !c.on {
            return None;
        }
        let key = self.key.lock().ok()?.clone()?;
        Some(Membership {
            key,
            device: c.device.clone(),
            name: self.name(&c),
            local_only: c.local_only.iter().cloned().collect::<HashSet<_>>(),
        })
    }

    fn name(&self, c: &Config) -> String {
        c.name
            .clone()
            .filter(|n| !n.trim().is_empty())
            .unwrap_or_else(mac_name)
    }

    fn relay(&self) -> Relay {
        let c = self.cfg();
        Relay::new(&c.relay, &c.device)
    }

    pub fn nudge(&self) {
        self.wake.notify_one();
    }

    fn set_health(&self, f: impl FnOnce(&mut Health)) {
        if let Ok(mut h) = self.health.lock() {
            f(&mut h);
        }
    }
}

/// The Mac's name as set in System Settings → General → Sharing.
fn mac_name() -> String {
    #[cfg(target_os = "macos")]
    {
        if let Ok(out) = std::process::Command::new("/usr/sbin/scutil")
            .args(["--get", "ComputerName"])
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if out.status.success() && !s.is_empty() {
                return s;
            }
        }
    }
    std::env::var("HOSTNAME")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "This Mac".into())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn friendly(e: &sync::SyncError) -> String {
    match e {
        sync::SyncError::Relay(RelayError::Network(_)) => {
            "Offline: changes will sync when this Mac is back online.".into()
        }
        other => {
            let s = other.to_string();
            let mut c = s.chars();
            match c.next() {
                Some(f) => f.to_uppercase().collect::<String>() + c.as_str() + ".",
                None => s,
            }
        }
    }
}

// ── The background round ───────────────────────────────────────────────────

pub fn start(app: &AppHandle) {
    // A change anywhere in the app wakes sync (a moment later, so a burst
    // of edits goes out together).
    let handle = app.clone();
    app.listen_any("tasks-changed", move |_| {
        if let Some(s) = handle.try_state::<SyncService>() {
            s.nudge();
        }
    });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut wait = ROUND;
        loop {
            let svc = app.state::<SyncService>();
            let woke = tokio::time::timeout(wait, svc.wake.notified())
                .await
                .is_ok();
            if woke {
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            wait = match round(&app).await {
                Ok(()) => ROUND,
                // Back off while offline or refused: 1, 2, 4… up to 5 minutes.
                Err(()) => (wait * 2).clamp(Duration::from_secs(60), Duration::from_secs(300)),
            };
        }
    });
}

/// One round, if sync is on. Err when it failed (for backing off).
async fn round(app: &AppHandle) -> Result<(), ()> {
    let svc = app.state::<SyncService>();
    let Some(me) = svc.membership() else {
        return Ok(());
    };
    if svc.health.lock().map(|h| h.busy).unwrap_or(true) {
        return Ok(());
    }
    svc.set_health(|h| h.busy = true);
    let state = app.state::<AppState>();
    let result = sync::cycle(&svc.relay(), &me, &state.store).await;
    svc.set_health(|h| h.busy = false);
    match result {
        Ok(report) => {
            if report.sent + report.received > 0 {
                log::info!(
                    "sync: sent {} and took in {} changes ({} things changed here)",
                    report.sent,
                    report.received,
                    report.changed
                );
            }
            let at = now();
            svc.edit(|c| {
                for d in &report.heard {
                    c.seen.insert(d.clone(), at.clone());
                }
                for (d, ms) in &report.seen {
                    if let Some(t) = chrono::DateTime::from_timestamp_millis(*ms) {
                        let t = t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true);
                        let e = c.seen.entry(d.clone()).or_default();
                        if t > *e {
                            *e = t;
                        }
                    }
                }
            });
            svc.set_health(|h| {
                h.last_ok = Some(at.clone());
                h.error = None;
            });
            if report.changed > 0 {
                let _ = app.emit("tasks-changed", ());
                tray::refresh(app);
            }
            if report.removed {
                log::info!("sync: another Mac removed this one from the group");
                forget(app, true);
            }
            let _ = app.emit("sync-changed", ());
            Ok(())
        }
        Err(e) => {
            log::warn!("sync: {e}");
            if matches!(e, sync::SyncError::Relay(RelayError::Gone)) {
                forget(app, true);
            }
            svc.set_health(|h| h.error = Some(friendly(&e)));
            let _ = app.emit("sync-changed", ());
            Err(())
        }
    }
}

/// Stop syncing on this Mac and forget the group (tasks stay).
fn forget(app: &AppHandle, removed: bool) {
    let svc = app.state::<SyncService>();
    if let Err(e) = svc.store_key(None) {
        log::warn!("sync: couldn't remove the key: {e}");
    }
    svc.edit(|c| {
        c.on = false;
        c.seen.clear();
        c.removed_notice = removed;
    });
    if let Ok(store) = app.state::<AppState>().store.lock() {
        if let Err(e) = store.sync_reset() {
            log::warn!("sync: couldn't reset: {e}");
        }
    }
    let _ = app.emit("sync-changed", ());
}

/// A backup replaced the tasks. With sync on, the restored copy is what
/// counts from now on: it goes out as new, and the other Macs are asked for
/// anything it doesn't have.
pub fn after_restore(app: &AppHandle) {
    let svc = app.state::<SyncService>();
    let Some(me) = svc.membership() else {
        return;
    };
    {
        let state = app.state::<AppState>();
        let locked = state.store.lock();
        if let Ok(store) = &locked {
            if let Err(e) = store.sync_reset() {
                log::warn!("sync: couldn't reset after restoring: {e}");
            }
        }
    }
    let relay = svc.relay();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = sync::ask_resync(&relay, &me).await {
            log::warn!("sync: couldn't ask the other Macs for a copy: {e}");
        }
    });
    svc.nudge();
}

// ── What the UI shows ──────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct DeviceView {
    id: String,
    name: String,
    me: bool,
    last_seen: Option<String>,
}

#[derive(Serialize)]
pub struct PairView {
    role: &'static str,
    code: String,
    /// waiting · compare · finishing · done · failed
    stage: &'static str,
    sas: Option<String>,
    confirmed: bool,
    error: Option<String>,
}

#[derive(Serialize)]
pub struct SyncStatus {
    on: bool,
    name: String,
    devices: Vec<DeviceView>,
    local_only: Vec<String>,
    last_ok: Option<String>,
    error: Option<String>,
    busy: bool,
    pending: i64,
    removed_notice: bool,
    pairing: Option<PairView>,
}

fn pair_view(p: &Pairing) -> PairView {
    let (role, sas) = match &p.role {
        Role::Host(h) => ("host", h.sas().map(str::to_string)),
        Role::Join(j) => ("join", j.sas().map(str::to_string)),
    };
    PairView {
        role,
        code: format!("{}-{}", &p.code[..4], &p.code[4..]),
        stage: p.stage,
        sas,
        confirmed: p.confirmed,
        error: p.error.clone(),
    }
}

#[tauri::command]
pub fn sync_status(
    svc: State<'_, SyncService>,
    state: State<'_, AppState>,
) -> CmdResult<SyncStatus> {
    let c = svc.cfg();
    let health = svc.health.lock().map(|h| h.clone()).unwrap_or_default();
    let (devices, pending) = match state.store.lock() {
        Ok(s) if c.on => (
            s.sync_devices().unwrap_or_default(),
            s.sync_pending_count().unwrap_or(0),
        ),
        _ => (vec![], 0),
    };
    let mut devices: Vec<DeviceView> = devices
        .into_iter()
        .filter(|d| !d.removed)
        .map(|d| DeviceView {
            me: d.id == c.device,
            last_seen: c.seen.get(&d.id).cloned(),
            name: if d.id == c.device {
                svc.name(&c)
            } else {
                d.name
            },
            id: d.id,
        })
        .collect();
    if c.on && !devices.iter().any(|d| d.me) {
        devices.insert(
            0,
            DeviceView {
                id: c.device.clone(),
                name: svc.name(&c),
                me: true,
                last_seen: None,
            },
        );
    }
    devices.sort_by_key(|d| !d.me);
    let pairing = svc
        .pairing
        .lock()
        .ok()
        .and_then(|p| p.as_ref().map(pair_view));
    Ok(SyncStatus {
        on: c.on,
        name: svc.name(&c),
        devices,
        local_only: c.local_only.clone(),
        last_ok: health.last_ok,
        error: health.error,
        busy: health.busy,
        pending,
        removed_notice: c.removed_notice,
        pairing,
    })
}

// ── Pairing ────────────────────────────────────────────────────────────────

fn new_pairing(svc: &SyncService, code: String, role: Role) -> u64 {
    let id = {
        let mut n = svc.next_pair.lock().unwrap_or_else(|e| e.into_inner());
        *n += 1;
        *n
    };
    if let Ok(mut p) = svc.pairing.lock() {
        *p = Some(Pairing {
            id,
            code,
            role,
            heard: 0,
            confirmed: false,
            stage: "waiting",
            error: None,
        });
    }
    id
}

/// Show a code so another Mac can join. Turns sync on here if it isn't yet.
#[tauri::command]
pub async fn sync_add_mac(app: AppHandle) -> CmdResult<()> {
    let svc = app.state::<SyncService>();
    if !svc.cfg().on {
        let key = GroupKey::generate().map_err(|e| e.to_string())?;
        svc.store_key(Some(&key))?;
        {
            let state = app.state::<AppState>();
            let store = state.store.lock().map_err(|e| e.to_string())?;
            store.sync_reset().map_err(|e| e.to_string())?;
        }
        svc.edit(|c| {
            c.on = true;
            c.removed_notice = false;
            c.seen.clear();
        });
        log::info!("sync: started a new group on this Mac");
    }
    let relay = svc.relay();
    svc.membership().ok_or("Sync couldn't start.")?;
    let mut opened = None;
    for _ in 0..3 {
        let code = crypto::room_code().map_err(|e| e.to_string())?;
        let (host, first) = pair::Host::new(&code).map_err(|e| e.to_string())?;
        match relay.open_room(&code, &first).await {
            Ok(()) => {
                opened = Some((code, host));
                break;
            }
            Err(RelayError::Other(_)) => continue, // taken: try another code
            Err(e) => return Err(e.to_string()),
        }
    }
    let (code, host) = opened.ok_or("Couldn't open a pairing code. Try again.")?;
    let id = new_pairing(&svc, code, Role::Host(host));
    let _ = app.emit("sync-changed", ());
    tauri::async_runtime::spawn(drive(app.clone(), id));
    // Send what's here now, so it's ready for the new Mac.
    svc.nudge();
    Ok(())
}

/// Join another Mac's group with the code it shows.
#[tauri::command]
pub async fn sync_join(app: AppHandle, code: String) -> CmdResult<()> {
    let svc = app.state::<SyncService>();
    if svc.cfg().on {
        return Err(
            "This Mac already syncs. Turn sync off here first to join another group.".into(),
        );
    }
    let code = crypto::clean_code(&code)
        .ok_or("That code should be 8 letters and numbers, like K7MX-4QRB.")?;
    let c = svc.cfg();
    let joiner = pair::Joiner::new(&code, &c.device).map_err(|e| e.to_string())?;
    // Check the code is open before showing anything.
    svc.relay().hear(&code, 0).await.map_err(|e| match e {
        RelayError::NoRoom => {
            "That code isn't open. Check it, or make a new one on the other Mac.".to_string()
        }
        e => e.to_string(),
    })?;
    let id = new_pairing(&svc, code, Role::Join(joiner));
    let _ = app.emit("sync-changed", ());
    tauri::async_runtime::spawn(drive(app.clone(), id));
    Ok(())
}

/// The person says the six digits match (or don't).
#[tauri::command]
pub fn sync_pair_confirm(app: AppHandle, same: bool) -> CmdResult<()> {
    let svc = app.state::<SyncService>();
    if same {
        if let Ok(mut p) = svc.pairing.lock() {
            if let Some(p) = p.as_mut() {
                p.confirmed = true;
                p.stage = "finishing";
            }
        }
        let _ = app.emit("sync-changed", ());
        Ok(())
    } else {
        cancel(
            &app,
            Some(
                "The numbers didn't match, so nothing was shared. Try again with a new code."
                    .into(),
            ),
        );
        Ok(())
    }
}

#[tauri::command]
pub fn sync_pair_cancel(app: AppHandle) -> CmdResult<()> {
    cancel(&app, None);
    Ok(())
}

/// End the pairing: tell the other Mac (best effort) and close the room.
fn cancel(app: &AppHandle, error: Option<String>) {
    let svc = app.state::<SyncService>();
    let code = svc.pairing.lock().ok().and_then(|mut p| {
        let code = p.as_ref().map(|x| x.code.clone());
        match (&error, p.as_mut()) {
            (Some(e), Some(x)) => {
                x.stage = "failed";
                x.error = Some(e.clone());
            }
            _ => *p = None,
        }
        code
    });
    if let Some(code) = code {
        let relay = svc.relay();
        tauri::async_runtime::spawn(async move {
            let _ = relay.say(&code, &pair::cancel_msg()).await;
            relay.close_room(&code).await;
        });
    }
    let _ = app.emit("sync-changed", ());
}

#[tauri::command]
pub fn sync_pair_dismiss(app: AppHandle) {
    let svc = app.state::<SyncService>();
    if let Ok(mut p) = svc.pairing.lock() {
        if p.as_ref()
            .is_some_and(|x| matches!(x.stage, "done" | "failed"))
        {
            *p = None;
        }
    }
    let _ = app.emit("sync-changed", ());
}

fn fail(svc: &SyncService, id: u64, msg: String) {
    if let Ok(mut p) = svc.pairing.lock() {
        if let Some(x) = p.as_mut().filter(|x| x.id == id) {
            x.stage = "failed";
            x.error = Some(msg);
        }
    }
}

enum Step {
    Wait,
    Say(Vec<String>),
    Invite,
    Joined(pair::Invite),
    Stop,
}

/// Run one pairing: read the room, answer, and finish once confirmed.
async fn drive(app: AppHandle, id: u64) {
    let svc = app.state::<SyncService>();
    let relay = svc.relay();
    let started = std::time::Instant::now();
    let code = match svc
        .pairing
        .lock()
        .ok()
        .and_then(|p| p.as_ref().map(|x| x.code.clone()))
    {
        Some(c) => c,
        None => return,
    };
    loop {
        if started.elapsed() > PAIR_FOR {
            fail(
                &svc,
                id,
                "The code expired. Make a new one to try again.".into(),
            );
            let _ = app.emit("sync-changed", ());
            break;
        }
        let heard = match svc
            .pairing
            .lock()
            .ok()
            .and_then(|p| p.as_ref().filter(|x| x.id == id).map(|x| x.heard))
        {
            Some(h) => h,
            None => break, // cancelled or replaced
        };
        let msgs = match relay.hear(&code, heard).await {
            Ok(m) => m,
            Err(RelayError::NoRoom) => {
                fail(&svc, id, "The other Mac closed the code.".into());
                let _ = app.emit("sync-changed", ());
                break;
            }
            Err(_) => {
                tokio::time::sleep(Duration::from_secs(2)).await;
                continue;
            }
        };

        // Feed what arrived to the state machine; decide what to do.
        let step = {
            let Ok(mut guard) = svc.pairing.lock() else {
                break;
            };
            let Some(p) = guard.as_mut().filter(|x| x.id == id) else {
                break;
            };
            if matches!(p.stage, "done" | "failed") {
                Step::Stop
            } else {
                let mut replies = vec![];
                let mut error = None;
                for m in &msgs {
                    p.heard += 1;
                    let r = match &mut p.role {
                        Role::Host(h) => h.hear(m),
                        Role::Join(j) => j.hear(m),
                    };
                    match r {
                        Ok(Some(reply)) => replies.push(reply),
                        Ok(None) => {}
                        Err(e) => error = Some(e),
                    }
                }
                let sas_ready = match &p.role {
                    Role::Host(h) => h.sas().is_some(),
                    Role::Join(j) => j.sas().is_some(),
                };
                if let Some(e) = error {
                    p.stage = "failed";
                    p.error = Some(match e {
                        pair::PairError::Cancelled => "The other Mac cancelled.".into(),
                        e => format!(
                            "{}{}.",
                            e.to_string()[..1].to_uppercase(),
                            &e.to_string()[1..]
                        ),
                    });
                    Step::Stop
                } else if !replies.is_empty() {
                    Step::Say(replies)
                } else if sas_ready && p.stage == "waiting" {
                    p.stage = "compare";
                    Step::Wait
                } else if p.confirmed {
                    match &p.role {
                        Role::Host(_) => Step::Invite,
                        Role::Join(j) => match j.invite() {
                            Ok(Some(inv)) => Step::Joined(inv),
                            Ok(None) => Step::Wait,
                            Err(e) => {
                                p.stage = "failed";
                                p.error = Some(format!("The invite couldn't be opened ({e})."));
                                Step::Stop
                            }
                        },
                    }
                } else {
                    Step::Wait
                }
            }
        };
        let _ = app.emit("sync-changed", ());

        match step {
            Step::Stop => break,
            Step::Say(replies) => {
                for r in replies {
                    if let Err(e) = relay.say(&code, &r).await {
                        log::warn!("sync: pairing reply failed: {e}");
                    }
                }
                continue;
            }
            Step::Wait => {}
            Step::Invite => {
                match finish_host(&app, id, &relay, &code).await {
                    Ok(()) => {}
                    Err(e) => fail(&svc, id, e),
                }
                let _ = app.emit("sync-changed", ());
                break;
            }
            Step::Joined(inv) => {
                match finish_join(&app, inv).await {
                    Ok(()) => {
                        if let Ok(mut p) = svc.pairing.lock() {
                            if let Some(x) = p.as_mut().filter(|x| x.id == id) {
                                x.stage = "done";
                            }
                        }
                        relay.close_room(&code).await;
                    }
                    Err(e) => fail(&svc, id, e),
                }
                let _ = app.emit("sync-changed", ());
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(1200)).await;
    }
}

/// Host side, after both people confirmed: bring the mailbox up to date,
/// make room for the new Mac, and hand it the key.
async fn finish_host(app: &AppHandle, id: u64, relay: &Relay, code: &str) -> Result<(), String> {
    let svc = app.state::<SyncService>();
    let me = svc.membership().ok_or("Sync is off on this Mac.")?;
    let (mailbox, token) = (me.key.mailbox_id(), me.key.mailbox_token());
    let peer = svc
        .pairing
        .lock()
        .ok()
        .and_then(|p| match p.as_ref().map(|x| &x.role) {
            Some(Role::Host(h)) => h.peer.clone(),
            _ => None,
        })
        .ok_or("The other Mac isn't here any more.")?;

    // Everything up to `latest` is already here; the new Mac starts after
    // it, with a full copy of what this Mac knows.
    let latest = relay
        .list(&mailbox, &token, 999_999_999_999)
        .await
        .map_err(|e| e.to_string())?
        .latest;
    relay
        .add_device(&mailbox, &token, &peer, latest)
        .await
        .map_err(|e| e.to_string())?;
    sync::send_snapshot(relay, &me, &app.state::<AppState>().store)
        .await
        .map_err(|e| e.to_string())?;
    let invite = pair::Invite {
        key: me.key.to_text(),
        relay: svc.cfg().relay,
        cursor: latest,
        host: me.device.clone(),
        host_name: me.name.clone(),
    };
    let msg = {
        let guard = svc.pairing.lock().map_err(|e| e.to_string())?;
        match guard.as_ref().filter(|x| x.id == id).map(|x| &x.role) {
            Some(Role::Host(h)) => h.invite(&invite).map_err(|e| e.to_string())?,
            _ => None,
        }
    }
    .ok_or("Pairing was cancelled.")?;
    relay.say(code, &msg).await.map_err(|e| e.to_string())?;
    if let Ok(mut p) = svc.pairing.lock() {
        if let Some(x) = p.as_mut().filter(|x| x.id == id) {
            x.stage = "done";
        }
    }
    log::info!("sync: added a Mac to the group");
    svc.edit(|c| {
        c.seen.insert(peer.clone(), now());
    });
    // The room closes itself in a few minutes; the joiner closes it sooner.
    Ok(())
}

/// Joiner side, after the person confirmed: take the key and start.
async fn finish_join(app: &AppHandle, inv: pair::Invite) -> Result<(), String> {
    let svc = app.state::<SyncService>();
    let key = GroupKey::from_text(&inv.key).ok_or("The invite had no valid key.")?;
    if !inv.relay.starts_with("https://") {
        return Err("The invite pointed somewhere unexpected.".into());
    }
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|e| e.to_string())?;
        store.sync_reset().map_err(|e| e.to_string())?;
        store
            .set_sync_cursor(inv.cursor)
            .map_err(|e| e.to_string())?;
    }
    svc.store_key(Some(&key))?;
    let at = now();
    svc.edit(|c| {
        c.on = true;
        c.relay = inv.relay.clone();
        c.removed_notice = false;
        c.seen.clear();
        c.seen.insert(inv.host.clone(), at);
    });
    log::info!("sync: joined a group");
    svc.nudge();
    Ok(())
}

// ── Everything else ────────────────────────────────────────────────────────

#[tauri::command]
pub fn sync_now(svc: State<'_, SyncService>) {
    svc.nudge();
}

/// Stop syncing with another Mac. It stops when it next checks in.
#[tauri::command]
pub async fn sync_remove(app: AppHandle, device: String) -> CmdResult<()> {
    let svc = app.state::<SyncService>();
    let me = svc.membership().ok_or("Sync is off on this Mac.")?;
    if device == me.device {
        return Err("Use “Turn off sync” to stop syncing this Mac.".into());
    }
    {
        let state = app.state::<AppState>();
        let store = state.store.lock().map_err(|e| e.to_string())?;
        store
            .sync_set(
                &me.device,
                &format!("d:{device}"),
                "removed",
                serde_json::Value::Bool(true),
            )
            .map_err(|e| e.to_string())?;
    }
    let _ = svc
        .relay()
        .remove_device(&me.key.mailbox_id(), &me.key.mailbox_token(), &device)
        .await;
    svc.edit(|c| {
        c.seen.remove(&device);
    });
    svc.nudge();
    let _ = app.emit("sync-changed", ());
    Ok(())
}

/// Turn sync off on this Mac. Its tasks stay; the other Macs keep theirs.
#[tauri::command]
pub async fn sync_leave(app: AppHandle) -> CmdResult<()> {
    let svc = app.state::<SyncService>();
    if let Some(me) = svc.membership() {
        let relay = svc.relay();
        let others = {
            let state = app.state::<AppState>();
            let store = state.store.lock().map_err(|e| e.to_string())?;
            let others = store
                .sync_devices()
                .unwrap_or_default()
                .into_iter()
                .filter(|d| d.id != me.device && !d.removed)
                .count();
            if others > 0 {
                let _ = store.sync_set(
                    &me.device,
                    &format!("d:{}", me.device),
                    "removed",
                    serde_json::Value::Bool(true),
                );
            }
            others
        };
        let (mailbox, token) = (me.key.mailbox_id(), me.key.mailbox_token());
        if others > 0 {
            // Say goodbye, then stop holding boxes for this Mac.
            let _ = sync::cycle(&relay, &me, &app.state::<AppState>().store).await;
            let _ = relay.remove_device(&mailbox, &token, &me.device).await;
        } else {
            // The last Mac: nothing in the mailbox is needed any more.
            let _ = relay.delete_mailbox(&mailbox, &token).await;
        }
    }
    forget(&app, false);
    log::info!("sync: turned off on this Mac");
    Ok(())
}

/// Keep a project on this Mac only (or share it again).
#[tauri::command]
pub fn sync_local_only(app: AppHandle, project: String, on: bool) -> CmdResult<()> {
    let svc = app.state::<SyncService>();
    svc.edit(|c| {
        c.local_only.retain(|p| p != &project);
        if on {
            c.local_only.push(project.clone());
            c.local_only.sort_by_key(|p| p.to_lowercase());
        }
    });
    svc.nudge();
    let _ = app.emit("sync-changed", ());
    Ok(())
}

/// What this Mac is called on the others.
#[tauri::command]
pub fn sync_rename(app: AppHandle, name: String) -> CmdResult<()> {
    let name: String = name.chars().filter(|c| !c.is_control()).take(60).collect();
    let svc = app.state::<SyncService>();
    svc.edit(|c| c.name = Some(name.trim().to_string()).filter(|n| !n.is_empty()));
    svc.nudge();
    let _ = app.emit("sync-changed", ());
    Ok(())
}

#[tauri::command]
pub fn sync_dismiss_notice(app: AppHandle) {
    app.state::<SyncService>()
        .edit(|c| c.removed_notice = false);
    let _ = app.emit("sync-changed", ());
}
