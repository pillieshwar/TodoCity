//! Two-way sync: sending what changed here back to the app it syncs with.
//!
//! It runs right after [`Store::mirror`] has brought the other app's changes
//! in, so each linked task's *base* (`imports.base`) is how the other app has
//! it now. Every field where the task here differs from its base was changed
//! here; when both sides changed the same field, the pull already took the
//! other app's value. That is a three-way merge, field by field, and the
//! other app wins a tie, as with Apple Reminders.
//!
//! [`Store::mirror_outbox`] only plans: it returns [`Op`]s for the connector
//! (Todoist's API, Things' URL scheme, a TODO.md file) to carry out, and
//! [`Store::mirror_sent`] records each result. Planning twice before sending
//! is harmless, and a failed send is simply planned again next pass.
//!
//! * Changed here → updated there (only the fields that changed here).
//! * New here, open, in a synced project → added there, with a
//!   `todocity://task/<uid>` line in its notes, so another Mac that also
//!   syncs with that app links to it instead of adding it again.
//! * Deleted here → deleted there. A safety brake stops a mass removal (more
//!   than 20 tasks that are also more than half of those linked): nothing is
//!   deleted and the pass says why.
//! * Moved here into a project that isn't synced → it stops syncing; the
//!   other app keeps its copy, and it never comes back here.
//! * A repeating task finished here → finished there (the other app moves
//!   it to its next date), and the link moves to the occurrence TodoCity
//!   made, so the series continues on both sides without doubling.
//! * Projects kept on this Mac only send nothing.
//! * Changes that just arrived from another of the person's Macs wait a few
//!   minutes before anything that can't safely happen twice (adding a task,
//!   finishing a repeat): the Mac where they were made sends them first.
//!   Field edits and deletes go straight away; repeating them is harmless.

use std::collections::{HashMap, HashSet};

use chrono::NaiveDate;
use rusqlite::{params, OptionalExtension};
use serde::Serialize;

use crate::mirror::{shown_day, Base};
use crate::store::{Store, StoreError, Task};
use crate::things::LOOSE_KEY;

/// What a connector can carry back, beyond the fields every one has (title,
/// notes, day and time, deadline, repeat, priority, done, project, section).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Extras {
    pub someday: bool,
    pub evening: bool,
    pub checklist: bool,
}

pub struct OutOptions<'a> {
    pub today: NaiveDate,
    pub extras: Extras,
    /// This Mac's id in Mac-to-Mac sync, when that's on.
    pub device: Option<&'a str>,
    /// Now, in milliseconds since 1970.
    pub now_ms: i64,
    /// Projects kept on this Mac only: nothing in them is sent.
    pub local_only: &'a HashSet<String>,
}

/// How long a change from another Mac waits before this Mac adds or
/// finishes it there itself.
pub const WAIT_FOR_OTHER_MAC_MS: i64 = 10 * 60 * 1000;

/// Removing more than this many tasks there in one pass, when that's also
/// more than half of those linked, is held back.
pub const MAX_SAFE_DELETES: usize = 20;

/// One change to make in the other app.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Op {
    /// Add task `task_id` there, as `want`.
    Create {
        task_id: i64,
        uid: String,
        want: Base,
    },
    /// Change the linked task: `old` is how it is there, `want` how it
    /// should be. `next` is the occurrence to follow once a repeat is done.
    Update {
        task_id: i64,
        ext_id: String,
        uid: Option<String>,
        old: Base,
        want: Base,
        next: Option<i64>,
    },
    /// Delete it there; it was deleted here.
    Delete { ext_id: String, old: Base },
}

impl Op {
    pub fn ext_id(&self) -> Option<&str> {
        match self {
            Op::Create { .. } => None,
            Op::Update { ext_id, .. } | Op::Delete { ext_id, .. } => Some(ext_id),
        }
    }
    /// A short description for the log and errors.
    pub fn title(&self) -> &str {
        match self {
            Op::Create { want, .. } | Op::Update { want, .. } => &want.title,
            Op::Delete { old, .. } => &old.title,
        }
    }
}

/// How sending one [`Op`] went.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Sent {
    /// Done; for a [`Op::Create`], the new task's id there.
    Ok(Option<String>),
    /// The task isn't there any more (the next pull sorts it out).
    Gone,
    Failed(String),
}

#[derive(Debug, Default, Clone, PartialEq, Serialize)]
pub struct Outbox {
    pub ops: Vec<Op>,
    /// Changes waiting for another Mac to send them first.
    pub waiting: usize,
    pub errors: Vec<String>,
}

/// How the task here looks as a [`Base`], with `building` already resolved.
pub(crate) fn base_here(t: &Task, building: String) -> Base {
    Base {
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
        done: t.done,
        building,
        floor: t.heading.clone(),
    }
}

/// How the task should be there: its base, with every field changed here.
/// The day needs care: an open task whose day has passed shows up today
/// here (as in the other app's Today), which is not a change.
pub(crate) fn wanted(old: &Base, here: &Base, extras: Extras, today: NaiveDate) -> Base {
    let mut w = old.clone();
    if here.title != old.title {
        w.title = here.title.clone();
    }
    if here.notes != old.notes {
        w.notes = here.notes.clone();
    }
    let today_s = today.format("%Y-%m-%d").to_string();
    // Finished here on a later day than it was shown: still not a change.
    let shown_then = match (&old.due_date, &here.due_date) {
        (Some(a), Some(b)) => here.done && !old.done && a < b && *b <= today_s,
        _ => false,
    };
    let day_moved = here.due_date != old.due_date
        && here.due_date != shown_day(&old.due_date, old.done, today)
        && !shown_then;
    if day_moved {
        w.due_date = here.due_date.clone();
    }
    if here.due_time != old.due_time {
        w.due_time = here.due_time.clone();
    }
    if here.deadline != old.deadline {
        w.deadline = here.deadline.clone();
    }
    if here.recurrence != old.recurrence {
        w.recurrence = here.recurrence.clone();
    }
    if here.priority != old.priority {
        w.priority = here.priority;
    }
    if here.done != old.done {
        w.done = here.done;
    }
    if here.building != old.building || here.floor != old.floor {
        w.building = here.building.clone();
        w.floor = here.floor.clone();
    }
    if extras.someday && here.someday != old.someday {
        w.someday = here.someday;
    }
    if extras.evening && here.evening != old.evening {
        w.evening = here.evening;
    }
    if extras.checklist && here.checklist != old.checklist {
        w.checklist = here.checklist.clone();
    }
    w
}

/// `<millis>-<counter>-<device>` → (millis, device).
fn parse_hlc(hlc: &str) -> Option<(i64, &str)> {
    let mut parts = hlc.splitn(3, '-');
    let ms = parts.next()?.parse().ok()?;
    parts.next()?;
    Some((ms, parts.next()?))
}

impl Store {
    /// Whether one of `fields` of task `uid` was just set by another Mac.
    fn just_from_another_mac(
        &self,
        uid: &str,
        fields: &[&str],
        opts: &OutOptions<'_>,
    ) -> Result<bool, StoreError> {
        let Some(me) = opts.device else {
            return Ok(false);
        };
        let entity = format!("t:{uid}");
        for field in fields {
            let hlc: Option<String> = self
                .conn
                .query_row(
                    "SELECT hlc FROM sync_shadow WHERE entity = ?1 AND field = ?2",
                    params![entity, field],
                    |r| r.get(0),
                )
                .optional()?;
            if let Some((ms, device)) = hlc.as_deref().and_then(parse_hlc) {
                if device != me && opts.now_ms - ms < WAIT_FOR_OTHER_MAC_MS {
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// Plan what to send to `source`. See the module docs.
    pub fn mirror_outbox(&self, source: &str, opts: &OutOptions<'_>) -> Result<Outbox, StoreError> {
        let mut out = Outbox::default();
        // Synced projects here, by name (lowercase) → the other app's key.
        let mut key_of: HashMap<String, String> = HashMap::new();
        // Keys left alone ("Stop syncing").
        let mut stopped: HashSet<String> = HashSet::new();
        for m in self.mirror_projects(Some(source))? {
            if m.stopped {
                stopped.insert(m.key);
            } else {
                key_of.insert(m.project.to_lowercase(), m.key);
            }
        }
        let local_only: HashSet<String> =
            opts.local_only.iter().map(|p| p.to_lowercase()).collect();
        let kept_here = |project: &Option<String>| {
            project
                .as_ref()
                .is_some_and(|p| local_only.contains(&p.to_lowercase()))
        };
        // The other app's key → the project here (for deletes).
        let project_of: HashMap<String, String> =
            key_of.iter().map(|(p, k)| (k.clone(), p.clone())).collect();
        let building_of = |project: &Option<String>| -> Option<String> {
            match project {
                None => Some(LOOSE_KEY.to_string()),
                Some(p) => key_of.get(&p.to_lowercase()).cloned(),
            }
        };

        // ── Linked tasks ───────────────────────────────────────────────────
        let mut links: Vec<(String, Option<i64>, Base)> = Vec::new();
        {
            let mut stmt = self.conn.prepare(
                "SELECT i.ext_id, t.id, i.base FROM imports i
                 LEFT JOIN tasks t ON t.id = i.task_id
                 WHERE i.source = ?1 AND i.base IS NOT NULL",
            )?;
            let rows = stmt.query_map([source], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<i64>>(1)?,
                    r.get::<_, String>(2)?,
                ))
            })?;
            for row in rows {
                let (ext, task, base) = row?;
                if let Ok(base) = serde_json::from_str::<Base>(&base) {
                    if !stopped.contains(&base.building) {
                        links.push((ext, task, base));
                    }
                }
            }
        }
        let linked = links.len();
        let mut deletes: Vec<Op> = Vec::new();
        for (ext, task, old) in links {
            let Some(id) = task else {
                if !kept_here(&project_of.get(&old.building).cloned()) {
                    deletes.push(Op::Delete { ext_id: ext, old });
                }
                continue;
            };
            let t = self.get(id)?;
            if kept_here(&t.project) {
                continue;
            }
            let Some(building) = building_of(&t.project) else {
                // Moved into a project that isn't synced: it stops syncing
                // and the other app keeps its copy.
                self.conn.execute(
                    "UPDATE imports SET task_id = NULL, base = NULL WHERE source = ?1 AND ext_id = ?2",
                    params![source, ext],
                )?;
                continue;
            };
            let here = base_here(&t, building);
            let want = wanted(&old, &here, opts.extras, opts.today);
            if want == old {
                continue;
            }
            let uid = self.uid_of(id)?;
            let mut next = None;
            if want.done && !old.done && t.recurrence.is_some() {
                if let Some(uid) = &uid {
                    if self.just_from_another_mac(uid, &["done"], opts)? {
                        out.waiting += 1;
                        continue;
                    }
                }
                next = self.next_occurrence(id)?;
            }
            out.ops.push(Op::Update {
                task_id: id,
                ext_id: ext,
                uid,
                old,
                want,
                next,
            });
        }
        if deletes.len() > MAX_SAFE_DELETES && deletes.len() * 2 > linked {
            out.errors.push(format!(
                "{} tasks were deleted here at once, so they were kept in the other app, to be safe. Delete them there if you meant to.",
                deletes.len()
            ));
        } else {
            out.ops.extend(deletes);
        }

        // ── New here ───────────────────────────────────────────────────────
        // Open tasks in a synced project that aren't linked to any app.
        let mut stmt = self.conn.prepare(
            "SELECT t.id, t.project, t.uid FROM tasks t
             WHERE t.done = 0 AND t.project IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM imports i WHERE i.task_id = t.id)
             ORDER BY t.created_at, t.id",
        )?;
        let rows: Vec<(i64, String, Option<String>)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
            .collect::<Result<_, _>>()?;
        for (id, project, uid) in rows {
            let Some(building) = key_of.get(&project.to_lowercase()).cloned() else {
                continue;
            };
            if local_only.contains(&project.to_lowercase()) {
                continue;
            }
            let Some(uid) = uid else { continue };
            if self.just_from_another_mac(&uid, &["title", "project"], opts)? {
                out.waiting += 1;
                continue;
            }
            let t = self.get(id)?;
            out.ops.push(Op::Create {
                task_id: id,
                uid,
                want: base_here(&t, building),
            });
        }
        Ok(out)
    }

    /// Record how sending `op` to `source` went.
    pub fn mirror_sent(&self, source: &str, op: &Op, sent: &Sent) -> Result<(), StoreError> {
        let json = |b: &Base| serde_json::to_string(b).unwrap_or_default();
        match (op, sent) {
            (_, Sent::Failed(_)) => {}
            (Op::Create { task_id, want, .. }, Sent::Ok(Some(ext))) => {
                self.conn.execute(
                    "INSERT INTO imports (source, ext_id, task_id, imported_at, base)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT (source, ext_id) DO UPDATE SET task_id = excluded.task_id, base = excluded.base",
                    params![source, ext, task_id, chrono::Utc::now().to_rfc3339(), json(want)],
                )?;
            }
            (Op::Create { .. }, _) => {}
            (
                Op::Update {
                    ext_id, want, next, ..
                },
                Sent::Ok(_),
            ) => {
                let (task, base) = match next {
                    // The repeat moved on there: follow it here.
                    Some(next) if want.done => {
                        let t = self.get(*next)?;
                        let mut b = want.clone();
                        b.done = false;
                        b.due_date = t.due_date.clone();
                        b.due_time = t.due_time.clone();
                        b.recurrence = t.recurrence.clone().or(b.recurrence.take());
                        (Some(*next), b)
                    }
                    _ => (None, want.clone()),
                };
                match task {
                    Some(task) => self.conn.execute(
                        "UPDATE imports SET task_id = ?3, base = ?4 WHERE source = ?1 AND ext_id = ?2",
                        params![source, ext_id, task, json(&base)],
                    )?,
                    None => self.conn.execute(
                        "UPDATE imports SET base = ?3 WHERE source = ?1 AND ext_id = ?2",
                        params![source, ext_id, json(&base)],
                    )?,
                };
            }
            (Op::Update { .. }, Sent::Gone) => {}
            (Op::Delete { ext_id, .. }, Sent::Ok(_) | Sent::Gone) => {
                // Kept, with no task: it never comes back.
                self.conn.execute(
                    "UPDATE imports SET task_id = NULL, base = NULL WHERE source = ?1 AND ext_id = ?2",
                    params![source, ext_id],
                )?;
            }
        }
        Ok(())
    }

    /// Two-way sync was just turned on for `source`: tasks deleted here
    /// while it was one-way stay in the other app (they were never meant
    /// to be removed there). Edits made here meanwhile go out as usual.
    pub fn mirror_start_two_way(&self, source: &str) -> Result<usize, StoreError> {
        Ok(self.conn.execute(
            "UPDATE imports SET task_id = NULL, base = NULL
             WHERE source = ?1 AND base IS NOT NULL
               AND (task_id IS NULL OR NOT EXISTS (SELECT 1 FROM tasks t WHERE t.id = imports.task_id))",
            [source],
        )?)
    }
}

#[cfg(test)]
mod tests;
