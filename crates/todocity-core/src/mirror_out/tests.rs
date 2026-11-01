//! Two-way sync against a pretend app that behaves like Todoist: a finished
//! repeating task stays open and moves to its next date. Two Macs are
//! joined by real Mac-to-Mac sync.

use std::collections::{BTreeMap, HashSet};

use chrono::NaiveDate;

use super::*;
use crate::mirror::{link_line, take_link, PassOptions, PassReport, Source};
use crate::store::{Imported, NewTask, TaskPatch};

fn day(d: u32) -> NaiveDate {
    NaiveDate::from_ymd_opt(2026, 11, d).unwrap()
}

/// The other app.
#[derive(Default)]
struct App {
    items: BTreeMap<String, Imported>,
    made: u32,
    /// Sends fail while this is on (no network).
    offline: bool,
    /// How many times each task was finished there.
    closed: BTreeMap<String, u32>,
}

impl App {
    fn new() -> Self {
        let mut a = App::default();
        a.put("a", "p1", "Plant tulips");
        a.put("b", LOOSE_KEY, "Call Sam");
        a
    }
    fn put(&mut self, id: &str, building: &str, title: &str) -> &mut Imported {
        self.items.insert(
            id.into(),
            Imported {
                ext_id: id.into(),
                building: building.into(),
                task: NewTask {
                    title: title.into(),
                    source_app: Some("Todoist".into()),
                    ..Default::default()
                },
                done: false,
                completed_at: None,
                created_at: None,
            },
        );
        self.items.get_mut(id).unwrap()
    }
    fn get(&self, id: &str) -> &Imported {
        &self.items[id]
    }
    fn find(&self, title: &str) -> Option<&Imported> {
        self.items.values().find(|i| i.task.title == title)
    }
    fn send(&mut self, op: &Op) -> Sent {
        if self.offline {
            return Sent::Failed("offline".into());
        }
        let fill = |i: &mut Imported, w: &Base| {
            i.building = w.building.clone();
            i.task.title = w.title.clone();
            i.task.due_date = w.due_date.clone();
            i.task.due_time = w.due_time.clone();
            i.task.deadline = w.deadline.clone();
            i.task.recurrence = w.recurrence.clone();
            i.task.priority = w.priority;
            i.task.heading = w.floor.clone();
        };
        match op {
            Op::Create { uid, want, .. } => {
                self.made += 1;
                let id = format!("n{}", self.made);
                let mut i = Imported {
                    ext_id: id.clone(),
                    building: String::new(),
                    task: NewTask::default(),
                    done: false,
                    completed_at: None,
                    created_at: None,
                };
                fill(&mut i, want);
                let mut notes = want.notes.clone().unwrap_or_default();
                if !notes.is_empty() {
                    notes.push_str("\n\n");
                }
                notes.push_str(&link_line(uid));
                i.task.notes = Some(notes);
                self.items.insert(id.clone(), i);
                Sent::Ok(Some(id))
            }
            Op::Update {
                ext_id, old, want, ..
            } => {
                let Some(i) = self.items.get_mut(ext_id) else {
                    return Sent::Gone;
                };
                let link = {
                    let mut n = i.task.notes.clone();
                    take_link(&mut n)
                };
                fill(i, want);
                i.task.notes = match (&want.notes, link) {
                    (n, None) => n.clone(),
                    (None, Some(u)) => Some(link_line(&u)),
                    (Some(n), Some(u)) => Some(format!("{n}\n\n{}", link_line(&u))),
                };
                if want.done && !old.done {
                    *self.closed.entry(ext_id.clone()).or_default() += 1;
                    match &want.recurrence {
                        // A repeat moves on a week and stays open.
                        Some(_) => {
                            let d = NaiveDate::parse_from_str(
                                old.due_date.as_deref().unwrap(),
                                "%Y-%m-%d",
                            )
                            .unwrap();
                            i.task.due_date = Some((d + chrono::Duration::days(7)).to_string());
                        }
                        None => {
                            i.done = true;
                            i.completed_at = Some("2026-11-10T09:00:00Z".into());
                        }
                    }
                } else {
                    i.done = want.done;
                }
                Sent::Ok(None)
            }
            Op::Delete { ext_id, .. } => match self.items.remove(ext_id) {
                Some(_) => Sent::Ok(None),
                None => Sent::Gone,
            },
        }
    }
}

/// One Mac: its store, and its id in Mac-to-Mac sync.
struct Mac {
    store: Store,
    device: &'static str,
    paired: bool,
    local_only: HashSet<String>,
}

#[derive(Debug, Default)]
struct Pass {
    pull: PassReport,
    out: Outbox,
}

impl Mac {
    fn new(device: &'static str) -> Self {
        Self {
            store: Store::open_in_memory().unwrap(),
            device,
            paired: false,
            local_only: HashSet::new(),
        }
    }
    /// One two-way pass `wait` ms from now.
    fn pass_at(&self, app: &mut App, later_ms: i64) -> Pass {
        let items: Vec<Imported> = app.items.values().cloned().collect();
        let buildings = vec![("p1".to_string(), "Garden".to_string())];
        let floors = vec![("Garden".to_string(), None)];
        let pull = self
            .store
            .mirror(
                &Source {
                    source: "todoist",
                    buildings,
                    floors: &floors,
                    items: &items,
                    complete: true,
                },
                &PassOptions {
                    today: day(10),
                    since: "2026-11-01T00:00:00Z",
                    two_way: true,
                },
            )
            .unwrap();
        let out = self
            .store
            .mirror_outbox(
                "todoist",
                &OutOptions {
                    today: day(10),
                    extras: Extras::default(),
                    device: self.paired.then_some(self.device),
                    now_ms: chrono::Utc::now().timestamp_millis() + later_ms,
                    local_only: &self.local_only,
                },
            )
            .unwrap();
        for op in &out.ops {
            let sent = app.send(op);
            self.store.mirror_sent("todoist", op, &sent).unwrap();
        }
        Pass { pull, out }
    }
    fn pass(&self, app: &mut App) -> Pass {
        self.pass_at(app, 0)
    }
    fn find(&self, title: &str) -> crate::store::Task {
        self.store
            .all()
            .unwrap()
            .into_iter()
            .find(|t| t.title == title)
            .unwrap_or_else(|| panic!("no task {title} on {}", self.device))
    }
    fn titles(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .store
            .all()
            .unwrap()
            .into_iter()
            .map(|t| t.title)
            .collect();
        v.sort();
        v
    }
    fn add(&self, title: &str, project: Option<&str>) -> i64 {
        self.store
            .insert(NewTask {
                title: title.into(),
                project: project.map(Into::into),
                ..Default::default()
            })
            .unwrap()
            .id
    }
    fn edit(&self, id: i64, patch: TaskPatch) {
        self.store.update(id, patch).unwrap();
    }
}

/// Mac-to-Mac sync: everything pending from `a` to `b`.
fn send(a: &mut Mac, b: &mut Mac) {
    a.paired = true;
    b.paired = true;
    let none = HashSet::new();
    a.store.sync_collect(a.device, a.device, &none).unwrap();
    let p = a.store.sync_pending(100_000).unwrap();
    a.store.sync_mark_sent(&p).unwrap();
    b.store.sync_apply(b.device, &p).unwrap();
}

/// Both ways, so each Mac has the other's changes and nothing is pending.
fn both(a: &mut Mac, b: &mut Mac) {
    send(a, b);
    send(b, a);
}

const LATER: i64 = WAIT_FOR_OTHER_MAC_MS + 60_000;

// ── One Mac ─────────────────────────────────────────────────────────────────

#[test]
fn an_edit_here_goes_there_and_settles() {
    let mut app = App::new();
    let mac = Mac::new("a");
    mac.pass(&mut app);
    let id = mac.find("Plant tulips").id;
    mac.edit(
        id,
        TaskPatch {
            title: Some("Plant 40 tulips".into()),
            priority: Some(1),
            deadline: Some(Some("2026-11-20".into())),
            ..Default::default()
        },
    );
    let p = mac.pass(&mut app);
    assert_eq!(p.out.ops.len(), 1);
    let there = app.get("a");
    assert_eq!(there.task.title, "Plant 40 tulips");
    assert_eq!(there.task.priority, 1);
    assert_eq!(there.task.deadline.as_deref(), Some("2026-11-20"));
    // Nothing left to send, and nothing changes here.
    let p = mac.pass(&mut app);
    assert!(p.out.ops.is_empty());
    assert_eq!(p.pull, PassReport::default());
    assert_eq!(mac.find("Plant 40 tulips").priority, 1);
}

#[test]
fn only_fields_changed_here_are_sent() {
    let mut app = App::new();
    let mac = Mac::new("a");
    mac.pass(&mut app);
    let id = mac.find("Plant tulips").id;
    mac.edit(
        id,
        TaskPatch {
            priority: Some(2),
            ..Default::default()
        },
    );
    // Meanwhile the title changed there.
    app.items.get_mut("a").unwrap().task.title = "Plant tulips by the gate".into();
    mac.pass(&mut app);
    assert_eq!(app.get("a").task.title, "Plant tulips by the gate");
    assert_eq!(app.get("a").task.priority, 2);
    assert_eq!(mac.store.get(id).unwrap().title, "Plant tulips by the gate");
}

#[test]
fn the_same_field_changed_on_both_sides_takes_the_other_apps() {
    let mut app = App::new();
    let mac = Mac::new("a");
    mac.pass(&mut app);
    let id = mac.find("Plant tulips").id;
    mac.edit(
        id,
        TaskPatch {
            title: Some("Here".into()),
            ..Default::default()
        },
    );
    app.items.get_mut("a").unwrap().task.title = "There".into();
    let p = mac.pass(&mut app);
    assert!(p.out.ops.is_empty());
    assert_eq!(mac.store.get(id).unwrap().title, "There");
    assert_eq!(app.get("a").task.title, "There");
}

#[test]
fn a_past_day_shown_as_today_is_not_a_change() {
    let mut app = App::new();
    app.items.get_mut("a").unwrap().task.due_date = Some("2026-11-02".into());
    let mac = Mac::new("a");
    mac.pass(&mut app);
    assert_eq!(
        mac.find("Plant tulips").due_date.as_deref(),
        Some("2026-11-10")
    );
    assert!(mac.pass(&mut app).out.ops.is_empty());
    assert_eq!(app.get("a").task.due_date.as_deref(), Some("2026-11-02"));
    // Finishing it doesn't move its day there either.
    mac.edit(
        mac.find("Plant tulips").id,
        TaskPatch {
            done: Some(true),
            ..Default::default()
        },
    );
    mac.pass(&mut app);
    assert!(app.get("a").done);
    assert_eq!(app.get("a").task.due_date.as_deref(), Some("2026-11-02"));
}

#[test]
fn a_new_task_in_a_synced_project_is_added_there_once() {
    let mut app = App::new();
    let mac = Mac::new("a");
    mac.pass(&mut app);
    mac.add("Water the roses", Some("Garden"));
    // In the Inbox or an unsynced project: stays here.
    mac.add("Buy stamps", None);
    mac.store.create_project("Home").unwrap();
    mac.add("Fix the tap", Some("Home"));
    let p = mac.pass(&mut app);
    assert_eq!(p.out.ops.len(), 1);
    let there = app.find("Water the roses").expect("added there");
    assert_eq!(there.building, "p1");
    assert!(there.task.notes.as_deref().unwrap().starts_with(LINK_START));
    // Next pass: linked, not doubled on either side, and the link line
    // never shows up in its notes here.
    let p = mac.pass(&mut app);
    assert!(p.out.ops.is_empty());
    assert_eq!(p.pull.added, 0);
    assert_eq!(app.items.len(), 3);
    assert_eq!(mac.find("Water the roses").notes, None);
    assert!(app.find("Buy stamps").is_none());
    assert!(app.find("Fix the tap").is_none());
}

const LINK_START: &str = "todocity://task/";

#[test]
fn deleted_here_is_deleted_there_and_never_comes_back() {
    let mut app = App::new();
    let mac = Mac::new("a");
    mac.pass(&mut app);
    mac.store.delete(mac.find("Plant tulips").id).unwrap();
    mac.pass(&mut app);
    assert!(app.find("Plant tulips").is_none());
    // Even if it turns up there again under the same id.
    app.put("a", "p1", "Plant tulips");
    mac.pass(&mut app);
    assert_eq!(mac.titles(), ["Call Sam"]);
}

#[test]
fn deleted_there_is_removed_here() {
    let mut app = App::new();
    let mac = Mac::new("a");
    mac.pass(&mut app);
    app.items.remove("a");
    let p = mac.pass(&mut app);
    assert_eq!(p.pull.removed, 1);
    assert!(p.out.ops.is_empty());
    assert_eq!(mac.titles(), ["Call Sam"]);
}

#[test]
fn deleting_many_here_at_once_is_held_back() {
    let mut app = App::new();
    for i in 0..30 {
        app.put(&format!("x{i}"), "p1", &format!("Bulb {i}"));
    }
    let mac = Mac::new("a");
    mac.pass(&mut app);
    for t in mac.store.all().unwrap() {
        if t.title.starts_with("Bulb") {
            mac.store.delete(t.id).unwrap();
        }
    }
    let p = mac.pass(&mut app);
    assert_eq!(p.out.errors.len(), 1);
    assert_eq!(app.items.len(), 32);
    // A few at a time still go.
    let mut app = App::new();
    let mac = Mac::new("a");
    mac.pass(&mut app);
    mac.store.delete(mac.find("Call Sam").id).unwrap();
    assert!(mac.pass(&mut app).out.errors.is_empty());
    assert_eq!(app.items.len(), 1);
}

#[test]
fn offline_edits_wait_and_go_when_back() {
    let mut app = App::new();
    let mac = Mac::new("a");
    mac.pass(&mut app);
    let id = mac.find("Plant tulips").id;
    app.offline = true;
    mac.edit(
        id,
        TaskPatch {
            title: Some("Plant bulbs".into()),
            ..Default::default()
        },
    );
    mac.add("Rake leaves", Some("Garden"));
    mac.store.delete(mac.find("Call Sam").id).unwrap();
    mac.pass(&mut app);
    mac.pass(&mut app);
    assert_eq!(app.get("a").task.title, "Plant tulips");
    assert_eq!(app.items.len(), 2);
    app.offline = false;
    mac.pass(&mut app);
    assert_eq!(app.get("a").task.title, "Plant bulbs");
    assert!(app.find("Rake leaves").is_some());
    assert!(app.find("Call Sam").is_none());
    assert_eq!(app.items.len(), 2);
    assert!(mac.pass(&mut app).out.ops.is_empty());
}

#[test]
fn a_repeat_finished_here_moves_on_there_once() {
    let mut app = App::new();
    {
        let a = app.items.get_mut("a").unwrap();
        a.task.due_date = Some("2027-03-01".into());
        a.task.recurrence = Some("weekly".into());
    }
    let mac = Mac::new("a");
    mac.pass(&mut app);
    let first = mac.find("Plant tulips").id;
    mac.edit(
        first,
        TaskPatch {
            done: Some(true),
            ..Default::default()
        },
    );
    let next = mac.store.get(first).unwrap().next_id.expect("next one");
    mac.pass(&mut app);
    assert_eq!(app.closed["a"], 1);
    assert_eq!(app.get("a").task.due_date.as_deref(), Some("2027-03-08"));
    // The next one here is the same task there, not a new one.
    assert_eq!(app.items.len(), 2);
    for _ in 0..3 {
        mac.pass(&mut app);
    }
    assert_eq!(app.items.len(), 2);
    assert_eq!(app.closed["a"], 1);
    assert!(mac.store.get(first).unwrap().done);
    let n = mac.store.get(next).unwrap();
    assert!(!n.done);
    assert_eq!(n.due_date.as_deref(), Some("2027-03-08"));
    assert_eq!(
        mac.store
            .all()
            .unwrap()
            .iter()
            .filter(|t| t.title == "Plant tulips")
            .count(),
        2
    );
    // Finishing the next one moves it on again, once.
    mac.edit(
        next,
        TaskPatch {
            done: Some(true),
            ..Default::default()
        },
    );
    mac.pass(&mut app);
    mac.pass(&mut app);
    assert_eq!(app.closed["a"], 2);
    assert_eq!(app.get("a").task.due_date.as_deref(), Some("2027-03-15"));
}

#[test]
fn a_repeat_finished_there_moves_on_here_without_doubling() {
    let mut app = App::new();
    {
        let a = app.items.get_mut("a").unwrap();
        a.task.due_date = Some("2027-03-01".into());
        a.task.recurrence = Some("weekly".into());
    }
    let mac = Mac::new("a");
    mac.pass(&mut app);
    app.items.get_mut("a").unwrap().task.due_date = Some("2027-03-08".into());
    let p = mac.pass(&mut app);
    assert!(p.out.ops.is_empty());
    assert_eq!(
        mac.find("Plant tulips").due_date.as_deref(),
        Some("2027-03-08")
    );
    assert_eq!(mac.titles(), ["Call Sam", "Plant tulips"]);
}

#[test]
fn moving_a_task_out_of_synced_projects_stops_syncing_it() {
    let mut app = App::new();
    let mac = Mac::new("a");
    mac.pass(&mut app);
    mac.store.create_project("Home").unwrap();
    let id = mac.find("Plant tulips").id;
    mac.edit(
        id,
        TaskPatch {
            project: Some(Some("Home".into())),
            ..Default::default()
        },
    );
    mac.pass(&mut app);
    // It stays in both apps, and no longer syncs.
    assert!(app.find("Plant tulips").is_some());
    app.items.get_mut("a").unwrap().task.title = "Changed there".into();
    mac.pass(&mut app);
    mac.pass(&mut app);
    assert_eq!(mac.store.get(id).unwrap().title, "Plant tulips");
    assert_eq!(app.items.len(), 2);
}

#[test]
fn moving_between_synced_projects_moves_it_there() {
    let mut app = App::new();
    let mac = Mac::new("a");
    mac.pass(&mut app);
    let id = mac.find("Call Sam").id;
    mac.edit(
        id,
        TaskPatch {
            project: Some(Some("Garden".into())),
            ..Default::default()
        },
    );
    mac.pass(&mut app);
    assert_eq!(app.get("b").building, "p1");
    assert!(mac.pass(&mut app).out.ops.is_empty());
}

#[test]
fn turning_two_way_on_keeps_one_way_deletes_there() {
    let mut app = App::new();
    let mac = Mac::new("a");
    // One-way for a while: a delete here never reached the other app.
    let items: Vec<Imported> = app.items.values().cloned().collect();
    mac.store
        .mirror(
            &Source {
                source: "todoist",
                buildings: vec![("p1".into(), "Garden".into())],
                floors: &[("Garden".into(), None)],
                items: &items,
                complete: true,
            },
            &PassOptions {
                today: day(10),
                since: "2026-11-01T00:00:00Z",
                two_way: false,
            },
        )
        .unwrap();
    mac.store.delete(mac.find("Call Sam").id).unwrap();
    assert_eq!(mac.store.mirror_start_two_way("todoist").unwrap(), 1);
    let p = mac.pass(&mut app);
    assert!(p.out.ops.is_empty());
    assert!(app.find("Call Sam").is_some());
    assert_eq!(mac.titles(), ["Plant tulips"]);
}

#[test]
fn a_new_task_there_that_is_already_here_is_linked() {
    let mut app = App::new();
    let mac = Mac::new("a");
    mac.store.create_project("Garden").unwrap();
    mac.add("plant  Tulips", Some("Garden"));
    mac.pass(&mut app);
    assert_eq!(mac.titles(), ["Call Sam", "Plant tulips"]);
    assert_eq!(app.items.len(), 2);
}

// ── Two Macs ────────────────────────────────────────────────────────────────

/// Mac A set up two-way sync first; Mac B has A's tasks through Mac-to-Mac
/// sync and connects the same app.
fn two_macs(app: &mut App) -> (Mac, Mac) {
    let mut a = Mac::new("mac-a");
    let mut b = Mac::new("mac-b");
    a.pass(app);
    both(&mut a, &mut b);
    b.pass_at(app, LATER);
    both(&mut a, &mut b);
    (a, b)
}

#[test]
fn a_second_mac_links_to_the_tasks_it_already_has() {
    let mut app = App::new();
    let (a, b) = two_macs(&mut app);
    assert_eq!(a.titles(), ["Call Sam", "Plant tulips"]);
    assert_eq!(b.titles(), ["Call Sam", "Plant tulips"]);
    assert_eq!(app.items.len(), 2);
}

#[test]
fn a_task_added_on_one_mac_is_added_there_once() {
    let mut app = App::new();
    let (mut a, mut b) = two_macs(&mut app);
    a.add("Water the roses", Some("Garden"));
    // B hears about it first and waits for A.
    both(&mut a, &mut b);
    let p = b.pass(&mut app);
    assert_eq!(p.out.waiting, 1);
    assert!(app.find("Water the roses").is_none());
    a.pass(&mut app);
    let p = b.pass(&mut app);
    assert_eq!(p.out.waiting, 0);
    assert!(p.out.ops.is_empty());
    for _ in 0..2 {
        a.pass_at(&mut app, LATER);
        b.pass_at(&mut app, LATER);
        both(&mut a, &mut b);
    }
    assert_eq!(
        app.items
            .values()
            .filter(|i| i.task.title == "Water the roses")
            .count(),
        1
    );
    assert_eq!(b.titles(), ["Call Sam", "Plant tulips", "Water the roses"]);
    assert_eq!(a.titles(), b.titles());
}

#[test]
fn a_task_added_on_a_mac_without_the_app_is_added_by_the_other_later() {
    let mut app = App::new();
    let (mut a, mut b) = two_macs(&mut app);
    // A stops syncing with the app; B is the only one left.
    a.store.forget_mirror("todoist").unwrap();
    a.add("Rake leaves", Some("Garden"));
    both(&mut a, &mut b);
    assert_eq!(b.pass(&mut app).out.waiting, 1);
    b.pass_at(&mut app, LATER);
    assert!(app.find("Rake leaves").is_some());
    assert!(b.pass_at(&mut app, LATER).out.ops.is_empty());
}

#[test]
fn edits_on_two_macs_settle_without_ping_pong() {
    let mut app = App::new();
    let (mut a, mut b) = two_macs(&mut app);
    a.edit(
        a.find("Plant tulips").id,
        TaskPatch {
            title: Some("Plant tulips today".into()),
            ..Default::default()
        },
    );
    both(&mut a, &mut b);
    // B passes before A has sent it: it sends the same change (harmless).
    b.pass(&mut app);
    a.pass(&mut app);
    for _ in 0..2 {
        a.pass(&mut app);
        b.pass(&mut app);
        both(&mut a, &mut b);
    }
    assert_eq!(app.get("a").task.title, "Plant tulips today");
    assert!(a.pass(&mut app).out.ops.is_empty());
    assert!(b.pass(&mut app).out.ops.is_empty());
    assert_eq!(a.titles(), b.titles());
}

#[test]
fn a_delete_on_one_mac_deletes_there_once_and_stays_deleted() {
    let mut app = App::new();
    let (mut a, mut b) = two_macs(&mut app);
    a.store.delete(a.find("Call Sam").id).unwrap();
    both(&mut a, &mut b);
    b.pass(&mut app);
    a.pass(&mut app);
    for _ in 0..2 {
        a.pass_at(&mut app, LATER);
        b.pass_at(&mut app, LATER);
        both(&mut a, &mut b);
    }
    assert!(app.find("Call Sam").is_none());
    assert_eq!(a.titles(), ["Plant tulips"]);
    assert_eq!(b.titles(), ["Plant tulips"]);
}

#[test]
fn a_repeat_finished_on_one_mac_moves_on_there_once() {
    let mut app = App::new();
    {
        let x = app.items.get_mut("a").unwrap();
        x.task.due_date = Some("2027-03-01".into());
        x.task.recurrence = Some("weekly".into());
    }
    let (mut a, mut b) = two_macs(&mut app);
    a.edit(
        a.find("Plant tulips").id,
        TaskPatch {
            done: Some(true),
            ..Default::default()
        },
    );
    both(&mut a, &mut b);
    // B hears first: it waits for A rather than finish it there too.
    let p = b.pass(&mut app);
    assert_eq!(p.out.waiting, 1);
    assert_eq!(app.closed.get("a"), None);
    a.pass(&mut app);
    assert_eq!(app.closed["a"], 1);
    for _ in 0..3 {
        b.pass_at(&mut app, LATER);
        a.pass_at(&mut app, LATER);
        both(&mut a, &mut b);
    }
    assert_eq!(app.closed["a"], 1);
    assert_eq!(app.get("a").task.due_date.as_deref(), Some("2027-03-08"));
    assert_eq!(app.items.len(), 2);
    for mac in [&a, &b] {
        let all = mac.store.all().unwrap();
        let tulips: Vec<_> = all.iter().filter(|t| t.title == "Plant tulips").collect();
        assert_eq!(tulips.len(), 2, "on {}", mac.device);
        assert_eq!(tulips.iter().filter(|t| t.done).count(), 1);
        assert!(tulips
            .iter()
            .any(|t| !t.done && t.due_date.as_deref() == Some("2027-03-08")));
    }
}

#[test]
fn a_repeat_finished_on_a_mac_that_is_away_is_finished_by_the_other() {
    let mut app = App::new();
    {
        let x = app.items.get_mut("a").unwrap();
        x.task.due_date = Some("2027-03-01".into());
        x.task.recurrence = Some("weekly".into());
    }
    let (mut a, mut b) = two_macs(&mut app);
    a.edit(
        a.find("Plant tulips").id,
        TaskPatch {
            done: Some(true),
            ..Default::default()
        },
    );
    // A goes to sleep right after telling B.
    both(&mut a, &mut b);
    b.pass_at(&mut app, LATER);
    assert_eq!(app.closed["a"], 1);
    // A wakes up: it follows instead of finishing it again.
    a.pass_at(&mut app, LATER);
    both(&mut a, &mut b);
    a.pass_at(&mut app, LATER);
    b.pass_at(&mut app, LATER);
    assert_eq!(app.closed["a"], 1);
    assert_eq!(app.get("a").task.due_date.as_deref(), Some("2027-03-08"));
}

#[test]
fn a_twin_added_by_both_macs_shows_once_here() {
    let mut app = App::new();
    let (mut a, mut b) = two_macs(&mut app);
    a.add("Water the roses", Some("Garden"));
    both(&mut a, &mut b);
    // Both Macs send it while apart (A was slow, B gave up waiting).
    a.pass(&mut app);
    let uid = a
        .store
        .uid_of(a.find("Water the roses").id)
        .unwrap()
        .unwrap();
    // The twin B made carries the same link.
    app.made += 1;
    let twin = app.put("twin", "p1", "Water the roses");
    twin.task.notes = Some(link_line(&uid));
    for _ in 0..2 {
        a.pass_at(&mut app, LATER);
        b.pass_at(&mut app, LATER);
        both(&mut a, &mut b);
    }
    assert_eq!(a.titles(), ["Call Sam", "Plant tulips", "Water the roses"]);
    assert_eq!(b.titles(), a.titles());
}

// ── Pieces ──────────────────────────────────────────────────────────────────

#[test]
fn link_lines_come_out_of_notes() {
    let uid = "0123456789abcdef0123456789abcdef";
    let mut n = Some(format!("Bring gloves\n\n{}", link_line(uid)));
    assert_eq!(take_link(&mut n).as_deref(), Some(uid));
    assert_eq!(n.as_deref(), Some("Bring gloves"));
    let mut n = Some(link_line(uid));
    assert_eq!(take_link(&mut n).as_deref(), Some(uid));
    assert_eq!(n, None);
    let mut n = Some("todocity://task/short".to_string());
    assert_eq!(take_link(&mut n), None);
    assert_eq!(n.as_deref(), Some("todocity://task/short"));
}

#[test]
fn a_project_kept_on_this_mac_sends_nothing() {
    let mut app = App::new();
    let mut mac = Mac::new("a");
    mac.pass(&mut app);
    mac.local_only.insert("garden".into());
    mac.edit(
        mac.find("Plant tulips").id,
        TaskPatch {
            title: Some("Plant bulbs".into()),
            ..Default::default()
        },
    );
    mac.add("Water the roses", Some("Garden"));
    let p = mac.pass(&mut app);
    assert!(p.out.ops.is_empty());
    assert_eq!(app.items.len(), 2);
    assert_eq!(app.get("a").task.title, "Plant tulips");
}
