//! RandR monitor geometry → [`MonitorInfo`] (Phase E §7.2, pure; tested on every host).
//!
//! The capturer reads RandR 1.5 `GetMonitors` (active monitors only) into [`RandrMonitor`]s and
//! [`monitors_from_randr`] turns them into the agent's monitor list:
//!
//! * each monitor is **clipped to the root window** (a monitor that reaches past the screen
//!   cannot be read with `GetImage`), and one narrower or shorter than 2 pixels after clipping is
//!   dropped (frames are floored to even dimensions for I420, [`even_size`]);
//! * monitors with exactly the same rectangle (clone mode) are reported once;
//! * **id order (stable)**: the primary monitor first, then the others by `(x, y)` (left to
//!   right, then top to bottom), then by name; ids are `1..=N`, at most [`MAX_MONITORS`];
//! * exactly one monitor is `primary`: the RandR primary if there is one, otherwise the first in
//!   the order above;
//! * `scale` is `1.0` (X11 has no per-monitor scale the capture sees), `mid` is `None`;
//! * names longer than the schema's 64 UTF-16 units are cut; an empty name becomes `Monitor <id>`;
//! * an empty or unusable list (RandR missing, older than 1.5, or nothing left after clipping)
//!   falls back to the **root window as one monitor**, id 1, named [`ROOT_NAME`].

use ia_core::types::MonitorInfo;

/// The most monitors the agent advertises (`monitorId` is `1..=16` in `agent/control.ts`).
pub const MAX_MONITORS: usize = 16;
/// `MonitorInfo.name` is at most 64 characters (UTF-16 units) in `agent/control.ts`.
pub const MAX_NAME_UNITS: usize = 64;
/// The name of the root-window fallback monitor.
pub const ROOT_NAME: &str = "X11 screen";

/// One RandR 1.5 monitor as `GetMonitors` reports it (the name atom already resolved).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RandrMonitor {
    pub name: String,
    pub primary: bool,
    pub x: i16,
    pub y: i16,
    pub width: u16,
    pub height: u16,
}

/// The frame size for a `width` x `height` area: both floored to even (I420 subsamples 2x2).
pub fn even_size(width: u32, height: u32) -> (u32, u32) {
    (width & !1, height & !1)
}

/// A monitor rectangle clipped to the root, in root coordinates.
#[derive(Debug, Clone)]
struct Clipped {
    name: String,
    primary: bool,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn clip(m: &RandrMonitor, root_w: u16, root_h: u16) -> Option<Clipped> {
    let x0 = i32::from(m.x).max(0);
    let y0 = i32::from(m.y).max(0);
    let x1 = (i32::from(m.x) + i32::from(m.width)).min(i32::from(root_w));
    let y1 = (i32::from(m.y) + i32::from(m.height)).min(i32::from(root_h));
    if x1 - x0 < 2 || y1 - y0 < 2 {
        return None;
    }
    Some(Clipped {
        name: m.name.clone(),
        primary: m.primary,
        x: x0,
        y: y0,
        width: (x1 - x0) as u32,
        height: (y1 - y0) as u32,
    })
}

/// Cut `name` to at most [`MAX_NAME_UNITS`] UTF-16 units, on a character boundary.
fn cut_name(name: &str) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in name.chars() {
        units += c.len_utf16();
        if units > MAX_NAME_UNITS {
            break;
        }
        out.push(c);
    }
    out
}

/// The agent's monitor list from RandR's (see the module docs for every rule).
pub fn monitors_from_randr(list: &[RandrMonitor], root_w: u16, root_h: u16) -> Vec<MonitorInfo> {
    let mut kept: Vec<Clipped> = Vec::new();
    for m in list {
        let Some(c) = clip(m, root_w, root_h) else {
            continue;
        };
        // Clone mode: one entry per rectangle; a duplicate that is the primary passes it on.
        if let Some(same) = kept
            .iter_mut()
            .find(|k| (k.x, k.y, k.width, k.height) == (c.x, c.y, c.width, c.height))
        {
            same.primary |= c.primary;
            continue;
        }
        kept.push(c);
    }
    if kept.is_empty() {
        return vec![root_monitor(root_w, root_h)];
    }
    kept.sort_by(|a, b| (!a.primary, a.x, a.y, &a.name).cmp(&(!b.primary, b.x, b.y, &b.name)));
    kept.truncate(MAX_MONITORS);
    kept.iter()
        .enumerate()
        .map(|(i, c)| {
            let id = (i + 1) as u32;
            let name = cut_name(c.name.trim());
            MonitorInfo {
                id,
                name: if name.is_empty() {
                    format!("Monitor {id}")
                } else {
                    name
                },
                // Sorted primary-first, so the first is the primary if any is, and exactly one is.
                primary: i == 0,
                x: c.x,
                y: c.y,
                width: c.width,
                height: c.height,
                scale: 1.0,
                mid: None,
            }
        })
        .collect()
}

/// The RandR-missing fallback: the whole root window as monitor 1.
fn root_monitor(root_w: u16, root_h: u16) -> MonitorInfo {
    MonitorInfo {
        id: 1,
        name: ROOT_NAME.to_string(),
        primary: true,
        x: 0,
        y: 0,
        // The schema requires a positive size; a zero-sized root cannot be captured anyway.
        width: u32::from(root_w).max(1),
        height: u32::from(root_h).max(1),
        scale: 1.0,
        mid: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mon(name: &str, primary: bool, x: i16, y: i16, w: u16, h: u16) -> RandrMonitor {
        RandrMonitor {
            name: name.into(),
            primary,
            x,
            y,
            width: w,
            height: h,
        }
    }

    fn rect(m: &MonitorInfo) -> (i32, i32, u32, u32) {
        (m.x, m.y, m.width, m.height)
    }

    #[test]
    fn two_side_by_side_monitors_primary_first() {
        let list = [
            mon("DP-1", false, 0, 0, 1920, 1080),
            mon("HDMI-1", true, 1920, 0, 1920, 1080),
        ];
        let out = monitors_from_randr(&list, 3840, 1080);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].id, 1);
        assert_eq!(out[0].name, "HDMI-1");
        assert!(out[0].primary);
        assert_eq!(rect(&out[0]), (1920, 0, 1920, 1080));
        assert_eq!(out[1].id, 2);
        assert_eq!(out[1].name, "DP-1");
        assert!(!out[1].primary);
        assert_eq!(rect(&out[1]), (0, 0, 1920, 1080));
        for m in &out {
            assert_eq!(m.scale, 1.0);
            assert_eq!(m.mid, None);
        }
    }

    #[test]
    fn without_a_primary_the_top_left_one_is_flagged() {
        let list = [
            mon("B", false, 1920, 0, 1280, 1024),
            mon("C", false, 0, 1080, 1920, 1080),
            mon("A", false, 0, 0, 1920, 1080),
        ];
        let out = monitors_from_randr(&list, 3200, 2160);
        let names: Vec<_> = out.iter().map(|m| m.name.as_str()).collect();
        // (x, y) order: (0,0), (0,1080), (1920,0).
        assert_eq!(names, ["A", "C", "B"]);
        assert!(out[0].primary);
        assert_eq!(out.iter().filter(|m| m.primary).count(), 1);
        assert_eq!(
            out.iter().map(|m| m.id).collect::<Vec<_>>(),
            [1, 2, 3],
            "ids are 1..=N in order"
        );
    }

    #[test]
    fn several_primaries_still_yield_exactly_one() {
        let list = [
            mon("A", true, 1920, 0, 1920, 1080),
            mon("B", true, 0, 0, 1920, 1080),
        ];
        let out = monitors_from_randr(&list, 3840, 1080);
        assert_eq!(out.iter().filter(|m| m.primary).count(), 1);
        assert_eq!(out[0].name, "B");
    }

    #[test]
    fn the_order_is_stable_whatever_randr_reports_first() {
        let a = [
            mon("A", false, 0, 0, 800, 600),
            mon("B", true, 800, 0, 800, 600),
            mon("C", false, 1600, 0, 800, 600),
        ];
        let mut b = a.clone();
        b.reverse();
        assert_eq!(
            monitors_from_randr(&a, 2400, 600),
            monitors_from_randr(&b, 2400, 600)
        );
    }

    #[test]
    fn empty_or_unusable_lists_fall_back_to_the_root() {
        for list in [
            vec![],
            vec![mon("zero", true, 0, 0, 0, 0)],
            vec![mon("outside", false, 5000, 0, 1920, 1080)],
            vec![mon("thin", false, 0, 0, 1, 1080)],
        ] {
            let out = monitors_from_randr(&list, 3840, 1080);
            assert_eq!(out.len(), 1, "{list:?}");
            let m = &out[0];
            assert_eq!(m.id, 1);
            assert!(m.primary);
            assert_eq!(m.name, ROOT_NAME);
            assert_eq!(rect(m), (0, 0, 3840, 1080));
            assert_eq!(m.scale, 1.0);
        }
        // A zero root still yields a schema-valid monitor.
        let out = monitors_from_randr(&[], 0, 0);
        assert_eq!(rect(&out[0]), (0, 0, 1, 1));
    }

    #[test]
    fn monitors_are_clipped_to_the_root() {
        let list = [
            mon("left", true, -100, -50, 1920, 1080),
            mon("right", false, 1820, 0, 1920, 1200),
        ];
        let out = monitors_from_randr(&list, 3000, 1080);
        assert_eq!(rect(&out[0]), (0, 0, 1820, 1030));
        assert_eq!(rect(&out[1]), (1820, 0, 1180, 1080));
    }

    #[test]
    fn clone_mode_duplicates_are_reported_once() {
        let list = [
            mon("eDP-1", false, 0, 0, 1920, 1080),
            mon("HDMI-1", true, 0, 0, 1920, 1080),
        ];
        let out = monitors_from_randr(&list, 1920, 1080);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "eDP-1");
        assert!(out[0].primary);
    }

    #[test]
    fn at_most_sixteen_monitors() {
        let list: Vec<_> = (0..20)
            .map(|i| mon(&format!("M{i}"), i == 7, (i * 100) as i16, 0, 100, 100))
            .collect();
        let out = monitors_from_randr(&list, 2000, 100);
        assert_eq!(out.len(), MAX_MONITORS);
        assert_eq!(out[0].name, "M7");
        assert_eq!(out.last().unwrap().id, 16);
    }

    #[test]
    fn names_are_cut_and_defaulted() {
        let long = "x".repeat(80);
        let wide = "\u{1F5A5}".repeat(40); // two UTF-16 units each
        let list = [
            mon(&long, true, 0, 0, 100, 100),
            mon(&wide, false, 100, 0, 100, 100),
            mon("  ", false, 200, 0, 100, 100),
        ];
        let out = monitors_from_randr(&list, 300, 100);
        assert_eq!(out[0].name.len(), 64);
        assert_eq!(out[1].name.encode_utf16().count(), 64);
        assert_eq!(out[1].name.chars().count(), 32);
        assert_eq!(out[2].name, "Monitor 3");
    }

    #[test]
    fn even_size_floors_both() {
        assert_eq!(even_size(1920, 1080), (1920, 1080));
        assert_eq!(even_size(1366, 767), (1366, 766));
        assert_eq!(even_size(1, 1), (0, 0));
        assert_eq!(even_size(0, 3), (0, 2));
    }
}
