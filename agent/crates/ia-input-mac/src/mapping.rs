//! Pointer mapping (Phase F §17.2): normalised monitor coordinates → the global display space of
//! Quartz (points, origin at the top-left of the main display, y down), W3C buttons → Quartz
//! mouse buttons and event types, and the wheel. Pure; tested on every host.
//!
//! The wire semantics are the Windows sink's: `nx, ny` in `0..=1` over one `MonitorInfo` (on
//! macOS its `x, y, width, height` are the display's bounds in global points, `CGDisplayBounds`),
//! W3C buttons `0..=4`, and `os.scroll` `dx, dy` in wheel notches where a positive `dy` scrolls
//! **down** and a positive `dx` scrolls **right**. One notch is one line-unit wheel click.

use ia_core::types::MonitorInfo;

/// The most wheel clicks one `os.scroll` axis produces (the control server already refuses
/// `|dx|, |dy| > 20` with `bad_args`; this bounds the value independently).
pub const MAX_WHEEL_CLICKS: i32 = 20;

/// Normalised (`nx`, `ny`) on `monitor` → a global point. Clamped inside the display with the last
/// point inclusive (`x + nx * (width - 1)`), so `1.0` never lands on the next display. A
/// non-finite input is treated as `0.0`.
pub fn to_global(monitor: &MonitorInfo, nx: f32, ny: f32) -> (f64, f64) {
    (
        axis(monitor.x, monitor.width, nx),
        axis(monitor.y, monitor.height, ny),
    )
}

fn axis(origin: i32, len: u32, n: f32) -> f64 {
    let n = if n.is_finite() {
        f64::from(n.clamp(0.0, 1.0))
    } else {
        0.0
    };
    f64::from(origin) + (n * f64::from(len.max(1) - 1)).round()
}

/// A Quartz mouse button (`CGMouseButton`) and the event types that go with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct MacButton {
    /// `kCGMouseButtonLeft` 0, `Right` 1, `Center` 2, then 3 and 4 for back and forward.
    pub number: u32,
    pub down: u32,
    pub up: u32,
    pub dragged: u32,
}

/// `kCGEventMouseMoved`.
pub const MOUSE_MOVED: u32 = 5;

/// W3C `MouseEvent.button` (0 left, 1 middle, 2 right, 3 back, 4 forward) → Quartz. Anything else
/// is `None` and is not injected (the wire schema allows only `0..=4`).
pub fn mac_button(w3c: u8) -> Option<MacButton> {
    // kCGEventLeftMouseDown/Up/Dragged 1/2/6, Right 3/4/7, Other 25/26/27.
    match w3c {
        0 => Some(MacButton {
            number: 0,
            down: 1,
            up: 2,
            dragged: 6,
        }),
        2 => Some(MacButton {
            number: 1,
            down: 3,
            up: 4,
            dragged: 7,
        }),
        1 => Some(MacButton {
            number: 2,
            down: 25,
            up: 26,
            dragged: 27,
        }),
        3 => Some(MacButton {
            number: 3,
            down: 25,
            up: 26,
            dragged: 27,
        }),
        4 => Some(MacButton {
            number: 4,
            down: 25,
            up: 26,
            dragged: 27,
        }),
        _ => None,
    }
}

/// The event type of a pointer move while `held` buttons are down: Quartz delivers drags as
/// their own types, and an app that sees `MouseMoved` with a button down drops the drag.
pub fn move_type(held: &[MacButton]) -> u32 {
    held.first().map_or(MOUSE_MOVED, |b| b.dragged)
}

/// `os.scroll` → `CGEventCreateScrollWheelEvent2` line units: `(wheel1, wheel2)`, vertical then
/// horizontal, where a positive wheel1 scrolls up and a positive wheel2 scrolls left in Quartz.
pub fn wheel(dx: i32, dy: i32) -> (i32, i32) {
    (
        -dy.clamp(-MAX_WHEEL_CLICKS, MAX_WHEEL_CLICKS),
        -dx.clamp(-MAX_WHEEL_CLICKS, MAX_WHEEL_CLICKS),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(x: i32, y: i32, width: u32, height: u32) -> MonitorInfo {
        MonitorInfo {
            id: 1,
            name: "Built-in Retina Display".into(),
            primary: x == 0 && y == 0,
            x,
            y,
            width,
            height,
            scale: 2.0,
            mid: None,
        }
    }

    #[test]
    fn corners_stay_on_the_display() {
        let m = display(0, 0, 1512, 982);
        assert_eq!(to_global(&m, 0.0, 0.0), (0.0, 0.0));
        assert_eq!(to_global(&m, 1.0, 1.0), (1511.0, 981.0));
        assert_eq!(to_global(&m, 0.5, 0.5), (756.0, 491.0));
        assert_eq!(to_global(&m, -3.0, 9.0), (0.0, 981.0));
        assert_eq!(to_global(&m, f32::NAN, f32::INFINITY), (0.0, 0.0));
    }

    #[test]
    fn a_secondary_display_left_of_and_above_the_main_one_has_negative_origins() {
        let m = display(-1920, -1080, 1920, 1080);
        assert_eq!(to_global(&m, 0.0, 0.0), (-1920.0, -1080.0));
        assert_eq!(to_global(&m, 1.0, 1.0), (-1.0, -1.0));
    }

    #[test]
    fn buttons_and_their_event_types() {
        assert_eq!(
            mac_button(0).map(|b| (b.number, b.down, b.up)),
            Some((0, 1, 2))
        );
        assert_eq!(
            mac_button(2).map(|b| (b.number, b.down, b.up)),
            Some((1, 3, 4))
        );
        assert_eq!(
            mac_button(1).map(|b| (b.number, b.down, b.up)),
            Some((2, 25, 26))
        );
        assert_eq!(mac_button(4).map(|b| b.number), Some(4));
        assert_eq!(mac_button(5), None);
        assert_eq!(move_type(&[]), MOUSE_MOVED);
        assert_eq!(move_type(&[mac_button(0).unwrap()]), 6);
        assert_eq!(move_type(&[mac_button(2).unwrap()]), 7);
    }

    #[test]
    fn positive_dy_scrolls_down_and_positive_dx_scrolls_right() {
        assert_eq!(wheel(0, 3), (-3, 0));
        assert_eq!(wheel(2, 0), (0, -2));
        assert_eq!(wheel(-99, 99), (-20, 20));
    }
}
