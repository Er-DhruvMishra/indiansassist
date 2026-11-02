//! Pointer mapping (Phase E §7.2): normalised monitor coordinates → X root-window pixels, and the
//! W3C button / wheel numbering → X core buttons. Pure; tested on every host.
//!
//! The wire semantics are the Windows sink's (`ia-input-win`): `nx, ny` in `0..=1` over one
//! `MonitorInfo` (root-window pixels on X11, from RandR), W3C buttons `0..=4`, and `os.scroll`
//! `dx, dy` in wheel notches where a positive `dy` scrolls **down** and a positive `dx` scrolls
//! **right** (Windows: `mouseData = -dy * WHEEL_DELTA`, `hwheel = dx * WHEEL_DELTA`). One notch is
//! one X wheel click, the X equivalent of one `WHEEL_DELTA`.

use ia_core::types::MonitorInfo;

/// X core button numbers.
pub const BUTTON_LEFT: u8 = 1;
pub const BUTTON_MIDDLE: u8 = 2;
pub const BUTTON_RIGHT: u8 = 3;
pub const WHEEL_UP: u8 = 4;
pub const WHEEL_DOWN: u8 = 5;
pub const WHEEL_LEFT: u8 = 6;
pub const WHEEL_RIGHT: u8 = 7;
pub const BUTTON_BACK: u8 = 8;
pub const BUTTON_FORWARD: u8 = 9;

/// The most wheel clicks one `os.scroll` axis produces (the control server already refuses
/// `|dx|, |dy| > 20` with `bad_args`; this bounds the loop independently).
pub const MAX_WHEEL_CLICKS: u32 = 20;

/// Normalised (`nx`, `ny`) on `monitor` → root-window pixel. Clamped inside the monitor with the
/// last pixel inclusive: `0.0` is the first column / row, `1.0` the last
/// (`x + round(nx * (width - 1))`). A non-finite input is treated as `0.0`.
pub fn to_root(monitor: &MonitorInfo, nx: f32, ny: f32) -> (i32, i32) {
    (
        axis(monitor.x, monitor.width, nx),
        axis(monitor.y, monitor.height, ny),
    )
}

fn axis(origin: i32, len: u32, n: f32) -> i32 {
    let n = if n.is_finite() {
        f64::from(n.clamp(0.0, 1.0))
    } else {
        0.0
    };
    let last = f64::from(len.max(1) - 1);
    let offset = (n * last).round() as i64;
    (i64::from(origin) + offset).clamp(i64::from(i32::MIN), i64::from(i32::MAX)) as i32
}

/// A root pixel as the `i16` pair XTEST `FakeInput` carries (X coordinates are 16-bit).
pub fn xtest_point((x, y): (i32, i32)) -> (i16, i16) {
    (
        x.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16,
        y.clamp(i32::from(i16::MIN), i32::from(i16::MAX)) as i16,
    )
}

/// W3C `MouseEvent.button` (0 left, 1 middle, 2 right, 3 back, 4 forward) → X core button.
/// Anything else is `None` and is not injected (the wire schema allows only `0..=4`).
pub fn x_button(w3c: u8) -> Option<u8> {
    match w3c {
        0 => Some(BUTTON_LEFT),
        1 => Some(BUTTON_MIDDLE),
        2 => Some(BUTTON_RIGHT),
        3 => Some(BUTTON_BACK),
        4 => Some(BUTTON_FORWARD),
        _ => None,
    }
}

/// `os.scroll` notches → `(X wheel button, clicks)`, vertical first then horizontal (the order
/// the Windows sink sends `WHEEL` then `HWHEEL`). Each click is one press + release.
pub fn wheel_clicks(dx: i32, dy: i32) -> Vec<(u8, u32)> {
    let mut out = Vec::with_capacity(2);
    let clicks = |n: i32| n.unsigned_abs().min(MAX_WHEEL_CLICKS);
    if dy > 0 {
        out.push((WHEEL_DOWN, clicks(dy)));
    } else if dy < 0 {
        out.push((WHEEL_UP, clicks(dy)));
    }
    if dx > 0 {
        out.push((WHEEL_RIGHT, clicks(dx)));
    } else if dx < 0 {
        out.push((WHEEL_LEFT, clicks(dx)));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(x: i32, y: i32, w: u32, h: u32) -> MonitorInfo {
        MonitorInfo {
            id: 1,
            name: "X11-1".into(),
            primary: true,
            x,
            y,
            width: w,
            height: h,
            scale: 1.0,
            mid: None,
        }
    }

    #[test]
    fn corners_are_the_first_and_last_pixel() {
        let m = mon(0, 0, 1920, 1080);
        assert_eq!(to_root(&m, 0.0, 0.0), (0, 0));
        assert_eq!(to_root(&m, 1.0, 1.0), (1919, 1079));
        assert_eq!(to_root(&m, 0.5, 0.5), (960, 540));
    }

    #[test]
    fn a_second_monitor_is_offset_by_its_origin() {
        // Two 1920x1080 RandR monitors side by side on one 3840x1080 root.
        let right = mon(1920, 0, 1920, 1080);
        assert_eq!(to_root(&right, 0.0, 0.0), (1920, 0));
        assert_eq!(to_root(&right, 1.0, 1.0), (3839, 1079));
        // A pixel p on the monitor round-trips through nx = p / (width - 1).
        for p in [0u32, 1, 180, 959, 1918, 1919] {
            let nx = p as f32 / 1919.0;
            assert_eq!(to_root(&right, nx, 0.0).0, 1920 + p as i32, "pixel {p}");
        }
    }

    #[test]
    fn negative_origins_and_stacked_monitors() {
        let left = mon(-1280, 0, 1280, 1024);
        assert_eq!(to_root(&left, 0.0, 0.0), (-1280, 0));
        assert_eq!(to_root(&left, 1.0, 1.0), (-1, 1023));
        let below = mon(0, 1080, 1920, 1200);
        assert_eq!(to_root(&below, 0.0, 1.0), (0, 2279));
    }

    #[test]
    fn out_of_range_and_non_finite_inputs_are_clamped_inside_the_monitor() {
        let m = mon(100, 50, 800, 600);
        assert_eq!(to_root(&m, -0.5, 2.0), (100, 649));
        assert_eq!(to_root(&m, f32::NAN, f32::INFINITY), (100, 50));
        assert_eq!(to_root(&m, f32::NEG_INFINITY, f32::NAN), (100, 50));
    }

    #[test]
    fn degenerate_monitor_maps_to_its_origin() {
        let m = mon(10, 20, 0, 1);
        assert_eq!(to_root(&m, 1.0, 1.0), (10, 20));
    }

    #[test]
    fn xtest_points_are_clamped_to_16_bits() {
        assert_eq!(xtest_point((100, 200)), (100, 200));
        assert_eq!(xtest_point((70_000, -70_000)), (i16::MAX, i16::MIN));
    }

    #[test]
    fn buttons() {
        assert_eq!(x_button(0), Some(1));
        assert_eq!(x_button(1), Some(2));
        assert_eq!(x_button(2), Some(3));
        assert_eq!(x_button(3), Some(8));
        assert_eq!(x_button(4), Some(9));
        assert_eq!(x_button(5), None);
        assert_eq!(x_button(255), None);
    }

    #[test]
    fn wheel_sign_convention_matches_the_windows_sink() {
        // Windows: dy > 0 → negative mouseData → scroll down; X: button 5.
        assert_eq!(wheel_clicks(0, 1), vec![(WHEEL_DOWN, 1)]);
        assert_eq!(wheel_clicks(0, -3), vec![(WHEEL_UP, 3)]);
        // Windows: dx > 0 → positive hwheel → scroll right; X: button 7.
        assert_eq!(wheel_clicks(2, 0), vec![(WHEEL_RIGHT, 2)]);
        assert_eq!(wheel_clicks(-1, 0), vec![(WHEEL_LEFT, 1)]);
        assert_eq!(wheel_clicks(-2, 4), vec![(WHEEL_DOWN, 4), (WHEEL_LEFT, 2)]);
        assert!(wheel_clicks(0, 0).is_empty());
    }

    #[test]
    fn wheel_clicks_are_bounded() {
        assert_eq!(
            wheel_clicks(0, i32::MIN),
            vec![(WHEEL_UP, MAX_WHEEL_CLICKS)]
        );
        assert_eq!(wheel_clicks(500, 0), vec![(WHEEL_RIGHT, MAX_WHEEL_CLICKS)]);
    }
}
