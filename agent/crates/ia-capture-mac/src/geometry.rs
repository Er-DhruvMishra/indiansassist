//! Display geometry and capture size (Phase F §17.2), pure and tested on every host.
//!
//! macOS describes displays in Quartz global points (origin at the main display's top-left, y
//! down). A `MonitorInfo` on macOS carries those points, so the input sink's normalised mapping
//! lands on the same display the video shows, and `scale` is the backing scale (2.0 on Retina).
//! Monitor ids are 1-based in the order the agent shows them: the main display first, then left
//! to right, top to bottom, so they do not change with `CGGetActiveDisplayList`'s order.

use ia_core::types::MonitorInfo;

/// The longest edge a captured frame is scaled to. ScreenCaptureKit scales on the GPU, so a
/// 3024×1964 Retina panel costs the encoder what a 1920×1247 one does.
pub const MAX_LONG_EDGE: u32 = 1920;

/// One active display as Quartz reports it.
#[derive(Debug, Clone, PartialEq)]
pub struct Display {
    /// `CGDirectDisplayID`.
    pub display_id: u32,
    /// `CGDisplayBounds`, global points.
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// `CGDisplayPixelsWide`: the backing pixels across, which gives the scale.
    pub pixels_wide: u32,
    /// `CGDisplayIsMain`.
    pub main: bool,
}

/// The agent's monitor list and, for each, the display it captures: `(MonitorInfo, display_id)`.
pub fn monitors(displays: &[Display]) -> Vec<(MonitorInfo, u32)> {
    let mut sorted: Vec<&Display> = displays
        .iter()
        .filter(|d| d.width >= 1.0 && d.height >= 1.0)
        .collect();
    sorted.sort_by(|a, b| {
        b.main
            .cmp(&a.main)
            .then(a.x.total_cmp(&b.x))
            .then(a.y.total_cmp(&b.y))
            .then(a.display_id.cmp(&b.display_id))
    });
    sorted
        .into_iter()
        .enumerate()
        .map(|(i, d)| {
            let scale = if d.width > 0.0 {
                (f64::from(d.pixels_wide) / d.width * 100.0).round() / 100.0
            } else {
                1.0
            };
            (
                MonitorInfo {
                    id: i as u32 + 1,
                    name: if d.main {
                        "Main display".to_string()
                    } else {
                        format!("Display {}", i + 1)
                    },
                    primary: d.main,
                    x: d.x.round() as i32,
                    y: d.y.round() as i32,
                    width: d.width.round() as u32,
                    height: d.height.round() as u32,
                    scale: scale.max(1.0) as f32,
                    mid: None,
                },
                d.display_id,
            )
        })
        .collect()
}

/// The frame size to ask ScreenCaptureKit for: the display's backing pixels, scaled down so the
/// long edge is at most `max_long_edge`, aspect kept, both sides even (I420 and VP8 need even
/// sizes) and at least 2.
pub fn capture_size(monitor: &MonitorInfo, max_long_edge: u32) -> (u32, u32) {
    let scale = f64::from(monitor.scale.max(1.0));
    let w = f64::from(monitor.width.max(1)) * scale;
    let h = f64::from(monitor.height.max(1)) * scale;
    let long = w.max(h);
    let k = if long > f64::from(max_long_edge) {
        f64::from(max_long_edge) / long
    } else {
        1.0
    };
    let even = |v: f64| ((v * k).round() as u32 & !1).max(2);
    (even(w), even(h))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(id: u32, x: f64, y: f64, w: f64, h: f64, px: u32, main: bool) -> Display {
        Display {
            display_id: id,
            x,
            y,
            width: w,
            height: h,
            pixels_wide: px,
            main,
        }
    }

    #[test]
    fn the_main_display_is_monitor_one_and_the_rest_follow_left_to_right() {
        let list = monitors(&[
            d(7, 1512.0, 0.0, 2560.0, 1440.0, 2560, false),
            d(3, -1920.0, -200.0, 1920.0, 1080.0, 1920, false),
            d(1, 0.0, 0.0, 1512.0, 982.0, 3024, true),
        ]);
        let ids: Vec<(u32, u32)> = list.iter().map(|(m, did)| (m.id, *did)).collect();
        assert_eq!(ids, vec![(1, 1), (2, 3), (3, 7)]);
        let main = &list[0].0;
        assert!(main.primary);
        assert_eq!((main.x, main.y, main.width, main.height), (0, 0, 1512, 982));
        assert_eq!(main.scale, 2.0);
        assert_eq!(list[1].0.x, -1920);
        assert_eq!(list[1].0.scale, 1.0);
        assert_eq!(list[1].0.name, "Display 2");
    }

    #[test]
    fn an_empty_display_is_skipped() {
        assert!(monitors(&[d(5, 0.0, 0.0, 0.0, 0.0, 0, true)]).is_empty());
    }

    #[test]
    fn a_retina_panel_is_captured_at_1920_on_the_long_edge_and_even() {
        let (m, _) = monitors(&[d(1, 0.0, 0.0, 1512.0, 982.0, 3024, true)])
            .pop()
            .unwrap();
        assert_eq!(capture_size(&m, MAX_LONG_EDGE), (1920, 1246));
    }

    #[test]
    fn a_small_display_keeps_its_pixels_and_odd_sides_are_floored_to_even() {
        let (m, _) = monitors(&[d(1, 0.0, 0.0, 1365.0, 767.0, 1365, true)])
            .pop()
            .unwrap();
        assert_eq!(capture_size(&m, MAX_LONG_EDGE), (1364, 766));
    }
}
