//! Two-way sync with Todoist: carrying [`Op`]s out through Todoist's Sync
//! API, a batch of commands per request.
//!
//! | TodoCity                 | Todoist                                       |
//! |--------------------------|-----------------------------------------------|
//! | Title                    | Content (the label `#tags` stay labels)       |
//! | Notes                    | Description (comments stay comments)          |
//! | Day, time, repeat        | Due date (a repeat as "every week starting …")|
//! | Deadline, priority       | Deadline, priority                            |
//! | Project, section         | Project (the Inbox for none), section         |
//! | Done                     | Completed (a repeat moves to its next date)   |
//! | Deleted                  | Deleted                                       |
//!
//! Sub-tasks, someday and evening stay as they are in Todoist. Each command
//! carries an id made from what it does, so a request that's retried after
//! a timeout doesn't add a task twice: Todoist answers it from memory.

use std::collections::HashMap;

use chrono::NaiveDate;
use serde_json::{json, Map, Value};

use crate::mirror::{link_line, Base};
use crate::mirror_out::{Extras, Op, Sent};
use crate::things::LOOSE_KEY;
use crate::todoist::Library;

/// What Todoist carries back beyond the usual fields: nothing.
pub const EXTRAS: Extras = Extras {
    someday: false,
    evening: false,
    checklist: false,
};

/// Todoist takes up to 100 commands a request.
const BATCH: usize = 90;

/// The `#tags` TodoCity added for labels: the run of `#words` at the end.
fn label_suffix(title: &str) -> &str {
    let t = title.trim_end();
    let mut cut = t.len();
    while let Some(i) = t[..cut].trim_end().rfind(' ') {
        let word = t[i + 1..cut].trim();
        if word.len() > 1 && word.starts_with('#') {
            cut = i;
        } else {
            break;
        }
    }
    &t[cut..]
}

/// The task's content in Todoist: the title without the label tags that
/// were added to it here (`old`: how it came in).
pub fn content_of(title: &str, old: Option<&str>) -> String {
    let t = title.trim();
    let suffix = old.map(label_suffix).unwrap_or("").trim();
    if !suffix.is_empty() {
        if let Some(rest) = t.strip_suffix(suffix) {
            if !rest.trim().is_empty() {
                return rest.trim_end().to_string();
            }
        }
    }
    t.to_string()
}

/// Paragraphs TodoCity adds to notes when reading Todoist.
const ADDED: [&str; 3] = [
    "Todoist date:",
    "Repeated in Todoist (",
    "Comments from Todoist:",
];

/// The description in Todoist: the notes without what TodoCity added when
/// reading it, plus the link line.
pub fn description_of(notes: Option<&str>, uid: Option<&str>) -> String {
    let mut parts: Vec<String> = notes
        .unwrap_or("")
        .split("\n\n")
        .map(str::trim)
        .filter(|p| !p.is_empty() && !ADDED.iter().any(|a| p.starts_with(a)))
        .map(str::to_string)
        .collect();
    if let Some(uid) = uid {
        parts.push(link_line(uid));
    }
    parts.join("\n\n")
}

/// A repeat Todoist had that TodoCity couldn't map, from the note about it.
fn unmapped_repeat(notes: Option<&str>) -> Option<String> {
    let notes = notes?;
    let start =
        notes.find("Repeated in Todoist (\u{201c}")? + "Repeated in Todoist (\u{201c}".len();
    let len = notes[start..].find('\u{201d}')?;
    Some(notes[start..start + len].trim().to_string()).filter(|s| !s.is_empty())
}

/// A TodoCity repeat in words Todoist understands.
pub fn repeat_words(rule: &str) -> Option<&'static str> {
    Some(match rule {
        "daily" => "every day",
        "weekdays" => "every workday",
        "weekly" => "every week",
        "biweekly" => "every 2 weeks",
        "monthly" => "every month",
        "yearly" => "every year",
        _ => return None,
    })
}

/// Todoist's due for `want` (`old`: how it was there).
pub fn due_of(want: &Base, old: Option<&Base>) -> Value {
    let Some(day) = want.due_date.as_deref() else {
        return Value::Null;
    };
    let words = match &want.recurrence {
        Some(r) => repeat_words(r).map(str::to_string),
        // A repeat Todoist has that TodoCity shows as a note: keep it.
        None => old
            .filter(|o| o.recurrence.is_none())
            .and_then(|o| unmapped_repeat(o.notes.as_deref())),
    };
    match words {
        Some(words) => {
            let date = NaiveDate::parse_from_str(day, "%Y-%m-%d")
                .map(|d| d.format("%b %-d %Y").to_string())
                .unwrap_or_else(|_| day.to_string());
            let at = want
                .due_time
                .as_deref()
                .map(|t| format!(" at {t}"))
                .unwrap_or_default();
            json!({ "string": format!("{words} starting {date}{at}"), "lang": "en" })
        }
        None => match &want.due_time {
            Some(t) => json!({ "date": format!("{day}T{t}:00") }),
            None => json!({ "date": day }),
        },
    }
}

/// TodoCity's P1–P3 (0 for none) as Todoist's 4–1.
pub fn priority_of(p: u8) -> u8 {
    match p {
        1 => 4,
        2 => 3,
        3 => 2,
        _ => 1,
    }
}

/// A uuid made from `seed`: the same command gets the same one.
fn uuid_of(seed: &str) -> String {
    use sha2::{Digest, Sha256};
    let h = Sha256::digest(seed.as_bytes());
    let x: String = h[..16].iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-4{}-a{}-{}",
        &x[0..8],
        &x[8..12],
        &x[13..16],
        &x[17..20],
        &x[20..32]
    )
}

/// One command, before its uuid.
#[derive(Debug, Clone, PartialEq)]
pub struct Command {
    pub kind: &'static str,
    pub temp_id: Option<String>,
    pub args: Value,
}

/// Where tasks go in Todoist: project ids and sections by name.
pub struct Places {
    pub inbox: Option<String>,
    sections: HashMap<(String, String), String>,
}

impl Places {
    pub fn new(lib: &Library) -> Self {
        let inbox = lib
            .projects
            .iter()
            .find(|p| p.inbox_project && !p.is_deleted)
            .map(|p| p.id.clone());
        let sections = lib
            .sections
            .iter()
            .filter(|s| !s.is_deleted)
            .map(|s| {
                let name = s.name.split_whitespace().collect::<Vec<_>>().join(" ");
                ((s.project_id.clone(), name.to_lowercase()), s.id.clone())
            })
            .collect();
        Self { inbox, sections }
    }

    fn project(&self, building: &str) -> Option<String> {
        if building == LOOSE_KEY {
            self.inbox.clone()
        } else {
            Some(building.to_string())
        }
    }

    /// The section's id, adding a command to make it when it's new.
    fn section(
        &mut self,
        project: &str,
        name: &str,
        out: &mut Vec<Command>,
        n: &mut usize,
    ) -> String {
        let key = (project.to_string(), name.to_lowercase());
        if let Some(id) = self.sections.get(&key) {
            return id.clone();
        }
        *n += 1;
        let temp = format!("section-{n}-{}", uuid_of(&format!("{project}\u{1f}{name}")));
        out.push(Command {
            kind: "section_add",
            temp_id: Some(temp.clone()),
            args: json!({ "name": name, "project_id": project }),
        });
        self.sections.insert(key, temp.clone());
        temp
    }

    /// Turn real ids in for temporary ones after a request.
    fn settle(&mut self, mapping: &HashMap<String, String>) {
        for id in self.sections.values_mut() {
            if let Some(real) = mapping.get(id) {
                *id = real.clone();
            }
        }
    }
}

/// The commands that carry out `op`. `n` numbers new things in a request.
pub fn commands(op: &Op, places: &mut Places, n: &mut usize) -> Result<Vec<Command>, String> {
    let mut out = Vec::new();
    match op {
        Op::Create { uid, want, .. } => {
            let project = places
                .project(&want.building)
                .ok_or("Todoist's Inbox couldn't be found")?;
            let mut args = Map::new();
            args.insert("content".into(), json!(content_of(&want.title, None)));
            args.insert(
                "description".into(),
                json!(description_of(want.notes.as_deref(), Some(uid))),
            );
            args.insert("project_id".into(), json!(project));
            if let Some(floor) = &want.floor {
                let s = places.section(&project, floor, &mut out, n);
                args.insert("section_id".into(), json!(s));
            }
            args.insert("priority".into(), json!(priority_of(want.priority)));
            if want.due_date.is_some() {
                args.insert("due".into(), due_of(want, None));
            }
            if let Some(d) = &want.deadline {
                args.insert("deadline".into(), json!({ "date": d }));
            }
            *n += 1;
            out.push(Command {
                kind: "item_add",
                temp_id: Some(format!("task-{n}-{uid}")),
                args: Value::Object(args),
            });
        }
        Op::Update {
            ext_id,
            uid,
            old,
            want,
            ..
        } => {
            let mut args = Map::new();
            if want.title != old.title {
                args.insert(
                    "content".into(),
                    json!(content_of(&want.title, Some(&old.title))),
                );
            }
            if want.notes != old.notes {
                args.insert(
                    "description".into(),
                    json!(description_of(want.notes.as_deref(), uid.as_deref())),
                );
            }
            if want.priority != old.priority {
                args.insert("priority".into(), json!(priority_of(want.priority)));
            }
            let due_changed = want.due_date != old.due_date
                || want.due_time != old.due_time
                || want.recurrence != old.recurrence;
            // Finishing a repeat moves its date there; don't set it too.
            let finishing = want.done && !old.done;
            if due_changed && !finishing {
                args.insert("due".into(), due_of(want, Some(old)));
            }
            if want.deadline != old.deadline {
                args.insert(
                    "deadline".into(),
                    match &want.deadline {
                        Some(d) => json!({ "date": d }),
                        None => Value::Null,
                    },
                );
            }
            if !args.is_empty() {
                args.insert("id".into(), json!(ext_id));
                out.push(Command {
                    kind: "item_update",
                    temp_id: None,
                    args: Value::Object(args),
                });
            }
            if want.building != old.building || want.floor != old.floor {
                let project = places
                    .project(&want.building)
                    .ok_or("Todoist's Inbox couldn't be found")?;
                let args = match &want.floor {
                    Some(floor) => {
                        let s = places.section(&project, floor, &mut out, n);
                        json!({ "id": ext_id, "section_id": s })
                    }
                    None => json!({ "id": ext_id, "project_id": project }),
                };
                out.push(Command {
                    kind: "item_move",
                    temp_id: None,
                    args,
                });
            }
            if want.done != old.done {
                out.push(Command {
                    kind: if want.done {
                        "item_close"
                    } else {
                        "item_uncomplete"
                    },
                    temp_id: None,
                    args: json!({ "id": ext_id }),
                });
            }
        }
        Op::Delete { ext_id, .. } => out.push(Command {
            kind: "item_delete",
            temp_id: None,
            args: json!({ "id": ext_id }),
        }),
    }
    Ok(out)
}

// ── Making a project there ("Sync with Todoist") ───────────────────────────

/// Names compared loosely: case and spacing don't matter.
fn same_name(a: &str, b: &str) -> bool {
    let norm = |s: &str| {
        s.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase()
    };
    norm(a) == norm(b)
}

/// An open, top-level Todoist project named `name` that doesn't sync with
/// another project here yet (`taken`: keys that do).
pub fn same_name_project<'a>(
    lib: &'a Library,
    name: &str,
    taken: &std::collections::HashSet<String>,
) -> Option<&'a crate::todoist::Project> {
    lib.projects.iter().find(|p| {
        !p.inbox_project
            && !p.is_deleted
            && !p.is_archived
            && p.parent_id.is_none()
            && !taken.contains(&p.id)
            && same_name(&p.name, name)
    })
}

/// The sections `project` (a Todoist project id, or `None` for a new one)
/// still needs for `floors`.
pub fn missing_sections(lib: &Library, project: Option<&str>, floors: &[String]) -> Vec<String> {
    let have: Vec<&str> = match project {
        None => Vec::new(),
        Some(id) => lib
            .sections
            .iter()
            .filter(|s| !s.is_deleted && s.project_id == id)
            .map(|s| s.name.as_str())
            .collect(),
    };
    let mut out: Vec<String> = Vec::new();
    for f in floors {
        let f = f.trim();
        if f.is_empty()
            || have.iter().any(|h| same_name(h, f))
            || out.iter().any(|o| same_name(o, f))
        {
            continue;
        }
        out.push(f.to_string());
    }
    out
}

/// The temporary id of the project a [`project_commands`] request makes.
const NEW_PROJECT: &str = "project-new";

/// Commands that make project `name` (when `into` is `None`) and its
/// `sections`, or add `sections` to the existing project `into`.
pub fn project_commands(name: &str, into: Option<&str>, sections: &[String]) -> Vec<Command> {
    let mut out = Vec::new();
    let project = match into {
        Some(id) => id.to_string(),
        None => {
            out.push(Command {
                kind: "project_add",
                temp_id: Some(NEW_PROJECT.into()),
                args: json!({ "name": name.trim() }),
            });
            NEW_PROJECT.to_string()
        }
    };
    for (i, s) in sections.iter().enumerate() {
        out.push(Command {
            kind: "section_add",
            temp_id: Some(format!("section-new-{i}")),
            args: json!({ "name": s, "project_id": project, "section_order": i + 1 }),
        });
    }
    out
}

/// Make project `name` there, with `sections`, or add `sections` to the
/// existing project `into`. Returns the new project's id; `None` when
/// Todoist took the request without saying (it had just made the same one,
/// for another Mac): look it up by name.
///
/// The ids come from the name and the hour, so two Macs asking at nearly
/// the same moment make one project.
pub async fn make_project(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    name: &str,
    into: Option<&str>,
    sections: &[String],
) -> Result<Option<String>, String> {
    let cmds = project_commands(name, into, sections);
    if cmds.is_empty() {
        return Ok(into.map(str::to_string));
    }
    let hour = chrono::Utc::now().format("%Y-%m-%dT%H");
    let seed = format!(
        "project\u{1f}{}\u{1f}{}\u{1f}{hour}",
        name.split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .to_lowercase(),
        into.unwrap_or("")
    );
    let wired: Vec<Value> = cmds.iter().map(|c| wire(c, &seed)).collect();
    let auth = format!("Bearer {}", token.trim());
    let answer = send(client, base, &auth, &wired).await?;
    let statuses = answer.get("sync_status");
    // The project itself must be there; a section that didn't take is
    // made again with the first task that goes in it.
    if into.is_none() {
        let uuid = wired[0]["uuid"].as_str().unwrap_or_default();
        if let Err((_, msg)) = status(statuses.and_then(|s| s.get(uuid))) {
            return Err(msg);
        }
        let id = answer
            .get("temp_id_mapping")
            .and_then(|m| m.get(NEW_PROJECT))
            .and_then(|v| match v {
                Value::String(s) => Some(s.clone()),
                Value::Number(n) => Some(n.to_string()),
                _ => None,
            });
        return Ok(id);
    }
    Ok(into.map(str::to_string))
}

/// A command as Todoist takes it, with a uuid made from what it does.
fn wire(c: &Command, seed: &str) -> Value {
    let mut v = json!({
        "type": c.kind,
        "uuid": uuid_of(&format!("{seed}\u{1f}{}\u{1f}{}", c.kind, c.args)),
        "args": c.args,
    });
    if let Some(t) = &c.temp_id {
        v["temp_id"] = json!(t);
    }
    v
}

/// How one command went, from Todoist's `sync_status`.
fn status(v: Option<&Value>) -> Result<(), (bool, String)> {
    match v {
        Some(Value::String(s)) if s == "ok" => Ok(()),
        Some(v) => {
            let msg = v
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("Todoist didn't accept a change")
                .to_string();
            let gone = v.get("http_code").and_then(Value::as_u64) == Some(404)
                || msg.to_lowercase().contains("not found");
            Err((gone, msg))
        }
        None => Err((false, "Todoist didn't answer for a change".into())),
    }
}

/// Carry `ops` out in Todoist. One result per op, in order.
pub async fn push(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    lib: &Library,
    ops: &[Op],
) -> Vec<Sent> {
    let auth = format!("Bearer {}", token.trim());
    let mut places = Places::new(lib);
    let mut results: Vec<Sent> = Vec::with_capacity(ops.len());
    let mut i = 0;
    while i < ops.len() {
        // A batch of whole ops.
        let mut batch: Vec<(usize, Vec<Command>)> = Vec::new();
        let mut count = 0;
        let mut n = 0;
        let mut early: Vec<(usize, Sent)> = Vec::new();
        while i < ops.len() {
            let before = places.sections.clone();
            match commands(&ops[i], &mut places, &mut n) {
                Ok(cs) if count > 0 && count + cs.len() > BATCH => {
                    // It goes in the next batch, with any section it needs.
                    places.sections = before;
                    break;
                }
                Ok(cs) => {
                    count += cs.len();
                    batch.push((i, cs));
                }
                Err(e) => early.push((i, Sent::Failed(e))),
            }
            i += 1;
        }
        let mut wired = Vec::new();
        for (idx, cs) in &batch {
            let seed = serde_json::to_string(&ops[*idx]).unwrap_or_default();
            for c in cs {
                wired.push(wire(c, &seed));
            }
        }
        let answer = if wired.is_empty() {
            Ok(Value::Null)
        } else {
            send(client, base, &auth, &wired).await
        };
        let mut sent: HashMap<usize, Sent> = early.into_iter().collect();
        match answer {
            Err(e) => {
                for (idx, _) in &batch {
                    sent.insert(*idx, Sent::Failed(e.clone()));
                }
            }
            Ok(v) => {
                let statuses = v.get("sync_status");
                let mapping: HashMap<String, String> = v
                    .get("temp_id_mapping")
                    .and_then(Value::as_object)
                    .map(|m| {
                        m.iter()
                            .filter_map(|(k, v)| {
                                let id = match v {
                                    Value::String(s) => s.clone(),
                                    Value::Number(n) => n.to_string(),
                                    _ => return None,
                                };
                                Some((k.clone(), id))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                places.settle(&mapping);
                let mut w = 0;
                for (idx, cs) in &batch {
                    let mut outcome = Sent::Ok(None);
                    for c in cs {
                        let uuid = wired[w]["uuid"].as_str().unwrap_or_default().to_string();
                        w += 1;
                        match status(statuses.and_then(|s| s.get(&uuid))) {
                            Ok(()) => {
                                if c.kind == "item_add" {
                                    let new = c.temp_id.as_ref().and_then(|t| mapping.get(t));
                                    outcome = Sent::Ok(new.cloned());
                                }
                            }
                            Err((true, _)) if !matches!(outcome, Sent::Failed(_)) => {
                                outcome = Sent::Gone
                            }
                            Err((_, msg)) => outcome = Sent::Failed(msg),
                        }
                    }
                    // An add must say where it went.
                    if matches!(ops[*idx], Op::Create { .. }) && outcome == Sent::Ok(None) {
                        outcome = Sent::Failed("Todoist didn't say where the new task went".into());
                    }
                    sent.insert(*idx, outcome);
                }
            }
        }
        let start = results.len();
        for idx in start..i {
            results.push(
                sent.remove(&idx)
                    .unwrap_or_else(|| Sent::Failed("Not sent".into())),
            );
        }
    }
    results
}

async fn send(
    client: &reqwest::Client,
    base: &str,
    auth: &str,
    commands: &[Value],
) -> Result<Value, String> {
    let res = client
        .post(format!("{base}/api/v1/sync"))
        .header("Authorization", auth)
        .form(&[("commands", Value::Array(commands.to_vec()).to_string())])
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Todoist: {e}"))?;
    match res.status().as_u16() {
        200..=299 => {}
        401 | 403 => return Err(
            "Todoist no longer accepts the saved token. Connect it again in Settings → Connectors."
                .into(),
        ),
        429 => return Err("Todoist is busy right now; changes go out on the next try.".into()),
        s => {
            return Err(format!(
                "Todoist answered with an error ({s}); changes go out on the next try."
            ))
        }
    }
    res.json::<Value>()
        .await
        .map_err(|e| format!("Todoist sent something unexpected: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::todoist::{Project, Section};

    fn base(title: &str) -> Base {
        Base {
            title: title.into(),
            building: "p1".into(),
            ..Default::default()
        }
    }

    fn lib() -> Library {
        Library {
            projects: vec![
                Project {
                    id: "inbox".into(),
                    name: "Inbox".into(),
                    inbox_project: true,
                    ..Default::default()
                },
                Project {
                    id: "p1".into(),
                    name: "Garden".into(),
                    ..Default::default()
                },
            ],
            sections: vec![Section {
                id: "s1".into(),
                project_id: "p1".into(),
                name: "Spring".into(),
                ..Default::default()
            }],
            ..Default::default()
        }
    }

    #[test]
    fn label_tags_stay_labels() {
        assert_eq!(
            content_of("Plant tulips #garden", Some("Plant tulips #garden")),
            "Plant tulips"
        );
        assert_eq!(
            content_of(
                "Plant 40 tulips #garden #spring",
                Some("Plant tulips #garden #spring")
            ),
            "Plant 40 tulips"
        );
        assert_eq!(
            content_of("Plant tulips #new", Some("Plant tulips")),
            "Plant tulips #new"
        );
        assert_eq!(content_of("#garden", Some("#garden")), "#garden");
    }

    #[test]
    fn notes_lose_what_was_added_and_gain_the_link() {
        let uid = "0123456789abcdef0123456789abcdef";
        let notes =
            "Bring gloves\n\nComments from Todoist:\n– from Maya\n\nTodoist date: someday soon";
        assert_eq!(
            description_of(Some(notes), Some(uid)),
            format!("Bring gloves\n\ntodocity://task/{uid}")
        );
        assert_eq!(description_of(None, None), "");
    }

    #[test]
    fn days_times_and_repeats() {
        let mut w = base("Water");
        w.due_date = Some("2026-11-03".into());
        assert_eq!(due_of(&w, None), json!({ "date": "2026-11-03" }));
        w.due_time = Some("09:30".into());
        assert_eq!(due_of(&w, None), json!({ "date": "2026-11-03T09:30:00" }));
        w.recurrence = Some("weekly".into());
        assert_eq!(
            due_of(&w, None),
            json!({ "string": "every week starting Nov 3 2026 at 09:30", "lang": "en" })
        );
        // A repeat TodoCity shows only as a note is kept when the day moves.
        let mut old = base("Water");
        old.notes = Some("Repeated in Todoist (\u{201c}every 3rd friday\u{201d}) — set a repeat here if you still need it.".into());
        let mut w = old.clone();
        w.due_date = Some("2026-11-20".into());
        assert_eq!(
            due_of(&w, Some(&old)),
            json!({ "string": "every 3rd friday starting Nov 20 2026", "lang": "en" })
        );
        w.due_date = None;
        assert_eq!(due_of(&w, Some(&old)), Value::Null);
    }

    #[test]
    fn an_update_sends_only_what_changed() {
        let lib = lib();
        let mut places = Places::new(&lib);
        let old = base("Plant tulips #garden");
        let mut want = old.clone();
        want.priority = 1;
        want.floor = Some("Spring".into());
        let op = Op::Update {
            task_id: 1,
            ext_id: "t1".into(),
            uid: None,
            old,
            want,
            next: None,
        };
        let cs = commands(&op, &mut places, &mut 0).unwrap();
        assert_eq!(cs.len(), 2);
        assert_eq!(cs[0].kind, "item_update");
        assert_eq!(cs[0].args, json!({ "id": "t1", "priority": 4 }));
        assert_eq!(cs[1].args, json!({ "id": "t1", "section_id": "s1" }));
    }

    #[test]
    fn finishing_a_repeat_closes_it_without_moving_its_date() {
        let lib = lib();
        let mut places = Places::new(&lib);
        let mut old = base("Water");
        old.due_date = Some("2026-11-03".into());
        old.recurrence = Some("weekly".into());
        let mut want = old.clone();
        want.done = true;
        want.due_date = Some("2026-11-04".into());
        let op = Op::Update {
            task_id: 1,
            ext_id: "t1".into(),
            uid: None,
            old,
            want,
            next: Some(2),
        };
        let cs = commands(&op, &mut places, &mut 0).unwrap();
        assert_eq!(cs.len(), 1);
        assert_eq!(cs[0].kind, "item_close");
    }

    #[test]
    fn a_new_task_goes_to_its_project_and_a_new_section() {
        let lib = lib();
        let mut places = Places::new(&lib);
        let mut want = base("Rake leaves");
        want.floor = Some("Autumn".into());
        let op = Op::Create {
            task_id: 1,
            uid: "0123456789abcdef0123456789abcdef".into(),
            want: want.clone(),
        };
        let mut n = 0;
        let cs = commands(&op, &mut places, &mut n).unwrap();
        assert_eq!(cs[0].kind, "section_add");
        assert_eq!(cs[1].kind, "item_add");
        assert_eq!(cs[1].args["project_id"], "p1");
        assert_eq!(
            cs[1].args["section_id"],
            json!(cs[0].temp_id.clone().unwrap())
        );
        // A second one in the same new section doesn't make it again.
        let cs = commands(&op, &mut places, &mut n).unwrap();
        assert_eq!(cs.len(), 1);
        // The Inbox.
        want.building = LOOSE_KEY.into();
        want.floor = None;
        let op = Op::Create {
            task_id: 2,
            uid: "1123456789abcdef0123456789abcdef".into(),
            want,
        };
        let cs = commands(&op, &mut places, &mut n).unwrap();
        assert_eq!(cs[0].args["project_id"], "inbox");
    }

    #[test]
    fn the_same_command_gets_the_same_uuid() {
        let c = Command {
            kind: "item_close",
            temp_id: None,
            args: json!({ "id": "t1" }),
        };
        assert_eq!(wire(&c, "x")["uuid"], wire(&c, "x")["uuid"]);
        assert_ne!(wire(&c, "x")["uuid"], wire(&c, "y")["uuid"]);
        assert_eq!(wire(&c, "x")["uuid"].as_str().unwrap().len(), 36);
    }

    #[test]
    fn a_project_is_found_by_its_name_once() {
        let mut l = lib();
        l.projects.push(Project {
            id: "300".into(),
            name: "garden  Reno".into(),
            ..Default::default()
        });
        l.projects.push(Project {
            id: "301".into(),
            name: "Garden reno".into(),
            is_archived: true,
            ..Default::default()
        });
        let none = std::collections::HashSet::new();
        assert_eq!(
            same_name_project(&l, "Garden reno", &none).map(|p| p.id.as_str()),
            Some("300")
        );
        let taken: std::collections::HashSet<String> = ["300".to_string()].into();
        assert!(same_name_project(&l, "Garden reno", &taken).is_none());
        assert!(same_name_project(&l, "Inbox", &none).is_none());
    }

    #[test]
    fn a_new_project_comes_with_its_sections() {
        let l = lib();
        let floors = vec!["Beds".to_string(), "beds".to_string(), "Tools".to_string()];
        let need = missing_sections(&l, None, &floors);
        assert_eq!(need, ["Beds", "Tools"]);
        let cmds = project_commands("Garden reno", None, &need);
        assert_eq!(cmds.len(), 3);
        assert_eq!(cmds[0].kind, "project_add");
        assert_eq!(cmds[0].args["name"], "Garden reno");
        assert_eq!(cmds[1].kind, "section_add");
        assert_eq!(cmds[1].args["project_id"], NEW_PROJECT);
        assert_eq!(cmds[2].args["name"], "Tools");
    }

    #[test]
    fn an_existing_project_gets_only_the_sections_it_lacks() {
        let l = lib();
        let s = l.sections.iter().find(|s| !s.is_deleted).unwrap();
        let floors = vec![s.name.to_uppercase(), "Paint".to_string()];
        let need = missing_sections(&l, Some(&s.project_id), &floors);
        assert_eq!(need, ["Paint"]);
        let cmds = project_commands("x", Some(&s.project_id), &need);
        assert_eq!(cmds.len(), 1);
        assert_eq!(cmds[0].args["project_id"], s.project_id.as_str());
    }

    #[test]
    fn statuses() {
        assert!(status(Some(&json!("ok"))).is_ok());
        assert_eq!(
            status(Some(
                &json!({ "error": "Item not found", "error_code": 22, "http_code": 404 })
            )),
            Err((true, "Item not found".into()))
        );
        assert!(matches!(status(None), Err((false, _))));
    }
}
