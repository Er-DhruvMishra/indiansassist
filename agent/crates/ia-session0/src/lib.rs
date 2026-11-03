//! `ia-session0`: the session-0 bridge between the installed service and the desktop worker
//! (`docs/specs/phase-d-contracts.md` §11.1).
//!
//! | Module | Owns |
//! |---|---|
//! | [`blob`] | the §4.2 launch blob: the one object the service writes down the pipe to start a session |
//! | [`proto`] | the duplex frames after it (`sign_sas`, desktop switches, `SESSIONCHANGE` notifications) and their line framing |
//! | [`pipe`] | `\\.\pipe\IndiansAssist.svc.<32 hex>`, its DACL, and the pid / image checks on both ends |
//! | [`desktop`] | §5.3 desktop selection, §3.4 `InteractiveState` derivation, and the rule 5.1c secure-surface gates |
//! | `win` | the Win32 calls behind all of that (`winapi` feature): WTS, desktop enumeration, `CreateProcessAsUser` |
//!
//! The split is deliberate and is what makes the service testable at all: every rule is a pure
//! function over a table of facts, and the Win32 layer only reads facts and performs what the
//! rules return. §15.2 forbids an automated test from calling `CreateProcessAsUser`,
//! `WTSQueryUserToken`, `SendSAS` or `BlockInput`, so those live behind the trait and are
//! covered by the manual checks in `docs/release.md`.

pub mod blob;
pub mod desktop;
pub mod pipe;
pub mod proto;

/// The Unix session-0 transport (F §8.2): the socketpair handoff and its peer checks, built on
/// every Unix target (Linux now, macOS once the apple stream fills its arms).
#[cfg(unix)]
pub mod unix;

#[cfg(all(windows, feature = "winapi"))]
pub mod win;

pub use blob::{BlobConsent, BlobError, LaunchBlob, LinuxLaunch, BLOB_MAX};
pub use desktop::{
    derive_interactive, secure_surface_verdict, select_desktop, surface_of, transition,
    SecureSurface, SessionFacts, SurfaceVerdict, Transition,
};
pub use pipe::{peer_verdict, PeerExpectation, PeerObservation, PeerRefusal, PipeError};
pub use proto::{read_frame, write_frame, FrameError, ServiceFrame, WireDesktop, WorkerFrame};
