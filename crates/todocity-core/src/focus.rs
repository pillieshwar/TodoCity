//! Focus Blocks: when the Mac's Focus should be on.
//!
//! A focus block is an event on the person's Focus calendar, made in
//! TodoCity's Calendar or in Apple Calendar. When one starts, TodoCity runs the
//! "TodoCity Focus" shortcut, which turns a Focus on *until the block's end*;
//! macOS then turns it off at that time on its own, even if TodoCity is closed
//! or the Mac is asleep.
//!
//! This module is the pure part: given the blocks around now and what happened
//! so far ([`State`]), what to do ([`Action`]). The Mac side
//! (`src-tauri/src/focus.rs`) reads the calendar, runs the shortcut and saves
//! the state. Rules:
//!
//! * Blocks that overlap or touch run as one ([`windows`]), so back-to-back
//!   blocks don't flicker Focus off and on.
//! * A block starts on time, or late (after sleep, or TodoCity opening late)
//!   when at least [`LATE_START_MIN`] minutes are left; otherwise it's missed.
//! * The calendar is the source of truth: a running block whose end moves
//!   moves Focus's end; one that's deleted or moved away turns Focus off.
//! * Something the person ended ("End now") is never started again.

use chrono::{Duration, NaiveDateTime};
use serde::{Deserialize, Serialize};

/// Shorter blocks are ignored.
pub const MIN_BLOCK_MIN: i64 = 5;
/// A block is "on time" within this many minutes of its start.
pub const START_GRACE_MIN: i64 = 2;
/// A block found running late still starts if this much of it is left.
pub const LATE_START_MIN: i64 = 5;
/// How long finished runs are remembered.
pub const KEEP_DAYS: i64 = 2;

/// One focus block occurrence, from the calendar.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Block {
    /// The calendar event's id (shared by a repeating event's occurrences).
    pub id: String,
    pub title: String,
    pub start: NaiveDateTime,
    pub end: NaiveDateTime,
}

impl Block {
    pub fn key(&self) -> String {
        key(&self.id, self.start)
    }
}

/// One occurrence of an event: its id plus its start, to the minute.
pub fn key(id: &str, start: NaiveDateTime) -> String {
    format!("{id}@{}", start.format("%Y-%m-%dT%H:%M"))
}

/// Blocks that run as one Focus.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Window {
    pub ids: Vec<String>,
    pub keys: Vec<String>,
    pub title: String,
    pub start: NaiveDateTime,
    pub end: NaiveDateTime,
}

/// Why a run stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Ended {
    /// It reached its end time (macOS turned Focus off).
    Completed,
    /// The person chose "End now".
    ByYou,
    /// The block was deleted or moved away while it ran.
    Changed,
    /// The Mac was asleep (or TodoCity closed) for nearly all of it.
    Missed,
}

/// The run going on now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Active {
    pub ids: Vec<String>,
    pub keys: Vec<String>,
    pub title: String,
    pub start: NaiveDateTime,
    /// The end macOS was told.
    pub end: NaiveDateTime,
}

/// A run that's over.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Done {
    pub keys: Vec<String>,
    pub title: String,
    pub start: NaiveDateTime,
    pub end: NaiveDateTime,
    pub reason: Ended,
    pub at: NaiveDateTime,
}

/// What's remembered between ticks (saved as `focus.json`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct State {
    pub active: Option<Active>,
    pub done: Vec<Done>,
}

impl State {
    fn is_done(&self, key: &str) -> bool {
        self.done.iter().any(|d| d.keys.iter().any(|k| k == key))
    }

    /// The most recent run that ended, for the wrap-up card.
    pub fn last_done(&self) -> Option<&Done> {
        self.done.iter().max_by_key(|d| d.at)
    }
}

/// What to tell macOS.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    Nothing,
    /// Turn Focus on (or keep it on) until `until`.
    On {
        until: NaiveDateTime,
    },
    Off,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub action: Action,
    pub state: State,
    /// Runs that ended in this step.
    pub finished: Vec<Done>,
}

/// The blocks still to run, merged where they overlap or touch. Tiny blocks
/// and ones already run (or ended, or missed) are left out.
pub fn windows(blocks: &[Block], state: &State) -> Vec<Window> {
    let mut list: Vec<&Block> = blocks
        .iter()
        .filter(|b| b.end - b.start >= Duration::minutes(MIN_BLOCK_MIN))
        .filter(|b| !state.is_done(&b.key()))
        .collect();
    list.sort_by(|a, b| a.start.cmp(&b.start).then(a.end.cmp(&b.end)));
    let mut out: Vec<Window> = Vec::new();
    for b in list {
        if let Some(w) = out.last_mut().filter(|w| b.start <= w.end) {
            w.end = w.end.max(b.end);
            if !w.ids.contains(&b.id) {
                w.ids.push(b.id.clone());
            }
            w.keys.push(b.key());
            continue;
        }
        out.push(Window {
            ids: vec![b.id.clone()],
            keys: vec![b.key()],
            title: b.title.clone(),
            start: b.start,
            end: b.end,
        });
    }
    out
}

/// The next block to start after `now`, if any.
pub fn next(blocks: &[Block], state: &State, now: NaiveDateTime) -> Option<Window> {
    windows(blocks, state).into_iter().find(|w| w.start > now)
}

/// Decide what to do at `now`.
pub fn plan(state: &State, blocks: &[Block], now: NaiveDateTime) -> Step {
    let mut st = state.clone();
    st.done.retain(|d| now - d.end < Duration::days(KEEP_DAYS));
    let mut finished = Vec::new();
    let mut action = Action::Nothing;

    if let Some(a) = st.active.clone() {
        let wins = windows(blocks, &st);
        let same = wins
            .into_iter()
            .find(|w| w.start <= now && now < w.end && w.ids.iter().any(|id| a.ids.contains(id)));
        if let Some(w) = same {
            if w.end != a.end {
                action = Action::On { until: w.end };
            }
            let mut keys = a.keys.clone();
            for k in w.keys {
                if !keys.contains(&k) {
                    keys.push(k);
                }
            }
            st.active = Some(Active {
                ids: w.ids,
                keys,
                title: a.title,
                start: a.start,
                end: w.end,
            });
            return Step {
                action,
                state: st,
                finished,
            };
        }
        // The run is over: it reached its end, or its block went away.
        let reason = if now >= a.end {
            Ended::Completed
        } else {
            action = Action::Off;
            Ended::Changed
        };
        let done = Done {
            keys: a.keys,
            title: a.title,
            start: a.start,
            end: a.end.min(now.max(a.start)),
            reason,
            at: now,
        };
        st.done.push(done.clone());
        finished.push(done);
        st.active = None;
    }

    let current = windows(blocks, &st)
        .into_iter()
        .find(|w| w.start <= now && now < w.end);
    if let Some(w) = current {
        let on_time = now - w.start <= Duration::minutes(START_GRACE_MIN);
        let enough_left = w.end - now >= Duration::minutes(LATE_START_MIN);
        if on_time || enough_left {
            action = Action::On { until: w.end };
            st.active = Some(Active {
                ids: w.ids,
                keys: w.keys,
                title: w.title,
                start: now.max(w.start),
                end: w.end,
            });
        } else {
            st.done.push(Done {
                keys: w.keys,
                title: w.title,
                start: w.start,
                end: w.end,
                reason: Ended::Missed,
                at: now,
            });
        }
    }
    Step {
        action,
        state: st,
        finished,
    }
}

/// "End now": stop the running block and don't start it again.
pub fn end_now(state: &State, now: NaiveDateTime) -> Step {
    let mut st = state.clone();
    let Some(a) = st.active.take() else {
        return Step {
            action: Action::Nothing,
            state: st,
            finished: Vec::new(),
        };
    };
    let done = Done {
        keys: a.keys,
        title: a.title,
        start: a.start,
        end: now.max(a.start).min(a.end),
        reason: Ended::ByYou,
        at: now,
    };
    st.done.push(done.clone());
    Step {
        action: Action::Off,
        state: st,
        finished: vec![done],
    }
}

/// What the shortcut is given: `off`, or the end time in ISO 8601 with the
/// Mac's UTC offset, which Shortcuts reads as a date.
pub fn shortcut_input(action: &Action, offset: chrono::FixedOffset) -> Option<String> {
    match action {
        Action::Nothing => None,
        Action::Off => Some("off".into()),
        Action::On { until } => {
            let local = until.and_local_timezone(offset).single()?;
            Some(local.format("%Y-%m-%dT%H:%M:%S%:z").to_string())
        }
    }
}

/// At most this many tasks are picked for one block.
pub const MAX_TASKS: usize = 10;

impl crate::store::Store {
    /// The tasks picked for a block occurrence (`focus::key`), in order.
    /// Tasks deleted since are left out.
    pub fn focus_tasks(&self, block: &str) -> Result<Vec<i64>, crate::store::StoreError> {
        let mut stmt = self.conn.prepare(
            "SELECT f.task_id FROM focus_tasks f JOIN tasks t ON t.id = f.task_id
             WHERE f.block = ?1 ORDER BY f.position",
        )?;
        let ids = stmt
            .query_map([block], |r| r.get::<_, i64>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(ids)
    }

    /// Pick the tasks for a block occurrence (replacing any picked before).
    pub fn set_focus_tasks(
        &self,
        block: &str,
        ids: &[i64],
    ) -> Result<(), crate::store::StoreError> {
        let tx = self.conn.unchecked_transaction()?;
        tx.execute("DELETE FROM focus_tasks WHERE block = ?1", [block])?;
        let mut seen: Vec<i64> = Vec::new();
        for id in ids {
            if seen.contains(id) || seen.len() >= MAX_TASKS {
                continue;
            }
            seen.push(*id);
            tx.execute(
                "INSERT INTO focus_tasks (block, task_id, position) VALUES (?1, ?2, ?3)",
                rusqlite::params![block, id, seen.len() as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// A block was moved (its start changed): its tasks go with it.
    pub fn move_focus_block(&self, from: &str, to: &str) -> Result<(), crate::store::StoreError> {
        if from == to {
            return Ok(());
        }
        let tx = self.conn.unchecked_transaction()?;
        tx.execute(
            "UPDATE OR IGNORE focus_tasks SET block = ?2 WHERE block = ?1",
            [from, to],
        )?;
        tx.execute("DELETE FROM focus_tasks WHERE block = ?1", [from])?;
        tx.commit()?;
        Ok(())
    }
}

#[cfg(test)]
mod store_tests {
    use crate::store::{NewTask, Store};

    fn add(s: &Store, title: &str) -> i64 {
        s.insert(NewTask {
            title: title.into(),
            ..Default::default()
        })
        .unwrap()
        .id
    }

    #[test]
    fn tasks_are_picked_per_block_in_order() {
        let s = Store::open_in_memory().unwrap();
        let (a, b, c) = (
            add(&s, "Draft the brief"),
            add(&s, "Reply to Maya"),
            add(&s, "Plan"),
        );
        s.set_focus_tasks("ev@2026-11-04T09:00", &[b, a, b])
            .unwrap();
        assert_eq!(s.focus_tasks("ev@2026-11-04T09:00").unwrap(), vec![b, a]);
        assert!(s.focus_tasks("ev@2026-11-05T09:00").unwrap().is_empty());
        s.set_focus_tasks("ev@2026-11-04T09:00", &[c]).unwrap();
        assert_eq!(s.focus_tasks("ev@2026-11-04T09:00").unwrap(), vec![c]);
    }

    #[test]
    fn deleted_tasks_drop_out_and_moves_carry_tasks() {
        let s = Store::open_in_memory().unwrap();
        let (a, b) = (add(&s, "Draft the brief"), add(&s, "Reply to Sam"));
        s.set_focus_tasks("ev@2026-11-04T09:00", &[a, b]).unwrap();
        s.delete(a).unwrap();
        assert_eq!(s.focus_tasks("ev@2026-11-04T09:00").unwrap(), vec![b]);
        s.move_focus_block("ev@2026-11-04T09:00", "ev@2026-11-04T10:00")
            .unwrap();
        assert!(s.focus_tasks("ev@2026-11-04T09:00").unwrap().is_empty());
        assert_eq!(s.focus_tasks("ev@2026-11-04T10:00").unwrap(), vec![b]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    fn at(h: u32, m: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(2026, 11, 4)
            .unwrap()
            .and_hms_opt(h, m, 0)
            .unwrap()
    }

    fn block(id: &str, from: (u32, u32), to: (u32, u32)) -> Block {
        Block {
            id: id.into(),
            title: format!("Focus {id}"),
            start: at(from.0, from.1),
            end: at(to.0, to.1),
        }
    }

    /// Run `plan` at each minute, returning the actions taken (not `Nothing`).
    fn run(blocks: &[Block], from: (u32, u32), to: (u32, u32)) -> (Vec<(String, Action)>, State) {
        let mut st = State::default();
        let mut out = Vec::new();
        let mut t = at(from.0, from.1);
        while t <= at(to.0, to.1) {
            let s = plan(&st, blocks, t);
            if s.action != Action::Nothing {
                out.push((t.format("%H:%M").to_string(), s.action.clone()));
            }
            st = s.state;
            t += Duration::minutes(1);
        }
        (out, st)
    }

    #[test]
    fn a_block_turns_focus_on_once_and_completes() {
        let b = [block("a", (9, 0), (10, 0))];
        let (actions, st) = run(&b, (8, 55), (10, 5));
        assert_eq!(
            actions,
            vec![("09:00".into(), Action::On { until: at(10, 0) })]
        );
        assert!(st.active.is_none());
        assert_eq!(st.last_done().unwrap().reason, Ended::Completed);
    }

    #[test]
    fn back_to_back_blocks_run_as_one() {
        let b = [block("a", (9, 0), (10, 0)), block("b", (10, 0), (11, 0))];
        let w = windows(&b, &State::default());
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].end, at(11, 0));
        let (actions, st) = run(&b, (8, 59), (11, 1));
        assert_eq!(
            actions,
            vec![("09:00".into(), Action::On { until: at(11, 0) })]
        );
        assert_eq!(st.last_done().unwrap().keys.len(), 2);
    }

    #[test]
    fn a_block_added_onto_the_running_one_extends_it() {
        let a = block("a", (9, 0), (10, 0));
        let mut st = plan(&State::default(), std::slice::from_ref(&a), at(9, 0)).state;
        let later = [a, block("b", (10, 0), (10, 30))];
        let s = plan(&st, &later, at(9, 20));
        assert_eq!(s.action, Action::On { until: at(10, 30) });
        st = s.state;
        assert_eq!(st.active.as_ref().unwrap().keys.len(), 2);
    }

    #[test]
    fn moving_the_end_moves_focus() {
        let st = plan(&State::default(), &[block("a", (9, 0), (10, 0))], at(9, 0)).state;
        let s = plan(&st, &[block("a", (9, 0), (10, 15))], at(9, 30));
        assert_eq!(s.action, Action::On { until: at(10, 15) });
        // Nothing more to do on the next tick.
        let s2 = plan(&s.state, &[block("a", (9, 0), (10, 15))], at(9, 31));
        assert_eq!(s2.action, Action::Nothing);
    }

    #[test]
    fn deleting_a_running_block_turns_focus_off() {
        let st = plan(&State::default(), &[block("a", (9, 0), (10, 0))], at(9, 0)).state;
        let s = plan(&st, &[], at(9, 30));
        assert_eq!(s.action, Action::Off);
        assert_eq!(s.finished[0].reason, Ended::Changed);
        assert!(s.state.active.is_none());
    }

    #[test]
    fn moving_a_running_block_later_turns_focus_off_then_on_again() {
        let st = plan(&State::default(), &[block("a", (9, 0), (10, 0))], at(9, 0)).state;
        let moved = [block("a", (11, 0), (12, 0))];
        let s = plan(&st, &moved, at(9, 30));
        assert_eq!(s.action, Action::Off);
        let s = plan(&s.state, &moved, at(11, 0));
        assert_eq!(s.action, Action::On { until: at(12, 0) });
    }

    #[test]
    fn late_starts_need_five_minutes_left() {
        let b = [block("a", (9, 0), (10, 0))];
        // Woke at 9:40: start, keeping the original end.
        let s = plan(&State::default(), &b, at(9, 40));
        assert_eq!(s.action, Action::On { until: at(10, 0) });
        // Woke at 9:57: too late, missed, and not tried again.
        let s = plan(&State::default(), &b, at(9, 57));
        assert_eq!(s.action, Action::Nothing);
        assert_eq!(s.state.done[0].reason, Ended::Missed);
        let s2 = plan(&s.state, &b, at(9, 58));
        assert_eq!(s2.action, Action::Nothing);
        assert!(s2.state.active.is_none());
    }

    #[test]
    fn asleep_across_the_end_just_completes() {
        let b = [block("a", (9, 0), (10, 0))];
        let st = plan(&State::default(), &b, at(9, 0)).state;
        let s = plan(&st, &b, at(13, 0));
        // macOS already ended it; nothing to send.
        assert_eq!(s.action, Action::Nothing);
        assert_eq!(s.finished[0].reason, Ended::Completed);
    }

    #[test]
    fn end_now_is_respected_for_the_rest_of_the_block() {
        let b = [block("a", (9, 0), (10, 0))];
        let st = plan(&State::default(), &b, at(9, 0)).state;
        let s = end_now(&st, at(9, 20));
        assert_eq!(s.action, Action::Off);
        assert_eq!(s.finished[0].reason, Ended::ByYou);
        assert_eq!(s.finished[0].end, at(9, 20));
        let s2 = plan(&s.state, &b, at(9, 21));
        assert_eq!(s2.action, Action::Nothing);
        assert!(s2.state.active.is_none());
    }

    #[test]
    fn end_now_does_not_swallow_the_next_block() {
        let b = [block("a", (9, 0), (10, 0)), block("b", (10, 30), (11, 0))];
        let st = plan(&State::default(), &b, at(9, 0)).state;
        let st = end_now(&st, at(9, 10)).state;
        let s = plan(&st, &b, at(10, 30));
        assert_eq!(s.action, Action::On { until: at(11, 0) });
    }

    #[test]
    fn a_repeating_event_runs_each_occurrence() {
        let monday = block("deep", (9, 0), (10, 0));
        let tuesday = Block {
            start: monday.start + Duration::days(1),
            end: monday.end + Duration::days(1),
            ..monday.clone()
        };
        let both = [monday.clone(), tuesday.clone()];
        let st = plan(&State::default(), &both, at(9, 0)).state;
        let st = plan(&st, &both, at(10, 1)).state;
        let s = plan(&st, &both, tuesday.start);
        assert_eq!(s.action, Action::On { until: tuesday.end });
    }

    #[test]
    fn tiny_blocks_are_ignored() {
        let b = [block("a", (9, 0), (9, 3))];
        assert!(windows(&b, &State::default()).is_empty());
        assert_eq!(
            plan(&State::default(), &b, at(9, 0)).action,
            Action::Nothing
        );
    }

    #[test]
    fn old_runs_are_forgotten() {
        let b = [block("a", (9, 0), (10, 0))];
        let st = plan(&State::default(), &b, at(9, 0)).state;
        let st = plan(&st, &b, at(10, 0)).state;
        assert_eq!(st.done.len(), 1);
        let later = at(10, 0) + Duration::days(3);
        assert!(plan(&st, &[], later).state.done.is_empty());
    }

    #[test]
    fn next_block_is_found() {
        let b = [block("a", (9, 0), (10, 0)), block("b", (13, 0), (14, 0))];
        let n = next(&b, &State::default(), at(11, 0)).unwrap();
        assert_eq!(n.ids, vec!["b".to_string()]);
    }

    #[test]
    fn shortcut_input_carries_the_offset() {
        let pst = chrono::FixedOffset::west_opt(8 * 3600).unwrap();
        assert_eq!(
            shortcut_input(&Action::On { until: at(10, 0) }, pst).as_deref(),
            Some("2026-11-04T10:00:00-08:00")
        );
        assert_eq!(shortcut_input(&Action::Off, pst).as_deref(), Some("off"));
        assert_eq!(shortcut_input(&Action::Nothing, pst), None);
    }

    #[test]
    fn state_round_trips_as_json() {
        let st = plan(&State::default(), &[block("a", (9, 0), (10, 0))], at(9, 0)).state;
        let text = serde_json::to_string(&st).unwrap();
        assert_eq!(serde_json::from_str::<State>(&text).unwrap(), st);
        // An empty or older file reads as the default.
        assert_eq!(
            serde_json::from_str::<State>("{}").unwrap(),
            State::default()
        );
    }
}
