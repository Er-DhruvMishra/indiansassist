//! The X11 input sink (Phase E §7.2 and rule 7.3c), compiled under
//! `cfg(all(target_os = "linux", feature = "x11"))`.
//!
//! * Pointer, buttons and wheel: XTEST `FakeInput` (an absolute `MotionNotify` on the root, then
//!   `ButtonPress` / `ButtonRelease`; the wheel is buttons 4-7, one click per notch).
//! * Keys: XTEST key events on the keycode `evdev + 8` ([`crate::keymap`]). As on Windows the
//!   `modifiers` argument is not applied: the Assist sends modifier keys as their own key events
//!   (`ControlLeft` down, `KeyC` press, `ControlLeft` up), so the server's own modifier state is
//!   the truth and nothing is pressed twice.
//! * Text: the spare-keycode Unicode path ([`crate::unicode`]); see [`X11Input::text`] for the
//!   timing.
//! * Rule 7.3c: [`InputSink::refuses_pointer`] and [`InputSink::refuses_keyboard`] read the
//!   agent's own windows **live on every call** (no cache): the top-level windows whose
//!   `_NET_WM_PID` (set by winit on every eframe window) is the agent's pid.

use std::collections::BTreeSet;
use std::time::Duration;

use ia_core::types::{Modifiers, MonitorInfo};
use ia_platform::traits::{InputSink, KeyAction, PointerAction};
use x11rb::connection::{Connection, RequestConnection};
use x11rb::errors::{ConnectionError, ReplyError};
use x11rb::protocol::xproto::{self, AtomEnum, ConnectionExt as _, MapState, Window};
use x11rb::protocol::xtest::{self, ConnectionExt as _};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::{CURRENT_TIME, NONE};

use crate::guard::{keyboard_refused, pointer_refused, AgentWindow};
use crate::keymap::x_keycode_for_code;
use crate::mapping::{to_root, wheel_clicks, x_button, xtest_point};
use crate::unicode::{binding_runs, plan_batches, spare_keycodes, text_keysyms, NO_SYMBOL};

/// After a text batch's keysyms are bound (and a round trip confirmed the server applied them),
/// wait this long before the first key press, so a client that re-reads the keymap when it
/// receives `MappingNotify` / `XkbMapNotify` (rather than at lookup time) has it before the key.
pub const TEXT_BIND_SETTLE: Duration = Duration::from_millis(10);

/// After a text batch's last release (and a round trip confirmed the server delivered every key
/// event), keep the binding this long before restoring the mapping. Xlib and GTK clients refresh
/// the keymap **lazily**: `MappingNotify` only marks it stale and the new mapping is fetched when
/// the key event is looked up, so restoring too early makes a slow client decode the keycode with
/// the restored (empty) mapping. 100 ms covers an event loop that is busy for a few frames; it
/// costs 100 ms per batch (one batch types up to 64 distinct characters, any number of repeats).
pub const TEXT_RELEASE_HOLD: Duration = Duration::from_millis(100);

/// How deep below a root child the `_NET_WM_PID` search looks (frame → client is depth 1; some
/// window managers add one or two wrapper windows).
const SEARCH_DEPTH: usize = 3;
/// A bound on the windows one guard scan visits.
const SEARCH_MAX_WINDOWS: usize = 4096;

fn xerr(e: impl std::fmt::Display) -> String {
    format!("X11: {e}")
}

/// A reply that may legitimately fail because the window vanished meanwhile (`BadWindow`):
/// `Ok(None)` for an X error, `Err` only when the connection itself failed.
fn reply_opt<R>(r: Result<R, ReplyError>) -> Result<Option<R>, String> {
    match r {
        Ok(v) => Ok(Some(v)),
        Err(ReplyError::X11Error(_)) => Ok(None),
        Err(ReplyError::ConnectionError(e)) => Err(xerr(e)),
    }
}

/// The XTEST input sink on one explicit X display.
pub struct X11Input {
    conn: RustConnection,
    root: Window,
    net_wm_pid: xproto::Atom,
    agent_pid: u32,
    min_keycode: u8,
    max_keycode: u8,
    /// Keys and buttons this sink pressed and has not released, released on drop so a session
    /// that ends mid-chord leaves no key held on the Desk.
    held_keys: BTreeSet<u8>,
    held_buttons: BTreeSet<u8>,
}

/// Connect to `display` (for example `":0"`), check XTEST is present. Same as [`X11Input::open`].
pub fn open(display: &str) -> Result<X11Input, String> {
    X11Input::open(display)
}

impl X11Input {
    /// Connect to the explicit `display` (never read from the environment here), check the XTEST
    /// extension, and intern `_NET_WM_PID`. The agent pid defaults to `std::process::id()`.
    pub fn open(display: &str) -> Result<Self, String> {
        let (conn, screen) = RustConnection::connect(Some(display))
            .map_err(|e| format!("cannot connect to X display {display}: {e}"))?;
        let setup = conn.setup();
        let root = setup
            .roots
            .get(screen)
            .ok_or_else(|| format!("X display {display} has no screen {screen}"))?
            .root;
        let (min_keycode, max_keycode) = (setup.min_keycode, setup.max_keycode);
        if conn
            .extension_information(xtest::X11_EXTENSION_NAME)
            .map_err(xerr)?
            .is_none()
        {
            return Err(format!("X display {display} has no XTEST extension"));
        }
        conn.xtest_get_version(2, 2)
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?;
        let net_wm_pid = conn
            .intern_atom(false, b"_NET_WM_PID")
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?
            .atom;
        Ok(Self {
            conn,
            root,
            net_wm_pid,
            agent_pid: std::process::id(),
            min_keycode,
            max_keycode,
            held_keys: BTreeSet::new(),
            held_buttons: BTreeSet::new(),
        })
    }

    /// The pid whose windows are "agent windows" for rule 7.3c (default: this process).
    pub fn with_agent_pid(mut self, pid: u32) -> Self {
        self.agent_pid = pid;
        self
    }

    /// A round trip: when it returns, the server has processed every request this sink sent.
    pub fn sync(&self) -> Result<(), String> {
        self.conn.sync().map_err(xerr)
    }

    /// The agent's viewable top-level windows, read now (rule 7.3c reads them on every event):
    /// every viewable child of the root that is, or has within [`SEARCH_DEPTH`] levels below it,
    /// a window whose `_NET_WM_PID` is the agent pid. The rectangle is the root child's outer
    /// geometry (`GetGeometry`, border included): with a reparenting window manager that is the
    /// frame, so the decorations of an agent window are guarded too.
    pub fn agent_windows(&self) -> Result<Vec<AgentWindow>, String> {
        let tops = self
            .conn
            .query_tree(self.root)
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?
            .children;
        let attrs = tops
            .iter()
            .map(|&w| self.conn.get_window_attributes(w).map(|c| (w, c)))
            .collect::<Result<Vec<_>, ConnectionError>>()
            .map_err(xerr)?;
        let mut viewable = Vec::new();
        for (w, cookie) in attrs {
            if let Some(a) = reply_opt(cookie.reply())? {
                if a.map_state == MapState::VIEWABLE {
                    viewable.push(w);
                }
            }
        }
        let owned = self.tops_owned_by_agent(&viewable)?;
        let geometry = owned
            .iter()
            .map(|&w| self.conn.get_geometry(w))
            .collect::<Result<Vec<_>, ConnectionError>>()
            .map_err(xerr)?;
        let mut out = Vec::with_capacity(owned.len());
        for cookie in geometry {
            if let Some(g) = reply_opt(cookie.reply())? {
                let border = 2 * u32::from(g.border_width);
                out.push(AgentWindow {
                    x: i32::from(g.x),
                    y: i32::from(g.y),
                    width: u32::from(g.width) + border,
                    height: u32::from(g.height) + border,
                    viewable: true,
                });
            }
        }
        Ok(out)
    }

    /// Which of `tops` (root children) carry the agent pid on themselves or a descendant within
    /// [`SEARCH_DEPTH`]. Breadth first, one pipelined round of `GetProperty` + `QueryTree` per
    /// level.
    fn tops_owned_by_agent(&self, tops: &[Window]) -> Result<Vec<Window>, String> {
        let mut owned: Vec<Window> = Vec::new();
        let mut frontier: Vec<(Window, Window)> = tops.iter().map(|&t| (t, t)).collect();
        let mut visited = 0usize;
        for depth in 0..=SEARCH_DEPTH {
            if frontier.is_empty() {
                break;
            }
            visited += frontier.len();
            if visited > SEARCH_MAX_WINDOWS {
                tracing::warn!(visited, "agent-window scan bounded");
                break;
            }
            let mut cookies = Vec::with_capacity(frontier.len());
            for &(top, w) in &frontier {
                let pid = self
                    .conn
                    .get_property(false, w, self.net_wm_pid, AtomEnum::CARDINAL, 0, 1)
                    .map_err(xerr)?;
                let tree = if depth < SEARCH_DEPTH {
                    Some(self.conn.query_tree(w).map_err(xerr)?)
                } else {
                    None
                };
                cookies.push((top, pid, tree));
            }
            let mut next = Vec::new();
            for (top, pid, tree) in cookies {
                if owned.contains(&top) {
                    continue; // dropping the cookies discards their replies
                }
                let found = reply_opt(pid.reply())?
                    .and_then(|r| r.value32().and_then(|mut v| v.next()))
                    == Some(self.agent_pid);
                if found {
                    owned.push(top);
                    continue;
                }
                if let Some(tree) = tree {
                    if let Some(t) = reply_opt(tree.reply())? {
                        next.extend(t.children.iter().map(|&c| (top, c)));
                    }
                }
            }
            frontier = next
                .into_iter()
                .filter(|(top, _)| !owned.contains(top))
                .collect();
        }
        Ok(owned)
    }

    /// Whether an agent window would receive key events now (rule 7.3c), read live:
    /// `GetInputFocus`; for `PointerRoot` or the root window (keys then go to the window under
    /// the pointer) the pointer position is checked against [`Self::agent_windows`]; otherwise
    /// the focus window and its ancestors (`QueryTree` parents up to the root) are checked for the
    /// agent pid, and so is everything below the top-level they belong to (the focus may sit on a
    /// window manager frame whose client is the agent's). Focus `None` discards keys: not refused.
    pub fn focus_is_agent_window(&self) -> Result<bool, String> {
        let focus = self
            .conn
            .get_input_focus()
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?
            .focus;
        const POINTER_ROOT: Window = 1;
        if focus == NONE {
            return Ok(false);
        }
        if focus == POINTER_ROOT || focus == self.root {
            let p = self
                .conn
                .query_pointer(self.root)
                .map_err(xerr)?
                .reply()
                .map_err(xerr)?;
            let windows = self.agent_windows()?;
            return Ok(pointer_refused(
                i32::from(p.root_x),
                i32::from(p.root_y),
                &windows,
            ));
        }
        let mut chain = vec![focus];
        let mut w = focus;
        loop {
            let tree = self
                .conn
                .query_tree(w)
                .map_err(xerr)?
                .reply()
                .map_err(xerr)?;
            if tree.parent == self.root || tree.parent == NONE || chain.len() > 64 {
                break;
            }
            w = tree.parent;
            chain.push(w);
        }
        let pids = chain
            .iter()
            .map(|&w| {
                self.conn
                    .get_property(false, w, self.net_wm_pid, AtomEnum::CARDINAL, 0, 1)
            })
            .collect::<Result<Vec<_>, ConnectionError>>()
            .map_err(xerr)?;
        for cookie in pids {
            let pid =
                reply_opt(cookie.reply())?.and_then(|r| r.value32().and_then(|mut v| v.next()));
            if pid == Some(self.agent_pid) {
                return Ok(true);
            }
        }
        // `w` is the top-level (root child) the focus belongs to.
        Ok(!self.tops_owned_by_agent(&[w])?.is_empty())
    }

    fn fake(&self, type_: u8, detail: u8, root: Window, x: i16, y: i16) -> Result<(), String> {
        self.conn
            .xtest_fake_input(type_, detail, CURRENT_TIME, root, x, y, 0)
            .map_err(xerr)?;
        Ok(())
    }

    fn motion(&self, (x, y): (i16, i16)) -> Result<(), String> {
        // detail 0 = absolute; the coordinates are relative to `root`.
        self.fake(xproto::MOTION_NOTIFY_EVENT, 0, self.root, x, y)
    }

    fn button(&mut self, button: u8, down: bool) -> Result<(), String> {
        let ty = if down {
            xproto::BUTTON_PRESS_EVENT
        } else {
            xproto::BUTTON_RELEASE_EVENT
        };
        self.fake(ty, button, NONE, 0, 0)?;
        if down {
            self.held_buttons.insert(button);
        } else {
            self.held_buttons.remove(&button);
        }
        Ok(())
    }

    fn key_event(&self, keycode: u8, down: bool) -> Result<(), String> {
        let ty = if down {
            xproto::KEY_PRESS_EVENT
        } else {
            xproto::KEY_RELEASE_EVENT
        };
        self.fake(ty, keycode, NONE, 0, 0)
    }

    fn try_pointer(
        &mut self,
        monitor: &MonitorInfo,
        nx: f32,
        ny: f32,
        action: PointerAction,
    ) -> Result<(), String> {
        self.motion(xtest_point(to_root(monitor, nx, ny)))?;
        let (b, presses, releases) = match action {
            PointerAction::Move => (0, 0, 0),
            PointerAction::Down(b) => (b, 1, 0),
            PointerAction::Up(b) => (b, 0, 1),
            PointerAction::Click(b) => (b, 1, 1),
            PointerAction::DblClick(b) => (b, 2, 2),
        };
        if presses + releases > 0 {
            if let Some(xb) = x_button(b) {
                match (presses, releases) {
                    (1, 0) => self.button(xb, true)?,
                    (0, 1) => self.button(xb, false)?,
                    (n, _) => {
                        for _ in 0..n {
                            self.button(xb, true)?;
                            self.button(xb, false)?;
                        }
                    }
                }
            }
        }
        self.conn.flush().map_err(xerr)
    }

    fn try_scroll(
        &mut self,
        monitor: &MonitorInfo,
        nx: f32,
        ny: f32,
        dx: i32,
        dy: i32,
    ) -> Result<(), String> {
        self.motion(xtest_point(to_root(monitor, nx, ny)))?;
        for (button, clicks) in wheel_clicks(dx, dy) {
            for _ in 0..clicks {
                self.fake(xproto::BUTTON_PRESS_EVENT, button, NONE, 0, 0)?;
                self.fake(xproto::BUTTON_RELEASE_EVENT, button, NONE, 0, 0)?;
            }
        }
        self.conn.flush().map_err(xerr)
    }

    fn try_key(&mut self, code: &str, action: KeyAction) -> Result<(), String> {
        let Some(kc) = x_keycode_for_code(code) else {
            return Ok(()); // unknown codes are refused upstream with bad_args
        };
        if kc < self.min_keycode || kc > self.max_keycode {
            return Ok(());
        }
        match action {
            KeyAction::Down => {
                self.key_event(kc, true)?;
                self.held_keys.insert(kc);
            }
            KeyAction::Up => {
                self.key_event(kc, false)?;
                self.held_keys.remove(&kc);
            }
            KeyAction::Press => {
                self.key_event(kc, true)?;
                self.key_event(kc, false)?;
            }
        }
        self.conn.flush().map_err(xerr)
    }

    /// Bind `keysyms` to consecutive keycodes from `first` (two levels, both the same keysym, so
    /// a held Shift does not change the character).
    fn set_keysyms(&self, first: u8, keysyms: &[u32]) -> Result<(), String> {
        let per_key: Vec<u32> = keysyms.iter().flat_map(|&k| [k, k]).collect();
        let count = u8::try_from(keysyms.len()).map_err(|_| "too many keysyms".to_string())?;
        self.conn
            .change_keyboard_mapping(count, first, 2, &per_key)
            .map_err(xerr)?;
        Ok(())
    }

    fn try_text(&mut self, text: &str) -> Result<(), String> {
        let keysyms = text_keysyms(text);
        if keysyms.is_empty() {
            return Ok(());
        }
        let count = self.max_keycode - self.min_keycode + 1;
        let mapping = self
            .conn
            .get_keyboard_mapping(self.min_keycode, count)
            .map_err(xerr)?
            .reply()
            .map_err(xerr)?;
        let spare = spare_keycodes(
            self.min_keycode,
            mapping.keysyms_per_keycode,
            &mapping.keysyms,
        );
        if spare.is_empty() {
            return Err("no spare keycode to type text with".into());
        }
        for batch in plan_batches(&keysyms, &spare) {
            let runs = binding_runs(&batch.bindings);
            let restore = Restore {
                input: self,
                runs: &runs,
            };
            for (first, syms) in &runs {
                restore.input.set_keysyms(*first, syms)?;
            }
            restore.input.sync()?;
            std::thread::sleep(TEXT_BIND_SETTLE);
            for &kc in &batch.presses {
                restore.input.key_event(kc, true)?;
                restore.input.key_event(kc, false)?;
            }
            restore.input.sync()?;
            std::thread::sleep(TEXT_RELEASE_HOLD);
            restore.finish()?;
        }
        Ok(())
    }
}

/// Restores a text batch's keycodes to `NoSymbol`, explicitly through [`Restore::finish`] or, if
/// the batch failed half-way, on drop (best effort).
struct Restore<'a> {
    input: &'a X11Input,
    runs: &'a [(u8, Vec<u32>)],
}

impl Restore<'_> {
    fn restore(&self) -> Result<(), String> {
        for (first, syms) in self.runs {
            self.input
                .set_keysyms(*first, &vec![NO_SYMBOL; syms.len()])?;
        }
        self.input.sync()
    }

    fn finish(self) -> Result<(), String> {
        let r = self.restore();
        std::mem::forget(self);
        r
    }
}

impl Drop for Restore<'_> {
    fn drop(&mut self) {
        if let Err(e) = self.restore() {
            tracing::warn!(error = %e, "could not restore the keyboard mapping after os.text");
        }
    }
}

impl InputSink for X11Input {
    fn pointer(&mut self, monitor: &MonitorInfo, nx: f32, ny: f32, action: PointerAction) {
        if let Err(e) = self.try_pointer(monitor, nx, ny, action) {
            tracing::warn!(error = %e, "X11 pointer injection failed");
        }
    }

    fn scroll(&mut self, monitor: &MonitorInfo, nx: f32, ny: f32, dx: i32, dy: i32) {
        if let Err(e) = self.try_scroll(monitor, nx, ny, dx, dy) {
            tracing::warn!(error = %e, "X11 scroll injection failed");
        }
    }

    fn key(&mut self, code: &str, action: KeyAction, _modifiers: Modifiers) {
        if let Err(e) = self.try_key(code, action) {
            tracing::warn!(error = %e, "X11 key injection failed");
        }
    }

    /// Types `text` through spare keycodes, in batches of up to 64 distinct characters. Per
    /// batch: bind (`ChangeKeyboardMapping`), round trip, wait [`TEXT_BIND_SETTLE`], press and
    /// release each character, round trip, keep the binding [`TEXT_RELEASE_HOLD`], restore the
    /// keycodes to `NoSymbol`, round trip. Blocks the caller for about 110 ms per batch.
    ///
    /// Known difference from `KEYEVENTF_UNICODE`: a held Ctrl or Alt applies to the typed
    /// character (as for any key), and Xlib's Caps Lock case conversion may upper-case a letter
    /// typed while Caps Lock is on.
    fn text(&mut self, text: &str) {
        if let Err(e) = self.try_text(text) {
            tracing::warn!(error = %e, "X11 text injection failed"); // the text is never logged
        }
    }

    /// Rule 7.3c: refused when the root point lies inside a viewable agent window, read live.
    /// Fails closed: when the windows cannot be read, the event is refused.
    fn refuses_pointer(&mut self, monitor: &MonitorInfo, nx: f32, ny: f32) -> bool {
        let (x, y) = to_root(monitor, nx, ny);
        match self.agent_windows() {
            Ok(windows) => pointer_refused(x, y, &windows),
            Err(e) => {
                tracing::warn!(error = %e, "agent windows unreadable; refusing pointer input");
                true
            }
        }
    }

    /// Rule 7.3c: refused while an agent window holds the input focus, read live. Fails closed.
    fn refuses_keyboard(&mut self) -> bool {
        match self.focus_is_agent_window() {
            Ok(agent) => keyboard_refused(agent),
            Err(e) => {
                tracing::warn!(error = %e, "input focus unreadable; refusing keyboard input");
                true
            }
        }
    }
}

impl Drop for X11Input {
    /// Release whatever this sink still holds down (a session that ends mid-drag or mid-chord).
    fn drop(&mut self) {
        if self.held_keys.is_empty() && self.held_buttons.is_empty() {
            return;
        }
        for kc in std::mem::take(&mut self.held_keys) {
            let _ = self.key_event(kc, false);
        }
        for b in std::mem::take(&mut self.held_buttons) {
            let _ = self.fake(xproto::BUTTON_RELEASE_EVENT, b, NONE, 0, 0);
        }
        let _ = self.conn.flush();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_sink_is_send() {
        fn assert_send<T: Send>() {}
        assert_send::<super::X11Input>();
    }
}
