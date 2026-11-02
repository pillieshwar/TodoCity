//! The menu-bar popover: a small calendar + agenda window that drops down
//! from the TodoCity icon when it's clicked, and hides when it loses focus.
//!
//! It is made once at launch and spends most of its life hidden. macOS may
//! unload a hidden window's page (after sleep, or when memory is tight),
//! which leaves an empty pane of glass where the day should be. So each time
//! it opens, the page is asked to answer ([`popover_alive`]); a page that
//! doesn't answer, or answers with nothing drawn, is reloaded.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, Rect, WebviewWindow};

pub const LABEL: &str = "popover";
/// Gap between the menu bar icon and the popover, in logical pixels.
const GAP: f64 = 6.0;
/// A click on the icon right after the popover hid itself (because that same
/// click took focus away) should close it, not reopen it.
const REOPEN_GUARD: Duration = Duration::from_millis(250);

static LAST_HIDDEN: Mutex<Option<Instant>> = Mutex::new(None);
static LAST_SHOWN: Mutex<Option<Instant>> = Mutex::new(None);
/// A capture is being reviewed in the popover: clicking elsewhere (say, back
/// into the page to re-read it) must not throw it away.
static PINNED: AtomicBool = AtomicBool::new(false);
/// Over a full-screen app the menu bar slides away as the popover opens,
/// which can briefly take focus from it; don't treat that as "clicked away".
const BLUR_GRACE: Duration = Duration::from_millis(400);
/// How long the page has to answer when the popover opens.
const ANSWER_WITHIN: Duration = Duration::from_millis(1200);
/// Reload at most this often, so a page that can't draw doesn't loop.
const RELOAD_AT_MOST_EVERY: Duration = Duration::from_secs(20);

/// The latest check sent to the page, and its answer: (check, drawn).
static CHECK: AtomicU64 = AtomicU64::new(0);
static ANSWER: Mutex<Option<(u64, bool)>> = Mutex::new(None);
static LAST_RELOAD: Mutex<Option<Instant>> = Mutex::new(None);

fn window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(LABEL)
}

fn recently_hidden() -> bool {
    LAST_HIDDEN
        .lock()
        .ok()
        .and_then(|t| *t)
        .is_some_and(|t| t.elapsed() < REOPEN_GUARD)
}

/// Show the popover under the icon at `icon`, or hide it if it's open.
pub fn toggle(app: &AppHandle, icon: Rect) {
    let Some(win) = window(app) else { return };
    if win.is_visible().unwrap_or(false) {
        hide(app);
        return;
    }
    if recently_hidden() {
        return;
    }
    open(app, &win, icon);
}

fn open(app: &AppHandle, win: &WebviewWindow, icon: Rect) {
    crate::spaces::configure(win, crate::spaces::Kind::Overlay);
    if let Err(e) = place(win, icon) {
        log::warn!("could not position popover: {e}");
    }
    if let Ok(mut t) = LAST_SHOWN.lock() {
        *t = Some(Instant::now());
    }
    crate::spaces::present(win);
    let _ = app.emit_to(LABEL, "popover-shown", ());
    check_page(app);
}

/// Whether the page should be reloaded, given its answer (`Some(drawn)`, or
/// `None` when it didn't answer in time).
pub fn needs_reload(answer: Option<bool>, reloaded_recently: bool) -> bool {
    !reloaded_recently && answer != Some(true)
}

/// Ask the page to answer; reload it if it doesn't, or if it has nothing
/// drawn.
fn check_page(app: &AppHandle) {
    let n = CHECK.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = app.emit_to(LABEL, "popover-check", n);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(ANSWER_WITHIN).await;
        if CHECK.load(Ordering::SeqCst) != n {
            return; // a newer check is under way
        }
        let answer = ANSWER
            .lock()
            .ok()
            .and_then(|a| *a)
            .filter(|(check, _)| *check == n)
            .map(|(_, drawn)| drawn);
        let recent = LAST_RELOAD
            .lock()
            .ok()
            .and_then(|t| *t)
            .is_some_and(|t| t.elapsed() < RELOAD_AT_MOST_EVERY);
        if !needs_reload(answer, recent) {
            return;
        }
        let Some(win) = window(&app) else { return };
        if !win.is_visible().unwrap_or(false) {
            return;
        }
        log::warn!(
            "menu-bar popover page {}; reloading it",
            if answer.is_none() {
                "didn't answer"
            } else {
                "had nothing drawn"
            }
        );
        if let Ok(mut t) = LAST_RELOAD.lock() {
            *t = Some(Instant::now());
        }
        if let Err(e) = win.reload() {
            log::warn!("could not reload the menu-bar popover: {e}");
        }
    });
}

/// The popover's page answers a check: it's there, and whether it has
/// anything drawn.
#[tauri::command]
pub fn popover_alive(check: u64, drawn: bool) {
    if let Ok(mut a) = ANSWER.lock() {
        *a = Some((check, drawn));
    }
}

/// A window's page hit an error while drawing (or loading): into the log,
/// so it can be found and fixed.
#[tauri::command]
pub fn page_error(view: String, message: String) {
    let message: String = message.chars().take(4000).collect();
    log::error!("page error in {view}: {message}");
}

/// Open the popover under the menu-bar icon to review a capture. Returns
/// false when the icon isn't on screen (so the caller can use the panel).
pub fn show_for_capture(app: &AppHandle) -> bool {
    let Some(win) = window(app) else {
        return false;
    };
    let Some(icon) = crate::tray::icon_rect(app) else {
        return false;
    };
    PINNED.store(true, Ordering::SeqCst);
    if win.is_visible().unwrap_or(false) {
        crate::spaces::present(&win);
    } else {
        open(app, &win, icon);
    }
    true
}

/// Why the popover opened by itself.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Focus {
    /// Tasks whose time just came.
    Due { ids: Vec<i64> },
    /// The daily "tasks without a date" check-in.
    Undated,
    /// Tasks AI agents sent, waiting for review.
    Inbox,
}

/// Open the popover under the menu-bar icon on its own, focused on `focus`,
/// without taking the keyboard from the app in front. False when the icon
/// isn't on screen.
pub fn show_focus(app: &AppHandle, focus: Focus) -> bool {
    let Some(win) = window(app) else {
        return false;
    };
    let Some(icon) = crate::tray::icon_rect(app) else {
        return false;
    };
    if !win.is_visible().unwrap_or(false) {
        crate::spaces::configure(&win, crate::spaces::Kind::Overlay);
        if let Err(e) = place(&win, icon) {
            log::warn!("could not position popover: {e}");
        }
        if let Ok(mut t) = LAST_SHOWN.lock() {
            *t = Some(Instant::now());
        }
        crate::spaces::present_passive(&win);
        let _ = app.emit_to(LABEL, "popover-shown", ());
        check_page(app);
    }
    let _ = app.emit_to(LABEL, "popover-focus", &focus);
    true
}

/// The popover's capture review started or ended.
pub fn set_pinned(pinned: bool) {
    PINNED.store(pinned, Ordering::SeqCst);
}

/// The popover lost focus: close it, unless it only just opened.
pub fn on_blur(app: &AppHandle) {
    if PINNED.load(Ordering::SeqCst) {
        return;
    }
    let fresh = LAST_SHOWN
        .lock()
        .ok()
        .and_then(|t| *t)
        .is_some_and(|t| t.elapsed() < BLUR_GRACE);
    if fresh {
        // Take focus back so a real click elsewhere still closes it.
        if let Some(win) = window(app) {
            crate::spaces::present(&win);
        }
        return;
    }
    hide(app);
}

pub fn hide(app: &AppHandle) {
    if let Some(win) = window(app) {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
            if let Ok(mut t) = LAST_HIDDEN.lock() {
                *t = Some(Instant::now());
            }
        }
    }
}

/// Centre the popover under the icon, kept on screen. On a bottom taskbar
/// (Windows) it opens upwards instead.
fn place(win: &WebviewWindow, icon: Rect) -> tauri::Result<()> {
    let scale = win.scale_factor()?;
    let pos = icon.position.to_physical::<f64>(scale);
    let size = icon.size.to_physical::<f64>(scale);
    let win_size = win.outer_size()?;
    let (w, h) = (win_size.width as f64, win_size.height as f64);
    let gap = GAP * scale;

    let center_x = pos.x + size.width / 2.0;
    let mut x = center_x - w / 2.0;
    let mut y = pos.y + size.height + gap;

    if let Some(m) = win.monitor_from_point(center_x, pos.y + size.height / 2.0)? {
        let (mp, ms) = (m.position(), m.size());
        let (left, top) = (mp.x as f64, mp.y as f64);
        let (right, bottom) = (left + ms.width as f64, top + ms.height as f64);
        x = x.clamp(left + gap, (right - w - gap).max(left + gap));
        if y + h > bottom {
            y = (pos.y - h - gap).max(top);
        }
    }
    win.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32))
}

#[cfg(test)]
mod tests {
    use super::needs_reload;

    #[test]
    fn a_page_that_drew_is_left_alone() {
        assert!(!needs_reload(Some(true), false));
    }

    #[test]
    fn a_silent_or_empty_page_is_reloaded_but_not_in_a_loop() {
        assert!(needs_reload(None, false));
        assert!(needs_reload(Some(false), false));
        assert!(!needs_reload(None, true));
        assert!(!needs_reload(Some(false), true));
    }
}
