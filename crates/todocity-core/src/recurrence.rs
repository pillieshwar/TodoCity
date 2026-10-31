//! Repeating tasks.
//!
//! A repeating task is an ordinary task with a `recurrence` rule. Completing
//! it creates the next occurrence (see `Store::update`). The next due day is
//! always after *today*, so finishing an overdue daily task late doesn't
//! leave a trail of overdue copies behind it.

use chrono::{Datelike, Duration, NaiveDate, Weekday};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rule {
    Daily,
    Weekdays,
    Weekly,
    Biweekly,
    Monthly,
    Yearly,
}

impl Rule {
    pub const ALL: [Rule; 6] = [
        Rule::Daily,
        Rule::Weekdays,
        Rule::Weekly,
        Rule::Biweekly,
        Rule::Monthly,
        Rule::Yearly,
    ];

    pub fn parse(s: &str) -> Option<Rule> {
        Rule::ALL.into_iter().find(|r| r.as_str() == s)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Rule::Daily => "daily",
            Rule::Weekdays => "weekdays",
            Rule::Weekly => "weekly",
            Rule::Biweekly => "biweekly",
            Rule::Monthly => "monthly",
            Rule::Yearly => "yearly",
        }
    }

    /// One step forward from `d`.
    fn step(self, d: NaiveDate, anchor_day: u32) -> NaiveDate {
        match self {
            Rule::Daily => d + Duration::days(1),
            Rule::Weekdays => {
                let mut n = d + Duration::days(1);
                while matches!(n.weekday(), Weekday::Sat | Weekday::Sun) {
                    n += Duration::days(1);
                }
                n
            }
            Rule::Weekly => d + Duration::days(7),
            Rule::Biweekly => d + Duration::days(14),
            Rule::Monthly => add_months(d, 1, anchor_day),
            Rule::Yearly => add_months(d, 12, anchor_day),
        }
    }
}

/// `d` plus `n` months, on `anchor_day` or the month's last day if shorter
/// (Jan 31 → Feb 28 → Mar 31).
fn add_months(d: NaiveDate, n: u32, anchor_day: u32) -> NaiveDate {
    let total = d.year() * 12 + d.month0() as i32 + n as i32;
    let (y, m0) = (total.div_euclid(12), total.rem_euclid(12) as u32);
    let mut day = anchor_day;
    loop {
        if let Some(nd) = NaiveDate::from_ymd_opt(y, m0 + 1, day) {
            return nd;
        }
        day -= 1;
    }
}

/// The next due day for a repeating task due on `due` (or undated), strictly
/// after `today` and after `due`.
pub fn next_due(rule: Rule, due: Option<NaiveDate>, today: NaiveDate) -> NaiveDate {
    let start = due.unwrap_or(today);
    // Monthly/yearly keep the original day of the month where possible.
    let anchor = start.day();
    let mut d = rule.step(start, anchor);
    // Bounded: daily over decades is still only a few thousand steps.
    for _ in 0..20_000 {
        if d > today {
            break;
        }
        d = rule.step(d, anchor);
    }
    d
}

// ── Custom repeats ─────────────────────────────────────────────────────────
//
// Beyond the six presets above: every N days, weeks, months or years; on
// chosen weekdays; monthly on a day or "the 2nd Tuesday"; from the schedule
// or from when it's finished; ending on a date or after N times. The six
// presets keep their old names when stored, so every version reads them;
// anything else is stored as `rrule:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE`.

/// How often, in what unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Freq {
    Day,
    Week,
    Month,
    Year,
}

/// Which day in a month (monthly and yearly repeats).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonthBy {
    /// Day 1–31 (shorter months use their last day), or -1: the last day.
    Day(i8),
    /// The 1st–4th weekday of the month, or -1: the last one.
    Nth(i8, Weekday),
}

/// A repeat rule: a preset or a custom one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Repeat {
    pub freq: Freq,
    /// Every this many units, 1–99.
    pub interval: u32,
    /// Weekly: which weekdays (bit 0 = Monday … bit 6 = Sunday); 0 means the
    /// series' own weekday.
    pub days: u8,
    /// Monthly and yearly: which day; `None` means the series' own day.
    pub month_by: Option<MonthBy>,
    /// The next one counts from the day it's finished, not the schedule.
    pub after_done: bool,
    /// No occurrences after this day.
    pub until: Option<NaiveDate>,
    /// How many are left, this one included (`Some(1)`: this is the last).
    pub count: Option<u32>,
}

const MON_FRI: u8 = 0b001_1111;
const CODES: [(&str, Weekday); 7] = [
    ("MO", Weekday::Mon),
    ("TU", Weekday::Tue),
    ("WE", Weekday::Wed),
    ("TH", Weekday::Thu),
    ("FR", Weekday::Fri),
    ("SA", Weekday::Sat),
    ("SU", Weekday::Sun),
];

fn bit(w: Weekday) -> u8 {
    1 << w.num_days_from_monday()
}

fn code(w: Weekday) -> &'static str {
    CODES[w.num_days_from_monday() as usize].0
}

fn weekday_of(code: &str) -> Option<Weekday> {
    CODES.iter().find(|(c, _)| *c == code).map(|(_, w)| *w)
}

impl Repeat {
    fn simple(freq: Freq, interval: u32) -> Self {
        Repeat {
            freq,
            interval,
            days: 0,
            month_by: None,
            after_done: false,
            until: None,
            count: None,
        }
    }

    /// A preset as a full rule.
    pub fn preset(rule: Rule) -> Self {
        match rule {
            Rule::Daily => Repeat::simple(Freq::Day, 1),
            Rule::Weekdays => Repeat {
                days: MON_FRI,
                ..Repeat::simple(Freq::Week, 1)
            },
            Rule::Weekly => Repeat::simple(Freq::Week, 1),
            Rule::Biweekly => Repeat::simple(Freq::Week, 2),
            Rule::Monthly => Repeat::simple(Freq::Month, 1),
            Rule::Yearly => Repeat::simple(Freq::Year, 1),
        }
    }

    /// Which preset this is, if it's exactly one.
    pub fn as_preset(&self) -> Option<Rule> {
        Rule::ALL.into_iter().find(|r| Repeat::preset(*r) == *self)
    }

    /// A stored rule: a preset name or `rrule:…`. Anything else is `None`.
    pub fn parse(s: &str) -> Option<Repeat> {
        if let Some(r) = Rule::parse(s) {
            return Some(Repeat::preset(r));
        }
        let body = s.strip_prefix("rrule:")?;
        let mut freq = None;
        let mut r = Repeat::simple(Freq::Day, 1);
        let mut byday: Option<&str> = None;
        let mut bymonthday: Option<i8> = None;
        for part in body.split(';').filter(|p| !p.is_empty()) {
            let (k, v) = part.split_once('=')?;
            match k {
                "FREQ" => {
                    freq = Some(match v {
                        "DAILY" => Freq::Day,
                        "WEEKLY" => Freq::Week,
                        "MONTHLY" => Freq::Month,
                        "YEARLY" => Freq::Year,
                        _ => return None,
                    })
                }
                "INTERVAL" => r.interval = v.parse().ok().filter(|n| (1..=99).contains(n))?,
                "BYDAY" => byday = Some(v),
                "BYMONTHDAY" => {
                    bymonthday = Some(
                        v.parse()
                            .ok()
                            .filter(|n: &i8| (1..=31).contains(n) || *n == -1)?,
                    )
                }
                "UNTIL" => r.until = Some(NaiveDate::parse_from_str(v, "%Y%m%d").ok()?),
                "COUNT" => r.count = Some(v.parse().ok().filter(|n| (1..=999).contains(n))?),
                "FROM" => r.after_done = v == "DONE",
                // Unknown keys from a newer version: keep what we understand.
                _ => {}
            }
        }
        r.freq = freq?;
        match (r.freq, byday) {
            (Freq::Week, Some(list)) => {
                for c in list.split(',') {
                    r.days |= bit(weekday_of(c)?);
                }
            }
            (Freq::Month | Freq::Year, Some(one)) => {
                // "2TU", "-1FR".
                let split = one.len().checked_sub(2)?;
                let (n, c) = one.split_at(split);
                let n: i8 = n.parse().ok().filter(|n| (1..=4).contains(n) || *n == -1)?;
                r.month_by = Some(MonthBy::Nth(n, weekday_of(c)?));
            }
            _ => {}
        }
        if let (Freq::Month | Freq::Year, Some(d)) = (r.freq, bymonthday) {
            r.month_by = Some(MonthBy::Day(d));
        }
        Some(r)
    }

    /// Stored form: the preset's name when it is one, else `rrule:…`.
    pub fn to_stored(&self) -> String {
        if let Some(p) = self.as_preset() {
            return p.as_str().to_string();
        }
        let freq = match self.freq {
            Freq::Day => "DAILY",
            Freq::Week => "WEEKLY",
            Freq::Month => "MONTHLY",
            Freq::Year => "YEARLY",
        };
        let mut out = format!("rrule:FREQ={freq}");
        if self.interval != 1 {
            out.push_str(&format!(";INTERVAL={}", self.interval));
        }
        if self.freq == Freq::Week && self.days != 0 {
            let days: Vec<&str> = CODES
                .iter()
                .filter(|(_, w)| self.days & bit(*w) != 0)
                .map(|(c, _)| *c)
                .collect();
            out.push_str(&format!(";BYDAY={}", days.join(",")));
        }
        if matches!(self.freq, Freq::Month | Freq::Year) {
            match self.month_by {
                Some(MonthBy::Day(d)) => out.push_str(&format!(";BYMONTHDAY={d}")),
                Some(MonthBy::Nth(n, w)) => out.push_str(&format!(";BYDAY={n}{}", code(w))),
                None => {}
            }
        }
        if self.after_done {
            out.push_str(";FROM=DONE");
        }
        if let Some(u) = self.until {
            out.push_str(&format!(";UNTIL={}", u.format("%Y%m%d")));
        }
        if let Some(c) = self.count {
            out.push_str(&format!(";COUNT={c}"));
        }
        out
    }

    /// The rule the next occurrence carries: one fewer left when counted.
    pub fn for_next(&self) -> Repeat {
        Repeat {
            count: self.count.map(|c| c.saturating_sub(1)),
            ..self.clone()
        }
    }

    /// Is this the last one? (Counted down to one.)
    pub fn is_last(&self) -> bool {
        self.count.is_some_and(|c| c <= 1)
    }

    /// The day in `y`-`m` (month 1–12) this rule lands on.
    fn in_month(&self, y: i32, m: u32, anchor: NaiveDate) -> NaiveDate {
        let last = last_day(y, m);
        match self.month_by {
            None => NaiveDate::from_ymd_opt(y, m, anchor.day().min(last)).unwrap_or(anchor),
            Some(MonthBy::Day(d)) => {
                let day = if d < 0 { last } else { (d as u32).min(last) };
                NaiveDate::from_ymd_opt(y, m, day).unwrap_or(anchor)
            }
            Some(MonthBy::Nth(n, w)) => {
                if n < 0 {
                    let end = NaiveDate::from_ymd_opt(y, m, last).unwrap_or(anchor);
                    let back =
                        (end.weekday().num_days_from_monday() + 7 - w.num_days_from_monday()) % 7;
                    end - Duration::days(i64::from(back))
                } else {
                    let first = NaiveDate::from_ymd_opt(y, m, 1).unwrap_or(anchor);
                    let ahead =
                        (w.num_days_from_monday() + 7 - first.weekday().num_days_from_monday()) % 7;
                    first + Duration::days(i64::from(ahead) + 7 * i64::from(n as u32 - 1))
                }
            }
        }
    }

    /// The next day after `after` (and after `anchor`, the series' day for
    /// this one), or from `done_on` for "after I finish". `None` past
    /// `until`. Counts and deadlines are the caller's.
    pub fn next(
        &self,
        anchor: NaiveDate,
        after: NaiveDate,
        done_on: NaiveDate,
    ) -> Option<NaiveDate> {
        let n = self.interval.max(1);
        let next = if self.after_done {
            match self.freq {
                Freq::Day => done_on + Duration::days(i64::from(n)),
                Freq::Week => done_on + Duration::days(7 * i64::from(n)),
                Freq::Month => add_months(done_on, n, done_on.day()),
                Freq::Year => add_months(done_on, 12 * n, done_on.day()),
            }
        } else {
            let from = after.max(anchor);
            match self.freq {
                Freq::Day => {
                    let gap = (from - anchor).num_days() / i64::from(n) + 1;
                    anchor + Duration::days(gap * i64::from(n))
                }
                Freq::Week => {
                    let days = if self.days == 0 {
                        bit(anchor.weekday())
                    } else {
                        self.days
                    };
                    let week = |d: NaiveDate| d.num_days_from_ce().div_euclid(7);
                    // Weeks start on Monday: day 1 of the Common Era was a Monday.
                    let monday = |d: NaiveDate| {
                        d - Duration::days(i64::from(d.weekday().num_days_from_monday()))
                    };
                    let base = week(monday(anchor));
                    let mut d = from + Duration::days(1);
                    let mut found = None;
                    for _ in 0..(7 * 100 + 7) {
                        let on_week = (week(monday(d)) - base).rem_euclid(n as i32) == 0;
                        if on_week && days & bit(d.weekday()) != 0 {
                            found = Some(d);
                            break;
                        }
                        d += Duration::days(1);
                    }
                    found?
                }
                Freq::Month | Freq::Year => {
                    let step = if self.freq == Freq::Month { n } else { 12 * n };
                    let start = anchor.year() * 12 + anchor.month0() as i32;
                    let mut found = None;
                    for k in 0..1200 {
                        let total = start + (k * step) as i32;
                        let d = self.in_month(
                            total.div_euclid(12),
                            total.rem_euclid(12) as u32 + 1,
                            anchor,
                        );
                        if d > from {
                            found = Some(d);
                            break;
                        }
                    }
                    found?
                }
            }
        };
        if self.until.is_some_and(|u| next > u) {
            return None;
        }
        Some(next)
    }

    /// Up to `n` days this repeat lands on, from `start` (itself included),
    /// stopping at `until`, a count or `end` (a deadline). For previews.
    pub fn upcoming(&self, start: NaiveDate, end: Option<NaiveDate>, n: usize) -> Vec<NaiveDate> {
        let mut out = vec![start];
        let mut rule = self.clone();
        let mut d = start;
        while out.len() < n && !rule.is_last() {
            let Some(next) = rule.next(d, d, d) else {
                break;
            };
            if end.is_some_and(|e| next > e) {
                break;
            }
            out.push(next);
            rule = rule.for_next();
            d = next;
        }
        out
    }
}

fn last_day(y: i32, m: u32) -> u32 {
    (28..=31)
        .rev()
        .find(|d| NaiveDate::from_ymd_opt(y, m, *d).is_some())
        .unwrap_or(28)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(s: &str) -> NaiveDate {
        NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }

    #[test]
    fn parses_every_rule() {
        for r in Rule::ALL {
            assert_eq!(Rule::parse(r.as_str()), Some(r));
        }
        assert_eq!(Rule::parse("hourly"), None);
    }

    #[test]
    fn steps_forward_from_the_due_day() {
        let today = d("2026-10-14"); // Wednesday
        assert_eq!(next_due(Rule::Daily, Some(today), today), d("2026-10-15"));
        assert_eq!(next_due(Rule::Weekly, Some(today), today), d("2026-10-21"));
        assert_eq!(
            next_due(Rule::Biweekly, Some(today), today),
            d("2026-10-28")
        );
        assert_eq!(next_due(Rule::Monthly, Some(today), today), d("2026-11-14"));
        assert_eq!(next_due(Rule::Yearly, Some(today), today), d("2027-10-14"));
    }

    #[test]
    fn weekdays_skip_the_weekend() {
        let fri = d("2026-10-16");
        assert_eq!(next_due(Rule::Weekdays, Some(fri), fri), d("2026-10-19"));
    }

    #[test]
    fn late_completion_lands_after_today() {
        // Weekly on Mondays, completed on Wednesday nine days late.
        assert_eq!(
            next_due(Rule::Weekly, Some(d("2026-10-05")), d("2026-10-14")),
            d("2026-10-19")
        );
        assert_eq!(
            next_due(Rule::Daily, Some(d("2026-01-01")), d("2026-10-14")),
            d("2026-10-15")
        );
    }

    #[test]
    fn early_completion_moves_one_step() {
        // Due next Monday, done today: next is the Monday after.
        assert_eq!(
            next_due(Rule::Weekly, Some(d("2026-10-19")), d("2026-10-14")),
            d("2026-10-26")
        );
    }

    #[test]
    fn month_end_is_clamped() {
        let jan31 = d("2027-01-31");
        assert_eq!(next_due(Rule::Monthly, Some(jan31), jan31), d("2027-02-28"));
        assert_eq!(
            next_due(Rule::Yearly, Some(d("2028-02-29")), d("2028-02-29")),
            d("2029-02-28")
        );
    }

    #[test]
    fn undated_starts_from_today() {
        let today = d("2026-10-14");
        assert_eq!(next_due(Rule::Daily, None, today), d("2026-10-15"));
    }

    #[test]
    fn presets_keep_their_names() {
        for r in Rule::ALL {
            let full = Repeat::parse(r.as_str()).unwrap();
            assert_eq!(full.to_stored(), r.as_str());
        }
        // A custom rule that is exactly a preset is stored as the preset.
        let same = Repeat::parse("rrule:FREQ=WEEKLY;INTERVAL=2").unwrap();
        assert_eq!(same.to_stored(), "biweekly");
        assert_eq!(Repeat::parse("hourly"), None);
        assert_eq!(Repeat::parse("rrule:FREQ=HOURLY"), None);
        assert_eq!(Repeat::parse("rrule:FREQ=DAILY;INTERVAL=0"), None);
    }

    #[test]
    fn custom_rules_round_trip() {
        for s in [
            "rrule:FREQ=DAILY;INTERVAL=3",
            "rrule:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
            "rrule:FREQ=MONTHLY;BYDAY=2TU;COUNT=6",
            "rrule:FREQ=MONTHLY;BYDAY=-1FR",
            "rrule:FREQ=MONTHLY;BYMONTHDAY=-1",
            "rrule:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15;UNTIL=20271231",
            "rrule:FREQ=WEEKLY;FROM=DONE",
            "rrule:FREQ=YEARLY;BYDAY=4TH",
        ] {
            assert_eq!(Repeat::parse(s).unwrap().to_stored(), s, "{s}");
        }
        // Keys from a newer version are ignored, not fatal.
        assert!(Repeat::parse("rrule:FREQ=DAILY;X-NEW=1").is_some());
    }

    #[test]
    fn every_other_monday_and_wednesday() {
        let r = Repeat::parse("rrule:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE").unwrap();
        let mon = d("2026-11-02");
        assert_eq!(r.next(mon, mon, mon), Some(d("2026-11-04")));
        let wed = d("2026-11-04");
        assert_eq!(r.next(wed, wed, wed), Some(d("2026-11-16")));
        let days = r.upcoming(mon, Some(d("2026-12-18")), 20);
        assert_eq!(days.len(), 8);
        assert_eq!(*days.last().unwrap(), d("2026-12-16"));
    }

    #[test]
    fn monthly_by_weekday_and_last_day() {
        let second_tue = Repeat::parse("rrule:FREQ=MONTHLY;BYDAY=2TU").unwrap();
        let nov10 = d("2026-11-10");
        assert_eq!(second_tue.next(nov10, nov10, nov10), Some(d("2026-12-08")));
        let last_fri = Repeat::parse("rrule:FREQ=MONTHLY;BYDAY=-1FR").unwrap();
        let oct30 = d("2026-10-30");
        assert_eq!(last_fri.next(oct30, oct30, oct30), Some(d("2026-11-27")));
        let last_day = Repeat::parse("rrule:FREQ=MONTHLY;BYMONTHDAY=-1").unwrap();
        let jan31 = d("2027-01-31");
        assert_eq!(last_day.next(jan31, jan31, jan31), Some(d("2027-02-28")));
        let feb = d("2027-02-28");
        assert_eq!(last_day.next(feb, feb, feb), Some(d("2027-03-31")));
        let quarterly = Repeat::parse("rrule:FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=15").unwrap();
        let jan15 = d("2027-01-15");
        assert_eq!(quarterly.next(jan15, jan15, jan15), Some(d("2027-04-15")));
    }

    #[test]
    fn late_and_early_finishes_stay_on_the_schedule() {
        let r = Repeat::parse("rrule:FREQ=DAILY;INTERVAL=3").unwrap();
        // Due Oct 1, finished Oct 14: the next is on the 3-day rhythm after today.
        assert_eq!(
            r.next(d("2026-10-01"), d("2026-10-14"), d("2026-10-14")),
            Some(d("2026-10-16"))
        );
        // Due next week, finished today: one step on from its day.
        assert_eq!(
            r.next(d("2026-10-20"), d("2026-10-20"), d("2026-10-14")),
            Some(d("2026-10-23"))
        );
    }

    #[test]
    fn after_i_finish_counts_from_the_finish() {
        let r = Repeat::parse("rrule:FREQ=WEEKLY;INTERVAL=2;FROM=DONE").unwrap();
        assert_eq!(
            r.next(d("2026-10-01"), d("2026-10-14"), d("2026-10-14")),
            Some(d("2026-10-28"))
        );
    }

    #[test]
    fn until_and_count_end_the_series() {
        let r = Repeat::parse("rrule:FREQ=WEEKLY;UNTIL=20261115").unwrap();
        let sat = d("2026-11-07");
        assert_eq!(r.next(sat, sat, sat), Some(d("2026-11-14")));
        let next = d("2026-11-14");
        assert_eq!(r.next(next, next, next), None);
        let counted = Repeat::parse("rrule:FREQ=DAILY;COUNT=2").unwrap();
        assert!(!counted.is_last());
        assert!(counted.for_next().is_last());
        assert_eq!(counted.for_next().to_stored(), "rrule:FREQ=DAILY;COUNT=1");
        assert_eq!(counted.upcoming(sat, None, 10).len(), 2);
    }

    #[test]
    fn presets_match_the_old_steps() {
        let today = d("2026-10-14");
        for (rule, want) in [
            (Rule::Daily, "2026-10-15"),
            (Rule::Weekly, "2026-10-21"),
            (Rule::Biweekly, "2026-10-28"),
            (Rule::Monthly, "2026-11-14"),
            (Rule::Yearly, "2027-10-14"),
        ] {
            assert_eq!(
                Repeat::preset(rule).next(today, today, today),
                Some(d(want)),
                "{rule:?}"
            );
            assert_eq!(next_due(rule, Some(today), today), d(want));
        }
        let fri = d("2026-10-16");
        assert_eq!(
            Repeat::preset(Rule::Weekdays).next(fri, fri, fri),
            Some(d("2026-10-19"))
        );
        // Late weekly on Mondays.
        let mon = d("2026-10-05");
        assert_eq!(
            Repeat::preset(Rule::Weekly).next(mon, d("2026-10-14"), d("2026-10-14")),
            Some(d("2026-10-19"))
        );
    }
}
