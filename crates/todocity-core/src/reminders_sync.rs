//! Platform-independent rules for two-way sync with an external reminders
//! app (Apple Reminders on macOS).
//!
//! Each linked task keeps a *base*: the title, due day and done state both
//! sides last agreed on. On every sync pass we compare the base with the
//! current TodoCity task (local) and the current reminder (remote) and merge
//! field by field — a three-way merge, like version control:
//!
//! * only one side changed a field → that change wins;
//! * both changed the same field → the reminder wins (it is the side the
//!   user most recently touched outside TodoCity, e.g. on their iPhone).
//!
//! Deleting a reminder never deletes the TodoCity task; the task is *detached*
//! and is never re-added to Reminders. A detached reminder that turns up in
//! the list again wasn't deleted after all (EventKit can briefly fail to look
//! one up, e.g. while another device syncs): it's linked back to its task,
//! never brought in as a second one.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::store::{NewTask, ReminderLink, Store, StoreError, Task, TaskPatch};

/// The synced fields of a task or reminder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SyncState {
    pub title: String,
    /// `YYYY-MM-DD`
    pub due: Option<String>,
    pub done: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Merge {
    /// What both sides should hold now; becomes the new base.
    pub result: SyncState,
    /// The reminder must be updated.
    pub push_remote: bool,
    /// The TodoCity task must be updated.
    pub update_local: bool,
}

fn pick<T: PartialEq + Clone>(base: &T, local: &T, remote: &T) -> T {
    if remote != base {
        remote.clone()
    } else {
        local.clone()
    }
}

pub fn merge(base: &SyncState, local: &SyncState, remote: &SyncState) -> Merge {
    let result = SyncState {
        title: pick(&base.title, &local.title, &remote.title),
        due: pick(&base.due, &local.due, &remote.due),
        done: pick(&base.done, &local.done, &remote.done),
    };
    Merge {
        push_remote: result != *remote,
        update_local: result != *local,
        result,
    }
}

fn normalize(title: &str) -> String {
    title
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Pair unlinked TodoCity tasks with unlinked reminders that are evidently the
/// same item (same title, ignoring case and spacing, and the same due day),
/// so turning sync back on doesn't create duplicates. Each side is used at
/// most once. Returns `(local_index, remote_index)` pairs.
pub fn pair_duplicates(local: &[SyncState], remote: &[SyncState]) -> Vec<(usize, usize)> {
    let mut used = vec![false; remote.len()];
    let mut pairs = Vec::new();
    for (li, l) in local.iter().enumerate() {
        let key = normalize(&l.title);
        if let Some(ri) = remote
            .iter()
            .enumerate()
            .position(|(ri, r)| !used[ri] && r.due == l.due && normalize(&r.title) == key)
        {
            used[ri] = true;
            pairs.push((li, ri));
        }
    }
    pairs
}

impl SyncState {
    pub fn of_task(t: &Task) -> Self {
        Self {
            title: t.title.clone(),
            due: t.due_date.clone(),
            done: t.done,
        }
    }
}

/// The reminders app, as the sync pass needs it. Implementations must not
/// panic; failures are reported as `Err(message)`.
pub trait RemindersBackend {
    /// The reminder's current state; `Ok(None)` if it no longer exists.
    fn get(&mut self, id: &str) -> Result<Option<SyncState>, String>;
    fn update(&mut self, id: &str, state: &SyncState) -> Result<(), String>;
    /// Create a reminder in `list_id`; returns its identifier.
    fn create(
        &mut self,
        list_id: &str,
        state: &SyncState,
        notes: Option<&str>,
    ) -> Result<String, String>;
    /// Incomplete reminders currently in `list_id`.
    fn incomplete_in_list(&mut self, list_id: &str) -> Result<Vec<(String, SyncState)>, String>;
    /// Delete a reminder. One that's already gone is `Ok`.
    fn delete(&mut self, id: &str) -> Result<(), String>;
}

pub struct PassOptions<'a> {
    pub list_id: &'a str,
    /// Put the original selected text in the reminder's notes.
    pub include_notes: bool,
    /// Only tasks created at or after this RFC 3339 time get new reminders
    /// (so turning sync on doesn't push old tasks unless asked).
    pub sync_since: Option<&'a str>,
}

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize)]
pub struct PassReport {
    /// TodoCity tasks updated from Reminders.
    pub pulled: usize,
    /// Reminders updated from TodoCity.
    pub pushed: usize,
    /// New reminders created for TodoCity tasks.
    pub created: usize,
    /// New TodoCity tasks created from reminders.
    pub imported: usize,
    /// Tasks detached because their reminder was deleted.
    pub unlinked: usize,
    /// Detached reminders found in the list again, linked back to their task.
    pub relinked: usize,
    /// Reminders deleted because their task was deleted in TodoCity (on
    /// this Mac or another).
    pub deleted: usize,
    /// Per-item failures; the rest of the pass still ran.
    pub errors: Vec<String>,
}

impl PassReport {
    pub fn changed_local(&self) -> bool {
        self.pulled > 0 || self.imported > 0
    }
}

/// Patch turning `from` into `to`, or None if they already match.
fn patch_between(from: &SyncState, to: &SyncState) -> Option<TaskPatch> {
    let patch = TaskPatch {
        title: (from.title != to.title).then(|| to.title.clone()),
        due_date: (from.due != to.due).then(|| to.due.clone()),
        done: (from.done != to.done).then_some(to.done),
        ..Default::default()
    };
    (patch.title.is_some() || patch.due_date.is_some() || patch.done.is_some()).then_some(patch)
}

/// Merge one linked pair and save what both sides now hold.
fn reconcile(
    store: &Store,
    backend: &mut impl RemindersBackend,
    link: &ReminderLink,
    task: &Task,
    mut remote: SyncState,
    report: &mut PassReport,
) -> Result<(), StoreError> {
    // A reminder with an empty title can't become a task title.
    if remote.title.trim().is_empty() {
        remote.title = link.base.title.clone();
    }
    let local = SyncState::of_task(task);
    let m = merge(&link.base, &local, &remote);
    if m.push_remote {
        if let Err(e) = backend.update(&link.reminder_id, &m.result) {
            report.errors.push(e);
            return Ok(());
        }
        report.pushed += 1;
    }
    if m.update_local {
        if let Some(patch) = patch_between(&local, &m.result) {
            store.update(task.id, patch)?;
            report.pulled += 1;
        }
    }
    if m.result != link.base || link.detached {
        store.save_reminder_link(&ReminderLink {
            task_id: link.task_id,
            reminder_id: link.reminder_id.clone(),
            base: m.result,
            detached: false,
        })?;
    }
    Ok(())
}

/// A task an earlier pass brought in for `state` before it could link it
/// (the pass then stopped): open, unlinked, made after `original`, with the
/// reminder's title and day and nothing of its own.
fn stray_copy(t: &Task, state: &SyncState, original: &Task) -> bool {
    !t.done
        && t.id != original.id
        && t.created_at >= original.created_at
        && normalize(&t.title) == normalize(&state.title)
        && t.due_date == state.due
        && t.source_text.is_none()
        && t.source_app.is_none()
        && t.notes.is_none()
        && t.project.is_none()
        && t.checklist.is_empty()
}

/// Save a new link. One that clashes with a link already there (the same
/// reminder) is reported and skipped, so one item can't stop the pass.
fn link_new(
    store: &Store,
    link: ReminderLink,
    report: &mut PassReport,
) -> Result<bool, StoreError> {
    match store.save_reminder_link(&link) {
        Ok(()) => Ok(true),
        Err(StoreError::Sqlite(rusqlite::Error::SqliteFailure(e, _)))
            if e.code == rusqlite::ErrorCode::ConstraintViolation =>
        {
            report.errors.push(format!(
                "\"{}\" is already linked to a reminder",
                link.base.title
            ));
            Ok(false)
        }
        Err(e) => Err(e),
    }
}

/// One full two-way sync pass.
pub fn run_pass(
    store: &Store,
    backend: &mut impl RemindersBackend,
    opts: &PassOptions<'_>,
) -> Result<PassReport, StoreError> {
    let mut report = PassReport::default();
    let mut linked_tasks = HashSet::new();
    let mut linked_reminders = HashSet::new();

    // 0. Reminders whose tasks were deleted go too. Until that works they
    // are never brought back in as new tasks.
    let mut trashed = HashSet::new();
    for id in store.reminder_trash()? {
        match backend.delete(&id) {
            Ok(()) => {
                store.clear_reminder_trash(&id)?;
                report.deleted += 1;
            }
            Err(e) => report.errors.push(e),
        }
        trashed.insert(id);
    }

    // 1. Reconcile every linked pair.
    let mut detached: HashMap<String, ReminderLink> = HashMap::new();
    for link in store.reminder_links()? {
        if link.detached {
            linked_tasks.insert(link.task_id);
            detached.insert(link.reminder_id.clone(), link);
            continue;
        }
        let task = match store.get(link.task_id) {
            Ok(t) => t,
            Err(StoreError::NotFound(_)) => {
                store.remove_reminder_link(link.task_id)?;
                continue;
            }
            Err(e) => return Err(e),
        };
        let remote = match backend.get(&link.reminder_id) {
            Ok(Some(r)) => r,
            Ok(None) => {
                // Deleted in Reminders: keep the task, and remember not to
                // add it back. (If the list still has it, step 2 links it
                // back: it couldn't be looked up just now.)
                let gone = ReminderLink {
                    detached: true,
                    ..link.clone()
                };
                store.save_reminder_link(&gone)?;
                linked_tasks.insert(link.task_id);
                detached.insert(gone.reminder_id.clone(), gone);
                report.unlinked += 1;
                continue;
            }
            Err(e) => {
                report.errors.push(e);
                linked_tasks.insert(link.task_id);
                linked_reminders.insert(link.reminder_id.clone());
                continue;
            }
        };
        linked_tasks.insert(link.task_id);
        linked_reminders.insert(link.reminder_id.clone());
        reconcile(store, backend, &link, &task, remote, &mut report)?;
    }

    // 2. New items on either side.
    let since = opts.sync_since.unwrap_or("");
    let listed: Vec<(String, SyncState)> = match backend.incomplete_in_list(opts.list_id) {
        Ok(items) => items,
        Err(e) => {
            report.errors.push(e);
            Vec::new()
        }
    };
    // A detached reminder that's in the list after all: link it back to its
    // task, and let go of any copy an earlier pass brought in for it.
    let mut strays: HashSet<i64> = HashSet::new();
    let all_tasks = store.list(None)?;
    for (id, state) in &listed {
        let Some(link) = detached.get(id) else {
            continue;
        };
        let task = match store.get(link.task_id) {
            Ok(t) => t,
            Err(StoreError::NotFound(_)) => {
                store.remove_reminder_link(link.task_id)?;
                continue;
            }
            Err(e) => return Err(e),
        };
        linked_reminders.insert(id.clone());
        for t in &all_tasks {
            if !linked_tasks.contains(&t.id)
                && !strays.contains(&t.id)
                && stray_copy(t, state, &task)
            {
                store.delete(t.id)?;
                strays.insert(t.id);
            }
        }
        reconcile(store, backend, link, &task, state.clone(), &mut report)?;
        report.relinked += 1;
    }
    let local_new: Vec<Task> = all_tasks
        .into_iter()
        .filter(|t| {
            !t.done
                && !linked_tasks.contains(&t.id)
                && !strays.contains(&t.id)
                && t.created_at.as_str() >= since
        })
        .collect();
    let remote_new: Vec<(String, SyncState)> = listed
        .into_iter()
        .filter(|(id, s)| {
            !linked_reminders.contains(id)
                && !detached.contains_key(id)
                && !trashed.contains(id)
                && !s.title.trim().is_empty()
        })
        .collect();

    // 3. Link obvious duplicates instead of copying them both ways.
    let local_states: Vec<SyncState> = local_new.iter().map(SyncState::of_task).collect();
    let remote_states: Vec<SyncState> = remote_new.iter().map(|(_, s)| s.clone()).collect();
    let pairs = pair_duplicates(&local_states, &remote_states);
    let paired_local: HashSet<usize> = pairs.iter().map(|p| p.0).collect();
    let paired_remote: HashSet<usize> = pairs.iter().map(|p| p.1).collect();
    for (li, ri) in pairs {
        link_new(
            store,
            ReminderLink {
                task_id: local_new[li].id,
                reminder_id: remote_new[ri].0.clone(),
                base: local_states[li].clone(),
                detached: false,
            },
            &mut report,
        )?;
    }

    // 4. TodoCity → Reminders.
    for (i, task) in local_new.iter().enumerate() {
        if paired_local.contains(&i) {
            continue;
        }
        let state = &local_states[i];
        let notes = if opts.include_notes {
            task.source_text.as_deref()
        } else {
            None
        };
        match backend.create(opts.list_id, state, notes) {
            Ok(id) => {
                let link = ReminderLink {
                    task_id: task.id,
                    reminder_id: id,
                    base: state.clone(),
                    detached: false,
                };
                if link_new(store, link, &mut report)? {
                    report.created += 1;
                }
            }
            Err(e) => report.errors.push(e),
        }
    }

    // 5. Reminders → TodoCity.
    for (i, (id, state)) in remote_new.iter().enumerate() {
        if paired_remote.contains(&i) {
            continue;
        }
        let tx = store.conn.unchecked_transaction()?;
        let task = store.insert(NewTask {
            title: state.title.clone(),
            due_date: state.due.clone(),
            ..Default::default()
        })?;
        let link = ReminderLink {
            task_id: task.id,
            reminder_id: id.clone(),
            base: SyncState::of_task(&task),
            detached: false,
        };
        // A task that can't be linked isn't kept: no stray copies.
        if link_new(store, link, &mut report)? {
            tx.commit()?;
            report.imported += 1;
        }
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(title: &str, due: Option<&str>, done: bool) -> SyncState {
        SyncState {
            title: title.into(),
            due: due.map(Into::into),
            done,
        }
    }

    #[test]
    fn no_changes_means_nothing_to_do() {
        let b = s("Call Sam", Some("2026-10-16"), false);
        let m = merge(&b, &b, &b);
        assert_eq!(m.result, b);
        assert!(!m.push_remote && !m.update_local);
    }

    #[test]
    fn local_change_is_pushed() {
        let b = s("Call Sam", Some("2026-10-16"), false);
        let local = s("Call Sam", Some("2026-10-16"), true);
        let m = merge(&b, &local, &b);
        assert_eq!(m.result, local);
        assert!(m.push_remote && !m.update_local);
    }

    #[test]
    fn remote_change_is_pulled() {
        let b = s("Call Sam", Some("2026-10-16"), false);
        let remote = s("Call Sam re: hiring", Some("2026-10-18"), false);
        let m = merge(&b, &b, &remote);
        assert_eq!(m.result, remote);
        assert!(!m.push_remote && m.update_local);
    }

    #[test]
    fn different_fields_merge() {
        let b = s("Call Sam", Some("2026-10-16"), false);
        let local = s("Call Sam about hiring", Some("2026-10-16"), false);
        let remote = s("Call Sam", Some("2026-10-16"), true);
        let m = merge(&b, &local, &remote);
        assert_eq!(
            m.result,
            s("Call Sam about hiring", Some("2026-10-16"), true)
        );
        assert!(m.push_remote && m.update_local);
    }

    #[test]
    fn same_field_conflict_prefers_reminder() {
        let b = s("Call Sam", Some("2026-10-16"), false);
        let local = s("Call Sam", Some("2026-10-17"), false);
        let remote = s("Call Sam", Some("2026-10-20"), false);
        assert_eq!(
            merge(&b, &local, &remote).result.due.as_deref(),
            Some("2026-10-20")
        );
    }

    #[test]
    fn clearing_a_due_date_syncs() {
        let b = s("x", Some("2026-10-16"), false);
        let remote = s("x", None, false);
        let m = merge(&b, &b, &remote);
        assert_eq!(m.result.due, None);
        assert!(m.update_local);
    }

    #[test]
    fn pairs_obvious_duplicates_once() {
        let local = [
            s("Book  flights", Some("2026-10-20"), false),
            s("Pay rent", None, false),
            s("Book flights", Some("2026-10-20"), false),
        ];
        let remote = [
            s("book flights", Some("2026-10-20"), false),
            s("Pay rent", Some("2026-11-01"), false),
        ];
        // Only the first "Book flights" pairs; "Pay rent" differs by date.
        assert_eq!(pair_duplicates(&local, &remote), vec![(0, 0)]);
    }

    // ── Full passes against a fake Reminders app ────────────────────────────

    use std::collections::HashMap;

    #[derive(Default)]
    struct FakeReminders {
        items: HashMap<String, (String, SyncState, Option<String>)>, // id -> (list, state, notes)
        next: usize,
        fail_get: bool,
        fail_delete: bool,
        /// Reminders `get` can't find for now, though the list still has
        /// them (as EventKit does while another device syncs).
        unfindable: HashSet<String>,
    }

    impl FakeReminders {
        fn add(&mut self, list: &str, st: SyncState) -> String {
            self.next += 1;
            let id = format!("R{}", self.next);
            self.items.insert(id.clone(), (list.into(), st, None));
            id
        }
    }

    impl RemindersBackend for FakeReminders {
        fn get(&mut self, id: &str) -> Result<Option<SyncState>, String> {
            if self.fail_get {
                return Err("offline".into());
            }
            if self.unfindable.contains(id) {
                return Ok(None);
            }
            Ok(self.items.get(id).map(|(_, s, _)| s.clone()))
        }
        fn update(&mut self, id: &str, state: &SyncState) -> Result<(), String> {
            let item = self.items.get_mut(id).ok_or("missing")?;
            item.1 = state.clone();
            Ok(())
        }
        fn create(
            &mut self,
            list_id: &str,
            state: &SyncState,
            notes: Option<&str>,
        ) -> Result<String, String> {
            let id = self.add(list_id, state.clone());
            self.items.get_mut(&id).unwrap().2 = notes.map(Into::into);
            Ok(id)
        }
        fn incomplete_in_list(
            &mut self,
            list_id: &str,
        ) -> Result<Vec<(String, SyncState)>, String> {
            let mut v: Vec<_> = self
                .items
                .iter()
                .filter(|(_, (l, s, _))| l == list_id && !s.done)
                .map(|(id, (_, s, _))| (id.clone(), s.clone()))
                .collect();
            v.sort_by(|a, b| a.0.cmp(&b.0));
            Ok(v)
        }
        fn delete(&mut self, id: &str) -> Result<(), String> {
            if self.fail_delete {
                return Err("Reminders is busy".into());
            }
            self.items.remove(id);
            Ok(())
        }
    }

    const LIST: &str = "todocity-list";

    fn opts() -> PassOptions<'static> {
        PassOptions {
            list_id: LIST,
            include_notes: false,
            sync_since: None,
        }
    }

    fn new_task(store: &Store, title: &str, due: Option<&str>) -> Task {
        store
            .insert(NewTask {
                title: title.into(),
                due_date: due.map(Into::into),
                source_text: Some("original selection".into()),
                ..Default::default()
            })
            .unwrap()
    }

    #[test]
    fn pushes_new_tasks_and_imports_new_reminders() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        new_task(&store, "Book flights", Some("2026-10-20"));
        rem.add(LIST, s("Buy milk", None, false));
        rem.add("other-list", s("Not ours", None, false));

        let r = run_pass(&store, &mut rem, &opts()).unwrap();
        assert_eq!((r.created, r.imported), (1, 1));
        let titles: Vec<String> = store
            .list(None)
            .unwrap()
            .into_iter()
            .map(|t| t.title)
            .collect();
        assert!(titles.contains(&"Buy milk".to_string()));
        assert!(!titles.contains(&"Not ours".to_string()));
        assert_eq!(store.reminder_links().unwrap().len(), 2);

        // A second pass is a no-op.
        assert_eq!(
            run_pass(&store, &mut rem, &opts()).unwrap(),
            PassReport::default()
        );
    }

    #[test]
    fn completion_syncs_both_ways() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        let a = new_task(&store, "A", None);
        let b = new_task(&store, "B", None);
        run_pass(&store, &mut rem, &opts()).unwrap();
        let rid = |task_id| store.reminder_link(task_id).unwrap().unwrap().reminder_id;

        // Done in TodoCity → completed in Reminders.
        store
            .update(
                a.id,
                TaskPatch {
                    done: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        // Completed in Reminders → done in TodoCity.
        rem.items.get_mut(&rid(b.id)).unwrap().1.done = true;

        let r = run_pass(&store, &mut rem, &opts()).unwrap();
        assert_eq!((r.pushed, r.pulled), (1, 1));
        assert!(rem.items[&rid(a.id)].1.done);
        assert!(store.get(b.id).unwrap().done);
    }

    #[test]
    fn edits_in_reminders_reach_pluck() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        let t = new_task(&store, "Call Sam", Some("2026-10-16"));
        run_pass(&store, &mut rem, &opts()).unwrap();
        let id = store.reminder_link(t.id).unwrap().unwrap().reminder_id;
        rem.items.get_mut(&id).unwrap().1 = s("Call Sam about hiring", Some("2026-10-18"), false);
        run_pass(&store, &mut rem, &opts()).unwrap();
        let t = store.get(t.id).unwrap();
        assert_eq!(t.title, "Call Sam about hiring");
        assert_eq!(t.due_date.as_deref(), Some("2026-10-18"));
    }

    #[test]
    fn deleting_a_reminder_keeps_the_task() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        let t = new_task(&store, "Keep me", None);
        run_pass(&store, &mut rem, &opts()).unwrap();
        rem.items.clear();
        let r = run_pass(&store, &mut rem, &opts()).unwrap();
        assert_eq!(r.unlinked, 1);
        assert_eq!(r.created, 0, "a deleted reminder must not be re-created");
        assert_eq!(store.get(t.id).unwrap().title, "Keep me");
        assert!(store.reminder_links().unwrap().iter().all(|l| l.detached));
        // …and it stays deleted on later passes.
        assert_eq!(
            run_pass(&store, &mut rem, &opts()).unwrap(),
            PassReport::default()
        );
        assert!(rem.items.is_empty());
    }

    #[test]
    fn backend_errors_do_not_unlink_or_duplicate() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        new_task(&store, "A", None);
        run_pass(&store, &mut rem, &opts()).unwrap();
        rem.fail_get = true;
        let r = run_pass(&store, &mut rem, &opts()).unwrap();
        assert_eq!(r.errors.len(), 1);
        assert_eq!(
            r.created, 0,
            "a temporarily unreadable link must not be recreated"
        );
        assert_eq!(store.reminder_links().unwrap().len(), 1);
        assert_eq!(rem.items.len(), 1);
    }

    #[test]
    fn re_enabling_links_duplicates_instead_of_copying() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        new_task(&store, "Pay rent", Some("2026-11-01"));
        rem.add(LIST, s("pay  rent", Some("2026-11-01"), false));
        let r = run_pass(&store, &mut rem, &opts()).unwrap();
        assert_eq!((r.created, r.imported), (0, 0));
        assert_eq!(rem.items.len(), 1);
        assert_eq!(store.list(None).unwrap().len(), 1);
        assert_eq!(store.reminder_links().unwrap().len(), 1);
    }

    #[test]
    fn respects_sync_since_and_notes_setting() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        new_task(&store, "Old task", None);
        let since = "2999-01-01T00:00:00Z";
        let o = PassOptions {
            list_id: LIST,
            include_notes: true,
            sync_since: Some(since),
        };
        assert_eq!(run_pass(&store, &mut rem, &o).unwrap().created, 0);

        let o = PassOptions {
            list_id: LIST,
            include_notes: true,
            sync_since: None,
        };
        run_pass(&store, &mut rem, &o).unwrap();
        let (_, _, notes) = rem.items.values().next().unwrap();
        assert_eq!(notes.as_deref(), Some("original selection"));
    }

    // ── Deletes from another Mac (two Macs, one Reminders list) ─────────────

    fn none() -> HashSet<String> {
        HashSet::new()
    }

    /// Send everything pending from `a` to `b`, like Mac-to-Mac sync does.
    fn send(a: &Store, a_dev: &str, b: &Store, b_dev: &str) {
        a.sync_collect(a_dev, a_dev, &none()).unwrap();
        let p = a.sync_pending(100_000).unwrap();
        a.sync_mark_sent(&p).unwrap();
        b.sync_apply(b_dev, &p).unwrap();
    }

    #[test]
    fn a_delete_from_another_mac_deletes_the_reminder_and_never_comes_back() {
        let a = Store::open_in_memory().unwrap();
        let b = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        let t = new_task(&a, "Renew passport", Some("2026-11-03"));
        send(&a, "A", &b, "B");
        // Mac B syncs with Reminders: the task gets a reminder there.
        let on_b = b.all().unwrap()[0].clone();
        run_pass(&b, &mut rem, &opts()).unwrap();
        assert_eq!(rem.items.len(), 1);
        assert!(b.reminder_link(on_b.id).unwrap().is_some());

        // Deleted on Mac A; Mac B hears about it.
        a.delete(t.id).unwrap();
        send(&a, "A", &b, "B");
        assert!(b.all().unwrap().is_empty());
        assert_eq!(b.reminder_trash().unwrap().len(), 1);

        // The next pass deletes the reminder instead of importing it again.
        let r = run_pass(&b, &mut rem, &opts()).unwrap();
        assert_eq!((r.deleted, r.imported), (1, 0));
        assert!(rem.items.is_empty());
        assert!(b.all().unwrap().is_empty());
        assert!(b.reminder_trash().unwrap().is_empty());
        // And nothing comes back on later passes, or on Mac A.
        assert_eq!(
            run_pass(&b, &mut rem, &opts()).unwrap(),
            PassReport::default()
        );
        send(&b, "B", &a, "A");
        assert!(a.all().unwrap().is_empty());
    }

    #[test]
    fn a_reminder_that_cant_be_deleted_yet_is_not_imported_meanwhile() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        let t = new_task(&store, "Pay rent", None);
        run_pass(&store, &mut rem, &opts()).unwrap();
        store.delete(t.id).unwrap();
        rem.fail_delete = true;
        let r = run_pass(&store, &mut rem, &opts()).unwrap();
        assert_eq!((r.deleted, r.imported, r.errors.len()), (0, 0, 1));
        assert!(store.all().unwrap().is_empty());
        // Tried again next time, and then it's gone.
        rem.fail_delete = false;
        let r = run_pass(&store, &mut rem, &opts()).unwrap();
        assert_eq!((r.deleted, r.imported), (1, 0));
        assert!(rem.items.is_empty());
    }

    #[test]
    fn a_reminder_that_briefly_cant_be_found_is_linked_back_not_imported() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        let t = new_task(&store, "Renew passport", Some("2026-11-03"));
        run_pass(&store, &mut rem, &opts()).unwrap();
        let id = rem.items.keys().next().unwrap().clone();
        // EventKit can't look it up for a moment, but it's still in the
        // list: linked back in the same pass, not imported again, and the
        // pass carries on.
        rem.unfindable.insert(id.clone());
        let r = run_pass(&store, &mut rem, &opts()).unwrap();
        assert_eq!(
            (r.unlinked, r.relinked, r.imported, r.created),
            (1, 1, 0, 0)
        );
        assert!(r.errors.is_empty());
        rem.unfindable.clear();
        let r = run_pass(&store, &mut rem, &opts()).unwrap();
        assert_eq!((r.relinked, r.imported, r.created), (0, 0, 0));
        assert_eq!(store.all().unwrap().len(), 1);
        let links = store.reminder_links().unwrap();
        assert_eq!(links.len(), 1);
        assert!(!links[0].detached);
        // From then on it syncs as before.
        rem.items.get_mut(&id).unwrap().1.title = "Renew passport at the post office".into();
        let r = run_pass(&store, &mut rem, &opts()).unwrap();
        assert_eq!((r.pulled, r.relinked), (1, 0));
        assert_eq!(
            store.get(t.id).unwrap().title,
            "Renew passport at the post office"
        );
        assert_eq!(rem.items.len(), 1);
    }

    #[test]
    fn a_stray_copy_from_an_earlier_stopped_pass_is_let_go() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        let t = new_task(&store, "Call Maya", None);
        let id = rem.add(LIST, s("Call Maya", None, false));
        store
            .save_reminder_link(&ReminderLink {
                task_id: t.id,
                reminder_id: id,
                base: SyncState::of_task(&t),
                detached: true,
            })
            .unwrap();
        // What an older version left behind: a bare copy brought in for the
        // reminder, which it then couldn't link.
        let stray = store
            .insert(NewTask {
                title: "Call Maya".into(),
                ..Default::default()
            })
            .unwrap();
        // The person's own task with the same title stays.
        let mine = store
            .insert(NewTask {
                title: "Call Maya".into(),
                notes: Some("about the offsite".into()),
                ..Default::default()
            })
            .unwrap();
        let r = run_pass(&store, &mut rem, &opts()).unwrap();
        assert_eq!((r.relinked, r.imported), (1, 0));
        assert!(r.errors.is_empty());
        assert!(matches!(store.get(stray.id), Err(StoreError::NotFound(_))));
        assert!(store.get(t.id).is_ok());
        assert!(store.get(mine.id).is_ok());
        // Nothing doubles on later passes.
        run_pass(&store, &mut rem, &opts()).unwrap();
        let r = run_pass(&store, &mut rem, &opts()).unwrap();
        assert_eq!((r.imported, r.created), (0, 0));
        assert_eq!(store.all().unwrap().len(), 2);
    }

    #[test]
    fn detached_tasks_leave_reminders_alone() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        let t = new_task(&store, "Keep me", None);
        run_pass(&store, &mut rem, &opts()).unwrap();
        rem.items.clear();
        run_pass(&store, &mut rem, &opts()).unwrap(); // detached now
        let other = rem.add(LIST, s("Someone else's reminder", None, false));
        store.delete(t.id).unwrap();
        assert!(store.reminder_trash().unwrap().is_empty());
        run_pass(&store, &mut rem, &opts()).unwrap();
        assert!(rem.items.contains_key(&other));
    }

    #[test]
    fn un_ticking_a_repeat_deletes_its_next_reminder_too() {
        let store = Store::open_in_memory().unwrap();
        let mut rem = FakeReminders::default();
        let t = store
            .insert(NewTask {
                title: "Water plants".into(),
                due_date: Some("2026-11-02".into()),
                recurrence: Some("weekly".into()),
                ..Default::default()
            })
            .unwrap();
        store
            .update(
                t.id,
                TaskPatch {
                    done: Some(true),
                    ..Default::default()
                },
            )
            .unwrap();
        run_pass(&store, &mut rem, &opts()).unwrap(); // the next one gets a reminder
        assert_eq!(rem.items.values().filter(|(_, s, _)| !s.done).count(), 1);
        store
            .update(
                t.id,
                TaskPatch {
                    done: Some(false),
                    ..Default::default()
                },
            )
            .unwrap();
        let r = run_pass(&store, &mut rem, &opts()).unwrap();
        assert_eq!(
            r.imported, 0,
            "the next one's reminder must not come back as a task"
        );
        assert_eq!(store.all().unwrap().len(), 1);
    }
}
