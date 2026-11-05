//! What TodoCity's agents are doing in the background, as short lines the
//! agent panel shows in its Activity tab: connecting an agent, checking
//! Slack, tasks added. Kept in memory (the last few hundred lines), never
//! written to disk.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

const KEEP: usize = 300;

#[derive(Debug, Clone, Serialize)]
pub struct Entry {
    pub id: u64,
    /// Local `YYYY-MM-DDTHH:MM:SS`.
    pub at: String,
    /// "slack", "agents".
    pub source: &'static str,
    /// The agent involved, by id.
    pub agent: Option<String>,
    /// "info", "working", "ok", "added", "error".
    pub kind: &'static str,
    pub text: String,
}

#[derive(Default)]
pub struct Activity {
    inner: Mutex<(u64, VecDeque<Entry>)>,
}

/// Add a line and tell every window.
pub fn log(
    app: &AppHandle,
    source: &'static str,
    agent: Option<&str>,
    kind: &'static str,
    text: impl Into<String>,
) {
    let entry = {
        let activity = app.state::<Activity>();
        let mut g = activity.inner.lock().unwrap_or_else(|e| e.into_inner());
        g.0 += 1;
        let entry = Entry {
            id: g.0,
            at: chrono::Local::now().format("%Y-%m-%dT%H:%M:%S").to_string(),
            source,
            agent: agent.map(str::to_string),
            kind,
            text: text.into(),
        };
        g.1.push_back(entry.clone());
        while g.1.len() > KEEP {
            g.1.pop_front();
        }
        entry
    };
    let _ = app.emit("agent-console", entry);
}

/// Everything kept, oldest first.
#[tauri::command]
pub fn agent_console(activity: State<'_, Activity>) -> Vec<Entry> {
    let g = activity.inner.lock().unwrap_or_else(|e| e.into_inner());
    g.1.iter().cloned().collect()
}

#[tauri::command]
pub fn agent_console_clear(app: AppHandle, activity: State<'_, Activity>) {
    activity
        .inner
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .1
        .clear();
    let _ = app.emit("agent-console-cleared", ());
}
