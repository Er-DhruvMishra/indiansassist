//! Agent orchestration (contract §2.1 precedence, §7 elevation, §10 self-delete).
//!
//! The pure decision logic (`cli`, `codecs`, `elevate`, `tokensource`, `sechs`, `svc`) is
//! tested in every build. The webrtc-rs peer, the VP8 encoder, the signaling client and the session
//! orchestration are compiled under the `media` feature (MSVC host; see agent/README.md).

pub mod cli;
pub mod codecs;
pub mod desk;
pub mod elevate;
pub mod filerecv;
pub mod hochild;
pub mod hopipe;
pub mod live;
pub mod pbrun;
pub mod sechs;
pub mod svc;
pub mod tokencheck;
pub mod tokensource;

#[cfg(feature = "media")]
pub mod capture;
#[cfg(feature = "media")]
pub mod channels;
#[cfg(feature = "media")]
pub mod peer;
#[cfg(feature = "media")]
pub mod pump;
#[cfg(feature = "media")]
pub mod recorder;
#[cfg(feature = "media")]
pub mod rtshutdown;
#[cfg(feature = "media")]
pub mod serve;
#[cfg(feature = "media")]
pub mod session;
#[cfg(feature = "media")]
pub mod signal;
// Phase E §7.2: voice (cpal + Opus) is its own feature; without it the same surface reports no
// device, so the Linux build needs no ALSA and advertises no `voice`.
#[cfg(feature = "voice")]
pub mod voice;
#[cfg(all(feature = "media", not(feature = "voice")))]
#[path = "novoice.rs"]
pub mod voice;
#[cfg(feature = "media")]
pub mod vp8;
