//! Phase F §17.2 (stream apple): the macOS implementations of the `ia-platform` traits and, for
//! macOS unattended (§17.3), `ServiceHost` and `DesktopBridge` (later). Compiled only on macOS;
//! only the apple stream edits this module.
//!
//! Every path and decision is a pure function ([`paths`], [`selfdel`], [`instance`]); the calls
//! that need the OS (the self-delete applier, `getpeereid` / `LOCAL_PEERPID`, `proc_pidpath`, the
//! instance socket) are [`os`].

pub mod deeplink;
pub mod instance;
pub mod os;
pub mod paths;
pub mod selfdel;

pub use os::{
    acquire_single_instance, apply_self_delete, InstanceOutcome, InstanceServer, MacElevation,
    MacKnownFolders, MacProtocolHandler, MacSelfDelete,
};
pub use paths::MacEnv;
