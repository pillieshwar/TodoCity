//! The tools AI agents get over MCP when the user turns on full access
//! (Settings → AI agents): read, add, change, finish and delete tasks,
//! sub-tasks, reminders, projects and sections, at a fine-grained level.
//!
//! Everything here is pure: it takes the store, the arguments an agent sent
//! and the local time, and returns JSON for the agent (or a message saying
//! what to fix). The app decides whether full access is on, and refreshes
//! its windows afterwards.

use chrono::{Duration, NaiveDate, NaiveDateTime};
use serde_json::{json, Map, Value};

use crate::recurrence::Repeat;
use crate::store::{ChecklistItem, NewTask, Store, StoreError, Task, TaskPatch};

/// Most tasks one call returns.
const MAX_LIMIT: usize = 500;
const DEFAULT_LIMIT: usize = 100;
/// Most tasks one batch call touches.
const MAX_BATCH: usize = 200;

type Args = Map<String, Value>;

/// A meeting from the person's calendars (busy time).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Busy {
    pub title: String,
    pub start: NaiveDateTime,
    pub end: NaiveDateTime,
}

/// What a call knows besides the store: who's calling, and the person's
/// meetings (from the Mac's calendars, when they share them).
pub struct Ctx<'a> {
    pub agent: &'a str,
    pub busy: &'a dyn Fn(NaiveDate, NaiveDate) -> Vec<Busy>,
}

fn no_meetings(_: NaiveDate, _: NaiveDate) -> Vec<Busy> {
    Vec::new()
}

impl Ctx<'static> {
    /// No agent name and no calendar (tests).
    pub fn none() -> Self {
        Ctx {
            agent: "agent",
            busy: &no_meetings,
        }
    }
}

// ── Definitions ────────────────────────────────────────────────────────────

fn s(desc: &str) -> Value {
    json!({ "type": "string", "description": desc })
}
fn s_or_null(desc: &str) -> Value {
    json!({ "type": ["string", "null"], "description": desc })
}
fn int(desc: &str) -> Value {
    json!({ "type": "integer", "description": desc })
}
fn int_or_null(desc: &str) -> Value {
    json!({ "type": ["integer", "null"], "description": desc })
}
fn boolean(desc: &str) -> Value {
    json!({ "type": "boolean", "description": desc })
}
fn id_prop() -> Value {
    int("The task's id, from list_tasks or get_task.")
}

const DATE: &str = "YYYY-MM-DD, the user's local date.";
const TIME: &str = "24-hour HH:MM local time, any minute (e.g. 09:07). Needs a date.";
const DURATION: &str = "How long it takes, in minutes (1–1440), e.g. 7, 30, 90.";
const REPEAT: &str = "daily, weekdays, weekly, biweekly, monthly or yearly; or a custom rule like rrule:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE (also BYDAY=2TU or BYMONTHDAY=-1 for months, FROM=DONE to count from when it's finished, UNTIL=YYYYMMDD, COUNT=n). A task's deadline always ends the series.";
const PRIORITY: &str = "0 none, 1 urgent (P1), 2 high (P2), 3 medium (P3).";

fn tool(
    name: &str,
    title: &str,
    description: &str,
    props: Value,
    required: &[&str],
    kind: Kind,
) -> Value {
    let (read_only, destructive, idempotent) = match kind {
        Kind::Read => (true, false, true),
        Kind::Write => (false, false, false),
        Kind::Set => (false, false, true),
        Kind::Delete => (false, true, true),
    };
    json!({
        "name": name,
        "title": title,
        "description": description,
        "inputSchema": {
            "type": "object",
            "properties": props,
            "required": required,
            "additionalProperties": false
        },
        "annotations": {
            "title": title,
            "readOnlyHint": read_only,
            "destructiveHint": destructive,
            "idempotentHint": idempotent,
            "openWorldHint": false
        }
    })
}

#[derive(Clone, Copy)]
enum Kind {
    Read,
    Write,
    Set,
    Delete,
}

/// Task fields an agent can set when adding or changing a task.
fn task_props(for_update: bool) -> Map<String, Value> {
    let mut p = Map::new();
    let clear = if for_update { " null clears it." } else { "" };
    let opt = |d: String| if for_update { s_or_null(&d) } else { s(&d) };
    p.insert(
        "title".into(),
        s("What to do, short and actionable. #tags in the title become tags."),
    );
    p.insert(
        "notes".into(),
        opt(format!(
            "Details, links, context (up to 2000 characters).{clear}"
        )),
    );
    p.insert(
        "due_date".into(),
        opt(format!("The day it's planned for, {DATE}{clear}")),
    );
    p.insert("due_time".into(), opt(format!("{TIME}{clear}")));
    p.insert(
        "duration".into(),
        if for_update {
            int_or_null(&format!("{DURATION}{clear}"))
        } else {
            int(DURATION)
        },
    );
    p.insert(
        "deadline".into(),
        opt(format!(
            "A hard deadline, separate from its day, {DATE}{clear}"
        )),
    );
    p.insert(
        "project".into(),
        opt(format!("Project name (created if new).{clear}")),
    );
    p.insert(
        "section".into(),
        opt(format!(
            "Section within the project (created if new).{clear}"
        )),
    );
    p.insert("priority".into(), int(PRIORITY));
    p.insert("repeat".into(), opt(format!("{REPEAT}{clear}")));
    p.insert(
        "evening".into(),
        boolean("Planned for the evening of its day."),
    );
    p.insert(
        "someday".into(),
        boolean("Parked for some day: no date, out of the way."),
    );
    if !for_update {
        p.insert(
            "subtasks".into(),
            json!({ "type": "array", "items": { "type": "string" }, "description": "Steps within the task, in order." }),
        );
    }
    p
}

/// Every tool, for `tools/list`.
pub fn tools() -> Vec<Value> {
    let mut update = task_props(true);
    update.insert("id".into(), id_prop());
    update.insert(
        "only_this".into(),
        boolean("For a repeating task's date: move just this one (the series keeps its days)."),
    );
    vec![
        tool(
            "get_overview",
            "Overview of the user's tasks",
            "Counts for Today, Overdue, Inbox and the next 7 days, plus the projects. A good first call.",
            json!({}),
            &[],
            Kind::Read,
        ),
        tool(
            "list_tasks",
            "List tasks",
            "Tasks matching filters, newest planning first. Lists: today (due today or earlier, still open), overdue, upcoming (next 7 days, or from/to), inbox (no project), someday, no_date, completed, all.",
            json!({
                "list": { "type": "string", "enum": ["today", "overdue", "upcoming", "inbox", "someday", "no_date", "completed", "all"], "description": "Which list (default: all open tasks)." },
                "project": s("Only this project."),
                "section": s("Only this section (with project; empty string for General: no section)."),
                "tag": s("Only tasks with this #tag."),
                "query": s("Words that must all appear in the title or notes."),
                "priority": int(PRIORITY),
                "from": s(&format!("Due on or after, {DATE}")),
                "to": s(&format!("Due on or before, {DATE}")),
                "include_done": boolean("Include finished tasks (default false, except for completed)."),
                "limit": int("At most this many (default 100, max 500)."),
                "offset": int("Skip this many, to page through.")
            }),
            &[],
            Kind::Read,
        ),
        tool("get_task", "Get one task", "Everything about one task: notes, sub-tasks, schedule, length, repeat, reminder, project and section.", json!({ "id": id_prop() }), &["id"], Kind::Read),
        tool(
            "get_schedule",
            "Get the schedule",
            "Day by day: meetings from the person's calendars, timed tasks in order with their start, end and length, then the day's untimed tasks. Defaults to the next 7 days.",
            json!({ "from": s(&format!("First day, {DATE}")), "to": s(&format!("Last day, {DATE}")) }),
            &[],
            Kind::Read,
        ),
        tool(
            "find_free_time",
            "Find free time",
            "Free stretches between meetings and timed tasks, day by day, within working hours. Use it before scheduling. Defaults to today, 08:00–18:00, stretches of 15 minutes or more.",
            json!({
                "from": s(&format!("First day, {DATE}")),
                "to": s(&format!("Last day, {DATE}")),
                "day_start": s("Start of the working day, HH:MM (default 08:00)."),
                "day_end": s("End of the working day, HH:MM (default 18:00)."),
                "min_minutes": int("Shortest stretch worth listing (default 15).")
            }),
            &[],
            Kind::Read,
        ),
        tool(
            "schedule_tasks",
            "Schedule several tasks",
            "Plan several tasks at once (a day plan): each gets a day, a start time and a length. All or nothing: if one is wrong, none change. It's one change the person can undo in one click.",
            json!({
                "items": {
                    "type": "array",
                    "description": "The tasks to schedule.",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": id_prop(),
                            "date": s(DATE),
                            "time": s(TIME),
                            "duration": int(DURATION)
                        },
                        "required": ["id", "date"],
                        "additionalProperties": false
                    }
                }
            }),
            &["items"],
            Kind::Set,
        ),
        tool(
            "list_reminders",
            "List upcoming reminders",
            "Tasks that will remind the user, in order: timed tasks and snoozed ones, with when each fires. Defaults to the next 7 days.",
            json!({ "from": s(&format!("From, {DATE}")), "to": s(&format!("To, {DATE}")) }),
            &[],
            Kind::Read,
        ),
        tool("list_projects", "List projects", "Every project with its color, open and done counts, and its sections.", json!({}), &[], Kind::Read),
        tool("list_sections", "List sections", "The sections of one project, with open and done counts.", json!({ "project": s("Project name.") }), &["project"], Kind::Read),
        tool("list_tags", "List tags", "Every #tag used on open tasks, most used first, with counts.", json!({}), &[], Kind::Read),
        tool(
            "add_task",
            "Add a task",
            "Add a task straight to the user's list (no review). Set any fields; only title is needed.",
            Value::Object(task_props(false)),
            &["title"],
            Kind::Write,
        ),
        tool(
            "update_task",
            "Change a task",
            "Change any fields of a task; leave out what stays the same, send null to clear. Changing the date of a repeating task moves the series unless only_this is true.",
            Value::Object(update),
            &["id"],
            Kind::Set,
        ),
        tool(
            "schedule_task",
            "Schedule a task",
            "Set when a task happens: its day, start time (any minute) and length. null clears the date (and time).",
            json!({
                "id": id_prop(),
                "date": s_or_null(&format!("{DATE} null: no date.")),
                "time": s_or_null(&format!("{TIME} null: no time.")),
                "duration": int_or_null(&format!("{DURATION} null: no set length.")),
                "only_this": boolean("Repeating task: move just this one.")
            }),
            &["id"],
            Kind::Set,
        ),
        tool("complete_task", "Complete a task", "Mark a task done. A repeating task makes its next one.", json!({ "id": id_prop() }), &["id"], Kind::Set),
        tool("reopen_task", "Reopen a task", "Mark a finished task not done (a repeat's next one is removed if untouched).", json!({ "id": id_prop() }), &["id"], Kind::Set),
        tool(
            "complete_tasks",
            "Complete several tasks",
            "Mark several tasks done at once.",
            json!({ "ids": { "type": "array", "items": { "type": "integer" }, "description": "Task ids." } }),
            &["ids"],
            Kind::Set,
        ),
        tool("delete_task", "Delete a task", "Delete a task for good (it's in the daily backups).", json!({ "id": id_prop() }), &["id"], Kind::Delete),
        tool(
            "move_task",
            "Move a task",
            "Put a task in a project and section (created if new), or take it out of its project with project null.",
            json!({ "id": id_prop(), "project": s_or_null("Project name, or null for none."), "section": s_or_null("Section, or null for General.") }),
            &["id", "project"],
            Kind::Set,
        ),
        tool(
            "snooze_task",
            "Snooze a reminder",
            "Remind the user about a task again later: at a local time, or in some minutes. until null cancels the snooze.",
            json!({
                "id": id_prop(),
                "until": s_or_null("Local YYYY-MM-DDTHH:MM, or null to cancel."),
                "minutes": int("Or: this many minutes from now.")
            }),
            &["id"],
            Kind::Set,
        ),
        tool(
            "set_repeat",
            "Set how a task repeats",
            "Make a task repeat, change its repeat, or stop it (null). Pausing keeps the repeat but stops reminders.",
            json!({ "id": id_prop(), "repeat": s_or_null(&format!("{REPEAT} null: no repeat.")), "paused": boolean("Pause or resume the series.") }),
            &["id"],
            Kind::Set,
        ),
        tool("skip_occurrence", "Skip one repeat", "Move a repeating task to its next day without finishing it.", json!({ "id": id_prop() }), &["id"], Kind::Write),
        tool(
            "add_subtask",
            "Add a sub-task",
            "Add a step to a task's sub-tasks (at the end, or at a position).",
            json!({ "id": id_prop(), "text": s("The step."), "position": int("0-based position (default: the end).") }),
            &["id", "text"],
            Kind::Write,
        ),
        tool(
            "update_subtask",
            "Change a sub-task",
            "Rename a sub-task or tick it off.",
            json!({ "id": id_prop(), "index": int("0-based index, from get_task."), "text": s("New text."), "done": boolean("Done or not.") }),
            &["id", "index"],
            Kind::Set,
        ),
        tool(
            "remove_subtask",
            "Remove a sub-task",
            "Remove one step from a task.",
            json!({ "id": id_prop(), "index": int("0-based index, from get_task.") }),
            &["id", "index"],
            Kind::Delete,
        ),
        tool(
            "create_project",
            "Create a project",
            "Start a new project, optionally with a color and sections.",
            json!({
                "name": s("Project name."),
                "color": s("#rrggbb."),
                "sections": { "type": "array", "items": { "type": "string" }, "description": "Sections to add." }
            }),
            &["name"],
            Kind::Write,
        ),
        tool(
            "update_project",
            "Change a project",
            "Rename a project and/or set its color (null clears the color).",
            json!({ "name": s("Current name."), "new_name": s("New name."), "color": s_or_null("#rrggbb, or null.") }),
            &["name"],
            Kind::Set,
        ),
        tool(
            "delete_project",
            "Delete a project",
            "Delete a project. If it still has tasks, set delete_tasks true to delete them too, or move them first.",
            json!({ "name": s("Project name."), "delete_tasks": boolean("Also delete its tasks.") }),
            &["name"],
            Kind::Delete,
        ),
        tool("create_section", "Create a section", "Add a section to a project.", json!({ "project": s("Project name."), "name": s("Section name.") }), &["project", "name"], Kind::Write),
        tool(
            "rename_section",
            "Rename a section",
            "Rename a section; its tasks go with it.",
            json!({ "project": s("Project name."), "name": s("Current name."), "new_name": s("New name.") }),
            &["project", "name", "new_name"],
            Kind::Set,
        ),
        tool(
            "delete_section",
            "Delete a section",
            "Delete a section. If it has tasks, set tasks to \"general\" to keep them in the project with no section, or \"delete\" to delete them.",
            json!({ "project": s("Project name."), "name": s("Section name."), "tasks": { "type": "string", "enum": ["general", "delete"], "description": "What happens to its tasks." } }),
            &["project", "name"],
            Kind::Delete,
        ),
    ]
}

/// The names of every tool.
pub fn names() -> Vec<String> {
    tools()
        .iter()
        .filter_map(|t| t["name"].as_str().map(String::from))
        .collect()
}

/// Whether a tool only reads.
pub fn is_read_only(name: &str) -> bool {
    tools()
        .iter()
        .find(|t| t["name"] == name)
        .is_some_and(|t| t["annotations"]["readOnlyHint"] == true)
}

// ── Output ─────────────────────────────────────────────────────────────────

/// `#tags` in a title, lowercased, without duplicates.
pub fn tags_of(title: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for word in title.split_whitespace() {
        if let Some(rest) = word.strip_prefix('#') {
            let tag: String = rest
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_' || *c == '-')
                .collect();
            if !tag.is_empty() {
                let t = format!("#{}", tag.to_lowercase());
                if !out.contains(&t) {
                    out.push(t);
                }
            }
        }
    }
    out
}

fn end_time(t: &Task) -> Option<String> {
    let time = t.due_time.as_deref()?;
    let d = t.duration?;
    let (h, m) = time.split_once(':')?;
    let start = h.parse::<u32>().ok()? * 60 + m.parse::<u32>().ok()?;
    let end = (start + d).min(24 * 60 - 1);
    Some(format!("{:02}:{:02}", end / 60, end % 60))
}

/// A task as agents see it.
pub fn task_json(t: &Task) -> Value {
    json!({
        "id": t.id,
        "title": t.title,
        "notes": t.notes,
        "done": t.done,
        "completed_at": t.completed_at,
        "due_date": t.due_date,
        "due_time": t.due_time,
        "duration": t.duration,
        "end_time": end_time(t),
        "deadline": t.deadline,
        "evening": t.evening,
        "someday": t.someday,
        "project": t.project,
        "section": t.heading,
        "priority": t.priority,
        "repeat": t.recurrence,
        "paused": t.paused,
        "snoozed_until": t.snoozed_until,
        "subtasks": t.checklist.iter().enumerate().map(|(i, c)| json!({ "index": i, "text": c.text, "done": c.done })).collect::<Vec<_>>(),
        "tags": tags_of(&t.title),
        "source": { "app": t.source_app, "url": t.source_url },
        "created_at": t.created_at
    })
}

// ── Arguments ──────────────────────────────────────────────────────────────

fn str_arg(a: &Args, key: &str) -> Result<Option<String>, String> {
    match a.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(s)) => Ok(Some(s.trim().to_string())),
        Some(_) => Err(format!("{key} must be a string")),
    }
}

fn need_str(a: &Args, key: &str) -> Result<String, String> {
    str_arg(a, key)?
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("{key} is required"))
}

/// Present: `Some(None)` for null (clear), `Some(Some(v))` for a value.
fn clearable(a: &Args, key: &str) -> Result<Option<Option<String>>, String> {
    match a.get(key) {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(Value::String(s)) if s.trim().is_empty() => Ok(Some(None)),
        Some(Value::String(s)) => Ok(Some(Some(s.trim().to_string()))),
        Some(_) => Err(format!("{key} must be a string or null")),
    }
}

fn int_arg(a: &Args, key: &str) -> Result<Option<i64>, String> {
    match a.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_i64()
            .map(Some)
            .ok_or_else(|| format!("{key} must be a whole number")),
    }
}

fn bool_arg(a: &Args, key: &str) -> Result<Option<bool>, String> {
    match a.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Bool(b)) => Ok(Some(*b)),
        Some(_) => Err(format!("{key} must be true or false")),
    }
}

fn id_arg(a: &Args) -> Result<i64, String> {
    int_arg(a, "id")?.ok_or_else(|| "id is required".to_string())
}

fn date_arg(a: &Args, key: &str) -> Result<Option<NaiveDate>, String> {
    str_arg(a, key)?
        .map(|d| {
            NaiveDate::parse_from_str(&d, "%Y-%m-%d")
                .map_err(|_| format!("{key} \"{d}\" is not a YYYY-MM-DD date"))
        })
        .transpose()
}

fn check_repeat(r: &str) -> Result<(), String> {
    Repeat::parse(r)
        .map(|_| ())
        .ok_or_else(|| format!("repeat \"{r}\" isn't one of: {REPEAT}"))
}

fn duration_arg(v: i64) -> Result<u32, String> {
    if (1..=1440).contains(&v) {
        Ok(v as u32)
    } else {
        Err("duration must be 1 to 1440 minutes".into())
    }
}

fn priority_arg(v: i64) -> Result<u8, String> {
    if (0..=3).contains(&v) {
        Ok(v as u8)
    } else {
        Err("priority must be 0, 1, 2 or 3".into())
    }
}

fn err(e: StoreError) -> String {
    match e {
        StoreError::NotFound(id) => format!("there's no task {id}; use list_tasks to find ids"),
        other => other.to_string(),
    }
}

fn found(store: &Store, id: i64) -> Result<Task, String> {
    store.get(id).map_err(err)
}

// ── Calls ──────────────────────────────────────────────────────────────────

/// Run one tool. `now` is the user's local time. The result is JSON for the
/// agent; `Err` is a message saying what to change.
pub fn call(store: &Store, name: &str, args: &Value, now: NaiveDateTime) -> Result<Value, String> {
    call_with(store, &Ctx::none(), name, args, now)
}

/// Run one tool for an agent, and record what it changed (see
/// `crate::agent_log`) so the person can see it and undo it.
pub fn run(
    store: &Store,
    ctx: &Ctx<'_>,
    name: &str,
    args: &Value,
    now: NaiveDateTime,
) -> Result<Value, String> {
    if is_read_only(name) {
        return call_with(store, ctx, name, args, now);
    }
    crate::agent_log::record(store, ctx.agent, name, || {
        call_with(store, ctx, name, args, now)
    })
}

fn call_with(
    store: &Store,
    ctx: &Ctx<'_>,
    name: &str,
    args: &Value,
    now: NaiveDateTime,
) -> Result<Value, String> {
    let empty = Map::new();
    let a = match args {
        Value::Object(m) => m,
        Value::Null => &empty,
        _ => return Err("arguments must be an object".into()),
    };
    let today = now.date();
    match name {
        "get_overview" => overview(store, today, now),
        "list_tasks" => list_tasks(store, a, today, now),
        "get_task" => Ok(task_json(&found(store, id_arg(a)?)?)),
        "get_schedule" => schedule(store, ctx, a, today),
        "find_free_time" => free_time(store, ctx, a, today),
        "schedule_tasks" => schedule_many(store, a),
        "list_reminders" => reminders(store, a, today),
        "list_projects" => projects(store),
        "list_sections" => sections(store, &need_str(a, "project")?),
        "list_tags" => tags(store),
        "add_task" => add_task(store, a),
        "update_task" => update_task(store, a),
        "schedule_task" => schedule_task(store, a),
        "complete_task" => set_done(store, id_arg(a)?, true),
        "reopen_task" => set_done(store, id_arg(a)?, false),
        "complete_tasks" => complete_many(store, a),
        "delete_task" => {
            let t = found(store, id_arg(a)?)?;
            store.delete(t.id).map_err(err)?;
            Ok(json!({ "deleted": t.id, "title": t.title }))
        }
        "move_task" => move_task(store, a),
        "snooze_task" => snooze(store, a, now),
        "set_repeat" => set_repeat(store, a),
        "skip_occurrence" => Ok(task_json(&store.skip(id_arg(a)?).map_err(err)?)),
        "add_subtask" | "update_subtask" | "remove_subtask" => subtask(store, name, a),
        "create_project" => create_project(store, a),
        "update_project" => update_project(store, a),
        "delete_project" => delete_project(store, a),
        "create_section" => {
            let project = need_str(a, "project")?;
            let name = need_str(a, "name")?;
            store.create_project(&project).map_err(err)?;
            let made = store
                .add_floor(&project, &name)
                .map_err(err)?
                .ok_or("name is required")?;
            Ok(json!({ "project": project, "section": made }))
        }
        "rename_section" => {
            let (project, from, to) = (
                need_str(a, "project")?,
                need_str(a, "name")?,
                need_str(a, "new_name")?,
            );
            let moved = store.rename_floor(&project, &from, &to).map_err(err)?;
            Ok(json!({ "project": project, "section": to, "tasks_moved": moved }))
        }
        "delete_section" => delete_section(store, a),
        other => Err(format!(
            "there's no tool \"{other}\"; tools/list has them all"
        )),
    }
}

fn open_tasks(store: &Store) -> Result<Vec<Task>, String> {
    Ok(store
        .list(None)
        .map_err(err)?
        .into_iter()
        .filter(|t| !t.done)
        .collect())
}

fn is_overdue(t: &Task, today: NaiveDate, now: NaiveDateTime) -> bool {
    let day = today.format("%Y-%m-%d").to_string();
    let time = now.format("%H:%M").to_string();
    if t.done || t.paused {
        return false;
    }
    let late_day = t.due_date.as_deref().is_some_and(|d| d < day.as_str());
    let late_time = t.due_date.as_deref() == Some(day.as_str())
        && t.due_time.as_deref().is_some_and(|tm| tm < time.as_str());
    let late_deadline = t.deadline.as_deref().is_some_and(|d| d < day.as_str());
    late_day || late_time || late_deadline
}

fn overview(store: &Store, today: NaiveDate, now: NaiveDateTime) -> Result<Value, String> {
    let open = open_tasks(store)?;
    let day = today.format("%Y-%m-%d").to_string();
    let week = (today + Duration::days(7)).format("%Y-%m-%d").to_string();
    let count = |f: &dyn Fn(&Task) -> bool| open.iter().filter(|&t| f(t)).count();
    Ok(json!({
        "today": day,
        "now": now.format("%H:%M").to_string(),
        "open_tasks": open.len(),
        "due_today": count(&|t| t.due_date.as_deref().is_some_and(|d| d <= day.as_str())),
        "overdue": count(&|t| is_overdue(t, today, now)),
        "inbox": count(&|t| t.project.is_none()),
        "next_7_days": count(&|t| t.due_date.as_deref().is_some_and(|d| d > day.as_str() && d <= week.as_str())),
        "someday": count(&|t| t.someday),
        "projects": store.projects().map_err(err)?.iter().map(|p| json!({ "name": p.name, "open": p.open })).collect::<Vec<_>>()
    }))
}

fn list_tasks(
    store: &Store,
    a: &Args,
    today: NaiveDate,
    now: NaiveDateTime,
) -> Result<Value, String> {
    let list = str_arg(a, "list")?.unwrap_or_else(|| "open".into());
    let day = today.format("%Y-%m-%d").to_string();
    let include_done = bool_arg(a, "include_done")?.unwrap_or(list == "completed" || list == "all");
    let from = date_arg(a, "from")?.map(|d| d.format("%Y-%m-%d").to_string());
    let to = date_arg(a, "to")?.map(|d| d.format("%Y-%m-%d").to_string());
    let project = str_arg(a, "project")?;
    let section = match a.get("section") {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) => Some(s.trim().to_string()),
        Some(_) => return Err("section must be a string".into()),
    };
    let tag = str_arg(a, "tag")?.map(|t| format!("#{}", t.trim_start_matches('#').to_lowercase()));
    let words: Vec<String> = str_arg(a, "query")?
        .unwrap_or_default()
        .to_lowercase()
        .split_whitespace()
        .map(String::from)
        .collect();
    let priority = int_arg(a, "priority")?;
    let limit = int_arg(a, "limit")?.map_or(DEFAULT_LIMIT, |n| (n.max(1) as usize).min(MAX_LIMIT));
    let offset = int_arg(a, "offset")?.map_or(0, |n| n.max(0) as usize);
    let week = (today + Duration::days(7)).format("%Y-%m-%d").to_string();

    let all = store.all().map_err(err)?;
    let mut picked: Vec<&Task> = all
        .iter()
        .filter(|t| include_done || !t.done)
        .filter(|t| match list.as_str() {
            "today" => {
                !t.done && !t.paused && t.due_date.as_deref().is_some_and(|d| d <= day.as_str())
            }
            "overdue" => is_overdue(t, today, now),
            "upcoming" => {
                let (lo, hi) = (
                    from.clone().unwrap_or_else(|| day.clone()),
                    to.clone().unwrap_or_else(|| week.clone()),
                );
                t.due_date
                    .as_deref()
                    .is_some_and(|d| d >= lo.as_str() && d <= hi.as_str())
            }
            "inbox" => t.project.is_none(),
            "someday" => t.someday,
            "no_date" => t.due_date.is_none() && !t.someday,
            "completed" => t.done,
            "all" | "open" => true,
            _ => false,
        })
        .filter(|t| {
            project.as_deref().map_or(true, |p| {
                t.project
                    .as_deref()
                    .is_some_and(|tp| tp.eq_ignore_ascii_case(p))
            })
        })
        .filter(|t| {
            section.as_deref().map_or(true, |s| {
                t.heading.as_deref().unwrap_or("").eq_ignore_ascii_case(s)
            })
        })
        .filter(|t| {
            tag.as_deref()
                .map_or(true, |g| tags_of(&t.title).iter().any(|x| x == g))
        })
        .filter(|t| priority.map_or(true, |p| i64::from(t.priority) == p))
        .filter(|t| {
            from.as_deref()
                .map_or(true, |f| t.due_date.as_deref().is_some_and(|d| d >= f))
        })
        .filter(|t| {
            to.as_deref()
                .map_or(true, |e| t.due_date.as_deref().is_some_and(|d| d <= e))
        })
        .filter(|t| {
            let hay = format!("{} {}", t.title, t.notes.as_deref().unwrap_or("")).to_lowercase();
            words.iter().all(|w| hay.contains(w.as_str()))
        })
        .collect();
    if !matches!(
        list.as_str(),
        "today"
            | "overdue"
            | "upcoming"
            | "inbox"
            | "someday"
            | "no_date"
            | "completed"
            | "all"
            | "open"
    ) {
        return Err(format!("list \"{list}\" isn't one of: today, overdue, upcoming, inbox, someday, no_date, completed, all"));
    }
    if list == "completed" {
        picked.sort_by(|x, y| y.completed_at.cmp(&x.completed_at));
    }
    let total = picked.len();
    let page: Vec<Value> = picked
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(task_json)
        .collect();
    Ok(json!({ "total": total, "offset": offset, "count": page.len(), "tasks": page }))
}

fn span(a: &Args, today: NaiveDate) -> Result<(NaiveDate, NaiveDate), String> {
    let from = date_arg(a, "from")?.unwrap_or(today);
    let to = date_arg(a, "to")?.unwrap_or(from + Duration::days(6));
    if to < from {
        return Err("to is before from".into());
    }
    if (to - from).num_days() > 92 {
        return Err("ask for at most 93 days at a time".into());
    }
    Ok((from, to))
}

fn schedule(store: &Store, ctx: &Ctx<'_>, a: &Args, today: NaiveDate) -> Result<Value, String> {
    let (from, to) = span(a, today)?;
    let open = open_tasks(store)?;
    let busy = (ctx.busy)(from, to);
    let mut days = Vec::new();
    let mut d = from;
    while d <= to {
        let iso = d.format("%Y-%m-%d").to_string();
        let mut timed: Vec<&Task> = open
            .iter()
            .filter(|t| t.due_date.as_deref() == Some(iso.as_str()) && t.due_time.is_some())
            .collect();
        timed.sort_by(|x, y| x.due_time.cmp(&y.due_time));
        let untimed: Vec<Value> = open
            .iter()
            .filter(|t| t.due_date.as_deref() == Some(iso.as_str()) && t.due_time.is_none())
            .map(task_json)
            .collect();
        let planned: u32 = timed.iter().filter_map(|t| t.duration).sum();
        let meetings: Vec<Value> = busy
            .iter()
            .filter(|b| b.start.date() <= d && b.end.date() >= d)
            .map(|b| json!({ "title": b.title, "start": b.start.format("%Y-%m-%dT%H:%M").to_string(), "end": b.end.format("%Y-%m-%dT%H:%M").to_string() }))
            .collect();
        days.push(json!({
            "date": iso,
            "weekday": d.format("%A").to_string(),
            "meetings": meetings,
            "timed": timed.into_iter().map(task_json).collect::<Vec<_>>(),
            "anytime": untimed,
            "planned_minutes": planned
        }));
        d += Duration::days(1);
    }
    Ok(json!({ "days": days }))
}

fn hm_arg(a: &Args, key: &str, default: &str) -> Result<chrono::NaiveTime, String> {
    let v = str_arg(a, key)?.unwrap_or_else(|| default.to_string());
    chrono::NaiveTime::parse_from_str(&v, "%H:%M")
        .map_err(|_| format!("{key} \"{v}\" is not a 24-hour HH:MM time"))
}

/// Free stretches each day between `day_start` and `day_end`, around
/// meetings and timed tasks (30 minutes for a task with no length).
fn free_time(store: &Store, ctx: &Ctx<'_>, a: &Args, today: NaiveDate) -> Result<Value, String> {
    let from = date_arg(a, "from")?.unwrap_or(today);
    let to = date_arg(a, "to")?.unwrap_or(from);
    if to < from || (to - from).num_days() > 31 {
        return Err("ask for 1 to 32 days, from before to".into());
    }
    let (start_t, end_t) = (
        hm_arg(a, "day_start", "08:00")?,
        hm_arg(a, "day_end", "18:00")?,
    );
    if end_t <= start_t {
        return Err("day_end must be after day_start".into());
    }
    let min = int_arg(a, "min_minutes")?.unwrap_or(15).max(1);
    let busy = (ctx.busy)(from, to);
    let open = open_tasks(store)?;
    let mut days = Vec::new();
    let mut d = from;
    while d <= to {
        let (lo, hi) = (d.and_time(start_t), d.and_time(end_t));
        let mut taken: Vec<(NaiveDateTime, NaiveDateTime)> =
            busy.iter().map(|b| (b.start, b.end)).collect();
        for t in &open {
            if let Some(state) = crate::calendar_sync::EventState::of_task(t) {
                if state.start.date() == d {
                    taken.push((state.start, state.end));
                }
            }
        }
        taken.retain(|(s, e)| *e > lo && *s < hi);
        taken.sort();
        let mut free = Vec::new();
        let mut cursor = lo;
        for (s, e) in taken {
            if s > cursor && (s - cursor).num_minutes() >= min {
                free.push((cursor, s));
            }
            cursor = cursor.max(e);
        }
        if hi > cursor && (hi - cursor).num_minutes() >= min {
            free.push((cursor, hi));
        }
        let total: i64 = free.iter().map(|(s, e)| (*e - *s).num_minutes()).sum();
        days.push(json!({
            "date": d.format("%Y-%m-%d").to_string(),
            "free": free.iter().map(|(s, e)| json!({ "start": s.format("%H:%M").to_string(), "end": e.format("%H:%M").to_string(), "minutes": (*e - *s).num_minutes() })).collect::<Vec<_>>(),
            "free_minutes": total
        }));
        d += Duration::days(1);
    }
    Ok(json!({ "days": days }))
}

/// Schedule several tasks at once, all or nothing.
fn schedule_many(store: &Store, a: &Args) -> Result<Value, String> {
    let Some(Value::Array(items)) = a.get("items") else {
        return Err("items must be a list of { id, date, time, duration }".into());
    };
    if items.is_empty() || items.len() > MAX_BATCH {
        return Err(format!("send 1 to {MAX_BATCH} items"));
    }
    // Check everything first.
    let mut plan = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let Value::Object(m) = item else {
            return Err(format!("item {i} must be an object"));
        };
        let id = int_arg(m, "id")?.ok_or_else(|| format!("item {i} needs an id"))?;
        found(store, id).map_err(|e| format!("item {i}: {e}"))?;
        let date = date_arg(m, "date")?.ok_or_else(|| format!("item {i} needs a date"))?;
        let time = str_arg(m, "time")?
            .map(|t| {
                chrono::NaiveTime::parse_from_str(&t, "%H:%M")
                    .map(|x| x.format("%H:%M").to_string())
                    .map_err(|_| format!("item {i}: time \"{t}\" is not HH:MM"))
            })
            .transpose()?;
        let duration = int_arg(m, "duration")?.map(duration_arg).transpose()?;
        plan.push((id, date, time, duration));
    }
    let mut out = Vec::new();
    for (id, date, time, duration) in plan {
        let mut p = TaskPatch {
            due_date: Some(Some(date.format("%Y-%m-%d").to_string())),
            due_time: Some(time),
            someday: Some(false),
            only_this: Some(true),
            ..Default::default()
        };
        if duration.is_some() {
            p.duration = Some(duration);
        }
        out.push(task_json(&store.update(id, p).map_err(err)?));
    }
    Ok(json!({ "scheduled": out.len(), "tasks": out }))
}

fn reminders(store: &Store, a: &Args, today: NaiveDate) -> Result<Value, String> {
    let (from, to) = span(a, today)?;
    let (lo, hi) = (
        from.format("%Y-%m-%d").to_string(),
        to.format("%Y-%m-%d").to_string(),
    );
    let mut out: Vec<(String, Value)> = Vec::new();
    for t in open_tasks(store)? {
        if t.paused {
            continue;
        }
        let at = match (&t.snoozed_until, &t.due_date, &t.due_time) {
            (Some(s), ..) => Some(s.chars().take(16).collect::<String>()),
            (None, Some(d), Some(tm)) => Some(format!("{d}T{tm}")),
            _ => None,
        };
        if let Some(at) = at {
            let day = &at[..10.min(at.len())];
            if day >= lo.as_str() && day <= hi.as_str() {
                let mut v = task_json(&t);
                v["remind_at"] = json!(at);
                v["snoozed"] = json!(t.snoozed_until.is_some());
                out.push((at, v));
            }
        }
    }
    out.sort_by(|x, y| x.0.cmp(&y.0));
    Ok(json!({ "reminders": out.into_iter().map(|(_, v)| v).collect::<Vec<_>>() }))
}

fn projects(store: &Store) -> Result<Value, String> {
    let floors = store.floors().map_err(err)?;
    let list: Vec<Value> = store
        .projects()
        .map_err(err)?
        .into_iter()
        .map(|p| {
            let sections: Vec<Value> = floors
                .iter()
                .filter(|f| f.project == p.name)
                .map(|f| json!({ "name": f.name, "open": f.open, "done": f.done }))
                .collect();
            json!({ "name": p.name, "color": p.color, "open": p.open, "done": p.done, "synced_from": p.synced, "sections": sections })
        })
        .collect();
    Ok(json!({ "projects": list }))
}

fn sections(store: &Store, project: &str) -> Result<Value, String> {
    let list: Vec<Value> = store
        .floors()
        .map_err(err)?
        .into_iter()
        .filter(|f| f.project.eq_ignore_ascii_case(project))
        .map(|f| json!({ "name": f.name, "open": f.open, "done": f.done }))
        .collect();
    Ok(json!({ "project": project, "sections": list }))
}

fn tags(store: &Store) -> Result<Value, String> {
    let mut counts: Vec<(String, usize)> = Vec::new();
    for t in open_tasks(store)? {
        for tag in tags_of(&t.title) {
            match counts.iter_mut().find(|(k, _)| *k == tag) {
                Some((_, n)) => *n += 1,
                None => counts.push((tag, 1)),
            }
        }
    }
    counts.sort_by(|x, y| y.1.cmp(&x.1).then(x.0.cmp(&y.0)));
    Ok(
        json!({ "tags": counts.into_iter().map(|(tag, count)| json!({ "tag": tag, "count": count })).collect::<Vec<_>>() }),
    )
}

fn add_task(store: &Store, a: &Args) -> Result<Value, String> {
    let title = need_str(a, "title")?;
    if title.chars().count() > 200 {
        return Err("title is longer than 200 characters".into());
    }
    let repeat = str_arg(a, "repeat")?;
    if let Some(r) = &repeat {
        check_repeat(r)?;
    }
    let due_time = str_arg(a, "due_time")?;
    let due_date = date_arg(a, "due_date")?.map(|d| d.format("%Y-%m-%d").to_string());
    if due_time.is_some() && due_date.is_none() {
        return Err("due_time needs a due_date".into());
    }
    let subtasks = match a.get("subtasks") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| ChecklistItem {
                text: s.to_string(),
                done: false,
            })
            .collect(),
        Some(_) => return Err("subtasks must be a list of strings".into()),
    };
    let project = str_arg(a, "project")?.filter(|s| !s.is_empty());
    let section = str_arg(a, "section")?.filter(|s| !s.is_empty());
    if section.is_some() && project.is_none() {
        return Err("section needs a project".into());
    }
    if let Some(p) = &project {
        store.create_project(p).map_err(err)?;
        if let Some(s) = &section {
            store.add_floor(p, s).map_err(err)?;
        }
    }
    let t = store
        .insert(NewTask {
            title,
            due_date,
            due_time,
            recurrence: repeat,
            notes: str_arg(a, "notes")?,
            deadline: date_arg(a, "deadline")?.map(|d| d.format("%Y-%m-%d").to_string()),
            evening: bool_arg(a, "evening")?.unwrap_or(false),
            someday: bool_arg(a, "someday")?.unwrap_or(false),
            project,
            heading: section,
            checklist: subtasks,
            priority: int_arg(a, "priority")?
                .map(priority_arg)
                .transpose()?
                .unwrap_or(0),
            duration: int_arg(a, "duration")?.map(duration_arg).transpose()?,
            ..Default::default()
        })
        .map_err(err)?;
    Ok(task_json(&t))
}

fn update_task(store: &Store, a: &Args) -> Result<Value, String> {
    let id = id_arg(a)?;
    let before = found(store, id)?;
    let mut p = TaskPatch::default();
    if let Some(t) = str_arg(a, "title")? {
        if t.is_empty() {
            return Err("title can't be empty".into());
        }
        p.title = Some(t);
    }
    p.notes = clearable(a, "notes")?;
    p.due_date = clearable(a, "due_date")?;
    p.due_time = clearable(a, "due_time")?;
    p.deadline = clearable(a, "deadline")?;
    if let Some(r) = clearable(a, "repeat")? {
        if let Some(r) = &r {
            check_repeat(r)?;
        }
        p.recurrence = Some(r);
    }
    if a.contains_key("duration") {
        p.duration = Some(int_arg(a, "duration")?.map(duration_arg).transpose()?);
    }
    if let Some(n) = int_arg(a, "priority")? {
        p.priority = Some(priority_arg(n)?);
    }
    p.evening = bool_arg(a, "evening")?;
    p.someday = bool_arg(a, "someday")?;
    p.only_this = bool_arg(a, "only_this")?;
    let project = clearable(a, "project")?;
    let section = clearable(a, "section")?;
    if let Some(Some(name)) = &project {
        store.create_project(name).map_err(err)?;
    }
    let target = match &project {
        Some(p) => p.clone(),
        None => before.project.clone(),
    };
    if let (Some(Some(s)), Some(proj)) = (&section, &target) {
        store.add_floor(proj, s).map_err(err)?;
    } else if matches!(section, Some(Some(_))) && target.is_none() {
        return Err("section needs a project".into());
    }
    if project.is_some() {
        p.project = project;
        p.heading = Some(section.clone().flatten());
    } else if section.is_some() {
        p.heading = section;
    }
    let t = store.update(id, p).map_err(err)?;
    Ok(task_json(&t))
}

fn schedule_task(store: &Store, a: &Args) -> Result<Value, String> {
    let id = id_arg(a)?;
    found(store, id)?;
    let mut p = TaskPatch {
        due_date: clearable(a, "date")?,
        due_time: clearable(a, "time")?,
        only_this: bool_arg(a, "only_this")?,
        ..Default::default()
    };
    if let Some(Some(_)) = &p.due_date {
        p.someday = Some(false);
    }
    if a.contains_key("duration") {
        p.duration = Some(int_arg(a, "duration")?.map(duration_arg).transpose()?);
    }
    if matches!(p.due_time, Some(Some(_))) && matches!(p.due_date, Some(None)) {
        return Err("a time needs a date".into());
    }
    Ok(task_json(&store.update(id, p).map_err(err)?))
}

fn set_done(store: &Store, id: i64, done: bool) -> Result<Value, String> {
    found(store, id)?;
    let (t, fx) = store
        .update_with_effects(
            id,
            TaskPatch {
                done: Some(done),
                ..Default::default()
            },
        )
        .map_err(err)?;
    let mut v = task_json(&t);
    if let Some(next) = fx.spawned {
        v["next_occurrence"] = json!(next);
    }
    Ok(v)
}

fn complete_many(store: &Store, a: &Args) -> Result<Value, String> {
    let ids: Vec<i64> = match a.get("ids") {
        Some(Value::Array(v)) => v.iter().filter_map(Value::as_i64).collect(),
        _ => return Err("ids must be a list of task ids".into()),
    };
    if ids.len() > MAX_BATCH {
        return Err(format!("at most {MAX_BATCH} tasks at once"));
    }
    let mut done = Vec::new();
    let mut missing = Vec::new();
    for id in ids {
        match store.update(
            id,
            TaskPatch {
                done: Some(true),
                ..Default::default()
            },
        ) {
            Ok(_) => done.push(id),
            Err(StoreError::NotFound(_)) => missing.push(id),
            Err(e) => return Err(err(e)),
        }
    }
    Ok(json!({ "completed": done, "not_found": missing }))
}

fn move_task(store: &Store, a: &Args) -> Result<Value, String> {
    let id = id_arg(a)?;
    found(store, id)?;
    let project = match a.get("project") {
        Some(Value::Null) => None,
        Some(Value::String(s)) if !s.trim().is_empty() => Some(s.trim().to_string()),
        _ => return Err("project is required: a name, or null for none".into()),
    };
    let section = str_arg(a, "section")?.filter(|s| !s.is_empty());
    if let Some(p) = &project {
        store.create_project(p).map_err(err)?;
        if let Some(s) = &section {
            store.add_floor(p, s).map_err(err)?;
        }
    }
    let heading = project.as_ref().and(section);
    Ok(task_json(
        &store
            .update(
                id,
                TaskPatch {
                    project: Some(project),
                    heading: Some(heading),
                    ..Default::default()
                },
            )
            .map_err(err)?,
    ))
}

fn snooze(store: &Store, a: &Args, now: NaiveDateTime) -> Result<Value, String> {
    let id = id_arg(a)?;
    found(store, id)?;
    let until = if let Some(m) = int_arg(a, "minutes")? {
        if !(1..=60 * 24 * 365).contains(&m) {
            return Err("minutes must be 1 or more".into());
        }
        Some(
            (now + Duration::minutes(m))
                .format("%Y-%m-%dT%H:%M:00")
                .to_string(),
        )
    } else {
        match clearable(a, "until")? {
            None => {
                return Err(
                    "send until (a local YYYY-MM-DDTHH:MM, or null to cancel) or minutes".into(),
                )
            }
            Some(None) => None,
            Some(Some(u)) => {
                let at = NaiveDateTime::parse_from_str(&u, "%Y-%m-%dT%H:%M")
                    .or_else(|_| NaiveDateTime::parse_from_str(&u, "%Y-%m-%dT%H:%M:%S"))
                    .map_err(|_| format!("until \"{u}\" is not a local YYYY-MM-DDTHH:MM time"))?;
                Some(at.format("%Y-%m-%dT%H:%M:00").to_string())
            }
        }
    };
    let t = store
        .update(
            id,
            TaskPatch {
                snoozed_until: Some(until),
                ..Default::default()
            },
        )
        .map_err(err)?;
    Ok(task_json(&t))
}

fn set_repeat(store: &Store, a: &Args) -> Result<Value, String> {
    let id = id_arg(a)?;
    found(store, id)?;
    let mut p = TaskPatch::default();
    if let Some(r) = clearable(a, "repeat")? {
        if let Some(r) = &r {
            check_repeat(r)?;
        }
        p.recurrence = Some(r);
    }
    p.paused = bool_arg(a, "paused")?;
    Ok(task_json(&store.update(id, p).map_err(err)?))
}

fn subtask(store: &Store, name: &str, a: &Args) -> Result<Value, String> {
    let t = found(store, id_arg(a)?)?;
    let mut steps = t.checklist.clone();
    match name {
        "add_subtask" => {
            let text = need_str(a, "text")?;
            let at = int_arg(a, "position")?
                .map_or(steps.len(), |p| (p.max(0) as usize).min(steps.len()));
            steps.insert(at, ChecklistItem { text, done: false });
        }
        _ => {
            let i = int_arg(a, "index")?.ok_or("index is required")?;
            let i = usize::try_from(i)
                .ok()
                .filter(|i| *i < steps.len())
                .ok_or_else(|| format!("index must be 0 to {}", steps.len().saturating_sub(1)))?;
            if name == "remove_subtask" {
                steps.remove(i);
            } else {
                if let Some(text) = str_arg(a, "text")?.filter(|s| !s.is_empty()) {
                    steps[i].text = text;
                }
                if let Some(done) = bool_arg(a, "done")? {
                    steps[i].done = done;
                }
            }
        }
    }
    let t = store
        .update(
            t.id,
            TaskPatch {
                checklist: Some(steps),
                ..Default::default()
            },
        )
        .map_err(err)?;
    Ok(task_json(&t))
}

fn check_color(c: &str) -> Result<(), String> {
    let ok = c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit());
    if ok {
        Ok(())
    } else {
        Err(format!("color \"{c}\" is not #rrggbb"))
    }
}

fn create_project(store: &Store, a: &Args) -> Result<Value, String> {
    let name = need_str(a, "name")?;
    let color = str_arg(a, "color")?;
    if let Some(c) = &color {
        check_color(c)?;
    }
    let made = store
        .create_project(&name)
        .map_err(err)?
        .ok_or("name is required")?;
    if let Some(c) = &color {
        store.set_project_color(&made, Some(c)).map_err(err)?;
    }
    if let Some(Value::Array(list)) = a.get("sections") {
        for s in list.iter().filter_map(Value::as_str) {
            store.add_floor(&made, s).map_err(err)?;
        }
    }
    sections(store, &made).map(|v| json!({ "project": made, "sections": v["sections"] }))
}

fn update_project(store: &Store, a: &Args) -> Result<Value, String> {
    let mut name = need_str(a, "name")?;
    if !store
        .projects()
        .map_err(err)?
        .iter()
        .any(|p| p.name == name)
    {
        return Err(format!(
            "there's no project \"{name}\"; list_projects has them all"
        ));
    }
    if let Some(new) = str_arg(a, "new_name")?.filter(|s| !s.is_empty()) {
        store.rename_project(&name, &new).map_err(err)?;
        name = new;
    }
    if let Some(c) = clearable(a, "color")? {
        if let Some(c) = &c {
            check_color(c)?;
        }
        store.set_project_color(&name, c.as_deref()).map_err(err)?;
    }
    Ok(json!({ "project": name }))
}

fn delete_project(store: &Store, a: &Args) -> Result<Value, String> {
    let name = need_str(a, "name")?;
    let tasks = store.project_tasks(&name).map_err(err)?;
    if !tasks.is_empty() {
        if bool_arg(a, "delete_tasks")? != Some(true) {
            return Err(format!(
                "{name} has {} tasks: move them, or send delete_tasks: true to delete them too",
                tasks.len()
            ));
        }
        for t in &tasks {
            store.delete(t.id).map_err(err)?;
        }
    }
    let gone = store.delete_project(&name).map_err(err)?;
    if !gone {
        return Err(format!("there's no project \"{name}\""));
    }
    Ok(json!({ "deleted": name, "tasks_deleted": tasks.len() }))
}

fn delete_section(store: &Store, a: &Args) -> Result<Value, String> {
    let project = need_str(a, "project")?;
    let name = need_str(a, "name")?;
    let inside: Vec<Task> = store
        .project_tasks(&project)
        .map_err(err)?
        .into_iter()
        .filter(|t| t.heading.as_deref() == Some(name.as_str()))
        .collect();
    if !inside.is_empty() {
        match str_arg(a, "tasks")?.as_deref() {
            Some("general") => {
                for t in &inside {
                    store.update(t.id, TaskPatch { heading: Some(None), ..Default::default() }).map_err(err)?;
                }
            }
            Some("delete") => {
                for t in &inside {
                    store.delete(t.id).map_err(err)?;
                }
            }
            _ => {
                return Err(format!(
                    "{name} has {} tasks: send tasks: \"general\" to keep them in {project}, or \"delete\"",
                    inside.len()
                ))
            }
        }
    }
    let gone = store.delete_floor(&project, &name).map_err(err)?;
    if !gone && inside.is_empty() {
        return Err(format!("there's no section \"{name}\" in {project}"));
    }
    Ok(json!({ "deleted": name, "project": project, "tasks": inside.len() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn now() -> NaiveDateTime {
        NaiveDateTime::parse_from_str("2026-11-02T10:00", "%Y-%m-%dT%H:%M").unwrap()
    }

    fn run(store: &Store, name: &str, args: Value) -> Value {
        call(store, name, &args, now()).unwrap_or_else(|e| panic!("{name}: {e}"))
    }

    fn fails(store: &Store, name: &str, args: Value) -> String {
        call(store, name, &args, now()).unwrap_err()
    }

    /// As an agent would: recorded, so it can be undone.
    fn run_with(store: &Store, ctx: &Ctx<'_>, name: &str, args: Value) -> Value {
        super::run(store, ctx, name, &args, now()).unwrap_or_else(|e| panic!("{name}: {e}"))
    }

    #[test]
    fn every_tool_is_listed_with_a_schema() {
        let tools = tools();
        assert_eq!(tools.len(), 30);
        for t in &tools {
            assert!(t["name"].as_str().is_some_and(|n| !n.is_empty()));
            assert_eq!(t["inputSchema"]["type"], "object");
            assert!(t["description"].as_str().is_some_and(|d| d.len() > 10));
        }
        let names = names();
        let mut unique = names.clone();
        unique.dedup();
        assert_eq!(names.len(), unique.len());
        assert!(is_read_only("list_tasks") && !is_read_only("delete_task"));
        // Every listed tool answers (not "no tool").
        let s = Store::open_in_memory().unwrap();
        for n in &names {
            if let Err(e) = call(&s, n, &json!({}), now()) {
                assert!(!e.contains("there's no tool"), "{n}: {e}");
            }
        }
    }

    #[test]
    fn add_read_change_and_finish_a_task() {
        let s = Store::open_in_memory().unwrap();
        let t = run(
            &s,
            "add_task",
            json!({
                "title": "Stand-up with Priya #work",
                "due_date": "2026-11-02",
                "due_time": "09:07",
                "duration": 7,
                "project": "Offsite",
                "section": "Program",
                "priority": 2,
                "subtasks": ["Agenda", "Notes"]
            }),
        );
        let id = t["id"].as_i64().unwrap();
        assert_eq!(t["end_time"], "09:14");
        assert_eq!(t["section"], "Program");
        assert_eq!(t["tags"], json!(["#work"]));
        assert_eq!(t["subtasks"].as_array().unwrap().len(), 2);

        let got = run(&s, "get_task", json!({ "id": id }));
        assert_eq!(got["duration"], 7);

        let changed = run(
            &s,
            "update_task",
            json!({ "id": id, "duration": 15, "notes": "Room 4", "due_time": "09:30" }),
        );
        assert_eq!(
            (changed["duration"].as_i64(), changed["end_time"].as_str()),
            (Some(15), Some("09:45"))
        );
        let cleared = run(
            &s,
            "update_task",
            json!({ "id": id, "duration": null, "notes": null }),
        );
        assert!(cleared["duration"].is_null() && cleared["notes"].is_null());

        let done = run(&s, "complete_task", json!({ "id": id }));
        assert_eq!(done["done"], true);
        let back = run(&s, "reopen_task", json!({ "id": id }));
        assert_eq!(back["done"], false);
    }

    #[test]
    fn lists_filter_like_the_app() {
        let s = Store::open_in_memory().unwrap();
        run(
            &s,
            "add_task",
            json!({ "title": "Late one", "due_date": "2026-10-30" }),
        );
        run(
            &s,
            "add_task",
            json!({ "title": "Today at 9", "due_date": "2026-11-02", "due_time": "09:00" }),
        );
        run(
            &s,
            "add_task",
            json!({ "title": "Tomorrow #home", "due_date": "2026-11-03", "project": "Home" }),
        );
        run(
            &s,
            "add_task",
            json!({ "title": "Some idea", "someday": true }),
        );
        let names = |v: Value| -> Vec<String> {
            v["tasks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|t| t["title"].as_str().unwrap().to_string())
                .collect()
        };
        assert_eq!(
            names(run(&s, "list_tasks", json!({ "list": "today" }))),
            vec!["Late one", "Today at 9"]
        );
        assert_eq!(
            names(run(&s, "list_tasks", json!({ "list": "overdue" }))),
            vec!["Late one", "Today at 9"]
        );
        assert_eq!(
            names(run(&s, "list_tasks", json!({ "list": "upcoming" }))),
            vec!["Today at 9", "Tomorrow #home"]
        );
        assert_eq!(
            names(run(&s, "list_tasks", json!({ "tag": "home" }))),
            vec!["Tomorrow #home"]
        );
        assert_eq!(
            names(run(&s, "list_tasks", json!({ "list": "someday" }))),
            vec!["Some idea"]
        );
        assert_eq!(
            names(run(&s, "list_tasks", json!({ "query": "idea" }))),
            vec!["Some idea"]
        );
        let inbox = run(&s, "list_tasks", json!({ "list": "inbox", "limit": 1 }));
        assert_eq!(
            (inbox["total"].as_i64(), inbox["count"].as_i64()),
            (Some(3), Some(1))
        );
        assert!(fails(&s, "list_tasks", json!({ "list": "nope" })).contains("isn't one of"));
        let o = run(&s, "get_overview", json!({}));
        assert_eq!(
            (
                o["open_tasks"].as_i64(),
                o["overdue"].as_i64(),
                o["someday"].as_i64()
            ),
            (Some(4), Some(2), Some(1))
        );
    }

    #[test]
    fn schedule_and_reminders() {
        let s = Store::open_in_memory().unwrap();
        let a = run(
            &s,
            "add_task",
            json!({ "title": "Deep work", "due_date": "2026-11-03", "due_time": "13:05", "duration": 95 }),
        );
        run(
            &s,
            "add_task",
            json!({ "title": "Review", "due_date": "2026-11-03", "due_time": "09:00", "duration": 30 }),
        );
        run(
            &s,
            "add_task",
            json!({ "title": "Anytime", "due_date": "2026-11-03" }),
        );
        let sched = run(
            &s,
            "get_schedule",
            json!({ "from": "2026-11-03", "to": "2026-11-03" }),
        );
        let day = &sched["days"][0];
        assert_eq!(day["timed"][0]["title"], "Review");
        assert_eq!(day["timed"][1]["end_time"], "14:40");
        assert_eq!(day["anytime"][0]["title"], "Anytime");
        assert_eq!(day["planned_minutes"], 125);

        let id = a["id"].as_i64().unwrap();
        run(&s, "snooze_task", json!({ "id": id, "minutes": 30 }));
        let r = run(&s, "list_reminders", json!({}));
        assert_eq!(r["reminders"][0]["remind_at"], "2026-11-02T10:30");
        assert_eq!(r["reminders"][0]["snoozed"], true);
        let cancelled = run(&s, "snooze_task", json!({ "id": id, "until": null }));
        assert!(cancelled["snoozed_until"].is_null());
        assert!(
            fails(&s, "snooze_task", json!({ "id": id, "until": "tomorrow" }))
                .contains("YYYY-MM-DDTHH:MM")
        );
    }

    #[test]
    fn schedule_task_sets_minutes_and_length() {
        let s = Store::open_in_memory().unwrap();
        let id = run(
            &s,
            "add_task",
            json!({ "title": "Call Sam", "someday": true }),
        )["id"]
            .as_i64()
            .unwrap();
        let t = run(
            &s,
            "schedule_task",
            json!({ "id": id, "date": "2026-11-04", "time": "16:23", "duration": 12 }),
        );
        assert_eq!(
            (
                t["due_time"].as_str(),
                t["end_time"].as_str(),
                t["someday"].as_bool()
            ),
            (Some("16:23"), Some("16:35"), Some(false))
        );
        let t = run(&s, "schedule_task", json!({ "id": id, "date": null }));
        assert!(t["due_date"].is_null() && t["due_time"].is_null());
        assert!(fails(
            &s,
            "schedule_task",
            json!({ "id": id, "date": "2026-11-04", "duration": 5000 })
        )
        .contains("1440"));
    }

    #[test]
    fn subtasks_move_repeats_and_deletes() {
        let s = Store::open_in_memory().unwrap();
        let id = run(
            &s,
            "add_task",
            json!({ "title": "Pack", "due_date": "2026-11-05", "repeat": "weekly" }),
        )["id"]
            .as_i64()
            .unwrap();
        run(&s, "add_subtask", json!({ "id": id, "text": "Charger" }));
        run(
            &s,
            "add_subtask",
            json!({ "id": id, "text": "Passport", "position": 0 }),
        );
        let t = run(
            &s,
            "update_subtask",
            json!({ "id": id, "index": 1, "done": true }),
        );
        assert_eq!(
            t["subtasks"],
            json!([{ "index": 0, "text": "Passport", "done": false }, { "index": 1, "text": "Charger", "done": true }])
        );
        let t = run(&s, "remove_subtask", json!({ "id": id, "index": 0 }));
        assert_eq!(t["subtasks"].as_array().unwrap().len(), 1);
        assert!(fails(&s, "remove_subtask", json!({ "id": id, "index": 5 })).contains("index"));

        let t = run(
            &s,
            "move_task",
            json!({ "id": id, "project": "Trip", "section": "Before" }),
        );
        assert_eq!(
            (t["project"].as_str(), t["section"].as_str()),
            (Some("Trip"), Some("Before"))
        );
        let t = run(&s, "move_task", json!({ "id": id, "project": null }));
        assert!(t["project"].is_null() && t["section"].is_null());

        let done = run(&s, "complete_task", json!({ "id": id }));
        assert!(done["next_occurrence"].as_i64().is_some());
        let t = run(&s, "set_repeat", json!({ "id": id, "repeat": null }));
        assert!(t["repeat"].is_null());
        assert!(
            fails(&s, "set_repeat", json!({ "id": id, "repeat": "hourly" }))
                .contains("isn't one of")
        );

        let gone = run(&s, "delete_task", json!({ "id": id }));
        assert_eq!(gone["deleted"], id);
        assert!(fails(&s, "get_task", json!({ "id": id })).contains("no task"));
    }

    #[test]
    fn projects_and_sections() {
        let s = Store::open_in_memory().unwrap();
        let p = run(
            &s,
            "create_project",
            json!({ "name": "Launch", "color": "#336699", "sections": ["Design", "Docs"] }),
        );
        assert_eq!(p["sections"].as_array().unwrap().len(), 2);
        run(
            &s,
            "add_task",
            json!({ "title": "Write docs", "project": "Launch", "section": "Docs" }),
        );
        run(
            &s,
            "rename_section",
            json!({ "project": "Launch", "name": "Docs", "new_name": "Help" }),
        );
        let listed = run(&s, "list_projects", json!({}));
        assert_eq!(listed["projects"][0]["color"], "#336699");
        assert!(fails(
            &s,
            "delete_section",
            json!({ "project": "Launch", "name": "Help" })
        )
        .contains("general"));
        run(
            &s,
            "delete_section",
            json!({ "project": "Launch", "name": "Help", "tasks": "general" }),
        );
        let left = run(&s, "list_tasks", json!({ "project": "Launch" }));
        assert!(left["tasks"][0]["section"].is_null());
        run(
            &s,
            "update_project",
            json!({ "name": "Launch", "new_name": "Launch 2", "color": null }),
        );
        assert!(fails(&s, "delete_project", json!({ "name": "Launch 2" })).contains("delete_tasks"));
        let gone = run(
            &s,
            "delete_project",
            json!({ "name": "Launch 2", "delete_tasks": true }),
        );
        assert_eq!(gone["tasks_deleted"], 1);
        assert!(run(&s, "list_projects", json!({}))["projects"]
            .as_array()
            .unwrap()
            .is_empty());
        assert!(
            fails(&s, "create_project", json!({ "name": "X", "color": "red" })).contains("#rrggbb")
        );
    }

    #[test]
    fn bad_input_says_what_to_fix() {
        let s = Store::open_in_memory().unwrap();
        assert!(fails(&s, "add_task", json!({})).contains("title is required"));
        assert!(
            fails(&s, "add_task", json!({ "title": "x", "due_time": "09:00" }))
                .contains("needs a due_date")
        );
        assert!(
            fails(&s, "add_task", json!({ "title": "x", "due_date": "Nov 2" }))
                .contains("YYYY-MM-DD")
        );
        assert!(fails(&s, "add_task", json!({ "title": "x", "priority": 9 })).contains("priority"));
        assert!(
            fails(&s, "add_task", json!({ "title": "x", "section": "A" }))
                .contains("needs a project")
        );
        assert!(fails(&s, "update_task", json!({ "id": 999 })).contains("no task 999"));
        assert!(fails(&s, "nope", json!({})).contains("no tool"));
        assert!(call(&s, "list_tasks", &json!([1]), now()).is_err());
    }

    #[test]
    fn complete_many_reports_missing_ids() {
        let s = Store::open_in_memory().unwrap();
        let a = run(&s, "add_task", json!({ "title": "A" }))["id"]
            .as_i64()
            .unwrap();
        let b = run(&s, "add_task", json!({ "title": "B" }))["id"]
            .as_i64()
            .unwrap();
        let r = run(&s, "complete_tasks", json!({ "ids": [a, b, 999] }));
        assert_eq!(r["completed"], json!([a, b]));
        assert_eq!(r["not_found"], json!([999]));
    }

    fn at(s: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M").unwrap()
    }

    fn meetings(_: NaiveDate, _: NaiveDate) -> Vec<Busy> {
        vec![
            Busy {
                title: "Design review".into(),
                start: at("2026-11-02T13:00"),
                end: at("2026-11-02T14:00"),
            },
            Busy {
                title: "Launch rehearsal".into(),
                start: at("2026-11-02T15:00"),
                end: at("2026-11-02T16:30"),
            },
        ]
    }

    #[test]
    fn free_time_goes_around_meetings_and_timed_tasks() {
        let s = Store::open_in_memory().unwrap();
        run(
            &s,
            "add_task",
            json!({ "title": "Stand-up", "due_date": "2026-11-02", "due_time": "09:00", "duration": 15 }),
        );
        run(
            &s,
            "add_task",
            json!({ "title": "No length", "due_date": "2026-11-02", "due_time": "11:00" }),
        );
        let ctx = Ctx {
            agent: "claude-ai",
            busy: &meetings,
        };
        let r = call_with(
            &s,
            &ctx,
            "find_free_time",
            &json!({ "from": "2026-11-02" }),
            now(),
        )
        .unwrap();
        let free: Vec<(String, String)> = r["days"][0]["free"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| {
                (
                    f["start"].as_str().unwrap().to_string(),
                    f["end"].as_str().unwrap().to_string(),
                )
            })
            .collect();
        let want = [
            ("08:00", "09:00"),
            ("09:15", "11:00"),
            ("11:30", "13:00"),
            ("14:00", "15:00"),
            ("16:30", "18:00"),
        ];
        assert_eq!(
            free,
            want.iter()
                .map(|(a, b)| (a.to_string(), b.to_string()))
                .collect::<Vec<_>>()
        );
        assert_eq!(r["days"][0]["free_minutes"], 60 + 105 + 90 + 60 + 90);
        let sched = call_with(
            &s,
            &ctx,
            "get_schedule",
            &json!({ "from": "2026-11-02", "to": "2026-11-02" }),
            now(),
        )
        .unwrap();
        assert_eq!(sched["days"][0]["meetings"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn schedule_tasks_is_all_or_nothing_and_one_undo() {
        let s = Store::open_in_memory().unwrap();
        let a = run(&s, "add_task", json!({ "title": "Draft pricing" }))["id"]
            .as_i64()
            .unwrap();
        let b = run(
            &s,
            "add_task",
            json!({ "title": "Review doc", "someday": true }),
        )["id"]
            .as_i64()
            .unwrap();
        // One bad item: nothing changes.
        assert!(fails(&s, "schedule_tasks", json!({ "items": [{ "id": a, "date": "2026-11-02", "time": "09:30" }, { "id": 999, "date": "2026-11-02" }] })).contains("999"));
        assert!(s.get(a).unwrap().due_date.is_none());
        let ctx = Ctx {
            agent: "claude-ai",
            busy: &meetings,
        };
        let r = run_with(
            &s,
            &ctx,
            "schedule_tasks",
            json!({ "items": [
            { "id": a, "date": "2026-11-02", "time": "09:30", "duration": 90 },
            { "id": b, "date": "2026-11-02", "time": "11:15", "duration": 30 }
        ] }),
        );
        assert_eq!(r["scheduled"], 2);
        assert_eq!(task_json(&s.get(a).unwrap())["end_time"], "11:00");
        assert!(!s.get(b).unwrap().someday);
        let log = s.agent_changes(7).unwrap();
        assert_eq!(log.len(), 2);
        assert!(log
            .iter()
            .all(|c| c.batch == log[0].batch && c.kind == "scheduled"));
        s.agent_undo_batch(&log[0].batch).unwrap();
        assert!(s.get(a).unwrap().due_date.is_none());
        assert!(s.get(b).unwrap().someday);
    }
}
