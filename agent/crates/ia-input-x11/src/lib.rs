//! Linux X11 input and clipboard (Phase E contract §7.2, the `ia-input-x11` row; rule 7.3c).
//!
//! Pure, compiled and tested on every host (Windows too):
//! * [`keymap`]: W3C `KeyboardEvent.code` → Linux evdev scancode, X keycode = `evdev + 8`,
//!   checked against `packages/shared/test/fixtures/agent/x11-keymap.json`;
//! * [`mapping`]: normalised monitor coordinates → root pixels, W3C buttons → X buttons, the
//!   wheel as buttons 4-7 with the Windows sink's sign convention and step;
//! * [`guard`]: the rule 7.3c injection-guard decision;
//! * [`unicode`]: characters → keysyms and the spare-keycode batch plan behind `os.text`.
//!
//! Behind `cfg(all(target_os = "linux", feature = "x11"))` (nothing elsewhere, so the Windows
//! `--all-features` gates pass): [`X11Input`] (XTEST, implements `InputSink` with the 7.3c guard)
//! and [`X11Clipboard`] (arboard, implements `ClipboardBridge`) with the §7.6 clipboard carrier
//! helpers. `block_local_input` keeps the trait default `false` (§7.3e: `os.input_lock` is
//! `not_supported` on Linux).

pub mod guard;
pub mod keymap;
pub mod mapping;
pub mod unicode;

#[cfg(all(target_os = "linux", feature = "x11"))]
mod clipboard;
#[cfg(all(target_os = "linux", feature = "x11"))]
mod input;

#[cfg(all(target_os = "linux", feature = "x11"))]
pub use clipboard::{clipboard_clear_if_unchanged, clipboard_read_once, X11Clipboard};
#[cfg(all(target_os = "linux", feature = "x11"))]
pub use input::{open, X11Input, TEXT_BIND_SETTLE, TEXT_RELEASE_HOLD};
