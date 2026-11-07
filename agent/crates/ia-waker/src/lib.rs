//! `ia-waker`: the wake and AMT-proxy side of an installed device
//! (`docs/specs/phase-d-contracts.md` §11.1).
//!
//! | Module | Owns |
//! |---|---|
//! | [`wol`] | the magic packet, where it goes, and opening the sealed target MAC (rule 8.2b/c) |
//! | [`segment`] | the rule 8.2a org-salted segment hashes, computed so no raw address leaves |
//! | [`amt`] | WS-Management requests, HTTP Digest, and reading the firmware's answers (rule 8.4) |
//!
//! A device only ever does two things for its peers: it sends one magic packet it was asked to
//! send, and it relays one AMT command whose credential it was handed sealed and wipes
//! afterwards. It gains no other authority over them (rule 8.2e), and both are on the audit
//! chain through the server.

pub mod amt;
pub mod segment;
pub mod wol;

#[cfg(feature = "net")]
mod client;
/// The OS-verified ureq agent every https call of the service makes (licence audit F1).
#[cfg(feature = "net")]
pub mod https;

#[cfg(feature = "net")]
pub use client::{AmtClient, LocalWaker};

pub use segment::lan_segment;
pub use wol::{magic_packet, packet_from_sealed, wol_targets};
