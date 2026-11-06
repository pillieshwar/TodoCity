//! Slack Secretary: a macOS background task (a LaunchAgent) that checks
//! Slack every five minutes, whether TodoCity is open or not.
//!
//! - launchd starts `TodoCity --slack-secretary` every [`INTERVAL_S`] and at
//!   login. Each run asks the person's agent about the time since the last
//!   good run ([`plan`]), so after the Mac was off or asleep for hours, it
//!   catches up on those hours (a few at a time, up to [`MAX_CATCH_UP_MS`]).
//! - It looks wider than the in-app check: DMs, group DMs and every channel
//!   the person is in ([`slack::Reach::Everything`]), and each task gets a
//!   priority.
//! - It never writes the task database. What it finds goes, one JSON line
//!   each, into a queue file ([`QueueLine`]) that TodoCity adds to the Inbox
//!   when it's running (within seconds) or next opens, so TodoCity stays the
//!   only writer and sync stays safe.
//!
//! Files in the data folder: [`CONFIG_FILE`] (written by the app: which
//! agent and tools), [`STATE_FILE`] (written by the background task: where
//! it's up to) and [`QUEUE_FILE`].
//!
//! Pure: the app and the background task do the reading, writing and running.

use serde::{Deserialize, Serialize};

use crate::slack::{self, Item};

/// The LaunchAgent's label (the bundle id's, so it reads as TodoCity's).
pub const LABEL: &str = "app.pluck.desktop.slack-secretary";
/// launchd starts it this often (seconds).
pub const INTERVAL_S: u32 = 300;
pub const CONFIG_FILE: &str = "slack-secretary.json";
pub const STATE_FILE: &str = "slack-secretary-state.json";
pub const QUEUE_FILE: &str = "slack-secretary-inbox.jsonl";
pub const LOCK_FILE: &str = "slack-secretary.lock";
/// The command-line switch that runs one check.
pub const FLAG: &str = "--slack-secretary";

/// Longest time looked back after the Mac was off (older messages are left).
pub const MAX_CATCH_UP_MS: i64 = 7 * 24 * 60 * 60_000;
/// Each question to the agent covers at most this long.
pub const CHUNK_MS: i64 = 6 * 60 * 60_000;
/// Questions per run; a longer gap carries on in the next runs.
pub const MAX_WINDOWS_PER_RUN: usize = 4;
/// A run started less than this after the last good one does nothing
/// (launchd can start one at login right after a timed one).
pub const MIN_GAP_MS: i64 = 4 * 60_000;
/// A lock older than this is from a run that didn't finish.
pub const LOCK_STALE_MS: i64 = 30 * 60_000;
/// Message keys remembered.
pub const SEEN_MAX: usize = 5000;

/// What the app tells the background task (it reads, never writes this).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Config {
    /// The agent that reads Slack, by `agent_runs` id.
    pub agent: String,
    /// Its Slack tools that read (Claude Code runs with only these).
    pub tools: Vec<String>,
    /// Look from here on a first run (Unix ms): where the in-app check was.
    pub start_ms: i64,
}

/// Where the background task is up to (it writes this; the app reads it).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct RunState {
    /// Messages up to here (Unix ms) have been looked at.
    pub cursor_ms: i64,
    pub last_run_ms: i64,
    pub last_ok_ms: i64,
    pub failures: u32,
    pub last_error: Option<String>,
    /// Tasks found, all time.
    pub found: u64,
    /// Messages already handed over (`channel:ts`), newest last.
    pub seen: Vec<String>,
    /// How far back it's still catching up (ms), 0 when up to date.
    pub behind_ms: i64,
}

/// One line in the queue.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum QueueLine {
    /// A message that needs the person.
    Item { at_ms: i64, item: Item },
    /// What a run did, for the agent panel's Activity tab.
    Note {
        at_ms: i64,
        kind: String,
        text: String,
    },
}

impl QueueLine {
    /// The line as written to the queue (JSON and a newline).
    pub fn to_line(&self) -> String {
        let mut s = serde_json::to_string(self).unwrap_or_default();
        s.push('\n');
        s
    }
}

/// The queue's lines, skipping any that aren't whole (a run cut off).
pub fn read_queue(text: &str) -> Vec<QueueLine> {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// What one run should do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// The time spans to ask about, oldest first, back to back.
    pub windows: Vec<(i64, i64)>,
    /// Older time left out (the Mac was off longer than [`MAX_CATCH_UP_MS`]).
    pub skipped_ms: i64,
    /// How long it hadn't looked, before this run.
    pub gap_ms: i64,
}

/// What to look at now: from just before where the last good run ended
/// (or the app's start, on a first run) to now, in chunks.
pub fn plan(state: &RunState, config: &Config, now_ms: i64) -> Plan {
    let from = if state.cursor_ms > 0 {
        state.cursor_ms
    } else if config.start_ms > 0 {
        config.start_ms
    } else {
        now_ms - slack::EVERY_MS
    };
    let gap_ms = (now_ms - from).max(0);
    let mut start = (from - slack::OVERLAP_MS).min(now_ms);
    let oldest = now_ms - MAX_CATCH_UP_MS;
    let mut skipped_ms = 0;
    if start < oldest {
        skipped_ms = oldest - start;
        start = oldest;
    }
    let mut windows = Vec::new();
    while start < now_ms && windows.len() < MAX_WINDOWS_PER_RUN {
        let end = (start + CHUNK_MS).min(now_ms);
        windows.push((start, end));
        start = end;
    }
    Plan {
        windows,
        skipped_ms,
        gap_ms,
    }
}

/// Whether a run should look now: not right after a good one, and after
/// failures, not before [`slack::retry_gap`].
pub fn should_run(state: &RunState, now_ms: i64) -> bool {
    if state.last_ok_ms > 0 && now_ms - state.last_ok_ms < MIN_GAP_MS && state.behind_ms == 0 {
        return false;
    }
    if state.failures > 0 {
        let wait = slack::retry_gap(state.failures).max(MIN_GAP_MS);
        return now_ms - state.last_run_ms >= wait;
    }
    true
}

/// A window was looked at: keep what's new (not handed over before), move
/// on to `covered_until`. Returns the new items.
pub fn record_ok(
    state: &mut RunState,
    items: Vec<Item>,
    covered_until_ms: i64,
    now_ms: i64,
) -> Vec<Item> {
    let mut fresh = Vec::new();
    for i in items {
        if state.seen.iter().any(|k| k == &i.key) || fresh.iter().any(|f: &Item| f.key == i.key) {
            continue;
        }
        state.seen.push(i.key.clone());
        fresh.push(i);
    }
    if state.seen.len() > SEEN_MAX {
        let cut = state.seen.len() - SEEN_MAX;
        state.seen.drain(..cut);
    }
    state.found += fresh.len() as u64;
    state.cursor_ms = state.cursor_ms.max(covered_until_ms);
    state.last_ok_ms = now_ms;
    state.failures = 0;
    state.last_error = None;
    state.behind_ms = (now_ms - state.cursor_ms - slack::EVERY_MS).max(0);
    fresh
}

/// A window failed: the next run asks about it again, after a while.
pub fn record_err(state: &mut RunState, error: &str) {
    state.failures = state.failures.saturating_add(1);
    state.last_error = Some(error.chars().take(300).collect());
}

/// "3 h 20 min", "45 min", "2 days".
pub fn gap_text(ms: i64) -> String {
    let min = (ms / 60_000).max(0);
    if min < 60 {
        return format!("{min} min");
    }
    let h = min / 60;
    if h < 48 {
        let m = min % 60;
        return if m == 0 {
            format!("{h} h")
        } else {
            format!("{h} h {m} min")
        };
    }
    format!("{} days", h / 24)
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

/// The LaunchAgent: runs `exe --slack-secretary` at login and every
/// [`INTERVAL_S`], as a low-priority background job, logging to `log`.
pub fn launch_agent_plist(exe: &str, shell: &str, home: &str, log: &str) -> String {
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>{label}</string>
	<key>ProgramArguments</key>
	<array>
		<string>{exe}</string>
		<string>{flag}</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>StartInterval</key>
	<integer>{interval}</integer>
	<key>ProcessType</key>
	<string>Background</string>
	<key>LowPriorityIO</key>
	<true/>
	<key>EnvironmentVariables</key>
	<dict>
		<key>HOME</key>
		<string>{home}</string>
		<key>SHELL</key>
		<string>{shell}</string>
	</dict>
	<key>StandardOutPath</key>
	<string>{log}</string>
	<key>StandardErrorPath</key>
	<string>{log}</string>
</dict>
</plist>
"#,
        label = LABEL,
        exe = xml(exe),
        flag = FLAG,
        interval = INTERVAL_S,
        home = xml(home),
        shell = xml(shell),
        log = xml(log),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;
    const HOUR: i64 = 60 * MIN;
    const NOW: i64 = 1_762_300_000_000;

    fn item(key: &str) -> Item {
        Item {
            key: key.into(),
            title: format!("Task {key}"),
            due_date: None,
            from: Some("Sam".into()),
            url: None,
            priority: 2,
            place: Some("#launch".into()),
        }
    }

    #[test]
    fn a_first_run_starts_where_the_in_app_check_was() {
        let cfg = Config {
            start_ms: NOW - 20 * MIN,
            ..Config::default()
        };
        let p = plan(&RunState::default(), &cfg, NOW);
        assert_eq!(p.windows, vec![(NOW - 20 * MIN - slack::OVERLAP_MS, NOW)]);
        assert_eq!(p.gap_ms, 20 * MIN);
        // No start known: one interval back.
        let p = plan(&RunState::default(), &Config::default(), NOW);
        assert_eq!(
            p.windows,
            vec![(NOW - slack::EVERY_MS - slack::OVERLAP_MS, NOW)]
        );
    }

    #[test]
    fn after_the_mac_was_off_it_catches_up_on_those_hours() {
        // Off for 9 hours: two windows, back to back, from the last good run.
        let state = RunState {
            cursor_ms: NOW - 9 * HOUR,
            ..RunState::default()
        };
        let p = plan(&state, &Config::default(), NOW);
        assert_eq!(p.gap_ms, 9 * HOUR);
        assert_eq!(p.windows.len(), 2);
        assert_eq!(p.windows[0].0, NOW - 9 * HOUR - slack::OVERLAP_MS);
        assert_eq!(p.windows[0].1, p.windows[1].0);
        assert_eq!(p.windows[1].1, NOW);
        assert_eq!(p.skipped_ms, 0);
    }

    #[test]
    fn a_long_gap_carries_on_over_runs_and_nothing_between_is_missed() {
        let cfg = Config::default();
        let mut state = RunState {
            cursor_ms: NOW - 3 * 24 * HOUR,
            ..RunState::default()
        };
        let mut now = NOW;
        let mut covered: Vec<(i64, i64)> = Vec::new();
        for _ in 0..10 {
            if !should_run(&state, now) {
                now += slack::EVERY_MS;
                continue;
            }
            let p = plan(&state, &cfg, now);
            for w in &p.windows {
                covered.push(*w);
                record_ok(&mut state, vec![], w.1, now);
            }
            state.last_run_ms = now;
            now += slack::EVERY_MS;
        }
        assert!(covered.len() > MAX_WINDOWS_PER_RUN, "more than one run");
        for w in covered.windows(2) {
            assert!(w[1].0 <= w[0].1, "no hole between {w:?}");
        }
        assert!(state.cursor_ms >= NOW);
        assert_eq!(state.behind_ms, 0);
    }

    #[test]
    fn more_than_a_week_off_leaves_the_oldest_out_and_says_so() {
        let state = RunState {
            cursor_ms: NOW - 10 * 24 * HOUR,
            ..RunState::default()
        };
        let p = plan(&state, &Config::default(), NOW);
        assert_eq!(p.windows[0].0, NOW - MAX_CATCH_UP_MS);
        assert!(p.skipped_ms > 2 * 24 * HOUR);
        assert_eq!(p.windows.len(), MAX_WINDOWS_PER_RUN);
    }

    #[test]
    fn runs_wait_after_a_good_one_and_back_off_after_failures() {
        let ok = RunState {
            last_ok_ms: NOW - 2 * MIN,
            cursor_ms: NOW - 2 * MIN,
            ..RunState::default()
        };
        assert!(!should_run(&ok, NOW));
        assert!(should_run(&ok, NOW + 3 * MIN));
        // Still catching up: carry on straight away.
        let behind = RunState {
            behind_ms: HOUR,
            ..ok.clone()
        };
        assert!(should_run(&behind, NOW));
        let mut bad = RunState {
            last_run_ms: NOW,
            ..RunState::default()
        };
        record_err(&mut bad, "Codex didn't answer.");
        record_err(&mut bad, "Codex didn't answer.");
        assert!(!should_run(&bad, NOW + 5 * MIN));
        assert!(should_run(&bad, NOW + 10 * MIN));
        assert_eq!(bad.last_error.as_deref(), Some("Codex didn't answer."));
    }

    #[test]
    fn each_message_is_handed_over_once() {
        let mut s = RunState::default();
        let first = record_ok(
            &mut s,
            vec![item("C1:1.1"), item("C1:1.1"), item("D1:2.2")],
            NOW,
            NOW,
        );
        assert_eq!(first.len(), 2);
        let again = record_ok(&mut s, vec![item("C1:1.1"), item("C2:3.3")], NOW, NOW);
        assert_eq!(
            again.iter().map(|i| i.key.as_str()).collect::<Vec<_>>(),
            vec!["C2:3.3"]
        );
        assert_eq!(s.found, 3);
        // The cursor never goes back.
        record_ok(&mut s, vec![], NOW - HOUR, NOW);
        assert_eq!(s.cursor_ms, NOW);
    }

    #[test]
    fn the_queue_round_trips_and_skips_broken_lines() {
        let lines = [
            QueueLine::Item {
                at_ms: NOW,
                item: item("C1:1.1"),
            },
            QueueLine::Note {
                at_ms: NOW,
                kind: "ok".into(),
                text: "Nothing new".into(),
            },
        ];
        let mut text: String = lines.iter().map(QueueLine::to_line).collect();
        text.push_str("{\"type\":\"item\",\"at_ms\":");
        let back = read_queue(&text);
        assert_eq!(back, lines.to_vec());
    }

    #[test]
    fn says_how_long_in_plain_words() {
        assert_eq!(gap_text(45 * MIN), "45 min");
        assert_eq!(gap_text(3 * HOUR), "3 h");
        assert_eq!(gap_text(9 * HOUR + 20 * MIN), "9 h 20 min");
        assert_eq!(gap_text(3 * 24 * HOUR), "3 days");
    }

    #[test]
    fn the_launch_agent_runs_the_check_every_five_minutes_and_at_login() {
        let p = launch_agent_plist(
            "/Applications/TodoCity.app/Contents/MacOS/todocity",
            "/bin/zsh",
            "/Users/sam & co",
            "/Users/sam/Library/Logs/TodoCity/slack-secretary.log",
        );
        assert!(p.contains("<string>app.pluck.desktop.slack-secretary</string>"));
        assert!(p.contains("<string>--slack-secretary</string>"));
        assert!(p.contains("<key>StartInterval</key>\n\t<integer>300</integer>"));
        assert!(p.contains("<key>RunAtLoad</key>\n\t<true/>"));
        assert!(p.contains("/Users/sam &amp; co"), "paths are escaped");
        assert!(!p.contains("sam & co"));
    }
}
