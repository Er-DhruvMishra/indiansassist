//! Capture sources for the agent. On Windows the real source is `ia-capture-win` (DXGI
//! primary, GDI fallback). This module adds a [`SyntheticCapturer`] — a generated-frame
//! producer behind the [`Capturer`] trait — so the loopback test (contract §15.2) can run
//! the media peer with no display, and so the encode path can be exercised deterministically.

use ia_core::types::MonitorInfo;
use ia_platform::traits::{Capturer, Frame};

/// A capturer that synthesises a packed-I420 frame per monitor, changing each tick so the
/// encoder emits both keyframes and inter frames. Used only in tests / bring-up.
pub struct SyntheticCapturer {
    monitors: Vec<MonitorInfo>,
    width: u32,
    height: u32,
    tick: u8,
}

impl SyntheticCapturer {
    /// One monitor of `width`x`height` (both forced even).
    pub fn single(width: u32, height: u32) -> Self {
        let (w, h) = (width & !1, height & !1);
        Self {
            monitors: vec![MonitorInfo {
                id: 1,
                name: "SYNTHETIC1".into(),
                primary: true,
                x: 0,
                y: 0,
                width: w,
                height: h,
                scale: 1.0,
                mid: None,
            }],
            width: w,
            height: h,
            tick: 0,
        }
    }

    fn frame(&self, luma: u8) -> Frame {
        let (w, h) = (self.width as usize, self.height as usize);
        let (cw, ch) = (w / 2, h / 2);
        // A horizontal gradient plus a per-tick offset so consecutive frames differ.
        let mut y = vec![0u8; w * h];
        for (row, chunk) in y.chunks_mut(w).enumerate() {
            for (col, px) in chunk.iter_mut().enumerate() {
                *px = luma
                    .wrapping_add((col as u8).wrapping_mul(3))
                    .wrapping_add((row as u8).wrapping_mul(5));
            }
        }
        Frame {
            width: self.width,
            height: self.height,
            y,
            u: vec![0x80; cw * ch],
            v: vec![0x80; cw * ch],
            y_stride: w,
            uv_stride: cw,
        }
    }
}

impl Capturer for SyntheticCapturer {
    fn enumerate(&self) -> Vec<MonitorInfo> {
        self.monitors.clone()
    }

    fn next_frame(&mut self, monitor_id: u32) -> Option<Frame> {
        if !self.monitors.iter().any(|m| m.id == monitor_id) {
            return None;
        }
        self.tick = self.tick.wrapping_add(17);
        Some(self.frame(self.tick))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn produces_packed_changing_frames() {
        let mut cap = SyntheticCapturer::single(64, 64);
        assert_eq!(cap.enumerate().len(), 1);
        let a = cap.next_frame(1).unwrap();
        let b = cap.next_frame(1).unwrap();
        assert_eq!(a.y_stride, 64);
        assert_eq!(a.uv_stride, 32);
        assert_ne!(a.y, b.y, "frames must change so inter frames are produced");
        assert!(cap.next_frame(9).is_none());
    }
}
