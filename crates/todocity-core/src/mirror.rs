//! Keeping TodoCity in step with Things 3 or Todoist: the pass that brings
//! the other app's changes in. With two-way sync on (the default), changes
//! made here go back out afterwards: see [`crate::mirror_out`].
//!
//! Tasks stay editable here. Each one remembers how the other app last had
//! it (its *base*, kept in `imports.base`). A pass only changes a field here
//! when that field changed in the other app since the last pass, so an edit
//! made in TodoCity sticks until the same field changes over there.
//!
//! * New in the other app → added here. A finished one only comes if it was
//!   finished after syncing began (the rest of the history came with the
//!   first import, if the person wanted it).
//! * Gone from the other app → removed here, unless it's done on either
//!   side (then it simply stays). A task deleted here never comes back.
//! * Each of the other app's projects (or areas) maps to one project here,
//!   by its id, so renaming it here keeps it in step. A stopped project —
//!   "Stop syncing", or taking it down — is left alone from then on.
//! * Two-way only: a new task there that is already here (it carries this
//!   task's `todocity://task/<uid>` link, because another Mac sent it, or a
//!   synced project here has an open task with the same title and day) is
//!   linked rather than added twice.
//! * A repeating task finished here moves on there too; when the other app
//!   shows the next date, the link follows to the next occurrence here, so
//!   the finished one stays finished and nothing repeats twice.

use std::collections::{HashMap, HashSet};

use chrono::NaiveDate;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::store::{ChecklistItem, Imported, Store, StoreError, TaskPatch};
use crate::things::LOOSE_KEY;

/// How the other app had a task at the last pass: the fields that flow in.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Base {
    pub title: String,
    pub notes: Option<String>,
    pub due_date: Option<String>,
    pub due_time: Option<String>,
    pub evening: bool,
    pub someday: bool,
    pub deadline: Option<String>,
    pub recurrence: Option<String>,
    pub checklist: Vec<ChecklistItem>,
    pub priority: u8,
    pub done: bool,
    /// The other app's project key (or [`LOOSE_KEY`]) and the floor in it.
    pub building: String,
    pub floor: Option<String>,
}

impl Base {
    pub fn of(item: &Imported) -> Self {
        let t = &item.task;
        Self {
            title: t.title.clone(),
            notes: t.notes.clone(),
            due_date: t.due_date.clone(),
            due_time: t.due_time.clone(),
            evening: t.evening,
            someday: t.someday,
            deadline: t.deadline.clone(),
            recurrence: t.recurrence.clone(),
            checklist: t.checklist.clone(),
            priority: t.priority,
            done: item.done,
            building: item.building.clone(),
            floor: t.heading.clone(),
        }
    }
}

/// Everything read from the other app on this pass.
pub struct Source<'a> {
    /// Where tasks are recorded as coming from (`things3`, `todoist`).
    pub source: &'a str,
    /// The other app's projects and areas: `(key, name)`, in its order.
    pub buildings: Vec<(String, String)>,
    /// Floors by building name, as the plan lists them.
    pub floors: &'a [(String, Option<String>)],
    /// Every task, open and (recently) finished.
    pub items: &'a [Imported],
    /// This is everything the other app has, so a missing task was removed
    /// there. False when only part could be read: nothing is removed then.
    pub complete: bool,
}

pub struct PassOptions<'a> {
    pub today: NaiveDate,
    /// RFC 3339; when syncing began. Finished tasks new to TodoCity only
    /// come if they were finished after this.
    pub since: &'a str,
    /// Changes here go back to the other app too.
    pub two_way: bool,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct PassReport {
    pub added: usize,
    pub updated: usize,
    pub removed: usize,
    /// Per-task problems; the rest of the pass still ran.
    pub errors: Vec<String>,
}

/// A project here kept in step with one of the other app's.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MirrorProject {
    pub source: String,
    pub key: String,
    pub project: String,
    pub source_name: String,
    pub stopped: bool,
}

/// The line that links a task in the other app to the same task here.
pub const LINK_PREFIX: &str = "todocity://task/";

/// The link written into the other app's notes for task `uid`.
pub fn link_line(uid: &str) -> String {
    format!("{LINK_PREFIX}{uid}")
}

/// Take a `todocity://task/<uid>` line out of `notes`; returns the uid.
pub fn take_link(notes: &mut Option<String>) -> Option<String> {
    let text = notes.as_deref()?;
    let mut uid = None;
    let kept: Vec<&str> = text
        .lines()
        .filter(|line| {
            let l = line.trim();
            match l.strip_prefix(LINK_PREFIX) {
                Some(rest) if rest.len() == 32 && rest.bytes().all(|b| b.is_ascii_hexdigit()) => {
                    uid.get_or_insert_with(|| rest.to_ascii_lowercase());
                    false
                }
                _ => true,
            }
        })
        .collect();
    uid.as_ref()?;
    let rest = kept.join("\n").trim().to_string();
    *notes = (!rest.is_empty()).then_some(rest);
    uid
}

/// Titles compared loosely: case and spacing don't matter.
pub(crate) fn same_title(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    };
    norm(a) == norm(b)
}

/// A change to a task here: its id, the patch, and done (with when).
type Update = (i64, TaskPatch, Option<(bool, Option<String>)>);

/// Removing more than this many tasks in one pass, and more than half of
/// those kept in step, looks like a bad read rather than a clear-out.
const MAX_SAFE_REMOVALS: usize = 20;

/// An open task's day: one that has passed shows up today, as it does in
/// the other app's Today list.
pub(crate) fn shown_day(due: &Option<String>, done: bool, today: NaiveDate) -> Option<String> {
    let d = due.as_deref()?;
    if done {
        return Some(d.to_string());
    }
    match NaiveDate::parse_from_str(d, "%Y-%m-%d") {
        Ok(day) if day < today => Some(today.format("%Y-%m-%d").to_string()),
        _ => Some(d.to_string()),
    }
}

/// The fields that changed in the other app, as a patch for the task here.
/// `project` is where the task's building lives here (`None`: the Inbox).
fn patch_for(old: &Base, new: &Base, project: Option<String>, today: NaiveDate) -> TaskPatch {
    let mut p = TaskPatch::default();
    if new.title != old.title {
        p.title = Some(new.title.clone());
    }
    if new.notes != old.notes {
        p.notes = Some(new.notes.clone());
    }
    if new.someday != old.someday {
        p.someday = Some(new.someday);
    }
    if new.due_date != old.due_date {
        p.due_date = Some(shown_day(&new.due_date, new.done, today));
    }
    if new.due_time != old.due_time {
        p.due_time = Some(new.due_time.clone());
    }
    if new.evening != old.evening {
        p.evening = Some(new.evening);
    }
    if new.deadline != old.deadline {
        p.deadline = Some(new.deadline.clone());
    }
    if new.recurrence != old.recurrence {
        p.recurrence = Some(new.recurrence.clone());
    }
    if new.checklist != old.checklist {
        p.checklist = Some(new.checklist.clone());
    }
    if new.priority != old.priority {
        p.priority = Some(new.priority);
    }
    if new.building != old.building || new.floor != old.floor {
        p.heading = Some(project.as_ref().and(new.floor.clone()));
        p.project = Some(project);
    }
    p
}

fn is_empty(p: &TaskPatch) -> bool {
    p.title.is_none()
        && p.notes.is_none()
        && p.someday.is_none()
        && p.due_date.is_none()
        && p.due_time.is_none()
        && p.evening.is_none()
        && p.deadline.is_none()
        && p.recurrence.is_none()
        && p.checklist.is_none()
        && p.priority.is_none()
        && p.project.is_none()
        && p.heading.is_none()
}

impl Store {
    /// The other app's projects and the projects here they map to.
    pub fn mirror_projects(&self, source: Option<&str>) -> Result<Vec<MirrorProject>, StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT source, key, project, source_name, stopped FROM mirror_projects
             WHERE ?1 IS NULL OR source = ?1 ORDER BY source, project",
        )?;
        let rows = stmt.query_map([source], |r| {
            Ok(MirrorProject {
                source: r.get(0)?,
                key: r.get(1)?,
                project: r.get(2)?,
                source_name: r.get(3)?,
                stopped: r.get(4)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Stop keeping project `name` in step: it and its tasks become ordinary
    /// TodoCity ones. Returns false when it wasn't being kept in step.
    pub fn stop_mirroring_project(&self, name: &str) -> Result<bool, StoreError> {
        Ok(self.conn.execute(
            "UPDATE mirror_projects SET stopped = 1 WHERE project = ?1 AND stopped = 0",
            [name],
        )? > 0)
    }

    /// Leave these of the other app's projects alone from now on (the ones
    /// left out when syncing was set up).
    pub fn stop_mirroring_keys(
        &self,
        source: &str,
        keys: &[(String, String)],
    ) -> Result<(), StoreError> {
        for (key, name) in keys {
            self.conn.execute(
                "INSERT INTO mirror_projects (source, key, project, source_name, stopped)
                 VALUES (?1, ?2, ?3, ?3, 1)
                 ON CONFLICT (source, key) DO UPDATE SET stopped = 1",
                params![source, key, name],
            )?;
        }
        Ok(())
    }

    /// Forget everything about keeping `source` in step (it was turned
    /// off). Tasks stay; imported ones are still never imported twice.
    pub fn forget_mirror(&self, source: &str) -> Result<(), StoreError> {
        self.conn
            .execute("DELETE FROM mirror_projects WHERE source = ?1", [source])?;
        self.conn
            .execute("UPDATE imports SET base = NULL WHERE source = ?1", [source])?;
        Ok(())
    }

    pub(crate) fn is_done(&self, id: i64) -> Result<bool, StoreError> {
        Ok(self
            .conn
            .query_row("SELECT done FROM tasks WHERE id = ?1", [id], |r| r.get(0))
            .optional()?
            .unwrap_or(false))
    }

    /// The occurrence a finished repeating task made: by `next_id` on the
    /// Mac that finished it, by its series uid on every other Mac.
    pub(crate) fn next_occurrence(&self, id: i64) -> Result<Option<i64>, StoreError> {
        // next_id, uid, series day, due day.
        type Row = (Option<i64>, Option<String>, Option<String>, Option<String>);
        let row: Option<Row> = self
            .conn
            .query_row(
                "SELECT next_id, uid, series_date, due_date FROM tasks WHERE id = ?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?;
        let Some((next, uid, series, due)) = row else {
            return Ok(None);
        };
        let exists = |n: i64| -> Result<bool, StoreError> {
            Ok(self
                .conn
                .query_row("SELECT 1 FROM tasks WHERE id = ?1", [n], |_| Ok(()))
                .optional()?
                .is_some())
        };
        if let Some(n) = next {
            if exists(n)? {
                return Ok(Some(n));
            }
        }
        let Some(uid) = uid else { return Ok(None) };
        let day = series
            .or(due)
            .and_then(|d| NaiveDate::parse_from_str(&d, "%Y-%m-%d").ok());
        let next_uid = crate::store::series_uid(&uid, day);
        Ok(self
            .conn
            .query_row("SELECT id FROM tasks WHERE uid = ?1", [next_uid], |r| {
                r.get(0)
            })
            .optional()?)
    }

    /// A task here that is the same as one new in the other app: the one
    /// its link line names, or an open, not yet linked task in the same
    /// project (or the Inbox) with the same title and day. The flag says whether
    /// it's linked already.
    fn already_here(
        &self,
        marked: Option<&str>,
        project: &Option<String>,
        title: &str,
        day: &Option<String>,
    ) -> Result<Option<(i64, bool)>, StoreError> {
        const LINKED: &str = "EXISTS (SELECT 1 FROM imports i WHERE i.task_id = t.id)";
        if let Some(uid) = marked {
            let hit: Option<(i64, bool)> = self
                .conn
                .query_row(
                    &format!("SELECT t.id, {LINKED} FROM tasks t WHERE t.uid = ?1"),
                    [uid],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?;
            if hit.is_some() {
                return Ok(hit);
            }
        }
        let mut stmt = self.conn.prepare(&format!(
            "SELECT t.id, t.title, t.due_date FROM tasks t
             WHERE t.done = 0 AND t.project IS ?1 COLLATE NOCASE AND NOT {LINKED}"
        ))?;
        let rows = stmt.query_map([project], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
            ))
        })?;
        let title_there = title;
        for row in rows {
            let (id, title, due) = row?;
            if same_title(&title, title_there) && &due == day {
                return Ok(Some((id, false)));
            }
        }
        Ok(None)
    }

    /// One pass: bring the other app's changes in. See the module docs.
    pub fn mirror(
        &self,
        src: &Source<'_>,
        opts: &PassOptions<'_>,
    ) -> Result<PassReport, StoreError> {
        let mut report = PassReport::default();
        let source = src.source;
        let tx = self.conn.unchecked_transaction()?;

        // ── Projects ───────────────────────────────────────────────────────
        let mut map: HashMap<String, MirrorProject> = self
            .mirror_projects(Some(source))?
            .into_iter()
            .map(|m| (m.key.clone(), m))
            .collect();
        let project_exists = |name: &str| -> Result<bool, StoreError> {
            Ok(self
                .conn
                .query_row(
                    "SELECT 1 FROM projects WHERE name = ?1 COLLATE NOCASE",
                    [name],
                    |_| Ok(()),
                )
                .optional()?
                .is_some())
        };
        let mut by_name: HashMap<String, String> = HashMap::new();
        for (key, name) in &src.buildings {
            if key == LOOSE_KEY {
                continue;
            }
            by_name.insert(name.clone(), key.clone());
            match map.get_mut(key) {
                Some(m) if m.stopped => {}
                Some(m) => {
                    if m.source_name != *name {
                        // Renamed there: rename here too, unless it was
                        // renamed here (that name wins) or the new name is
                        // taken by another project.
                        if m.project == m.source_name && !project_exists(name)? {
                            self.rename_project(&m.project, name)?;
                            m.project = name.clone();
                        }
                        m.source_name = name.clone();
                        self.conn.execute(
                            "UPDATE mirror_projects SET project = ?3, source_name = ?4
                             WHERE source = ?1 AND key = ?2",
                            params![source, key, m.project, m.source_name],
                        )?;
                    }
                    self.create_project(&m.project)?;
                }
                None => {
                    // A name another of this app's projects already uses
                    // here gets a number, so the two stay apart.
                    let taken: HashSet<String> =
                        map.values().map(|m| m.project.to_lowercase()).collect();
                    let mut local = name.clone();
                    let mut i = 2;
                    while taken.contains(&local.to_lowercase()) {
                        local = format!("{name} ({i})");
                        i += 1;
                    }
                    let local = self.create_project(&local)?.unwrap_or(local);
                    self.conn.execute(
                        "INSERT INTO mirror_projects (source, key, project, source_name, stopped)
                         VALUES (?1, ?2, ?3, ?4, 0)",
                        params![source, key, local, name],
                    )?;
                    map.insert(
                        key.clone(),
                        MirrorProject {
                            source: source.into(),
                            key: key.clone(),
                            project: local,
                            source_name: name.clone(),
                            stopped: false,
                        },
                    );
                }
            }
        }
        // Where a building lives here: `None` when stopped (leave it alone),
        // `Some(None)` for the Inbox.
        let local_of = |key: &str| -> Option<Option<String>> {
            if key == LOOSE_KEY {
                return Some(None);
            }
            match map.get(key) {
                Some(m) if m.stopped => None,
                Some(m) => Some(Some(m.project.clone())),
                None => Some(None),
            }
        };
        for (bname, floor) in src.floors {
            let (Some(floor), Some(key)) = (floor, by_name.get(bname)) else {
                continue;
            };
            if let Some(Some(project)) = local_of(key) {
                self.add_floor(&project, floor)?;
            }
        }

        // ── Tasks ──────────────────────────────────────────────────────────
        let mut links: HashMap<String, (Option<i64>, Option<String>)> = HashMap::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT i.ext_id, t.id, i.base FROM imports i
                 LEFT JOIN tasks t ON t.id = i.task_id WHERE i.source = ?1",
            )?;
            let rows = stmt.query_map([source], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, Option<String>>(2)?,
                ))
            })?;
            for row in rows {
                let (ext, task, base) = row?;
                links.insert(ext, (task, base));
            }
        }
        let set_base = |ext: &str, task: Option<i64>, base: &Base| -> Result<(), StoreError> {
            let json = serde_json::to_string(base).unwrap_or_default();
            self.conn.execute(
                "INSERT INTO imports (source, ext_id, task_id, imported_at, base)
                 VALUES (?1, ?2, ?3, ?4, ?5)
                 ON CONFLICT (source, ext_id) DO UPDATE SET base = excluded.base",
                params![source, ext, task, chrono::Utc::now().to_rfc3339(), json],
            )?;
            Ok(())
        };

        // Changes to tasks already here, applied once the rest is saved.
        let mut updates: Vec<Update> = Vec::new();
        let mut seen: HashSet<&str> = HashSet::new();
        for item in src.items {
            seen.insert(item.ext_id.as_str());
            let Some(project) = local_of(&item.building) else {
                continue;
            };
            // The link line is TodoCity's own; it never shows in notes here.
            let mut owned = item.clone();
            let marked = take_link(&mut owned.task.notes);
            let item = &owned;
            let new = Base::of(item);
            match links.get(&item.ext_id) {
                Some((Some(id), base)) => {
                    let old = base
                        .as_deref()
                        .and_then(|b| serde_json::from_str::<Base>(b).ok());
                    match old {
                        // Brought in before syncing began: from here on.
                        None => set_base(&item.ext_id, Some(*id), &new)?,
                        Some(old) if old == new => {}
                        Some(old) => {
                            // A repeat finished here and moved on there: the
                            // link follows to the next occurrence here.
                            let mut id = *id;
                            if new.recurrence.is_some()
                                && !new.done
                                && !old.done
                                && new.due_date != old.due_date
                                && self.is_done(id)?
                            {
                                if let Some(next) = self.next_occurrence(id)? {
                                    id = next;
                                    self.conn.execute(
                                        "UPDATE imports SET task_id = ?3 WHERE source = ?1 AND ext_id = ?2",
                                        params![source, item.ext_id, id],
                                    )?;
                                }
                            }
                            let patch = patch_for(&old, &new, project, opts.today);
                            let done = (new.done != old.done)
                                .then(|| (new.done, item.completed_at.clone()));
                            if !is_empty(&patch) || done.is_some() {
                                updates.push((id, patch, done));
                            }
                            set_base(&item.ext_id, Some(id), &new)?;
                        }
                    }
                }
                // Deleted here: it stays deleted.
                Some((None, _)) => {}
                None => {
                    if item.done
                        && item
                            .completed_at
                            .as_deref()
                            .map_or(true, |at| at < opts.since)
                    {
                        continue;
                    }
                    // Two-way: the same task may already be here.
                    if opts.two_way && !item.done {
                        let day = shown_day(&item.task.due_date, false, opts.today);
                        match self.already_here(
                            marked.as_deref(),
                            &project,
                            &item.task.title,
                            &day,
                        )? {
                            Some((_, true)) => {
                                // Its twin there is linked already: keep this
                                // one out rather than show it twice.
                                self.conn.execute(
                                    "INSERT OR IGNORE INTO imports (source, ext_id, task_id, imported_at)
                                     VALUES (?1, ?2, NULL, ?3)",
                                    params![source, item.ext_id, chrono::Utc::now().to_rfc3339()],
                                )?;
                                continue;
                            }
                            Some((id, false)) => {
                                // Linked; where the two differ, the other
                                // app's version wins, as in a tie.
                                let here = crate::mirror_out::base_here(
                                    &self.get(id)?,
                                    item.building.clone(),
                                );
                                let patch = patch_for(&here, &new, project.clone(), opts.today);
                                if !is_empty(&patch) {
                                    updates.push((id, patch, None));
                                }
                                set_base(&item.ext_id, Some(id), &new)?;
                                continue;
                            }
                            None => {}
                        }
                    }
                    let mut task = item.task.clone();
                    task.due_date = shown_day(&task.due_date, item.done, opts.today);
                    task.project = project.clone();
                    task.heading = project.as_ref().and(task.heading);
                    let id = match self.insert(task) {
                        Ok(t) => t.id,
                        Err(StoreError::Sqlite(e)) => return Err(e.into()),
                        Err(e) => {
                            report.errors.push(format!("{}: {e}", item.task.title));
                            continue;
                        }
                    };
                    if let Some(created) = &item.created_at {
                        self.conn.execute(
                            "UPDATE tasks SET created_at = ?1 WHERE id = ?2",
                            params![created, id],
                        )?;
                    }
                    if item.done {
                        self.conn.execute(
                            "UPDATE tasks SET done = 1, completed_at = ?1 WHERE id = ?2",
                            params![item.completed_at, id],
                        )?;
                    }
                    set_base(&item.ext_id, Some(id), &new)?;
                    report.added += 1;
                }
            }
        }

        // ── Removed there ──────────────────────────────────────────────────
        if src.complete {
            let mut gone: Vec<(String, Option<i64>)> = Vec::new();
            let mut kept = 0;
            for (ext, (task, base)) in &links {
                let Some(base) = base
                    .as_deref()
                    .and_then(|b| serde_json::from_str::<Base>(b).ok())
                else {
                    continue;
                };
                if local_of(&base.building).is_none() {
                    continue;
                }
                kept += 1;
                if seen.contains(ext.as_str()) || base.done {
                    continue;
                }
                gone.push((ext.clone(), *task));
            }
            if gone.len() > MAX_SAFE_REMOVALS && gone.len() * 2 > kept {
                report.errors.push(format!(
                    "{} tasks seem to be gone from the other app, so none were removed here, to be safe",
                    gone.len()
                ));
            } else {
                for (ext, task) in gone {
                    if let Some(id) = task {
                        let done: bool = self.conn.query_row(
                            "SELECT done FROM tasks WHERE id = ?1",
                            [id],
                            |r| r.get(0),
                        )?;
                        // Done here: it stays, and simply stops syncing.
                        if !done {
                            self.conn.execute("DELETE FROM tasks WHERE id = ?1", [id])?;
                            report.removed += 1;
                        }
                    }
                    self.conn.execute(
                        "DELETE FROM imports WHERE source = ?1 AND ext_id = ?2",
                        params![source, ext],
                    )?;
                }
            }
        }
        tx.commit()?;

        for (id, patch, done) in updates {
            if !is_empty(&patch) {
                match self.update(id, patch) {
                    Ok(_) => {}
                    Err(StoreError::Sqlite(e)) => return Err(e.into()),
                    Err(e) => {
                        report.errors.push(format!("task {id}: {e}"));
                        continue;
                    }
                }
            }
            // Straight in, so a repeating task doesn't make its next one
            // here: the other app makes (and sends) that itself.
            if let Some((done, at)) = done {
                self.conn.execute(
                    "UPDATE tasks SET done = ?1,
                         completed_at = CASE WHEN ?1 THEN COALESCE(?2, completed_at, ?3) ELSE NULL END,
                         snoozed_until = NULL WHERE id = ?4",
                    params![done, at, chrono::Utc::now().to_rfc3339(), id],
                )?;
            }
            report.updated += 1;
        }
        Ok(report)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::NewTask;

    fn day(d: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(2026, 11, d).unwrap()
    }

    fn item(id: &str, building: &str, title: &str) -> Imported {
        Imported {
            ext_id: id.into(),
            building: building.into(),
            task: NewTask {
                title: title.into(),
                source_app: Some("Things 3".into()),
                ..Default::default()
            },
            done: false,
            completed_at: None,
            created_at: None,
        }
    }

    struct World {
        buildings: Vec<(String, String)>,
        floors: Vec<(String, Option<String>)>,
        items: Vec<Imported>,
    }

    impl World {
        fn new() -> Self {
            Self {
                buildings: vec![("p1".into(), "Garden".into())],
                floors: vec![("Garden".into(), None)],
                items: vec![
                    item("a", "p1", "Plant tulips"),
                    item("b", LOOSE_KEY, "Call Sam"),
                ],
            }
        }
        fn pass(&self, store: &Store) -> PassReport {
            store
                .mirror(
                    &Source {
                        source: "things3",
                        buildings: self.buildings.clone(),
                        floors: &self.floors,
                        items: &self.items,
                        complete: true,
                    },
                    &PassOptions {
                        today: day(10),
                        since: "2026-11-01T00:00:00Z",
                        two_way: false,
                    },
                )
                .unwrap()
        }
    }

    fn find(store: &Store, title: &str) -> crate::store::Task {
        store
            .all()
            .unwrap()
            .into_iter()
            .find(|t| t.title == title)
            .unwrap_or_else(|| panic!("no task {title}"))
    }

    #[test]
    fn new_tasks_and_projects_come_in() {
        let store = Store::open_in_memory().unwrap();
        let w = World::new();
        let r = w.pass(&store);
        assert_eq!(r.added, 2);
        assert_eq!(
            find(&store, "Plant tulips").project.as_deref(),
            Some("Garden")
        );
        assert_eq!(find(&store, "Call Sam").project, None);
        // Again: nothing new.
        assert_eq!(w.pass(&store), PassReport::default());
    }

    #[test]
    fn edits_here_stick_until_that_field_changes_there() {
        let store = Store::open_in_memory().unwrap();
        let mut w = World::new();
        w.pass(&store);
        let id = find(&store, "Plant tulips").id;
        store
            .update(
                id,
                TaskPatch {
                    title: Some("Plant 40 tulips".into()),
                    priority: Some(1),
                    ..Default::default()
                },
            )
            .unwrap();
        // Something else changes there: the edit here stays.
        w.items[0].task.deadline = Some("2026-11-20".into());
        assert_eq!(w.pass(&store).updated, 1);
        let t = store.get(id).unwrap();
        assert_eq!(t.title, "Plant 40 tulips");
        assert_eq!(t.priority, 1);
        assert_eq!(t.deadline.as_deref(), Some("2026-11-20"));
        // The title changes there: that wins.
        w.items[0].task.title = "Plant tulips and daffodils".into();
        w.pass(&store);
        assert_eq!(store.get(id).unwrap().title, "Plant tulips and daffodils");
        assert_eq!(store.get(id).unwrap().priority, 1);
    }

    #[test]
    fn done_there_is_done_here_without_a_second_repeat() {
        let store = Store::open_in_memory().unwrap();
        let mut w = World::new();
        w.items[0].task.due_date = Some("2026-11-10".into());
        w.items[0].task.recurrence = Some("weekly".into());
        w.pass(&store);
        let id = find(&store, "Plant tulips").id;
        w.items[0].done = true;
        w.items[0].completed_at = Some("2026-11-10T09:00:00Z".into());
        w.pass(&store);
        let t = store.get(id).unwrap();
        assert!(t.done);
        assert_eq!(t.next_id, None);
        assert_eq!(store.all().unwrap().len(), 2);
    }

    #[test]
    fn removed_there_is_removed_here_unless_done() {
        let store = Store::open_in_memory().unwrap();
        let mut w = World::new();
        w.pass(&store);
        let keep = find(&store, "Call Sam").id;
        store
            .update(
                keep,
                TaskPatch {
                    done: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        w.items.clear();
        let r = w.pass(&store);
        assert_eq!(r.removed, 1);
        assert!(store.get(keep).unwrap().done);
        assert_eq!(store.all().unwrap().len(), 1);
    }

    #[test]
    fn deleted_here_never_comes_back() {
        let store = Store::open_in_memory().unwrap();
        let w = World::new();
        w.pass(&store);
        store.delete(find(&store, "Call Sam").id).unwrap();
        assert_eq!(w.pass(&store).added, 0);
        assert_eq!(store.all().unwrap().len(), 1);
    }

    #[test]
    fn a_stopped_project_is_left_alone() {
        let store = Store::open_in_memory().unwrap();
        let mut w = World::new();
        w.pass(&store);
        assert!(store.stop_mirroring_project("Garden").unwrap());
        let id = find(&store, "Plant tulips").id;
        w.items[0].task.title = "Changed there".into();
        w.items.push(item("c", "p1", "Water the roses"));
        w.pass(&store);
        assert_eq!(store.get(id).unwrap().title, "Plant tulips");
        assert!(store
            .all()
            .unwrap()
            .iter()
            .all(|t| t.title != "Water the roses"));
        // Gone there: still here.
        w.items.retain(|i| i.building != "p1");
        w.pass(&store);
        assert!(store.get(id).is_ok());
    }

    #[test]
    fn renames_follow_unless_renamed_here() {
        let store = Store::open_in_memory().unwrap();
        let mut w = World::new();
        w.pass(&store);
        w.buildings[0].1 = "Backyard".into();
        w.floors[0].0 = "Backyard".into();
        w.pass(&store);
        assert_eq!(
            find(&store, "Plant tulips").project.as_deref(),
            Some("Backyard")
        );
        store.rename_project("Backyard", "Yard").unwrap();
        w.buildings[0].1 = "Outside".into();
        w.floors[0].0 = "Outside".into();
        w.items.push(item("c", "p1", "Rake leaves"));
        w.pass(&store);
        assert_eq!(find(&store, "Rake leaves").project.as_deref(), Some("Yard"));
        assert_eq!(
            find(&store, "Plant tulips").project.as_deref(),
            Some("Yard")
        );
    }

    #[test]
    fn a_bad_read_removes_nothing() {
        let store = Store::open_in_memory().unwrap();
        let mut w = World::new();
        for i in 0..30 {
            w.items
                .push(item(&format!("x{i}"), LOOSE_KEY, &format!("Task {i}")));
        }
        w.pass(&store);
        w.items.clear();
        let r = w.pass(&store);
        assert_eq!(r.removed, 0);
        assert_eq!(r.errors.len(), 1);
        assert_eq!(store.all().unwrap().len(), 32);
    }

    #[test]
    fn old_finished_tasks_stay_behind_and_past_days_show_today() {
        let store = Store::open_in_memory().unwrap();
        let mut w = World::new();
        let mut old = item("old", LOOSE_KEY, "Old one");
        old.done = true;
        old.completed_at = Some("2025-01-01T00:00:00Z".into());
        w.items.push(old);
        w.items[0].task.due_date = Some("2026-11-02".into());
        w.pass(&store);
        assert!(store.all().unwrap().iter().all(|t| t.title != "Old one"));
        assert_eq!(
            find(&store, "Plant tulips").due_date.as_deref(),
            Some("2026-11-10")
        );
    }

    #[test]
    fn tasks_imported_before_are_adopted_not_doubled() {
        let store = Store::open_in_memory().unwrap();
        let w = World::new();
        store.import("things3", &w.floors, &w.items[..1]).unwrap();
        let id = find(&store, "Plant tulips").id;
        store
            .update(
                id,
                TaskPatch {
                    title: Some("Edited".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        let r = w.pass(&store);
        assert_eq!(r.added, 1);
        assert_eq!(store.get(id).unwrap().title, "Edited");
        assert_eq!(store.all().unwrap().len(), 2);
    }
}
