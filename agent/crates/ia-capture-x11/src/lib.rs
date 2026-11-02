//! Linux X11 screen capture (Phase E contract §7.2, the `ia-capture-x11` row).
//!
//! The layout follows the rest of the workspace (`agent/README.md`): pure logic that builds and is
//! tested on every host, and the OS half behind a feature that compiles to nothing elsewhere.
//!
//! * Pure, every host: [`geometry`] (RandR 1.5 monitors → [`ia_core::types::MonitorInfo`], with
//!   the root-window fallback), [`tiles`] (tile-hash change detection over a BGRA buffer, so a
//!   static screen skips the BGRA→I420 conversion) and [`cursor`] (alpha-compositing the XFixes
//!   cursor image into a BGRA frame).
//! * `cfg(all(target_os = "linux", feature = "x11"))`: [`X11Capturer`], which implements
//!   [`ia_platform::traits::Capturer`] over `x11rb`'s pure-Rust `RustConnection` (no libX11
//!   link): RandR `GetMonitors`, MIT-SHM `ShmGetImage` into a `memfd` segment attached with
//!   `ShmAttachFd` (fallback: core `GetImage`), and XFixes `GetCursorImage`. The colour
//!   conversion is `ia_frame::convert::bgra_to_i420`, shared with the Windows capturer.
//!
//! The X11 tests are `tests/xvfb.rs`, `#[ignore]`-marked and run only by
//! `agent/scripts/xvfb-test.sh` against a harness-owned Xvfb (§7.10).

pub mod cursor;
pub mod geometry;
pub mod tiles;

#[cfg(all(target_os = "linux", feature = "x11"))]
mod capturer;
#[cfg(all(target_os = "linux", feature = "x11"))]
mod shm;

#[cfg(all(target_os = "linux", feature = "x11"))]
pub use capturer::{Counters, Options, X11Capturer};
