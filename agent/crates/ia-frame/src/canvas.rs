//! Canvas and ladder scaling math (contract §4.1 downscale, §3.6 M6 recorder canvas).
//! Pure; tested ungated.

/// Fit `(w, h)` inside a box whose long edge is `long_edge`, preserving aspect ratio and
/// forcing even dimensions (encoder requirement). Never upscales past the source.
pub fn fit_long_edge(w: u32, h: u32, long_edge: u32) -> (u32, u32) {
    if w == 0 || h == 0 {
        return (2, 2);
    }
    let src_long = w.max(h);
    let scale = if src_long <= long_edge {
        1.0
    } else {
        long_edge as f64 / src_long as f64
    };
    let sw = ((w as f64 * scale).round() as u32).max(2);
    let sh = ((h as f64 * scale).round() as u32).max(2);
    (make_even(sw), make_even(sh))
}

fn make_even(n: u32) -> u32 {
    if n.is_multiple_of(2) {
        n
    } else {
        n + 1
    }
}

/// A letterbox placement: where to draw a scaled source inside a fixed canvas (centred).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Letterbox {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

/// Scale `(src_w, src_h)` to fit inside `(canvas_w, canvas_h)` and centre it (§3.6 M6).
/// The canvas stays fixed for the whole recording even when the routed monitor changes
/// resolution, so a monitor of a different aspect ratio is letterboxed, not stretched.
pub fn letterbox(src_w: u32, src_h: u32, canvas_w: u32, canvas_h: u32) -> Letterbox {
    if src_w == 0 || src_h == 0 {
        return Letterbox {
            x: 0,
            y: 0,
            w: canvas_w,
            h: canvas_h,
        };
    }
    let scale = (canvas_w as f64 / src_w as f64).min(canvas_h as f64 / src_h as f64);
    let w = make_even(((src_w as f64 * scale).round() as u32).min(canvas_w)).min(canvas_w);
    let h = make_even(((src_h as f64 * scale).round() as u32).min(canvas_h)).min(canvas_h);
    let x = (canvas_w.saturating_sub(w)) / 2;
    let y = (canvas_h.saturating_sub(h)) / 2;
    Letterbox { x, y, w, h }
}

/// The recorder fixed canvas (contract §3.6 M6): the first routed monitor fitted to the
/// `medium` ladder long edge (1600), even dimensions.
pub fn recorder_canvas(first_monitor_w: u32, first_monitor_h: u32) -> (u32, u32) {
    fit_long_edge(first_monitor_w, first_monitor_h, 1600)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fit_keeps_aspect_and_even_dims() {
        // 2560x1440 -> long edge 1600 -> 1600x900.
        assert_eq!(fit_long_edge(2560, 1440, 1600), (1600, 900));
        // Already small enough: unchanged but evened.
        assert_eq!(fit_long_edge(1280, 720, 1600), (1280, 720));
        // Odd source rounds to even.
        let (w, h) = fit_long_edge(1365, 767, 1024);
        assert_eq!(w % 2, 0);
        assert_eq!(h % 2, 0);
        assert!(w <= 1024 && h <= 1024);
    }

    #[test]
    fn recorder_canvas_uses_medium_long_edge() {
        assert_eq!(recorder_canvas(3840, 2160), (1600, 900));
        assert_eq!(recorder_canvas(1920, 1080), (1600, 900));
    }

    #[test]
    fn letterbox_centres_a_portrait_source_in_a_landscape_canvas() {
        // A 1080x1920 phone-shaped source into a 1600x900 canvas.
        let lb = letterbox(1080, 1920, 1600, 900);
        assert!(lb.h <= 900);
        assert!(lb.w <= 1600);
        // Centred horizontally with pillarboxing.
        assert!(lb.x > 0);
        assert_eq!(lb.y, (900 - lb.h) / 2);
        assert_eq!(lb.w % 2, 0);
        assert_eq!(lb.h % 2, 0);
    }

    #[test]
    fn letterbox_same_aspect_fills_canvas() {
        let lb = letterbox(1600, 900, 1600, 900);
        assert_eq!(
            lb,
            Letterbox {
                x: 0,
                y: 0,
                w: 1600,
                h: 900
            }
        );
    }
}
