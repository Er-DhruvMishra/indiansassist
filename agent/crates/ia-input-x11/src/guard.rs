//! The rule 7.3c injection guard, as a pure decision (Phase E §7.3c, binding): injected input
//! never operates the agent's own windows. X11 marks no injected event, so the sink decides
//! **before** injecting: a pointer or scroll event whose root point lies inside any viewable agent
//! window is refused, and a key or text event is refused while an agent window holds the input
//! focus. The control server answers a refusal `ctl.res { ok: false, error: 'not_allowed' }`.
//!
//! The X11 sink (`X11Input`) reads the windows live on every call and feeds them here.

/// One of the agent's own top-level windows in root coordinates. On a reparenting window manager
/// this is the **frame** around the agent's client window (title bar and close button included),
/// so the decorations of a consent window are guarded too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentWindow {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    /// `map_state == Viewable`: an unmapped (hidden) window cannot be operated and does not refuse.
    pub viewable: bool,
}

impl AgentWindow {
    /// Whether the root pixel lies in this window, edges inclusive: the window covers the pixels
    /// `x ..= x + width - 1` and `y ..= y + height - 1`. A zero-sized window covers nothing.
    pub fn contains(&self, root_x: i32, root_y: i32) -> bool {
        let (x, y) = (i64::from(root_x), i64::from(root_y));
        let (left, top) = (i64::from(self.x), i64::from(self.y));
        self.width > 0
            && self.height > 0
            && x >= left
            && x < left + i64::from(self.width)
            && y >= top
            && y < top + i64::from(self.height)
    }
}

/// Rule 7.3c, pointer and scroll: refused when the point is inside any viewable agent window.
pub fn pointer_refused(root_x: i32, root_y: i32, windows: &[AgentWindow]) -> bool {
    windows
        .iter()
        .any(|w| w.viewable && w.contains(root_x, root_y))
}

/// Rule 7.3c, key and text: refused while an agent window holds the input focus.
pub fn keyboard_refused(focus_is_agent_window: bool) -> bool {
    focus_is_agent_window
}

#[cfg(test)]
mod tests {
    use super::*;

    fn win(x: i32, y: i32, width: u32, height: u32, viewable: bool) -> AgentWindow {
        AgentWindow {
            x,
            y,
            width,
            height,
            viewable,
        }
    }

    #[test]
    fn pointer_table() {
        let pill = win(100, 100, 300, 200, true); // pixels 100..=399 x 100..=299
        let hidden = win(1000, 0, 400, 400, false);
        let ws = [pill, hidden];
        let cases: &[(i32, i32, bool, &str)] = &[
            (250, 200, true, "centre"),
            (100, 100, true, "top-left pixel"),
            (399, 299, true, "bottom-right pixel"),
            (399, 100, true, "top-right pixel"),
            (100, 299, true, "bottom-left pixel"),
            (99, 200, false, "one left of the window"),
            (400, 200, false, "one right of the window"),
            (250, 99, false, "one above"),
            (250, 300, false, "one below"),
            (1200, 200, false, "inside a hidden window"),
            (-5, -5, false, "off the root"),
        ];
        for (x, y, want, what) in cases {
            assert_eq!(pointer_refused(*x, *y, &ws), *want, "{what} ({x}, {y})");
        }
    }

    #[test]
    fn any_of_several_windows_refuses() {
        let ws = [win(0, 0, 10, 10, true), win(-200, 500, 100, 50, true)];
        assert!(pointer_refused(5, 5, &ws));
        assert!(pointer_refused(-200, 549, &ws));
        assert!(pointer_refused(-101, 500, &ws));
        assert!(!pointer_refused(-100, 500, &ws));
        assert!(!pointer_refused(50, 50, &ws));
    }

    #[test]
    fn no_windows_or_empty_windows_never_refuse() {
        assert!(!pointer_refused(0, 0, &[]));
        let ws = [win(0, 0, 0, 10, true), win(0, 0, 10, 0, true)];
        assert!(!pointer_refused(0, 0, &ws));
    }

    #[test]
    fn extreme_geometry_does_not_overflow() {
        let ws = [win(i32::MAX - 1, i32::MAX - 1, u32::MAX, u32::MAX, true)];
        assert!(pointer_refused(i32::MAX, i32::MAX, &ws));
        assert!(!pointer_refused(i32::MIN, 0, &ws));
    }

    #[test]
    fn keyboard_table() {
        assert!(keyboard_refused(true));
        assert!(!keyboard_refused(false));
    }
}
