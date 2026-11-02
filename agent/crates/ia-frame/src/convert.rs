//! BGRA (DDA/GDI) → I420 colour conversion (contract §4.1). Pure; tested ungated. The
//! production build swaps this for `yuvutils-rs` (SIMD); this reference converter keeps the
//! GDI path self-contained and is the oracle the SIMD path is checked against.

use ia_platform::traits::Frame;

/// Convert tightly-packed or strided BGRA to planar I420 using BT.601 (limited range).
/// `src_stride` is bytes per row (>= `width * 4`). Width/height are rounded down to even.
pub fn bgra_to_i420(bgra: &[u8], width: u32, height: u32, src_stride: usize) -> Frame {
    let w = (width & !1) as usize;
    let h = (height & !1) as usize;
    let cw = w / 2;
    let ch = h / 2;

    let mut y_plane = vec![0u8; w * h];
    let mut u_plane = vec![0u8; cw * ch];
    let mut v_plane = vec![0u8; cw * ch];

    // Luma for every pixel.
    for row in 0..h {
        let src_row = &bgra[row * src_stride..];
        for col in 0..w {
            let px = &src_row[col * 4..col * 4 + 4];
            let (b, g, r) = (px[0] as i32, px[1] as i32, px[2] as i32);
            let y = (77 * r + 150 * g + 29 * b + 128) >> 8; // 0..255 approx BT.601
            y_plane[row * w + col] = y.clamp(16, 235) as u8;
        }
    }

    // Chroma subsampled 2x2 (average of the block).
    for cy in 0..ch {
        for cx in 0..cw {
            let mut sr = 0i32;
            let mut sg = 0i32;
            let mut sb = 0i32;
            for dy in 0..2 {
                for dx in 0..2 {
                    let row = cy * 2 + dy;
                    let col = cx * 2 + dx;
                    let px = &bgra[row * src_stride + col * 4..];
                    sb += px[0] as i32;
                    sg += px[1] as i32;
                    sr += px[2] as i32;
                }
            }
            let (r, g, b) = (sr / 4, sg / 4, sb / 4);
            let u = ((-43 * r - 85 * g + 128 * b + 128) >> 8) + 128;
            let v = ((128 * r - 107 * g - 21 * b + 128) >> 8) + 128;
            u_plane[cy * cw + cx] = u.clamp(16, 240) as u8;
            v_plane[cy * cw + cx] = v.clamp(16, 240) as u8;
        }
    }

    Frame {
        width: w as u32,
        height: h as u32,
        y: y_plane,
        u: u_plane,
        v: v_plane,
        y_stride: w,
        uv_stride: cw,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, b: u8, g: u8, r: u8) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for _ in 0..(w * h) {
            v.extend_from_slice(&[b, g, r, 255]);
        }
        v
    }

    #[test]
    fn plane_sizes_are_i420() {
        let f = bgra_to_i420(&solid(4, 4, 0, 0, 0), 4, 4, 16);
        assert_eq!(f.y.len(), 16);
        assert_eq!(f.u.len(), 4);
        assert_eq!(f.v.len(), 4);
        assert_eq!(f.y_stride, 4);
        assert_eq!(f.uv_stride, 2);
    }

    #[test]
    fn black_and_white_luma() {
        let black = bgra_to_i420(&solid(2, 2, 0, 0, 0), 2, 2, 8);
        assert!(black.y.iter().all(|&y| y == 16));
        let white = bgra_to_i420(&solid(2, 2, 255, 255, 255), 2, 2, 8);
        assert!(white.y.iter().all(|&y| y == 235));
    }

    #[test]
    fn pure_red_has_expected_chroma_sign() {
        // Red: V well above 128, U below 128.
        let red = bgra_to_i420(&solid(2, 2, 0, 0, 255), 2, 2, 8);
        assert!(red.v[0] > 128);
        assert!(red.u[0] < 128);
    }

    #[test]
    fn odd_dimensions_rounded_down() {
        let f = bgra_to_i420(&solid(6, 6, 10, 20, 30), 5, 5, 24);
        assert_eq!(f.width, 4);
        assert_eq!(f.height, 4);
    }
}
