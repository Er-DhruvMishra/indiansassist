//! The Linux halves of the platform seam (Phase E §7.4, §7.7). Every path, name and decision is a
//! pure function here, compiled and tested on every host ([`display`], [`paths`], [`desktop`],
//! [`selfdel`], [`instance`], [`testguard`]); the calls that need the OS (the abstract socket,
//! `SO_PEERCRED`, `getuid`, the file writes) are [`os`], behind `cfg(target_os = "linux")` and the
//! `linux-os` feature.

pub mod desktop;
pub mod display;
pub mod instance;
pub mod paths;
pub mod selfdel;
/// The Linux service seam (F §8.4, §8.5): the logind facts table and the worker spawn plan as
/// data. Pure, so it compiles and is tested on every host; the OS impls live in `ia-service`.
pub mod service;
pub mod testguard;

#[cfg(all(target_os = "linux", feature = "linux-os"))]
pub mod os;

pub use display::{display_server, DisplayEnv, DisplayServer};
pub use paths::XdgEnv;
