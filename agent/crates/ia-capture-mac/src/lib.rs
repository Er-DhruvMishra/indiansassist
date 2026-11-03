//! `ia-capture-mac`: the macOS screen capture of the macOS portable agent (Phase F §17.2).
//! **The apple stream owns this crate** (§1.4).
//!
//! Pure, compiled and tested on every host: [`geometry`], the display order, the macOS
//! `MonitorInfo` (global points, backing scale) and the capture size.
//!
//! Behind `cfg(all(target_os = "macos", feature = "macos"))` (nothing elsewhere, so the Windows
//! and Linux `--all-features` gates compile no Apple framework): [`SckCapturer`], ScreenCaptureKit
//! capture implementing `Capturer`, and the Screen Recording check.

pub mod geometry;

#[cfg(all(target_os = "macos", feature = "macos"))]
mod sck;

#[cfg(all(target_os = "macos", feature = "macos"))]
pub use sck::{active_displays, SckCapturer, RETRY_EVERY};

/// Whether this process may capture the screen now (`CGPreflightScreenCaptureAccess`; never shows
/// a prompt).
/// `CGPreflightScreenCaptureAccess` can answer no for a process that has the grant (seen on
/// macOS 15 with an ad hoc signed bundle), so a no is checked once per process against
/// ScreenCaptureKit itself, which hands over the shareable content only with the grant. The
/// answer is kept: macOS applies a new grant only to a new process anyway.
#[cfg(all(target_os = "macos", feature = "macos"))]
pub fn screen_recording_granted() -> bool {
    static CONFIRMED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    objc2_core_graphics::CGPreflightScreenCaptureAccess()
        || *CONFIRMED.get_or_init(|| match sck::shareable_content_available() {
            Ok(()) => {
                eprintln!("Screen Recording: preflight said no, ScreenCaptureKit says yes");
                true
            }
            Err(e) => {
                eprintln!("Screen Recording: not granted ({e})");
                false
            }
        })
}

/// Asks the system for Screen Recording (`CGRequestScreenCaptureAccess`): the first call shows
/// the system prompt, later ones return the current answer. Called only from the consent
/// window's "Allow screen recording" button, never automatically (§17.2, PRD 5).
#[cfg(all(target_os = "macos", feature = "macos"))]
pub fn request_screen_recording() -> bool {
    objc2_core_graphics::CGRequestScreenCaptureAccess()
}
