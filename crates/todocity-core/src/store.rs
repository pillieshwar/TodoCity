//! Local task storage in SQLite (WAL mode).
//!
//! Dates are stored as a plain calendar day (`YYYY-MM-DD`) because a task is
//! "due Friday", not "due at an instant". Creation time is stored as UTC plus
//! the IANA zone the user was in, so history stays interpretable after travel.

use std::path::Path;

use chrono::{NaiveDate, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};

use crate::recurrence::Repeat;

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
    #[error("invalid date '{0}', expected YYYY-MM-DD")]
    BadDate(String),
    #[error("task title cannot be empty")]
    EmptyTitle,
    #[error("task {0} not found")]
    NotFound(i64),
    #[error("invalid time '{0}', expected HH:MM")]
    BadTime(String),
    #[error("unknown repeat rule '{0}'")]
    BadRecurrence(String),
}

/// One step of a task's checklist.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChecklistItem {
    pub text: String,
    #[serde(default)]
    pub done: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Task {
    pub id: i64,
    pub title: String,
    /// Calendar day, `YYYY-MM-DD`, or `None` for "someday".
    pub due_date: Option<String>,
    /// The original selection, kept so the user can see where a task came from.
    pub source_text: Option<String>,
    pub done: bool,
    /// RFC 3339 UTC timestamp.
    pub created_at: String,
    /// IANA zone at creation, e.g. `America/Los_Angeles`.
    pub created_tz: Option<String>,
    pub completed_at: Option<String>,
    /// Local time of day, `HH:MM`; only set together with `due_date`.
    pub due_time: Option<String>,
    /// Repeat rule (see [`crate::recurrence::Repeat`]): `weekly`, or a
    /// custom `rrule:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE`.
    pub recurrence: Option<String>,
    /// The app the text was captured in, e.g. `Slack`.
    pub source_app: Option<String>,
    /// That app's bundle identifier, used to reopen it.
    pub source_bundle: Option<String>,
    /// The page or document the text came from, when the app exposes it.
    pub source_url: Option<String>,
    /// Local time (`YYYY-MM-DDTHH:MM:SS`) a snoozed reminder fires again.
    pub snoozed_until: Option<String>,
    /// Local time the last notification for this task was shown.
    pub notified_at: Option<String>,
    /// For a completed repeating task: the occurrence it created.
    pub next_id: Option<i64>,
    /// The user's own description: links, details, anything useful later.
    pub notes: Option<String>,
    /// A hard deadline (`YYYY-MM-DD`), separate from the day it's planned for.
    #[serde(default)]
    pub deadline: Option<String>,
    /// Planned for the evening of its day ("This Evening").
    #[serde(default)]
    pub evening: bool,
    /// Parked for some day: no date, out of the way.
    #[serde(default)]
    pub someday: bool,
    /// The project this task belongs to, and its section in that project.
    #[serde(default)]
    pub project: Option<String>,
    #[serde(default)]
    pub heading: Option<String>,
    /// Steps within the task.
    #[serde(default)]
    pub checklist: Vec<ChecklistItem>,
    /// For a repeating task moved on its own: the day the series had it on,
    /// so the next one keeps the series' rhythm.
    #[serde(default)]
    pub series_date: Option<String>,
    /// A paused repeating task: no reminders until it's resumed.
    #[serde(default)]
    pub paused: bool,
    /// 0 (none), or 1 (urgent), 2 (high), 3 (medium).
    #[serde(default)]
    pub priority: u8,
    /// How long it takes, in minutes (1 to 1440); `None` for no set length.
    #[serde(default)]
    pub duration: Option<u32>,
    /// The AI agent that last added or changed it ("claude-code"), until
    /// the person changes it themselves. This Mac only; see `agent_log`.
    #[serde(default)]
    pub agent: Option<String>,
    /// When the agent did (RFC 3339 UTC).
    #[serde(default)]
    pub agent_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct NewTask {
    pub title: String,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub recurrence: Option<String>,
    pub source_text: Option<String>,
    pub source_app: Option<String>,
    pub source_bundle: Option<String>,
    pub source_url: Option<String>,
    pub notes: Option<String>,
    pub created_tz: Option<String>,
    pub deadline: Option<String>,
    pub evening: bool,
    pub someday: bool,
    pub project: Option<String>,
    pub heading: Option<String>,
    pub checklist: Vec<ChecklistItem>,
    /// 0 (none) to 3; see [`Task::priority`].
    pub priority: u8,
    /// Minutes; see [`Task::duration`].
    pub duration: Option<u32>,
}

/// Partial update. `due_date: Some(None)` clears the date (and the time).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskPatch {
    pub title: Option<String>,
    #[serde(default, with = "double_option")]
    pub due_date: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    pub due_time: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    pub recurrence: Option<Option<String>>,
    /// `Some(None)` (or an empty string) clears the description.
    #[serde(default, with = "double_option")]
    pub notes: Option<Option<String>>,
    /// Local `YYYY-MM-DDTHH:MM:SS`; `Some(None)` cancels a snooze.
    #[serde(default, with = "double_option")]
    pub snoozed_until: Option<Option<String>>,
    pub done: Option<bool>,
    #[serde(default, with = "double_option")]
    pub deadline: Option<Option<String>>,
    pub evening: Option<bool>,
    pub someday: Option<bool>,
    /// `Some(None)` takes the task out of its project (and heading).
    #[serde(default, with = "double_option")]
    pub project: Option<Option<String>>,
    #[serde(default, with = "double_option")]
    pub heading: Option<Option<String>>,
    pub checklist: Option<Vec<ChecklistItem>>,
    pub paused: Option<bool>,
    /// 0 clears it; 1 (urgent) to 3 (medium).
    pub priority: Option<u8>,
    /// Minutes, 1 to 1440; `Some(None)` (or 0) clears it.
    #[serde(default, with = "double_option")]
    pub duration: Option<Option<u32>>,
    /// Moving a repeating task: `true` moves just this one (the series keeps
    /// its days), otherwise the series moves with it.
    pub only_this: Option<bool>,
}

/// What `Store::update` did besides changing the task itself.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct UpdateEffects {
    /// A repeating task was completed and this next occurrence was created.
    pub spawned: Option<i64>,
    /// A completion was undone and this unstarted occurrence was removed.
    pub removed: Option<i64>,
}

mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    pub fn serialize<T: Serialize, S: Serializer>(
        v: &Option<Option<T>>,
        s: S,
    ) -> Result<S::Ok, S::Error> {
        v.serialize(s)
    }
    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        d: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(d).map(Some)
    }
}

const MIGRATIONS: &[&str] = &[
    r#"
CREATE TABLE tasks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    title         TEXT    NOT NULL CHECK (length(trim(title)) > 0),
    due_date      TEXT    CHECK (due_date IS NULL OR due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
    source_text   TEXT,
    done          INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT    NOT NULL,
    created_tz    TEXT,
    completed_at  TEXT
);
CREATE INDEX tasks_open_due ON tasks (done, due_date);
"#,
    r#"
CREATE TABLE reminder_links (
    task_id      INTEGER PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
    reminder_id  TEXT    NOT NULL UNIQUE,
    base_title   TEXT    NOT NULL,
    base_due     TEXT,
    base_done    INTEGER NOT NULL,
    -- The reminder was deleted in Reminders: keep the task, never re-add it.
    detached     INTEGER NOT NULL DEFAULT 0
);
"#,
    r#"
ALTER TABLE tasks ADD COLUMN due_time TEXT CHECK (due_time IS NULL OR due_time GLOB '[0-2][0-9]:[0-5][0-9]');
ALTER TABLE tasks ADD COLUMN recurrence TEXT;
ALTER TABLE tasks ADD COLUMN source_app TEXT;
ALTER TABLE tasks ADD COLUMN source_bundle TEXT;
ALTER TABLE tasks ADD COLUMN source_url TEXT;
ALTER TABLE tasks ADD COLUMN snoozed_until TEXT;
ALTER TABLE tasks ADD COLUMN notified_at TEXT;
ALTER TABLE tasks ADD COLUMN next_id INTEGER;
"#,
    r#"
ALTER TABLE tasks ADD COLUMN notes TEXT;
"#,
    r#"
ALTER TABLE tasks ADD COLUMN deadline TEXT CHECK (deadline IS NULL OR deadline GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]');
ALTER TABLE tasks ADD COLUMN evening INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN someday INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN project TEXT;
ALTER TABLE tasks ADD COLUMN heading TEXT;
ALTER TABLE tasks ADD COLUMN checklist TEXT;
ALTER TABLE tasks ADD COLUMN series_date TEXT;
ALTER TABLE tasks ADD COLUMN paused INTEGER NOT NULL DEFAULT 0;
CREATE INDEX tasks_completed ON tasks (done, completed_at);
"#,
    // Projects and their headings ("buildings" and "floors") can exist
    // before any task is in them.
    r#"
CREATE TABLE projects (name TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE floors (
    project    TEXT NOT NULL,
    name       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (project, name)
);
INSERT OR IGNORE INTO projects (name, created_at)
    SELECT project, MIN(created_at) FROM tasks WHERE project IS NOT NULL GROUP BY project;
INSERT OR IGNORE INTO floors (project, name, created_at)
    SELECT project, heading, MIN(created_at) FROM tasks
    WHERE project IS NOT NULL AND heading IS NOT NULL GROUP BY project, heading;
"#,
    // Each project can have its own color (`#rrggbb`), used for its tasks.
    r#"
ALTER TABLE projects ADD COLUMN color TEXT;
"#,
    // Tasks brought in from another app (e.g. Things 3), so importing again
    // never adds a task twice, even one deleted here since.
    r#"
CREATE TABLE imports (
    source      TEXT NOT NULL,
    ext_id      TEXT NOT NULL,
    task_id     INTEGER,
    imported_at TEXT NOT NULL,
    PRIMARY KEY (source, ext_id)
);
"#,
    // Sync between a person's Macs (see `crate::sync`): every task gets an id
    // that's the same on every Mac, and the last state each Mac agreed on is
    // kept per field ("the shadow"), so changes are found by comparing.
    r#"
ALTER TABLE tasks ADD COLUMN uid TEXT;
UPDATE tasks SET uid = lower(hex(randomblob(16))) WHERE uid IS NULL;
CREATE UNIQUE INDEX tasks_uid ON tasks (uid);
CREATE TRIGGER tasks_uid_new AFTER INSERT ON tasks FOR EACH ROW WHEN NEW.uid IS NULL
BEGIN
    UPDATE tasks SET uid = lower(hex(randomblob(16))) WHERE rowid = NEW.rowid;
END;
CREATE TABLE sync_shadow (
    entity  TEXT NOT NULL,
    field   TEXT NOT NULL,
    value   TEXT NOT NULL,
    hlc     TEXT NOT NULL,
    pending INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (entity, field)
) WITHOUT ROWID;
CREATE INDEX sync_shadow_pending ON sync_shadow (pending) WHERE pending = 1;
CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- A counter that moves whenever tasks, projects or headings change, so sync
-- only compares everything when something did.
INSERT INTO sync_state (key, value) VALUES ('dirty', '1');
CREATE TRIGGER sync_dirty_task_ins AFTER INSERT ON tasks BEGIN UPDATE sync_state SET value = CAST(value AS INTEGER) + 1 WHERE key = 'dirty'; END;
CREATE TRIGGER sync_dirty_task_upd AFTER UPDATE ON tasks BEGIN UPDATE sync_state SET value = CAST(value AS INTEGER) + 1 WHERE key = 'dirty'; END;
CREATE TRIGGER sync_dirty_task_del AFTER DELETE ON tasks BEGIN UPDATE sync_state SET value = CAST(value AS INTEGER) + 1 WHERE key = 'dirty'; END;
CREATE TRIGGER sync_dirty_proj_ins AFTER INSERT ON projects BEGIN UPDATE sync_state SET value = CAST(value AS INTEGER) + 1 WHERE key = 'dirty'; END;
CREATE TRIGGER sync_dirty_proj_upd AFTER UPDATE ON projects BEGIN UPDATE sync_state SET value = CAST(value AS INTEGER) + 1 WHERE key = 'dirty'; END;
CREATE TRIGGER sync_dirty_proj_del AFTER DELETE ON projects BEGIN UPDATE sync_state SET value = CAST(value AS INTEGER) + 1 WHERE key = 'dirty'; END;
CREATE TRIGGER sync_dirty_floor_ins AFTER INSERT ON floors BEGIN UPDATE sync_state SET value = CAST(value AS INTEGER) + 1 WHERE key = 'dirty'; END;
CREATE TRIGGER sync_dirty_floor_del AFTER DELETE ON floors BEGIN UPDATE sync_state SET value = CAST(value AS INTEGER) + 1 WHERE key = 'dirty'; END;
"#,
    // Priority: 0 (none), 1 (urgent), 2 (high), 3 (medium).
    r#"
ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 3);
"#,
    // Keeping in step with Things 3 or Todoist (see `crate::mirror`): each
    // brought-in task remembers how the other app last had it, and each of
    // the other app's projects which project it is here.
    r#"
ALTER TABLE imports ADD COLUMN base TEXT;
CREATE TABLE mirror_projects (
    source      TEXT NOT NULL,
    key         TEXT NOT NULL,
    project     TEXT NOT NULL,
    source_name TEXT NOT NULL,
    stopped     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (source, key)
);
"#,
    // Reminders to delete: whenever a task linked to a reminder is deleted —
    // here, by another Mac, by keep-in-sync or by un-ticking a repeat — its
    // reminder is queued so the next Reminders pass deletes it too, instead
    // of bringing it back as a new task.
    r#"
CREATE TABLE reminder_trash (
    reminder_id TEXT PRIMARY KEY,
    queued_at   TEXT NOT NULL
);
CREATE TRIGGER reminder_trash_on_delete BEFORE DELETE ON tasks BEGIN
    INSERT OR IGNORE INTO reminder_trash (reminder_id, queued_at)
        SELECT reminder_id, strftime('%Y-%m-%dT%H:%M:%SZ', 'now') FROM reminder_links
        WHERE task_id = OLD.id AND detached = 0;
END;
-- A next occurrence deleted any way (here or by another Mac) is no longer
-- the next one: ticking its task again makes a new one.
CREATE TRIGGER next_id_on_delete AFTER DELETE ON tasks BEGIN
    UPDATE tasks SET next_id = NULL WHERE next_id = OLD.id;
END;
"#,
    // How long a task takes, in minutes (none: no set length).
    r#"
ALTER TABLE tasks ADD COLUMN duration INTEGER CHECK (duration IS NULL OR duration BETWEEN 1 AND 1440);
"#,
    // Two-way calendar sync (see `crate::calendar_sync`): each timed task's
    // event in a calendar app, the calendar made for each project, and events
    // to delete because their task was deleted (any way: here, another Mac,
    // keep-in-sync).
    r#"
CREATE TABLE calendar_links (
    provider    TEXT    NOT NULL,
    task_id     INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    event_id    TEXT    NOT NULL,
    lane        TEXT    NOT NULL,
    base_title  TEXT    NOT NULL,
    base_start  TEXT    NOT NULL,
    base_end    TEXT    NOT NULL,
    PRIMARY KEY (provider, task_id),
    UNIQUE (provider, event_id)
);
CREATE TABLE calendar_lanes (
    provider    TEXT NOT NULL,
    lane        TEXT NOT NULL,
    calendar_id TEXT NOT NULL,
    name        TEXT NOT NULL,
    PRIMARY KEY (provider, lane)
);
CREATE TABLE calendar_trash (
    provider  TEXT NOT NULL,
    event_id  TEXT NOT NULL,
    queued_at TEXT NOT NULL,
    PRIMARY KEY (provider, event_id)
);
CREATE TRIGGER calendar_trash_on_delete BEFORE DELETE ON tasks BEGIN
    INSERT OR IGNORE INTO calendar_trash (provider, event_id, queued_at)
        SELECT provider, event_id, strftime('%Y-%m-%dT%H:%M:%SZ', 'now') FROM calendar_links
        WHERE task_id = OLD.id;
END;
"#,
    // What AI agents did (see `crate::agent_log`): every task an agent added,
    // changed or deleted, with how it was before, so it can be undone. The
    // task remembers the agent until the person changes it themselves.
    r#"
ALTER TABLE tasks ADD COLUMN agent TEXT;
ALTER TABLE tasks ADD COLUMN agent_at TEXT;
CREATE TABLE agent_changes (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    at       TEXT    NOT NULL,
    agent    TEXT    NOT NULL,
    batch    TEXT    NOT NULL,
    tool     TEXT    NOT NULL,
    task_id  INTEGER NOT NULL,
    kind     TEXT    NOT NULL,
    title    TEXT    NOT NULL,
    summary  TEXT    NOT NULL,
    before   TEXT,
    undone   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX agent_changes_at ON agent_changes (at);
CREATE INDEX agent_changes_task ON agent_changes (task_id);
"#,
    // Tasks handed to an AI agent with "Send to agent" (see
    // `crate::agent_runs`): who's working on it, how it's going, and what
    // the agent reported. Local to this Mac, like agent marks; never synced.
    r#"
CREATE TABLE agent_runs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL,
    agent      TEXT    NOT NULL,
    token      TEXT    NOT NULL UNIQUE,
    folder     TEXT,
    status     TEXT    NOT NULL,
    summary    TEXT,
    links      TEXT    NOT NULL DEFAULT '[]',
    started_at TEXT    NOT NULL,
    updated_at TEXT    NOT NULL
);
CREATE INDEX agent_runs_task ON agent_runs (task_id);
"#,
    // What an agent's terminal showed (cleaned), and its last few lines, so
    // "what did it do" survives closing TodoCity (see `crate::agent_runs`).
    r#"
ALTER TABLE agent_runs ADD COLUMN transcript TEXT;
ALTER TABLE agent_runs ADD COLUMN tail TEXT;
"#,
];

/// One task to bring in from another app, with its history.
#[derive(Debug, Clone, Default)]
pub struct Imported {
    /// The other app's id for it, unique within `source`.
    pub ext_id: String,
    /// The other app's project (or area) it's in, or the loose key.
    pub building: String,
    pub task: NewTask,
    pub done: bool,
    /// RFC 3339 UTC; when it was finished (done tasks) and created.
    pub completed_at: Option<String>,
    pub created_at: Option<String>,
}

/// What an import did.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct ImportReport {
    pub added: usize,
    pub done: usize,
    /// Brought in before, so left alone.
    pub skipped: usize,
    /// Couldn't be read (e.g. an impossible date); the rest still came in.
    pub failed: usize,
}

/// A TodoCity task linked to an external reminder, with the state both sides
/// last agreed on (see `reminders_sync`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReminderLink {
    pub task_id: i64,
    pub reminder_id: String,
    pub base: crate::reminders_sync::SyncState,
    /// The reminder was deleted outside TodoCity; the task no longer syncs.
    #[serde(default)]
    pub detached: bool,
}

/// A finished task, as one lit window of the city: just what the city shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CityWindow {
    pub id: i64,
    pub title: String,
    pub project: Option<String>,
    pub heading: Option<String>,
    pub completed_at: String,
}

/// A heading in a project (a floor of its building) and its task counts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FloorSummary {
    pub project: String,
    pub name: String,
    pub open: i64,
    pub done: i64,
}

/// A project and how far along it is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ProjectSummary {
    pub name: String,
    pub open: i64,
    pub done: i64,
    /// The color the user picked (`#rrggbb`), if any.
    pub color: Option<String>,
    /// The app it's kept in step with (`things3`, `todoist`), if any.
    pub synced: Option<String>,
}

pub struct Store {
    pub(crate) conn: Connection,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self, StoreError> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self, StoreError> {
        let _mode: String =
            conn.pragma_update_and_check(None, "journal_mode", "WAL", |r| r.get(0))?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        let version: i64 = conn.pragma_query_value(None, "user_version", |r| r.get(0))?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            conn.execute_batch(sql)?;
            conn.pragma_update(None, "user_version", (i + 1) as i64)?;
        }
        Ok(Self { conn })
    }

    pub fn insert(&self, t: NewTask) -> Result<Task, StoreError> {
        let title = clean_title(&t.title)?;
        let due = t.due_date.as_deref().map(check_date).transpose()?;
        // A time only means something on a day.
        let time = match due {
            Some(_) => t.due_time.as_deref().map(check_time).transpose()?,
            None => None,
        };
        let rule = t.recurrence.as_deref().map(check_rule).transpose()?;
        self.conn.execute(
            "INSERT INTO tasks (title, due_date, due_time, recurrence, source_text, source_app,
                                source_bundle, source_url, created_at, created_tz)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                title,
                due,
                time,
                rule,
                t.source_text,
                clean_opt(t.source_app),
                clean_opt(t.source_bundle),
                clean_opt(t.source_url),
                now(),
                t.created_tz
            ],
        )?;
        let id = self.conn.last_insert_rowid();
        let deadline = t.deadline.as_deref().map(check_date).transpose()?;
        let project = clean_name(t.project);
        let heading = project.as_ref().and(clean_name(t.heading));
        self.conn.execute(
            "UPDATE tasks SET notes = ?1, deadline = ?2, evening = ?3, someday = ?4, project = ?5,
                 heading = ?6, checklist = ?7, priority = ?8, duration = ?9 WHERE id = ?10",
            params![
                clean_notes(t.notes.as_deref()),
                deadline,
                t.evening && due.is_some(),
                t.someday && due.is_none(),
                project,
                heading,
                checklist_json(&t.checklist),
                clean_priority(t.priority),
                clean_duration(t.duration),
                id
            ],
        )?;
        self.get(id)
    }

    pub fn get(&self, id: i64) -> Result<Task, StoreError> {
        self.conn
            .query_row(&format!("{SELECT} WHERE id = ?1"), [id], map_row)
            .optional()?
            .ok_or(StoreError::NotFound(id))
    }

    /// Open tasks plus anything completed on or after `done_since`
    /// (`YYYY-MM-DD`, compared against the UTC completion day), ordered for
    /// the day-grouped panel: dated tasks by day, then undated.
    pub fn list(&self, done_since: Option<&str>) -> Result<Vec<Task>, StoreError> {
        let since = done_since
            .map(check_date)
            .transpose()?
            .unwrap_or_else(|| "9999-12-31".into());
        let mut stmt = self.conn.prepare(&format!(
            "{SELECT} WHERE done = 0 OR substr(completed_at, 1, 10) >= ?1
             ORDER BY {ORDER}"
        ))?;
        let rows = stmt.query_map([since], map_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Every task, done or not (for export).
    pub fn all(&self) -> Result<Vec<Task>, StoreError> {
        let mut stmt = self.conn.prepare(&format!("{SELECT} ORDER BY {ORDER}"))?;
        let rows = stmt.query_map([], map_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Record that a notification for this task was shown at `at` (local).
    pub fn mark_notified(&self, id: i64, at: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "UPDATE tasks SET notified_at = ?1 WHERE id = ?2",
            params![at, id],
        )?;
        Ok(())
    }

    /// Write a consistent copy of the database to `path` (which must not
    /// exist yet). Safe while the app is running.
    pub fn backup_to(&self, path: impl AsRef<Path>) -> Result<(), StoreError> {
        let path = path.as_ref().to_string_lossy().to_string();
        self.conn.execute("VACUUM INTO ?1", [path])?;
        Ok(())
    }

    pub fn update(&self, id: i64, patch: TaskPatch) -> Result<Task, StoreError> {
        self.update_with_effects(id, patch).map(|(t, _)| t)
    }

    /// Apply `patch`. Completing a repeating task creates its next
    /// occurrence; un-completing it removes that occurrence again if it
    /// hasn't been touched.
    pub fn update_with_effects(
        &self,
        id: i64,
        patch: TaskPatch,
    ) -> Result<(Task, UpdateEffects), StoreError> {
        let before = self.get(id)?;
        let mut effects = UpdateEffects::default();
        let tx = self.conn.unchecked_transaction()?;
        // Changed by the person (or anything else): no longer the agent's.
        // `agent_log` marks it again when an agent made this change.
        tx.execute(
            "UPDATE tasks SET agent = NULL, agent_at = NULL WHERE id = ?1 AND agent IS NOT NULL",
            [id],
        )?;
        if let Some(title) = patch.title {
            tx.execute(
                "UPDATE tasks SET title = ?1 WHERE id = ?2",
                params![clean_title(&title)?, id],
            )?;
        }
        let mut reschedule = false;
        if let Some(due) = patch.due_date {
            let due = due.as_deref().map(check_date).transpose()?;
            if due.is_none() {
                tx.execute(
                    "UPDATE tasks SET due_time = NULL, evening = 0 WHERE id = ?1",
                    [id],
                )?;
            } else {
                // A day takes it off Someday.
                tx.execute("UPDATE tasks SET someday = 0 WHERE id = ?1", [id])?;
            }
            tx.execute(
                "UPDATE tasks SET due_date = ?1 WHERE id = ?2",
                params![due, id],
            )?;
            if due != before.due_date && before.recurrence.is_some() {
                // Just this one: remember where the series had it. Otherwise
                // the series follows the new day.
                let series = if patch.only_this == Some(true) {
                    before.series_date.clone().or(before.due_date.clone())
                } else {
                    None
                };
                tx.execute(
                    "UPDATE tasks SET series_date = ?1 WHERE id = ?2",
                    params![series, id],
                )?;
            }
            reschedule |= due != before.due_date;
        }
        if let Some(time) = patch.due_time {
            let time = time.as_deref().map(check_time).transpose()?;
            // Ignored on an undated task.
            tx.execute(
                "UPDATE tasks SET due_time = CASE WHEN due_date IS NULL THEN NULL ELSE ?1 END WHERE id = ?2",
                params![time, id],
            )?;
            reschedule |= time != before.due_time;
        }
        if let Some(notes) = patch.notes {
            tx.execute(
                "UPDATE tasks SET notes = ?1 WHERE id = ?2",
                params![clean_notes(notes.as_deref()), id],
            )?;
        }
        if let Some(rule) = patch.recurrence {
            let rule = rule.as_deref().map(check_rule).transpose()?;
            if rule.is_none() {
                tx.execute(
                    "UPDATE tasks SET series_date = NULL, paused = 0 WHERE id = ?1",
                    [id],
                )?;
            }
            tx.execute(
                "UPDATE tasks SET recurrence = ?1 WHERE id = ?2",
                params![rule, id],
            )?;
        }
        if let Some(deadline) = patch.deadline {
            let deadline = deadline.as_deref().map(check_date).transpose()?;
            tx.execute(
                "UPDATE tasks SET deadline = ?1 WHERE id = ?2",
                params![deadline, id],
            )?;
        }
        if let Some(evening) = patch.evening {
            // Only a task with a day can be in that day's evening.
            tx.execute(
                "UPDATE tasks SET evening = (?1 AND due_date IS NOT NULL) WHERE id = ?2",
                params![evening, id],
            )?;
        }
        if let Some(someday) = patch.someday {
            if someday {
                tx.execute(
                    "UPDATE tasks SET someday = 1, due_date = NULL, due_time = NULL, evening = 0,
                         snoozed_until = NULL WHERE id = ?1",
                    [id],
                )?;
            } else {
                tx.execute("UPDATE tasks SET someday = 0 WHERE id = ?1", [id])?;
            }
        }
        if let Some(project) = patch.project {
            let project = clean_name(project);
            if project != before.project {
                tx.execute(
                    "UPDATE tasks SET project = ?1, heading = NULL WHERE id = ?2",
                    params![project, id],
                )?;
            }
        }
        if let Some(heading) = patch.heading {
            tx.execute(
                "UPDATE tasks SET heading = CASE WHEN project IS NULL THEN NULL ELSE ?1 END WHERE id = ?2",
                params![clean_name(heading), id],
            )?;
        }
        if let Some(list) = patch.checklist {
            tx.execute(
                "UPDATE tasks SET checklist = ?1 WHERE id = ?2",
                params![checklist_json(&list), id],
            )?;
        }
        if let Some(priority) = patch.priority {
            tx.execute(
                "UPDATE tasks SET priority = ?1 WHERE id = ?2",
                params![clean_priority(priority), id],
            )?;
        }
        if let Some(duration) = patch.duration {
            tx.execute(
                "UPDATE tasks SET duration = ?1 WHERE id = ?2",
                params![clean_duration(duration), id],
            )?;
        }
        if let Some(paused) = patch.paused {
            tx.execute(
                "UPDATE tasks SET paused = (?1 AND recurrence IS NOT NULL) WHERE id = ?2",
                params![paused, id],
            )?;
        }
        if reschedule {
            // A new due moment gets a fresh notification.
            tx.execute(
                "UPDATE tasks SET snoozed_until = NULL, notified_at = NULL WHERE id = ?1",
                [id],
            )?;
        }
        if let Some(snooze) = patch.snoozed_until {
            tx.execute(
                "UPDATE tasks SET snoozed_until = ?1 WHERE id = ?2",
                params![snooze, id],
            )?;
        }
        if let Some(done) = patch.done {
            tx.execute(
                "UPDATE tasks SET done = ?1, completed_at = CASE WHEN ?1 THEN ?2 ELSE NULL END,
                     snoozed_until = NULL WHERE id = ?3",
                params![done, now(), id],
            )?;
            if done && !before.done && before.next_id.is_none() {
                effects.spawned = spawn_next(&tx, id)?;
            }
            if !done && before.done {
                effects.removed = unspawn_next(&tx, &before)?;
            }
        }
        tx.commit()?;
        Ok((self.get(id)?, effects))
    }

    pub fn reminder_links(&self) -> Result<Vec<ReminderLink>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT task_id, reminder_id, base_title, base_due, base_done, detached FROM reminder_links ORDER BY task_id",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ReminderLink {
                task_id: r.get(0)?,
                reminder_id: r.get(1)?,
                base: crate::reminders_sync::SyncState {
                    title: r.get(2)?,
                    due: r.get(3)?,
                    done: r.get(4)?,
                },
                detached: r.get(5)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    pub fn reminder_link(&self, task_id: i64) -> Result<Option<ReminderLink>, StoreError> {
        Ok(self
            .reminder_links()?
            .into_iter()
            .find(|l| l.task_id == task_id))
    }

    /// Create or replace the link for `link.task_id`.
    pub fn save_reminder_link(&self, link: &ReminderLink) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO reminder_links (task_id, reminder_id, base_title, base_due, base_done, detached)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(task_id) DO UPDATE SET reminder_id = ?2, base_title = ?3, base_due = ?4,
                 base_done = ?5, detached = ?6",
            params![
                link.task_id,
                link.reminder_id,
                link.base.title,
                link.base.due,
                link.base.done,
                link.detached
            ],
        )?;
        Ok(())
    }

    pub fn remove_reminder_link(&self, task_id: i64) -> Result<(), StoreError> {
        self.conn
            .execute("DELETE FROM reminder_links WHERE task_id = ?1", [task_id])?;
        Ok(())
    }

    /// Reminders whose tasks were deleted, waiting to be deleted in Reminders.
    pub fn reminder_trash(&self) -> Result<Vec<String>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT reminder_id FROM reminder_trash ORDER BY queued_at, reminder_id")?;
        let rows = stmt.query_map([], |r| r.get(0))?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// The reminder is gone from Reminders: stop trying to delete it.
    pub fn clear_reminder_trash(&self, reminder_id: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "DELETE FROM reminder_trash WHERE reminder_id = ?1",
            [reminder_id],
        )?;
        Ok(())
    }

    /// Completed tasks, newest first: up to `limit` finished before
    /// `before` (an RFC 3339 completion time; `None` = from the newest).
    pub fn logbook(&self, before: Option<&str>, limit: u32) -> Result<Vec<Task>, StoreError> {
        let mut stmt = self.conn.prepare(&format!(
            "{SELECT} WHERE done = 1 AND completed_at IS NOT NULL AND (?1 IS NULL OR completed_at < ?1)
             ORDER BY completed_at DESC, id DESC LIMIT ?2"
        ))?;
        let rows = stmt.query_map(params![before, limit.min(500)], map_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Every completed task, oldest first (up to `limit`, the newest kept):
    /// the windows of the city.
    pub fn city_windows(&self, limit: u32) -> Result<Vec<CityWindow>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, project, heading, completed_at FROM (
                 SELECT id, title, project, heading, completed_at FROM tasks
                 WHERE done = 1 AND completed_at IS NOT NULL
                 ORDER BY completed_at DESC, id DESC LIMIT ?1
             ) ORDER BY completed_at, id",
        )?;
        let rows = stmt.query_map(params![limit.min(20_000)], |r| {
            Ok(CityWindow {
                id: r.get(0)?,
                title: r.get(1)?,
                project: r.get(2)?,
                heading: r.get(3)?,
                completed_at: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Every project with its open and completed task counts, by name.
    pub fn projects(&self) -> Result<Vec<ProjectSummary>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT p.name, COALESCE(SUM(t.done = 0), 0), COALESCE(SUM(t.done = 1), 0),
                    (SELECT color FROM projects c WHERE c.name = p.name),
                    (SELECT source FROM mirror_projects m WHERE m.project = p.name AND m.stopped = 0 LIMIT 1)
             FROM (SELECT name FROM projects UNION SELECT project FROM tasks WHERE project IS NOT NULL) p
             LEFT JOIN tasks t ON t.project = p.name
             GROUP BY p.name ORDER BY p.name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(ProjectSummary {
                name: r.get(0)?,
                open: r.get(1)?,
                done: r.get(2)?,
                color: r.get(3)?,
                synced: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Every heading of every project (floors), with task counts.
    pub fn floors(&self) -> Result<Vec<FloorSummary>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT f.project, f.name, COALESCE(SUM(t.done = 0), 0), COALESCE(SUM(t.done = 1), 0)
             FROM (SELECT project, name FROM floors
                   UNION SELECT project, heading FROM tasks WHERE project IS NOT NULL AND heading IS NOT NULL) f
             LEFT JOIN tasks t ON t.project = f.project AND t.heading = f.name
             GROUP BY f.project, f.name ORDER BY f.project COLLATE NOCASE, f.name COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(FloorSummary {
                project: r.get(0)?,
                name: r.get(1)?,
                open: r.get(2)?,
                done: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Start a project (a building) with no tasks yet. Returns its name as
    /// stored, or `None` for a blank name.
    pub fn create_project(&self, name: &str) -> Result<Option<String>, StoreError> {
        let Some(name) = clean_name(Some(name.to_string())) else {
            return Ok(None);
        };
        self.conn.execute(
            "INSERT OR IGNORE INTO projects (name, created_at) VALUES (?1, ?2)",
            params![name, now()],
        )?;
        Ok(Some(name))
    }

    /// Add a heading (a floor) to a project, creating the project if needed.
    pub fn add_floor(&self, project: &str, name: &str) -> Result<Option<String>, StoreError> {
        let Some(project) = self.create_project(project)? else {
            return Ok(None);
        };
        let Some(name) = clean_name(Some(name.to_string())) else {
            return Ok(None);
        };
        self.conn.execute(
            "INSERT OR IGNORE INTO floors (project, name, created_at) VALUES (?1, ?2, ?3)",
            params![project, name, now()],
        )?;
        Ok(Some(name))
    }

    /// Rename a heading (floor) in a project, on its tasks too.
    pub fn rename_floor(&self, project: &str, from: &str, to: &str) -> Result<usize, StoreError> {
        let Some(to) = clean_name(Some(to.to_string())) else {
            return Ok(0);
        };
        self.conn.execute(
            "UPDATE OR IGNORE floors SET name = ?3 WHERE project = ?1 AND name = ?2",
            params![project, from, to],
        )?;
        self.conn.execute(
            "DELETE FROM floors WHERE project = ?1 AND name = ?2",
            params![project, from],
        )?;
        Ok(self.conn.execute(
            "UPDATE tasks SET heading = ?3 WHERE project = ?1 AND heading = ?2",
            params![project, from, to],
        )?)
    }

    /// Every task in a project, done ones too (a building with all its homes).
    pub fn project_tasks(&self, project: &str) -> Result<Vec<Task>, StoreError> {
        let mut stmt = self
            .conn
            .prepare(&format!("{SELECT} WHERE project = ?1 ORDER BY {ORDER}"))?;
        let rows = stmt.query_map([project], map_row)?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// Give a project its own color (`#rrggbb`), or none (`None`). Projects
    /// that only exist through their tasks get a row of their own here.
    pub fn set_project_color(&self, name: &str, color: Option<&str>) -> Result<(), StoreError> {
        let color = color.filter(|c| {
            c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit())
        });
        self.conn.execute(
            "INSERT OR IGNORE INTO projects (name, created_at) VALUES (?1, ?2)",
            params![name, now()],
        )?;
        self.conn.execute(
            "UPDATE projects SET color = ?2 WHERE name = ?1",
            params![name, color],
        )?;
        Ok(())
    }

    /// Take down an empty project (a building with no homes, done or not).
    /// Returns false, and changes nothing, while any task is still in it.
    pub fn delete_project(&self, name: &str) -> Result<bool, StoreError> {
        let used: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM tasks WHERE project = ?1",
            [name],
            |r| r.get(0),
        )?;
        if used > 0 {
            return Ok(false);
        }
        self.conn
            .execute("DELETE FROM floors WHERE project = ?1", [name])?;
        self.conn
            .execute("DELETE FROM projects WHERE name = ?1", [name])?;
        // A kept-in-step project that's taken down stays down.
        self.conn.execute(
            "UPDATE mirror_projects SET stopped = 1 WHERE project = ?1",
            [name],
        )?;
        Ok(true)
    }

    /// Take down an empty floor (a heading with no tasks, done or not).
    pub fn delete_floor(&self, project: &str, name: &str) -> Result<bool, StoreError> {
        let used: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM tasks WHERE project = ?1 AND heading = ?2",
            params![project, name],
            |r| r.get(0),
        )?;
        if used > 0 {
            return Ok(false);
        }
        self.conn.execute(
            "DELETE FROM floors WHERE project = ?1 AND name = ?2",
            params![project, name],
        )?;
        Ok(true)
    }

    /// Rename a project on every task in it (done ones too).
    pub fn rename_project(&self, from: &str, to: &str) -> Result<usize, StoreError> {
        let Some(to) = clean_name(Some(to.to_string())) else {
            return Ok(0);
        };
        self.conn.execute(
            "UPDATE OR IGNORE projects SET name = ?2 WHERE name = ?1",
            params![from, to],
        )?;
        self.conn
            .execute("DELETE FROM projects WHERE name = ?1", params![from])?;
        self.conn.execute(
            "UPDATE OR IGNORE floors SET project = ?2 WHERE project = ?1",
            params![from, to],
        )?;
        self.conn
            .execute("DELETE FROM floors WHERE project = ?1", params![from])?;
        self.conn.execute(
            "UPDATE mirror_projects SET project = ?2 WHERE project = ?1",
            params![from, to],
        )?;
        Ok(self.conn.execute(
            "UPDATE tasks SET project = ?2 WHERE project = ?1",
            params![from, to],
        )?)
    }

    /// Skip one occurrence of a repeating task: it moves to the series' next
    /// day, as if this one had been done.
    pub fn skip(&self, id: i64) -> Result<Task, StoreError> {
        let t = self.get(id)?;
        let Some(rule) = t.recurrence.as_deref().and_then(Repeat::parse) else {
            return Ok(t);
        };
        // The last one of a counted series: nothing comes after it.
        if rule.is_last() {
            return Ok(t);
        }
        let today = chrono::Local::now().date_naive();
        let Some(next) = next_occurrence(&t, &rule, today) else {
            return Ok(t);
        };
        let next = next.format("%Y-%m-%d").to_string();
        // Skipping uses up one of a counted series.
        let rule = rule.for_next().to_stored();
        self.conn.execute(
            "UPDATE tasks SET due_date = ?1, series_date = NULL, snoozed_until = NULL,
                 notified_at = NULL, someday = 0, recurrence = ?3 WHERE id = ?2",
            params![next, id, rule],
        )?;
        self.get(id)
    }

    /// The other app's ids already brought in from `source`.
    pub fn imported_ids(
        &self,
        source: &str,
    ) -> Result<std::collections::HashSet<String>, StoreError> {
        let mut stmt = self
            .conn
            .prepare("SELECT ext_id FROM imports WHERE source = ?1")?;
        let rows = stmt.query_map([source], |r| r.get::<_, String>(0))?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Bring in tasks from another app in one go: projects and floors first
    /// (empty ones too), then every task not brought in before. All or
    /// nothing: if the database fails part way, nothing is kept.
    pub fn import(
        &self,
        source: &str,
        floors: &[(String, Option<String>)],
        items: &[Imported],
    ) -> Result<ImportReport, StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        for (project, floor) in floors {
            match floor {
                Some(f) => self.add_floor(project, f)?,
                None => self.create_project(project)?,
            };
        }
        let known = self.imported_ids(source)?;
        let mut report = ImportReport::default();
        for item in items {
            if known.contains(&item.ext_id) {
                report.skipped += 1;
                continue;
            }
            let task = match self.insert(item.task.clone()) {
                Ok(t) => t,
                Err(StoreError::Sqlite(e)) => return Err(e.into()),
                Err(_) => {
                    report.failed += 1;
                    continue;
                }
            };
            let created = item
                .created_at
                .clone()
                .unwrap_or_else(|| task.created_at.clone());
            let completed = item
                .done
                .then(|| item.completed_at.clone().unwrap_or_else(|| created.clone()));
            self.conn.execute(
                "UPDATE tasks SET created_at = ?1, done = ?2, completed_at = ?3 WHERE id = ?4",
                params![created, item.done, completed, task.id],
            )?;
            self.conn.execute(
                "INSERT OR IGNORE INTO imports (source, ext_id, task_id, imported_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![source, item.ext_id, task.id, now()],
            )?;
            report.added += 1;
            report.done += item.done as usize;
        }
        tx.commit()?;
        Ok(report)
    }

    pub fn delete(&self, id: i64) -> Result<(), StoreError> {
        match self.conn.execute("DELETE FROM tasks WHERE id = ?1", [id])? {
            0 => Err(StoreError::NotFound(id)),
            _ => Ok(()),
        }
    }
}

const SELECT: &str = "SELECT id, title, due_date, source_text, done, created_at, created_tz, completed_at,
    due_time, recurrence, source_app, source_bundle, source_url, snoozed_until, notified_at, next_id, notes,
    deadline, evening, someday, project, heading, checklist, series_date, paused, priority, duration, agent, agent_at FROM tasks";

/// By day, all-day tasks before timed ones, then by time.
const ORDER: &str = "due_date IS NULL, due_date, due_time IS NOT NULL, due_time, done, created_at";

fn map_row(r: &Row<'_>) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?,
        title: r.get(1)?,
        due_date: r.get(2)?,
        source_text: r.get(3)?,
        done: r.get(4)?,
        created_at: r.get(5)?,
        created_tz: r.get(6)?,
        completed_at: r.get(7)?,
        due_time: r.get(8)?,
        recurrence: r.get(9)?,
        source_app: r.get(10)?,
        source_bundle: r.get(11)?,
        source_url: r.get(12)?,
        snoozed_until: r.get(13)?,
        notified_at: r.get(14)?,
        next_id: r.get(15)?,
        notes: r.get(16)?,
        deadline: r.get(17)?,
        evening: r.get(18)?,
        someday: r.get(19)?,
        project: r.get(20)?,
        heading: r.get(21)?,
        checklist: r
            .get::<_, Option<String>>(22)?
            .and_then(|j| serde_json::from_str::<Vec<ChecklistItem>>(&j).ok())
            .unwrap_or_default(),
        series_date: r.get(23)?,
        paused: r.get(24)?,
        priority: r.get(25)?,
        duration: r.get(26)?,
        agent: r.get(27)?,
        agent_at: r.get(28)?,
    })
}

/// Create the next occurrence of repeating task `id` (inside `tx`).
fn spawn_next(tx: &rusqlite::Transaction<'_>, id: i64) -> Result<Option<i64>, StoreError> {
    let t = tx.query_row(&format!("{SELECT} WHERE id = ?1"), [id], map_row)?;
    let Some(rule) = t.recurrence.as_deref().and_then(Repeat::parse) else {
        return Ok(None);
    };
    // The last of a counted series ("after 6 times").
    if rule.is_last() {
        return Ok(None);
    }
    let parse = |d: &str| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok();
    let base = t
        .series_date
        .as_deref()
        .or(t.due_date.as_deref())
        .and_then(parse);
    let today = chrono::Local::now().date_naive();
    // Past its end date or the deadline: this was the last one.
    let Some(next_day) = next_occurrence(&t, &rule, today) else {
        return Ok(None);
    };
    let next = next_day.format("%Y-%m-%d").to_string();
    let next_rule = rule.for_next().to_stored();
    // The same next one on every Mac: its uid comes from the series, so two
    // Macs that both finish this occurrence while apart make the same task.
    let uid = next_uid(tx, id, base)?;
    if let Some(uid) = &uid {
        let existing: Option<i64> = tx
            .query_row("SELECT id FROM tasks WHERE uid = ?1", [uid], |r| r.get(0))
            .optional()?;
        if let Some(next_id) = existing {
            // Already here (finished earlier, un-ticked, now finished again
            // after the next one was done): point at it, don't make another.
            tx.execute(
                "UPDATE tasks SET next_id = ?1 WHERE id = ?2",
                params![next_id, id],
            )?;
            return Ok(Some(next_id));
        }
    }
    let fresh: Vec<ChecklistItem> = t
        .checklist
        .iter()
        .map(|c| ChecklistItem {
            text: c.text.clone(),
            done: false,
        })
        .collect();
    tx.execute(
        "INSERT INTO tasks (title, due_date, due_time, recurrence, source_text, source_app,
                            source_bundle, source_url, created_at, created_tz, uid)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
        params![
            t.title,
            next,
            t.due_time,
            next_rule,
            t.source_text,
            t.source_app,
            t.source_bundle,
            t.source_url,
            now(),
            t.created_tz,
            uid
        ],
    )?;
    let next_id = tx.last_insert_rowid();
    tx.execute(
        "UPDATE tasks SET notes = ?1, deadline = ?2, evening = ?3, project = ?4, heading = ?5,
             checklist = ?6, priority = ?7, duration = ?8 WHERE id = ?9",
        params![
            t.notes,
            t.deadline,
            t.evening,
            t.project,
            t.heading,
            checklist_json(&fresh),
            t.priority,
            t.duration,
            next_id
        ],
    )?;
    tx.execute(
        "UPDATE tasks SET next_id = ?1 WHERE id = ?2",
        params![next_id, id],
    )?;
    Ok(Some(next_id))
}

/// The day after this occurrence of `t`: on the series' rhythm after the
/// later of its own day and `today` (or from `today` for "after I finish").
/// `None` when the rule's end date or the task's deadline comes first: a
/// deadline always ends the series.
fn next_occurrence(t: &Task, rule: &Repeat, today: NaiveDate) -> Option<NaiveDate> {
    let parse = |d: &str| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok();
    // The series' own day for this one (it may have been moved on its own).
    let base = t
        .series_date
        .as_deref()
        .or(t.due_date.as_deref())
        .and_then(parse)
        .unwrap_or(today);
    // Done early (or moved later on its own): the next one still comes after
    // the day this one actually had.
    let after = t
        .due_date
        .as_deref()
        .and_then(parse)
        .map_or(today, |d| d.max(today));
    let next = rule.next(base, after, today)?;
    if t.deadline
        .as_deref()
        .and_then(parse)
        .is_some_and(|dl| next > dl)
    {
        return None;
    }
    Some(next)
}

/// The uid of the occurrence that follows task `id`, whose series day is
/// `base`: the same on every Mac, since the task's own uid and series day
/// are synced. `None` for a task with no uid (it then gets a random one).
fn next_uid(
    tx: &rusqlite::Transaction<'_>,
    id: i64,
    base: Option<NaiveDate>,
) -> Result<Option<String>, StoreError> {
    let uid: Option<String> = tx
        .query_row("SELECT uid FROM tasks WHERE id = ?1", [id], |r| r.get(0))
        .optional()?
        .flatten();
    Ok(uid.map(|u| series_uid(&u, base)))
}

/// `next_uid`'s formula: 32 hex characters, like a random uid.
pub(crate) fn series_uid(parent_uid: &str, base: Option<NaiveDate>) -> String {
    use sha2::{Digest, Sha256};
    use std::fmt::Write;
    let day = base.map_or_else(|| "none".to_string(), |d| d.format("%Y-%m-%d").to_string());
    let digest = Sha256::digest(format!("todocity-next\u{1f}{parent_uid}\u{1f}{day}").as_bytes());
    let mut out = String::with_capacity(32);
    for b in &digest[..16] {
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Undo `spawn_next`: remove the next occurrence unless it was completed.
/// It's found by its series uid as well as `next_id`, which only the Mac
/// that made it knows: un-ticking on another Mac removes it too.
fn unspawn_next(tx: &rusqlite::Transaction<'_>, before: &Task) -> Result<Option<i64>, StoreError> {
    let parse = |d: &str| NaiveDate::parse_from_str(d, "%Y-%m-%d").ok();
    let base = before
        .series_date
        .as_deref()
        .or(before.due_date.as_deref())
        .and_then(parse);
    let by_uid = match next_uid(tx, before.id, base)? {
        Some(uid) => tx
            .query_row("SELECT id FROM tasks WHERE uid = ?1", [uid], |r| r.get(0))
            .optional()?,
        None => None,
    };
    let Some(next) = before.next_id.or(by_uid) else {
        return Ok(None);
    };
    let mut removed = tx.execute("DELETE FROM tasks WHERE id = ?1 AND done = 0", [next])?;
    if let Some(other) = by_uid.filter(|o| *o != next) {
        removed += tx.execute("DELETE FROM tasks WHERE id = ?1 AND done = 0", [other])?;
    }
    tx.execute("UPDATE tasks SET next_id = NULL WHERE id = ?1", [before.id])?;
    Ok((removed > 0).then_some(next))
}

/// Longest task, in minutes: a whole day.
pub const MAX_DURATION_MIN: u32 = 1440;

/// 1 to 1440 minutes; 0 (or nothing) is no set length, more is a whole day.
fn clean_duration(d: Option<u32>) -> Option<u32> {
    d.filter(|m| *m > 0).map(|m| m.min(MAX_DURATION_MIN))
}

/// 0 to 3; anything else is no priority.
fn clean_priority(p: u8) -> u8 {
    if p <= 3 {
        p
    } else {
        0
    }
}

/// Longest description kept, in characters.
pub const MAX_NOTES_CHARS: usize = 2000;

/// Trimmed, capped, and `None` when empty.
fn clean_notes(s: Option<&str>) -> Option<String> {
    let s = s?.trim();
    (!s.is_empty()).then(|| s.chars().take(MAX_NOTES_CHARS).collect())
}

/// Longest project or heading name, in characters.
const MAX_NAME_CHARS: usize = 60;
/// Most checklist steps kept, and the longest step.
const MAX_CHECKLIST: usize = 50;
const MAX_STEP_CHARS: usize = 200;

/// A project or heading name: single-spaced, capped, `None` when empty.
fn clean_name(s: Option<String>) -> Option<String> {
    let s = s?.split_whitespace().collect::<Vec<_>>().join(" ");
    (!s.is_empty()).then(|| s.chars().take(MAX_NAME_CHARS).collect())
}

/// The checklist as stored: JSON, empty steps dropped, `None` when empty.
fn checklist_json(items: &[ChecklistItem]) -> Option<String> {
    let clean: Vec<ChecklistItem> = items
        .iter()
        .filter_map(|c| {
            let text = c.text.split_whitespace().collect::<Vec<_>>().join(" ");
            (!text.is_empty()).then(|| ChecklistItem {
                text: text.chars().take(MAX_STEP_CHARS).collect(),
                done: c.done,
            })
        })
        .take(MAX_CHECKLIST)
        .collect();
    (!clean.is_empty()).then(|| serde_json::to_string(&clean).unwrap_or_default())
}

fn clean_opt(s: Option<String>) -> Option<String> {
    s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

fn check_time(t: &str) -> Result<String, StoreError> {
    chrono::NaiveTime::parse_from_str(t, "%H:%M")
        .map(|nt| nt.format("%H:%M").to_string())
        .map_err(|_| StoreError::BadTime(t.to_string()))
}

fn check_rule(r: &str) -> Result<String, StoreError> {
    Repeat::parse(r)
        .map(|r| r.to_stored())
        .ok_or_else(|| StoreError::BadRecurrence(r.to_string()))
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn clean_title(t: &str) -> Result<String, StoreError> {
    let t = t.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        Err(StoreError::EmptyTitle)
    } else {
        Ok(t)
    }
}

fn check_date(d: &str) -> Result<String, StoreError> {
    NaiveDate::parse_from_str(d, "%Y-%m-%d")
        .map(|nd| nd.format("%Y-%m-%d").to_string())
        .map_err(|_| StoreError::BadDate(d.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn task(title: &str, due: Option<&str>) -> NewTask {
        NewTask {
            title: title.into(),
            due_date: due.map(Into::into),
            ..Default::default()
        }
    }

    #[test]
    fn insert_and_list_orders_by_day_then_undated() {
        let s = Store::open_in_memory().unwrap();
        s.insert(task("someday", None)).unwrap();
        s.insert(task("friday", Some("2026-10-16"))).unwrap();
        s.insert(task("today", Some("2026-10-13"))).unwrap();
        let titles: Vec<_> = s.list(None).unwrap().into_iter().map(|t| t.title).collect();
        assert_eq!(titles, ["today", "friday", "someday"]);
    }

    #[test]
    fn rejects_bad_dates_and_empty_titles() {
        let s = Store::open_in_memory().unwrap();
        assert!(matches!(
            s.insert(task("x", Some("Friday"))),
            Err(StoreError::BadDate(_))
        ));
        assert!(matches!(
            s.insert(task("x", Some("2026-02-30"))),
            Err(StoreError::BadDate(_))
        ));
        assert!(matches!(
            s.insert(task("   ", None)),
            Err(StoreError::EmptyTitle)
        ));
    }

    #[test]
    fn update_patch_semantics() {
        let s = Store::open_in_memory().unwrap();
        let t = s.insert(task("a", Some("2026-10-16"))).unwrap();
        let t = s
            .update(
                t.id,
                TaskPatch {
                    title: Some(" b  c ".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(t.title, "b c");
        assert_eq!(t.due_date.as_deref(), Some("2026-10-16"));
        let t = s
            .update(
                t.id,
                TaskPatch {
                    due_date: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(t.due_date, None);
        let t = s
            .update(
                t.id,
                TaskPatch {
                    done: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(t.done && t.completed_at.is_some());
        let t = s
            .update(
                t.id,
                TaskPatch {
                    done: Some(false),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(!t.done && t.completed_at.is_none());
    }

    #[test]
    fn patch_json_distinguishes_clear_from_absent() {
        let absent: TaskPatch = serde_json::from_str(r#"{}"#).unwrap();
        assert_eq!(absent.due_date, None);
        let clear: TaskPatch = serde_json::from_str(r#"{"due_date":null}"#).unwrap();
        assert_eq!(clear.due_date, Some(None));
    }

    #[test]
    fn done_tasks_hidden_unless_recent() {
        let s = Store::open_in_memory().unwrap();
        let t = s.insert(task("x", None)).unwrap();
        s.update(
            t.id,
            TaskPatch {
                done: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert!(s.list(None).unwrap().is_empty());
        assert_eq!(s.list(Some("2000-01-01")).unwrap().len(), 1);
    }

    #[test]
    fn delete_and_not_found() {
        let s = Store::open_in_memory().unwrap();
        let t = s.insert(task("x", None)).unwrap();
        s.delete(t.id).unwrap();
        assert!(matches!(s.delete(t.id), Err(StoreError::NotFound(_))));
    }

    #[test]
    fn file_db_uses_wal_and_migrates_once() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tasks.db");
        {
            let s = Store::open(&path).unwrap();
            s.insert(task("persisted", None)).unwrap();
        }
        let s = Store::open(&path).unwrap();
        let mode: String = s
            .conn
            .pragma_query_value(None, "journal_mode", |r| r.get(0))
            .unwrap();
        assert_eq!(mode.to_lowercase(), "wal");
        assert_eq!(s.list(None).unwrap()[0].title, "persisted");
    }

    #[test]
    fn reminder_links_round_trip_and_cascade() {
        use crate::reminders_sync::SyncState;
        let s = Store::open_in_memory().unwrap();
        let t = s.insert(task("x", Some("2026-10-16"))).unwrap();
        let mut link = ReminderLink {
            task_id: t.id,
            reminder_id: "ABC-123".into(),
            base: SyncState {
                title: "x".into(),
                due: Some("2026-10-16".into()),
                done: false,
            },
            detached: false,
        };
        s.save_reminder_link(&link).unwrap();
        assert_eq!(s.reminder_link(t.id).unwrap(), Some(link.clone()));
        link.base.done = true;
        s.save_reminder_link(&link).unwrap();
        assert_eq!(s.reminder_links().unwrap(), vec![link]);
        // Deleting the task removes its link.
        s.delete(t.id).unwrap();
        assert!(s.reminder_links().unwrap().is_empty());
    }

    #[test]
    fn times_sort_after_all_day_and_clear_with_the_date() {
        let s = Store::open_in_memory().unwrap();
        let mk = |title: &str, time: Option<&str>| NewTask {
            title: title.into(),
            due_date: Some("2026-10-16".into()),
            due_time: time.map(Into::into),
            ..Default::default()
        };
        s.insert(mk("late", Some("17:30"))).unwrap();
        s.insert(mk("early", Some("9:05"))).unwrap();
        s.insert(mk("all day", None)).unwrap();
        let list = s.list(None).unwrap();
        let titles: Vec<_> = list.iter().map(|t| t.title.as_str()).collect();
        assert_eq!(titles, ["all day", "early", "late"]);
        assert_eq!(list[1].due_time.as_deref(), Some("09:05"));
        let t = s
            .update(
                list[1].id,
                TaskPatch {
                    due_date: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!((t.due_date, t.due_time), (None, None));
        assert!(matches!(
            s.insert(NewTask {
                due_time: Some("25:00".into()),
                ..mk("x", None)
            }),
            Err(StoreError::BadTime(_))
        ));
        // A time without a day is dropped.
        let t = s
            .insert(NewTask {
                title: "y".into(),
                due_time: Some("10:00".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(t.due_time, None);
    }

    #[test]
    fn completing_a_repeating_task_creates_the_next_one_and_undo_removes_it() {
        let s = Store::open_in_memory().unwrap();
        let today = chrono::Local::now().date_naive();
        let t = s
            .insert(NewTask {
                title: "Water plants".into(),
                due_date: Some(today.format("%Y-%m-%d").to_string()),
                due_time: Some("08:00".into()),
                recurrence: Some("daily".into()),
                source_app: Some("Notes".into()),
                ..Default::default()
            })
            .unwrap();
        let (done, fx) = s
            .update_with_effects(
                t.id,
                TaskPatch {
                    done: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        let next_id = fx.spawned.expect("next occurrence");
        assert_eq!(done.next_id, Some(next_id));
        let next = s.get(next_id).unwrap();
        let tomorrow = (today + chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        assert_eq!(next.due_date.as_deref(), Some(tomorrow.as_str()));
        assert_eq!(next.due_time.as_deref(), Some("08:00"));
        assert_eq!(next.recurrence.as_deref(), Some("daily"));
        assert_eq!(next.source_app.as_deref(), Some("Notes"));
        assert!(!next.done);

        // Completing again doesn't spawn twice.
        let (_, fx) = s
            .update_with_effects(
                t.id,
                TaskPatch {
                    done: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(fx.spawned, None);

        // Undo: the untouched next occurrence goes away.
        let (undone, fx) = s
            .update_with_effects(
                t.id,
                TaskPatch {
                    done: Some(false),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(fx.removed, Some(next_id));
        assert_eq!(undone.next_id, None);
        assert!(matches!(s.get(next_id), Err(StoreError::NotFound(_))));
        assert!(matches!(
            s.insert(NewTask {
                title: "z".into(),
                recurrence: Some("hourly".into()),
                ..Default::default()
            }),
            Err(StoreError::BadRecurrence(_))
        ));
    }

    #[test]
    fn rescheduling_resets_notification_state() {
        let s = Store::open_in_memory().unwrap();
        let t = s.insert(task("x", Some("2026-10-16"))).unwrap();
        s.mark_notified(t.id, "2026-10-16T09:00:00").unwrap();
        let t = s
            .update(
                t.id,
                TaskPatch {
                    snoozed_until: Some(Some("2026-10-16T09:15:00".into())),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(t.notified_at.as_deref(), Some("2026-10-16T09:00:00"));
        assert_eq!(t.snoozed_until.as_deref(), Some("2026-10-16T09:15:00"));
        let t = s
            .update(
                t.id,
                TaskPatch {
                    due_date: Some(Some("2026-10-17".into())),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!((t.notified_at, t.snoozed_until), (None, None));
        // Moving a fired reminder to another day while clearing its snooze
        // also forgets the old notification.
        s.mark_notified(t.id, "2026-10-17T09:00:00").unwrap();
        let t = s
            .update(
                t.id,
                TaskPatch {
                    due_date: Some(Some("2026-10-18".into())),
                    snoozed_until: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!((t.notified_at, t.snoozed_until), (None, None));
    }

    #[test]
    fn descriptions_are_saved_cleared_and_carried_to_the_next_repeat() {
        let s = Store::open_in_memory().unwrap();
        let t = s
            .insert(NewTask {
                title: "Pay rent".into(),
                notes: Some("  https://bank.example/pay  ".into()),
                due_date: Some(
                    chrono::Local::now()
                        .date_naive()
                        .format("%Y-%m-%d")
                        .to_string(),
                ),
                recurrence: Some("monthly".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(t.notes.as_deref(), Some("https://bank.example/pay"));
        let (_, fx) = s
            .update_with_effects(
                t.id,
                TaskPatch {
                    done: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        let next = s.get(fx.spawned.unwrap()).unwrap();
        assert_eq!(next.notes, t.notes);
        let t = s
            .update(
                t.id,
                TaskPatch {
                    notes: Some(Some("   ".into())),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(t.notes, None);
        let long = "x".repeat(MAX_NOTES_CHARS + 10);
        let t = s
            .update(
                t.id,
                TaskPatch {
                    notes: Some(Some(long)),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(t.notes.unwrap().chars().count(), MAX_NOTES_CHARS);
    }

    #[test]
    fn backup_copies_everything() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store::open_in_memory().unwrap();
        s.insert(task("keep me", None)).unwrap();
        let path = dir.path().join("copy.db");
        s.backup_to(&path).unwrap();
        let copy = Store::open(&path).unwrap();
        assert_eq!(copy.all().unwrap()[0].title, "keep me");
    }

    fn day(offset: i64) -> String {
        (chrono::Local::now().date_naive() + chrono::Duration::days(offset))
            .format("%Y-%m-%d")
            .to_string()
    }

    fn patch(f: impl FnOnce(&mut TaskPatch)) -> TaskPatch {
        let mut p = TaskPatch::default();
        f(&mut p);
        p
    }

    #[test]
    fn checklists_deadlines_and_projects_round_trip() {
        let s = Store::open_in_memory().unwrap();
        let t = s
            .insert(NewTask {
                title: "Pack for the offsite".into(),
                due_date: Some(day(1)),
                deadline: Some(day(3)),
                project: Some("  Offsite   2026 ".into()),
                heading: Some("Travel".into()),
                checklist: vec![
                    ChecklistItem {
                        text: " Charger ".into(),
                        done: false,
                    },
                    ChecklistItem {
                        text: "   ".into(),
                        done: false,
                    },
                    ChecklistItem {
                        text: "Passport".into(),
                        done: true,
                    },
                ],
                ..Default::default()
            })
            .unwrap();
        assert_eq!(t.deadline.as_deref(), Some(day(3).as_str()));
        assert_eq!(t.project.as_deref(), Some("Offsite 2026"));
        assert_eq!(t.heading.as_deref(), Some("Travel"));
        assert_eq!(
            t.checklist,
            vec![
                ChecklistItem {
                    text: "Charger".into(),
                    done: false
                },
                ChecklistItem {
                    text: "Passport".into(),
                    done: true
                },
            ]
        );

        // Changing project drops the heading; clearing the deadline works.
        let t = s
            .update(
                t.id,
                patch(|p| {
                    p.project = Some(Some("Home".into()));
                    p.deadline = Some(None);
                    p.checklist = Some(vec![]);
                }),
            )
            .unwrap();
        assert_eq!(
            (t.project.as_deref(), t.heading.as_deref()),
            (Some("Home"), None)
        );
        assert_eq!(t.deadline, None);
        assert!(t.checklist.is_empty());

        // A heading needs a project.
        let t = s
            .update(
                t.id,
                patch(|p| {
                    p.project = Some(None);
                    p.heading = Some(Some("Later".into()));
                }),
            )
            .unwrap();
        assert_eq!((t.project, t.heading), (None, None));
        assert!(matches!(
            s.insert(NewTask {
                title: "x".into(),
                deadline: Some("friday".into()),
                ..Default::default()
            }),
            Err(StoreError::BadDate(_))
        ));
    }

    #[test]
    fn someday_and_evening_follow_the_date() {
        let s = Store::open_in_memory().unwrap();
        let t = s.insert(task("Learn piano", Some(&day(0)))).unwrap();
        let t = s.update(t.id, patch(|p| p.evening = Some(true))).unwrap();
        assert!(t.evening);
        // Someday clears the day (and the evening).
        let t = s.update(t.id, patch(|p| p.someday = Some(true))).unwrap();
        assert!(t.someday && !t.evening);
        assert_eq!(t.due_date, None);
        // No evening without a day.
        let t = s.update(t.id, patch(|p| p.evening = Some(true))).unwrap();
        assert!(!t.evening);
        // A day brings it back from Someday.
        let t = s
            .update(t.id, patch(|p| p.due_date = Some(Some(day(2)))))
            .unwrap();
        assert!(!t.someday);
        // Inserting with someday and a date keeps the date.
        let t = s
            .insert(NewTask {
                title: "y".into(),
                due_date: Some(day(0)),
                someday: true,
                ..Default::default()
            })
            .unwrap();
        assert!(!t.someday);
    }

    #[test]
    fn repeats_carry_steps_and_deadline_and_keep_their_rhythm() {
        let s = Store::open_in_memory().unwrap();
        let t = s
            .insert(NewTask {
                title: "Weekly report".into(),
                due_date: Some(day(0)),
                deadline: Some(day(30)),
                recurrence: Some("weekly".into()),
                project: Some("Work".into()),
                checklist: vec![ChecklistItem {
                    text: "Numbers".into(),
                    done: true,
                }],
                ..Default::default()
            })
            .unwrap();
        // Just this one moves to tomorrow; the series stays on today's weekday.
        let t = s
            .update(
                t.id,
                patch(|p| {
                    p.due_date = Some(Some(day(1)));
                    p.only_this = Some(true);
                }),
            )
            .unwrap();
        assert_eq!(t.series_date.as_deref(), Some(day(0).as_str()));
        let (_, fx) = s
            .update_with_effects(t.id, patch(|p| p.done = Some(true)))
            .unwrap();
        let next = s.get(fx.spawned.unwrap()).unwrap();
        assert_eq!(next.due_date.as_deref(), Some(day(7).as_str()));
        // The deadline is the end of the series, so it stays put.
        assert_eq!(next.deadline.as_deref(), Some(day(30).as_str()));
        assert_eq!(next.project.as_deref(), Some("Work"));
        assert_eq!(
            next.checklist,
            vec![ChecklistItem {
                text: "Numbers".into(),
                done: false
            }]
        );
        assert_eq!(next.series_date, None);

        // Moving the whole series: the next follows the new day.
        let t2 = s
            .insert(NewTask {
                title: "Gym".into(),
                due_date: Some(day(0)),
                recurrence: Some("weekly".into()),
                ..Default::default()
            })
            .unwrap();
        let t2 = s
            .update(t2.id, patch(|p| p.due_date = Some(Some(day(2)))))
            .unwrap();
        assert_eq!(t2.series_date, None);
        let (_, fx) = s
            .update_with_effects(t2.id, patch(|p| p.done = Some(true)))
            .unwrap();
        assert_eq!(
            s.get(fx.spawned.unwrap()).unwrap().due_date.as_deref(),
            Some(day(9).as_str())
        );
    }

    #[test]
    fn repeats_never_go_past_the_deadline() {
        let s = Store::open_in_memory().unwrap();
        let t = s
            .insert(NewTask {
                title: "Water the seedlings".into(),
                due_date: Some(day(0)),
                deadline: Some(day(15)),
                recurrence: Some("weekly".into()),
                priority: 2,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(t.priority, 2);
        // Day 0 → day 7 → day 14: each on or before the deadline.
        let (_, fx) = s
            .update_with_effects(t.id, patch(|p| p.done = Some(true)))
            .unwrap();
        let second = s.get(fx.spawned.unwrap()).unwrap();
        assert_eq!(second.due_date.as_deref(), Some(day(7).as_str()));
        assert_eq!(second.priority, 2);
        let (_, fx) = s
            .update_with_effects(second.id, patch(|p| p.done = Some(true)))
            .unwrap();
        let third = s.get(fx.spawned.unwrap()).unwrap();
        assert_eq!(third.due_date.as_deref(), Some(day(14).as_str()));
        // Skipping can't move it past the deadline either.
        assert_eq!(
            s.skip(third.id).unwrap().due_date.as_deref(),
            Some(day(14).as_str())
        );
        // Day 21 would be after day 15: that was the last one.
        let (_, fx) = s
            .update_with_effects(third.id, patch(|p| p.done = Some(true)))
            .unwrap();
        assert_eq!(fx.spawned, None);
    }

    #[test]
    fn custom_repeats_count_down_and_end() {
        let s = Store::open_in_memory().unwrap();
        let t = s
            .insert(NewTask {
                title: "Physio exercises".into(),
                due_date: Some(day(0)),
                recurrence: Some("rrule:FREQ=DAILY;INTERVAL=3;COUNT=3".into()),
                ..Default::default()
            })
            .unwrap();
        // Day 0 (3 left) → day 3 (2 left) → day 6 (the last).
        let (_, fx) = s
            .update_with_effects(t.id, patch(|p| p.done = Some(true)))
            .unwrap();
        let second = s.get(fx.spawned.unwrap()).unwrap();
        assert_eq!(second.due_date.as_deref(), Some(day(3).as_str()));
        assert_eq!(
            second.recurrence.as_deref(),
            Some("rrule:FREQ=DAILY;INTERVAL=3;COUNT=2")
        );
        // Skipping uses one up: day 6 is now the last.
        let skipped = s.skip(second.id).unwrap();
        assert_eq!(skipped.due_date.as_deref(), Some(day(6).as_str()));
        assert_eq!(
            skipped.recurrence.as_deref(),
            Some("rrule:FREQ=DAILY;INTERVAL=3;COUNT=1")
        );
        assert_eq!(
            s.skip(second.id).unwrap().due_date.as_deref(),
            Some(day(6).as_str())
        );
        let (_, fx) = s
            .update_with_effects(second.id, patch(|p| p.done = Some(true)))
            .unwrap();
        assert_eq!(fx.spawned, None);
    }

    #[test]
    fn custom_repeats_stop_at_the_deadline_and_are_stored_plainly() {
        let s = Store::open_in_memory().unwrap();
        // A custom rule that is really a preset is stored as the preset,
        // so older versions on other Macs read it.
        let t = s
            .insert(NewTask {
                title: "Team notes".into(),
                due_date: Some(day(0)),
                recurrence: Some("rrule:FREQ=WEEKLY".into()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(t.recurrence.as_deref(), Some("weekly"));
        assert!(s
            .update(
                t.id,
                patch(|p| p.recurrence = Some(Some("every tuesday".into())))
            )
            .is_err());
        let t = s
            .update(
                t.id,
                patch(|p| {
                    p.recurrence = Some(Some("rrule:FREQ=DAILY;INTERVAL=4".into()));
                    p.deadline = Some(Some(day(6)));
                }),
            )
            .unwrap();
        let (_, fx) = s
            .update_with_effects(t.id, patch(|p| p.done = Some(true)))
            .unwrap();
        let next = s.get(fx.spawned.unwrap()).unwrap();
        assert_eq!(next.due_date.as_deref(), Some(day(4).as_str()));
        // Day 8 would be past the deadline (day 6).
        let (_, fx) = s
            .update_with_effects(next.id, patch(|p| p.done = Some(true)))
            .unwrap();
        assert_eq!(fx.spawned, None);
    }

    #[test]
    fn priority_is_set_cleared_and_kept_in_range() {
        let s = Store::open_in_memory().unwrap();
        let t = s.insert(task("Call the bank", None)).unwrap();
        assert_eq!(t.priority, 0);
        let t = s.update(t.id, patch(|p| p.priority = Some(1))).unwrap();
        assert_eq!(t.priority, 1);
        let t = s.update(t.id, patch(|p| p.priority = Some(9))).unwrap();
        assert_eq!(t.priority, 0);
    }

    #[test]
    fn skip_pause_and_stop_a_repeat() {
        let s = Store::open_in_memory().unwrap();
        let t = s
            .insert(NewTask {
                title: "Standup notes".into(),
                due_date: Some(day(0)),
                recurrence: Some("daily".into()),
                ..Default::default()
            })
            .unwrap();
        let t = s.skip(t.id).unwrap();
        assert_eq!(t.due_date.as_deref(), Some(day(1).as_str()));
        assert!(!t.done);
        let t = s.update(t.id, patch(|p| p.paused = Some(true))).unwrap();
        assert!(t.paused);
        // Stopping the repeat also un-pauses.
        let t = s
            .update(t.id, patch(|p| p.recurrence = Some(None)))
            .unwrap();
        assert!(!t.paused && t.recurrence.is_none());
        // Only repeating tasks pause; skipping a one-off changes nothing.
        let t = s.update(t.id, patch(|p| p.paused = Some(true))).unwrap();
        assert!(!t.paused);
        assert_eq!(
            s.skip(t.id).unwrap().due_date.as_deref(),
            Some(day(1).as_str())
        );
    }

    #[test]
    fn logbook_pages_newest_first_and_projects_count() {
        let s = Store::open_in_memory().unwrap();
        let mut ids = vec![];
        for (i, title) in ["a", "b", "c"].iter().enumerate() {
            let t = s
                .insert(NewTask {
                    title: (*title).into(),
                    project: Some("P".into()),
                    ..Default::default()
                })
                .unwrap();
            s.conn
                .execute(
                    "UPDATE tasks SET done = 1, completed_at = ?1 WHERE id = ?2",
                    params![format!("2026-10-2{i}T10:00:00Z"), t.id],
                )
                .unwrap();
            ids.push(t.id);
        }
        s.insert(NewTask {
            title: "open".into(),
            project: Some("P".into()),
            ..Default::default()
        })
        .unwrap();
        // A building and a floor can exist before any task is in them.
        assert_eq!(
            s.create_project("  Garden  reno ").unwrap().as_deref(),
            Some("Garden reno")
        );
        s.add_floor("Garden reno", "Beds").unwrap();
        s.add_floor("P", "Later").unwrap();
        let names: Vec<_> = s
            .projects()
            .unwrap()
            .into_iter()
            .map(|p| (p.name, p.open, p.done))
            .collect();
        assert_eq!(
            names,
            vec![("Garden reno".to_string(), 0, 0), ("P".to_string(), 1, 3)]
        );
        let floors: Vec<_> = s
            .floors()
            .unwrap()
            .into_iter()
            .map(|f| (f.project, f.name))
            .collect();
        assert_eq!(
            floors,
            vec![
                ("Garden reno".to_string(), "Beds".to_string()),
                ("P".to_string(), "Later".to_string())
            ]
        );
        assert_eq!(s.rename_project("Garden reno", "Garden").unwrap(), 0);
        assert!(s
            .floors()
            .unwrap()
            .iter()
            .any(|f| f.project == "Garden" && f.name == "Beds"));
        // Empty floors and buildings can be taken down; ones with homes can't.
        assert_eq!(s.project_tasks("P").unwrap().len(), 4);
        assert!(!s.delete_project("P").unwrap());
        assert!(s.delete_floor("Garden", "Beds").unwrap());
        assert!(s.delete_project("Garden").unwrap());
        assert!(s.delete_floor("P", "Later").unwrap());
        assert!(!s.projects().unwrap().iter().any(|p| p.name == "Garden"));
        assert!(s.floors().unwrap().is_empty());
        let city = s.city_windows(10).unwrap();
        assert_eq!(
            city.iter().map(|w| w.title.as_str()).collect::<Vec<_>>(),
            ["a", "b", "c"]
        );
        assert_eq!(city[0].project.as_deref(), Some("P"));
        let newest = s.city_windows(2).unwrap();
        assert_eq!(
            newest.iter().map(|w| w.title.as_str()).collect::<Vec<_>>(),
            ["b", "c"]
        );
        let page = s.logbook(None, 2).unwrap();
        assert_eq!(
            page.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(),
            ["c", "b"]
        );
        let rest = s.logbook(page[1].completed_at.as_deref(), 2).unwrap();
        assert_eq!(
            rest.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(),
            ["a"]
        );
        assert_eq!(
            s.projects().unwrap(),
            vec![ProjectSummary {
                name: "P".into(),
                open: 1,
                done: 3,
                color: None,
                synced: None
            }]
        );
        s.set_project_color("P", Some("#ff8800")).unwrap();
        assert_eq!(s.projects().unwrap()[0].color.as_deref(), Some("#ff8800"));
        s.set_project_color("P", Some("red; drop")).unwrap();
        assert_eq!(s.projects().unwrap()[0].color, None);
    }

    #[test]
    fn upgrades_a_version_1_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("tasks.db");
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(MIGRATIONS[0]).unwrap();
            conn.pragma_update(None, "user_version", 1).unwrap();
            conn.execute(
                "INSERT INTO tasks (title, created_at) VALUES ('old task', '2026-10-01T00:00:00Z')",
                [],
            )
            .unwrap();
        }
        let s = Store::open(&path).unwrap();
        assert_eq!(s.list(None).unwrap()[0].title, "old task");
        assert!(s.reminder_links().unwrap().is_empty());
    }

    #[test]
    fn durations_are_kept_cleaned_and_cleared() {
        let s = Store::open_in_memory().unwrap();
        let t = s
            .insert(NewTask {
                title: "Stand-up".into(),
                due_date: Some("2026-11-02".into()),
                due_time: Some("09:07".into()),
                duration: Some(7),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(
            (t.due_time.as_deref(), t.duration),
            (Some("09:07"), Some(7))
        );
        let set = |d: Option<u32>| {
            s.update(
                t.id,
                TaskPatch {
                    duration: Some(d),
                    ..Default::default()
                },
            )
            .unwrap()
            .duration
        };
        assert_eq!(set(Some(45)), Some(45));
        assert_eq!(set(Some(5000)), Some(MAX_DURATION_MIN));
        assert_eq!(set(Some(0)), None);
        assert_eq!(set(Some(30)), Some(30));
        assert_eq!(set(None), None);
        // Other edits leave it alone.
        set(Some(25));
        let t = s
            .update(
                t.id,
                TaskPatch {
                    title: Some("Stand-up with Maya".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(t.duration, Some(25));
        // And a patch from JSON can set or clear it.
        let p: TaskPatch = serde_json::from_str(r#"{"duration": 15}"#).unwrap();
        assert_eq!(p.duration, Some(Some(15)));
        let p: TaskPatch = serde_json::from_str(r#"{"duration": null}"#).unwrap();
        assert_eq!(p.duration, Some(None));
        let p: TaskPatch = serde_json::from_str("{}").unwrap();
        assert_eq!(p.duration, None);
    }

    #[test]
    fn the_next_repeat_keeps_its_length() {
        let s = Store::open_in_memory().unwrap();
        let t = s
            .insert(NewTask {
                title: "Run".into(),
                due_date: Some("2026-11-02".into()),
                due_time: Some("06:30".into()),
                recurrence: Some("daily".into()),
                duration: Some(40),
                ..Default::default()
            })
            .unwrap();
        let (_, fx) = s
            .update_with_effects(
                t.id,
                TaskPatch {
                    done: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        let next = s.get(fx.spawned.unwrap()).unwrap();
        assert_eq!(
            (next.due_time.as_deref(), next.duration),
            (Some("06:30"), Some(40))
        );
    }
}
