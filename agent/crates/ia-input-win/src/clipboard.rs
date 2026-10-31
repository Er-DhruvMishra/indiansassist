//! Windows clipboard text bridge (contract §5.6), compiled under `winapi`. Text only, both
//! ways: [`ClipboardBridge::set_text`] writes `CF_UNICODETEXT`, and [`ClipboardBridge::take_update`]
//! returns a Desk-originated change once (debounced by a last-seen sequence number so the
//! agent's own `set_text` is not echoed back to the Assist).
//!
//! NOTE: CI-compiled on the Windows targets; not built by the default dev gate here.

use ia_platform::traits::ClipboardBridge;
use windows::core::Error as WinError;
use windows::Win32::Foundation::{HANDLE, HGLOBAL, HWND};
use windows::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber, OpenClipboard,
    SetClipboardData,
};
use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows::Win32::System::Ole::CF_UNICODETEXT;

const CF_UNICODETEXT_FMT: u32 = CF_UNICODETEXT.0 as u32;

/// The Win32 clipboard as a [`ClipboardBridge`]. A single owner (the control serve loop)
/// drives it; it holds no OS handle between calls.
pub struct WinClipboard {
    /// The clipboard sequence number at the last read/write we performed, so a change made
    /// by another app (the Desk user copying) is distinguished from our own `set_text`.
    last_seq: u32,
}

impl Default for WinClipboard {
    fn default() -> Self {
        Self::new()
    }
}

impl WinClipboard {
    pub fn new() -> Self {
        // SAFETY: no preconditions; returns 0 when the caller lacks WINSTA_ACCESSCLIPBOARD.
        let last_seq = unsafe { GetClipboardSequenceNumber() };
        Self { last_seq }
    }

    fn read_text() -> Option<String> {
        // SAFETY: the clipboard is opened and closed within this function; the global is
        // locked while copied and unlocked before close.
        unsafe {
            if OpenClipboard(HWND::default()).is_err() {
                return None;
            }
            let mut out = None;
            let handle = GetClipboardData(CF_UNICODETEXT_FMT);
            if let Ok(h) = handle {
                if !h.is_invalid() {
                    let hglobal = HGLOBAL(h.0);
                    let ptr = GlobalLock(hglobal) as *const u16;
                    if !ptr.is_null() {
                        let mut len = 0usize;
                        while *ptr.add(len) != 0 {
                            len += 1;
                        }
                        let slice = std::slice::from_raw_parts(ptr, len);
                        out = Some(String::from_utf16_lossy(slice));
                        let _ = GlobalUnlock(hglobal);
                    }
                }
            }
            let _ = CloseClipboard();
            out
        }
    }

    fn write_text(text: &str) -> Result<(), WinError> {
        let mut units: Vec<u16> = text.encode_utf16().collect();
        units.push(0);
        let bytes = units.len() * std::mem::size_of::<u16>();
        // SAFETY: the clipboard is opened and emptied first; the moveable global is sized to
        // the NUL-terminated UTF-16 buffer and handed to the clipboard, which takes ownership.
        unsafe {
            OpenClipboard(HWND::default())?;
            let result = (|| {
                EmptyClipboard()?;
                let hmem: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, bytes)?;
                let dst = GlobalLock(hmem) as *mut u16;
                if dst.is_null() {
                    return Err(WinError::from_win32());
                }
                std::ptr::copy_nonoverlapping(units.as_ptr(), dst, units.len());
                let _ = GlobalUnlock(hmem);
                SetClipboardData(CF_UNICODETEXT_FMT, HANDLE(hmem.0))?;
                Ok(())
            })();
            let _ = CloseClipboard();
            result
        }
    }
}

impl ClipboardBridge for WinClipboard {
    fn set_text(&mut self, text: &str) {
        if Self::write_text(text).is_ok() {
            // SAFETY: no preconditions.
            self.last_seq = unsafe { GetClipboardSequenceNumber() };
        }
    }

    fn take_update(&mut self) -> Option<String> {
        // SAFETY: no preconditions.
        let seq = unsafe { GetClipboardSequenceNumber() };
        if seq == self.last_seq {
            return None;
        }
        self.last_seq = seq;
        Self::read_text()
    }
}
