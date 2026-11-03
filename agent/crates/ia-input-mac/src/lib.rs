//! `ia-input-mac`: the macOS input and clipboard of the macOS portable agent (Phase F §17.2;
//! C §3.5 and E rule 7.3c for the guard). **The apple stream owns this crate** (§1.4).
//!
//! Pure, compiled and tested on every host (the `ia-input-x11` pattern):
//! * [`keymap`]: W3C `KeyboardEvent.code` → macOS virtual key (`kVK_*`), checked against
//!   `tests/fixtures/mac-keymap.json`, and the modifier each modifier key holds;
//! * [`mapping`]: normalised monitor coordinates → Quartz global points, W3C buttons → Quartz
//!   buttons and event types, the wheel with the Windows sink's sign convention;
//! * [`guard`]: the injection-guard decision over the agent's own windows;
//! * [`text`]: the UTF-16 chunking behind `os.text`.
//!
//! Behind `cfg(all(target_os = "macos", feature = "macos"))` (nothing elsewhere, so the Windows
//! and Linux `--all-features` gates compile no Apple framework): [`MacInput`] (CGEvent, implements
//! `InputSink` with the guard) and [`MacClipboard`] (`NSPasteboard`, implements
//! `ClipboardBridge`).

pub mod guard;
pub mod keymap;
pub mod mapping;
pub mod text;

#[cfg(all(target_os = "macos", feature = "macos"))]
pub mod access;
#[cfg(all(target_os = "macos", feature = "macos"))]
mod clipboard;
#[cfg(all(target_os = "macos", feature = "macos"))]
mod input;

#[cfg(all(target_os = "macos", feature = "macos"))]
pub use access::{accessibility_granted, request_accessibility};
#[cfg(all(target_os = "macos", feature = "macos"))]
pub use clipboard::MacClipboard;
#[cfg(all(target_os = "macos", feature = "macos"))]
pub use input::{own_windows, settings_window, MacInput};
