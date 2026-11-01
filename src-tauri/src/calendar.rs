//! Calendar connector (macOS): read the events in the Mac's Calendar app so
//! TodoCity can show them next to tasks.
//!
//! Read-only and local. Events come from EventKit, the same store the Calendar
//! app uses, so Google, Outlook and iCloud calendars that are added to the Mac
//! show up too, without TodoCity signing in anywhere or using the network.
//!
//! One worker thread owns a single, long-lived `EKEventStore`. A fresh store
//! loads subscribed calendars (Holidays, Birthdays) and remote accounts in the
//! background, so an early query can miss them; keeping one store warm, asking
//! it to refresh, and re-querying when it posts `EKEventStoreChangedNotification`
//! is what makes results consistent.

#![cfg_attr(not(target_os = "macos"), allow(dead_code, unused_imports))]

use serde::Serialize;
use tauri::AppHandle;
use todocity_core::meeting_move::Movable;

use crate::reminders::Access;

#[derive(Debug, Clone, Serialize)]
pub struct CalendarInfo {
    pub id: String,
    /// Stable name for remembering the user's choice: `Account / Title`.
    /// (macOS can change a subscribed calendar's id after a sync; its name
    /// stays the same.)
    pub key: String,
    pub title: String,
    /// The account it belongs to: "iCloud", "Google", "On My Mac"…
    pub source: String,
    /// `#rrggbb`, the colour the Calendar app uses for it.
    pub color: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EventInfo {
    pub id: String,
    pub title: String,
    /// Local `YYYY-MM-DDTHH:MM:SS`.
    pub start: String,
    pub end: String,
    pub all_day: bool,
    pub calendar: String,
    pub color: Option<String>,
    /// Whether it can be moved from TodoCity (`meeting_move::movable`).
    pub movable: Movable,
}

#[derive(Debug, Clone, Serialize)]
pub struct Status {
    pub supported: bool,
    pub access: Access,
    pub enabled: bool,
    /// Calendars the user turned off (`CalendarInfo::key`). Everything else,
    /// including calendars added later, is shown.
    pub hidden: Vec<String>,
}

pub fn key(source: &str, title: &str) -> String {
    format!("{source} / {title}")
}

/// Start the worker. Call once at launch (macOS); a no-op elsewhere.
pub fn start(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    macos::start(app.clone());
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

pub fn access() -> Access {
    #[cfg(target_os = "macos")]
    return macos::access();
    #[cfg(not(target_os = "macos"))]
    Access::Unsupported
}

/// Show the macOS permission prompt (once) and wait for the answer.
pub fn request_access() -> Result<Access, String> {
    #[cfg(target_os = "macos")]
    return macos::request_access();
    #[cfg(not(target_os = "macos"))]
    Err("Calendar is only available on macOS.".into())
}

pub fn calendars() -> Result<Vec<CalendarInfo>, String> {
    #[cfg(target_os = "macos")]
    return macos::calendars();
    #[cfg(not(target_os = "macos"))]
    Ok(Vec::new())
}

/// Events overlapping the days `from..=to` (`YYYY-MM-DD`), leaving out the
/// `hidden` calendars, sorted all-day first then by start.
pub fn events(from: &str, to: &str, hidden: &[String]) -> Result<Vec<EventInfo>, String> {
    let parse = |s: &str| {
        chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").map_err(|_| format!("Not a date: {s}"))
    };
    let (from, to) = (parse(from)?, parse(to)?);
    if to < from || (to - from).num_days() > 62 {
        return Err("Ask for at most two months of events at a time.".into());
    }
    #[cfg(target_os = "macos")]
    return macos::events(from, to, hidden.to_vec());
    #[cfg(not(target_os = "macos"))]
    {
        let _ = hidden;
        Ok(Vec::new())
    }
}

/// Move one meeting (the occurrence starting at `at`) to `start`..`end`, all
/// local `YYYY-MM-DDTHH:MM[:SS]`. `everyone` is the OK to move a meeting with
/// guests. Returns the event as it is now.
pub fn move_event(
    id: &str,
    at: &str,
    start: &str,
    end: &str,
    everyone: bool,
) -> Result<EventInfo, String> {
    use todocity_core::meeting_move::{check_times, parse_local};
    let (at, start, end) = (parse_local(at)?, parse_local(start)?, parse_local(end)?);
    check_times(start, end)?;
    #[cfg(target_os = "macos")]
    return macos::move_event(id.to_string(), at, start, end, everyone);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (id, at, everyone);
        Err("Calendar is only available on macOS.".into())
    }
}

#[cfg(target_os = "macos")]
mod macos {
    #![allow(unused_unsafe)]

    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc::{self, Sender};
    use std::sync::{Mutex, OnceLock};
    use std::time::Duration;

    use block2::RcBlock;
    use chrono::{Local, NaiveDate, NaiveDateTime, TimeZone};
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, Bool, NSObjectProtocol, ProtocolObject};
    use objc2::sel;
    use objc2_app_kit::NSColorSpace;
    use objc2_event_kit::{
        EKAuthorizationStatus, EKCalendar, EKEntityType, EKEvent, EKEventStore,
        EKEventStoreChangedNotification, EKSpan,
    };
    use objc2_foundation::{NSArray, NSDate, NSError, NSNotification, NSNotificationCenter};
    use tauri::{AppHandle, Emitter};
    use todocity_core::meeting_move::{allowed, movable, EventFacts};

    use super::{key, Access, CalendarInfo, EventInfo};

    /// How long a caller waits for the worker.
    const WAIT: Duration = Duration::from_secs(10);
    /// EventKit posts bursts of change notifications; tell the UI once.
    const SETTLE: Duration = Duration::from_millis(600);

    enum Request {
        Calendars(Sender<Vec<CalendarInfo>>),
        Events {
            from: NaiveDate,
            to: NaiveDate,
            hidden: Vec<String>,
            reply: Sender<Vec<EventInfo>>,
        },
        /// Move one occurrence of a meeting.
        Move {
            id: String,
            at: NaiveDateTime,
            start: NaiveDateTime,
            end: NaiveDateTime,
            everyone: bool,
            reply: Sender<Result<EventInfo, String>>,
        },
        /// Access was just granted or changed: start over with a new store.
        Reset,
    }

    static WORKER: OnceLock<Mutex<Sender<Request>>> = OnceLock::new();
    static PENDING: AtomicBool = AtomicBool::new(false);

    pub fn start(app: AppHandle) {
        let (tx, rx) = mpsc::channel::<Request>();
        if WORKER.set(Mutex::new(tx)).is_err() {
            return;
        }
        let spawned = std::thread::Builder::new()
            .name("todocity-calendar".into())
            .spawn(move || {
                let mut worker = Worker { app, store: None };
                // Warm up now, so the first look at the menu bar already has
                // subscribed calendars loaded.
                worker.store();
                while let Ok(req) = rx.recv() {
                    match req {
                        Request::Calendars(reply) => {
                            let _ = reply.send(worker.calendars());
                        }
                        Request::Events {
                            from,
                            to,
                            hidden,
                            reply,
                        } => {
                            let _ = reply.send(worker.events(from, to, &hidden));
                        }
                        Request::Move {
                            id,
                            at,
                            start,
                            end,
                            everyone,
                            reply,
                        } => {
                            let _ = reply.send(worker.move_event(&id, at, start, end, everyone));
                        }
                        Request::Reset => worker.close(),
                    }
                }
            });
        if let Err(e) = spawned {
            log::warn!("could not start the calendar worker: {e}");
        }
    }

    fn send(req: Request) -> Result<(), String> {
        let tx = WORKER
            .get()
            .ok_or("Calendar isn't ready yet.")?
            .lock()
            .map_err(|_| "Calendar worker stopped.".to_string())?
            .clone();
        tx.send(req).map_err(|_| "Calendar worker stopped.".into())
    }

    pub fn calendars() -> Result<Vec<CalendarInfo>, String> {
        let (tx, rx) = mpsc::channel();
        send(Request::Calendars(tx))?;
        rx.recv_timeout(WAIT)
            .map_err(|_| "Calendar took too long to answer.".into())
    }

    pub fn events(
        from: NaiveDate,
        to: NaiveDate,
        hidden: Vec<String>,
    ) -> Result<Vec<EventInfo>, String> {
        let (tx, rx) = mpsc::channel();
        send(Request::Events {
            from,
            to,
            hidden,
            reply: tx,
        })?;
        rx.recv_timeout(WAIT)
            .map_err(|_| "Calendar took too long to answer.".into())
    }

    pub fn move_event(
        id: String,
        at: NaiveDateTime,
        start: NaiveDateTime,
        end: NaiveDateTime,
        everyone: bool,
    ) -> Result<EventInfo, String> {
        let (tx, rx) = mpsc::channel();
        send(Request::Move {
            id,
            at,
            start,
            end,
            everyone,
            reply: tx,
        })?;
        rx.recv_timeout(WAIT)
            .map_err(|_| "Calendar took too long to answer.".to_string())?
    }

    struct Store {
        store: Retained<EKEventStore>,
        observer: Retained<ProtocolObject<dyn NSObjectProtocol>>,
    }

    struct Worker {
        app: AppHandle,
        store: Option<Store>,
    }

    impl Worker {
        /// The long-lived store, created once access is granted.
        fn store(&mut self) -> Option<&EKEventStore> {
            if access() != Access::Full {
                self.close();
                return None;
            }
            if self.store.is_none() {
                let store = unsafe { EKEventStore::new() };
                let app = self.app.clone();
                let block = RcBlock::new(move |_: NonNull<NSNotification>| changed(&app));
                let sender: &AnyObject = &store;
                let observer = unsafe {
                    NSNotificationCenter::defaultCenter()
                        .addObserverForName_object_queue_usingBlock(
                            Some(EKEventStoreChangedNotification),
                            Some(sender),
                            None,
                            &block,
                        )
                };
                // Ask subscribed and remote calendars to catch up; when they
                // do, the observer tells the UI to look again.
                unsafe { store.refreshSourcesIfNecessary() };
                self.store = Some(Store { store, observer });
            }
            self.store.as_ref().map(|s| &*s.store)
        }

        fn close(&mut self) {
            if let Some(s) = self.store.take() {
                unsafe {
                    let observer: &AnyObject = (*s.observer).as_ref();
                    NSNotificationCenter::defaultCenter().removeObserver(observer);
                }
            }
        }

        fn calendars(&mut self) -> Vec<CalendarInfo> {
            let Some(store) = self.store() else {
                return Vec::new();
            };
            let mut list: Vec<CalendarInfo> = all(store).iter().map(|c| info(c)).collect();
            list.sort_by(|a, b| a.source.cmp(&b.source).then(a.title.cmp(&b.title)));
            list
        }

        fn events(&mut self, from: NaiveDate, to: NaiveDate, hidden: &[String]) -> Vec<EventInfo> {
            let Some(store) = self.store() else {
                return Vec::new();
            };
            unsafe { store.refreshSourcesIfNecessary() };
            let chosen: Vec<Retained<EKCalendar>> = all(store)
                .into_iter()
                .filter(|c| {
                    let i = info(c);
                    !hidden.contains(&i.key)
                })
                .collect();
            if chosen.is_empty() {
                return Vec::new();
            }
            let calendars = NSArray::from_retained_slice(&chosen);
            let start = NSDate::dateWithTimeIntervalSince1970(midnight(from));
            let end =
                NSDate::dateWithTimeIntervalSince1970(midnight(to + chrono::Duration::days(1)));
            let found = unsafe {
                let predicate = store.predicateForEventsWithStartDate_endDate_calendars(
                    &start,
                    &end,
                    Some(&calendars),
                );
                store.eventsMatchingPredicate(&predicate)
            };
            let mut out: Vec<EventInfo> = found.to_vec().iter().map(|e| event_info(e)).collect();
            out.sort_by(|a, b| b.all_day.cmp(&a.all_day).then(a.start.cmp(&b.start)));
            out.dedup_by(|a, b| a.id == b.id && a.start == b.start);
            out
        }
    }

    impl Worker {
        /// The occurrence of `id` that starts at `at` (to the minute), moved
        /// to `start`..`end` and saved for this occurrence only.
        fn move_event(
            &mut self,
            id: &str,
            at: NaiveDateTime,
            start: NaiveDateTime,
            end: NaiveDateTime,
            everyone: bool,
        ) -> Result<EventInfo, String> {
            let Some(store) = self.store() else {
                return Err(
                    "Allow TodoCity in System Settings → Privacy & Security → Calendars.".into(),
                );
            };
            let from = date(at - chrono::Duration::days(1));
            let to = date(at + chrono::Duration::days(1));
            let want = at.format("%Y-%m-%dT%H:%M").to_string();
            let found = unsafe {
                let predicate =
                    store.predicateForEventsWithStartDate_endDate_calendars(&from, &to, None);
                store.eventsMatchingPredicate(&predicate)
            };
            let event = found
                .to_vec()
                .into_iter()
                .find(|e| unsafe {
                    e.eventIdentifier().is_some_and(|s| s.to_string() == id)
                        && local(e.startDate().timeIntervalSince1970()).starts_with(&want)
                })
                .ok_or(
                    "This meeting just changed in Calendar. Take another look and move it again.",
                )?;
            allowed(movable(facts(&event)), everyone)?;
            unsafe {
                event.setStartDate(Some(&date(start)));
                event.setEndDate(Some(&date(end)));
                store
                    .saveEvent_span_commit_error(&event, EKSpan::ThisEvent, true)
                    .map_err(|e| e.localizedDescription().to_string())?;
            }
            Ok(event_info(&event))
        }
    }

    /// What `meeting_move::movable` needs to know about an event.
    fn facts(e: &EKEvent) -> EventFacts {
        unsafe {
            let cal = e.calendar();
            EventFacts {
                can_edit: cal.as_ref().is_some_and(|c| c.allowsContentModifications()),
                all_day: e.isAllDay(),
                has_guests: e.hasAttendees(),
                i_organize: e.organizer().is_some_and(|o| o.isCurrentUser()),
                todocity: cal.as_ref().is_some_and(|c| {
                    c.title()
                        .to_string()
                        .starts_with(crate::calsync::TITLE_PREFIX)
                }),
            }
        }
    }

    fn event_info(e: &EKEvent) -> EventInfo {
        unsafe {
            let cal = e.calendar();
            EventInfo {
                id: e
                    .eventIdentifier()
                    .map(|s| s.to_string())
                    .unwrap_or_default(),
                title: e.title().to_string(),
                start: local(e.startDate().timeIntervalSince1970()),
                end: local(e.endDate().timeIntervalSince1970()),
                all_day: e.isAllDay(),
                calendar: cal
                    .as_ref()
                    .map(|c| c.title().to_string())
                    .unwrap_or_default(),
                color: cal.as_ref().and_then(|c| hex(c)),
                movable: movable(facts(e)),
            }
        }
    }

    fn date(t: NaiveDateTime) -> Retained<NSDate> {
        let secs = Local
            .from_local_datetime(&t)
            .earliest()
            .map(|d| d.timestamp())
            .unwrap_or_default();
        NSDate::dateWithTimeIntervalSince1970(secs as f64)
    }

    /// The calendar database changed (new data synced, a calendar added,
    /// access changed). Tell the UI once things settle.
    fn changed(app: &AppHandle) {
        if PENDING.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(SETTLE);
            PENDING.store(false, Ordering::SeqCst);
            let _ = app.emit("calendar-changed", ());
        });
    }

    pub fn access() -> Access {
        let status = unsafe { EKEventStore::authorizationStatusForEntityType(EKEntityType::Event) };
        match status {
            s if s == EKAuthorizationStatus::NotDetermined => Access::NotDetermined,
            s if s == EKAuthorizationStatus::Restricted => Access::Restricted,
            s if s == EKAuthorizationStatus::Denied => Access::Denied,
            s if s == EKAuthorizationStatus::FullAccess => Access::Full,
            s if s == EKAuthorizationStatus::WriteOnly => Access::WriteOnly,
            _ => Access::Denied,
        }
    }

    pub fn request_access() -> Result<Access, String> {
        let store = unsafe { EKEventStore::new() };
        let (tx, rx) = mpsc::channel::<Result<bool, String>>();
        let block = RcBlock::new(move |granted: Bool, err: *mut NSError| {
            let result = match unsafe { err.as_ref() } {
                Some(e) if !granted.as_bool() => {
                    Err(unsafe { e.localizedDescription() }.to_string())
                }
                _ => Ok(granted.as_bool()),
            };
            let _ = tx.send(result);
        });
        unsafe {
            if store.respondsToSelector(sel!(requestFullAccessToEventsWithCompletion:)) {
                store.requestFullAccessToEventsWithCompletion(RcBlock::as_ptr(&block));
            } else {
                #[allow(deprecated)]
                store.requestAccessToEntityType_completion(
                    EKEntityType::Event,
                    RcBlock::as_ptr(&block),
                );
            }
        }
        let answer = rx.recv_timeout(Duration::from_secs(300));
        // A store made before access was granted never sees the calendars.
        let _ = send(Request::Reset);
        match answer {
            Ok(Ok(_)) => Ok(access()),
            Ok(Err(e)) => Err(e),
            Err(_) => Err("No answer to the Calendar permission request.".into()),
        }
    }

    fn hex(cal: &EKCalendar) -> Option<String> {
        let color = unsafe { cal.color() };
        let rgb = color.colorUsingColorSpace(&NSColorSpace::sRGBColorSpace())?;
        let c = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        Some(format!(
            "#{:02x}{:02x}{:02x}",
            c(rgb.redComponent()),
            c(rgb.greenComponent()),
            c(rgb.blueComponent())
        ))
    }

    fn info(cal: &EKCalendar) -> CalendarInfo {
        unsafe {
            let source = cal
                .source()
                .map(|s| s.title().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "On My Mac".into());
            let title = cal.title().to_string();
            CalendarInfo {
                id: cal.calendarIdentifier().to_string(),
                key: key(&source, &title),
                title,
                source,
                color: hex(cal),
            }
        }
    }

    /// The Mac's calendars, without the ones TodoCity keeps its own tasks in
    /// (those tasks are already beside the meetings).
    fn all(store: &EKEventStore) -> Vec<Retained<EKCalendar>> {
        unsafe { store.calendarsForEntityType(EKEntityType::Event) }
            .to_vec()
            .into_iter()
            .filter(|c| {
                !unsafe { c.title() }
                    .to_string()
                    .starts_with(crate::calsync::TITLE_PREFIX)
            })
            .collect()
    }

    fn local(secs: f64) -> String {
        Local
            .timestamp_opt(secs.floor() as i64, 0)
            .single()
            .map(|t| t.format("%Y-%m-%dT%H:%M:%S").to_string())
            .unwrap_or_default()
    }

    fn midnight(day: NaiveDate) -> f64 {
        day.and_hms_opt(0, 0, 0)
            .and_then(|t| Local.from_local_datetime(&t).earliest())
            .map(|t| t.timestamp() as f64)
            .unwrap_or_default()
    }
}
