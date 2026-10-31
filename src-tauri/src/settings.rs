//! App preferences that aren't shortcuts or Reminders, saved in
//! `settings.json` next to the task database.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use todocity_core::modes::ViewMode;
use todocity_core::notify::NotifySettings;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AppSettings {
    pub notify: NotifySettings,
    /// Check for (and download) updates in the background.
    pub auto_update: bool,
    /// Remember which app and page a capture came from.
    pub remember_source: bool,
    /// The first-run walkthrough was finished or skipped.
    pub onboarding_done: bool,
    /// "Open at login" was set up once; after that it's the user's choice.
    pub autostart_initialized: bool,
    /// Last day (`YYYY-MM-DD`) the morning summary went out.
    pub last_summary: Option<String>,
    /// Last day an automatic backup was written.
    pub last_backup: Option<String>,
    /// The "what's new" note for this version was dismissed.
    pub seen_version: Option<String>,
    /// Open the task panel when TodoCity starts and the first time the Mac
    /// wakes each day, so it's never out of sight for long.
    pub show_on_start: bool,
    /// Last day (`YYYY-MM-DD`) the panel was shown for that reason.
    pub last_greeted: Option<String>,
    /// The menu-bar icon was given its starting spot (see `tray::place`).
    pub menubar_placed: bool,
    /// Review captures in the dropdown under the menu-bar icon (true) or in
    /// the side panel.
    pub capture_in_menu_bar: bool,
    /// Calendar connector: show events from the Mac's calendars.
    pub calendar_enabled: bool,
    /// 0.4.9 only: calendars to show, by id. Migrated to `calendar_hidden`.
    pub calendar_ids: Option<Vec<String>>,
    /// Calendars the user turned off, by `calendar::key` (account / title).
    pub calendar_hidden: Vec<String>,
    /// "system", "light" or "dark".
    pub theme: String,
    /// 0.4.27 made dark the default; settings from before were moved over once.
    /// (Missing in older files, so it reads as false there.)
    #[serde(default)]
    pub theme_v2: bool,
    /// 0.4.53 made compact rows (and lists rather than boards) the default;
    /// settings from before were moved over once.
    #[serde(default)]
    pub look_v2: bool,
    /// 0.4.55: Personal is on by default, and Work and Personal file new
    /// tasks in Office and Home. Settings from before were moved over once.
    #[serde(default)]
    pub modes_v2: bool,
    /// The Home and Office projects were made (once, so deleting them sticks).
    #[serde(default)]
    pub default_projects_made: bool,
    /// Press ⌘C twice quickly to capture what was just copied.
    pub double_copy: bool,
    /// The name the user gave their city (every finished task lights a window).
    pub city_name: Option<String>,
    /// Show the city in the corner of full screen.
    pub city_corner: bool,
    /// What the city calls its mayor (the user).
    pub mayor_name: Option<String>,
    /// Play the "Lights on" sound when a task is done.
    pub done_sound: bool,
    /// The highest population the city has reached: milestones built at it
    /// stay built, even if tasks are un-ticked later. Only ever goes up.
    pub city_peak: u32,
    /// The milestone (its population) last celebrated, so each is cheered once.
    pub city_seen: u32,
    /// Once a day, open the menu-bar dropdown to plan tasks that have no date.
    pub undated_nudge: bool,
    /// When to do that, `HH:MM` local time.
    pub undated_time: String,
    /// Last day (`YYYY-MM-DD`) the undated nudge was shown.
    pub last_undated_nudge: Option<String>,
    /// When a task's time comes, also open the menu-bar dropdown on it.
    pub due_spotlight: bool,
    /// Let AI agents on this Mac add tasks (to the review inbox) over MCP.
    pub agents_enabled: bool,
    /// Agents may add to-dos they notice without being asked (still reviewed).
    pub agents_proactive: bool,
    /// Full access: connected agents can read, add, change, complete and
    /// delete tasks, projects and sections, with no review. Off by default.
    pub agents_full_access: bool,
    /// Notice to-dos in Slack and Outlook as they appear on screen.
    pub watch: WatchSettings,
    /// How TodoCity looks and behaves, as the user likes it.
    pub look: LookSettings,
    /// Modes this Mac offers (Work, Personal, and any the user made).
    pub modes: Vec<ViewMode>,
    /// The mode this Mac is in; none shows everything.
    pub mode: Option<String>,
    /// Open in full screen when TodoCity starts (or is opened again).
    pub open_full: bool,
}

/// Limits for the right-hand pane's width.
pub const SIDE_MIN: u32 = 240;
pub const SIDE_MAX: u32 = 640;

/// Personal touches: calendar, clock, colors, density and the city.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LookSettings {
    /// First day of the week: "auto" (from the Mac's region), "sun", "mon" or "sat".
    pub week_start: String,
    /// "auto", "12" or "24" hour clock.
    pub clock: String,
    /// Which list opens: "last" (where you left off), "today", "upcoming" or "all".
    pub start_list: String,
    /// Show each task's notes and sub-tasks under it in full screen.
    pub details: bool,
    /// Accent color: "purple", "blue", "green", "orange" or "pink".
    pub accent: String,
    /// The city's sky: "auto" (follows Appearance), "night" or "dusk".
    pub city_sky: String,
    /// Cars, trucks and blinking windows in the city.
    pub city_motion: bool,
    /// Tighter rows in full screen.
    pub compact: bool,
    /// The mayor's figure: "man" or "woman".
    pub mayor_look: String,
    /// Width of full screen's right-hand pane, in points (0: the default).
    pub side_width: u32,
    /// Full screen's right-hand pane (calendar and hours) is open.
    pub side_open: bool,
    /// Show finished tasks in the lists (they're always in Completed).
    pub show_done: bool,
    /// List or board, per view: "inbox" or "project:<name>" → "list" | "board".
    pub list_views: std::collections::BTreeMap<String, String>,
    /// Where a task came from ("from Mail"): "always", "hover" or "never".
    pub show_source: String,
}

impl Default for LookSettings {
    fn default() -> Self {
        Self {
            week_start: "auto".into(),
            clock: "auto".into(),
            start_list: "last".into(),
            details: true,
            accent: "purple".into(),
            city_sky: "auto".into(),
            city_motion: true,
            compact: true,
            mayor_look: "man".into(),
            side_width: 0,
            side_open: true,
            show_done: false,
            list_views: std::collections::BTreeMap::new(),
            show_source: "always".into(),
        }
    }
}

impl LookSettings {
    /// Unknown values fall back to the defaults.
    pub fn clean(self) -> Self {
        let pick = |v: String, ok: &[&str], d: &str| {
            if ok.contains(&v.as_str()) {
                v
            } else {
                d.to_string()
            }
        };
        Self {
            week_start: pick(self.week_start, &["auto", "sun", "mon", "sat"], "auto"),
            clock: pick(self.clock, &["auto", "12", "24"], "auto"),
            // "all" (Anytime) became Inbox in 0.4.52.
            start_list: pick(
                if self.start_list == "all" {
                    "inbox".into()
                } else {
                    self.start_list
                },
                &["last", "today", "upcoming", "inbox"],
                "last",
            ),
            details: self.details,
            accent: pick(
                self.accent,
                &["purple", "blue", "green", "orange", "pink"],
                "purple",
            ),
            city_sky: pick(self.city_sky, &["auto", "night", "dusk"], "auto"),
            city_motion: self.city_motion,
            compact: self.compact,
            mayor_look: pick(self.mayor_look, &["man", "woman"], "man"),
            side_width: if self.side_width == 0 {
                0
            } else {
                self.side_width.clamp(SIDE_MIN, SIDE_MAX)
            },
            side_open: self.side_open,
            show_done: self.show_done,
            list_views: self
                .list_views
                .into_iter()
                .filter(|(k, v)| k.len() <= 200 && (v == "list" || v == "board"))
                .take(500)
                .collect(),
            show_source: pick(self.show_source, &["always", "hover", "never"], "always"),
        }
    }
}

/// Watch mode (see `watch.rs`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct WatchSettings {
    pub enabled: bool,
    /// 0.4.16–0.4.19 only: apps to watch. Every app is watched now, except
    /// `watch::ALWAYS_SKIP` and `excluded`.
    pub apps: Vec<String>,
    /// Bundle ids the user doesn't want read.
    pub excluded: Vec<String>,
    /// Only while the Mac is on power.
    pub plugged_in_only: bool,
    /// Open the menu-bar dropdown when something is found.
    pub show_right_away: bool,
    /// Paused until this local time, `YYYY-MM-DDTHH:MM:SS`.
    pub paused_until: Option<String>,
    /// The user's name as each app shows it, by bundle id ("Sam Rivera"
    /// in Slack, "Rivera, Sam" in Outlook). Alternatives separated by
    /// commas, or semicolons when a name has a comma.
    pub names: std::collections::BTreeMap<String, String>,
    /// Who reads the new messages: "local" (the open model on this Mac) or
    /// an agent id ("claude", "codex"…) the person picked in Watch.
    pub reader: String,
}

impl Default for WatchSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            apps: Vec::new(),
            excluded: Vec::new(),
            plugged_in_only: false,
            show_right_away: true,
            paused_until: None,
            names: Default::default(),
            reader: "local".into(),
        }
    }
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            notify: NotifySettings::default(),
            auto_update: true,
            remember_source: true,
            onboarding_done: false,
            autostart_initialized: false,
            last_summary: None,
            last_backup: None,
            seen_version: None,
            show_on_start: true,
            last_greeted: None,
            menubar_placed: false,
            capture_in_menu_bar: true,
            calendar_enabled: false,
            calendar_ids: None,
            calendar_hidden: Vec::new(),
            theme: "dark".into(),
            theme_v2: true,
            look_v2: true,
            modes_v2: true,
            default_projects_made: false,
            double_copy: true,
            city_name: None,
            city_corner: true,
            mayor_name: None,
            done_sound: true,
            city_peak: 0,
            city_seen: 0,
            undated_nudge: true,
            undated_time: "16:00".into(),
            last_undated_nudge: None,
            due_spotlight: true,
            agents_enabled: false,
            agents_proactive: true,
            agents_full_access: false,
            watch: WatchSettings::default(),
            look: LookSettings::default(),
            modes: ViewMode::defaults(),
            mode: Some("personal".into()),
            open_full: true,
        }
    }
}

pub struct Settings {
    path: PathBuf,
    value: Mutex<AppSettings>,
}

impl Settings {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join("settings.json");
        let mut value: AppSettings = std::fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        let migrate = !value.theme_v2 || !value.look_v2 || !value.modes_v2;
        if !value.theme_v2 {
            // Dark is the default from 0.4.27; "follow the Mac" moves over once.
            if value.theme == "system" {
                value.theme = "dark".into();
            }
            value.theme_v2 = true;
        }
        if !value.look_v2 {
            // Compact rows and lists are the defaults from 0.4.53.
            value.look.compact = true;
            value.look.list_views.clear();
            value.look_v2 = true;
        }
        if !value.modes_v2 {
            // Personal by default, with Home and Office, from 0.4.55.
            if value.mode.is_none() {
                value.mode = Some("personal".into());
            }
            for m in &mut value.modes {
                m.adopt_defaults();
            }
            value.modes_v2 = true;
        }
        let me = Self {
            path,
            value: Mutex::new(value.clone()),
        };
        if migrate {
            if let Err(e) = me.save(&value) {
                log::warn!("could not save settings: {e}");
            }
        }
        me
    }

    pub fn get(&self) -> AppSettings {
        self.value.lock().map(|v| v.clone()).unwrap_or_default()
    }

    /// Change the settings and save them; returns the new value.
    pub fn update(&self, f: impl FnOnce(&mut AppSettings)) -> AppSettings {
        let next = match self.value.lock() {
            Ok(mut v) => {
                f(&mut v);
                v.clone()
            }
            Err(_) => return AppSettings::default(),
        };
        if let Err(e) = self.save(&next) {
            log::warn!("could not save settings: {e}");
        }
        next
    }

    fn save(&self, s: &AppSettings) -> std::io::Result<()> {
        let bytes = serde_json::to_vec_pretty(s)?;
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, bytes)?;
        std::fs::rename(tmp, &self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_and_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let s = Settings::new(dir.path());
        assert!(s.get().notify.enabled && s.get().auto_update && !s.get().onboarding_done);
        s.update(|v| {
            v.onboarding_done = true;
            v.notify.daily_summary = true;
        });
        let again = Settings::new(dir.path());
        assert!(again.get().onboarding_done && again.get().notify.daily_summary);
    }

    #[test]
    fn look_falls_back_to_defaults() {
        let odd = LookSettings {
            week_start: "tue".into(),
            clock: "24".into(),
            accent: "neon".into(),
            mayor_look: "robot".into(),
            side_width: 9000,
            show_source: "sometimes".into(),
            ..LookSettings::default()
        }
        .clean();
        assert_eq!(odd.mayor_look, "man");
        assert_eq!(odd.show_source, "always");
        let hover = LookSettings {
            show_source: "hover".into(),
            ..LookSettings::default()
        }
        .clean();
        assert_eq!(hover.show_source, "hover");
        assert_eq!(odd.side_width, SIDE_MAX);
        let views = LookSettings {
            list_views: [
                ("inbox".to_string(), "board".to_string()),
                ("project:A".to_string(), "grid".to_string()),
            ]
            .into(),
            ..LookSettings::default()
        }
        .clean();
        assert_eq!(views.list_views.len(), 1);
        assert!(views.side_open && !views.show_done);
        assert_eq!(odd.week_start, "auto");
        assert_eq!(odd.clock, "24");
        assert_eq!(odd.accent, "purple");
        assert!(odd.details && odd.city_motion && odd.compact);
    }

    #[test]
    fn older_files_keep_new_defaults() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            r#"{"onboarding_done":true}"#,
        )
        .unwrap();
        let s = Settings::new(dir.path()).get();
        assert!(s.onboarding_done && s.auto_update && s.remember_source);
        assert!(s.double_copy);
        assert!(s.city_corner && s.city_name.is_none());
        // Modes: Work and Personal, with Personal on (0.4.55).
        assert_eq!(s.modes, ViewMode::defaults());
        assert_eq!(s.mode.as_deref(), Some("personal"));
        assert!(s.open_full && s.modes_v2 && !s.default_projects_made);
        // Compact rows from 0.4.53.
        assert!(s.look.compact && s.look_v2);
        assert_eq!(s.look.show_source, "always");
    }

    #[test]
    fn dark_becomes_the_default_once() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), r#"{"theme":"system"}"#).unwrap();
        let s = Settings::new(dir.path());
        assert_eq!(s.get().theme, "dark");
        // Choosing "system" again afterwards sticks.
        s.update(|v| v.theme = "system".into());
        assert_eq!(Settings::new(dir.path()).get().theme, "system");
        std::fs::write(dir.path().join("settings.json"), r#"{"theme":"light"}"#).unwrap();
        assert_eq!(Settings::new(dir.path()).get().theme, "light");
    }
}
