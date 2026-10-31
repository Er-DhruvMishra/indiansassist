//! The ladder downscale (contract §4.1 "Scaling", §4.3): a packed I420 frame resized to the
//! rung's size before encoding. Pure Rust, no SIMD: bilinear for ratios under 2 (1080p ->
//! 1600 px keeps text legible) and an area average for larger ratios (no aliasing when a
//! 2560 px desktop drops to the 1024 px floor). Never upscales: a request at or above the
//! source size returns a packed copy of the source.

use ia_platform::traits::Frame;

/// Resize `src` (any strides) to a packed `dst_w`x`dst_h` I420 frame (both forced even and
/// clamped to the source size).
pub fn scale_i420(src: &Frame, dst_w: u32, dst_h: u32) -> Frame {
    let dst_w = (dst_w.min(src.width) & !1).max(2);
    let dst_h = (dst_h.min(src.height) & !1).max(2);
    let (sw, sh) = (src.width as usize, src.height as usize);
    let (dw, dh) = (dst_w as usize, dst_h as usize);
    let y = scale_plane(&src.y, sw, sh, src.y_stride, dw, dh);
    let u = scale_plane(&src.u, sw / 2, sh / 2, src.uv_stride, dw / 2, dh / 2);
    let v = scale_plane(&src.v, sw / 2, sh / 2, src.uv_stride, dw / 2, dh / 2);
    Frame {
        width: dst_w,
        height: dst_h,
        y,
        u,
        v,
        y_stride: dw,
        uv_stride: dw / 2,
    }
}

/// True when `frame` is already packed at exactly `w`x`h` (no scale or copy needed).
pub fn is_packed_at(frame: &Frame, w: u32, h: u32) -> bool {
    frame.width == w
        && frame.height == h
        && frame.y_stride == w as usize
        && frame.uv_stride == (w / 2) as usize
}

fn scale_plane(src: &[u8], sw: usize, sh: usize, stride: usize, dw: usize, dh: usize) -> Vec<u8> {
    let mut out = vec![0u8; dw * dh];
    if sw == 0 || sh == 0 || dw == 0 || dh == 0 {
        return out;
    }
    if sw == dw && sh == dh {
        for row in 0..dh {
            out[row * dw..row * dw + dw].copy_from_slice(&src[row * stride..row * stride + sw]);
        }
        return out;
    }
    if sw >= dw * 2 || sh >= dh * 2 {
        area_average(src, sw, sh, stride, dw, dh, &mut out);
    } else {
        bilinear(src, sw, sh, stride, dw, dh, &mut out);
    }
    out
}

/// 16.16 fixed-point bilinear with pixel-centre alignment.
fn bilinear(src: &[u8], sw: usize, sh: usize, stride: usize, dw: usize, dh: usize, out: &mut [u8]) {
    let x_step = ((sw as u64) << 16) / dw as u64;
    let y_step = ((sh as u64) << 16) / dh as u64;
    // Precompute the column taps once per plane.
    let cols: Vec<(usize, usize, u32)> = (0..dw)
        .map(|x| {
            let fx = ((x as u64 * x_step) + (x_step >> 1)).saturating_sub(1 << 15);
            let x0 = ((fx >> 16) as usize).min(sw - 1);
            let x1 = (x0 + 1).min(sw - 1);
            (x0, x1, (fx & 0xFFFF) as u32)
        })
        .collect();
    for y in 0..dh {
        let fy = ((y as u64 * y_step) + (y_step >> 1)).saturating_sub(1 << 15);
        let y0 = ((fy >> 16) as usize).min(sh - 1);
        let y1 = (y0 + 1).min(sh - 1);
        let wy = (fy & 0xFFFF) as u32;
        let r0 = &src[y0 * stride..y0 * stride + sw];
        let r1 = &src[y1 * stride..y1 * stride + sw];
        let dst = &mut out[y * dw..y * dw + dw];
        for (d, &(x0, x1, wx)) in dst.iter_mut().zip(cols.iter()) {
            let top = r0[x0] as u32 * (65536 - wx) + r0[x1] as u32 * wx;
            let bot = r1[x0] as u32 * (65536 - wx) + r1[x1] as u32 * wx;
            let v = ((top as u64 >> 8) * (65536 - wy) as u64 + (bot as u64 >> 8) * wy as u64) >> 24;
            *d = v.min(255) as u8;
        }
    }
}

/// Each destination pixel is the mean of the source pixels its footprint covers.
fn area_average(
    src: &[u8],
    sw: usize,
    sh: usize,
    stride: usize,
    dw: usize,
    dh: usize,
    out: &mut [u8],
) {
    let span = |i: usize, s: usize, d: usize| {
        let a = i * s / d;
        let b = ((i + 1) * s / d).max(a + 1).min(s);
        (a, b)
    };
    let cols: Vec<(usize, usize)> = (0..dw).map(|x| span(x, sw, dw)).collect();
    for y in 0..dh {
        let (y0, y1) = span(y, sh, dh);
        for (x, &(x0, x1)) in cols.iter().enumerate() {
            let mut sum = 0u32;
            for row in y0..y1 {
                let r = &src[row * stride + x0..row * stride + x1];
                sum += r.iter().map(|&p| p as u32).sum::<u32>();
            }
            let n = ((y1 - y0) * (x1 - x0)) as u32;
            out[y * dw + x] = ((sum + n / 2) / n) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(w: u32, h: u32, f: impl Fn(usize, usize) -> u8) -> Frame {
        let (wu, hu) = (w as usize, h as usize);
        let mut y = vec![0u8; wu * hu];
        for r in 0..hu {
            for c in 0..wu {
                y[r * wu + c] = f(c, r);
            }
        }
        Frame {
            width: w,
            height: h,
            y,
            u: vec![0x40; (wu / 2) * (hu / 2)],
            v: vec![0xC0; (wu / 2) * (hu / 2)],
            y_stride: wu,
            uv_stride: wu / 2,
        }
    }

    #[test]
    fn output_is_packed_at_the_requested_even_size() {
        let src = frame(1920, 1080, |_, _| 100);
        let out = scale_i420(&src, 1600, 900);
        assert_eq!((out.width, out.height), (1600, 900));
        assert_eq!(out.y.len(), 1600 * 900);
        assert_eq!(out.u.len(), 800 * 450);
        assert!(is_packed_at(&out, 1600, 900));
        // Odd requests are made even.
        let out = scale_i420(&src, 1001, 563);
        assert_eq!((out.width, out.height), (1000, 562));
    }

    #[test]
    fn flat_planes_stay_flat_on_both_paths() {
        let src = frame(2560, 1440, |_, _| 77);
        for (w, h) in [(1920, 1080), (1024, 576)] {
            let out = scale_i420(&src, w, h);
            assert!(out.y.iter().all(|&p| p == 77), "{w}x{h} luma");
            assert!(out.u.iter().all(|&p| p == 0x40));
            assert!(out.v.iter().all(|&p| p == 0xC0));
        }
    }

    #[test]
    fn never_upscales_and_copies_strided_sources() {
        let mut src = frame(64, 32, |c, r| (c + r) as u8);
        // Re-pack the luma with a wider stride to prove strides are honoured.
        let stride = 80;
        let mut y = vec![0u8; stride * 32];
        for r in 0..32 {
            y[r * stride..r * stride + 64].copy_from_slice(&src.y[r * 64..r * 64 + 64]);
        }
        let packed = src.y.clone();
        src.y = y;
        src.y_stride = stride;
        let out = scale_i420(&src, 640, 320);
        assert_eq!((out.width, out.height), (64, 32));
        assert_eq!(out.y, packed);
    }

    #[test]
    fn a_horizontal_ramp_stays_monotonic() {
        let src = frame(1920, 8, |c, _| (c * 255 / 1919) as u8);
        for w in [1600u32, 640] {
            let out = scale_i420(&src, w, 8);
            let row = &out.y[..w as usize];
            assert!(
                row.windows(2).all(|p| p[0] <= p[1]),
                "ramp monotonic at {w}"
            );
            assert!(row[0] < 10 && row[w as usize - 1] > 245);
        }
    }
}
