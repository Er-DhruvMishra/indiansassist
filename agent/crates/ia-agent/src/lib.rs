//! Agent orchestration (contract §2.1 precedence, §7 elevation, §10 self-delete).
//!
//! The pure decision logic (`cli`, `codecs`, `elevate`, `tokensource`, `sechs`) is tested in
//! every build. The webrtc-rs peer, the VP8 encoder, the signaling client and the session
//! orchestration are compiled under the `media` feature (MSVC host; see agent/README.md).

pub mod cli;
pub mod codecs;
pub mod elevate;
pub mod filerecv;
pub mod live;
pub mod pbrun;
pub mod sechs;
pub mod tokensource;

#[cfg(feature = "media")]
pub mod capture;
#[cfg(feature = "media")]
pub mod channels;
#[cfg(feature = "media")]
pub mod peer;
#[cfg(feature = "media")]
pub mod serve;
#[cfg(feature = "media")]
pub mod session;
#[cfg(feature = "media")]
pub mod signal;
#[cfg(feature = "media")]
pub mod vp8;
