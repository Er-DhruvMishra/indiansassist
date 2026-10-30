//! GDI `BitBlt` capture fallback (contract §4.1 Fallback). Compiled under `winapi`;
//! CI-built on Windows. The DXGI Desktop Duplication primary path (§4.1) is the production
//! target; this GDI path is the compatibility fallback and the bring-up capturer.

use ia_core::types::MonitorInfo;
use ia_platform::traits::{Capturer, Frame};
use windows::core::PCWSTR;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, CreateDCW, DeleteDC, DeleteObject,
    GetDIBits, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HBITMAP, HDC,
    SRCCOPY,
};

use crate::convert::bgra_to_i420;
use crate::enumerate::enumerate;

/// A GDI capturer over the enumerated monitors.
pub struct GdiCapturer {
    monitors: Vec<MonitorInfo>,
}

impl GdiCapturer {
    pub fn new() -> Self {
        Self {
            monitors: enumerate(),
        }
    }

    fn grab(m: &MonitorInfo) -> Option<Frame> {
        let device: Vec<u16> = m.name.encode_utf16().chain(std::iter::once(0)).collect();
        let (w, h) = (m.width as i32, m.height as i32);
        if w <= 0 || h <= 0 {
            return None;
        }
        // SAFETY: handles are created and released within this function; BITMAPINFO is sized
        // to the bitmap; the output buffer matches width*height*4.
        unsafe {
            let src: HDC = CreateDCW(
                PCWSTR(device.as_ptr()),
                PCWSTR::null(),
                PCWSTR::null(),
                None,
            );
            if src.is_invalid() {
                return None;
            }
            let mem = CreateCompatibleDC(src);
            let bmp: HBITMAP = CreateCompatibleBitmap(src, w, h);
            let old = SelectObject(mem, bmp);
            let ok = BitBlt(mem, 0, 0, w, h, src, 0, 0, SRCCOPY).is_ok();

            let mut frame = None;
            if ok {
                let mut bi = BITMAPINFO {
                    bmiHeader: BITMAPINFOHEADER {
                        biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                        biWidth: w,
                        biHeight: -h, // top-down
                        biPlanes: 1,
                        biBitCount: 32,
                        biCompression: BI_RGB.0,
                        ..Default::default()
                    },
                    ..Default::default()
                };
                let mut buf = vec![0u8; (w * h * 4) as usize];
                let scanned = GetDIBits(
                    mem,
                    bmp,
                    0,
                    h as u32,
                    Some(buf.as_mut_ptr() as *mut _),
                    &mut bi,
                    DIB_RGB_COLORS,
                );
                if scanned != 0 {
                    frame = Some(bgra_to_i420(&buf, w as u32, h as u32, (w * 4) as usize));
                }
            }

            SelectObject(mem, old);
            let _ = DeleteObject(bmp);
            let _ = DeleteDC(mem);
            let _ = DeleteDC(src);
            frame
        }
    }
}

impl Default for GdiCapturer {
    fn default() -> Self {
        Self::new()
    }
}

impl Capturer for GdiCapturer {
    fn enumerate(&self) -> Vec<MonitorInfo> {
        self.monitors.clone()
    }

    fn next_frame(&mut self, monitor_id: u32) -> Option<Frame> {
        let m = self.monitors.iter().find(|m| m.id == monitor_id)?.clone();
        Self::grab(&m)
    }
}
