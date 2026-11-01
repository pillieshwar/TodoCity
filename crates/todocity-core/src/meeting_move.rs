//! Moving a calendar meeting from TodoCity: which meetings may move, and the
//! checks on a new time. The Mac side (`src-tauri/src/calendar.rs`) reads the
//! facts from EventKit and saves the move there; Calendar then syncs it to
//! iCloud, Google or Outlook like any edit made in the Calendar app.

use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

/// Whether TodoCity lets a meeting move.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Movable {
    /// Your own event with no guests: moves straight away.
    Yes,
    /// A meeting you organize: moves after "Move for everyone?", and the
    /// guests get an update.
    Everyone,
    /// Stays put: an invite from someone else, a read-only or subscribed
    /// calendar (holidays, birthdays), an all-day event, or one of TodoCity's
    /// own calendars (those are tasks; move the task).
    No,
}

/// What EventKit says about one event.
#[derive(Debug, Clone, Copy, Default)]
pub struct EventFacts {
    /// The calendar allows changes (`allowsContentModifications`).
    pub can_edit: bool,
    pub all_day: bool,
    /// It has guests (`hasAttendees`).
    pub has_guests: bool,
    /// You are its organizer (`organizer.isCurrentUser`).
    pub i_organize: bool,
    /// It's in a `TodoCity · …` calendar.
    pub todocity: bool,
}

pub fn movable(f: EventFacts) -> Movable {
    if !f.can_edit || f.all_day || f.todocity {
        Movable::No
    } else if !f.has_guests {
        Movable::Yes
    } else if f.i_organize {
        Movable::Everyone
    } else {
        Movable::No
    }
}

/// The shortest and longest a moved meeting can be, in minutes.
pub const MIN_MINUTES: i64 = 5;
pub const MAX_MINUTES: i64 = 24 * 60;

/// Checks a new start and end before saving: the end after the start, and a
/// length from 5 minutes to a day.
pub fn check_times(start: NaiveDateTime, end: NaiveDateTime) -> Result<(), String> {
    let minutes = (end - start).num_minutes();
    if minutes < MIN_MINUTES {
        return Err("A meeting needs at least 5 minutes.".into());
    }
    if minutes > MAX_MINUTES {
        return Err("Move a meeting of up to a day from here; longer ones in Calendar.".into());
    }
    Ok(())
}

/// Whether a move is allowed now: `everyone` is the person's answer to
/// "Move for everyone?" (always needed for meetings with guests).
pub fn allowed(m: Movable, everyone: bool) -> Result<(), String> {
    match m {
        Movable::Yes => Ok(()),
        Movable::Everyone if everyone => Ok(()),
        Movable::Everyone => Err("Confirm moving this meeting for everyone first.".into()),
        Movable::No => Err("Change this one in Calendar.".into()),
    }
}

/// Parses TodoCity's local time format, `YYYY-MM-DDTHH:MM[:SS]`.
pub fn parse_local(s: &str) -> Result<NaiveDateTime, String> {
    NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M"))
        .map_err(|_| format!("Not a time: {s}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn facts() -> EventFacts {
        EventFacts {
            can_edit: true,
            ..Default::default()
        }
    }

    #[test]
    fn own_events_move_and_organized_meetings_ask() {
        assert_eq!(movable(facts()), Movable::Yes);
        let organized = EventFacts {
            has_guests: true,
            i_organize: true,
            ..facts()
        };
        assert_eq!(movable(organized), Movable::Everyone);
    }

    #[test]
    fn invites_read_only_all_day_and_todocity_stay_put() {
        let invite = EventFacts {
            has_guests: true,
            ..facts()
        };
        assert_eq!(movable(invite), Movable::No);
        assert_eq!(
            movable(EventFacts::default()),
            Movable::No,
            "holidays, birthdays"
        );
        let all_day = EventFacts {
            all_day: true,
            ..facts()
        };
        assert_eq!(movable(all_day), Movable::No);
        let ours = EventFacts {
            todocity: true,
            ..facts()
        };
        assert_eq!(movable(ours), Movable::No);
    }

    #[test]
    fn meetings_with_guests_need_the_ok() {
        assert!(allowed(Movable::Yes, false).is_ok());
        assert!(allowed(Movable::Everyone, false).is_err());
        assert!(allowed(Movable::Everyone, true).is_ok());
        assert!(allowed(Movable::No, true).is_err());
    }

    #[test]
    fn times_are_checked() {
        let t = |s| parse_local(s).unwrap();
        assert!(check_times(t("2026-11-02T10:00"), t("2026-11-02T10:30")).is_ok());
        assert!(
            check_times(t("2026-11-02T23:30:00"), t("2026-11-03T00:15:00")).is_ok(),
            "past midnight"
        );
        assert!(check_times(t("2026-11-02T10:00"), t("2026-11-02T10:00")).is_err());
        assert!(check_times(t("2026-11-02T10:00"), t("2026-11-02T09:00")).is_err());
        assert!(check_times(t("2026-11-02T10:00"), t("2026-11-03T10:01")).is_err());
        assert!(parse_local("tomorrow").is_err());
    }
}
