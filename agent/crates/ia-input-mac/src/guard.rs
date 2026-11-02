//! The C §3.5 / E rule 7.3c injection guard on macOS, as a pure decision (Phase F §17.2): injected
//! input never operates the agent's own windows. Quartz does not mark a posted event for the
//! receiving app, so, as on X11, the sink decides **before** posting: a pointer or scroll event
//! whose global point lies inside an on-screen agent window is refused, and a key or text event
//! is refused while the agent is the active application (one of its windows has the keyboard).
//! The control server answers a refusal `ctl.res { ok: false, error: 'not_allowed' }`.
//!
//! The sink reads the agent's windows live (`CGWindowListCopyWindowInfo`, filtered to this
//! process) on every call and feeds them here.

/// One of the agent's own windows in global points (`kCGWindowBounds`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AgentWindow {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// `kCGWindowIsOnscreen`: an ordered-out window cannot be operated and does not refuse.
    pub on_screen: bool,
}

impl AgentWindow {
    /// Whether the global point lies in this window: `x <= px < x + width`, the same for y.
    pub fn contains(&self, px: f64, py: f64) -> bool {
        self.width > 0.0
            && self.height > 0.0
            && px >= self.x
            && px < self.x + self.width
            && py >= self.y
            && py < self.y + self.height
    }
}

/// Pointer and scroll: refused when the point is inside any on-screen agent window.
pub fn pointer_refused(px: f64, py: f64, windows: &[AgentWindow]) -> bool {
    windows.iter().any(|w| w.on_screen && w.contains(px, py))
}

/// Key and text: refused while the agent is the active application.
pub fn keyboard_refused(agent_is_active: bool) -> bool {
    agent_is_active
}

#[cfg(test)]
mod tests {
    use super::*;

    const PILL: AgentWindow = AgentWindow {
        x: 600.0,
        y: 0.0,
        width: 300.0,
        height: 44.0,
        on_screen: true,
    };

    #[test]
    fn a_point_on_the_pill_is_refused_and_one_beside_it_is_not() {
        assert!(pointer_refused(600.0, 0.0, &[PILL]));
        assert!(pointer_refused(899.5, 43.5, &[PILL]));
        assert!(
            !pointer_refused(900.0, 10.0, &[PILL]),
            "right edge is exclusive"
        );
        assert!(!pointer_refused(599.9, 10.0, &[PILL]));
        assert!(!pointer_refused(700.0, 44.0, &[PILL]));
    }

    #[test]
    fn hidden_and_empty_windows_never_refuse() {
        let hidden = AgentWindow {
            on_screen: false,
            ..PILL
        };
        let empty = AgentWindow { width: 0.0, ..PILL };
        assert!(!pointer_refused(700.0, 10.0, &[hidden, empty]));
        assert!(!pointer_refused(700.0, 10.0, &[]));
    }

    #[test]
    fn the_keyboard_is_refused_only_while_the_agent_is_active() {
        assert!(keyboard_refused(true));
        assert!(!keyboard_refused(false));
    }
}
