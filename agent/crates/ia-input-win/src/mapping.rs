//! Virtual-desktop pointer mapping (contract §5.3). Pure math; tested ungated.

use ia_core::types::MonitorInfo;

/// The virtual screen rect in physical pixels (`SM_X/YVIRTUALSCREEN`, `SM_CX/CYVIRTUALSCREEN`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VirtualScreen {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

/// Normalised (`nx`,`ny`) on `monitor` → absolute `MOUSEEVENTF_ABSOLUTE|VIRTUALDESK`
/// coordinates in the 0..=65535 range over the virtual screen (contract §5.3).
pub fn map_to_virtual(monitor: &MonitorInfo, nx: f32, ny: f32, vs: VirtualScreen) -> (i32, i32) {
    // Clamp the normalised input defensively.
    let nx = nx.clamp(0.0, 1.0);
    let ny = ny.clamp(0.0, 1.0);
    let px = monitor.x as f32 + nx * monitor.width as f32;
    let py = monitor.y as f32 + ny * monitor.height as f32;
    // Avoid divide-by-zero on a degenerate virtual rect.
    let vw = (vs.width.max(1)) as f32;
    let vh = (vs.height.max(1)) as f32;
    let dx = ((px - vs.x as f32) * 65535.0 / vw).round() as i32;
    let dy = ((py - vs.y as f32) * 65535.0 / vh).round() as i32;
    (dx.clamp(0, 65535), dy.clamp(0, 65535))
}

/// Convert a `WheelEvent` delta in notches to the `mouseData` for `MOUSEEVENTF_WHEEL`
/// (one notch = `WHEEL_DELTA` = 120; positive `dy` scrolls down, so `mouseData = -dy*120`).
pub fn wheel_mouse_data(dy: i32) -> i32 {
    -dy * 120
}

/// `MOUSEEVENTF_HWHEEL` `mouseData` (positive `dx` scrolls right → `dx*120`).
pub fn hwheel_mouse_data(dx: i32) -> i32 {
    dx * 120
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(id: u32, x: i32, y: i32, w: u32, h: u32, primary: bool) -> MonitorInfo {
        MonitorInfo {
            id,
            name: format!("DISPLAY{id}"),
            primary,
            x,
            y,
            width: w,
            height: h,
            scale: 1.0,
            mid: None,
        }
    }

    #[test]
    fn primary_monitor_corners_map_to_extremes() {
        let m = mon(1, 0, 0, 1920, 1080, true);
        let vs = VirtualScreen {
            x: 0,
            y: 0,
            width: 1920,
            height: 1080,
        };
        assert_eq!(map_to_virtual(&m, 0.0, 0.0, vs), (0, 0));
        assert_eq!(map_to_virtual(&m, 1.0, 1.0, vs), (65535, 65535));
        // Centre.
        let (cx, cy) = map_to_virtual(&m, 0.5, 0.5, vs);
        assert!((cx - 32768).abs() <= 1 && (cy - 32768).abs() <= 1);
    }

    #[test]
    fn secondary_monitor_to_the_right_maps_into_upper_half() {
        // Two 1920-wide monitors side by side; virtual screen is 3840 wide.
        let right = mon(2, 1920, 0, 1920, 1080, false);
        let vs = VirtualScreen {
            x: 0,
            y: 0,
            width: 3840,
            height: 1080,
        };
        // Left edge of the right monitor = virtual x 1920 → ~ half of 65535.
        let (dx, _) = map_to_virtual(&right, 0.0, 0.0, vs);
        assert!((dx - 32768).abs() <= 1, "dx was {dx}");
        // Right edge = virtual x 3840 → max.
        let (dx2, _) = map_to_virtual(&right, 1.0, 0.0, vs);
        assert_eq!(dx2, 65535);
    }

    #[test]
    fn monitor_with_negative_origin() {
        // A monitor to the left of primary (negative x). Virtual origin is negative.
        let left = mon(2, -1920, 0, 1920, 1080, false);
        let vs = VirtualScreen {
            x: -1920,
            y: 0,
            width: 3840,
            height: 1080,
        };
        assert_eq!(map_to_virtual(&left, 0.0, 0.0, vs), (0, 0));
        let (dx, _) = map_to_virtual(&left, 1.0, 0.0, vs);
        assert!((dx - 32768).abs() <= 1);
    }

    #[test]
    fn wheel_sign_rules() {
        assert_eq!(wheel_mouse_data(1), -120); // scroll down → negative mouseData
        assert_eq!(wheel_mouse_data(-1), 120);
        assert_eq!(hwheel_mouse_data(1), 120);
    }
}
