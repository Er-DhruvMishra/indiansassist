//! The macOS clipboard bridge (Phase F §17.2, C §5.6): the general `NSPasteboard`, text only,
//! compiled under `cfg(all(target_os = "macos", feature = "macos"))`.
//!
//! Change detection uses the pasteboard's `changeCount`, the macOS equivalent of the Windows
//! clipboard sequence number: [`MacClipboard::take_update`] reads the text only after the count
//! moved, and a write of our own is not reported back. Clipboard content is never logged.

use ia_platform::traits::ClipboardBridge;
use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
use objc2_foundation::NSString;

pub struct MacClipboard {
    last_change: isize,
}

impl MacClipboard {
    /// Starts at the current change count, so text already on the clipboard is not sent.
    pub fn new() -> Self {
        Self {
            last_change: NSPasteboard::generalPasteboard().changeCount(),
        }
    }
}

impl Default for MacClipboard {
    fn default() -> Self {
        Self::new()
    }
}

impl ClipboardBridge for MacClipboard {
    fn set_text(&mut self, text: &str) {
        let pb = NSPasteboard::generalPasteboard();
        pb.clearContents();
        // SAFETY: `NSPasteboardTypeString` is a framework constant, valid for the process lifetime.
        let ok = pb.setString_forType(&NSString::from_str(text), unsafe { NSPasteboardTypeString });
        if ok {
            self.last_change = pb.changeCount();
        }
    }

    fn take_update(&mut self) -> Option<String> {
        let pb = NSPasteboard::generalPasteboard();
        let now = pb.changeCount();
        if now == self.last_change {
            return None;
        }
        self.last_change = now;
        // SAFETY: as above.
        let text = pb.stringForType(unsafe { NSPasteboardTypeString })?;
        Some(text.to_string())
    }
}
