//! The Accessibility grant (Phase F §17.2 TCC flow), compiled under
//! `cfg(all(target_os = "macos", feature = "macos"))`. Posting CGEvents into other apps needs it;
//! without it Quartz drops them silently. TCC is never bypassed (PRD 5): these are the system
//! calls, and the only way to the grant is the person's choice in System Settings.

use std::ffi::c_void;

use objc2_foundation::{NSDictionary, NSNumber, NSString};

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> bool;
    fn AXIsProcessTrustedWithOptions(options: *const c_void) -> bool;
    static kAXTrustedCheckOptionPrompt: *const c_void;
}

/// Whether this process may post input now (never shows a prompt).
pub fn accessibility_granted() -> bool {
    // SAFETY: no arguments; reads the process's TCC state.
    unsafe { AXIsProcessTrusted() }
}

/// Asks the system for Accessibility: shows the system prompt that offers to open System
/// Settings, and returns the current answer. Called only from the consent window's "Allow
/// control" button, never automatically.
pub fn request_accessibility() -> bool {
    // SAFETY: `kAXTrustedCheckOptionPrompt` is a CFString constant, toll-free bridged to
    // NSString; the dictionary lives across the call.
    unsafe {
        let key: &NSString = &*(kAXTrustedCheckOptionPrompt as *const NSString);
        let options = NSDictionary::from_slices(&[key], &[&*NSNumber::new_bool(true)]);
        AXIsProcessTrustedWithOptions(
            &*options as *const NSDictionary<NSString, NSNumber> as *const c_void,
        )
    }
}

/// The System Settings pane for each grant, opened by the consent window's second button.
pub const SETTINGS_ACCESSIBILITY: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility";
pub const SETTINGS_SCREEN_RECORDING: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
