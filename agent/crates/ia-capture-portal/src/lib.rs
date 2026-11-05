//! Wayland screen capture through the desktop portal (Phase F contract §9.2, the
//! `ia-capture-portal` row).
//!
//! The layout follows the rest of the workspace (`agent/README.md`): pure logic that builds and is
//! tested on every host, and the OS half behind a feature that compiles to nothing elsewhere.
//!
//! * Pure, every host: [`session`] (the portal ScreenCast session as data: its steps, the
//!   `SelectSources` plan and the mapping of each failure to the reported status), [`format`]
//!   (SPA format and buffer-type negotiation: five 8-bit RGB layouts, `MemFd` / `MemPtr` only)
//!   and [`convert`] (stride and format conversion to packed BGRA, then I420).
//! * `cfg(all(target_os = "linux", feature = "portal"))`: [`PortalCapturer`], which implements
//!   [`ia_platform::traits::Capturer`] with **ashpd** (`CreateSession`, `SelectSources`, `Start`,
//!   `OpenPipeWireRemote`) and **pipewire** (the stream on the portal's fd and node). DMA-BUF is
//!   never negotiated.
//!
//! The portal tests are `tests/portal.rs`, `#[ignore]`-marked and run only by
//! `agent/scripts/portal-test.sh` against a harness-owned headless sway, PipeWire and portal on a
//! private session bus (§9.6).

pub mod convert;
pub mod format;
pub mod session;

#[cfg(all(target_os = "linux", feature = "portal"))]
mod os;

#[cfg(all(target_os = "linux", feature = "portal"))]
pub use os::{probe, PortalCapturer, PORTAL_MONITOR_ID};
