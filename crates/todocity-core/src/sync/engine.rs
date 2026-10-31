//! Finding what changed on this Mac, and folding in what changed elsewhere.
//!
//! Nothing in the rest of the app has to remember to "log" a change. The
//! store keeps a *shadow*: for every synced thing (a task, a project, a
//! heading, a Mac) and each of its fields, the last value all Macs agreed on
//! and when it was set. [`Store::sync_collect`] compares the real tables
//! with the shadow; every difference is a change made here, stamped with a
//! hybrid logical clock and marked to send. [`Store::sync_apply`] takes
//! changes from other Macs, keeps each field's newest value (last writer
//! wins, field by field) and writes it straight into the tables — never
//! through the app's own logic, so a repeating task finished on another Mac
//! doesn't spawn its next one twice.
//!
//! Entities are named `t:<uid>` (a task), `p:<name>` (a project), `f:<project>␟<name>`
//! (a heading) and `d:<device>` (a Mac in the group).

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use rusqlite::types::{Value as Sql, ValueRef};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::store::{Store, StoreError};

/// Task columns that travel between Macs. Local-only state (notification
/// times, snoozes, links to Reminders, the local row id) stays put.
pub const TASK_FIELDS: &[&str] = &[
    "title",
    "due_date",
    "due_time",
    "recurrence",
    "notes",
    "deadline",
    "evening",
    "someday",
    "project",
    "heading",
    "checklist",
    "done",
    "completed_at",
    "paused",
    "priority",
    "duration",
    "series_date",
    "created_at",
    "created_tz",
    "source_text",
    "source_app",
    "source_bundle",
    "source_url",
];

/// Separates a project from a heading in a heading's entity name.
pub const UNIT: char = '\u{1f}';

/// One field of one thing, set to a value at a moment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Change {
    #[serde(rename = "e")]
    pub entity: String,
    #[serde(rename = "f")]
    pub field: String,
    #[serde(rename = "v")]
    pub value: Value,
    #[serde(rename = "h")]
    pub hlc: String,
}

/// What applying a batch did.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Applied {
    /// Fields that were newer than ours and taken.
    pub fields: usize,
    /// Tasks, projects or headings that changed here as a result.
    pub things: usize,
    /// Another Mac said this Mac was removed from the group.
    pub removed_here: bool,
}

/// A Mac in the sync group, as this Mac knows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Device {
    pub id: String,
    pub name: String,
    pub removed: bool,
}

// ── Clock ──────────────────────────────────────────────────────────────────

/// A hybrid logical clock: wall-clock milliseconds, a counter for many
/// changes in one millisecond (or a clock that went backwards), and the
/// device id to break ties. Formatted so plain string order is time order.
#[derive(Debug, Clone, PartialEq, Eq)]
struct Clock {
    millis: i64,
    counter: u32,
}

const MAX_COUNTER: u32 = 999_999;

impl Clock {
    fn parse(s: &str) -> Option<Self> {
        let mut it = s.splitn(3, '-');
        let millis = it.next()?.parse().ok()?;
        let counter = it.next()?.parse().ok()?;
        Some(Self { millis, counter })
    }

    fn tick(&mut self, now_ms: i64, device: &str) -> String {
        if now_ms > self.millis {
            self.millis = now_ms;
            self.counter = 0;
        } else if self.counter >= MAX_COUNTER {
            self.millis += 1;
            self.counter = 0;
        } else {
            self.counter += 1;
        }
        format!("{:013}-{:06}-{device}", self.millis, self.counter)
    }

    /// Move up to another Mac's time, unless it's impossible (more than a
    /// day ahead of this Mac's clock, or out of range): a broken clock
    /// elsewhere mustn't drag this one into the far future.
    fn observe(&mut self, other: &str) {
        if let Some(o) = Clock::parse(other) {
            let sane =
                o.counter <= MAX_COUNTER && o.millis >= 0 && o.millis <= now_ms() + 86_400_000;
            if sane && (o.millis, o.counter) > (self.millis, self.counter) {
                *self = o;
            }
        }
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

// ── Conversions ────────────────────────────────────────────────────────────

fn to_json(v: ValueRef<'_>) -> Value {
    match v {
        ValueRef::Null => Value::Null,
        ValueRef::Integer(i) => Value::from(i),
        ValueRef::Real(f) => Value::from(f),
        ValueRef::Text(t) => Value::from(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(_) => Value::Null,
    }
}

fn to_sql(v: &Value) -> Sql {
    match v {
        Value::Null => Sql::Null,
        Value::Bool(b) => Sql::Integer(i64::from(*b)),
        Value::Number(n) => match n.as_i64() {
            Some(i) => Sql::Integer(i),
            None => Sql::Real(n.as_f64().unwrap_or(0.0)),
        },
        Value::String(s) => Sql::Text(s.clone()),
        other => Sql::Text(other.to_string()),
    }
}

type Fields = BTreeMap<String, Value>;

impl Store {
    fn sync_get(&self, key: &str) -> Result<Option<String>, StoreError> {
        Ok(self
            .conn
            .query_row("SELECT value FROM sync_state WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
    }

    fn sync_put(&self, key: &str, value: &str) -> Result<(), StoreError> {
        self.conn.execute(
            "INSERT INTO sync_state (key, value) VALUES (?1, ?2)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    /// The last box this Mac has read from the mailbox.
    pub fn sync_cursor(&self) -> Result<i64, StoreError> {
        Ok(self
            .sync_get("cursor")?
            .and_then(|s| s.parse().ok())
            .unwrap_or(0))
    }

    pub fn set_sync_cursor(&self, n: i64) -> Result<(), StoreError> {
        self.sync_put("cursor", &n.to_string())
    }

    fn clock(&self) -> Result<Clock, StoreError> {
        Ok(self
            .sync_get("hlc")?
            .and_then(|s| Clock::parse(&s))
            .unwrap_or(Clock {
                millis: 0,
                counter: 0,
            }))
    }

    fn save_clock(&self, c: &Clock) -> Result<(), StoreError> {
        self.sync_put("hlc", &format!("{}-{}", c.millis, c.counter))
    }

    /// Forget everything sync knew (leaving a group, or joining a new one).
    /// Tasks stay as they are.
    pub fn sync_reset(&self) -> Result<(), StoreError> {
        // The change counter and the clock carry on.
        self.conn.execute_batch(
            "DELETE FROM sync_shadow; DELETE FROM sync_state WHERE key NOT IN ('dirty', 'hlc');",
        )?;
        Ok(())
    }

    fn shadow(&self, prefix: &str) -> Result<HashMap<String, HashMap<String, String>>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT entity, field, value FROM sync_shadow WHERE substr(entity, 1, 2) = ?1",
        )?;
        let mut out: HashMap<String, HashMap<String, String>> = HashMap::new();
        let rows = stmt.query_map([prefix], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        for row in rows {
            let (e, f, v) = row?;
            out.entry(e).or_default().insert(f, v);
        }
        Ok(out)
    }

    /// Everything this Mac shares right now, as entity → fields.
    fn current(
        &self,
        local_only: &HashSet<String>,
    ) -> Result<BTreeMap<String, Fields>, StoreError> {
        let mut out = BTreeMap::new();
        let cols = TASK_FIELDS.join(", ");
        let mut stmt = self.conn.prepare(&format!(
            "SELECT uid, {cols} FROM tasks WHERE uid IS NOT NULL"
        ))?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let uid: String = r.get(0)?;
            let mut f = Fields::new();
            for (i, name) in TASK_FIELDS.iter().enumerate() {
                f.insert((*name).to_string(), to_json(r.get_ref(i + 1)?));
            }
            if let Some(Value::String(p)) = f.get("project") {
                if local_only.contains(p) {
                    continue;
                }
            }
            f.insert("deleted".into(), Value::Bool(false));
            out.insert(format!("t:{uid}"), f);
        }
        let mut stmt = self.conn.prepare("SELECT name, color FROM projects")?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let name: String = r.get(0)?;
            if local_only.contains(&name) {
                continue;
            }
            let mut f = Fields::new();
            f.insert("color".into(), to_json(r.get_ref(1)?));
            f.insert("deleted".into(), Value::Bool(false));
            out.insert(format!("p:{name}"), f);
        }
        let mut stmt = self.conn.prepare("SELECT project, name FROM floors")?;
        let mut rows = stmt.query([])?;
        while let Some(r) = rows.next()? {
            let (project, name): (String, String) = (r.get(0)?, r.get(1)?);
            if local_only.contains(&project) {
                continue;
            }
            let mut f = Fields::new();
            f.insert("deleted".into(), Value::Bool(false));
            out.insert(format!("f:{project}{UNIT}{name}"), f);
        }
        Ok(out)
    }

    /// Compare the tables with the shadow and record every difference as a
    /// change to send. Tasks, projects and headings in `local_only`
    /// projects are left out (and leave the other Macs if they were there).
    /// `name` is this Mac's name as others should see it. Returns how many
    /// fields changed.
    pub fn sync_collect(
        &self,
        device: &str,
        name: &str,
        local_only: &HashSet<String>,
    ) -> Result<usize, StoreError> {
        // Nothing changed since the last look (same tables, name and
        // rules): skip comparing everything.
        let dirty = self.sync_get("dirty")?.unwrap_or_default();
        let mut rules: Vec<&str> = local_only.iter().map(String::as_str).collect();
        rules.sort_unstable();
        let mark = format!("{dirty}|{name}|{}", rules.join("\u{1f}"));
        if !dirty.is_empty() && self.sync_get("collected")?.as_deref() == Some(mark.as_str()) {
            return Ok(0);
        }

        let tx = self.conn.unchecked_transaction()?;
        let mut clock = self.clock()?;
        let now = now_ms();
        let mut changed = 0;
        let mut put = |entity: &str,
                       field: &str,
                       value: &str,
                       clock: &mut Clock|
         -> Result<(), StoreError> {
            let hlc = clock.tick(now, device);
            tx.execute(
                "INSERT INTO sync_shadow (entity, field, value, hlc, pending) VALUES (?1, ?2, ?3, ?4, 1)
                 ON CONFLICT (entity, field) DO UPDATE SET value = excluded.value, hlc = excluded.hlc, pending = 1",
                params![entity, field, value, hlc],
            )?;
            changed += 1;
            Ok(())
        };

        let current = self.current(local_only)?;
        for prefix in ["t:", "p:", "f:"] {
            let shadow = self.shadow(prefix)?;
            for (entity, fields) in current
                .range(prefix.to_string()..)
                .take_while(|(e, _)| e.starts_with(prefix))
            {
                let known = shadow.get(entity);
                for (field, value) in fields {
                    let text = value.to_string();
                    if known.and_then(|k| k.get(field)) != Some(&text) {
                        put(entity, field, &text, &mut clock)?;
                    }
                }
            }
            // Gone from here: deleted (or moved into a This-Mac-only
            // project). Only things that were ever whole here count, so a
            // task we've only heard part of is never deleted by accident.
            for (entity, known) in &shadow {
                let whole = prefix != "t:" || known.contains_key("title");
                if whole
                    && !current.contains_key(entity)
                    && known.get("deleted").map(String::as_str) != Some("true")
                {
                    put(entity, "deleted", "true", &mut clock)?;
                }
            }
        }

        // This Mac's own name. (Whether it's been removed is for others to say.)
        let me = format!("d:{device}");
        let name_json = Value::from(name).to_string();
        let known: Option<String> = tx
            .query_row(
                "SELECT value FROM sync_shadow WHERE entity = ?1 AND field = 'name'",
                [&me],
                |r| r.get(0),
            )
            .optional()?;
        if known.as_deref() != Some(&name_json) {
            put(&me, "name", &name_json, &mut clock)?;
        }
        self.save_clock(&clock)?;
        self.sync_put("collected", &mark)?;
        tx.commit()?;
        Ok(changed)
    }

    /// Set one field from this Mac directly (e.g. removing another Mac).
    pub fn sync_set(
        &self,
        device: &str,
        entity: &str,
        field: &str,
        value: Value,
    ) -> Result<(), StoreError> {
        let mut clock = self.clock()?;
        let hlc = clock.tick(now_ms(), device);
        self.conn.execute(
            "INSERT INTO sync_shadow (entity, field, value, hlc, pending) VALUES (?1, ?2, ?3, ?4, 1)
             ON CONFLICT (entity, field) DO UPDATE SET value = excluded.value, hlc = excluded.hlc, pending = 1",
            params![entity, field, value.to_string(), hlc],
        )?;
        self.save_clock(&clock)
    }

    /// Changes made here and not sent yet, oldest first.
    pub fn sync_pending(&self, limit: usize) -> Result<Vec<Change>, StoreError> {
        self.changes_where("WHERE pending = 1 ORDER BY hlc LIMIT ?1", limit)
    }

    /// Everything, to bring a Mac that missed boxes up to date.
    pub fn sync_snapshot(&self) -> Result<Vec<Change>, StoreError> {
        self.changes_where("WHERE ?1 > 0 ORDER BY entity, field", usize::MAX >> 1)
    }

    fn changes_where(&self, clause: &str, n: usize) -> Result<Vec<Change>, StoreError> {
        let mut stmt = self.conn.prepare(&format!(
            "SELECT entity, field, value, hlc FROM sync_shadow {clause}"
        ))?;
        let rows = stmt.query_map([n as i64], |r| {
            let v: String = r.get(2)?;
            Ok(Change {
                entity: r.get(0)?,
                field: r.get(1)?,
                value: serde_json::from_str(&v).unwrap_or(Value::Null),
                hlc: r.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<Vec<_>, _>>()?)
    }

    /// These were sent: no longer pending (unless changed again since).
    pub fn sync_mark_sent(&self, sent: &[Change]) -> Result<(), StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        {
            let mut stmt = tx.prepare(
                "UPDATE sync_shadow SET pending = 0 WHERE entity = ?1 AND field = ?2 AND hlc = ?3",
            )?;
            for c in sent {
                stmt.execute(params![c.entity, c.field, c.hlc])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Fold in changes from other Macs: each field keeps its newest value,
    /// and tasks, projects and headings are written to match.
    pub fn sync_apply(&self, device: &str, changes: &[Change]) -> Result<Applied, StoreError> {
        let dirty_before = self.sync_get("dirty")?;
        let collected = self.sync_get("collected")?;
        let tx = self.conn.unchecked_transaction()?;
        let mut clock = self.clock()?;
        let mut touched = BTreeSet::<String>::new();
        let mut out = Applied::default();
        {
            let mut get =
                tx.prepare("SELECT hlc FROM sync_shadow WHERE entity = ?1 AND field = ?2")?;
            let mut set = tx.prepare(
                "INSERT INTO sync_shadow (entity, field, value, hlc, pending) VALUES (?1, ?2, ?3, ?4, 0)
                 ON CONFLICT (entity, field) DO UPDATE SET value = excluded.value, hlc = excluded.hlc, pending = 0",
            )?;
            for c in changes {
                if !valid_entity(&c.entity) || c.field.is_empty() || c.field.len() > 40 {
                    continue;
                }
                clock.observe(&c.hlc);
                let ours: Option<String> = get
                    .query_row(params![c.entity, c.field], |r| r.get(0))
                    .optional()?;
                if ours.as_deref().is_some_and(|h| h >= c.hlc.as_str()) {
                    continue;
                }
                set.execute(params![c.entity, c.field, c.value.to_string(), c.hlc])?;
                out.fields += 1;
                touched.insert(c.entity.clone());
            }
        }
        for entity in &touched {
            let mut fields = Fields::new();
            {
                let mut stmt =
                    tx.prepare("SELECT field, value FROM sync_shadow WHERE entity = ?1")?;
                let rows = stmt.query_map([entity], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?;
                for row in rows {
                    let (f, v) = row?;
                    fields.insert(f, serde_json::from_str(&v).unwrap_or(Value::Null));
                }
            }
            let deleted = fields.get("deleted") == Some(&Value::Bool(true));
            // One thing that won't write (it shouldn't happen) mustn't stop
            // the rest: it stays in the shadow and is tried again next time.
            tx.execute_batch("SAVEPOINT thing")?;
            let wrote = if let Some(uid) = entity.strip_prefix("t:") {
                write_task(&tx, uid, &fields, deleted)
            } else if let Some(name) = entity.strip_prefix("p:") {
                write_project(&tx, name, &fields, deleted)
            } else if let Some(rest) = entity.strip_prefix("f:") {
                match rest.split_once(UNIT) {
                    Some((p, n)) => write_floor(&tx, p, n, deleted),
                    None => Ok(false),
                }
            } else {
                if entity.strip_prefix("d:") == Some(device)
                    && fields.get("removed") == Some(&Value::Bool(true))
                {
                    out.removed_here = true;
                }
                Ok(false)
            };
            match wrote {
                Ok(changed) => {
                    tx.execute_batch("RELEASE thing")?;
                    out.things += usize::from(changed);
                }
                Err(e) => {
                    log::warn!(
                        "sync: couldn't write {}: {e}",
                        entity.split(':').next().unwrap_or("")
                    );
                    tx.execute_batch("ROLLBACK TO thing; RELEASE thing")?;
                }
            }
        }
        self.save_clock(&clock)?;
        // The tables were in step with the shadow before, and what was just
        // written matches it too: still in step.
        if let (Some(before), Some(c)) = (dirty_before, collected) {
            if let Some(rest) = c.strip_prefix(&format!("{before}|")) {
                let after = self.sync_get("dirty")?.unwrap_or_default();
                self.sync_put("collected", &format!("{after}|{rest}"))?;
            }
        }
        tx.commit()?;
        Ok(out)
    }

    /// Every Mac this one has heard of in its group.
    pub fn sync_devices(&self) -> Result<Vec<Device>, StoreError> {
        let shadow = self.shadow("d:")?;
        let mut out: Vec<Device> = shadow
            .into_iter()
            .map(|(e, f)| Device {
                id: e[2..].to_string(),
                name: f
                    .get("name")
                    .and_then(|v| serde_json::from_str::<String>(v).ok())
                    .unwrap_or_else(|| "A Mac".into()),
                removed: f.get("removed").map(String::as_str) == Some("true"),
            })
            .collect();
        out.sort_by(|a, b| {
            a.name
                .to_lowercase()
                .cmp(&b.name.to_lowercase())
                .then(a.id.cmp(&b.id))
        });
        Ok(out)
    }

    /// How many changes are waiting to be sent.
    pub fn sync_pending_count(&self) -> Result<i64, StoreError> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*) FROM sync_shadow WHERE pending = 1",
            [],
            |r| r.get(0),
        )?)
    }
}

fn valid_entity(e: &str) -> bool {
    e.len() > 2 && e.len() <= 300 && matches!(e.get(..2), Some("t:" | "p:" | "f:" | "d:"))
}

/// Make the task with `uid` match `fields`. Returns whether anything changed.
fn write_task(
    tx: &rusqlite::Transaction<'_>,
    uid: &str,
    fields: &Fields,
    deleted: bool,
) -> Result<bool, rusqlite::Error> {
    let existing: Option<(i64, Option<String>, Option<String>)> = tx
        .query_row(
            "SELECT id, due_date, due_time FROM tasks WHERE uid = ?1",
            [uid],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    if deleted {
        return Ok(match existing {
            Some((id, ..)) => tx.execute("DELETE FROM tasks WHERE id = ?1", [id])? > 0,
            None => false,
        });
    }
    let title_ok = matches!(fields.get("title"), Some(Value::String(t)) if !t.trim().is_empty());
    let present: Vec<&str> = TASK_FIELDS
        .iter()
        .copied()
        .filter(|f| fields.contains_key(*f))
        .collect();
    match existing {
        Some((id, due, time)) => {
            if present.is_empty() {
                return Ok(false);
            }
            let sets: Vec<String> = present
                .iter()
                .enumerate()
                .map(|(i, f)| format!("{f} = ?{}", i + 2))
                .collect();
            let mut values: Vec<Sql> = vec![Sql::Integer(id)];
            values.extend(present.iter().map(|f| to_sql(&fields[*f])));
            tx.execute(
                &format!("UPDATE tasks SET {} WHERE id = ?1", sets.join(", ")),
                rusqlite::params_from_iter(values),
            )?;
            // Moved to another day or time elsewhere: remind afresh here.
            let moved = |f: &str, old: &Option<String>| {
                fields.get(f).is_some_and(|v| v.as_str() != old.as_deref())
            };
            if moved("due_date", &due) || moved("due_time", &time) {
                tx.execute(
                    "UPDATE tasks SET notified_at = NULL, snoozed_until = NULL WHERE id = ?1",
                    [id],
                )?;
            }
            Ok(true)
        }
        // Not here yet: add it once we know enough to show it.
        None if title_ok => {
            let mut cols = vec!["uid".to_string()];
            let mut values = vec![Sql::Text(uid.to_string())];
            for f in &present {
                cols.push((*f).to_string());
                values.push(to_sql(&fields[*f]));
            }
            if !fields.contains_key("created_at") {
                cols.push("created_at".into());
                values.push(Sql::Text(
                    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
                ));
            }
            let marks: Vec<String> = (1..=values.len()).map(|i| format!("?{i}")).collect();
            tx.execute(
                &format!(
                    "INSERT INTO tasks ({}) VALUES ({})",
                    cols.join(", "),
                    marks.join(", ")
                ),
                rusqlite::params_from_iter(values),
            )?;
            Ok(true)
        }
        None => Ok(false),
    }
}

fn write_project(
    tx: &rusqlite::Transaction<'_>,
    name: &str,
    fields: &Fields,
    deleted: bool,
) -> Result<bool, rusqlite::Error> {
    if deleted {
        return Ok(tx.execute("DELETE FROM projects WHERE name = ?1", [name])? > 0);
    }
    let added = tx.execute(
        "INSERT OR IGNORE INTO projects (name, created_at) VALUES (?1, ?2)",
        params![
            name,
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        ],
    )?;
    let color = fields.get("color").map(to_sql).unwrap_or(Sql::Null);
    let recolored = tx.execute(
        "UPDATE projects SET color = ?2 WHERE name = ?1 AND color IS NOT ?2",
        params![name, color],
    )?;
    Ok(added + recolored > 0)
}

fn write_floor(
    tx: &rusqlite::Transaction<'_>,
    project: &str,
    name: &str,
    deleted: bool,
) -> Result<bool, rusqlite::Error> {
    if deleted {
        return Ok(tx.execute(
            "DELETE FROM floors WHERE project = ?1 AND name = ?2",
            params![project, name],
        )? > 0);
    }
    Ok(tx.execute(
        "INSERT OR IGNORE INTO floors (project, name, created_at) VALUES (?1, ?2, ?3)",
        params![
            project,
            name,
            chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
        ],
    )? > 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{ChecklistItem, NewTask, TaskPatch};

    fn none() -> HashSet<String> {
        HashSet::new()
    }

    /// Send everything pending from `a` to `b`.
    fn send(a: &Store, a_dev: &str, b: &Store, b_dev: &str) -> Applied {
        a.sync_collect(a_dev, a_dev, &none()).unwrap();
        let p = a.sync_pending(100_000).unwrap();
        a.sync_mark_sent(&p).unwrap();
        b.sync_apply(b_dev, &p).unwrap()
    }

    fn titles(s: &Store) -> Vec<String> {
        let mut v: Vec<String> = s.all().unwrap().into_iter().map(|t| t.title).collect();
        v.sort();
        v
    }

    fn new(title: &str) -> NewTask {
        NewTask {
            title: title.into(),
            ..Default::default()
        }
    }

    #[test]
    fn clock_orders_as_text() {
        let mut c = Clock {
            millis: 0,
            counter: 0,
        };
        let a = c.tick(1000, "x");
        let b = c.tick(1000, "x");
        let back = c.tick(900, "x"); // the wall clock went backwards
        assert!(a < b && b < back, "{a} {b} {back}");
        c.observe("0000000005000-000003-y");
        // Nonsense from a broken clock is ignored.
        c.observe("9223372036854775807-000003-z");
        c.observe("0000000005000-4294967295-z");
        let d = c.tick(1000, "x");
        assert!(d.as_str() > "0000000005000-000003-y");
    }

    #[test]
    fn two_macs_converge() {
        let a = Store::open_in_memory().unwrap();
        let b = Store::open_in_memory().unwrap();
        let t = a
            .insert(NewTask {
                title: "Book flights".into(),
                due_date: Some("2026-11-02".into()),
                project: Some("Trip".into()),
                checklist: vec![ChecklistItem {
                    text: "Compare".into(),
                    done: false,
                }],
                ..Default::default()
            })
            .unwrap();
        a.create_project("Trip").unwrap();
        a.set_project_color("Trip", Some("#336699")).unwrap();
        a.add_floor("Trip", "Before").unwrap();
        b.insert(new("Call Maya")).unwrap();

        send(&a, "A", &b, "B");
        send(&b, "B", &a, "A");
        assert_eq!(titles(&a), vec!["Book flights", "Call Maya"]);
        assert_eq!(titles(&a), titles(&b));
        let on_b = b
            .all()
            .unwrap()
            .into_iter()
            .find(|x| x.title == "Book flights")
            .unwrap();
        assert_eq!(on_b.due_date.as_deref(), Some("2026-11-02"));
        assert_eq!(on_b.checklist.len(), 1);
        assert_eq!(b.projects().unwrap()[0].color.as_deref(), Some("#336699"));
        assert_eq!(b.floors().unwrap()[0].name, "Before");

        // Nothing new after applying: no echo back.
        assert_eq!(b.sync_collect("B", "B", &none()).unwrap(), 0);
        assert_eq!(a.sync_collect("A", "A", &none()).unwrap(), 0);

        // Edit on A, finish on B, delete elsewhere.
        a.update(
            t.id,
            TaskPatch {
                title: Some("Book flights to Lisbon".into()),
                ..Default::default()
            },
        )
        .unwrap();
        send(&a, "A", &b, "B");
        let id_b = b
            .all()
            .unwrap()
            .into_iter()
            .find(|x| x.title.starts_with("Book"))
            .unwrap()
            .id;
        b.update(
            id_b,
            TaskPatch {
                done: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        send(&b, "B", &a, "A");
        let on_a = a.get(t.id).unwrap();
        assert_eq!(on_a.title, "Book flights to Lisbon");
        assert!(on_a.done);

        let maya = a
            .all()
            .unwrap()
            .into_iter()
            .find(|x| x.title == "Call Maya")
            .unwrap();
        a.delete(maya.id).unwrap();
        send(&a, "A", &b, "B");
        assert_eq!(titles(&b), vec!["Book flights to Lisbon"]);
    }

    #[test]
    fn the_newest_edit_of_each_field_wins() {
        let a = Store::open_in_memory().unwrap();
        let b = Store::open_in_memory().unwrap();
        let t = a.insert(new("Draft")).unwrap();
        send(&a, "A", &b, "B");
        let tb = b.all().unwrap()[0].id;

        // Both edit while apart: A the title, then B the title and notes.
        a.update(
            t.id,
            TaskPatch {
                title: Some("From A".into()),
                ..Default::default()
            },
        )
        .unwrap();
        a.sync_collect("A", "A", &none()).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(5));
        b.update(
            tb,
            TaskPatch {
                title: Some("From B".into()),
                notes: Some(Some("b's note".into())),
                ..Default::default()
            },
        )
        .unwrap();
        b.sync_collect("B", "B", &none()).unwrap();

        send(&a, "A", &b, "B");
        send(&b, "B", &a, "A");
        let (x, y) = (a.get(t.id).unwrap(), b.get(tb).unwrap());
        assert_eq!(x.title, "From B");
        assert_eq!(
            (x.title.as_str(), x.notes.as_deref()),
            (y.title.as_str(), y.notes.as_deref())
        );
    }

    #[test]
    fn finishing_a_repeating_task_elsewhere_does_not_spawn_twice() {
        let a = Store::open_in_memory().unwrap();
        let b = Store::open_in_memory().unwrap();
        let t = a
            .insert(NewTask {
                title: "Water plants".into(),
                due_date: Some("2026-11-02".into()),
                recurrence: Some("weekly".into()),
                ..Default::default()
            })
            .unwrap();
        send(&a, "A", &b, "B");
        a.update(
            t.id,
            TaskPatch {
                done: Some(true),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(a.all().unwrap().len(), 2);
        send(&a, "A", &b, "B");
        assert_eq!(b.all().unwrap().len(), 2);
        assert_eq!(b.all().unwrap().iter().filter(|t| t.done).count(), 1);
    }

    #[test]
    fn this_mac_only_projects_stay_here() {
        let a = Store::open_in_memory().unwrap();
        let b = Store::open_in_memory().unwrap();
        let private: HashSet<String> = ["Home".to_string()].into();
        a.create_project("Home").unwrap();
        a.insert(NewTask {
            title: "Fix sink".into(),
            project: Some("Home".into()),
            ..Default::default()
        })
        .unwrap();
        let shared = a.insert(new("Send report")).unwrap();
        a.sync_collect("A", "A", &private).unwrap();
        let p = a.sync_pending(1000).unwrap();
        b.sync_apply("B", &p).unwrap();
        assert_eq!(titles(&b), vec!["Send report"]);
        assert!(b.projects().unwrap().is_empty());

        // Moving a shared task into it takes it off the other Mac.
        a.update(
            shared.id,
            TaskPatch {
                project: Some(Some("Home".into())),
                ..Default::default()
            },
        )
        .unwrap();
        a.sync_collect("A", "A", &private).unwrap();
        b.sync_apply("B", &a.sync_pending(1000).unwrap()).unwrap();
        assert!(titles(&b).is_empty());
        // And moving it back out brings it back.
        a.update(
            shared.id,
            TaskPatch {
                project: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
        a.sync_collect("A", "A", &private).unwrap();
        b.sync_apply("B", &a.sync_pending(1000).unwrap()).unwrap();
        assert_eq!(titles(&b), vec!["Send report"]);
    }

    #[test]
    fn snapshots_catch_up_a_mac_that_missed_everything() {
        let a = Store::open_in_memory().unwrap();
        let b = Store::open_in_memory().unwrap();
        a.insert(new("One")).unwrap();
        let two = a.insert(new("Two")).unwrap();
        a.sync_collect("A", "A", &none()).unwrap();
        a.delete(two.id).unwrap();
        a.sync_collect("A", "A", &none()).unwrap();
        b.sync_apply("B", &a.sync_snapshot().unwrap()).unwrap();
        assert_eq!(titles(&b), vec!["One"]);
        // Applying the same thing again changes nothing.
        let again = b.sync_apply("B", &a.sync_snapshot().unwrap()).unwrap();
        assert_eq!(again.fields, 0);
    }

    #[test]
    fn half_known_tasks_are_never_deleted_by_accident() {
        let b = Store::open_in_memory().unwrap();
        let only_done = Change {
            entity: "t:abc".into(),
            field: "done".into(),
            value: Value::from(1),
            hlc: "0000000001000-000000-A".into(),
        };
        b.sync_apply("B", &[only_done]).unwrap();
        assert!(b.all().unwrap().is_empty());
        assert_eq!(b.sync_collect("B", "B", &none()).unwrap(), 1); // just its own name
        assert!(b
            .sync_pending(10)
            .unwrap()
            .iter()
            .all(|c| c.entity == "d:B"));
    }

    #[test]
    fn devices_and_removal() {
        let a = Store::open_in_memory().unwrap();
        let b = Store::open_in_memory().unwrap();
        a.sync_collect("A", "Work Mac", &none()).unwrap();
        b.sync_collect("B", "Home Mac", &none()).unwrap();
        b.sync_apply("B", &a.sync_pending(10).unwrap()).unwrap();
        let names: Vec<String> = b
            .sync_devices()
            .unwrap()
            .into_iter()
            .map(|d| d.name)
            .collect();
        assert_eq!(names, vec!["Home Mac", "Work Mac"]);

        b.sync_set("B", "d:A", "removed", Value::Bool(true))
            .unwrap();
        let r = a.sync_apply("A", &b.sync_pending(10).unwrap()).unwrap();
        assert!(r.removed_here);
    }

    #[test]
    fn unchanged_tables_are_not_compared_again() {
        let a = Store::open_in_memory().unwrap();
        let b = Store::open_in_memory().unwrap();
        let t = a.insert(new("One")).unwrap();
        assert!(a.sync_collect("A", "A", &none()).unwrap() > 0);
        assert_eq!(a.sync_collect("A", "A", &none()).unwrap(), 0);
        // Taking in changes keeps it in step: no full compare, nothing echoed.
        b.insert(new("Two")).unwrap();
        b.sync_collect("B", "B", &none()).unwrap();
        a.sync_apply("A", &b.sync_pending(100).unwrap()).unwrap();
        assert_eq!(
            a.sync_get("collected").unwrap().unwrap().split('|').next(),
            a.sync_get("dirty").unwrap().as_deref()
        );
        assert_eq!(a.sync_collect("A", "A", &none()).unwrap(), 0);
        // A real edit, a new name or a new rule is noticed.
        a.update(
            t.id,
            TaskPatch {
                title: Some("One!".into()),
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(a.sync_collect("A", "A", &none()).unwrap(), 1);
        assert_eq!(a.sync_collect("A", "Renamed", &none()).unwrap(), 1);
        let rule: HashSet<String> = ["Home".to_string()].into();
        assert_eq!(a.sync_collect("A", "Renamed", &rule).unwrap(), 0);
        a.sync_reset().unwrap();
        assert!(a.sync_collect("A", "Renamed", &rule).unwrap() > 0);
    }

    #[test]
    fn bad_entities_are_ignored() {
        let b = Store::open_in_memory().unwrap();
        let junk = Change {
            entity: "x:1".into(),
            field: "title".into(),
            value: Value::from("nope"),
            hlc: "1".into(),
        };
        assert_eq!(b.sync_apply("B", &[junk]).unwrap().fields, 0);
    }

    fn weekly(store: &Store, title: &str) -> i64 {
        store
            .insert(NewTask {
                title: title.into(),
                due_date: Some("2026-11-02".into()),
                recurrence: Some("weekly".into()),
                ..Default::default()
            })
            .unwrap()
            .id
    }

    fn set_done(store: &Store, id: i64, done: bool) {
        store
            .update(
                id,
                TaskPatch {
                    done: Some(done),
                    ..Default::default()
                },
            )
            .unwrap();
    }

    fn by_title(store: &Store, title: &str) -> i64 {
        store
            .all()
            .unwrap()
            .into_iter()
            .find(|t| t.title == title && !t.done)
            .or_else(|| store.all().unwrap().into_iter().find(|t| t.title == title))
            .unwrap()
            .id
    }

    #[test]
    fn a_repeat_finished_on_both_macs_while_apart_makes_one_next_task() {
        let a = Store::open_in_memory().unwrap();
        let b = Store::open_in_memory().unwrap();
        let ta = weekly(&a, "Water plants");
        send(&a, "A", &b, "B");
        let tb = by_title(&b, "Water plants");

        // Both Macs tick it off while they can't reach each other.
        set_done(&a, ta, true);
        set_done(&b, tb, true);
        assert_eq!(a.all().unwrap().len(), 2);
        assert_eq!(b.all().unwrap().len(), 2);

        send(&a, "A", &b, "B");
        send(&b, "B", &a, "A");
        for s in [&a, &b] {
            let all = s.all().unwrap();
            assert_eq!(all.len(), 2, "one done, one next: {:?}", titles(s));
            assert_eq!(all.iter().filter(|t| !t.done).count(), 1);
        }
        // And it stays that way.
        send(&a, "A", &b, "B");
        assert_eq!(b.all().unwrap().len(), 2);
    }

    #[test]
    fn a_counted_custom_repeat_finished_on_both_macs_makes_one_next_task_and_then_ends() {
        let a = Store::open_in_memory().unwrap();
        let b = Store::open_in_memory().unwrap();
        let ta = a
            .insert(NewTask {
                title: "Book club".into(),
                due_date: Some("2026-11-10".into()),
                recurrence: Some("rrule:FREQ=MONTHLY;BYDAY=2TU;COUNT=2".into()),
                ..Default::default()
            })
            .unwrap()
            .id;
        send(&a, "A", &b, "B");
        let tb = by_title(&b, "Book club");
        // Both Macs finish it while apart: one next one, the last.
        set_done(&a, ta, true);
        set_done(&b, tb, true);
        send(&a, "A", &b, "B");
        send(&b, "B", &a, "A");
        for s in [&a, &b] {
            let open: Vec<_> = s.all().unwrap().into_iter().filter(|t| !t.done).collect();
            assert_eq!(open.len(), 1, "{:?}", titles(s));
            assert_eq!(
                open[0].recurrence.as_deref(),
                Some("rrule:FREQ=MONTHLY;BYDAY=2TU;COUNT=1")
            );
        }
        // Finishing the last one makes nothing more, on either Mac.
        let last = by_title(&b, "Book club");
        set_done(&b, last, true);
        send(&b, "B", &a, "A");
        for s in [&a, &b] {
            assert!(s.all().unwrap().iter().all(|t| t.done), "{:?}", titles(s));
        }
    }

    #[test]
    fn un_ticking_on_the_other_mac_removes_the_next_one_everywhere() {
        let a = Store::open_in_memory().unwrap();
        let b = Store::open_in_memory().unwrap();
        let ta = weekly(&a, "Water plants");
        send(&a, "A", &b, "B");
        set_done(&a, ta, true);
        send(&a, "A", &b, "B");
        assert_eq!(b.all().unwrap().len(), 2);

        // Mac B un-ticks it: the next one goes, on B and then on A.
        let tb = b.all().unwrap().into_iter().find(|t| t.done).unwrap().id;
        set_done(&b, tb, false);
        assert_eq!(b.all().unwrap().len(), 1);
        send(&b, "B", &a, "A");
        let left = a.all().unwrap();
        assert_eq!(left.len(), 1, "{:?}", titles(&a));
        assert!(!left[0].done);

        // Ticking it again (on A) makes the next one once more, on both.
        set_done(&a, ta, true);
        send(&a, "A", &b, "B");
        for s in [&a, &b] {
            assert_eq!(s.all().unwrap().len(), 2);
            assert_eq!(s.all().unwrap().iter().filter(|t| !t.done).count(), 1);
        }
    }

    #[test]
    fn a_finished_next_one_is_kept_when_the_first_is_un_ticked_and_ticked() {
        let a = Store::open_in_memory().unwrap();
        let ta = weekly(&a, "Water plants");
        set_done(&a, ta, true);
        let next = a.all().unwrap().into_iter().find(|t| !t.done).unwrap().id;
        set_done(&a, next, true); // the next one is done too (and spawns its own)
        set_done(&a, ta, false); // un-tick the first: the done next one stays
        set_done(&a, ta, true); // tick again: no error, no duplicate
        let all = a.all().unwrap();
        assert_eq!(all.len(), 3, "first, its next (done) and the one after");
        assert_eq!(all.iter().filter(|t| !t.done).count(), 1);
    }

    #[test]
    fn the_next_one_gets_the_same_uid_on_every_mac() {
        let a = Store::open_in_memory().unwrap();
        let b = Store::open_in_memory().unwrap();
        let ta = weekly(&a, "Water plants");
        send(&a, "A", &b, "B");
        set_done(&a, ta, true);
        set_done(&b, by_title(&b, "Water plants"), true);
        let uid = |s: &Store| -> String {
            let next = s.all().unwrap().into_iter().find(|t| !t.done).unwrap().id;
            s.conn
                .query_row("SELECT uid FROM tasks WHERE id = ?1", [next], |r| r.get(0))
                .unwrap()
        };
        assert_eq!(uid(&a), uid(&b));
        assert_eq!(uid(&a).len(), 32);
    }

    #[test]
    fn a_tasks_length_travels_to_the_other_mac() {
        let a = Store::open_in_memory().unwrap();
        let b = Store::open_in_memory().unwrap();
        let t = a
            .insert(NewTask {
                title: "Deep work".into(),
                due_date: Some("2026-11-02".into()),
                due_time: Some("13:05".into()),
                duration: Some(95),
                ..Default::default()
            })
            .unwrap();
        send(&a, "A", &b, "B");
        let on_b = b.all().unwrap()[0].clone();
        assert_eq!(
            (on_b.due_time.as_deref(), on_b.duration),
            (Some("13:05"), Some(95))
        );
        b.update(
            on_b.id,
            TaskPatch {
                duration: Some(None),
                ..Default::default()
            },
        )
        .unwrap();
        send(&b, "B", &a, "A");
        assert_eq!(a.get(t.id).unwrap().duration, None);
    }
}
