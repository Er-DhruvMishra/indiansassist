//! Cursor compositing (Phase E §7.2, pure; tested on every host).
//!
//! X11 screen grabs do not contain the pointer (it is a hardware or server sprite), so the
//! capturer reads it with XFixes `GetCursorImage` and draws it into the BGRA frame before the
//! change detection and the I420 conversion. XFixes cursor pixels are 32-bit ARGB (alpha in the
//! high byte) with **premultiplied** alpha, so each channel is
//! `out = src + dst * (255 - a) / 255`.

/// A cursor image: `width * height` premultiplied ARGB pixels, row-major.
#[derive(Debug, Clone, Copy)]
pub struct CursorImage<'a> {
    pub pixels: &'a [u32],
    pub width: u32,
    pub height: u32,
}

/// Composite `cursor` with its top-left corner at (`x`, `y`) of a BGRA / BGRX frame of
/// `width` x `height` pixels and `stride` bytes per row. Parts outside the frame are clipped;
/// the frame's fourth byte is left as it was. A short `pixels` slice composites nothing.
pub fn composite(
    frame: &mut [u8],
    width: u32,
    height: u32,
    stride: usize,
    cursor: &CursorImage<'_>,
    x: i32,
    y: i32,
) {
    let (cw, ch) = (cursor.width as i64, cursor.height as i64);
    if cursor.pixels.len() < (cw * ch) as usize {
        return;
    }
    let (x, y) = (i64::from(x), i64::from(y));
    let x0 = x.max(0);
    let y0 = y.max(0);
    let x1 = (x + cw).min(i64::from(width));
    let y1 = (y + ch).min(i64::from(height));
    if x0 >= x1 || y0 >= y1 {
        return;
    }
    for fy in y0..y1 {
        let cy = fy - y;
        let src_row = &cursor.pixels[(cy * cw) as usize..][..cw as usize];
        let dst_row = &mut frame[fy as usize * stride..];
        for fx in x0..x1 {
            let argb = src_row[(fx - x) as usize];
            let a = argb >> 24;
            if a == 0 {
                continue;
            }
            let px = &mut dst_row[fx as usize * 4..fx as usize * 4 + 3];
            if a == 255 {
                px[0] = argb as u8;
                px[1] = (argb >> 8) as u8;
                px[2] = (argb >> 16) as u8;
                continue;
            }
            let inv = 255 - a;
            for (i, d) in px.iter_mut().enumerate() {
                let s = (argb >> (8 * i)) & 0xFF;
                let v = s + (u32::from(*d) * inv + 127) / 255;
                *d = v.min(255) as u8;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grey(w: u32, h: u32, v: u8) -> Vec<u8> {
        let mut f = Vec::new();
        for _ in 0..w * h {
            f.extend_from_slice(&[v, v, v, 0]);
        }
        f
    }

    fn px(f: &[u8], stride: usize, x: usize, y: usize) -> [u8; 4] {
        let p = y * stride + x * 4;
        [f[p], f[p + 1], f[p + 2], f[p + 3]]
    }

    #[test]
    fn opaque_pixels_replace_and_transparent_ones_keep() {
        let mut f = grey(8, 8, 100);
        // 2x2 cursor: opaque red, transparent, opaque blue, transparent.
        let pixels = [0xFFFF_0000, 0x0000_0000, 0xFF00_00FF, 0x0000_0000];
        let c = CursorImage {
            pixels: &pixels,
            width: 2,
            height: 2,
        };
        composite(&mut f, 8, 8, 32, &c, 3, 4);
        assert_eq!(px(&f, 32, 3, 4), [0, 0, 255, 0]); // BGR of red
        assert_eq!(px(&f, 32, 4, 4), [100, 100, 100, 0]);
        assert_eq!(px(&f, 32, 3, 5), [255, 0, 0, 0]); // BGR of blue
        assert_eq!(px(&f, 32, 2, 4), [100, 100, 100, 0]);
    }

    #[test]
    fn premultiplied_alpha_blends() {
        let mut f = grey(1, 1, 200);
        // 50 % white, premultiplied: a = 128, rgb = 128.
        let pixels = [0x8080_8080];
        let c = CursorImage {
            pixels: &pixels,
            width: 1,
            height: 1,
        };
        composite(&mut f, 1, 1, 4, &c, 0, 0);
        // 128 + 200 * 127 / 255 = 128 + 99.6 -> 228
        assert_eq!(px(&f, 4, 0, 0), [228, 228, 228, 0]);
    }

    #[test]
    fn clipped_at_every_edge() {
        let pixels = [0xFF00_FF00u32; 16];
        let c = CursorImage {
            pixels: &pixels,
            width: 4,
            height: 4,
        };
        for (x, y) in [(-2, -2), (6, 6), (-2, 6), (6, -2)] {
            let mut f = grey(8, 8, 0);
            composite(&mut f, 8, 8, 32, &c, x, y);
            let green = (0..8)
                .flat_map(|yy| (0..8).map(move |xx| (xx, yy)))
                .filter(|&(xx, yy)| px(&f, 32, xx, yy)[1] == 255)
                .count();
            assert_eq!(green, 4, "cursor at ({x},{y})");
        }
        // Entirely outside: nothing changes.
        let mut f = grey(8, 8, 7);
        composite(&mut f, 8, 8, 32, &c, 100, -100);
        assert_eq!(f, grey(8, 8, 7));
    }

    #[test]
    fn a_short_pixel_slice_is_ignored() {
        let mut f = grey(4, 4, 9);
        let pixels = [0xFFFF_FFFFu32; 3];
        let c = CursorImage {
            pixels: &pixels,
            width: 2,
            height: 2,
        };
        composite(&mut f, 4, 4, 16, &c, 0, 0);
        assert_eq!(f, grey(4, 4, 9));
    }

    #[test]
    fn honours_the_stride() {
        let stride = 4 * 4 + 8;
        let mut f = vec![1u8; stride * 2];
        let pixels = [0xFF11_2233u32];
        let c = CursorImage {
            pixels: &pixels,
            width: 1,
            height: 1,
        };
        composite(&mut f, 4, 2, stride, &c, 2, 1);
        assert_eq!(px(&f, stride, 2, 1), [0x33, 0x22, 0x11, 1]);
        assert_eq!(f.iter().filter(|&&b| b != 1).count(), 3);
    }
}
