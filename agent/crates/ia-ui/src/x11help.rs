//! The X11 window treatment of the pill and panel (Phase E §7.2, §7.3b), the Linux counterpart
//! of `winhelp`: find the agent's own eframe windows (by `_NET_WM_PID` and title), mark the pill
//! `_NET_WM_WINDOW_TYPE_UTILITY`, ask the window manager for `_NET_WM_STATE_ABOVE` +
//! `_NET_WM_STATE_SKIP_TASKBAR` + `_NET_WM_STATE_SKIP_PAGER` (re-asserted every 2 s), and report
//! whether a window is still mapped so the pill can be re-shown (the pill is mandatory).
//!
//! The pill is **not** excluded from capture: X11 has no `WDA_EXCLUDEFROMCAPTURE` (rule 7.3b).
//! Every call is best effort: no window manager (Xvfb) or a manager that ignores EWMH simply
//! leaves the window as winit made it.

use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    AtomEnum, ClientMessageEvent, ConnectionExt, EventMask, MapState, PropMode, Window,
};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;

/// One connection to the session's X server for the window treatment.
pub struct X11Help {
    conn: RustConnection,
    root: Window,
    pid: u32,
}

fn atom(conn: &RustConnection, name: &str) -> Option<u32> {
    conn.intern_atom(false, name.as_bytes())
        .ok()?
        .reply()
        .ok()
        .map(|r| r.atom)
}

impl X11Help {
    /// Connect to `DISPLAY` (the agent's own session display). `None` when there is none.
    pub fn connect() -> Option<Self> {
        let display = std::env::var("DISPLAY").ok().filter(|d| !d.is_empty())?;
        let (conn, screen) = x11rb::connect(Some(&display)).ok()?;
        let root = conn.setup().roots.get(screen)?.root;
        Some(Self {
            conn,
            root,
            pid: std::process::id(),
        })
    }

    fn property_u32(&self, win: Window, name: &str) -> Option<u32> {
        let a = atom(&self.conn, name)?;
        let r = self
            .conn
            .get_property(false, win, a, AtomEnum::CARDINAL, 0, 1)
            .ok()?
            .reply()
            .ok()?;
        let v = r.value32()?.next();
        v
    }

    fn title(&self, win: Window) -> Option<String> {
        let utf8 = atom(&self.conn, "UTF8_STRING")?;
        let net_name = atom(&self.conn, "_NET_WM_NAME")?;
        for (prop, ty) in [
            (net_name, utf8),
            (AtomEnum::WM_NAME.into(), AtomEnum::STRING.into()),
        ] {
            if let Ok(Ok(r)) = self
                .conn
                .get_property(false, win, prop, ty, 0, 256)
                .map(|c| c.reply())
            {
                if !r.value.is_empty() {
                    return Some(String::from_utf8_lossy(&r.value).into_owned());
                }
            }
        }
        None
    }

    /// The agent's own window titled `title` (searching the root's children and, under a
    /// reparenting window manager, one level below each frame).
    pub fn find_own_window(&self, title: &str) -> Option<Window> {
        let tree = self.conn.query_tree(self.root).ok()?.reply().ok()?;
        for top in tree.children {
            let mut candidates = vec![top];
            if let Ok(Ok(sub)) = self.conn.query_tree(top).map(|c| c.reply()) {
                candidates.extend(sub.children);
            }
            for w in candidates {
                if self.property_u32(w, "_NET_WM_PID") == Some(self.pid)
                    && self.title(w).as_deref() == Some(title)
                {
                    return Some(w);
                }
            }
        }
        None
    }

    /// Mark `win` a utility window and ask for above / skip-taskbar / skip-pager.
    pub fn style_pill(&self, win: Window) {
        if let (Some(ty), Some(utility)) = (
            atom(&self.conn, "_NET_WM_WINDOW_TYPE"),
            atom(&self.conn, "_NET_WM_WINDOW_TYPE_UTILITY"),
        ) {
            let _ =
                self.conn
                    .change_property32(PropMode::REPLACE, win, ty, AtomEnum::ATOM, &[utility]);
        }
        self.reassert(win);
    }

    /// Re-send `_NET_WM_STATE` add ABOVE + SKIP_TASKBAR + SKIP_PAGER (every 2 s while live).
    pub fn reassert(&self, win: Window) {
        let Some(state) = atom(&self.conn, "_NET_WM_STATE") else {
            return;
        };
        let names = [
            ("_NET_WM_STATE_ABOVE", "_NET_WM_STATE_SKIP_TASKBAR"),
            ("_NET_WM_STATE_SKIP_PAGER", "_NET_WM_STATE_STICKY"),
        ];
        for (a, b) in names {
            let (Some(a), Some(b)) = (atom(&self.conn, a), atom(&self.conn, b)) else {
                continue;
            };
            // _NET_WM_STATE_ADD = 1; source indication 1 = a normal application.
            let ev = ClientMessageEvent::new(32, win, state, [1, a, b, 1, 0]);
            let _ = self.conn.send_event(
                false,
                self.root,
                EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
                ev,
            );
        }
        let _ = self.conn.flush();
    }

    /// Whether `win` is still mapped and viewable (the pill is re-shown when it is not).
    pub fn is_viewable(&self, win: Window) -> bool {
        self.conn
            .get_window_attributes(win)
            .ok()
            .and_then(|c| c.reply().ok())
            .is_some_and(|a| a.map_state == MapState::VIEWABLE)
    }
}
