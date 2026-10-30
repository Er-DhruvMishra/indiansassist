//! Agent orchestration (contract §2.1 precedence, §7 elevation, §10 self-delete).
//!
//! The decision logic lives here and is tested in the default (pure) build. The webrtc-rs
//! peer, encoders and signaling client are compiled under the `media` feature (which needs
//! a C toolchain + nasm, absent on the gnu dev machine — see agent/README.md).

pub mod codecs;
pub mod elevate;
pub mod tokensource;

#[cfg(feature = "media")]
pub mod peer;
