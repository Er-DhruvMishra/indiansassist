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
pub mod testguard;

#[cfg(all(target_os = "linux", feature = "linux-os"))]
pub mod os;

pub use display::{display_server, DisplayEnv, DisplayServer};
pub use paths::XdgEnv;
