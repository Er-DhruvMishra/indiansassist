//! The X11 clipboard bridge (Phase E §7.2, C §5.6) and the rank-4 clipboard token carrier
//! helpers (§7.6), compiled under `cfg(all(target_os = "linux", feature = "x11"))`.
//!
//! Text goes through `arboard` 3 (its X11 backend; `arboard::Clipboard::new()` reads `DISPLAY`).
//! Change detection: arboard opens a new X connection for every read of a selection another
//! client owns, so [`X11Clipboard::take_update`] does not read on every poll. It watches the
//! CLIPBOARD selection with XFixes `SelectSelectionInput` (on its own connection to the same
//! `DISPLAY`) and reads only after the owner changed, the X equivalent of the Windows sink's
//! clipboard sequence number. Without XFixes it falls back to reading on every poll. Clipboard
//! content is never logged.

use ia_platform::traits::ClipboardBridge;
use x11rb::connection::Connection;
use x11rb::protocol::xfixes::{ConnectionExt as _, SelectionEventMask};
use x11rb::protocol::xproto::ConnectionExt as _;
use x11rb::protocol::Event;
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

/// XFixes notifications of CLIPBOARD owner changes.
struct SelectionWatch {
    conn: RustConnection,
}

impl SelectionWatch {
    fn open() -> Option<Self> {
        // `None` = the `DISPLAY` environment variable, the display arboard uses.
        let (conn, screen) = RustConnection::connect(None).ok()?;
        conn.xfixes_query_version(5, 0).ok()?.reply().ok()?;
        let root = conn.setup().roots.get(screen)?.root;
        let clipboard = conn
            .intern_atom(false, b"CLIPBOARD")
            .ok()?
            .reply()
            .ok()?
            .atom;
        conn.xfixes_select_selection_input(
            root,
            clipboard,
            SelectionEventMask::SET_SELECTION_OWNER
                | SelectionEventMask::SELECTION_WINDOW_DESTROY
                | SelectionEventMask::SELECTION_CLIENT_CLOSE,
        )
        .ok()?;
        conn.sync().ok()?;
        Some(Self { conn })
    }

    /// Whether the CLIPBOARD owner changed since the last call; `Err` when the connection broke.
    fn changed(&mut self) -> Result<bool, ()> {
        let mut changed = false;
        loop {
            match self.conn.poll_for_event() {
                Ok(Some(Event::XfixesSelectionNotify(_))) => changed = true,
                Ok(Some(_)) => {}
                Ok(None) => return Ok(changed),
                Err(_) => return Err(()),
            }
        }
    }
}

/// The X11 CLIPBOARD as a [`ClipboardBridge`] (text only, both ways). A single owner (the serve
/// loop) drives it.
pub struct X11Clipboard {
    clipboard: arboard::Clipboard,
    /// The text we last set or reported, so our own `set_text` is not echoed back to the Assist
    /// and an unchanged clipboard is not reported twice.
    last: Option<String>,
    watch: Option<SelectionWatch>,
}

impl X11Clipboard {
    /// `None` when no X clipboard is reachable (`DISPLAY` unset or the server unreachable). The
    /// text present now is remembered, not reported, as the Windows bridge ignores what was on
    /// the clipboard before the session.
    pub fn new() -> Option<Self> {
        let mut clipboard = arboard::Clipboard::new().ok()?;
        // Watch first, then read: a change after the read is then always seen.
        let watch = SelectionWatch::open();
        if watch.is_none() {
            tracing::info!("XFixes unavailable; the clipboard is read on every poll");
        }
        let last = clipboard.get_text().ok();
        Some(Self {
            clipboard,
            last,
            watch,
        })
    }
}

impl ClipboardBridge for X11Clipboard {
    fn set_text(&mut self, text: &str) {
        match self.clipboard.set_text(text) {
            Ok(()) => self.last = Some(text.to_owned()),
            Err(e) => tracing::warn!(error = %e, "could not set the X11 clipboard"),
        }
    }

    fn take_update(&mut self) -> Option<String> {
        if let Some(watch) = &mut self.watch {
            match watch.changed() {
                Ok(false) => return None,
                Ok(true) => {}
                Err(()) => {
                    tracing::warn!("clipboard watch lost; reading on every poll");
                    self.watch = None;
                }
            }
        }
        let text = self.clipboard.get_text().ok()?;
        if self.last.as_deref() == Some(text.as_str()) {
            return None;
        }
        self.last = Some(text.clone());
        Some(text)
    }
}

/// §7.6 rank-4 carrier: read the CLIPBOARD text once (`None` when there is no text).
pub fn clipboard_read_once() -> Option<String> {
    arboard::Clipboard::new().ok()?.get_text().ok()
}

/// §7.6 rank-4 carrier: "clear" the clipboard after the token was taken from it, by taking the
/// CLIPBOARD selection with an empty string, but only while it still holds `value` (the user may
/// have copied something else meanwhile, which must survive). `true` when cleared.
///
/// X has no atomic compare-and-set on a selection; the window between the check and the take is
/// one round trip.
pub fn clipboard_clear_if_unchanged(value: &str) -> bool {
    let Ok(mut clipboard) = arboard::Clipboard::new() else {
        return false;
    };
    match clipboard.get_text() {
        Ok(current) if current == value => clipboard.set_text("").is_ok(),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_bridge_is_send() {
        fn assert_send<T: Send>() {}
        assert_send::<super::X11Clipboard>();
    }
}
